use super::*;

/// Permissive CORS for the webview: the renderer origin (vite dev server or
/// tauri://localhost) is cross-origin to this loopback port and WKWebView
/// enforces CORS strictly — without these headers every renderer fetch fails
/// even though the proxy itself works (curl never notices the difference).
/// The Python sidecar used to send them directly (allow_origins=["*"]); the
/// proxy must behave the same now that all traffic flows through it.
pub(super) async fn cors(req: Request<Body>, next: Next) -> Response<Body> {
    // Answer preflight here: the browser sends OPTIONS before any JSON POST
    // and must get the allow headers without a round trip to the sidecar.
    if req.method() == axum::http::Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_cors_headers(&mut res);
        return res;
    }
    let mut res = next.run(req).await;
    add_cors_headers(&mut res);
    res
}

pub(super) fn add_cors_headers(res: &mut Response<Body>) {
    let h = res.headers_mut();
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        axum::http::HeaderValue::from_static("*"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("*"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    h.insert(
        axum::http::header::ACCESS_CONTROL_MAX_AGE,
        axum::http::HeaderValue::from_static("86400"),
    );
}

pub(super) async fn health() -> Response<Body> {
    Json(json!({"status": "ok", "version": "1.0.0"})).into_response()
}

// ---------- web (serve) mode: token auth + static frontend ------------------

/// Token gate, active ONLY in serve mode (`codifa serve`). The desktop app's
/// loopback router stays unauthenticated so the Tauri renderer keeps working.
///
/// A candidate token is accepted from, in order: `Authorization: Bearer`, the
/// `?token=` query, then the `codifa_token` cookie. The cookie is the workhorse
/// (same-origin pages and WebSockets carry it automatically); the query is how
/// the session is BOOTSTRAPPED — the server prints a `?token=` URL and this
/// middleware plants the cookie on the first response. WS clients cannot set
/// headers, so the cookie must exist before anything else works.
pub(super) async fn web_auth(req: Request<Body>, next: Next) -> Response<Body> {
    let Some(token) = crate::webmode::token() else {
        return next.run(req).await;
    };
    if req.method() == axum::http::Method::OPTIONS || req.uri().path() == "/health" {
        // Preflights are answered by the cors layer below; /health carries no
        // data and lets uptime probes work without the token.
        return next.run(req).await;
    }

    let mut from_query = false;
    let mut candidate: Option<String> = None;
    if let Some(h) = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(t) = h.strip_prefix("Bearer ") {
            candidate = Some(t.trim().to_string());
        }
    }
    if candidate.is_none() {
        if let Some(q) = req.uri().query() {
            for pair in q.split('&') {
                if let Some(v) = pair.strip_prefix("token=") {
                    candidate = Some(percent_decode(v));
                    from_query = true;
                    break;
                }
            }
        }
    }
    if candidate.is_none() {
        if let Some(c) = req
            .headers()
            .get(axum::http::header::COOKIE)
            .and_then(|v| v.to_str().ok())
        {
            for pair in c.split(';') {
                if let Some(v) = pair.trim().strip_prefix("codifa_token=") {
                    candidate = Some(v.to_string());
                    break;
                }
            }
        }
    }

    match candidate {
        Some(t) if crate::webmode::token_matches(&t) => {
            // Behind a TLS proxy (which sets x-forwarded-proto) the session
            // cookie gets `Secure` so it never rides a plain-HTTP downgrade;
            // a direct loopback session stays without it — `Secure` would
            // stop the cookie being sent over the http:// URLs that
            // legitimately have no TLS. Read before `next.run(req)`: the
            // request is consumed there.
            let https = req
                .headers()
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(|v| v.trim().eq_ignore_ascii_case("https"))
                .unwrap_or(false);
            let mut res = next.run(req).await;
            if from_query {
                // Plant the session cookie: every later request (assets, the
                // terminal WebSocket) authenticates itself without the token
                // sitting in the URL bar / history.
                let cookie = format!(
                    "codifa_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{}",
                    if https { "; Secure" } else { "" }
                );
                if let Ok(hv) = axum::http::HeaderValue::from_str(&cookie) {
                    res.headers_mut()
                        .append(axum::http::header::SET_COOKIE, hv);
                }
            }
            res
        }
        _ => unauthorized(req.uri().path()),
    }
}

pub(super) fn unauthorized(path: &str) -> Response<Body> {
    // A browser navigation gets an HTML hint (the token lives in the URL the
    // server printed); API calls get the plain JSON error the renderer shows.
    let looks_like_document = !path
        .rsplit('/')
        .next()
        .map(|seg| seg.contains('.'))
        .unwrap_or(false);
    if looks_like_document {
        let html = concat!(
            "<!doctype html><meta charset=\"utf-8\"><title>Codifa — unauthorized</title>",
            "<body style=\"font-family:sans-serif;background:#1e1e1e;color:#ddd;",
            "display:grid;place-items:center;height:100vh;margin:0\">",
            "<p style=\"max-width:36em;line-height:1.6\">No access token. Open the ",
            "<code>?token=…</code> URL that the server printed when it started",
            " (it is also saved in <code>~/.codifa/web-token</code>).</p></body>"
        );
        (
            StatusCode::UNAUTHORIZED,
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response()
    }
}

/// Minimal percent-decoding for the `?token=` value (`+` and `%XX`).
pub(super) fn percent_decode(v: &str) -> String {
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Desktop router: unknown paths are real 404s (see `not_found`). Serve mode
/// falls through to the built frontend instead.
pub(super) async fn mode_fallback(req: Request<Body>) -> Response<Body> {
    if crate::webmode::active().is_some() {
        return static_file(req).await;
    }
    not_found(req).await
}

/// Serve the built frontend: embedded assets first (a packaged build has the
/// renderer INSIDE the binary through Tauri's asset embedding), then the
/// `--dist` directory for a dev/cargo run. SPA routes (no extension) fall back
/// to `index.html`.
pub(super) async fn static_file(req: Request<Body>) -> Response<Body> {
    let raw = req.uri().path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };
    if path.split('/').any(|seg| seg == "..") {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }

    if let Some(app) = crate::webmode::app() {
        if let Some(asset) = app.asset_resolver().get(path.to_string()) {
            let mut res = Response::builder()
                .status(StatusCode::OK)
                .header(axum::http::header::CONTENT_TYPE, asset.mime_type)
                .header(
                    axum::http::header::CACHE_CONTROL,
                    cache_control_for(path),
                )
                .body(Body::from(asset.bytes))
                .unwrap();
            if let Some(csp) = asset.csp_header {
                if let Ok(hv) = axum::http::HeaderValue::from_str(&csp) {
                    res.headers_mut().append("content-security-policy", hv);
                }
            }
            return res;
        }
    }

    if let Some(dist) = crate::webmode::dist_dir() {
        let mut resolved: Option<PathBuf> = None;
        let candidate = dist.join(path);
        if candidate.is_file() {
            resolved = Some(candidate);
        } else if !path.contains('.') {
            // SPA fallback: /chats/abc and friends are index.html's routes.
            let index = dist.join("index.html");
            if index.is_file() {
                resolved = Some(index);
            }
        }
        if let Some(file) = resolved {
            if let Ok(bytes) = tokio::fs::read(&file).await {
                let mime = mime_for_path(&file);
                return (
                    StatusCode::OK,
                    [
                        (axum::http::header::CONTENT_TYPE, mime),
                        (axum::http::header::CACHE_CONTROL, cache_control_for(path)),
                    ],
                    bytes,
                )
                    .into_response();
            }
        }
    }

    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": format!("no such file: {path}") })),
    )
        .into_response()
}

/// Hashed asset filenames are immutable; the entry document is not.
pub(super) fn cache_control_for(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

/// The static-mime map for the disk fallback. The embedded-asset path carries
/// its own mime from the bundler, so this only ever sees `--dist` files.
pub(super) fn mime_for_path(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

