use super::*;

/// The operations above, as (TOOL name, description) pairs — the ONE place both
/// the agent's tool schemas and the HTTP routes read, so the two can never drift
/// apart. Names are the full `browser_*` tool names the model calls.
pub const ACTIONS: &[(&str, &str)] = &[
    ("browser_status", "Current page URL and title."),
    (
        "browser_navigate",
        "Open a URL in the agent's tab, wait for it to load, and return the page's summary (main text + key interactive elements with refs) — no separate snapshot call needed.",
    ),
    (
        "browser_navigate_back",
        "Go back in the page's history and return the page's summary with fresh refs.",
    ),
    (
        "browser_snapshot",
        "Page as a summary: main text, headings and `[ref] role \"name\"` entries (main/dialog first, nav/footer last). Run this before any element action. full=true adds the whole body text and every entry (12K chars).",
    ),
    (
        "browser_click",
        "Click an element by `ref` from a snapshot. The result carries the page AFTER the click (fresh refs) — no separate snapshot call needed.",
    ),
    ("browser_hover", "Hover an element by `ref`."),
    (
        "browser_type",
        "Type text into a field (focus it by `ref`, or the focused element). The result carries the page afterwards with fresh refs.",
    ),
    ("browser_fill_form", "Fill several fields in one call: `fields: [{ref, value}]`."),
    ("browser_select_option", "Pick an option in a `<select>` by `ref` and `value`. The result carries the page afterwards with fresh refs."),
    ("browser_press_key", "Press a key or combo, e.g. `Enter`, `Tab`, `Meta+A`. The result carries the page afterwards with fresh refs."),
    (
        "browser_evaluate",
        // Page scope, NOT a module scope: a `React is not defined` / `h is not a
        // function` evaluation is a failed round, and a traced turn spent NINE of
        // them hand-building React elements before giving up. The driver cannot
        // import the page's bundler, so say so here — the cheap path is driving
        // the real DOM (browser_click/browser_type) and reading plain JS values.
        "Run plain JavaScript in the page and return its value. It runs in page scope: React, JSX and the app's own imports are NOT available, so never hand-build elements here — drive the real DOM with browser_click/browser_type/browser_fill_form and use this only to read values or check computed style.",
    ),
    ("browser_wait_for", "Wait for text to appear/disappear, or a number of seconds."),
    ("browser_console_messages", "Console logs and uncaught exceptions."),
    ("browser_network_requests", "Requests the page made, with status codes."),
    ("browser_find", "Search the page text and return the matching snippets."),
    ("browser_scroll", "Scroll the page (or a `ref`) by a pixel delta."),
    ("browser_resize", "Set the emulated viewport size."),
    ("browser_emulate_media", "Emulate dark mode / reduced motion / forced colors."),
    ("browser_handle_dialog", "Accept or dismiss the page's next alert/confirm/prompt."),
    ("browser_file_upload", "Attach local files to a file input by `ref`. The result carries the page afterwards with fresh refs."),
    ("browser_drag", "Drag from `ref` to `to_ref`. The result carries the page afterwards with fresh refs."),
    ("browser_tabs", "List, open, switch or close tabs."),
];

/// The action half of a tool name (`browser_navigate` → `navigate`).
pub fn action_of(tool: &str) -> Option<&'static str> {
    ACTIONS
        .iter()
        .find(|(n, _)| *n == tool)
        .map(|(n, _)| n.trim_start_matches("browser_"))
}

/// True when `name` is one of the driver's tools.
pub fn handles(name: &str) -> bool {
    ACTIONS.iter().any(|(n, _)| *n == name)
}

/// True when `op` is one of the driver's ACTIONS (the suffix after `browser_`).
///
/// Pure on purpose: `run` checks this BEFORE connecting, so a hallucinated tool
/// name is rejected without starting a Chromium the call could never use.
pub(super) fn is_known(op: &str) -> bool {
    ACTIONS
        .iter()
        .any(|(n, _)| n.trim_start_matches("browser_") == op)
}

/// Per-action parameters. Actions missing here take no arguments.
pub(super) fn action_props(action: &str) -> Value {
    match action {
        "navigate" => json!({"url": {"type": "string"}}),
        "snapshot" => json!({
            "full": {"type": "boolean", "description": "true: the whole page text and every entry (12K chars). Default: a ~6K summary (main text, headings, main/dialog entries first)."}
        }),
        "click" | "hover" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "button": {"type": "string"},
            "click_count": {"type": "integer"},
            "modifiers": {"type": "array", "items": {"type": "string"}},
        }),
        "type" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "text": {"type": "string"},
            "clear": {"type": "boolean"},
            "submit": {"type": "boolean"},
        }),
        "fill_form" => json!({
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "integer"},
                        "selector": {"type": "string"},
                        "value": {"type": "string"}
                    }
                }
            }
        }),
        "select_option" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "value": {"type": "string"}
        }),
        "press_key" => json!({
            "key": {"type": "string"},
            "modifiers": {"type": "array", "items": {"type": "string"}}
        }),
        "evaluate" => json!({"expression": {"type": "string"}}),
        "wait_for" => json!({
            "text": {"type": "string"},
            "text_gone": {"type": "string"},
            "time": {"type": "number"},
            "timeout": {"type": "integer"}
        }),
        "console_messages" => json!({
            "level": {"type": "string", "description": "info|warning|error"},
            "clear": {"type": "boolean"}
        }),
        "network_requests" => json!({
            "filter": {"type": "string"},
            "clear": {"type": "boolean"}
        }),
        "find" => json!({"text": {"type": "string"}}),
        "scroll" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "dx": {"type": "integer"},
            "dy": {"type": "integer"}
        }),
        "resize" => json!({"width": {"type": "integer"}, "height": {"type": "integer"}}),
        "emulate_media" => json!({
            "colorScheme": {"type": "string"},
            "reducedMotion": {"type": "string"},
            "forcedColors": {"type": "string"},
            "media": {"type": "string"}
        }),
        "handle_dialog" => json!({
            "accept": {"type": "boolean"},
            "promptText": {"type": "string"}
        }),
        "file_upload" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "paths": {"type": "array", "items": {"type": "string"}}
        }),
        "drag" => json!({
            "ref": {"type": "integer"},
            "selector": {"type": "string"},
            "to_ref": {"type": "integer"},
            "to_selector": {"type": "string"}
        }),
        "tabs" => json!({
            "action": {"type": "string", "description": "list | new | select | close"},
            "index": {"type": "integer"},
            "url": {"type": "string"}
        }),
        _ => json!({}),
    }
}

/// Native agent tools: one per browser action. The app ships its own CDP driver
/// under these names, so no MCP connector is needed for the browser.
pub fn entries() -> Vec<(&'static str, &'static str, Value)> {
    ACTIONS
        .iter()
        .map(|(tool, desc)| {
            (
                *tool,
                *desc,
                action_props(tool.trim_start_matches("browser_")),
            )
        })
        .collect()
}
