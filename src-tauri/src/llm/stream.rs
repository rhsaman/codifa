use super::*;

/// One provider usage payload, normalized to ONE vocabulary.
///
/// The two conventions a usage object can follow, told apart by the fields the
/// payload itself carries (never by the provider's NAME — a custom gateway that
/// speaks Anthropic's wire format is caught by its shape):
///
/// - **Additive** (Anthropic and Anthropic-compatible endpoints): the cache
///   fields sit BESIDE `input_tokens`, so the input the provider actually
///   processed is `input + cache_read + cache_creation`.
/// - **Subset** (OpenAI / DeepSeek / Google / OpenAI-compatible gateways): the
///   reported input ALREADY covers the cached part
///   (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`,
///   `cachedContentTokenCount`), so adding it would double-count.
///
/// `input_total` is the one inclusive number every consumer wants: the
/// compaction trigger's baseline, the context meter and the cost math all
/// treat input as "everything the model read this call".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NormalizedUsage {
    /// Inclusive billed input (see the type doc).
    pub input_total: u64,
    pub output_tokens: u64,
    /// The reported cache read, 0 when absent.
    pub cache_read: u64,
    /// The reported cache write (Anthropic `cache_creation_input_tokens`), 0
    /// when absent — OpenAI-style payloads have no such field.
    pub cache_write: u64,
    /// The payload carried a cache-read field at all. "Unknown" (a gateway
    /// that reports nothing) must stay distinguishable from a REAL zero (the
    /// cache genuinely missed), or the ruler's hit rate lies.
    pub cache_read_reported: bool,
    pub cache_write_reported: bool,
    /// The provider's own input number, BEFORE normalization — exclusive for
    /// additive payloads. Kept for consumers that echo the raw figure.
    pub reported_input: u64,
}

impl NormalizedUsage {
    /// `None` when the payload is not an object or carries no recognizable
    /// input field at all.
    pub fn from_payload(u: &Value) -> Option<NormalizedUsage> {
        let obj = u.as_object()?;
        let num = |keys: &[&str]| -> Option<u64> {
            keys.iter()
                .find_map(|k| obj.get(*k).and_then(Value::as_u64))
        };
        let output =
            num(&["output_tokens", "completion_tokens", "candidatesTokenCount"]).unwrap_or(0);
        // ADDITIVE shape: the Anthropic cache fields beside the input.
        let a_read = obj.get("cache_read_input_tokens").and_then(Value::as_u64);
        let a_write = obj
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64);
        if a_read.is_some() || a_write.is_some() {
            let input = num(&["input_tokens", "prompt_tokens"]).unwrap_or(0);
            let read = a_read.unwrap_or(0);
            let write = a_write.unwrap_or(0);
            return Some(NormalizedUsage {
                input_total: input + read + write,
                output_tokens: output,
                cache_read: read,
                cache_write: write,
                cache_read_reported: a_read.is_some(),
                cache_write_reported: a_write.is_some(),
                reported_input: input,
            });
        }
        // SUBSET shape: the reported input already includes the cached part.
        let input = num(&["prompt_tokens", "input_tokens", "promptTokenCount"])?;
        let read_direct = num(&[
            "prompt_cache_hit_tokens",
            "cached_tokens",
            "cachedContentTokenCount",
        ]);
        let read_nested = obj
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64);
        let read = read_direct.or(read_nested).unwrap_or(0);
        Some(NormalizedUsage {
            input_total: input,
            output_tokens: output,
            cache_read: read,
            cache_write: 0,
            cache_read_reported: read_direct.is_some() || read_nested.is_some(),
            cache_write_reported: false,
            reported_input: input,
        })
    }
}

// ---------------------------------------------------------------------------
// Streaming (SSE) — phase 3-2: the agent loop consumes deltas + tool_calls.
// ---------------------------------------------------------------------------

/// One streamed step's accumulated output.
#[derive(Debug, Default, Clone)]
pub struct StreamAcc {
    pub text: String,
    /// OpenAI-style tool calls accumulated across deltas: {id, name, arguments}.
    pub tool_calls: Vec<Value>,
    pub finish_reason: String,
    pub usage: Option<Value>,
    /// Provider failure carried INSIDE the stream: an `error`/`detail` object on
    /// an HTTP 200 response. The read loop cannot raise it as an `Err` the moment
    /// it arrives without discarding the text already streamed, so it is latched
    /// here and promoted to a real error by [`finish_stream`] once it closes.
    pub error: Option<String>,
    /// Bytes of REASONING ("thinking") content seen so far. The reasoning text
    /// itself is deliberately never streamed — rendering it token by token made
    /// the UI crawl — but its arrival has to be observable, otherwise the pill
    /// can only ever say "Working" while the model is clearly thinking. Counting
    /// it here lets the read loop detect a reasoning-only payload without
    /// sniffing the raw JSON.
    pub reasoning_len: usize,
    /// Raise counter of the interrupt signal when this stream started reading.
    /// The stream treats the signal as "mine" ONLY when its generation is now
    /// greater than this stamp, so a raise meant for an earlier window (already
    /// consumed, or landing before this request) can never cancel a request the
    /// user never steered. Together with `interrupted` this is what makes a
    /// mid-turn steer deterministic instead of a coin flip.
    pub interrupt_base: u64,
    /// True when the stream was dropped early because a mid-turn steer landed.
    /// The agent loop then re-issues the same step with the steer appended
    /// instead of waiting for a model answer the user already superseded.
    pub interrupted: bool,
}

/// One live signal from a streaming model call.
///
/// Text and the reasoning state travel through ONE callback on purpose: the
/// agent loop hands `stream_chat` a single closure, because two closures would
/// both need a mutable borrow of its event emitter at the same time.
pub enum StreamSignal<'a> {
    /// A text delta to append to the assistant bubble.
    Text(&'a str),
    /// The model started (`true`) or stopped (`false`) producing reasoning
    /// content. Only the state change is reported, never the reasoning text.
    Thinking(bool),
}

/// Callback fired for every live stream signal.
pub type SignalSink<'a> = &'a mut (dyn FnMut(StreamSignal<'_>) + Send + 'a);

/// Event-driven "drop this stream now" signal for mid-turn steers.
///
/// The steer inbox is only read BETWEEN model calls, so a steer typed while a
/// request was already streaming had to wait for that whole request to finish —
/// exactly the reported "steer behaves like a queued message". `push_steer`
/// raises this signal and the read loop below selects on it, so the in-flight
/// request is dropped at once and re-issued with the steer appended.
///
/// There is deliberately no timer anywhere in this path: a raise is an event, so
/// detection is instant, and a merely slow model is never mistaken for failure.
#[derive(Debug, Default)]
pub struct InterruptSignal {
    /// Monotonic raise counter.
    ///
    /// A plain bool is NOT enough here. A stream only learns about a raise when
    /// its read loop is parked on `wait()`, so a raise that lands while no
    /// stream is parked (the moment between two model calls, when the agent is
    /// executing a tool, or in the gap right after the previous stream was
    /// dropped) used to be either swallowed by `reset()` or consumed by the
    /// WRONG iteration — the reported "sometimes the steer goes through, and
    /// sometimes it just waits for the whole turn". Counting raises lets each
    /// stream spot exactly the raises that happened AFTER it started, so a raise
    /// is never lost and never mis-attributed.
    generation: AtomicU64,
    notify: Notify,
}

impl InterruptSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Raise the signal and wake an in-flight stream waiting on it.
    /// Returns the new generation (the stamp a consuming stream compares to).
    pub fn raise(&self) -> u64 {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.notify.notify_waiters();
        gen
    }

    /// The raise counter as it stands now. A stream captures this BEFORE it
    /// starts reading and treats any larger value as "a steer landed on me".
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// True when a raise happened after `since`.
    pub fn interrupted_since(&self, since: u64) -> bool {
        self.generation() > since
    }

    /// Resolve once the counter is greater than `since` (immediately when it
    /// already is), then return the value it reached.
    pub async fn wait_for(&self, since: u64) -> u64 {
        loop {
            // Register interest BEFORE re-checking the counter: a raise landing
            // between the check and the wait would otherwise be lost forever.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let now = self.generation();
            if now > since {
                return now;
            }
            notified.await;
        }
    }
}

/// Message carried by a provider error object. Failures do not all arrive with a
/// non-2xx status, and every provider words them differently, so the shape — not
/// the provider name — decides: OpenAI-style `{"error": {"message": …}}`, a plain
/// `{"error": "…"}`, FastAPI-style `{"detail": "…"}`, Anthropic's
/// `{"type": "error", "message": …}` frame, and Google's message-less
/// `{"error": {"code": …, "status": "…"}}`.
pub(crate) fn provider_error_message(v: &Value) -> Option<String> {
    let err = &v["error"];
    // Anthropic reports a mid-stream failure as `{"type":"error","message":…}`:
    // there is no `error` object at all. The top-level `message` is read ONLY
    // when the body declares itself an error envelope, so a healthy delta (which
    // carries `type` too, but never `message`) cannot be mistaken for a failure.
    let envelope = (v["type"].as_str() == Some("error"))
        .then(|| v["message"].as_str())
        .flatten();
    let named = err["message"]
        .as_str()
        .or_else(|| err["detail"].as_str())
        .or_else(|| err["type"].as_str())
        .or_else(|| err.as_str())
        .or_else(|| v["detail"].as_str())
        .or(envelope);
    let msg = match named {
        Some(m) => m.trim().to_string(),
        // Google sends no message at all — the status/code pair is the whole
        // reason, and without it the failure would read as an empty answer.
        None => match (
            err["status"].as_str().unwrap_or_default().trim(),
            err["code"].as_i64(),
        ) {
            ("", None) => return None,
            ("", Some(code)) => format!("error code {code}"),
            (status, None) => status.to_string(),
            (status, Some(code)) => format!("{status} (code {code})"),
        },
    };
    (!msg.is_empty()).then(|| msg.to_string())
}

/// Span of the next SSE event terminator in `buf`, as `(start, end)`.
///
/// The SSE spec ends an event with a blank line, and the line ending may be
/// LF, CRLF or CR. Splitting only on `"\n\n"` silently skipped every frame of
/// a CRLF stream — Google's native `streamGenerateContent` endpoint sends
/// CRLF, so the whole Gemini answer arrived, was never parsed, and the turn
/// ended at EOF with an empty accumulator (`returned no content — the
/// provider closed the stream without finishing`).
pub(super) fn sse_frame_end(buf: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for terminator in ["\r\n\r\n", "\n\n", "\r\r"] {
        if let Some(start) = buf.find(terminator) {
            let end = start + terminator.len();
            // The EARLIEST terminator closes this frame; the longest spelling
            // wins an exact tie so a CRLF pair is never read as two CR frames.
            best = Some(match best {
                Some((b, e)) if b < start || (b == start && e >= end) => (b, e),
                _ => (start, end),
            });
        }
    }
    best
}

/// Parse one SSE `data:` payload into accumulator updates, forwarding text
/// deltas to `on_delta` as they arrive. Returns true when the payload ends the
/// read loop: the `[DONE]` marker, or an error frame — whose reason is latched
/// into [`StreamAcc::error`] for [`finish_stream`] to raise.
pub(super) fn apply_sse_payload(
    provider: &str,
    payload: &str,
    acc: &mut StreamAcc,
    on_delta: &mut dyn FnMut(&str),
) -> bool {
    let payload = payload.trim();
    if payload == "[DONE]" {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(payload) else {
        return false;
    };
    // The request failed even though the transport did not. Reading on would
    // hang on a provider that holds the socket open, and ignoring the frame is
    // what made a dead model look like a silent success.
    if let Some(msg) = provider_error_message(&v) {
        acc.error = Some(msg);
        return true;
    }
    match provider {
        "anthropic" => {
            match v["type"].as_str() {
                Some("content_block_delta") => {
                    if v["delta"]["type"].as_str() == Some("thinking_delta") {
                        // Extended thinking: the reasoning text is measured, not
                        // streamed — the UI only needs to know it is happening.
                        if let Some(t) = v["delta"]["thinking"].as_str() {
                            acc.reasoning_len += t.len();
                        }
                    } else if let Some(t) = v["delta"]["text"].as_str() {
                        if latch_content_error(acc, t) {
                            return true;
                        }
                        acc.text.push_str(t);
                        on_delta(t);
                    }
                }
                Some("message_delta") => {
                    acc.finish_reason = v["delta"]["stop_reason"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    if v["usage"].is_object() {
                        let merged = match acc.usage.take() {
                            Some(u) => {
                                let mut m = u;
                                for (k, val) in v["usage"].as_object().unwrap() {
                                    m[k] = val.clone();
                                }
                                m
                            }
                            None => v["usage"].clone(),
                        };
                        acc.usage = Some(merged);
                    }
                }
                Some("message_start") => {
                    if v["message"]["usage"].is_object() {
                        acc.usage = Some(v["message"]["usage"].clone());
                    }
                }
                _ => {}
            }
        }
        _ => {
            let choice = &v["choices"][0];
            // Reasoning deltas: providers name them differently (OpenRouter and
            // DeepSeek: `reasoning`; several gateways: `reasoning_content`;
            // Anthropic-compatible shims: `thinking`). They are measured, never
            // streamed: forwarding the reasoning text token by token slowed the
            // UI to a crawl, so only the arrival of reasoning is signalled.
            if let Some(r) = choice["delta"]["reasoning"]
                .as_str()
                .or_else(|| choice["delta"]["reasoning_content"].as_str())
                .or_else(|| choice["delta"]["thinking"].as_str())
            {
                acc.reasoning_len += r.len();
            }
            if let Some(t) = choice["delta"]["content"].as_str() {
                if latch_content_error(acc, t) {
                    return true;
                }
                acc.text.push_str(t);
                on_delta(t);
            }
            if let Some(tcs) = choice["delta"]["tool_calls"].as_array() {
                for tc in tcs {
                    // Deterministic slot target. OpenAI always sends `index`;
                    // when a provider omits it, a delta that OPENS a call (it
                    // carries an id or a name) gets its own slot instead of
                    // being merged into slot 0 — the old `unwrap_or(0)` folded
                    // every streamed call into the first one and left the rest
                    // nameless, which surfaced as `unknown tool ""`.
                    let idx = match tc["index"].as_u64() {
                        Some(i) => i as usize,
                        None => {
                            let opens_new = tc["id"].as_str().is_some()
                                || tc["function"]["name"]
                                    .as_str()
                                    .map(|n| !n.is_empty())
                                    .unwrap_or(false);
                            if opens_new || acc.tool_calls.is_empty() {
                                acc.tool_calls.len()
                            } else {
                                acc.tool_calls.len() - 1
                            }
                        }
                    };
                    // Every slot is a structurally complete call, never a bare
                    // `{}`: reading `tc["function"]["name"]` off an empty object
                    // produced `""`, which the dispatch guard reported as
                    // `unknown tool ""` and burned a whole round-trip.
                    while acc.tool_calls.len() <= idx {
                        acc.tool_calls
                            .push(json!({"function": {"name": "", "arguments": ""}}));
                    }
                    let slot = &mut acc.tool_calls[idx];
                    if let Some(id) = tc["id"].as_str() {
                        slot["id"] = json!(id);
                    }
                    // Never let an EMPTY name overwrite a good one. Some
                    // providers stream the name once and then send `"name":""`
                    // on every following delta; the blind overwrite erased it,
                    // so the call reached the dispatch guard as `unknown tool ""`
                    // and burned a whole round-trip re-issuing it.
                    if let Some(name) = tc["function"]["name"].as_str() {
                        if !name.is_empty() {
                            slot["function"]["name"] = json!(name);
                        }
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        let cur = slot["function"]["arguments"].as_str().unwrap_or_default();
                        slot["function"]["arguments"] = json!(format!("{cur}{args}"));
                    }
                    // Google's OpenAI-compatible endpoint returns Gemini's
                    // thought signature beside every tool call under
                    // `extra_content.google.thought_signature`. It is REQUIRED
                    // on the next round: replaying the assistant tool call
                    // without it is rejected with HTTP 400 ("Function call is
                    // missing a thought_signature"). Keep the whole provider-
                    // namespaced object, not the one field, so another gateway
                    // with its own extra data is covered too.
                    if !tc["extra_content"].is_null() {
                        slot["extra_content"] = tc["extra_content"].clone();
                    }
                }
            }
            if let Some(fr) = choice["finish_reason"].as_str() {
                acc.finish_reason = fr.to_string();
            }
            if v["usage"].is_object() {
                acc.usage = Some(v["usage"].clone());
            }
        }
    }
    false
}

/// Promote a finished stream to a real error when it produced nothing usable.
///
/// A provider does not have to fail on the transport to fail the request: it can
/// answer 200 and then close the socket, or close a stream that only ever
/// carried reasoning. Both used to end the turn as a silent success — an empty
/// bubble, no banner, nothing logged — which is exactly what a model that cannot
/// serve the request looked like from the outside. Every other case keeps the
/// streamed text.
pub(super) fn finish_stream(provider: &str, acc: StreamAcc) -> Result<StreamAcc, (u16, String)> {
    if let Some(msg) = acc.error.as_deref() {
        return Err((
            0u16,
            format!("{provider} reported an error mid-stream: {msg}"),
        ));
    }
    // A mid-turn steer drops this request on purpose: the agent loop re-issues
    // the step with the steer appended, so an empty accumulator is the expected
    // outcome here and not a failure.
    if acc.interrupted {
        return Ok(acc);
    }
    // A 200 stream whose whole CONTENT is a billing/auth refusal (Pollinations
    // does this for a drained account): zero usage plus the wording. Without
    // this the turn "succeeds" and the refusal is stored as the assistant's
    // answer, while the model test — which only checks non-empty — shows a
    // green tick. Tool calls are exempt: a model may discuss billing and then
    // call a tool.
    if acc.tool_calls.is_empty() && usage_is_zero(acc.usage.as_ref()) {
        if let Some(msg) = content_error_message(&acc.text) {
            return Err((0u16, format!("{provider} refused the request: {msg}")));
        }
    }
    if !acc.text.trim().is_empty() || !acc.tool_calls.is_empty() {
        return Ok(acc);
    }
    let ending = if acc.finish_reason.is_empty() {
        "the provider closed the stream without finishing".to_string()
    } else {
        format!("the stream finished with '{}'", acc.finish_reason)
    };
    if acc.reasoning_len > 0 {
        return Err((
            0u16,
            format!(
                "{provider} returned no content after streaming reasoning — {ending} \
                 (the thinking block may have used the whole budget)"
            ),
        ));
    }
    Err((0u16, format!("{provider} returned no content — {ending}")))
}

/// Resolves once the Stop flag is raised; never resolves when there is no flag.
///
/// This is a poll of the user's own cancel request, not a deadline on the
/// model: it lets Stop win while the request is parked waiting for response
/// headers or for the next chunk (the plain flag check below only runs AFTER a
/// chunk arrives, so a silent provider made Stop a no-op).
pub(super) async fn wait_cancel(cancel: Option<&std::sync::atomic::AtomicBool>) {
    match cancel {
        Some(c) => {
            while !c.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// Stream one chat completion, invoking `on_delta` for every text chunk.
/// Returns the accumulated result (text, tool_calls, finish_reason, usage).
pub async fn stream_chat(
    client: &Client,
    cfg: &LlmConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    on_event: SignalSink<'_>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    steer_interrupt: Option<&InterruptSignal>,
) -> Result<StreamAcc, (u16, String)> {
    if cfg.api_keys.is_empty() && !kind_allows_keyless(&cfg.provider) {
        return Err((0, "no api key configured".into()));
    }
    // A keyless local endpoint runs ONE attempt with an empty key (no auth
    // header); cloud kinds never reach this with an empty list.
    let empty_key = [String::new()];
    let attempts: &[String] = if cfg.api_keys.is_empty() { &empty_key } else { &cfg.api_keys };
    // Build the payload ONCE (it is key-independent): the previous code rebuilt
    // and re-cloned the whole message array — base64 images included — for every
    // API-key attempt.
    let body = build_request_body(cfg, messages, tools);
    let mut last_err = String::new();
    for key in key_attempt_order(attempts) {
        match stream_with_key(client, cfg, &key, &body, on_event, cancel, steer_interrupt)
            .await
        {
            Ok(acc) => {
                mark_key_ok(&key);
                return Ok(acc);
            }
            Err((status, body)) if is_key_error(status, &body) => {
                mark_key_dead(&key);
                last_err = format!("key rejected ({status}): {body}");
                continue;
            }
            // Keep the real status: the headless caller (the scheduler) prefixes
            // "upstream HTTP {status}" onto the body so the run record names the
            // failure. Zeroing it here made a 429/500 indistinguishable from a
            // transport drop.
            Err((status, body)) => return Err((status, body)),
        }
    }
    Err((0, last_err))
}

pub(super) async fn stream_with_key(
    client: &Client,
    cfg: &LlmConfig,
    key: &str,
    body: &Value,
    on_event: SignalSink<'_>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    steer_interrupt: Option<&InterruptSignal>,
) -> Result<StreamAcc, (u16, String)> {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    let (url, header_name, header_value) = match cfg.provider.as_str() {
        "anthropic" => (format!("{base}/v1/messages"), "x-api-key", key.to_string()),
        // Google's OpenAI-compatible endpoint: standard messages + tools, so
        // the agent loop's advertised schemas actually reach the model. The
        // native streaming shape cannot express them (see
        // `gemini_openai_api`), and its absence caused MALFORMED_FUNCTION_CALL.
        "google" => (
            format!("{}/chat/completions", gemini_openai_api(&cfg.base_url)),
            "Authorization",
            format!("Bearer {key}"),
        ),
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    };
    // An EMPTY key is "no credential" (a keyless local endpoint): send no auth
    // header at all — the same rule `endpoint_and_auth` applies for one-shot
    // calls. The caller skips a header with an empty NAME.
    let (header_name, header_value): (&'static str, String) = if key.is_empty() {
        ("", String::new())
    } else {
        (header_name, header_value)
    };

    // Set only after a gateway refused a field, and each strip is applied to
    // what was ACTUALLY sent last. Two independent `Option`s picked with `or`
    // were wrong the moment a server rejected both: the more-stripped copy lost
    // and the request looped back with the field it just rejected. Cumulative
    // and capped, so a strict gateway always converges on a body it accepts.
    let mut retry_body: Option<Value> = None;
    let mut retries_left: u8 = 2;
    // Bound ONLY the wait for the response headers — never the answer. After a
    // sleep/wake or a NAT rebinding a dead connection can sit in TCP
    // retransmit for tens of minutes reporting NO error, which defeats the
    // "the transport surfaces a dead connection instantly" assumption below;
    // the SSE idle guard only arms AFTER `break resp`, so a headless run
    // parked right here forever: trace silent, log silent, run row stuck at
    // "running". A provider that cannot flush HEADERS within this budget will
    // not answer either; the env override covers an exotic queued gateway.
    let header_wait = std::time::Duration::from_secs(header_wait_secs());
    let resp = loop {
        let send_body = retry_body.as_ref().unwrap_or(body);
        let mut req = client.post(&url).json(send_body);
        // The row's own header list goes FIRST, and the key-derived auth header
        // is skipped when the row already spells that name out — reqwest
        // appends instead of replacing, so sending both would duplicate it.
        for (name, value) in &cfg.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        if !header_name.is_empty() && !has_header(&cfg.headers, header_name) {
            req = req.header(header_name, header_value.as_str());
        }
        if cfg.provider == "anthropic" && !has_header(&cfg.headers, "anthropic-version") {
            req = req.header("anthropic-version", "2023-06-01");
        }
        let resp = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Err((0u16, "aborted by user".into())),
            _ = tokio::time::sleep(header_wait) => {
                return Err((
                    0u16,
                    format!(
                        "provider sent no response headers within {}s (connection black-holed; raise CODIFA_HEADER_WAIT_SECS if your gateway is slower)",
                        header_wait_secs()
                    ),
                ))
            }
            r = req.send() => r.map_err(|e| (0u16, e.to_string()))?,
        };
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            break resp;
        }
        let text = resp.text().await.unwrap_or_default();
        // Both fields below are OPTIONAL niceties: dropping one still gets the
        // answer. Strip whichever the gateway named, cumulatively, and retry —
        // but only twice, because a third rejection is a real error.
        let reject_stream = rejects_stream_options(status, &text);
        let reject_parallel = rejects_parallel_tool_calls(status, &text);
        if retries_left > 0 && (reject_stream || reject_parallel) {
            let mut stripped = send_body.clone();
            let mut changed = false;
            if let Some(obj) = stripped.as_object_mut() {
                if reject_stream && obj.remove("stream_options").is_some() {
                    changed = true;
                }
                if reject_parallel && obj.remove("parallel_tool_calls").is_some() {
                    changed = true;
                }
            }
            if changed {
                retries_left -= 1;
                retry_body = Some(stripped);
                continue;
            }
        }
        return Err((status, nonempty_error_body(status, text)));
    };

    let mut acc = StreamAcc::default();
    // Stamp this request with the signal's current generation: only a raise that
    // happens AFTER this point is meant for THIS stream. Without the stamp a
    // raise landing between two requests was consumed by the next one (or lost),
    // which is why a mid-turn steer only went through sometimes.
    if let Some(sig) = steer_interrupt {
        acc.interrupt_base = sig.generation();
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // Live thinking state, reported only on a REAL transition: a payload that
    // carries neither reasoning nor text (usage / role deltas) must not flicker
    // the pill off and on.
    let mut thinking_on = false;
    use futures_util::StreamExt;
    // Idle timeout: a stalled provider stream (no DATA for this long) must abort
    // the turn with a clear error instead of hanging it forever. Deliberately
    // generous, because some providers stay silent for many minutes while a
    // large model thinks before the first token, and cutting that off looked
    // like "the model errored after 60 seconds". It is still finite on purpose:
    // a provider that answers 200 and then keeps the socket open with keep-alive
    // comments, never sending an event or EOF, would otherwise hang the turn with
    // no error at all. The deadline is refreshed only by a real SSE `data:`
    // frame, so keep-alive chatter cannot keep a dead stream alive; an aborted
    // connection still surfaces instantly as a transport `Err`.
    let idle_secs = stream_idle_secs();
    let mut idle_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(idle_secs);
    loop {
        // Stop button: the cancel flag is checked on every chunk read, so a
        // running stream (including one inside an explore sub-agent) aborts
        // immediately instead of finishing the whole model call first.
        if let Some(c) = cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                return Err((0u16, "aborted by user".into()));
            }
        }
        // A mid-turn steer drops this request instantly instead of letting the
        // model finish an answer the user already superseded. `biased` makes the
        // interrupt win every tie, so a steer is never delayed by a ready chunk.
        // Stop and a mid-turn steer are both EVENTS raced against the next chunk,
        // so neither waits for a silent provider to speak first.
        let chunk = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Err((0u16, "aborted by user".into())),
            _ = async {
                match steer_interrupt {
                    Some(sig) => sig.wait_for(acc.interrupt_base).await,
                    None => std::future::pending::<u64>().await,
                }
            } => {
                acc.interrupted = true;
                return finish_stream(&cfg.provider, acc);
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                return Err((
                    0u16,
                    format!("provider stream sent no data for {idle_secs}s"),
                ));
            }
            next = stream.next() => next,
        };
        let chunk = match chunk {
            Some(chunk) => chunk.map_err(|e| (0u16, e.to_string()))?,
            None => break,
        };
        let before_text = acc.text.len();
        let before_reasoning = acc.reasoning_len;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line; the terminator may be LF,
        // CRLF (Gemini) or CR. `lines()` strips a trailing `\r`, and the
        // explicit replace also handles a CR-only stream.
        while let Some((_, end)) = sse_frame_end(&buf) {
            let frame: String = buf.drain(..end).collect();
            for line in frame.replace('\r', "\n").lines() {
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.strip_prefix(' ').unwrap_or(payload);
                // The parser keeps its text-only sink; this thin adapter is
                // what lets the caller receive BOTH kinds of signal from one
                // closure (and keeps the parser's unit tests untouched).
                // A real frame is progress: push the idle deadline out.
                idle_deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_secs(idle_secs);
                let mut text_sink = |t: &str| on_event(StreamSignal::Text(t));
                // A terminal frame — the `[DONE]` marker or a stream error:
                // either way this step's outcome is decided here.
                if apply_sse_payload(&cfg.provider, payload, &mut acc, &mut text_sink) {
                    return finish_stream(&cfg.provider, acc);
                }
            }
        }
        if acc.reasoning_len > before_reasoning && !thinking_on {
            thinking_on = true;
            on_event(StreamSignal::Thinking(true));
        }
        if acc.text.len() > before_text && thinking_on {
            thinking_on = false;
            on_event(StreamSignal::Thinking(false));
        }
    }
    // The last frame may close without its trailing blank line (some gateways
    // end the socket right after the payload). Parse whatever is left so the
    // final text/reasoning chunk is not lost; a truncated JSON frame simply
    // fails to parse and is ignored.
    if !buf.trim().is_empty() {
        for line in buf.replace('\r', "\n").lines() {
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.strip_prefix(' ').unwrap_or(payload);
            let mut text_sink = |t: &str| on_event(StreamSignal::Text(t));
            if apply_sse_payload(&cfg.provider, payload, &mut acc, &mut text_sink) {
                break;
            }
        }
    }
    // The socket closed without a terminal frame. Only now can the outcome be
    // judged, because everything streamed before the close is accumulated.
    finish_stream(&cfg.provider, acc)
}

/// A provider that answers HTTP 200 and puts its refusal in the assistant
/// CONTENT instead of an error envelope. Pollinations does this for a drained
/// account: the reply is "The account behind this API key doesn't have enough
/// credits…", usage is all zeros, and a model test that only checks
/// "non-empty" therefore shows a green tick while every real turn is refused.
///
/// Only strong, billing/auth-shaped phrases count, and callers additionally
/// require zero usage, so a model that legitimately DISCUSSES credits is not
/// misread as a failed call.
pub fn content_error_message(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.is_empty() || t.len() > 800 {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "have enough credits",
        "not enough credit",
        "insufficient credit",
        "credit balance is too low",
        "exceeded your current quota",
        "insufficient_quota",
        "free usage limit reached",
        "free tier limit",
        "out of credits",
        "no credits",
        "please top up",
        "top up or",
        "account is suspended",
        "account has been suspended",
        "payment required",
        "invalid api key",
        "incorrect api key",
    ];
    NEEDLES
        .iter()
        .any(|needle| lower.contains(needle))
        .then_some(t)
}

/// True when a provider reported usage and every token count is zero. A
/// content-level refusal (see [`content_error_message`]) is only trusted in
/// that case; a real answer always bills at least one token.
pub(super) fn usage_is_zero(usage: Option<&Value>) -> bool {
    let Some(u) = usage else {
        return false;
    };
    let keys = [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
    ];
    let mut seen = false;
    for key in keys {
        if let Some(n) = u.get(key).and_then(Value::as_i64) {
            seen = true;
            if n != 0 {
                return false;
            }
        }
    }
    seen
}

/// Latch a provider refusal that arrived as ordinary CONTENT before it is
/// forwarded to the UI. Pollinations answers a drained account with a normal
/// 200 chunk whose `delta.content` is the billing message; streaming it made
/// the transcript fill with that text on every retry. Only a complete-looking
/// first chunk (≥60 chars) is treated this way — a real model's first delta is
/// a few tokens, so this cannot swallow a normal answer.
pub(super) fn latch_content_error(acc: &mut StreamAcc, t: &str) -> bool {
    if acc.text.is_empty() && t.trim().len() >= 60 {
        if let Some(msg) = content_error_message(t) {
            acc.error = Some(msg.to_string());
            return true;
        }
    }
    false
}

/// Pull (text, usage) out of a provider response.
pub(super) fn extract_completion(provider: &str, v: &Value) -> Result<LlmResult, (u16, String)> {
    // A 200 carrying an error object is a failure, not an empty answer: the body
    // names the reason, so every one-shot caller (title, compact, model test)
    // reports that instead of a blank "empty reply".
    if let Some(msg) = provider_error_message(v) {
        return Err((0u16, msg));
    }
    let (text, usage) = match provider {
        "anthropic" => {
            let text: String = v["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            (text, Some(v["usage"].clone()))
        }
        "google" => {
            // Gemini may split the answer across several parts (and can carry
            // thought/signature parts first); concatenate every text part that
            // is not reasoning instead of reading only `parts[0]`.
            let text: String = v["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|p| p["thought"].as_bool() != Some(true))
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            (text, Some(v["usageMetadata"].clone()))
        }
        _ => {
            let choice = &v["choices"][0];
            let text = choice["message"]["content"].as_str().unwrap_or_default().to_string();
            let usage = v["usage"].as_object().map(|_| v["usage"].clone());
            (text, usage)
        }
    };
    // A 200 whose CONTENT is a billing/auth refusal: the provider used the
    // normal completion shape, so only zero usage + the wording can tell it
    // apart from a real answer. Without this a title/compact call would store
    // the refusal as its result and a model probe would show a green tick.
    if usage_is_zero(usage.as_ref()) {
        if let Some(msg) = content_error_message(&text) {
            return Err((0u16, msg.to_string()));
        }
    }
    Ok(LlmResult { text, usage })
}
