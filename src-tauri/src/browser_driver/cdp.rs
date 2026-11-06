use super::*;

pub(super) type Pending = Arc<Mutex<HashMap<u64, Waiter<Result<Value, String>>>>>;

/// A live CDP session bound to ONE tab.
pub(super) struct CdpConn {
    /// Outgoing frames, consumed by the writer task on the runtime thread.
    tx: mpsc::UnboundedSender<String>,
    /// Commands waiting for their reply, keyed by request id.
    pending: Pending,
    /// `Target.attachToTarget` session, sent with every page command.
    session: String,
    /// `Page.loadEventFired` counter — the navigation-settled signal.
    pub(super) load_count: Arc<AtomicU64>,
    /// Console/exception log captured by the reader loop.
    pub(super) logs: Arc<Mutex<Vec<Value>>>,
    /// Network request log captured by the reader loop.
    pub(super) net: Arc<Mutex<Vec<Value>>>,
    /// What to do with the NEXT `javascriptDialogOpening` (accept, prompt text).
    pub(super) dialog: Arc<Mutex<(bool, String)>>,
}

impl CdpConn {
    /// Open the browser-level WebSocket, attach to `target`, and hand back a
    /// connection whose reader loop is already running.
    pub(super) fn start(ws_url: String, target: String) -> Result<Self, String> {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let load_count = Arc::new(AtomicU64::new(0));
        let logs: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let net: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let dialog: Arc<Mutex<(bool, String)>> = Arc::new(Mutex::new((false, String::new())));

        // Readiness handshake: the caller must learn WHY a connect failed, but
        // nothing may outlive the handshake or a failed connect would block the
        // caller for the full timeout.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let err_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let p = pending.clone();
        let lc = load_count.clone();
        let lg = logs.clone();
        let nt = net.clone();
        let dl = dialog.clone();
        let errs = err_slot.clone();
        let tx_events = tx.clone();

        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("browser runtime: {e}")));
                    return;
                }
            };
            let outcome: Result<(), String> = rt.block_on(async move {
                let ws = tokio_tungstenite::connect_async(&ws_url)
                    .await
                    .map_err(|e| format!("cdp connect failed: {e}"))?
                    .0;
                let (mut sink, mut stream) = ws.split();
                let attach = json!({
                    "id": 1u64,
                    "method": "Target.attachToTarget",
                    "params": {"targetId": target, "flatten": true},
                });
                sink.send(Message::Text(attach.to_string().into()))
                    .await
                    .map_err(|e| format!("cdp attach send: {e}"))?;
                let deadline = Instant::now() + CDP_CALL_TIMEOUT;
                let mut session: Option<String> = None;
                while session.is_none() {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err("timed out attaching to the tab".to_string());
                    }
                    let next = match tokio::time::timeout(left, stream.next()).await {
                        Ok(Some(Ok(msg))) => msg,
                        Ok(Some(Err(e))) => return Err(format!("cdp attach: {e}")),
                        _ => return Err("cdp closed while attaching".to_string()),
                    };
                    let Message::Text(txt) = next else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
                        continue;
                    };
                    if v.get("id").and_then(Value::as_u64) != Some(1) {
                        continue;
                    }
                    if let Some(err) = v.get("error") {
                        return Err(format!("attach failed: {err}"));
                    }
                    session = v["result"]["sessionId"].as_str().map(str::to_string);
                }
                let session = session.expect("session checked above");
                let session_for_events = session.clone();
                let _ = ready_tx.send(Ok(session));

                let mut rx = rx;
                let writer = async move {
                    while let Some(txt) = rx.recv().await {
                        if sink.send(Message::Text(txt.into())).await.is_err() {
                            break;
                        }
                    }
                };
                let reader = async move {
                    let mut open: HashMap<String, usize> = HashMap::new();
                    while let Some(Ok(msg)) = stream.next().await {
                        let Message::Text(txt) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<Value>(&txt) else {
                            continue;
                        };
                        if let Some(id) = v.get("id").and_then(Value::as_u64) {
                            if id == NO_REPLY_ID {
                                continue;
                            }
                            let waiter = p.lock().ok().and_then(|mut m| m.remove(&id));
                            if let Some(w) = waiter {
                                let _ = match v.get("error") {
                                    Some(err) => w.send(Err(format!("cdp error: {err}"))),
                                    None => w.send(Ok(v
                                        .get("result")
                                        .cloned()
                                        .unwrap_or(Value::Null))),
                                };
                            }
                            continue;
                        }
                        let method = v.get("method").and_then(Value::as_str).unwrap_or_default();
                        let params = v.get("params").cloned().unwrap_or(Value::Null);
                        match method {
                            "Page.loadEventFired" => {
                                // The only event whose counter the driver reads
                                // back: `wait_load` blocks on it.
                                lc.fetch_add(1, Ordering::Relaxed);
                            }
                            "Runtime.consoleAPICalled" => push_capped(
                                &lg,
                                json!({
                                    "kind": "console",
                                    "level": params["type"].as_str().unwrap_or("log"),
                                    "time": params["timestamp"].as_f64().unwrap_or_default(),
                                    "text": console_text(&params["args"]),
                                }),
                                LOG_CAP,
                            ),
                            "Runtime.exceptionThrown" => push_capped(
                                &lg,
                                json!({
                                    "kind": "exception",
                                    "level": "error",
                                    "time": params["timestamp"].as_f64().unwrap_or_default(),
                                    "text": params["exceptionDetails"]["exception"]["description"]
                                        .as_str()
                                        .or_else(|| params["exceptionDetails"]["text"].as_str())
                                        .unwrap_or("uncaught exception"),
                                }),
                                LOG_CAP,
                            ),
                            "Log.entryAdded" => {
                                let e = &params["entry"];
                                push_capped(
                                    &lg,
                                    json!({
                                        "kind": "log",
                                        "level": e["level"].as_str().unwrap_or("info"),
                                        "time": e["timestamp"].as_f64().unwrap_or_default(),
                                        "text": e["text"].as_str().unwrap_or_default(),
                                    }),
                                    LOG_CAP,
                                );
                            }
                            "Network.requestWillBeSent" => {
                                let id = params["requestId"].as_str().unwrap_or_default().to_string();
                                let mut buf = match nt.lock() {
                                    Ok(b) => b,
                                    Err(_) => continue,
                                };
                                if buf.len() >= NET_CAP {
                                    buf.remove(0);
                                    open.clear();
                                }
                                open.insert(id.clone(), buf.len());
                                buf.push(json!({
                                    "id": id,
                                    "method": params["request"]["method"].as_str().unwrap_or_default(),
                                    "url": params["request"]["url"].as_str().unwrap_or_default(),
                                    "type": params["type"].as_str().unwrap_or_default(),
                                    "status": null,
                                }));
                            }
                            "Network.responseReceived" => {
                                let id = params["requestId"].as_str().unwrap_or_default();
                                if let (Ok(mut buf), Some(&idx)) = (nt.lock(), open.get(id)) {
                                    if let Some(row) = buf.get_mut(idx) {
                                        row["status"] = params["response"]["status"].clone();
                                    }
                                }
                            }
                            "Page.javascriptDialogOpening" => {
                                let accept = dl.lock().map(|d| d.0).unwrap_or(false);
                                let prompt = dl
                                    .lock()
                                    .map(|d| d.1.clone())
                                    .unwrap_or_default();
                                push_capped(
                                    &lg,
                                    json!({
                                        "kind": "dialog",
                                        "level": "warn",
                                        "time": 0,
                                        "text": format!(
                                            "{} ({}): {}",
                                            params["type"].as_str().unwrap_or("dialog"),
                                            if accept { "accepted" } else { "dismissed" },
                                            params["message"].as_str().unwrap_or_default()
                                        ),
                                    }),
                                    LOG_CAP,
                                );
                                // A dialog blocks every later command, so it is
                                // always answered; the policy only decides HOW.
                                let reply = json!({
                                    "id": NO_REPLY_ID,
                                    "method": "Page.handleJavaScriptDialog",
                                    "sessionId": session_for_events,
                                    "params": {"accept": accept, "promptText": prompt},
                                });
                                let _ = tx_events.send(reply.to_string());
                            }
                            _ => {}
                        }
                    }
                };
                tokio::join!(writer, reader);
                Ok(())
            });
            if let Err(e) = outcome {
                if let Ok(mut slot) = errs.lock() {
                    *slot = Some(e);
                }
            }
        });

        match ready_rx.recv_timeout(CDP_CALL_TIMEOUT + Duration::from_secs(5)) {
            Ok(Ok(session)) => Ok(Self {
                tx,
                pending,
                session,
                load_count,
                logs,
                net,
                dialog,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let reason = err_slot
                    .lock()
                    .ok()
                    .and_then(|s| s.clone())
                    .unwrap_or_else(|| "the browser connection closed".to_string());
                Err(reason)
            }
        }
    }

    /// Attach this connection to another tab of the same browser.
    pub(super) fn attach(&mut self, target: &str) -> Result<(), String> {
        let res = self.call(
            "Target.attachToTarget",
            json!({"targetId": target, "flatten": true}),
        )?;
        let session = res["sessionId"]
            .as_str()
            .ok_or_else(|| "attachToTarget returned no sessionId".to_string())?;
        self.session = session.to_string();
        Ok(())
    }

    pub(super) fn enable_domains(&mut self) {
        // Failures are non-fatal: an old Chromium may not support a domain, and
        // the op that actually needs it will report the real error.
        for method in [
            "Page.enable",
            "Runtime.enable",
            "Log.enable",
            "Network.enable",
            "DOM.enable",
        ] {
            let _ = self.call(method, json!({}));
        }
        // Present the same Chrome identity as the panel's session (see
        // `driver_hooks::identity`). Best effort: a failure keeps the default.
        if let Some((ua, js)) = crate::browser::driver_hooks::identity() {
            let _ = self.call("Emulation.setUserAgentOverride", ua);
            let _ = self.call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": js}),
            );
        }
    }
}

/// Render `Runtime.consoleAPICalled` args into one line.
pub(super) fn console_text(args: &Value) -> String {
    let Some(list) = args.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for a in list {
        if let Some(s) = a["value"].as_str() {
            parts.push(s.to_string());
        } else if let Some(s) = a["description"].as_str() {
            parts.push(s.to_string());
        } else if let Some(v) = a["value"].as_f64() {
            parts.push(v.to_string());
        } else if let Some(v) = a["value"].as_bool() {
            parts.push(v.to_string());
        } else {
            parts.push(a["type"].as_str().unwrap_or("object").to_string());
        }
    }
    parts.join(" ")
}

pub(super) fn push_capped(buf: &Arc<Mutex<Vec<Value>>>, item: Value, cap: usize) {
    if let Ok(mut b) = buf.lock() {
        if b.len() >= cap {
            b.remove(0);
        }
        b.push(item);
    }
}

// ---------------------------------------------------------------------------
// Driver: one per chat, holding the ref table
// ---------------------------------------------------------------------------

impl CdpConn {
    /// Send one command and wait for its reply.
    ///
    /// Takes `&self`: a driver op holds the driver lock for its whole duration,
    /// so the reader loop (which owns the other half) must never need it. The
    /// request id comes from a global atomic so two connections can never mint
    /// the same id.
    pub(super) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, CDP_CALL_TIMEOUT)
    }

    fn call_timeout(&self, method: &str, params: Value, ttl: Duration) -> Result<Value, String> {
        let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut p = self.pending.lock().map_err(|_| "cdp pending lock poisoned")?;
            p.insert(id, tx);
        }
        let browser_level = method.starts_with("Target.") || method.starts_with("Browser.");
        let mut msg = json!({"id": id, "method": method, "params": params});
        if !browser_level {
            msg["sessionId"] = json!(self.session);
        }
        if self.tx.send(msg.to_string()).is_err() {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err("the browser connection is closed".to_string());
        }
        match rx.recv_timeout(ttl) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("cdp {method} timed out"))
            }
        }
    }
}

/// Global request counter: two connections in the same process must never mint
/// the same id, because the reader loop routes replies by id alone. Starts well
/// above the ids the attach handshake uses so the two shapes never collide.
pub(super) static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1_000_000);

// ---------------------------------------------------------------------------
// Driver registry
// ---------------------------------------------------------------------------

/// True when an error means the connection (not the command) is gone, so the
/// caller should reconnect once and retry.
pub(super) fn is_stale(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("connection is closed")
        || e.contains("no target")
        || e.contains("session with given id not found")
        || e.contains("target closed")
        || e.contains("inspected target navigated or closed")
        || e.contains("cdp attach")
        || e.contains("cdp connect failed")
}

