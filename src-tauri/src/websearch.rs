//! Native web search: the `web_search` tool.
//!
//! Mirrors the Python sidecar's search backends (DuckDuckGo, Tavily) but runs
//! in-process. The engine order is NOT hardcoded: it follows Settings → Plugins,
//! where the top engine is the primary and the ones below are fallbacks tried in
//! order until one answers. A disabled engine is never used.

use serde_json::{json, Value};

/// One search hit, shaped so the frontend's WebResultLinks can render it.
fn hit(title: &str, url: &str, snippet: &str) -> Value {
    json!({"title": title, "url": url, "snippet": snippet})
}

/// Strip HTML tags and collapse whitespace (DDG returns markup in titles).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Decode the handful of entities DDG emits in titles/snippets.
fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

/// DDG wraps every result link in a redirect (`//duckduckgo.com/l/?uddg=<url>`);
/// unwrap it so the UI links to the real page.
fn decode_ddg_url(raw: &str) -> String {
    let url = if let Some(rest) = raw.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        raw.to_string()
    };
    if let Some(idx) = url.find("uddg=") {
        let rest = &url[idx + 5..];
        let enc = rest.split('&').next().unwrap_or(rest);
        return percent_encoding::percent_decode_str(enc)
            .decode_utf8_lossy()
            .to_string();
    }
    url
}

/// Flatten an error and its `source()` chain into one line, so a failed
/// request reports the real cause (DNS, TLS, connect) instead of a generic
/// "error sending request".
fn err_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![e.to_string()];
    let mut cur = e.source();
    while let Some(inner) = cur {
        parts.push(inner.to_string());
        cur = inner.source();
    }
    parts.join(" <- ")
}

/// Parse a DuckDuckGo HTML result page into hits.
///
/// Split from the fetch so it can be tested offline against a saved page:
/// the endpoint rate-limits by IP, so a live request is not always possible.
fn parse_ddg_html(body: &str, max: usize) -> Result<Vec<Value>, String> {
    let link_re = regex::Regex::new(r#"(?s)class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
        .map_err(|e| e.to_string())?;
    let snip_re = regex::Regex::new(r#"(?s)class="result__snippet"[^>]*>(.*?)</a>"#)
        .map_err(|e| e.to_string())?;
    let snippets: Vec<String> = snip_re
        .captures_iter(body)
        .map(|c| unescape(&strip_tags(&c[1])))
        .collect();
    let mut out: Vec<Value> = Vec::new();
    for (i, c) in link_re.captures_iter(body).enumerate() {
        if out.len() >= max {
            break;
        }
        let url = decode_ddg_url(&c[1]);
        let title = unescape(&strip_tags(&c[2]));
        if url.is_empty() || title.is_empty() {
            continue;
        }
        out.push(hit(
            &title,
            &url,
            snippets.get(i).map(String::as_str).unwrap_or_default(),
        ));
    }
    Ok(out)
}

/// DuckDuckGo via its no-JS HTML endpoint (the page the `ddgs` package scrapes).
///
/// The endpoint refuses a plain TLS client, so the request goes through
/// `primp`, which reproduces Chrome's TLS/HTTP2 fingerprint. The Python `ddgs`
/// package reaches the same page with httpx (HTTP/2 + shuffled ciphers) rather
/// than primp, so the two clients are equivalent in intent, not in code.
///
/// Some networks block DuckDuckGo outright (Iran, for one): there the request
/// times out for every client and the fallback chain moves to the next engine.
async fn duckduckgo(
    _client: &reqwest::Client,
    query: &str,
    max: usize,
) -> Result<Vec<Value>, String> {
    let client = primp::Client::builder()
        .impersonate(primp::Impersonate::Chrome)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let res = client
        .post("https://html.duckduckgo.com/html/")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .form(&[("q", query), ("b", ""), ("l", "wt-wt")])
        .send()
        .await
        .map_err(|e| format!("request failed: {}", err_chain(&e)))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| format!("body read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let out = parse_ddg_html(&body, max)?;
    if out.is_empty() {
        return Err("no results (the endpoint may be rate-limiting)".into());
    }
    Ok(out)
}

/// Tavily's search API (plain API key, no OAuth).
async fn tavily(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    max: usize,
) -> Result<Vec<Value>, String> {
    if api_key.trim().is_empty() {
        return Err("no API key set (Settings → Plugins)".into());
    }
    let res = client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "max_results": max,
            "search_depth": "basic",
        }))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    let parsed: Value =
        serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    let out: Vec<Value> = parsed["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .take(max)
                .map(|r| {
                    hit(
                        r["title"].as_str().unwrap_or_default(),
                        r["url"].as_str().unwrap_or_default(),
                        r["content"].as_str().unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        return Err("no results".into());
    }
    Ok(out)
}

/// Run `query` against the configured engines, top to bottom.
///
/// `plugins` is the Settings → Plugins list verbatim: `order` decides priority
/// (0 = primary, higher = fallback) and `enabled: false` removes an engine from
/// the chain entirely. The first engine that answers wins; when every one fails
/// the error names each engine and its reason, so a broken key is visible
/// instead of silently degrading to "no results".
pub async fn search(plugins: &[Value], query: &str, max: usize) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("web_search requires a query".into());
    }
    let mut ordered: Vec<&Value> = plugins
        .iter()
        .filter(|p| p["enabled"].as_bool().unwrap_or(true))
        .collect();
    ordered.sort_by_key(|p| p["order"].as_u64().unwrap_or(u64::MAX));
    if ordered.is_empty() {
        return Err("no web-search engine is enabled (Settings → Plugins)".into());
    }
    let client = crate::llm::http_client();
    let mut failures: Vec<String> = Vec::new();
    for p in ordered {
        let kind = p["kind"].as_str().unwrap_or_default();
        let label = p["label"].as_str().unwrap_or(kind);
        let attempt = match kind {
            "duckduckgo" => duckduckgo(&client, q, max).await,
            "tavily" => tavily(&client, p["apiKey"].as_str().unwrap_or_default(), q, max).await,
            other => Err(format!("unknown engine {other:?}")),
        };
        match attempt {
            Ok(hits) => return Ok(serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into())),
            Err(e) => failures.push(format!("{label}: {e}")),
        }
    }
    Err(format!(
        "every web-search engine failed — {}",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_tags_removes_markup_and_collapses_space() {
        assert_eq!(strip_tags("<b>Hello</b>\n  <i>world</i>"), "Hello world");
    }

    #[test]
    fn unescape_decodes_entities() {
        assert_eq!(unescape("a &amp; b &#x27;c&#x27;"), "a & b 'c'");
    }

    #[test]
    fn decode_ddg_url_unwraps_the_redirect() {
        let raw = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x";
        assert_eq!(decode_ddg_url(raw), "https://example.com/a?b=1");
        // A direct link is passed through untouched.
        assert_eq!(decode_ddg_url("https://x.dev/y"), "https://x.dev/y");
    }

    /// A trimmed copy of a real DuckDuckGo HTML result page: the redirect
    /// wrapper, the `result__a` title link and the `result__snippet` body.
    const DDG_PAGE: &str = r##"
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F&rut=abc">Rust <b>Programming</b> Language</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F">A language empowering everyone to build reliable software.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRust&amp;rut=def">Rust (programming language) &amp; friends</a>
    </h2>
    <a class="result__snippet" href="#">Rust is a multi-paradigm systems programming language.</a>
  </div>
</div>
"##;

    #[test]
    fn parse_ddg_html_reads_a_real_result_page() {
        let hits = parse_ddg_html(DDG_PAGE, 10).expect("parse");
        assert_eq!(hits.len(), 2, "{hits:?}");
        // The redirect wrapper is unwrapped and the title markup stripped.
        assert_eq!(hits[0]["url"], "https://www.rust-lang.org/");
        assert_eq!(hits[0]["title"], "Rust Programming Language");
        assert_eq!(
            hits[0]["snippet"],
            "A language empowering everyone to build reliable software."
        );
        // Entities in titles are decoded.
        assert_eq!(hits[1]["title"], "Rust (programming language) & friends");
        assert_eq!(hits[1]["url"], "https://en.wikipedia.org/wiki/Rust");
    }

    #[test]
    fn parse_ddg_html_honours_the_result_cap() {
        let hits = parse_ddg_html(DDG_PAGE, 1).expect("parse");
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn parse_ddg_html_returns_nothing_for_a_challenge_page() {
        // The anti-bot page carries no result markup, so the caller reports
        // "no results" instead of inventing hits.
        let hits = parse_ddg_html("<html><body>anomaly challenge</body></html>", 5).expect("parse");
        assert!(hits.is_empty(), "{hits:?}");
    }

    #[tokio::test]
    async fn search_errors_when_no_engine_is_enabled() {
        let plugins = json!([{"kind": "duckduckgo", "enabled": false, "order": 0}]);
        let err = search(plugins.as_array().unwrap(), "rust", 5)
            .await
            .unwrap_err();
        assert!(err.contains("no web-search engine is enabled"), "{err}");
    }

    #[tokio::test]
    async fn search_tries_engines_in_settings_order() {
        // Two unknown engines: the failure report must follow `order`, not the
        // array order — that is the whole point of the Settings → Plugins list.
        let plugins = json!([
            {"kind": "second", "label": "Second", "enabled": true, "order": 1},
            {"kind": "first", "label": "First", "enabled": true, "order": 0},
        ]);
        let err = search(plugins.as_array().unwrap(), "rust", 5)
            .await
            .unwrap_err();
        let first = err.find("First:").expect("First must be reported");
        let second = err.find("Second:").expect("Second must be reported");
        assert!(first < second, "order 0 must be tried first: {err}");
    }

    /// Live network check: DuckDuckGo needs no key, so it must answer even
    /// when the primary engine is misconfigured — this is the fallback the
    /// Settings → Plugins order promises. Run with `--ignored`.
    ///
    /// DuckDuckGo rate-limits by IP, so a blocked network is reported as a
    /// skip: the HTML parsing itself is covered offline by
    /// `parse_ddg_html_reads_a_real_result_page`.
    #[tokio::test]
    #[ignore]
    async fn live_duckduckgo_answers_when_the_primary_engine_fails() {
        let plugins = json!([
            {"kind": "tavily", "enabled": true, "order": 0, "apiKey": "tvly-bogus"},
            {"kind": "duckduckgo", "enabled": true, "order": 1},
        ]);
        let out = match search(plugins.as_array().unwrap(), "rust programming language", 3).await {
            Ok(out) => out,
            Err(e) if e.contains("timed out") || e.contains("no results") => {
                eprintln!("skipped: DuckDuckGo unreachable from this network — {e}");
                return;
            }
            Err(e) => panic!("duckduckgo should answer when tavily fails: {e}"),
        };
        let hits: Vec<Value> = serde_json::from_str(&out).expect("hits json");
        assert!(!hits.is_empty(), "no hits: {out}");
        assert!(
            hits[0]["url"].as_str().unwrap_or_default().starts_with("http"),
            "{out}"
        );
    }

    /// Control for the DuckDuckGo live test: proves the `primp` client itself
    /// reaches the network, so a DuckDuckGo failure can be blamed on the
    /// network blocking DuckDuckGo rather than on a broken impersonation
    /// client. Run with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_primp_reaches_a_control_host() {
        let client = primp::Client::builder()
            .impersonate(primp::Impersonate::Chrome)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("primp client");
        let res = client
            .get("https://example.com/")
            .send()
            .await
            .expect("primp should reach a plain host");
        assert!(res.status().is_success(), "status {}", res.status());
    }

    #[tokio::test]
    async fn search_requires_a_query() {
        let plugins = json!([{"kind": "duckduckgo", "enabled": true, "order": 0}]);
        let err = search(plugins.as_array().unwrap(), "   ", 5)
            .await
            .unwrap_err();
        assert!(err.contains("requires a query"), "{err}");
    }
}
