use super::*;

pub(super) struct Driver {
    pub(super) chat: String,
    /// Target id of the tab this driver is attached to (the `tabs` op switches
    /// it; `hooks::set_target` keeps the panel's registry in step).
    pub(super) target: String,
    pub(super) conn: CdpConn,
    /// Monotonic ref counter: a ref is never reused, so an old one either
    /// resolves to its element or reports "gone".
    pub(super) next_ref: usize,
    /// Snapshots whose refs are still resolvable, newest last.
    pub(super) snapshots: Vec<(usize, Snapshot)>,
    /// Version of the newest snapshot.
    pub(super) current: Option<usize>,
    /// Version whose full page render was already sent to the model. A repeated
    /// `full=true` on the same unchanged version answers with a short note
    /// instead of resending the whole page (traced: 14 full re-reads).
    pub(super) full_sent_version: Option<usize>,
    pub(super) seq: usize,
}

/// Per-chat drivers. A plain `Mutex<Vec<..>>` so the static stays
/// `const`-constructible, matching the registry style in `browser.rs`.
pub(super) static DRIVERS: Mutex<Vec<(String, Arc<Mutex<Driver>>)>> = Mutex::new(Vec::new());

impl Driver {
    fn connect(chat: &str) -> Result<Self, String> {
        // `ensure_target` starts the whole browser when the chat has no tab yet,
        // so the agent's first browser call works without the panel being open.
        let target = hooks::ensure_target(chat)?;
        let port = hooks::port().ok_or_else(|| "browser is not running".to_string())?;
        let ws_url = hooks::ws_url(port)?;
        let mut conn = CdpConn::start(ws_url, target.clone())?;
        conn.enable_domains();
        Ok(Self {
            chat: chat.to_string(),
            target,
            conn,
            next_ref: 1,
            snapshots: Vec::new(),
            current: None,
            full_sent_version: None,
            seq: 0,
        })
    }

    pub(super) fn url(&self) -> String {
        self.eval("location.href", false)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    pub(super) fn title(&self) -> String {
        self.eval("document.title", false)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    /// `Runtime.evaluate`, returning the value (not the node).
    pub(super) fn eval(&self, expr: &str, await_promise: bool) -> Result<Value, String> {
        eval_on(&self.conn, expr, await_promise)
    }
}

pub(super) fn eval_on(conn: &CdpConn, expr: &str, await_promise: bool) -> Result<Value, String> {
    let res = conn.call(
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": true,
            "awaitPromise": await_promise,
            "userGesture": true,
        }),
    )?;
    if res["exceptionDetails"].is_object() {
        return Err(format!(
            "page error: {}",
            res["exceptionDetails"]["exception"]["description"]
                .as_str()
                .or_else(|| res["exceptionDetails"]["text"].as_str())
                .unwrap_or("evaluation failed")
        ));
    }
    Ok(res["result"]["value"].clone())
}

pub(super) fn node_on(conn: &CdpConn, expr: &str) -> Result<String, String> {
    let res = conn.call(
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": false,
            "awaitPromise": false,
            "userGesture": true,
        }),
    )?;
    res["result"]["objectId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            let detail = res["result"]["description"]
                .as_str()
                .unwrap_or("no element matched");
            format!("element not found ({detail})")
        })
}

pub(super) fn chat_key(chat: &str) -> String {
    hooks::chat_key(chat)
}

pub(super) fn cached_driver(chat: &str) -> Option<Arc<Mutex<Driver>>> {
    let list = DRIVERS.lock().ok()?;
    list.iter()
        .find(|(k, _)| k == chat)
        .map(|(_, d)| d.clone())
}

pub(super) fn store_driver(chat: &str, driver: Arc<Mutex<Driver>>) -> Arc<Mutex<Driver>> {
    let Ok(mut list) = DRIVERS.lock() else {
        return driver;
    };
    if let Some((_, existing)) = list.iter().find(|(k, _)| k == chat) {
        // Another thread won the race: keep its connection, drop ours.
        return existing.clone();
    }
    list.push((chat.to_string(), driver.clone()));
    driver
}

pub(super) fn driver_for(chat: &str) -> Result<Arc<Mutex<Driver>>, String> {
    if let Some(d) = cached_driver(chat) {
        return Ok(d);
    }
    let fresh = Arc::new(Mutex::new(Driver::connect(chat)?));
    Ok(store_driver(chat, fresh))
}

/// Drop the cached driver for a chat (used when the connection died).
pub(super) fn drop_driver(chat: &str) {
    if let Ok(mut list) = DRIVERS.lock() {
        list.retain(|(k, _)| k != chat);
    }
}

/// Forget a chat's driver from outside this module (called when the browser
/// reaps that chat's tab).
///
/// The cached driver holds a CDP WebSocket and the page snapshots it collected;
/// once its target is closed it can never answer again, so keeping it is a
/// retained allocation plus a ref table that will never resolve. Only the
/// module's own `drop_driver` knew how to release it.
pub(crate) fn forget(chat: &str) {
    drop_driver(&chat_key(chat));
}

/// Run `f` with the chat's driver, reconnecting ONCE when the connection turns
/// out to be dead (the browser was reaped, the tab was closed, the renderer
/// swapped processes on a cross-site navigation).
pub(super) fn with_driver<F, T>(chat: &str, mut f: F) -> Result<T, String>
where
    F: FnMut(&mut Driver) -> Result<T, String>,
{
    let key = chat_key(chat);
    let handle = driver_for(&key)?;
    let mut guard = handle
        .lock()
        .map_err(|_| "browser driver lock poisoned".to_string())?;
    match f(&mut guard) {
        Ok(v) => Ok(v),
        Err(e) if is_stale(&e) => {
            drop(guard);
            drop_driver(&key);
            let fresh = driver_for(&key)?;
            let mut guard = fresh
                .lock()
                .map_err(|_| "browser driver lock poisoned".to_string())?;
            f(&mut guard)
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Refs, elements and coordinates
// ---------------------------------------------------------------------------

