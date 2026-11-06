use super::*;

/// One pasted cookie ready for `Network.setCookie`.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct PastedCookie {
    pub(super) name: String,
    pub(super) value: String,
}

/// Set-Cookie attribute names that must never become a cookie when the user
/// pastes a whole `Set-Cookie:` header line.
pub(super) const COOKIE_ATTRS: [&str; 8] = [
    "path",
    "domain",
    "expires",
    "max-age",
    "secure",
    "httponly",
    "samesite",
    "partitioned",
];

/// Parse what the user pasted into the import dialog. Accepted shapes, most
/// specific first:
///   * a JSON array of DevTools-style cookie objects (`[{"name": ..., "value": ...}]`);
///   * `name=value; name2=value2` — the shape of `document.cookie` / a
///     `Cookie:` header / a `Set-Cookie:` line (attributes are dropped);
///   * one bare token with no `=` — treated as the `sessionid` value, the one
///     cookie an Instagram session needs.
/// Later duplicates of the same name win (the paste's own intent).
pub(super) fn parse_cookie_blob(raw: &str) -> Vec<PastedCookie> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    // JSON array of cookie objects (the "EditThisCookie"-style export).
    if raw.starts_with('[') {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(raw) {
            let out: Vec<PastedCookie> = items
                .iter()
                .filter_map(|c| {
                    let name = c["name"].as_str()?.trim().to_string();
                    let value = c["value"].as_str()?.to_string();
                    (!name.is_empty()).then_some(PastedCookie { name, value })
                })
                .collect();
            if !out.is_empty() {
                return dedupe_cookies(out);
            }
        }
    }
    // name=value pairs. No `=` anywhere: a single bare token is the sessionid
    // value itself.
    if !raw.contains('=') {
        return vec![PastedCookie {
            name: "sessionid".to_string(),
            value: raw.to_string(),
        }];
    }
    let out: Vec<PastedCookie> = raw
        .split(';')
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            let name = name.trim().to_string();
            if name.is_empty() || COOKIE_ATTRS.contains(&name.to_ascii_lowercase().as_str()) {
                return None;
            }
            Some(PastedCookie {
                name,
                value: value.trim().to_string(),
            })
        })
        .collect();
    dedupe_cookies(out)
}

/// Keep the LAST value for every name (a paste that repeats a cookie means
/// "the later one is the current one").
pub(super) fn dedupe_cookies(cookies: Vec<PastedCookie>) -> Vec<PastedCookie> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<PastedCookie> = Vec::with_capacity(cookies.len());
    for c in cookies {
        match seen.get(&c.name) {
            Some(&i) => out[i] = c,
            None => {
                seen.insert(c.name.clone(), out.len());
                out.push(c);
            }
        }
    }
    out
}

/// Import pasted session cookies into the shared browser profile.
///
/// The paste flow exists for sites whose server-side bot defenses reject even
/// a perfectly presented login form from an automation browser — Instagram
/// above all. Importing the user's OWN session cookie is ordinary multi-device
/// behavior: no password is typed into the virtual browser, so there is no
/// failed-login signal, and the cookie lands in the same persistent profile
/// the in-app logins live in.
pub fn import_cookies(chat_id: &str, domain: &str, raw: &str) -> Value {
    let cookies = parse_cookie_blob(raw);
    if cookies.is_empty() {
        return json!({"ok": false, "error": "no cookies found in the paste"});
    }
    let host = domain
        .trim()
        .split("://")
        .last()
        .unwrap_or_default()
        .trim_matches('/')
        .trim_start_matches('.')
        .to_string();
    if host.is_empty() || !host.contains('.') {
        return json!({"ok": false, "error": "a domain like instagram.com is required"});
    }
    let chat = normalize_chat(chat_id);
    // The setCookie call rides a tab's CDP session; cookies are browser-global
    // once set, so the choice of tab does not matter — any live one works.
    let tab = match existing_tab(&chat) {
        Some(t) if tab_usable(&t.target_id) => t,
        _ => match ensure_tab(&chat) {
            Ok(t) => t,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    // One year out: a session-scoped cookie would vanish with the browser,
    // and the paste came from a long-lived login.
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 365 * 24 * 3600;
    let mut calls: Vec<(&'static str, Value)> = vec![("Network.enable", json!({}))];
    let mut names = Vec::new();
    for c in &cookies {
        calls.push((
            "Network.setCookie",
            json!({
                "name": c.name,
                "value": c.value,
                "domain": format!(".{host}"),
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "Lax",
                "expires": expires,
            }),
        ));
        names.push(c.name.clone());
    }
    match cdp_calls_on(&tab, calls, false) {
        Ok(results) => {
            let imported = results
                .iter()
                .skip(1) // Network.enable's ack
                .filter(|r| r["success"] == true)
                .count();
            json!({"ok": true, "imported": imported, "names": names, "domain": host})
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

