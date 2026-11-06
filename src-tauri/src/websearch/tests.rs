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
