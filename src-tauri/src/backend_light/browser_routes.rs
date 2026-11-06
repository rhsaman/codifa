use super::*;

/// POST /doc/read — extract text or render styled HTML for the file viewer.
/// Ported from `backend/doc_tools.py`: the Python sidecar is no longer
/// involved in reading documents.
pub(super) async fn doc_read(Json(body): Json<crate::docs::DocReadBody>) -> Response<Body> {
    // Parsing a PDF or a large spreadsheet is CPU-bound and can take seconds:
    // run it on the blocking pool so one big document never stalls the other
    // loopback requests (chat stream, settings, ...).
    match tokio::task::spawn_blocking(move || crate::docs::handle_doc_read(body)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => Json(json!({ "error": format!("document read failed: {e}") })).into_response(),
    }
}

// ---------- /browser/* (native in-app browser) ----------
//
// The panel sends `chat_id` as a query param on GET and inside the JSON body
// on POST (see BrowserPanel.sidecarFetch), so both are accepted here.

pub(super) fn chat_id_of(body: &Value, query: &HashMap<String, String>) -> String {
    body.get("chat_id")
        .and_then(Value::as_str)
        .or_else(|| query.get("chat_id").map(String::as_str))
        .unwrap_or_default()
        .to_string()
}

/// Run one blocking `browser::*` call off the router's async workers.
///
/// The router runtime has only TWO worker threads, and every browser call
/// blocks (channel wait on the CDP driver, a helper thread + runtime, sleeps).
/// Calling them inline parked both workers whenever two requests overlapped
/// (status poll + a keystroke), freezing the whole local API — typing, hover
/// and the fit button all lagged behind it. `spawn_blocking` keeps the async
/// workers free.
pub(super) async fn off<F>(f: F) -> Response<Body>
where
    F: FnOnce() -> Value + Send + 'static,
{
    let v = tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| json!({"ok": false, "error": format!("browser task failed: {e}")}));
    Json(v).into_response()
}

pub(super) async fn browser_status(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    off(move || crate::browser::status(&chat)).await
}

/// Start the one-click download of the app's own automation browser.
///
/// Returns immediately: the download and unpack run on a plain thread (see
/// `browser::install`), and the panel follows `/browser/install/status`.
pub(super) async fn browser_install() -> Response<Body> {
    crate::browser::install();
    Json(crate::browser::install_status()).into_response()
}

/// Progress of the automation-browser install, plus whether the browser is
/// usable right now (the panel uses `available` to decide between the browser
/// UI and the install affordance only while there is no running session).
pub(super) async fn browser_install_status() -> Response<Body> {
    Json(crate::browser::install_status()).into_response()
}

pub(super) async fn browser_launch(Json(body): Json<Value>) -> Response<Body> {    let url = body["url"].as_str().unwrap_or("about:blank");
    let chat = chat_id_of(&body, &HashMap::new());
    let url = url.to_string();
    off(move || crate::browser::launch(&url, &chat)).await
}

/// Navigate an ALREADY running session (the panel's address bar).
pub(super) async fn browser_navigate(Json(body): Json<Value>) -> Response<Body> {
    let url = body["url"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    let url = url.to_string();
    off(move || crate::browser::navigate_to(&url, &chat)).await
}

pub(super) async fn browser_screenshot(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    off(move || crate::browser::screenshot(&chat)).await
}

/// Long-poll the tab's latest pushed frame (`after` = last seq the panel has).
/// Answers the moment the page repaints; times out quietly after ~4s with no
/// new frame, and the panel simply asks again.
pub(super) async fn browser_frame(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    let after = q
        .get("after")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    Json(crate::browser::frame(&chat, after).await).into_response()
}

pub(super) async fn browser_click(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    // A ref (or a selector) means the panel/agent is asking for a real element
    // click: run it through the native driver, which resolves and scrolls the
    // element. Raw x/y stays on the arm's coordinate path.
    if body.get("ref").is_some() || body.get("selector").is_some() {
        let b = body.clone();
        return off(move || driver_json("click", &b, &chat)).await;
    }
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    off(move || crate::browser::click(x, y, &chat)).await
}

/// Run one `browser_driver` action and render it as the `{ok, text}` /
/// `{ok, error}` envelope the renderer already understands.
pub(super) fn driver_json(action: &str, body: &Value, chat: &str) -> Value {
    match crate::browser_driver::run(action, body, chat) {
        Ok(text) => json!({"ok": true, "text": text}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

pub(super) async fn browser_type(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    if body.get("ref").is_some() || body.get("selector").is_some() {
        let b = body.clone();
        return off(move || driver_json("type", &b, &chat)).await;
    }
    let text = body["text"].as_str().unwrap_or_default();
    let text = text.to_string();
    off(move || crate::browser::type_text(&text, &chat)).await
}

pub(super) async fn browser_scroll(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    if body.get("ref").is_some() || body.get("selector").is_some() {
        let b = body.clone();
        return off(move || driver_json("scroll", &b, &chat)).await;
    }
    let dx = body["dx"].as_i64().unwrap_or_default();
    let dy = body["dy"].as_i64().unwrap_or_default();
    off(move || crate::browser::scroll(dx, dy, &chat)).await
}

/// `browser_snapshot` for the panel: the same ref list the agent sees, so a
/// user-driven click can be expressed as a ref instead of a pixel.
pub(super) async fn browser_snapshot(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    let b = body.clone();
    off(move || driver_json("snapshot", &b, &chat)).await
}

pub(super) async fn browser_move(Json(body): Json<Value>) -> Response<Body> {
    let x = body["x"].as_i64().unwrap_or_default();
    let y = body["y"].as_i64().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    off(move || crate::browser::move_mouse(x, y, &chat)).await
}

pub(super) async fn browser_key(Json(body): Json<Value>) -> Response<Body> {
    let key = body["key"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    let key = key.to_string();
    off(move || crate::browser::press_key(&key, &chat)).await
}

pub(super) async fn browser_viewport(Json(body): Json<Value>) -> Response<Body> {
    let w = body["width"].as_u64().unwrap_or(1280) as u32;
    let h = body["height"].as_u64().unwrap_or(800) as u32;
    let chat = chat_id_of(&body, &HashMap::new());
    off(move || crate::browser::set_viewport(w, h, &chat)).await
}

pub(super) async fn browser_history(Json(body): Json<Value>) -> Response<Body> {
    let action = body["action"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    let action = action.to_string();
    off(move || crate::browser::history(&action, &chat)).await
}

pub(super) async fn browser_search(Json(body): Json<Value>) -> Response<Body> {
    let query = body["query"].as_str().unwrap_or_default();
    let chat = chat_id_of(&body, &HashMap::new());
    let query = query.to_string();
    off(move || crate::browser::search(&query, &chat)).await
}

pub(super) async fn browser_devtools_url(Query(q): Query<HashMap<String, String>>) -> Response<Body> {
    let chat = q.get("chat_id").cloned().unwrap_or_default();
    off(move || crate::browser::devtools_url(&chat)).await
}

/// Import pasted session cookies into the shared browser profile ("log in
/// once in the user's real browser, keep the session inside the app") — the
/// path for sites whose server-side bot defense rejects every login form the
/// automation browser submits, Instagram above all.
pub(super) async fn browser_cookies_import(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    let domain = body["domain"].as_str().unwrap_or_default().to_string();
    let text = body["text"].as_str().unwrap_or_default().to_string();
    off(move || crate::browser::import_cookies(&chat, &domain, &text)).await
}

pub(super) async fn browser_close(Json(body): Json<Value>) -> Response<Body> {
    let chat = chat_id_of(&body, &HashMap::new());
    off(move || crate::browser::close(&chat)).await
}

/// Catch-all: no Python sidecar exists any more, so an unknown path is a real
/// 404. Naming the path (and pointing at the log) makes a stale renderer call
/// diagnosable instead of looking like a network failure.
pub(super) async fn not_found(req: Request<Body>) -> Response<Body> {
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    eprintln!("[router] no route for {path}");
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": format!("no such endpoint: {path}") })),
    )
        .into_response()
}

