use super::*;

/// Browser-level CDP connection: one WebSocket, one `sessionId` per tab.
///
/// The socket is split into read/write halves so the driver can race incoming
/// events (screencast frames) against new batches without borrow conflicts.
pub(super) struct Cdp {
    tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    next_id: u64,
    /// Session id of the tab this connection is currently driving.
    pub(super) session: Option<String>,
    /// Screencast frames absorbed while a command was waiting for its reply:
    /// `(flatten sessionId, base64 jpeg)`, latest per session. The driver moves
    /// them into the frame cache after the batch (see `flush_frames`).
    frames: Vec<(String, String)>,
    /// Viewport override each session already holds. The override is scoped to
    /// the CDP session and persists on a warm connection, so re-sending it with
    /// every keystroke, hover and status poll only forced a relayout and a new
    /// frame each time. It lives here so it is dropped with the connection.
    applied_vp: std::collections::HashMap<String, (u32, u32)>,
    /// `Emulation.setUserAgentOverride` params built from the browser's own
    /// version (see `ua_override`), cached for the life of the connection.
    pub(super) ua: Option<Value>,
}

impl Cdp {
    pub(super) async fn connect(port: u16) -> Result<Self, String> {
        let ws_url = browser_ws_url(port)?;
        let (ws, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect failed: {e}"))?;
        let (tx, rx) = ws.split();
        Ok(Self {
            tx,
            rx,
            next_id: 1,
            session: None,
            frames: Vec::new(),
            applied_vp: std::collections::HashMap::new(),
            ua: None,
        })
    }

    /// Cache one pushed screencast frame and acknowledge it immediately.
    ///
    /// Two things stalled the panel's frames before:
    ///   1. `send` skipped every event while waiting for its reply, so a frame
    ///      that landed during a command (exactly when typing or clicking) was
    ///      never stored or acknowledged;
    ///   2. the acknowledgement carried the CDP flatten session id (a string)
    ///      instead of the frame's own integer `params.sessionId`, which
    ///      Chromium rejects — the frame stays unacknowledged and after a couple
    ///      of them it stops pushing frames altogether.
    async fn absorb_frame(&mut self, v: &Value) {
        let Some(data) = v["params"]["data"].as_str() else {
            return;
        };
        let Some(flat) = v["sessionId"].as_str() else {
            return;
        };
        let ack_id = v["params"]["sessionId"].as_i64().unwrap_or(0);
        self.frames.retain(|(s, _)| s != flat);
        self.frames.push((flat.to_string(), data.to_string()));
        let id = self.next_id;
        self.next_id += 1;
        // Fire and forget: the ack's own reply is ignored by id mismatch.
        let ack = json!({
            "id": id,
            "method": "Page.screencastFrameAck",
            "sessionId": flat,
            "params": {"sessionId": ack_id},
        });
        let _ = self.tx.send(Message::Text(ack.to_string().into())).await;
    }

    /// Send one command and wait for its matching reply. Commands carry the
    /// current `sessionId` (flatten mode), so replies come back on the same
    /// socket tagged with the same id.
    pub(super) async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(session) = &self.session {
            msg["sessionId"] = json!(session);
        }
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("cdp send {method}: {e}"))?;
        let deadline = Instant::now() + CDP_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("cdp {method} timed out"));
            }
            let next = tokio::time::timeout(remaining, self.rx.next())
                .await
                .map_err(|_| format!("cdp {method} timed out"))?;
            let Some(Ok(Message::Text(txt))) = next else {
                continue;
            };
            let v: Value = match serde_json::from_str(&txt) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("method").and_then(Value::as_str) == Some("Page.screencastFrame") {
                self.absorb_frame(&v).await;
                continue;
            }
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue; // an event or another command's reply
            }
            if let Some(err) = v.get("error") {
                return Err(format!("cdp {method}: {err}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

// ---------------------------------------------------------------------------
// Shared CDP connection: ONE warm WebSocket for the whole app
// ---------------------------------------------------------------------------
//
// Every keystroke, hover move and frame used to open a fresh WebSocket
// (`/json/version` probe + handshake + `Target.attachToTarget` + viewport
// override) and spawn a fresh thread + tokio runtime for it. At the panel's
// input rate that work queued up faster than it drained — typing and the
// virtual cursor lagged seconds behind, and a size change sat minutes behind a
// flood of stale hover moves. One long-lived connection, driven by one thread
// that executes batches strictly in arrival order, turns every action into a
// single warm-socket command and preserves input order for free.

/// One batch of CDP commands, executed in order on the shared connection.
pub(super) struct CdpBatch {
    /// Tab to drive, or `None` for browser-level commands
    /// (Target.getTargets / createTarget / closeTarget / getTargetInfo).
    target: Option<String>,
    /// The tab's emulated viewport, applied when `with_viewport` is set.
    viewport: (u32, u32),
    /// Re-apply the emulated viewport before the commands: screenshots and
    /// input need the tab's coordinate space, while navigation must not drag
    /// it into the next page's first paint.
    with_viewport: bool,
    commands: Vec<(&'static str, Value)>,
    reply: std::sync::mpsc::Sender<Result<Vec<Value>, String>>,
}

/// Handle on the driver thread: its request channel plus the browser port the
/// connection was opened against.
pub(super) struct CdpPool {
    port: u16,
    tx: tokio::sync::mpsc::Sender<CdpBatch>,
}

/// The one driver serving every tab. `Option` (not a lazy cell) so the static
/// stays `const`-constructible.
pub(super) static CDP_POOL: Mutex<Option<CdpPool>> = Mutex::new(None);

/// Sender for the shared connection, (re)starting the driver thread when the
/// browser is new or was restarted on a different port.
pub(super) fn cdp_pool() -> Result<tokio::sync::mpsc::Sender<CdpBatch>, String> {
    let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
    let mut guard = CDP_POOL.lock().map_err(|_| "cdp pool poisoned")?;
    if let Some(pool) = guard.as_ref() {
        if pool.port == port {
            return Ok(pool.tx.clone());
        }
        // The browser restarted on another port — the old driver's socket is
        // dead, so fall through and spawn a fresh one. The old thread winds
        // down once its channel closes.
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<CdpBatch>(64);
    std::thread::Builder::new()
        .name("cdp-driver".to_string())
        .spawn(move || cdp_driver_main(rx))
        .map_err(|e| format!("cannot start the cdp driver: {e}"))?;
    *guard = Some(CdpPool { port, tx: tx.clone() });
    Ok(tx)
}

/// Drop the stored handle so the next call starts a fresh driver thread.
/// Called wherever the browser process is killed or replaced: a same-port
/// restart still self-heals via the transport-error retry, this just makes the
/// common path immediate.
pub(super) fn invalidate_cdp_pool() {
    if let Ok(mut guard) = CDP_POOL.lock() {
        *guard = None;
    }
}

/// True for errors that mean the CONNECTION or the cached session is gone
/// (browser restart, cross-process navigation) rather than the command itself
/// failing — those are retried once on a fresh connection. A timed-out command
/// is deliberately NOT retried: its reply may still be in flight, and replaying
/// a slow input event is worse than reporting the failure.
pub(super) fn is_transport_error(err: &str) -> bool {
    let low = err.to_ascii_lowercase();
    if low.contains("timed out") {
        return false;
    }
    low.contains("websocket")
        || low.contains("connect")
        || low.contains("closed")
        || low.contains("session")
        || low.contains("no target")
        || low.contains("target crashed")
        || low.contains("detached")
        || low.contains("io error")
        || low.contains("protocol")
        || low.contains("broken pipe")
        || low.contains("reset")
}

/// The driver: pull batches in arrival order and run each one to completion
/// before taking the next. Strict ordering is what keeps a typing burst (one
/// batch per flush) from being reordered behind later requests. Between
/// batches the loop reads the socket, so Chromium's PUSHED frames (screencast)
/// land in the frame cache instead of piling up unacked.
pub(super) fn cdp_driver_main(mut rx: tokio::sync::mpsc::Receiver<CdpBatch>) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    rt.block_on(async move {
        let mut conn: Option<Cdp> = None;
        // target_id -> flatten sessionId. Sessions outlive batches, so a tab is
        // attached ONCE and every later command rides the cached session.
        let mut sessions: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // Sessions with Page.startScreencast already running (frame push).
        let mut screencast_on: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        loop {
            if conn.is_none() {
                // No connection: there is nothing to race the channel against.
                match rx.recv().await {
                    Some(batch) => {
                        let res = run_batch(
                            &mut conn,
                            &mut sessions,
                            &mut screencast_on,
                            &batch,
                        )
                        .await;
                        let _ = batch.reply.send(res);
                    }
                    None => break,
                }
                continue;
            }
            tokio::select! {
                batch = rx.recv() => {
                    match batch {
                        Some(batch) => {
                            let res = run_batch(
                                &mut conn,
                                &mut sessions,
                                &mut screencast_on,
                                &batch,
                            )
                            .await;
                            let _ = batch.reply.send(res);
                        }
                        None => break,
                    }
                }
                msg = conn.as_mut().expect("connection checked above").rx.next() => {
                    on_socket_msg(&mut conn, &mut sessions, &mut screencast_on, msg).await;
                }
            }
        }
    });
}

/// Move the frames a connection absorbed into the shared per-tab cache, which
/// wakes the panel's long-poll.
pub(super) fn flush_frames(cdp: &mut Cdp, sessions: &std::collections::HashMap<String, String>) {
    for (flat, data) in std::mem::take(&mut cdp.frames) {
        let target = sessions
            .iter()
            .find(|(_, s)| **s == flat)
            .map(|(t, _)| t.clone());
        if let Some(target) = target {
            mark_pushed(&target);
            store_frame(&target, &format!("data:image/jpeg;base64,{data}"));
        }
    }
}

/// Handle one socket message while no batch is running. Screencast frames are
/// stored for the panel's long-poll and acked (an unacked frame stops the
/// stream); `Target.targetDestroyed` tears a popup out of the registry the
/// moment Chromium closes it (the "log in succeeded, popup closes" beat must
/// snap the panel back to the page instantly, not a poll later); everything
/// else — stray events, late replies — is dropped.
pub(super) async fn on_socket_msg(
    conn: &mut Option<Cdp>,
    sessions: &mut std::collections::HashMap<String, String>,
    screencast_on: &mut std::collections::HashSet<String>,
    msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) {
    let Some(Ok(Message::Text(txt))) = msg else {
        // Socket closed or errored: drop everything session-scoped so the
        // next batch reconnects and re-attaches from scratch.
        *conn = None;
        sessions.clear();
        screencast_on.clear();
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return;
    };
    match v.get("method").and_then(Value::as_str) {
        Some("Page.screencastFrame") => {
            if let Some(c) = conn.as_mut() {
                c.absorb_frame(&v).await;
                flush_frames(c, sessions);
            }
        }
        Some("Target.targetDestroyed") => {
            let gone = v["params"]["targetId"].as_str().unwrap_or_default();
            if !gone.is_empty() {
                if let Ok(mut popups) = POPUPS.lock() {
                    popups.retain(|p| p.target_id != gone);
                }
                drop_frame(gone);
            }
        }
        _ => {}
    }
}

/// Run one batch on the shared connection. On a transport-level failure the
/// connection (and the session cache) is dropped and the batch is replayed
/// once — the same "fresh connection" recovery the per-call design had for
/// free, without paying a reconnect on every success.
pub(super) async fn run_batch(
    conn: &mut Option<Cdp>,
    sessions: &mut std::collections::HashMap<String, String>,
    screencast_on: &mut std::collections::HashSet<String>,
    batch: &CdpBatch,
) -> Result<Vec<Value>, String> {
    for attempt in 0..2 {
        if conn.is_none() {
            let port = alive_port().ok_or_else(|| "browser is not running".to_string())?;
            *conn = Some(Cdp::connect(port).await?);
        }
        let cdp = conn.as_mut().expect("connection just checked");
        match &batch.target {
            Some(target_id) => {
                let session = match sessions.get(target_id) {
                    Some(s) => s.clone(),
                    None => {
                        let res = cdp
                            .send(
                                "Target.attachToTarget",
                                json!({"targetId": target_id, "flatten": true}),
                            )
                            .await?;
                        let s = res["sessionId"]
                            .as_str()
                            .ok_or_else(|| "attachToTarget returned no sessionId".to_string())?
                            .to_string();
                        sessions.insert(target_id.clone(), s.clone());
                        apply_user_agent(cdp, &s).await;
                        // A freshly attached POPUP's first document predates
                        // this session, so addScriptToEvaluateOnNewDocument
                        // never ran inside it. Re-run the consistency script
                        // IN the live document — a reload here was tried and
                        // is wrong: it fires exactly when the user starts
                        // clicking/typing and wipes their focus mid-flow.
                        // Future documents get the script via the registration.
                        if popup_root_of(target_id).is_some() {
                            let _ = cdp
                                .send(
                                    "Runtime.evaluate",
                                    json!({"expression": consistency_js()}),
                                )
                                .await;
                        }
                        s
                    }
                };
                cdp.session = Some(session.clone());
                // Push frames for this tab once per session: the panel's
                // long-poll then renders on every page repaint with no capture
                // round trip at all.
                if !screencast_on.contains(&session) {
                    let _ = cdp
                        .send(
                            "Page.startScreencast",
                            json!({
                                "format": "jpeg",
                                "quality": SCREENSHOT_QUALITY,
                                "maxWidth": 4096,
                                "maxHeight": 4096,
                                "everyNthFrame": 1,
                            }),
                        )
                        .await;
                    screencast_on.insert(session.clone());
                }
                // Only the DISPLAYED page may push frames. While a popup is on
                // screen its opener tab still screencasts — for a live-chart
                // page like TradingView that is a firehose of frames nobody
                // displays, all serialized through this one socket, and the
                // popup's own click/keystroke batches queue behind megabytes
                // of them (measured as "the popup works but seconds late").
                // Silence the opener while its popup is displayed; the normal
                // `!screencast_on` path restarts it the moment the panel is
                // back on the tab.
                if let Some(root_id) = popup_root_of(target_id) {
                    if let Some(root_session) = sessions.get(&root_id) {
                        if screencast_on.contains(root_session) {
                            let saved = cdp.session.clone();
                            cdp.session = Some(root_session.clone());
                            let _ = cdp.send("Page.stopScreencast", json!({})).await;
                            cdp.session = saved;
                            screencast_on.remove(root_session);
                        }
                    }
                }
            }
            None => cdp.session = None,
        }
        let mut calls: Vec<(&'static str, Value)> = Vec::new();
        // Re-send the override only when this session does not hold it yet
        // (first use, or the tab's size changed) — not on every input event.
        let mut prepended = false;
        if batch.with_viewport {
            let held = cdp
                .session
                .as_ref()
                .and_then(|s| cdp.applied_vp.get(s))
                .copied();
            if held != Some(batch.viewport) {
                calls = with_viewport_override(batch.viewport.0, batch.viewport.1, calls);
                prepended = true;
            }
        }
        calls.extend(batch.commands.iter().cloned());
        let mut out = Vec::with_capacity(calls.len());
        let mut failure = None;
        for (method, params) in calls {
            match cdp.send(method, params).await {
                Ok(v) => out.push(v),
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        match failure {
            None => {
                // The override's own reply is bookkeeping, not a result: strip
                // it so callers reading `out[0]` see the FIRST COMMAND's reply
                // (a missing strip made screenshot/current_url read the
                // override's ack and report "empty screenshot" forever).
                if prepended && !out.is_empty() {
                    out.remove(0);
                    if let Some(s) = cdp.session.clone() {
                        cdp.applied_vp.insert(s, batch.viewport);
                    }
                }
                // A batch that carries its own override (set_viewport) also
                // updates what the session holds.
                for (method, params) in &batch.commands {
                    if *method == "Emulation.setDeviceMetricsOverride" {
                        if let (Some(s), Some(w), Some(h)) = (
                            cdp.session.clone(),
                            params["width"].as_u64(),
                            params["height"].as_u64(),
                        ) {
                            cdp.applied_vp.insert(s, (w as u32, h as u32));
                        }
                    }
                }
                flush_frames(cdp, sessions);
                return Ok(out);
            }
            Some(e) if attempt == 0 && is_transport_error(&e) => {
                *conn = None;
                sessions.clear();
                screencast_on.clear();
                continue;
            }
            Some(e) => return Err(e),
        }
    }
    Err("cdp retry exhausted".to_string())
}

/// Submit one batch to the shared connection and wait for the result.
pub(super) fn cdp_batch(
    target: Option<&Tab>,
    with_viewport: bool,
    commands: Vec<(&'static str, Value)>,
) -> Result<Vec<Value>, String> {
    let tx = cdp_pool()?;
    let (reply, rx) = std::sync::mpsc::channel();
    let batch = CdpBatch {
        target: target.map(|t| t.target_id.clone()),
        viewport: target.map(|t| t.viewport).unwrap_or(DEFAULT_VIEWPORT),
        with_viewport,
        commands,
        reply,
    };
    // `try_send` (not an await): every caller of this fn sits in sync code on
    // an async runtime. A full queue means the driver is hopelessly behind —
    // erroring one stale batch beats buffering minutes of them.
    tx.try_send(batch)
        .map_err(|_| "the cdp driver is not accepting work".to_string())?;
    // Cdp::send already bounds every command at CDP_TIMEOUT; the headroom only
    // covers queueing behind the batches ahead of this one.
    match rx.recv_timeout(CDP_TIMEOUT + Duration::from_secs(5)) {
        Ok(res) => res,
        Err(_) => Err("the cdp driver did not answer in time".to_string()),
    }
}

/// Run a sequence of CDP commands against `tab` with the tab's emulated
/// viewport re-applied first (screenshots and input need the coordinate space).
pub(super) fn cdp_calls(tab: &Tab, calls: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    cdp_batch(Some(tab), true, calls)
}

/// Same batch with explicit control over the viewport override: navigation
/// must not drag the emulated size into the next page's first paint, while
/// `Emulation.setDeviceMetricsOverride` itself rides in its own batch.
pub(super) fn cdp_calls_on(
    tab: &Tab,
    calls: Vec<(&'static str, Value)>,
    with_viewport: bool,
) -> Result<Vec<Value>, String> {
    cdp_batch(Some(tab), with_viewport, calls)
}

/// Browser-level commands (no tab session): target discovery, creation, close.
pub(super) fn cdp_browser_batch(commands: Vec<(&'static str, Value)>) -> Result<Vec<Value>, String> {
    cdp_batch(None, false, commands)
}

// ---------------------------------------------------------------------------
// Pushed frames (Page.startScreencast)
// ---------------------------------------------------------------------------
//
// Polling Page.captureScreenshot cost a forced capture + JPEG encode on every
// panel tick and serialized against input on the shared connection — the
// click/keystroke feedback could never beat ~a capture time. Screencast flips
// it around: Chromium pushes a frame on every page REPAINT (a keystroke, a
// hover state, a navigation), the driver caches the latest one and acks it,
// and /browser/frame long-polls until something newer exists. Idle pages push
// nothing, so the idle cost is zero.

