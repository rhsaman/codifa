use super::*;

pub(super) fn ref_of(args: &Value) -> Option<usize> {
    if let Some(n) = args["ref"].as_u64() {
        return Some(n as usize);
    }
    let raw = args["ref"].as_str()?.trim();
    let digits = raw
        .trim_start_matches("@")
        .trim_start_matches("e")
        .trim_start_matches('-');
    digits.parse::<usize>().ok()
}

/// Map a printed ref to its index inside the snapshot that handed it out.
///
/// Refs are monotonic across snapshots (`next_ref` is never reset), so a ref is
/// NOT an array index — the snapshot's `base_ref` must be subtracted. Returns
/// `None` when `wanted` was handed out by a different snapshot (older or newer).
pub(super) fn ref_index(base_ref: usize, len: usize, wanted: usize) -> Option<usize> {
    if wanted < base_ref {
        return None; // handed out by an OLDER snapshot
    }
    let index = wanted - base_ref;
    if index >= len {
        return None; // handed out by a NEWER snapshot
    }
    Some(index)
}

/// Resolve a ref against the newest snapshot that contains it.
///
/// Treating the ref as a direct index made every ref resolve to the NEXT entry
/// (ref [1] — the button — hit entries[1], the input), so clicks landed on the
/// wrong element.
pub(super) fn entry_for(d: &Driver, wanted: usize) -> Option<SnapEntry> {
    for (_version, snap) in d.snapshots.iter().rev() {
        if let Some(index) = ref_index(snap.base_ref, snap.entries.len(), wanted) {
            return snap.entries.get(index).cloned();
        }
    }
    None
}

/// The CSS/text selector path, for callers that have no ref.
pub(super) fn selector_expr(args: &Value) -> Option<String> {
    let sel = args["selector"].as_str().map(str::trim).filter(|s| !s.is_empty());
    if let Some(sel) = sel {
        return Some(format!(
            "document.querySelector({})",
            serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    let text = args["text"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
    // Text without a ref: ask the injected matcher, which knows the same
    // role/name rules the snapshot used.
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    Some(format!(
        "(function(){{var m=__cfMatch('',{0},0);if(m) return m;var c=__cfCandidates();\
         for(var i=0;i<c.length;i++){{if(c[i].name.indexOf({0})>=0) return c[i].el;}}return null;}})()",
        literal
    ))
}

/// Resolve whatever the call used (ref / selector / text) into an objectId.
pub(super) fn resolve_node(d: &mut Driver, args: &Value) -> Result<String, String> {
    if let Some(wanted) = ref_of(args) {
        let entry = entry_for(d, wanted).ok_or_else(|| {
            format!("ref [{wanted}] is unknown — run browser_snapshot again to get fresh refs")
        })?;
        let expr = format!(
            "__cfMatch({}, {}, {})",
            serde_json::to_string(&entry.role).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&entry.name).unwrap_or_else(|_| "\"\"".into()),
            entry.nth
        );
        return node_on(&mut &d.conn, &js(&expr));
    }
    let expr = selector_expr(args).ok_or_else(|| {
        "pass `ref` (from browser_snapshot), or `selector`, or `text`".to_string()
    })?;
    node_on(&mut &d.conn, &js(&expr))
}

/// Scroll an element into view and return its centre point.
pub(super) fn element_point(d: &mut Driver, object_id: &str) -> Result<(i64, i64), String> {
    let conn = &d.conn;
    let _ = conn.call(
        "DOM.scrollIntoViewIfNeeded",
        json!({"objectId": object_id}),
    );
    let res = conn.call(
        "Runtime.callFunctionOn",
        json!({
            "objectId": object_id,
            "functionDeclaration": "function(){var r=this.getBoundingClientRect();\
                return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});}",
            "returnByValue": true,
        }),
    )?;
    let raw = res["result"]["value"].as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let x = parsed["x"].as_i64().unwrap_or(-1);
    let y = parsed["y"].as_i64().unwrap_or(-1);
    if x < 0 || y < 0 {
        return Err("the element has no clickable box (it may be hidden)".to_string());
    }
    Ok((x, y))
}

pub(super) fn modifier_bits(args: &Value) -> i64 {
    let mut bits = 0;
    if let Some(list) = args["modifiers"].as_array() {
        for m in list {
            match m.as_str().unwrap_or_default().to_ascii_lowercase().as_str() {
                "alt" | "option" => bits |= 1,
                "ctrl" | "control" => bits |= 2,
                "meta" | "cmd" | "command" | "super" => bits |= 4,
                "shift" => bits |= 8,
                _ => {}
            }
        }
    }
    bits
}

pub(super) fn mouse(d: &mut Driver, kind: &str, x: i64, y: i64, extra: Value) -> Result<(), String> {
    let mut params = json!({"type": kind, "x": x, "y": y});
    if let (Some(dst), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            dst.insert(k.clone(), v.clone());
        }
    }
    let conn = &d.conn;
    conn.call("Input.dispatchMouseEvent", params)?;
    Ok(())
}

/// Wait until the page's load event fires after `before`, or until it reports
/// `complete` twice in a row (a same-document navigation never fires `load`).
pub(super) fn wait_load(d: &mut Driver, before: u64, ttl: Duration) -> Result<(), String> {
    let deadline = Instant::now() + ttl;
    // Give the navigation a beat to start before trusting `readyState`, which
    // still describes the page being left.
    std::thread::sleep(Duration::from_millis(120));
    let mut complete = 0;
    loop {
        if d.conn.load_count.load(Ordering::Relaxed) > before {
            return Ok(());
        }
        if let Ok(v) = d.eval("document.readyState", false) {
            if v.as_str() == Some("complete") {
                complete += 1;
                if complete >= 2 {
                    return Ok(());
                }
            } else {
                complete = 0;
            }
        }
        if Instant::now() >= deadline {
            // A slow page is not a failed navigation: report the URL we got to.
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn op_snapshot(d: &mut Driver, budget: usize, full: bool) -> Result<Value, String> {
    let raw = {
        let conn = &d.conn;
        let res = conn.call(
            "Runtime.evaluate",
            json!({
                "expression": js_snapshot(),
                "returnByValue": true,
                "awaitPromise": false,
                "userGesture": true,
            }),
        )?;
        if res["exceptionDetails"].is_object() {
            return Err(format!(
                "snapshot failed: {}",
                res["exceptionDetails"]["text"]
                    .as_str()
                    .unwrap_or("page error")
            ));
        }
        res["result"]["value"].clone()
    };
    if !raw.is_object() {
        return Err("snapshot returned no data (the page may be loading)".to_string());
    }
    let sig = signature(&raw);
    if let Some(version) = d.current {
        if let Some((_, snap)) = d.snapshots.iter().find(|(v, _)| *v == version) {
            if snap.sig == sig {
                // Unchanged page: the note says the refs still stand, and the
                // same render (at the caller's budget) goes back — the model
                // asked to see the page, and the page it has is this one.
                let text = format!(
                    "[unchanged since refs v{version} — the refs below are still valid]\n{}",
                    render_snapshot(snap, budget, full)
                );
                return Ok(json!({
                    "text": text,
                    "version": version,
                    "unchanged": true,
                }));
            }
        }
    }

    let url = raw["url"].as_str().unwrap_or_default().to_string();
    let title = raw["title"].as_str().unwrap_or_default().to_string();

    let mut entries: Vec<SnapEntry> = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    // The ref printed for `entries[0]`: refs are monotonic across snapshots, so
    // the offset between the printed number and the array index has to be kept.
    let base_ref = d.next_ref;
    for e in raw["entries"].as_array().cloned().unwrap_or_default() {
        let role = e["role"].as_str().unwrap_or("element").to_string();
        let name = e["name"].as_str().unwrap_or_default().to_string();
        let region = e["region"].as_str().unwrap_or("other").to_string();
        let nth = {
            let slot = seen.entry((role.clone(), name.clone())).or_insert(0);
            let n = *slot;
            *slot += 1;
            n
        };
        entries.push(SnapEntry {
            role,
            name,
            region,
            nth,
        });
        d.next_ref += 1;
    }
    // Display order: main/dialog first, other next, page furniture last —
    // a stable sort, so DOM order survives inside each band.
    let mut display_order: Vec<usize> = (0..entries.len()).collect();
    display_order.sort_by_key(|&i| region_rank(&entries[i].region));

    let headings: Vec<(String, String)> = raw["headings"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|h| {
            (
                h["role"].as_str().unwrap_or("h").to_string(),
                h["name"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();

    d.seq += 1;
    let version = d.seq;
    let snap = Snapshot {
        url,
        title,
        display_order,
        entries,
        headings,
        main_text: raw["main_text"].as_str().unwrap_or_default().to_string(),
        body_text: raw["text"].as_str().unwrap_or_default().to_string(),
        base_ref,
        sig,
    };
    d.snapshots.push((version, snap));
    if d.snapshots.len() > MAX_SNAPSHOTS {
        d.snapshots.remove(0);
    }
    d.current = Some(version);

    let stored = &d.snapshots.last().expect("just pushed").1;
    let text = format!("refs v{version}\n\n{}", render_snapshot(stored, budget, full));

    Ok(json!({
        "text": text,
        "version": version,
        "unchanged": false,
    }))
}

pub(super) fn op_navigate(d: &mut Driver, url: &str) -> Result<Value, String> {
    let target = url.trim();
    if target.is_empty() {
        return Err("navigate needs a url".to_string());
    }
    let before = d.conn.load_count.load(Ordering::Relaxed);
    let res = {
        let conn = &d.conn;
        conn.call("Page.navigate", json!({"url": target}))?
    };
    if let Some(err) = res["errorText"].as_str() {
        if !err.is_empty() && err != "net::ERR_ABORTED" {
            return Err(format!("navigation failed: {err}"));
        }
    }
    wait_load(d, before, NAV_TIMEOUT)?;
    // The snapshot rides IN the navigate result: "open X and look at it" costs
    // ONE tool call instead of navigate + browser_snapshot, and every ref the
    // summary prints is already registered (the call above stored the
    // snapshot), so a click on it resolves without re-snapshotting.
    let snap = op_snapshot(d, SNAPSHOT_NAV_CHARS, false)?;
    Ok(json!({
        "text": format!("Navigated to {}\n\n{}", d.url(), snap["text"].as_str().unwrap_or_default()),
        "url": d.url(),
        "title": d.title(),
        "version": snap["version"].clone(),
    }))
}

pub(super) fn op_navigate_back(d: &mut Driver) -> Result<Value, String> {
    let before = d.conn.load_count.load(Ordering::Relaxed);
    {
        let conn = &d.conn;
        conn.call(
            "Runtime.evaluate",
            json!({"expression": "history.back()", "returnByValue": true}),
        )?;
    }
    wait_load(d, before, Duration::from_secs(15))?;
    // Same one-call contract as navigate: the page comes back WITH its summary.
    let snap = op_snapshot(d, SNAPSHOT_NAV_CHARS, false)?;
    Ok(json!({
        "text": format!("Went back to {}\n\n{}", d.url(), snap["text"].as_str().unwrap_or_default()),
        "url": d.url(),
        "version": snap["version"].clone(),
    }))
}

pub(super) fn op_click(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let node = resolve_node(d, args)?;
    let (x, y) = element_point(d, &node)?;
    let modifiers = modifier_bits(args);
    let button = args["button"].as_str().unwrap_or("left");
    let clicks = args["click_count"].as_i64().unwrap_or(1).clamp(1, 3);
    let before = d.conn.load_count.load(Ordering::Relaxed);
    // Make the tab the ACTIVE one before pressing. A background target does not
    // receive input events: the dispatch is answered ("ok") but the renderer
    // never sees a click, so a handler never fires. The panel's Chromium is
    // shared, so "the tab the agent is driving" is not necessarily the front
    // one.
    {
        let conn = &d.conn;
        let _ = conn.call("Page.bringToFront", json!({}));
    }
    mouse(
        d,
        "mouseMoved",
        x,
        y,
        json!({"button": "none", "buttons": 0, "modifiers": modifiers}),
    )?;
    mouse(
        d,
        "mousePressed",
        x,
        y,
        json!({"button": button, "clickCount": clicks, "buttons": 1, "modifiers": modifiers}),
    )?;
    mouse(
        d,
        "mouseReleased",
        x,
        y,
        json!({"button": button, "clickCount": clicks, "buttons": 0, "modifiers": modifiers}),
    )?;
    // A click may start a navigation: give it a short chance to settle so the
    // next command sees the new document.
    wait_load(d, before, Duration::from_secs(5))?;
    Ok(json!({
        "text": format!("Clicked at ({x}, {y}) — now on {}", d.url()),
        "url": d.url(),
    }))
}

pub(super) fn op_hover(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let node = resolve_node(d, args)?;
    let (x, y) = element_point(d, &node)?;
    mouse(
        d,
        "mouseMoved",
        x,
        y,
        json!({"button": "none", "buttons": 0}),
    )?;
    Ok(json!({"text": format!("Hovering at ({x}, {y})")}))
}

/// Focus a node so typing lands in it.
pub(super) fn focus_node(d: &mut Driver, object_id: &str) -> Result<(), String> {
    let conn = &d.conn;
    if conn
        .call("DOM.focus", json!({"objectId": object_id}))
        .is_ok()
    {
        return Ok(());
    }
    // Not focusable through DOM.focus (a div with a click handler, say):
    // click it instead, which is what a person would do.
    let (x, y) = element_point(d, object_id)?;
    mouse(
        d,
        "mousePressed",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    )?;
    mouse(
        d,
        "mouseReleased",
        x,
        y,
        json!({"button": "left", "clickCount": 1, "buttons": 0}),
    )
}

/// Replace the focused element's content and type `text` into it.
pub(super) fn type_into(d: &mut Driver, node: Option<&str>, text: &str, clear: bool) -> Result<(), String> {
    if let Some(node) = node {
        focus_node(d, node)?;
    }
    if clear {
        // Select the field's current content so `insertText` replaces it — the
        // React-friendly equivalent of Cmd+A, Backspace.
        let conn = &d.conn;
        let _ = conn.call(
            "Runtime.evaluate",
            json!({
                "expression": "(function(){var el=document.activeElement;\
                    if(el&&el.select){el.select();}\
                    else if(el&&el.setSelectionRange){el.setSelectionRange(0,(el.value||'').length);}\
                    return true;})()",
                "returnByValue": true,
            }),
        );
    }
    let conn = &d.conn;
    if crate::browser::is_short_plain_text(text) {
        // Real keydown/keyup per character: a bare insertText fires neither,
        // which login forms and bot checks treat as an automated client.
        for ch in text.chars() {
            for ev in crate::browser::char_key_events(ch) {
                conn.call("Input.dispatchKeyEvent", ev)?;
            }
        }
    } else {
        conn.call("Input.insertText", json!({"text": text}))?;
    }
    Ok(())
}

pub(super) fn op_type(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let text = args["text"].as_str().unwrap_or_default();
    if text.is_empty() {
        return Err("type needs `text`".to_string());
    }
    let node = if ref_of(args).is_some() || args["selector"].as_str().is_some() {
        Some(resolve_node(d, args)?)
    } else {
        None
    };
    let clear = args["clear"].as_bool().unwrap_or(false);
    type_into(d, node.as_deref(), text, clear)?;
    if args["submit"].as_bool().unwrap_or(false) {
        press_key(d, "Enter", 0)?;
    }
    Ok(json!({
        "text": format!(
            "Typed {} character(s){}",
            text.chars().count(),
            if args["submit"].as_bool().unwrap_or(false) { " and pressed Enter" } else { "" }
        )
    }))
}

pub(super) fn op_fill_form(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let fields = args["fields"]
        .as_array()
        .cloned()
        .ok_or_else(|| "fill_form needs `fields` (an array)".to_string())?;
    if fields.is_empty() {
        return Err("fill_form needs at least one field".to_string());
    }
    let mut done = Vec::new();
    for field in fields {
        let value = field["value"]
            .as_str()
            .or_else(|| field["text"].as_str())
            .unwrap_or_default()
            .to_string();
        let node = resolve_node(d, &field)?;
        type_into(d, Some(&node), &value, true)?;
        done.push(
            field["ref"]
                .as_u64()
                .map(|r| format!("[{r}]"))
                .unwrap_or_else(|| field["selector"].as_str().unwrap_or("field").to_string()),
        );
    }
    Ok(json!({
        "text": format!("Filled {} field(s): {}", done.len(), done.join(", "))
    }))
}

pub(super) fn op_select_option(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let value = args["value"].as_str().unwrap_or_default().to_string();
    if value.is_empty() {
        return Err("select_option needs `value`".to_string());
    }
    let node = resolve_node(d, args)?;
    let conn = &d.conn;
    let res = conn.call(
        "Runtime.callFunctionOn",
        json!({
            "objectId": node,
            "functionDeclaration": "function(want){\
                this.value=want;\
                this.dispatchEvent(new Event('input',{bubbles:true}));\
                this.dispatchEvent(new Event('change',{bubbles:true}));\
                return this.value;}",
            "arguments": [{"value": value}],
            "returnByValue": true,
        }),
    )?;
    Ok(json!({
        "text": format!(
            "Selected \"{}\" (the field now reads \"{}\")",
            value,
            res["result"]["value"].as_str().unwrap_or_default()
        )
    }))
}

/// (virtual key code, key, code) for a named key or a single character.
pub(super) fn key_triple(spec: &str) -> Option<(i64, String, String)> {
    let named = match spec.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some((13, "Enter", "Enter")),
        "tab" => Some((9, "Tab", "Tab")),
        "escape" | "esc" => Some((27, "Escape", "Escape")),
        "backspace" => Some((8, "Backspace", "Backspace")),
        "delete" | "del" => Some((46, "Delete", "Delete")),
        "arrowup" | "up" => Some((38, "ArrowUp", "ArrowUp")),
        "arrowdown" | "down" => Some((40, "ArrowDown", "ArrowDown")),
        "arrowleft" | "left" => Some((37, "ArrowLeft", "ArrowLeft")),
        "arrowright" | "right" => Some((39, "ArrowRight", "ArrowRight")),
        "home" => Some((36, "Home", "Home")),
        "end" => Some((35, "End", "End")),
        "pageup" => Some((33, "PageUp", "PageUp")),
        "pagedown" => Some((34, "PageDown", "PageDown")),
        "space" => Some((32, " ", "Space")),
        _ => None,
    };
    if let Some((code, key, dom)) = named {
        return Some((code, key.to_string(), dom.to_string()));
    }
    let mut chars = spec.chars();
    let ch = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let code = match ch {
        'a'..='z' => ch as i64 - 32,
        'A'..='Z' => ch as i64,
        '0'..='9' => ch as i64,
        ' ' => 32,
        '-' => 189,
        '=' => 187,
        '[' => 219,
        ']' => 221,
        '\\' => 220,
        ';' => 186,
        '\'' => 222,
        ',' => 188,
        '.' => 190,
        '/' => 191,
        '`' => 192,
        _ => return None,
    };
    let dom = match ch {
        'a'..='z' | 'A'..='Z' => format!("Key{}", ch.to_ascii_uppercase()),
        '0'..='9' => format!("Digit{ch}"),
        _ => format!("{ch}"),
    };
    Some((code, ch.to_string(), dom))
}

pub(super) fn press_key(d: &mut Driver, spec: &str, modifiers: i64) -> Result<(), String> {
    // Accept the `Meta+A` combo spelling in addition to a bare key plus
    // the `modifiers` array.
    let (spec, modifiers) = match spec.rsplit_once('+') {
        Some((prefix, rest)) if !rest.is_empty() => {
            let mut bits = modifiers;
            for part in prefix.split('+') {
                bits |= match part.trim().to_ascii_lowercase().as_str() {
                    "alt" | "option" => 1,
                    "ctrl" | "control" => 2,
                    "meta" | "cmd" | "command" | "super" => 4,
                    "shift" => 8,
                    _ => 0,
                };
            }
            (rest, bits)
        }
        _ => (spec, modifiers),
    };
    let (code, key, dom) =
        key_triple(spec).ok_or_else(|| format!("unknown key: {spec:?}"))?;
    if modifiers == 0 && key.chars().count() == 1 && key != " " {
        // A lone character is just text: inserting it fires the same `input`
        // events as a keypress and cannot be swallowed by a keymap.
        let conn = &d.conn;
        conn.call("Input.insertText", json!({"text": key}))?;
        return Ok(());
    }
    let base = json!({
        "windowsVirtualKeyCode": code,
        "nativeVirtualKeyCode": code,
        "key": key,
        "code": dom,
        "modifiers": modifiers,
    });
    let down_type = if modifiers != 0 { "rawKeyDown" } else { "keyDown" };
    let mut down = base.clone();
    down["type"] = json!(down_type);
    if modifiers == 0 {
        down["text"] = json!(key);
    }
    let mut up = base;
    up["type"] = json!("keyUp");
    let conn = &d.conn;
    conn.call("Input.dispatchKeyEvent", down)?;
    conn.call("Input.dispatchKeyEvent", up)?;
    Ok(())
}

pub(super) fn op_press_key(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let spec = args["key"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "press_key needs `key` (e.g. \"Enter\", \"Meta+A\")".to_string())?;
    press_key(d, spec, modifier_bits(args))?;
    Ok(json!({"text": format!("Pressed {spec}")}))
}

pub(super) fn op_evaluate(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let expr = args["expression"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "evaluate needs `expression`".to_string())?;
    let value = d.eval(expr, true).map_err(evaluate_error_hint)?;
    let rendered = match &value {
        Value::String(s) => s.clone(),
        Value::Null => "(null)".to_string(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let rendered = if rendered.chars().count() > 8_000 {
        let head: String = rendered.chars().take(8_000).collect();
        format!("{head}\n…[truncated]")
    } else {
        rendered
    };
    Ok(json!({"text": rendered}))
}

/// Turn a page-scope evaluation failure into a message that steers the NEXT step.
///
/// Traced (`mvyy1qf7`): nine consecutive `browser_evaluate` rounds died on
/// `React is not defined` / `h is not a function` / `window.__ui.renderDiffPreview
/// is not a function`, each a paid round-trip, because the raw CDP text named the
/// symptom but never the cheaper path. The note names it, and only for the
/// module-scope class of failure — a genuine page bug keeps its own error.
pub(super) fn evaluate_error_hint(err: String) -> String {
    const MODULE_SCOPE_SIGNALS: [&str; 5] = [
        "is not defined",
        "is not a function",
        "Cannot use import statement",
        "Unexpected token '<'",
        "jsx",
    ];
    let lower = err.to_lowercase();
    if !MODULE_SCOPE_SIGNALS
        .iter()
        .any(|sig| lower.contains(&sig.to_lowercase()))
    {
        return err;
    }
    format!(
        "{err}\n\n[note] `browser_evaluate` runs in PAGE scope, not the app's module scope: React, \
         JSX, imported components and dev-server globals are NOT reachable from it. Do not try to \
         build or import elements here — drive the real DOM instead (browser_snapshot → \
         browser_click/browser_type/browser_fill_form), or read plain JS values \
         (`getComputedStyle`, `querySelector(...).getBoundingClientRect()`, `innerText`)."
    )
}

pub(super) fn op_wait_for(d: &mut Driver, args: &Value) -> Result<Value, String> {
    if let Some(secs) = args["time"].as_f64() {
        let clamped = secs.clamp(0.0, 30.0);
        std::thread::sleep(Duration::from_secs_f64(clamped));
        return Ok(json!({"text": format!("Waited {clamped}s")}));
    }
    let text = args["text"].as_str().map(str::to_string);
    let gone = args["text_gone"].as_str().map(str::to_string);
    if text.is_none() && gone.is_none() {
        return Err("wait_for needs `text`, `text_gone` or `time`".to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(args["timeout"].as_u64().unwrap_or(10).min(60));
    loop {
        if let Some(needle) = &text {
            let expr = format!(
                "document.body?(document.body.innerText||'').indexOf({})>=0:false",
                serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
            );
            if let Ok(v) = d.eval(&expr, false) {
                if v.as_bool().unwrap_or(false) {
                    return Ok(json!({"text": format!("Text appeared: {needle}")}));
                }
            }
        }
        if let Some(needle) = &gone {
            let expr = format!(
                "document.body?(document.body.innerText||'').indexOf({})<0:true",
                serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
            );
            if let Ok(v) = d.eval(&expr, false) {
                if v.as_bool().unwrap_or(false) {
                    return Ok(json!({"text": format!("Text disappeared: {needle}")}));
                }
            }
        }
        if Instant::now() >= deadline {
            let what = text.or(gone).unwrap_or_default();
            return Err(format!("timed out waiting for {what:?}"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

pub(super) fn op_console_messages(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let wanted = args["level"]
        .as_str()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "info".to_string());
    if args["clear"].as_bool().unwrap_or(false) {
        if let Ok(mut l) = d.conn.logs.lock() {
            l.clear();
        }
        return Ok(json!({"text": "Console log cleared."}));
    }
    let entries = d.conn.logs.lock().map(|l| l.clone()).unwrap_or_default();
    let rank = |level: &str| match level {
        "error" => 3,
        "warn" | "warning" => 2,
        _ => 1,
    };
    let floor = if wanted.starts_with("err") {
        3
    } else if wanted.starts_with("warn") {
        2
    } else {
        1
    };
    let mut lines = Vec::new();
    for e in entries {
        let level = e["level"].as_str().unwrap_or("log");
        if rank(level) < floor {
            continue;
        }
        let kind = e["kind"].as_str().unwrap_or("console");
        lines.push(format!(
            "[{level}] ({kind}) {}",
            e["text"].as_str().unwrap_or_default()
        ));
    }
    if lines.is_empty() {
        return Ok(json!({"text": format!("No console messages at level {wanted} or above.")}));
    }
    Ok(json!({"text": lines.join("\n")}))
}

pub(super) fn op_network_requests(d: &mut Driver, args: &Value) -> Result<Value, String> {
    if args["clear"].as_bool().unwrap_or(false) {
        if let Ok(mut n) = d.conn.net.lock() {
            n.clear();
        }
        return Ok(json!({"text": "Network log cleared."}));
    }
    let filter = args["filter"].as_str().unwrap_or_default().to_string();
    let entries = d.conn.net.lock().map(|n| n.clone()).unwrap_or_default();
    if entries.is_empty() {
        return Ok(json!({"text": "No network requests captured yet."}));
    }
    let mut lines = Vec::new();
    for e in entries {
        let url = e["url"].as_str().unwrap_or_default();
        if !filter.is_empty() && !url.contains(&filter) {
            continue;
        }
        lines.push(format!(
            "{:>4} {:<6} {}",
            e["status"]
                .as_i64()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "—".to_string()),
            e["method"].as_str().unwrap_or("GET"),
            url
        ));
    }
    if lines.is_empty() {
        return Ok(json!({"text": format!("No requests matching {filter:?}.")}));
    }
    let shown: Vec<String> = lines.iter().rev().take(120).rev().cloned().collect();
    Ok(json!({
        "text": format!("{} request(s):\n{}", lines.len(), shown.join("\n"))
    }))
}

pub(super) fn op_find(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let needle = args["text"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "find needs `text`".to_string())?;
    let expr = format!(
        r#"(function(){{var n={};var t=document.body?(document.body.innerText||''):'';
        var low=t.toLowerCase(),needle=n.toLowerCase(),out=[],i=0,from=0;
        while(out.length<10){{i=low.indexOf(needle,from);if(i<0)break;from=i+needle.length;
        out.push(t.slice(Math.max(0,i-80),Math.min(t.length,i+needle.length+80)).replace(/\s+/g,' ').trim());}}
        return JSON.stringify({{count:out.length,hits:out}});}})()"#,
        serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into())
    );
    let raw = d.eval(&expr, false)?;
    let parsed: Value = serde_json::from_str(raw.as_str().unwrap_or("{}"))
        .unwrap_or_else(|_| json!({"count": 0, "hits": []}));
    if parsed["count"].as_i64().unwrap_or(0) == 0 {
        return Ok(json!({"text": format!("No match for {needle:?} on this page.")}));
    }
    let hits = parsed["hits"].as_array().cloned().unwrap_or_default();
    let mut text = format!("{} match(es) for {needle:?}:\n", hits.len());
    for h in hits {
        text.push_str(&format!("… {} …\n", h.as_str().unwrap_or_default()));
    }
    Ok(json!({"text": text}))
}

pub(super) fn op_scroll(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let dx = args["dx"].as_i64().unwrap_or(0);
    let dy = args["dy"].as_i64().unwrap_or(600);
    let (x, y) = if ref_of(args).is_some()
        || args["selector"].as_str().is_some()
        || args["text"].as_str().is_some()
    {
        let node = resolve_node(d, args)?;
        element_point(d, &node)?
    } else {
        // Scroll the middle of the viewport (same behaviour as the panel's wheel).
        match d.eval("JSON.stringify([window.innerWidth/2, window.innerHeight/2])", false) {
            Ok(v) => {
                let parsed: Value = serde_json::from_str(v.as_str().unwrap_or("[0,0]"))
                    .unwrap_or_else(|_| json!([0, 0]));
                (
                    parsed[0].as_f64().unwrap_or(0.0) as i64,
                    parsed[1].as_f64().unwrap_or(0.0) as i64,
                )
            }
            Err(_) => (400, 300),
        }
    };
    let conn = &d.conn;
    conn.call(
        "Input.dispatchMouseEvent",
        json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy}),
    )?;
    Ok(json!({"text": format!("Scrolled by ({dx}, {dy})")}))
}

pub(super) fn op_resize(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let width = args["width"].as_u64().unwrap_or(1280).clamp(200, 4096) as u32;
    let height = args["height"].as_u64().unwrap_or(800).clamp(200, 4096) as u32;
    {
        let conn = &d.conn;
        conn.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}),
        )?;
    }
    // Keep the panel's own viewport in sync, so the ruler and the frames agree.
    let chat = d.chat.clone();
    let _ = crate::browser::set_viewport(width, height, &chat);
    Ok(json!({"text": format!("Viewport is now {width}x{height}")}))
}

pub(super) fn op_emulate_media(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let mut features = Vec::new();
    if let Some(scheme) = args["colorScheme"].as_str() {
        features.push(json!({"name": "prefers-color-scheme", "value": scheme}));
    }
    if let Some(motion) = args["reducedMotion"].as_str() {
        features.push(json!({"name": "prefers-reduced-motion", "value": motion}));
    }
    if let Some(contrast) = args["forcedColors"].as_str() {
        features.push(json!({"name": "forced-colors", "value": contrast}));
    }
    if features.is_empty() {
        return Err(
            "emulate_media needs colorScheme, reducedMotion or forcedColors".to_string(),
        );
    }
    let media = args["media"].as_str().unwrap_or("screen");
    let conn = &d.conn;
    conn.call(
        "Emulation.setEmulatedMedia",
        json!({"media": media, "features": features}),
    )?;
    Ok(json!({"text": format!("Emulated media: {media} with {features:?}")}))
}

pub(super) fn op_handle_dialog(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let accept = args["accept"].as_bool().unwrap_or(false);
    let prompt = args["promptText"].as_str().unwrap_or_default().to_string();
    if let Ok(mut policy) = d.conn.dialog.lock() {
        *policy = (accept, prompt.clone());
    }
    // Try to answer a dialog that is ALREADY open (the policy above covers the
    // next one).
    let conn = &d.conn;
    let replied = conn
        .call(
            "Page.handleJavaScriptDialog",
            json!({"accept": accept, "promptText": prompt}),
        )
        .is_ok();
    Ok(json!({
        "text": if replied {
            format!("Answered the open dialog ({}). Future dialogs will be {}.",
                if accept { "accepted" } else { "dismissed" },
                if accept { "accepted" } else { "dismissed" })
        } else {
            format!("Policy set: future dialogs will be {}.",
                if accept { "accepted" } else { "dismissed" })
        }
    }))
}

pub(super) fn op_file_upload(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let paths: Vec<String> = args["paths"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if paths.is_empty() {
        return Err("file_upload needs `paths` (absolute file paths)".to_string());
    }
    for p in &paths {
        if !std::path::Path::new(p).is_file() {
            return Err(format!("no such file: {p}"));
        }
    }
    let node = resolve_node(d, args)?;
    {
        let conn = &d.conn;
        conn.call(
            "DOM.setFileInputFiles",
            json!({"files": paths, "objectId": node}),
        )?;
    }
    Ok(json!({
        "text": format!("Attached {} file(s) to the file input.", paths.len())
    }))
}

pub(super) fn op_drag(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let from = resolve_node(d, args)?;
    let (fx, fy) = element_point(d, &from)?;
    // The destination may be given as `to_ref` / `to_selector` / `to_text`.
    let mut to_args = json!({});
    for (dst, src) in [
        ("ref", "to_ref"),
        ("selector", "to_selector"),
        ("text", "to_text"),
    ] {
        if let Some(v) = args.get(src) {
            if !v.is_null() {
                to_args[dst] = v.clone();
            }
        }
    }
    let to = resolve_node(d, &to_args)?;
    let (tx, ty) = element_point(d, &to)?;
    mouse(
        d,
        "mouseMoved",
        fx,
        fy,
        json!({"button": "none", "buttons": 0}),
    )?;
    mouse(
        d,
        "mousePressed",
        fx,
        fy,
        json!({"button": "left", "clickCount": 1, "buttons": 1}),
    )?;
    let steps = 8;
    for i in 1..=steps {
        let x = fx + (tx - fx) * i / steps;
        let y = fy + (ty - fy) * i / steps;
        mouse(
            d,
            "mouseMoved",
            x,
            y,
            json!({"button": "left", "buttons": 1}),
        )?;
        std::thread::sleep(Duration::from_millis(30));
    }
    mouse(
        d,
        "mouseReleased",
        tx,
        ty,
        json!({"button": "left", "clickCount": 1, "buttons": 0}),
    )?;
    Ok(json!({"text": format!("Dragged ({fx}, {fy}) → ({tx}, {ty})")}))
}

pub(super) fn op_tabs(d: &mut Driver, args: &Value) -> Result<Value, String> {
    let action = args["action"].as_str().unwrap_or("list");
    match action {
        "list" => {}
        "new" => {
            let url = args["url"].as_str().unwrap_or("about:blank");
            let conn = &d.conn;
            let res = conn.call("Target.createTarget", json!({"url": url}))?;
            let id = res["targetId"]
                .as_str()
                .ok_or_else(|| "createTarget returned no id".to_string())?
                .to_string();
            d.conn.attach(&id)?;
            hooks::set_target(&d.chat, &id);
            d.target = id;
            d.conn.enable_domains();
            return Ok(json!({"text": format!("Opened a new tab on {url}")}));
        }
        "select" | "close" => {}
        other => return Err(format!("unknown tabs action: {other}")),
    }

    let list = {
        let conn = &d.conn;
        conn.call("Target.getTargets", json!({}))?
    };
    let pages: Vec<Value> = list["targetInfos"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|t| t["type"].as_str() == Some("page"))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    if action == "list" {
        let mut text = String::new();
        for (i, t) in pages.iter().enumerate() {
            let id = t["targetId"].as_str().unwrap_or_default();
            text.push_str(&format!(
                "{}{}. {} — {}\n",
                if id == d.target { "* " } else { "  " },
                i,
                t["title"].as_str().unwrap_or_default(),
                t["url"].as_str().unwrap_or_default()
            ));
        }
        return Ok(json!({
            "text": if text.is_empty() { "No tabs.".to_string() } else { format!("Tabs (* = current):\n{text}") }
        }));
    }

    let index = args["index"].as_u64().unwrap_or(0) as usize;
    let target = pages
        .get(index)
        .and_then(|t| t["targetId"].as_str())
        .ok_or_else(|| format!("no tab at index {index}"))?
        .to_string();
    if action == "select" {
        d.conn.attach(&target)?;
        hooks::set_target(&d.chat, &target);
        d.target = target;
        d.conn.enable_domains();
        return Ok(json!({
            "text": format!("Switched to tab {index} — {}", d.url())
        }));
    }
    {
        let conn = &d.conn;
        let _ = conn.call("Target.closeTarget", json!({"targetId": target}));
    }
    if target == d.target {
        // The current tab is gone: the driver will re-attach on the next call.
        return Ok(json!({
            "text": format!("Closed tab {index} (it was the current tab; the next call re-attaches).")
        }));
    }
    Ok(json!({"text": format!("Closed tab {index}")}))
}

pub(super) fn op_status(d: &mut Driver) -> Result<Value, String> {
    let url = d.url();
    let title = d.title();
    Ok(json!({
        "text": format!("Page: {title}\nURL: {url}"),
        "url": url,
        "title": title,
    }))
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run one driver operation and render its result as text for the model.
///
/// `op` is the suffix after `browser_` (`navigate`, `snapshot`, `click`, …), so
/// the tool names and the route names come from ONE list.
pub fn run(op: &str, args: &Value, chat_id: &str) -> Result<String, String> {
    // Check the action name FIRST: `with_driver` starts the whole browser when
    // the chat has no tab yet, so validating inside the dispatch below meant a
    // hallucinated tool name launched a Chromium and only then failed —
    // leaving a browser running for a call that could never have worked.
    if !is_known(op) {
        return Err(format!("unknown browser action: {op}"));
    }
    let chat = chat_key(chat_id);
    // A mutating action may start a navigation; the post-action snapshot below
    // must describe the page AFTER it settles. Captured before the dispatch.
    let before_load = with_driver(&chat, |d| {
        Ok(d.conn.load_count.load(Ordering::Relaxed))
    })
    .unwrap_or(0);
    let value = with_driver(&chat, |d| match op {
        "status" => op_status(d),
        "navigate" => op_navigate(d, args["url"].as_str().unwrap_or_default()),
        "navigate_back" => op_navigate_back(d),
        "snapshot" => op_snapshot(
            d,
            if args["full"].as_bool().unwrap_or(false) {
                SNAPSHOT_MAX_CHARS
            } else {
                SNAPSHOT_SUMMARY_CHARS
            },
            args["full"].as_bool().unwrap_or(false),
        ),
        "click" => op_click(d, args),
        "hover" => op_hover(d, args),
        "type" => op_type(d, args),
        "fill_form" => op_fill_form(d, args),
        "select_option" => op_select_option(d, args),
        "press_key" => op_press_key(d, args),
        "evaluate" => op_evaluate(d, args),
        "wait_for" => op_wait_for(d, args),
        "console_messages" => op_console_messages(d, args),
        "network_requests" => op_network_requests(d, args),
        "find" => op_find(d, args),
        "scroll" => op_scroll(d, args),
        "resize" => op_resize(d, args),
        "emulate_media" => op_emulate_media(d, args),
        "handle_dialog" => op_handle_dialog(d, args),
        "file_upload" => op_file_upload(d, args),
        "drag" => op_drag(d, args),
        "tabs" => op_tabs(d, args),
        other => Err(format!("unknown browser action: {other}")),
    })?;
    // A mutating action RETURNS THE PAGE AFTER THE ACTION: the traced pattern
    // `click → wait_for → snapshot` cost THREE model rounds per interaction
    // (five times in one traced turn — 29 model calls, 954K input tokens),
    // because a bare "clicked" left the model blind and a snapshot round had
    // to follow. The summary rides in the same result, refs already
    // registered, so the next action can target the new page directly.
    if POST_ACTION_SNAPSHOT_OPS.contains(&op) {
        let _ = with_driver(&chat, |d| wait_load(d, before_load, Duration::from_secs(3)));
        if let Ok(snap) = with_driver(&chat, |d| op_snapshot(d, SNAPSHOT_SUMMARY_CHARS, false)) {
            let action_text = value["text"].as_str().unwrap_or_default().to_string();
            let summary = snap["text"].as_str().unwrap_or_default();
            return Ok(format!(
                "{action_text}\n\n--- Page after {op} (fresh refs) ---\n{summary}"
            ));
        }
    }
    let text = value["text"].as_str().unwrap_or_default().to_string();
    Ok(if text.is_empty() {
        serde_json::to_string_pretty(&value).unwrap_or_default()
    } else {
        text
    })
}

