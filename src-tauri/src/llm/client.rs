use super::*;

pub struct LlmResult {
    pub text: String,
    pub usage: Option<Value>,
}

/// Sentinel meaning "no practical timeout" for `LlmConfig::timeout_secs`.
/// reqwest requires a concrete duration, so this is 24 hours — long enough
/// that a chat turn is never cut off while the provider is still answering,
/// however slow it is (the user's explicit requirement).
pub const NO_TIMEOUT_SECS: u64 = 24 * 60 * 60;

/// Wait this long for the provider to start answering (response headers).
/// A user-visible error after N seconds is NEVER wanted: some providers and
/// large reasoning models legitimately take many minutes — even half an hour —
/// before the first byte, and cutting that off surfaced as a bogus "provider
/// did not respond" error while the model was still thinking. This budget is
/// 24 hours precisely so it never fires in practice; a genuinely dead
/// connection still aborts through the transport's own TCP errors, and the
/// user can always hit Stop (the cancel flag is checked every step).
pub const HEADER_TIMEOUT_SECS_DEFAULT: u64 = 24 * 60 * 60;

/// Abort a stream after this much TOTAL silence (not a pause between chunks —
/// total, since the last byte of any kind). A long thinking pause is not a
/// failure, so this is far above any legitimate gap, but it is finite on
/// purpose: a provider that answers HTTP 200 and then keeps the socket open with
/// keep-alive chatter and never sends an event or EOF would otherwise hang the
/// turn forever, with no error and a Stop button that has nothing to cancel.
/// Override with `CODIFA_STREAM_IDLE_SECS`.
pub const IDLE_TIMEOUT_SECS_DEFAULT: u64 = 600;

/// Wait this long for a STREAMING request to flush its response headers
/// before giving up and reporting an error. This bounds ONLY the connect+
/// TTFB phase, never the answer: headers carry no payload, so a provider
/// that has them ready will return them in seconds. The SSE idle guard
/// below arms only AFTER the headers arrive, so without this ceiling a
/// black-holed connection (sleep/wake, NAT rebinding — days of silent TCP
/// retransmit with NO transport error) parks a headless run at "running"
/// forever: no trace row, no log line, no timeout anywhere in the chain.
/// Override with `CODIFA_HEADER_WAIT_SECS`.
pub const HEADER_WAIT_SECS_DEFAULT: u64 = 60;

/// Resolve the stream idle budget, allowing an env override for long-running
/// local models that emit nothing while they compute.
pub(super) fn stream_idle_secs() -> u64 {
    std::env::var("CODIFA_STREAM_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(IDLE_TIMEOUT_SECS_DEFAULT)
}

/// Resolve the wait for a streaming request's response HEADERS. Headers carry
/// no answer payload, so this can be far tighter than the idle budget: a
/// provider that accepts the request but cannot flush headers within this
/// budget has a dead connection (sleep/wake black-hole), not a slow model.
/// Override with `CODIFA_HEADER_WAIT_SECS`.
pub(super) fn header_wait_secs() -> u64 {
    std::env::var("CODIFA_HEADER_WAIT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(HEADER_WAIT_SECS_DEFAULT)
}

/// The process-wide provider HTTP client.
///
/// Built ONCE. reqwest owns the connection pool and the TLS session cache, so a
/// fresh client per call forced a new TCP handshake AND a new TLS handshake for
/// every single request: every tool-slot call (title / compact / vision), every
/// step of a turn and every retried key paid for it. One client still talks to
/// however many providers are configured — the pool is keyed by origin.
pub(super) static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Shared provider HTTP client (no proxy, like the sidecar). Cloning is cheap:
/// the handle is reference-counted and shares the pool.
pub fn http_client() -> Client {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .connect_timeout(std::time::Duration::from_secs(15))
                // TCP keepalive is NOT a deadline on the model: a slow-but-connected
                // provider keeps answering the probes and is never cut off. It only lets
                // the OS notice a half-open connection (VPN/proxy switch, a gateway that
                // died without a FIN) and surface a transport error, which the retry
                // path then handles. Without it such a socket stayed silent forever.
                .tcp_keepalive(Some(std::time::Duration::from_secs(30)))
                // Hold idle sockets open between steps and turns so a follow-up
                // call reuses the established connection instead of re-dialing.
                // The idle cap MUST stay below the SERVER's own keep-alive
                // window (node's http server closes idle sockets after ~5s,
                // nginx after 75s): a reused socket the server already closed
                // is a black hole — the request is written into the void and
                // sits until the header budget expires. Measured on the local
                // 9router gateway: the first turn after a pause paid a ~50s
                // dead wait, then the retry on a fresh connection answered in
                // 4s. Re-dialing costs ~0ms on a localhost gateway, so a short
                // idle window keeps the reuse benefit and never hands a request
                // a corpse. 4s sits strictly BELOW node's default
                // keepAliveTimeout (5s) — the 9router gateway closes idle
                // sockets there, and a socket idle 5-8s was still being reused
                // and hung.
                .pool_idle_timeout(std::time::Duration::from_secs(4))
                .pool_max_idle_per_host(4)
                .build()
                .expect("reqwest client")
        })
        .clone()
}

/// Normalize the base URL the same way providers.py does:
/// - strip a trailing slash
/// - anthropic: strip a trailing `/v1` (the SDK re-appends `/v1/messages`)
/// - ollama: append `/v1` unless already present
pub fn normalize_base(provider: &str, base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    match provider {
        "anthropic" => {
            if base.ends_with("/v1") {
                base.truncate(base.len() - 3);
            }
        }
        "ollama" => {
            if !base.ends_with("/v1") {
                base.push_str("/v1");
            }
        }
        _ => {}
    }
    base
}

/// Gemini's native root: the configured base with a trailing `/openai` (the
/// OpenAI-compat suffix the old Google default carried) or `/v1beta` removed,
/// so `{root}/v1beta/models/…` is the same URL whichever way the base was
/// written. A path prefix in front of those suffixes (`https://proxy/gemini/v1beta`)
/// survives, which is what lets the same code drive a Gemini-compatible gateway.
pub fn gemini_native_root(base: &str) -> String {
    let mut root = base.trim().trim_end_matches('/').to_string();
    // `/openai` first: the legacy default ends in `/v1beta/openai`.
    for suffix in ["/openai", "/v1beta"] {
        if let Some(head) = root.strip_suffix(suffix) {
            root = head.trim_end_matches('/').to_string();
        }
    }
    root
}

/// Gemini's native API prefix — `{gemini_native_root}/v1beta` — which every
/// native call (`:generateContent`, `:predictLongRunning`, operations) hangs
/// off. Chat and the media tools must agree on it, so the saved base URL can
/// stay the OpenAI-compat one (`…/v1beta/openai`) while both wire shapes still
/// resolve to `…/v1beta/models/…`.
pub fn gemini_native_api(base: &str) -> String {
    format!("{}/v1beta", gemini_native_root(base))
}

/// Gemini's OpenAI-compatible API prefix (`{root}/v1beta/openai`).
///
/// Chat streams through this endpoint instead of the native
/// `streamGenerateContent` shape. The native body has no `tools` field in this
/// client, while the system prompt tells the model to call `load_skill`,
/// `use_mcp`, `read`, … — so Gemini tried to emit function calls nobody had
/// declared and ended the turn with `finishReason: MALFORMED_FUNCTION_CALL`.
/// Google's compat endpoint takes the SAME OpenAI messages/tools this agent
/// loop already speaks, returns real tool-call ids and Gemini 3 thought
/// signatures, and is maintained by Google. It is the same URL the saved
/// Google base already carries (`…/v1beta/openai`), normalized here so a root
/// base works too.
pub fn gemini_openai_api(base: &str) -> String {
    format!("{}/v1beta/openai", gemini_native_root(base))
}

/// The bare model id every Gemini URL path expects.
///
/// Google's own `/v1beta/models` listing (and older saved selections) hands
/// out ids prefixed `models/` (`models/gemini-flash-latest`), while every URL
/// builder already interpolates into a literal `models/…` segment — the verbatim
/// id produced `…/v1beta/models/models/gemini-flash-latest:generateContent`,
/// a 404 with an EMPTY body, so every Google call failed without saying why.
/// Stripping any number of leading `models/` segments (and stray slashes) here
/// makes chat, one-shot and media URLs agree whatever spelling was saved —
/// the same normalization `models.rs` already applies for the catalog lookup.
pub fn google_model_name(model: &str) -> &str {
    let mut name = model.trim();
    loop {
        if let Some(rest) = name.strip_prefix("models/") {
            name = rest;
        } else if let Some(rest) = name.strip_prefix('/') {
            name = rest;
        } else {
            return name;
        }
    }
}

/// Resolve the chat-completions endpoint + auth header style for a kind.
/// Returns (url, header_name, header_value_prefix). An empty header_name
/// means "send no auth header" — the keyless local-endpoint case.
pub(super) fn endpoint_and_auth(cfg: &LlmConfig, key: &str) -> (String, &'static str, String) {
    let base = normalize_base(&cfg.provider, &cfg.base_url);
    // Use the key of THIS attempt, not always the first one: the caller's
    // key-fallback loop retried a key the provider had just rejected, so a
    // rejected first key failed the whole call instead of falling through.
    let key = if key.is_empty() {
        cfg.api_keys.first().cloned().unwrap_or_default()
    } else {
        key.to_string()
    };
    let (url, header_name, header_value) = match cfg.provider.as_str() {
        "anthropic" => (
            format!("{base}/v1/messages"),
            "x-api-key",
            key.clone(),
        ),
        // Native shape: the saved base may carry the OpenAI-compat suffix
        // (`…/v1beta/openai`), and appending `/v1beta` to THAT produced
        // `…/v1beta/openai/v1beta/models/…` — a 404 for every Google chat call.
        // The root is normalized so both spellings of the base resolve here.
        "google" => (
            format!(
                "{}/models/{model}:generateContent",
                gemini_native_api(&cfg.base_url),
                model = google_model_name(&cfg.model)
            ),
            "x-goog-api-key",
            key.clone(),
        ),
        // OpenAI-compatible kinds (openrouter/ollama/custom/nvidia/...)
        _ => (format!("{base}/chat/completions"), "Authorization", format!("Bearer {key}")),
    };
    // An EMPTY key is "no credential" (a keyless local endpoint): send no auth
    // header at all — a bare `Bearer ` is a malformed credential some servers
    // reject, and the model-list path (models.rs `auth_headers`) omits the
    // header for the same reason. The caller skips a header with an empty NAME.
    if key.is_empty() {
        return (url, "", String::new());
    }
    (url, header_name, header_value)
}

/// The provider telling us the MODEL's upstream endpoint is gone.
///
/// The status code cannot be trusted for this one: a gateway may carry it on a
/// 429 (observed body: `Upstream request failed: Endpoint is unavailable.` with
/// `"code":"rate_limit_exceeded"`), which reads like "come back later" and
/// keeps a model that cannot serve the request at all. The body names the
/// failure, so the body decides.
pub(super) const UPSTREAM_DOWN: [&str; 8] = [
    "upstream request failed",
    "endpoint is unavailable",
    "endpoint unavailable",
    "no available endpoint",
    "upstream is unavailable",
    // LiteLLM-style routers answer "No ready deployment" / "No deployments
    // available for selected model" when every backend of a model is down. The
    // model itself cannot serve us, so the next rung must take the call instead
    // of the same dead model being retried for the whole budget.
    "no ready deployment",
    "no healthy deployment",
    "no deployment",
];

/// Whether a provider response says the model's upstream endpoint is down.
pub(super) fn upstream_is_down(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    UPSTREAM_DOWN.iter().any(|needle| t.contains(needle))
}

pub(super) fn is_key_error(status: u16, body: &str) -> bool {
    // A dead upstream endpoint is not a key problem: walking the key list would
    // only repeat the same doomed call with every configured key. Returning
    // `false` fails immediately and hands the raw provider error upward, where
    // it is classified as a model-side failure and the next configured model
    // gets the call.
    if upstream_is_down(body) {
        return false;
    }
    matches!(status, 401 | 402 | 403 | 429)
        || body.to_ascii_lowercase().contains("invalid api key")
        || body.to_ascii_lowercase().contains("unauthorized")
        || body.to_ascii_lowercase().contains("quota")
}

/// An error body that always SAYS something. A rejected request can come back
/// with a status and no body at all (a Google 404 for a malformed model path
/// is empty) — surfacing the bare string then read as `failed: ` with nothing
/// after it, and the user saw a failure with no reason. The synthetic text is
/// status-only, so it cannot flip `is_key_error` or `upstream_is_down`.
pub(super) fn nonempty_error_body(status: u16, text: String) -> String {
    if text.trim().is_empty() {
        format!("HTTP {status} (empty body)")
    } else {
        text
    }
}

// ---------- per-key cooldowns ----------
//
// Free-tier keys recover on their own: the quota resets (a minute, an hour, a
// day later) and the SAME key works again. The key ladder itself has no
// memory, so while one key sits exhausted every request still pays a doomed
// attempt on it before reaching the next one. Marking a rejected key cold for
// a while removes that tax, and the key rejoins the ladder once the window
// passes — the "test the dead key again later" behavior a rotating pool of
// free keys needs.

/// Process-global registry: key string → the Instant its cooldown expires.
/// In memory only (the key already lives in the config structs); never
/// persisted, never logged.
pub(super) static KEY_COOLDOWNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

pub(super) fn cooldowns() -> &'static Mutex<HashMap<String, Instant>> {
    KEY_COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the map, recovering from a poisoned lock: a panic in one thread must
/// not take key rotation down with it.
pub(super) fn cooldown_lock() -> MutexGuard<'static, HashMap<String, Instant>> {
    cooldowns().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How long a rejected key sits out. The default is HOURS because the common
/// death on a rotating pool of free-tier keys is a daily cap: re-probing every
/// few minutes only buys each dead key a doomed attempt per probe, while a
/// multi-hour bench makes it nearly free until its quota day rolls over. The
/// price is that a merely RATE-LIMITED key (a 429 that a minute of waiting
/// would fix) also sits out the window — acceptable while other keys carry
/// the load, and moot when every key is cooling (they all run anyway).
/// `CODIFA_KEY_COOLDOWN_SECS` overrides it (a tiny value ≈ the old
/// always-retry-first behavior).
pub(super) fn key_cooldown() -> Duration {
    const DEFAULT_SECS: u64 = 4 * 60 * 60;
    let secs = std::env::var("CODIFA_KEY_COOLDOWN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SECS);
    Duration::from_secs(secs.max(1))
}

/// A key the provider just refused on a key error: off the ladder until the
/// cooldown expires. A second refusal while still cold RE-ARMS the window
/// (it failed again, so its clock restarts).
pub(super) fn mark_key_dead(key: &str) {
    cooldown_lock().insert(key.to_string(), Instant::now() + key_cooldown());
}

/// A key that just served a successful call: drop any cooldown it earned
/// earlier, so a key whose quota came back early is used again at once.
pub(super) fn mark_key_ok(key: &str) {
    cooldown_lock().remove(key);
}

pub(super) fn key_is_cooling(key: &str, now: Instant) -> bool {
    cooldown_lock()
        .get(key)
        .map_or(false, |until| *until > now)
}

/// The ladder order for one request: keys NOT on cooldown first (the user's
/// own order preserved), then the cooling ones as a last resort — a request
/// must not die with "all keys rejected" while one of the cold keys may have
/// recovered early. When EVERY key is cooling the original order runs
/// unchanged, so an all-cold request attempts the same keys it always did.
pub(super) fn key_attempt_order(keys: &[String]) -> Vec<String> {
    let now = Instant::now();
    let mut live = Vec::new();
    let mut cold = Vec::new();
    for key in keys {
        if key_is_cooling(key, now) {
            cold.push(key.clone());
        } else {
            live.push(key.clone());
        }
    }
    if live.is_empty() {
        keys.to_vec()
    } else {
        live.extend(cold);
        live
    }
}

/// Whether a rejected request is complaining about the optional
/// `stream_options` field specifically.
///
/// Some strict OpenAI-compatible servers reject an unknown field instead of
/// ignoring it. That is not a broken model — dropping the field still gets the
/// answer, only the token accounting is lost — so the request is retried once
/// without it rather than failing the step.
pub(super) fn rejects_stream_options(status: u16, body: &str) -> bool {
    status == 400 && body.to_ascii_lowercase().contains("stream_options")
}

/// Whether a gateway refused `parallel_tool_calls` as an unknown field.
///
/// Same contract as [`rejects_stream_options`]: a strict OpenAI-compatible
/// server can 400 on the field instead of ignoring it. Dropping it only costs
/// the batching hint the model would have got — the answer is still served — so
/// the request is retried once without it rather than failing the step.
pub(super) fn rejects_parallel_tool_calls(status: u16, body: &str) -> bool {
    status == 400 && body.to_ascii_lowercase().contains("parallel_tool_calls")
}

/// Whether a failed model call means "THIS model cannot serve us", i.e. the only
/// case where trying the next configured fallback is the right move.
///
/// The rule is deliberately narrow. A fallback is an escape hatch for a model
/// that does not work — NOT a retry for the network. Only a provider REJECTING
/// the request in a way another model could fix qualifies:
///
/// * the key or account is refused (401 / 402 / 403, "invalid api key",
///   "forbidden", "insufficient credit", "permission denied");
/// * the provider does not serve this model ("model not found", "unknown
///   model", "not supported", "does not exist");
/// * the provider's upstream endpoint for the model is unavailable — some
///   gateways report that on a 429, so [`upstream_is_down`] is checked BEFORE
///   the rate-limit gate and the body wins over the status;
/// * the account's allowance for the model is EXHAUSTED ("usage limit
///   reached", `insufficient_quota`) — also checked BEFORE the rate-limit gate,
///   because a 429 carrying it means "this will never answer", not "come back
///   later";
/// * the model answered with nothing usable (an empty summary/title/description)
///   — the model itself is not working, which is not a transport problem.
///
/// Everything else stays on the SAME model: a dropped connection, a timeout, a
/// 5xx, a genuine 429/rate limit (one that does not name a broken endpoint), an
/// idle stream or a user abort. Falling back there
/// would spend the user's whole fallback list on a provider hiccup, hide the
/// real reason behind the last rung's error, and pay for calls that could never
/// have succeeded.
pub fn should_fall_back(err: &str) -> bool {
    let e = err.trim().to_ascii_lowercase();
    if e.is_empty() {
        return false;
    }
    // Transport-level first. A gateway body can contain "invalid" or "model" by
    // accident, so these must never reach the model needles below.
    const TRANSPORT: [&str; 13] = [
        "no response within",
        "no data for",
        "aborted by user",
        "error sending request",
        "connect",
        "timed out",
        "timeout",
        "dns",
        "tls",
        "broken pipe",
        "reset by peer",
        "incomplete message",
        "unexpected eof",
    ];
    if TRANSPORT.iter().any(|needle| e.contains(needle)) {
        return false;
    }
    // Checked BEFORE the rate-limit gate: a gateway can carry "this model's
    // endpoint is gone" on a 429, and that status alone would read as "come
    // back later" and keep the broken model for the rest of the attempts.
    if upstream_is_down(&e) {
        return true;
    }
    // An EXHAUSTED allowance is not "come back later". The account or the model
    // has no quota left and no number of repeats will change that, while the
    // next configured model may live on an entirely different account. The
    // observed body is opencode's `FreeUsageLimitError` ("Free usage limit
    // reached. Subscribe to OpenCode Go to keep going") carried on a 429: the
    // rate-limit gate below reads that as a temporary hiccup, keeps the same
    // model and leaves the user's whole fallback list unused.
    const EXHAUSTED: [&str; 5] = [
        "usage limit",
        "insufficient_quota",
        "exceeded your current quota",
        "quota has been exceeded",
        "credit balance",
    ];
    if EXHAUSTED.iter().any(|needle| e.contains(needle)) {
        return true;
    }
    // The provider asking us to come back later is not a broken model: retrying
    // the SAME model is exactly right, so a genuine 429 must never consume a
    // fallback.
    if e.contains("rate limit") || e.contains("429") || e.contains("too many requests") {
        return false;
    }
    // "key rejected (NNN): …" carries the status. 401/402/403 mean the account
    // or key is refused; anything else that reached this branch is a request
    // problem, not a model problem.
    if let Some(rest) = e.split("key rejected (").nth(1) {
        let status: u16 = rest
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        return matches!(status, 401 | 402 | 403);
    }
    // A model that answered with nothing usable is not working either.
    if e.contains("returned an empty summary")
        || e.contains("returned an empty title")
        || e.contains("returned an empty description")
        || e.contains("empty model response")
        || e.contains("returned no content")
    {
        return true;
    }
    const REJECTED: [&str; 20] = [
        "invalid api key",
        "incorrect api key",
        "invalid_api_key",
        "api key not valid",
        "no api key configured",
        // A gateway that holds no credential for its own UPSTREAM can never
        // serve this model — asking again is pure waste, so it must fall
        // through to the next rung. (Observed from a 9router gateway:
        // "No active credentials for provider: openrouter" on every `oc/*`
        // model. The message is the GATEWAY's, not ours — we only classify it.)
        "credential",
        "unauthorized",
        "unauthenticated",
        "authentication",
        "model not found",
        "model_not_found",
        "unknown model",
        "no such model",
        "not a valid model",
        "does not exist",
        "forbidden",
        "permission",
        "insufficient",
        "no credit",
        "not supported",
    ];
    if REJECTED.iter().any(|needle| e.contains(needle)) {
        return true;
    }
    // "model `gpt-x` not found" / "model `gpt-x` is unavailable": the model NAME
    // sits between the two halves, so no single substring can ever match. Pair
    // the halves instead — every provider words this one differently, but they
    // all name the model AND say it is missing.
    let names_a_model = e.contains("model");
    let says_missing = [
        "not found",
        "not available",
        "unavailable",
        "unknown",
        "invalid",
        "unsupported",
        "rejected",
    ]
    .iter()
    .any(|needle| e.contains(needle));
    names_a_model && says_missing
}

/// Kinds that may be called with NO api key at all: the `ollama` kind (the
/// local OpenAI-compatible servers — Ollama, llama.cpp, LM Studio) and any
/// `custom` base_url, which is how every localhost gateway (vLLM, a proxy) is
/// wired. For these a keyless attempt is the RULE, not an error: the model
/// list (models.rs `auth_headers`) and the sidecar probe (backend_light.rs)
/// already send an empty key to exactly such endpoints. Cloud kinds keep the
/// up-front refusal — spending a network round trip to learn a key is missing
/// tells the user far less than "no api key configured".
pub(super) fn kind_allows_keyless(kind: &str) -> bool {
    matches!(kind, "ollama" | "custom")
}

