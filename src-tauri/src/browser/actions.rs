use super::*;

/// The `status` payload the panel polls (same keys as the Python sidecar).
pub fn status(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = active_tab(&chat) else {
        return json!({
            "ok": true,
            "active": false,
            "url": "",
            "viewport": {"width": DEFAULT_VIEWPORT.0, "height": DEFAULT_VIEWPORT.1},
            "available": find_chromium().is_some(),
            "chat": chat,
            "cdp": Value::Null,
        });
    };
    let url = current_url(&tab);
    json!({
        "ok": true,
        "active": true,
        "url": url,
        "viewport": {"width": tab.viewport.0, "height": tab.viewport.1},
        "available": true,
        "chat": chat,
        "cdp": alive_port().map(|p| format!("http://127.0.0.1:{p}")),
    })
}

/// Navigate a tab, idempotently (an existing tab is reused).
pub(super) fn navigate(tab: &Tab, url: &str) -> Result<(), String> {
    cdp_calls_on(
        tab,
        vec![("Page.navigate", json!({"url": url}))],
        false,
    )
    .map(|_| ())
}

/// Navigate an already-open chat tab (the panel's address bar). Unlike `launch`
/// this never starts a browser: a down session reports the same
/// "browser is not running" error the panel already handles.
pub fn navigate_to(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let target = url.trim();
    if target.is_empty() {
        return json!({"ok": false, "error": "empty url"});
    }
    // Already there: re-issuing the same URL is a full reload, and the panel
    // syncs its omnibox from `status` on every poll — so a chat switch (which
    // remounts the panel) used to reload the page the agent was working on.
    // Comparing here makes navigation idempotent for every caller.
    let showing = current_url(&tab);
    if same_page(&showing, target) {
        return json!({"ok": true, "url": showing});
    }
    let tab_for_call = tab.clone();
    let tab_for_settle = tab.clone();
    let target_owned = target.to_string();
    match block_on(async move {
        navigate(&tab_for_call, &target_owned)?;
        Ok(Value::Null)
    }) {
        Ok(_) => {
            // Wait for the navigation to commit AND settle so the returned url
            // is the new page rather than the one being left (a fixed sleep
            // both raced slow pages and wasted time on fast ones). On a thrown
            // thread, so the axum worker is never parked for up to 8s.
            let _ = block_on(async move {
                wait_page_settled(&tab_for_settle, Duration::from_secs(8)).await;
                Ok(Value::Null)
            });
            json!({"ok": true, "url": current_url(&tab)})
        }
        Err(e) => json!({"ok": false, "error": format!("navigation failed: {e}")}),
    }
}

/// Launch (or reuse) the chat's tab and optionally navigate it.
pub fn launch(url: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let target = url.trim();
    let tab = match active_tab(&chat) {
        Some(t) => t,
        None => match ensure_tab(&chat) {
            Ok(t) => t,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    // A fresh tab starts on about:blank; only navigate when asked for a real
    // page (and not the one already showing).
    if !target.is_empty() && target != "about:blank" {
        let current = current_url(&tab);
        if current != target {
            if let Err(e) = navigate(&tab, target) {
                return json!({"ok": false, "error": format!("navigation failed: {e}")});
            }
        }
    }
    let _ = set_viewport(DEFAULT_VIEWPORT.0, DEFAULT_VIEWPORT.1, &chat);
    status(&chat)
}

/// Wait until the tab's document leaves the `loading` state (bounded).
///
/// `Page.captureScreenshot` on a document that is still loading — or whose
/// first paint has not landed yet — returns a BLACK frame: the reported
/// "the page goes black during UI tests". ZCode's own browser tooling waits
/// for the load state before every observation; this is the same rule,
/// enforced centrally so every consumer (the panel's status poll and the
/// agent's tool calls) is covered. Falls through on the timeout so a page
/// that never settles still produces a frame.
pub(super) async fn wait_page_settled(tab: &Tab, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let ready = cdp_calls_on(
            tab,
            vec![("Runtime.evaluate", json!({
                "expression": "document.readyState",
                "returnByValue": true,
            }))],
            false,
        );
        let settled = ready
            .ok()
            .and_then(|res| res.into_iter().next())
            .and_then(|r| {
                // Runtime.evaluate's reply carries the RemoteObject under its
                // own `result` key (`{"result": {"result": {...}}}` on the
                // wire, one level stripped by `Cdp::send`). Reading one level
                // deeper than that always yielded Null, so every navigation
                // waited out the whole timeout instead of settling early.
                r["result"]["value"]
                    .as_str()
                    .map(str::to_string)
            })
            .map(|v| v == "interactive" || v == "complete")
            .unwrap_or(false);
        if settled || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// One JPEG frame as a data URI (the panel renders it directly).
///
/// The device-metrics override rides in the capture batch (`cdp_calls`
/// prepends it): `Emulation.setDeviceMetricsOverride` is scoped to the CDP
/// session, and the session a screenshot drives must hold the tab's emulated
/// size before the capture, whatever ran before it.
pub fn screenshot(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = active_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    let tab_for_call = tab.clone();
    let fut = async move {
        // A settled page captures cleanly; an unsettled one gets a readiness
        // wait first. Each check is one warm-socket command now.
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut waited = false;
        loop {
            let ready = cdp_calls(
                &tab_for_call,
                vec![(
                    "Runtime.evaluate",
                    json!({
                        "expression": "document.readyState",
                        "returnByValue": true,
                    }),
                )],
            );
            let settled = ready
                .ok()
                .and_then(|res| res.into_iter().next())
                .and_then(|res| {
                    // Same reply depth as `wait_page_settled`: one `result`
                    // from the CDP envelope (stripped by send), one from the
                    // RemoteObject. A deeper read was always Null and made
                    // every seed capture burn its whole 6s deadline.
                    res["result"]["value"]
                        .as_str()
                        .map(str::to_string)
                })
                .map(|v| v == "interactive" || v == "complete")
                .unwrap_or(false);
            if settled || Instant::now() >= deadline {
                break;
            }
            waited = true;
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if waited {
            // One paint beat after readyState flips: the first composited
            // frame usually lands right behind the DOM reporting ready —
            // capturing on the readyState tick alone still races it every few
            // pages. A page that was ALREADY settled needs no beat; skipping
            // it here never covered a resize (the override below re-lays-out
            // synchronously before the capture).
            tokio::time::sleep(Duration::from_millis(180)).await;
        }
        let res = cdp_calls(
            &tab_for_call,
            vec![(
                "Page.captureScreenshot",
                json!({"format": "jpeg", "quality": SCREENSHOT_QUALITY}),
            )],
        )?;
        Ok(res
            .into_iter()
            .next()
            .and_then(|v| v["data"].as_str().map(str::to_string))
            .unwrap_or_default())
    };
    match block_on(fut) {
        Ok(b64) if !b64.is_empty() => json!({
            "ok": true,
            "image": format!("data:image/jpeg;base64,{b64}"),
            "width": w,
            "height": h,
        }),
        Ok(_) => json!({"ok": false, "error": "empty screenshot"}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Dispatch one mouse event at viewport coordinates.
pub(super) fn mouse_event(
    tab: &Tab,
    kind: &'static str,
    x: i64,
    y: i64,
    extra: Value,
) -> Result<(), String> {
    let mut params = json!({"type": kind, "x": x, "y": y});
    if let (Some(dst), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            dst.insert(k.clone(), v.clone());
        }
    }
    cdp_calls(tab, vec![("Input.dispatchMouseEvent", params)]).map(|_| ())
}

/// Click at viewport coordinates.
///
/// Press and release ride in ONE batch: on the shared, strictly ordered
/// connection two separate requests could be interleaved by a hover move from
/// the panel, splitting the click.
pub fn click(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let press = json!({
        "type": "mousePressed",
        "x": x,
        "y": y,
        "button": "left",
        "clickCount": 1,
        "buttons": 1,
    });
    let release = json!({
        "type": "mouseReleased",
        "x": x,
        "y": y,
        "button": "left",
        "clickCount": 1,
        "buttons": 0,
    });
    match cdp_calls(
        &tab,
        vec![
            ("Input.dispatchMouseEvent", press),
            ("Input.dispatchMouseEvent", release),
        ],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Move the virtual cursor (hover).
pub fn move_mouse(x: i64, y: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    match mouse_event(&tab, "mouseMoved", x, y, json!({"buttons": 0})) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Whether `text` is short enough to be typed key by key. Long runs and text
/// with line breaks keep the single `Input.insertText` call: they are pastes in
/// practice, and thousands of key events would only slow them down.
pub(crate) fn is_short_plain_text(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= 80 && !text.contains(['\n', '\r', '\t'])
}

/// The keyDown/keyUp pair for one typed character.
///
/// `Input.insertText` changes the field but fires no `keydown`/`keyup`, which is
/// exactly how a script tells a person from an automated client. Real events
/// carry the key, its text and (for ASCII) the physical code and key code.
pub(crate) fn char_key_events(ch: char) -> [Value; 2] {
    let key = ch.to_string();
    let mut base = json!({"key": key, "text": key, "unmodifiedText": key});
    let (code, vk): (Option<String>, u32) = if ch.is_ascii_alphabetic() {
        let up = ch.to_ascii_uppercase();
        (Some(format!("Key{up}")), up as u32)
    } else if ch.is_ascii_digit() {
        (Some(format!("Digit{ch}")), ch as u32)
    } else if ch == ' ' {
        (Some("Space".to_string()), 32)
    } else {
        (None, 0)
    };
    if let Some(code) = code {
        base["code"] = json!(code);
        base["windowsVirtualKeyCode"] = json!(vk);
        base["nativeVirtualKeyCode"] = json!(vk);
    }
    if ch.is_ascii_uppercase() {
        base["modifiers"] = json!(8); // Shift
    }
    let mut down = base.clone();
    down["type"] = json!("keyDown");
    let mut up = base;
    up["type"] = json!("keyUp");
    if let Some(o) = up.as_object_mut() {
        o.remove("text");
        o.remove("unmodifiedText");
    }
    [down, up]
}

/// Type text into the focused element.
pub fn type_text(text: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let calls: Vec<(&'static str, Value)> = if is_short_plain_text(text) {
        text.chars()
            .flat_map(char_key_events)
            .map(|ev| ("Input.dispatchKeyEvent", ev))
            .collect()
    } else {
        vec![("Input.insertText", json!({"text": text}))]
    };
    match cdp_calls(&tab, calls) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Named keys we can dispatch as real key events: (virtual key code, key, code).
pub(super) fn key_spec(name: &str) -> Option<(i64, &'static str, &'static str)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => (13, "Enter", "Enter"),
        "tab" => (9, "Tab", "Tab"),
        "escape" | "esc" => (27, "Escape", "Escape"),
        "backspace" => (8, "Backspace", "Backspace"),
        "delete" => (46, "Delete", "Delete"),
        "up" | "arrowup" => (38, "ArrowUp", "ArrowUp"),
        "down" | "arrowdown" => (40, "ArrowDown", "ArrowDown"),
        "left" | "arrowleft" => (37, "ArrowLeft", "ArrowLeft"),
        "right" | "arrowright" => (39, "ArrowRight", "ArrowRight"),
        "home" => (36, "Home", "Home"),
        "end" => (35, "End", "End"),
        "pageup" => (33, "PageUp", "PageUp"),
        "pagedown" => (34, "PageDown", "PageDown"),
        "space" => (32, " ", "Space"),
        _ => return None,
    })
}

/// Press one key (a named key, or a single character typed literally).
pub fn press_key(key: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some((code, name, dom_code)) = key_spec(key) else {
        // Not a named key: type it as text (matches the Python fallback).
        return type_text(key, &chat);
    };
    let base = json!({
        "windowsVirtualKeyCode": code,
        "nativeVirtualKeyCode": code,
        "key": name,
        "code": dom_code,
    });
    let mut down = base.clone();
    down["type"] = json!("keyDown");
    let mut up = base;
    up["type"] = json!("keyUp");
    match cdp_calls(
        &tab,
        vec![
            ("Input.dispatchKeyEvent", down),
            ("Input.dispatchKeyEvent", up),
        ],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Scroll the page by a wheel delta.
pub fn scroll(dx: i64, dy: i64, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let (w, h) = tab.viewport;
    match cdp_calls(
        &tab,
        vec![(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel",
                "x": w / 2,
                "y": h / 2,
                "deltaX": dx,
                "deltaY": dy,
            }),
        )],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Resize the emulated viewport. The size is REMEMBERED on the tab so the
/// panel's ruler and fit-to-pane resizes survive the next status poll.
pub fn set_viewport(width: u32, height: u32, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    // Guard against a zero/absurd size from a mid-typing input.
    let w = width.clamp(200, 4096);
    let h = height.clamp(200, 4096);
    match cdp_calls_on(
        &tab,
        vec![("Emulation.setDeviceMetricsOverride", viewport_override(w, h))],
        false,
    ) {
        Ok(_) => {
            store_viewport(&chat, (w, h));
            json!({"ok": true, "width": w, "height": h})
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Back / forward / reload through the page's own history.
pub fn history(action: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let expr = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return json!({"ok": false, "error": format!("unknown history action: {other}")}),
    };
    let tab_for_call = tab.clone();
    let expr_owned = expr;
    match cdp_calls(
        &tab_for_call,
        vec![(
            "Runtime.evaluate",
            json!({"expression": expr_owned, "returnByValue": true}),
        )],
    ) {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// Omnibox search: try Google, then Bing, then DuckDuckGo — the first engine
/// that actually loads wins, and its results URL is returned for the address bar.
pub fn search(query: &str, chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let q = percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let engines = [
        ("google.com", format!("https://www.google.com/search?q={q}")),
        ("bing.com", format!("https://www.bing.com/search?q={q}")),
        ("duckduckgo.com", format!("https://duckduckgo.com/?q={q}")),
    ];
    let mut last = String::new();
    for (host, url) in engines {
        if let Err(e) = navigate(&tab, &url) {
            last = e;
            continue;
        }
        // Give the engine a moment to commit the navigation before reading back.
        std::thread::sleep(Duration::from_millis(600));
        let href = current_url(&tab);
        if href.contains(host) {
            return json!({"ok": true, "url": href});
        }
        last = format!("{host} did not load");
    }
    json!({"ok": false, "error": format!("search failed: {last}")})
}

/// DevTools frontend URL opened in the user's browser. DevTools drives a TAB, so
/// the frontend points at the tab's own websocket target (`/json/list` is
/// browser-wide and each page target still carries its own debugger url), never
/// at the browser-level endpoint — the latter is not inspectable.
pub fn devtools_url(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let Some(port) = alive_port() else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let ws = match http_get_json(port, "/json/list")
        .ok()
        .and_then(|list| {
            list.as_array()?.iter().find_map(|t| {
                (t["id"].as_str() == Some(tab.target_id.as_str()))
                    .then(|| t["webSocketDebuggerUrl"].as_str().map(str::to_string))
                    .flatten()
            })
        }) {
        Some(ws) => ws,
        None => return json!({"ok": false, "error": "no tab websocket endpoint"}),
    };
    let ws_arg = ws
        .strip_prefix("ws://")
        .unwrap_or(&ws)
        .to_string();
    json!({
        "ok": true,
        "url": format!("http://127.0.0.1:{port}/devtools/inspector.html?ws={ws_arg}"),
    })
}

/// Close one chat's tab (the shared browser keeps running for the other chats).
pub fn close(chat_id: &str) -> Value {
    let chat = normalize_chat(chat_id);
    let removed = close_tab(&chat);
    json!({"ok": true, "closed": removed})
}

// ---------------------------------------------------------------------------
// Driver façade
// ---------------------------------------------------------------------------

/// Everything the native CDP driver (`browser_driver.rs`) needs from this
/// module, so the process/tab registry stays private to the file that owns it.
///
/// The driver is a SEPARATE module rather than more code in this one because it
/// needs something this file used to lack: the driver thread OWNS the one
/// long-lived WebSocket and runs strictly request→reply, so it cannot also
/// serve the agent's concurrently reading driver. Everything here is
/// request/reply on that separate, per-driver socket.
pub(crate) mod driver_hooks {
    /// The identity the panel's session presents (Chrome User-Agent + client
    /// hints, plus the consistency script), built from the running browser's own
    /// version. The agent's driver is a SEPARATE CDP session on the same tab, so
    /// it has to send the same override or the two sessions disagree about who
    /// the browser is.
    pub(crate) fn identity() -> Option<(serde_json::Value, String)> {
        let port = super::alive_port()?;
        let info = super::http_get_json(port, "/json/version").ok()?;
        let version = serde_json::json!({
            "userAgent": info["User-Agent"],
            "product": info["Browser"],
        });
        super::ua_override(&version).map(|ua| (ua, super::consistency_js()))
    }

    /// Normalized chat key.
    pub(crate) fn chat_key(chat: &str) -> String {
        super::normalize_chat(chat)
    }

    /// Port of the live shared browser (refreshes its idle timer).
    pub(crate) fn port() -> Option<u16> {
        super::alive_port()
    }

    /// WebSocket URL of the browser-level endpoint.
    pub(crate) fn ws_url(port: u16) -> Result<String, String> {
        super::browser_ws_url(port)
    }

    /// Target id of the chat's tab, starting the browser AND the tab when
    /// needed. This is the same tab the right-side panel polls, so the agent
    /// and the user always look at one page.
    pub(crate) fn ensure_target(chat: &str) -> Result<String, String> {
        super::ensure_tab(chat).map(|t| t.target_id)
    }

    /// Point the chat's registered tab at `target` (the panel and the driver
    /// must never disagree about which page the chat is on).
    pub(crate) fn set_target(chat: &str, target: &str) {
        if let Ok(mut tabs) = super::TABS.lock() {
            if let Some((_, tab)) = tabs.iter_mut().find(|(k, _)| k == chat) {
                tab.target_id = target.to_string();
            }
        }
    }
}
