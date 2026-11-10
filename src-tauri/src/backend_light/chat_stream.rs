use super::*;

/// SSE heartbeat period. The client's stall watchdog reads an SSE stream that
/// goes silent for too long as a dead connection, so the Python sidecar kept
/// the stream alive with `: keepalive` comments every ~15s while the agent was
/// thinking or running a slow tool. The Rust router must do the same: without
/// a heartbeat a long silent stretch (much likelier when two chats share one
/// provider) was aborted as a connection loss.
pub(super) const SSE_KEEPALIVE_SECS: u64 = 15;

pub(super) async fn chat_stream_entry(
    State(st): State<AppState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    chat_stream_native(body, st.data_root).await
}

/// POST /chat/steer — deliver a message to a running turn for this chat.
/// Body: `{chat_id, id, prompt, attachments, images, ...}`. Answers
/// `{ok: true}` when the message was queued (a turn is running) and
/// `{ok: false}` when nothing was running / nothing was sendable, so the
/// renderer re-sends it as the next turn instead of losing it. `prompt` may be
/// empty when the composer carried images or file attachments — that is how a
/// mid-turn picture-only steer works.
pub(super) async fn chat_steer(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    let id = body.get("id").and_then(Value::as_str).unwrap_or_default().trim();
    let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or_default();
    let attachments: Vec<String> = body
        .get("attachments")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // Keep the raw entries: the agent resolves paths / `{path, dataUrl}` only
    // after it knows a turn is actually running (it reads files on disk).
    let images: Vec<Value> = body
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if chat_id.is_empty() || id.is_empty() {
        return Json(json!({"ok": false})).into_response();
    }
    let ok = agent::push_steer(chat_id, id, prompt, attachments, images);
    Json(json!({"ok": ok})).into_response()
}

/// POST /chat/steer/cancel — drop a queued steer the user deleted first.
pub(super) async fn chat_steer_cancel(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    let id = body.get("id").and_then(Value::as_str).unwrap_or_default().trim();
    if !chat_id.is_empty() && !id.is_empty() {
        agent::cancel_steer(chat_id, id);
    }
    Json(json!({"ok": true})).into_response()
}

/// POST /chat/retry_now — force the running explore retry ladder to retry NOW.
///
/// The banner's Retry button used to be a no-op on a LIVE sub-agent retry: the
/// parent turn is still streaming, so the renderer's `send()` is swallowed by
/// its own single-flight guard and the whole last user turn could never be
/// re-sent. Rebooting the turn is the wrong fix anyway — what the user wants is
/// "stop waiting and try that sub-agent call again". This skips the ladder's
/// backoff so the very next attempt runs immediately.
pub(super) async fn chat_retry_now(Json(body): Json<Value>) -> Response<Body> {
    let chat_id = body.get("chat_id").and_then(Value::as_str).unwrap_or_default().trim();
    if chat_id.is_empty() {
        return bad_request("chat_id is required");
    }
    // `ok` is TRUE only when a ladder is actually listening. The renderer shows
    // the click as accepted only then; otherwise it must not pretend the retry
    // happened (the banner outlives its ladder whenever the turn has ended, and
    // a click that nothing consumes is precisely what made the button look
    // dead while the UI still claimed "retrying now (requested)").
    let listening = agent::nudge_subagent_retry(chat_id);
    Json(json!({"ok": true, "listening": listening})).into_response()
}

/// POST /chat/slot_model — push a Tool Models change to the RUNNING turn.
///
/// The turn's request body carries `subagent_models` as a snapshot taken when
/// the renderer called `/chat/stream`, so changing the sub-agent model while it
/// is retrying never reached the ladder: it kept retrying the model the user
/// had just replaced. The renderer now posts every change here, and the ladder
/// re-resolves the slot before its next attempt.
pub(super) async fn chat_slot_model(Json(body): Json<Value>) -> Response<Body> {
    let slot = body.get("slot").and_then(Value::as_str).unwrap_or_default().trim();
    if slot.is_empty() {
        return bad_request("slot is required");
    }
    // Absent/null model = "parent model", which an empty entry already means.
    let entry = body.get("model").and_then(Value::as_str).unwrap_or_default().trim();
    agent::set_live_slot_entry(slot, entry);
    Json(json!({"ok": true})).into_response()
}

/// Native Rust agent turn streamed as SSE `data: {"kind": ...}` lines —
/// the same event protocol the Python sidecar emits.
pub(super) async fn chat_stream_native(body: Value, data_root: PathBuf) -> Response<Body> {
    let mut req = match serde_json::from_value::<agent::AgentRequest>(body) {
        Ok(r) => r,
        Err(e) => return bad_request(&format!("invalid agent request: {e}")),
    };
    // The skill store is a data-root directory, not a workspace one: hand the
    // resolved root to the agent so skill routing reads the real store.
    if req.data_root.is_empty() {
        req.data_root = data_root.to_string_lossy().to_string();
    }
    let (tx, rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<axum::body::Bytes, std::io::Error>>();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Watcher: when the client disconnects (Stop button closes the fetch),
    // the stream consumer drops the response body -> the sender side of the
    // last clone goes away. We detect it via a weak handle: once the strong
    // sender count hits zero (all clones dropped), flip the cancel flag so
    // the agent loop bails instead of burning provider tokens.
    let cancel_watcher = std::sync::Arc::clone(&cancel);
    // Weak handle: the watcher must NOT keep the channel alive — a strong
    // clone here meant the sender count never reached zero after run_turn
    // finished, so the SSE stream stayed open after `done` (curl/fetch hung
    // until its own timeout).
    let watch_tx = tx.downgrade();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    // When the client disconnects (Stop button aborts the fetch), the
    // response body — and with it the channel receiver — is dropped, which
    // flips the sender's is_closed(). strong_count() can NEVER reach zero
    // mid-turn (the turn task itself holds a sender), so the old check only
    // fired after the turn finished — Stop did not stop a running explore.
    // WeakUnboundedSender has no is_closed: upgrade temporarily (the turn
    // task keeps strong senders alive, so this succeeds mid-turn) and ask
    // the strong handle whether the receiver is gone.
    let receiver_gone = match watch_tx.upgrade() {
        Some(s) => {
            let closed = s.is_closed();
            drop(s);
            closed
        }
        None => true,
    };
    if receiver_gone {
        cancel_watcher.store(true, std::sync::atomic::Ordering::Relaxed);
        break;
    }
        }
    });
    // Heartbeat emitter. Uses a WEAK handle on purpose: the temporary upgrade
    // lives only inside one tick, so the heartbeat can never keep the body
    // open after the turn ends (a strong clone here left the SSE stream
    // hanging after `done`). `turn_done` is the deterministic exit for the
    // last tick after the turn finished.
    let turn_done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ka_tx = tx.downgrade();
    let ka_done = std::sync::Arc::clone(&turn_done);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SSE_KEEPALIVE_SECS)).await;
            if ka_done.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            match ka_tx.upgrade() {
                Some(s) => {
                    let sent = s
                        .send(Ok(axum::body::Bytes::from_static(b": keepalive\n\n")))
                        .is_ok();
                    drop(s);
                    // Send error = the receiver is gone (client disconnected).
                    if !sent {
                        break;
                    }
                }
                // No strong senders left: the turn finished — nothing to keep
                // alive, so exit and let the body complete.
                None => break,
            }
        }
    });
    tokio::spawn(async move {
        let tx_err = tx.clone();
        let done_flag = turn_done;
        let mut emit = move |ev: &agent::AgentEvent| {
            let line = format!("data: {}\n\n", ev.to_json());
            let _ = tx.send(Ok(axum::body::Bytes::from(line)));
        };
        if let Err(e) = agent::run_turn(&req, &mut emit, &cancel).await {
            let payload = serde_json::json!({"kind": "error", "content": e});
            let _ = tx_err.send(Ok(axum::body::Bytes::from(format!(
                "data: {payload}\n\n"
            ))));
            // A fatal turn error is still a TERMINAL state: the protocol
            // requires `done` or the client reports "Connection lost mid-turn"
            // on top of the real error.
            let done = agent::AgentEvent::Done { aborted: false }.to_json();
            let _ = tx_err.send(Ok(axum::body::Bytes::from(format!("data: {done}\n\n"))));
        }
        done_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(UnboundedReceiverStream::new(rx)))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "stream build failed").into_response()
        })
}

// ---------- plans (native) ----------
// The Python sidecar wrote plan files from graph.py with no HTTP endpoints;
// the native agent owns the same on-disk layout now, and the renderer can
// reload a plan after restart via GET /plan.

