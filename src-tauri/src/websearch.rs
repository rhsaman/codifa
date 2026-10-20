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
        // The shared client deliberately has no deadline (a MODEL may think for
        // minutes and must never be cut off), but a SEARCH has no reason to hang
        // forever: a server that accepts the connection and goes silent used to
        // freeze the whole turn — inside an explore that meant "stuck after a
        // tool call", with no error and no retry, because the call never
        // returned. Bound it so the engine chain fails over / reports instead.
        .timeout(std::time::Duration::from_secs(30))
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
/// JSON-string form of [`search_with_engine`], kept as the plain "just give me
/// the hits" entry point (the engine chain itself lives there).
#[allow(dead_code)]
pub async fn search(plugins: &[Value], query: &str, max: usize) -> Result<String, String> {
    let (hits, _engine) = search_with_engine(plugins, query, max).await?;
    Ok(serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into()))
}

/// Same chain as [`search`], but it also reports WHICH engine answered, as the
/// engine `kind` (`duckduckgo`, `tavily`, …). Because the chain falls back, the
/// configured primary is not necessarily the one that served the query — the
/// chat card badges the engine that actually answered, so it must come from
/// here and not from the settings list.
pub async fn search_with_engine(
    plugins: &[Value],
    query: &str,
    max: usize,
) -> Result<(Vec<Value>, String), String> {
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
            // Report the engine that actually answered: a fallback may have
            // served this query, and the chat card badges that one.
            Ok(hits) => return Ok((hits, kind.to_string())),
            Err(e) => failures.push(format!("{label}: {e}")),
        }
    }
    Err(format!(
        "every web-search engine failed — {}",
        failures.join("; ")
    ))
}

// ---------- page fetching (`fetch_url` + `web_search` auto-fetch) -------------

/// Browser User-Agent for page fetches. Documentation sites and CDNs routinely
/// answer 403 to an empty or `curl`-looking agent, which the model cannot work
/// around — the same reason the old Python sidecar retried a 403 with a browser
/// UA before giving up.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Hard cap on the bytes read from one page, so an enormous (or hostile)
/// response can never balloon memory or the model's context.
pub const MAX_FETCH_BYTES: usize = 1_000_000;
/// Per-request deadline for a page fetch. The shared client deliberately has no
/// total deadline (a MODEL may think for minutes and must not be cut off), but a
/// page fetch that hangs would freeze the whole turn — bound it.
const FETCH_TIMEOUT_SECS: u64 = 30;
/// Default text cap for one explicit `fetch_url` call (mirrors codex's
/// `web_fetch`): a single call returns the page, not a teaser.
pub const FETCH_EXCERPT_CHARS: usize = 100_000;
/// Per-page text cap when `web_search` auto-fetches its top results: the page is
/// only an input to the distiller there, so it stays lean.
const WEB_SEARCH_FETCH_CHARS: usize = 4_000;
/// Upper bound on the auto-fetch count: one search must never fan out into an
/// unbounded number of downloads.
pub const WEB_SEARCH_AUTO_FETCH_MAX: usize = 10;
/// Default for `webSearchAutoFetch` (Settings → Web Providers): five results
/// returned and the top five fetched — the count the UI starts at.
pub const WEB_SEARCH_AUTO_FETCH_DEFAULT: usize = 5;
/// Per-result snippet cap inside `web_search`'s answer, so ten results cannot
/// crowd out the auto-fetched page content.
const WEB_SEARCH_SNIPPET_MAX: usize = 200;

/// Byte length of the UTF-8 character starting with `b`.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// Decode `&#123;` / `&#x1F600;` numeric entities (they are common in modern
/// pages and would otherwise reach the model as noise).
fn decode_numeric_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' && i + 2 < bytes.len() && bytes[i + 1] == b'#' {
            let hex = bytes[i + 2] == b'x' || bytes[i + 2] == b'X';
            let start = if hex { i + 3 } else { i + 2 };
            let mut end = start;
            while end < bytes.len() && bytes[end] != b';' && end - start < 8 {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b';' && end > start {
                let digits = &s[start..end];
                if let Ok(code) = u32::from_str_radix(digits, if hex { 16 } else { 10 }) {
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        let end = (i + utf8_len(bytes[i])).min(bytes.len());
        out.push_str(&s[i..end]);
        i = end;
    }
    out
}

/// Turn an HTML page into readable plain text.
///
/// Non-content elements (script/style/svg/…) are removed BEFORE tag stripping —
/// otherwise a modern page's entire JavaScript bundle lands in the model's
/// context. Block level tags become newlines so headings, list items and table
/// rows keep their own lines instead of merging into one paragraph.
pub fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    // `to_ascii_lowercase` preserves byte length (non-ASCII bytes are copied
    // verbatim), so an index found in the lowercased copy is valid for `s`.
    for tag in ["script", "style", "noscript", "svg", "template", "iframe", "head"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let lower = s.to_ascii_lowercase();
            let Some(start) = lower.find(&open) else { break };
            match lower[start..].find(&close) {
                // Unterminated block: nothing after it is trustworthy.
                None => {
                    s.truncate(start);
                    break;
                }
                Some(rel) => s.replace_range(start..start + rel + close.len(), " "),
            }
        }
    }
    while let Some(start) = s.find("<!--") {
        match s[start..].find("-->") {
            None => {
                s.truncate(start);
                break;
            }
            Some(rel) => s.replace_range(start..start + rel + 3, " "),
        }
    }
    // Block level boundaries become newlines so the text keeps its shape.
    let lower = s.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut spaced = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let end = bytes[i..]
                .iter()
                .position(|b| *b == b'>')
                .map(|rel| i + rel + 1)
                .unwrap_or(bytes.len());
            let name = lower[i + 1..end]
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
                .next()
                .unwrap_or("")
                .to_string();
            // Only BLOCK elements break the line: treating every closing tag
            // (</b>, </a>, </span>) as a break split inline prose across lines.
            let is_block = matches!(
                name.as_str(),
                "p" | "div"
                    | "li"
                    | "tr"
                    | "br"
                    | "hr"
                    | "ul"
                    | "ol"
                    | "table"
                    | "thead"
                    | "tbody"
                    | "section"
                    | "article"
                    | "header"
                    | "footer"
                    | "blockquote"
                    | "pre"
                    | "form"
                    | "nav"
                    | "aside"
                    | "main"
                    | "figure"
                    | "figcaption"
                    | "dl"
                    | "dd"
                    | "dt"
                    | "td"
                    | "th"
            ) || (name.len() == 2
                && name.starts_with('h')
                && name.as_bytes()[1].is_ascii_digit());
            spaced.push(if is_block { '\n' } else { '\0' });
            i = end;
            continue;
        }
        let end = (i + utf8_len(bytes[i])).min(bytes.len());
        spaced.push_str(&s[i..end]);
        i = end;
    }
    let decoded = unescape(&decode_numeric_entities(&spaced));
    // Inline tags contribute NO space (HTML does not render one: `<b>a</b>b`
    // is "ab"), so they are marked with NUL and removed here. Block tags keep
    // their newline, and empty lines are dropped — the block breaks already
    // separate the content.
    let mut out = String::with_capacity(decoded.len());
    for line in decoded.split('\n') {
        let line = line.replace('\0', "");
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Whether a URL points at a raw text/source file.
///
/// `fetch_url` returns such a URL WHOLE (like codex's `webfetch`): a skill
/// install or a docs page that came back as a 100k-char excerpt made the agent
/// re-fetch the same file, so the cap is auto-lifted instead of trusting the
/// model to pass `full=true`.
pub fn looks_like_source_url(url: &str) -> bool {
    let probe = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    let host = probe
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if [
        "raw.githubusercontent.com",
        "cdn.jsdelivr.net",
        "gist.github.com",
        "raw.fastgit.org",
    ]
    .iter()
    .any(|h| host.starts_with(h))
    {
        return true;
    }
    let last = host.rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((_, ext)) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "md" | "markdown"
                | "txt"
                | "text"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "py"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "css"
                | "html"
                | "htm"
                | "sh"
                | "bash"
                | "xml"
                | "svg"
                | "csv"
                | "sql"
                | "env"
                | "ini"
                | "conf"
                | "cfg"
                | "rs"
                | "go"
                | "java"
                | "rb"
                | "php"
        ),
        None => false,
    }
}

/// Cut `s` to at most `max` chars on a char boundary (byte slicing mid-char
/// panics on Persian/emoji text).
fn clamp_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// One page fetch: `{url, title, content, offset, total_chars}` or
/// `{url, error}`. Never panics — a broken URL must not fail the whole search.
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub url: String,
    pub title: String,
    pub content: String,
    pub total_chars: usize,
}

/// Fetch a URL and return its text.
///
/// The page is downloaded with a browser UA, on a bounded deadline, streamed and
/// truncated at `MAX_FETCH_BYTES`; a `403` is retried once with the same UA minus
/// the browser fingerprint (some CDNs reject only the fingerprint). HTML is
/// converted to plain text, and any other `text/*` / JSON / XML body is returned
/// as-is. `max_chars` bounds the RETURNED text only — a page already downloaded
/// is never re-downloaded for a different slice.
pub async fn fetch_page(
    client: &reqwest::Client,
    url: &str,
    max_chars: usize,
    offset: usize,
) -> Result<FetchedPage, String> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".into());
    }
    let mut req = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS));
    let mut res = match req.send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("request failed: {}", err_chain(&e))),
    };
    if res.status() == reqwest::StatusCode::FORBIDDEN {
        // Cloudflare-style blocks often key on the browser TLS/fingerprint
        // rather than the UA string; retry with a plain client UA.
        req = client
            .get(url)
            .header("User-Agent", "curl/8.7.1")
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS));
        res = match req.send().await {
            Ok(r) => r,
            Err(e) => return Err(format!("request failed: {}", err_chain(&e))),
        };
    }
    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Binary payloads (images, archives) would decode to garbage; say so
    // instead of handing the model a wall of replacement characters.
    let textual = content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript");
    if !textual {
        return Err(format!("unsupported content type {content_type:?}"));
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() >= MAX_FETCH_BYTES {
                    body.truncate(MAX_FETCH_BYTES);
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                if body.is_empty() {
                    return Err(format!("body read failed: {e}"));
                }
                break;
            }
        }
    }
    let raw = String::from_utf8_lossy(&body).into_owned();
    let head = raw.trim_start().to_ascii_lowercase();
    let is_html =
        content_type.contains("html") || head.starts_with("<!doctype") || head.starts_with("<html");
    // The title is read BEFORE the non-HTML branch moves `raw` into `text`.
    let title = if is_html { extract_title(&raw) } else { String::new() };
    let text = if is_html { html_to_text(&raw) } else { raw };
    // `offset` pages past an earlier excerpt: the caller re-reads a long page
    // without the model having to invent offsets.
    let sliced: String = text.chars().skip(offset).take(max_chars).collect();
    Ok(FetchedPage {
        url: url.to_string(),
        title,
        content: sliced,
        total_chars: text.chars().count(),
    })
}

/// The `<title>` of an HTML page, trimmed (empty when there is none).
fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(open_end) = lower[start..].find('>') else {
        return String::new();
    };
    let body_start = start + open_end + 1;
    let Some(rel_end) = lower[body_start..].find("</title>") else {
        return String::new();
    };
    unescape(&html[body_start..body_start + rel_end].trim().to_string())
}

/// Fetch several pages in parallel. A failing URL yields `None` and never
/// cancels the others — one dead link must not sink a whole search.
pub async fn fetch_many(
    client: &reqwest::Client,
    urls: &[String],
    max_chars: usize,
) -> Vec<Option<FetchedPage>> {
    let futs = urls.iter().map(|u| fetch_page(client, u, max_chars, 0));
    futures_util::future::join_all(futs)
        .await
        .into_iter()
        .map(|r| r.ok())
        .collect()
}

/// `web_search`'s page-text builder: searches, then auto-fetches the top `n`
/// results so the model gets real page content instead of a 200-char teaser.
///
/// Returns the ranked hits plus a `url -> page text` map. The fetch count comes
/// from the user's setting (0 disables it), so this is the only place that
/// decides how expensive a search is.
pub async fn search_with_pages(
    plugins: &[Value],
    query: &str,
    max: usize,
    auto_fetch: usize,
) -> Result<(Vec<Value>, Vec<(String, String)>, String), String> {
    let (hits, engine) = search_with_engine(plugins, query, max).await?;
    let n = auto_fetch.min(hits.len()).min(WEB_SEARCH_AUTO_FETCH_MAX);
    if n == 0 {
        return Ok((hits, Vec::new(), engine));
    }
    let urls: Vec<String> = hits
        .iter()
        .take(n)
        .filter_map(|h| h["url"].as_str().map(str::to_string))
        .collect();
    let client = crate::llm::http_client();
    let pages = fetch_many(&client, &urls, WEB_SEARCH_FETCH_CHARS).await;
    let pairs = urls
        .into_iter()
        .zip(pages)
        .filter_map(|(u, p)| p.map(|p| (u, p.content)))
        .filter(|(_, body)| !body.is_empty())
        .collect();
    Ok((hits, pairs, engine))
}

/// The model-facing answer for a search: one block per ranked result, with the
/// auto-fetched page body (or the snippet when the fetch failed) under it.
pub fn search_answer(
    query: &str,
    hits: &[Value],
    pages: &[(String, String)],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for h in hits {
        let url = h["url"].as_str().unwrap_or_default();
        let snippet = clamp_chars(h["snippet"].as_str().unwrap_or_default(), WEB_SEARCH_SNIPPET_MAX);
        let fetched = pages
            .iter()
            .find(|(u, _)| u == url)
            .map(|(_, body)| body.as_str());
        let body = fetched.unwrap_or(&snippet);
        let kind = if fetched.is_some() { "page" } else { "snippet" };
        lines.push(format!(
            "- {}\n  {url}\n  [{kind}] {body}",
            h["title"].as_str().unwrap_or_default()
        ));
    }
    format!("WEB RESULTS for {query:?}\n{}", lines.join("\n"))
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

    #[test]
    fn html_to_text_drops_scripts_and_keeps_the_prose() {
        // A modern page's JS bundle would otherwise land in the model's context;
        // the block tags must still break the text into lines.
        let html = "<html><head><title>T</title><style>body{color:red}</style></head>\
<body><script>var x = 1 < 2;</script><h1>Heading</h1><p>First <b>para</b>.</p>\
<ul><li>one</li><li>two</li></ul></body></html>";
        let text = html_to_text(html);
        assert!(!text.contains("var x"), "script body survived: {text}");
        assert!(!text.contains("color:red"), "style body survived: {text}");
        assert!(!text.contains('<'), "tags survived: {text}");
        assert!(text.contains("Heading"), "{text}");
        assert!(text.contains("First para."), "{text}");
        // Each list item keeps its own line.
        assert!(text.contains("one\ntwo"), "{text}");
    }

    #[test]
    fn html_to_text_decodes_numeric_entities_and_keeps_unicode() {
        let text = html_to_text("<p>&#1587;&#1604;&#1575;&#1605; &#x41; &amp; &#82;ust</p>");
        assert!(text.starts_with("سلام"), "Persian must survive intact: {text}");
        assert!(text.contains("A & Rust"), "{text}");
    }

    #[test]
    fn html_to_text_survives_an_unterminated_script() {
        // A truncated page (the byte cap can cut mid-tag) must not panic or
        // leak half a script into the answer.
        let text = html_to_text("<p>keep</p><script>var a = 1;");
        assert_eq!(text, "keep");
    }

    #[test]
    fn extract_title_reads_the_tag_and_unescapes_it() {
        assert_eq!(
            extract_title("<html><head><title>Rust &amp; Cargo</title></head></html>"),
            "Rust & Cargo"
        );
        // No title at all is not an error.
        assert_eq!(extract_title("<html><body>x</body></html>"), "");
    }

    #[test]
    fn clamp_chars_cuts_on_a_char_boundary() {
        // Byte slicing mid-char would panic on Persian text.
        let s = "سلام دنیا";
        assert_eq!(clamp_chars(s, 4), "سلام");
        assert_eq!(clamp_chars(s, 100), s);
    }

    #[test]
    fn search_answer_inlines_the_fetched_page_and_falls_back_to_the_snippet() {
        let hits = vec![
            json!({"title": "A", "url": "https://a.dev/", "snippet": "snip-a"}),
            json!({"title": "B", "url": "https://b.dev/", "snippet": "snip-b"}),
        ];
        let pages = vec![("https://a.dev/".to_string(), "REAL PAGE A".to_string())];
        let out = search_answer("q", &hits, &pages);
        // The fetched page replaces its snippet...
        assert!(out.contains("[page] REAL PAGE A"), "{out}");
        // ...and the un-fetched hit keeps its snippet.
        assert!(out.contains("[snippet] snip-b"), "{out}");
        assert!(out.contains("https://b.dev/"), "{out}");
    }

    #[test]
    fn source_urls_are_auto_full() {
        // Ported from the Python tool: relying on the model to pass full=true
        // made skill installs come back as a tiny excerpt.
        for url in [
            "https://raw.githubusercontent.com/o/r/main/SKILL.md",
            "https://cdn.jsdelivr.net/npm/x/y.ts?x=1",
            "https://example.com/docs/readme.md",
            "https://example.com/data.json",
        ] {
            assert!(looks_like_source_url(url), "{url} must be treated as a source file");
        }
        for url in ["https://example.com/", "https://news.site/article"] {
            assert!(!looks_like_source_url(url), "{url} must not lift the cap");
        }
    }

    #[tokio::test]
    async fn fetch_page_rejects_a_non_http_url() {
        let client = crate::llm::http_client();
        let err = fetch_page(&client, "file:///etc/passwd", 100, 0)
            .await
            .unwrap_err();
        assert!(err.contains("http://"), "{err}");
    }

    /// One local HTTP server that answers a tiny HTML page, so the fetch path is
    /// exercised on the wire without touching the network. Also proves the
    /// browser UA and the offset paging.
    #[tokio::test]
    async fn fetch_page_reads_html_and_pages_with_offset() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    tx.send(String::from_utf8_lossy(&buf[..n]).to_string()).ok();
                    let body = "<html><head><title>Mock Page</title></head><body>\
<script>noise()</script><h1>Hello</h1><p>This is the mock body text.</p></body></html>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let client = crate::llm::http_client();
        let url = format!("http://{addr}/page");
        let page = fetch_page(&client, &url, 100_000, 0).await.expect("fetch");
        assert_eq!(page.title, "Mock Page");
        assert!(page.content.contains("Hello"), "{}", page.content);
        assert!(!page.content.contains("noise()"), "script survived: {}", page.content);
        assert_eq!(page.url, url);
        // The request carried a browser UA: docs sites 403 an empty agent.
        let seen = rx.recv().await.expect("server saw no request");
        assert!(seen.starts_with("GET /page"), "{seen}");
        assert!(
            seen.to_ascii_lowercase().contains("user-agent: mozilla"),
            "{seen}"
        );
        // `offset` pages past an earlier excerpt instead of re-downloading.
        let all = page.content.chars().count();
        let tail = fetch_page(&client, &url, 100_000, all - 5).await.expect("fetch 2");
        assert_eq!(tail.total_chars, all, "total_chars reports the whole page");
        assert_eq!(tail.content.chars().count(), 5, "{}", tail.content);
    }
}
