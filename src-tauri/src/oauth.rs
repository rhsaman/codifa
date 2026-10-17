//! Native Google OAuth sign-in (port of the Python sidecar's
//! `/oauth/google/{start,callback,result}` trio).
//!
//! Flow: bind a loopback listener on a free port, build the consent URL with
//! that port as the `redirect_uri`, open the OS browser, then serve the ONE
//! callback request Google redirects back with. The authorization code is
//! exchanged for tokens with `reqwest` — no Python, no polling endpoint.
//!
//! Google allows a loopback redirect with an arbitrary port
//! (`http://127.0.0.1:<any>/…`), which is why the port does not have to be
//! pre-registered or fixed.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Search Console (webmasters) — the default scope of the sign-in flow. Gemini
/// models authenticate with an API key, so OAuth exists only for that tool.
pub const SEARCH_CONSOLE_SCOPE: &str = "https://www.googleapis.com/auth/webmasters.readonly";

/// How long to keep the callback listener open for the user to finish consent.
const CONSENT_BUDGET: Duration = Duration::from_secs(5 * 60);

const CALLBACK_PATH: &str = "/oauth/google/callback";

fn urlencode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Percent-decode one query value (`+` counts as a space).
fn urldecode(s: &str) -> String {
    percent_encoding::percent_decode_str(&s.replace('+', " "))
        .decode_utf8_lossy()
        .into_owned()
}

/// Split a raw query string into decoded key/value pairs.
fn parse_query(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        out.insert(urldecode(k), urldecode(v));
    }
    out
}

/// A tiny HTML page shown in the browser tab after the redirect.
fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:15px -apple-system,system-ui,sans-serif;margin:14vh auto;\
         max-width:520px;text-align:center;color:#222}}h1{{font-size:19px}}</style>\
         <h1>{title}</h1><p>{body}</p>"
    )
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(msg.as_bytes()).await;
    let _ = sock.flush().await;
}

/// Exchange an authorization code for tokens. Returns the raw token response.
async fn exchange_code(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<Value, String> {
    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("google oauth token exchange failed: {e}"))?;
    let status = res.status();
    let data: Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        let detail = data
            .get("error_description")
            .or_else(|| data.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!(
            "google oauth token exchange failed ({}): {detail}",
            status.as_u16()
        ));
    }
    Ok(data)
}

/// Run the whole sign-in: consent URL → OS browser → callback → token exchange.
pub async fn sign_in(
    client_id: &str,
    client_secret: &str,
    scope: Option<String>,
) -> Result<Value, String> {
    let cid = client_id.trim();
    if cid.is_empty() {
        return Err("missing Google OAuth client id".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("cannot open the OAuth callback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let state = uuid::Uuid::new_v4().simple().to_string();
    let scope = scope
        .unwrap_or_default()
        .trim()
        .to_string();
    let scope = if scope.is_empty() {
        SEARCH_CONSOLE_SCOPE.to_string()
    } else {
        scope
    };

    let consent_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &access_type=offline&prompt=consent&state={}",
        urlencode(cid),
        urlencode(&redirect_uri),
        urlencode(&scope),
        urlencode(&state),
    );
    open::that_detached(&consent_url).map_err(|e| format!("cannot open the browser: {e}"))?;

    let http = crate::llm::http_client();
    let deadline = tokio::time::Instant::now() + CONSENT_BUDGET;
    loop {
        let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
        let (mut sock, _peer) = match accepted {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(format!("oauth callback accept failed: {e}")),
            Err(_) => return Err("Google sign-in timed out".into()),
        };
        // Only the request line is needed — read once and parse it.
        let mut buf = vec![0u8; 8192];
        let n = match sock.read(&mut buf).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();
        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target, String::new()),
        };
        // Browsers fire extra requests (favicon) at the same origin: ignore
        // anything that is not the callback, keeping the listener open.
        if path != CALLBACK_PATH {
            respond(&mut sock, "404 Not Found", &page("Not found", "")).await;
            continue;
        }
        let params = parse_query(&query);
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            respond(
                &mut sock,
                "400 Bad Request",
                &page("Sign-in failed", "The OAuth state did not match. Try again."),
            )
            .await;
            return Err("Google sign-in state mismatch — try signing in again".into());
        }
        if let Some(err) = params.get("error") {
            respond(
                &mut sock,
                "200 OK",
                &page("Sign-in cancelled", "You can close this tab."),
            )
            .await;
            return Err(format!("Google sign-in cancelled ({err})"));
        }
        let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
            respond(
                &mut sock,
                "400 Bad Request",
                &page("Sign-in failed", "Google returned no authorization code."),
            )
            .await;
            return Err("Google returned no authorization code".into());
        };

        match exchange_code(&http, cid, client_secret.trim(), code, &redirect_uri).await {
            Ok(data) => {
                let refresh = data
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if refresh.is_empty() {
                    respond(
                        &mut sock,
                        "200 OK",
                        &page(
                            "Sign-in incomplete",
                            "Google returned no refresh token. Remove this app's access at \
                             myaccount.google.com/permissions and sign in again.",
                        ),
                    )
                    .await;
                    return Err(
                        "Google returned no refresh token — revoke the app's access and retry".into(),
                    );
                }
                respond(
                    &mut sock,
                    "200 OK",
                    &page(
                        "Signed in!",
                        "Your Google account is connected. You can close this tab and return to Codifa.",
                    ),
                )
                .await;
                return Ok(json!({
                    "refreshToken": refresh,
                    "accessToken": data.get("access_token").and_then(Value::as_str).unwrap_or(""),
                    "expiresIn": data.get("expires_in").and_then(Value::as_u64).unwrap_or(3600),
                }));
            }
            Err(e) => {
                respond(
                    &mut sock,
                    "400 Bad Request",
                    &page("Sign-in failed", &e),
                )
                .await;
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing_decodes_and_handles_bare_keys() {
        let q = parse_query("code=4%2F0A&state=abc-123&error=");
        assert_eq!(q.get("code").map(String::as_str), Some("4/0A"));
        assert_eq!(q.get("state").map(String::as_str), Some("abc-123"));
        assert_eq!(q.get("error").map(String::as_str), Some(""));
        let bare = parse_query("flag");
        assert_eq!(bare.get("flag").map(String::as_str), Some(""));
    }

    #[test]
    fn urlencode_escapes_separators_and_spaces() {
        assert_eq!(urlencode("4/0A b"), "4%2F0A%20b");
        assert!(urlencode(SEARCH_CONSOLE_SCOPE).contains("%2F"));
        assert_eq!(urldecode(&urlencode("a b/c")), "a b/c");
    }
}
