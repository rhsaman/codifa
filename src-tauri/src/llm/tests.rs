    use super::*;

    /// A black-holed streaming connection must FAIL AFTER THE HEADER BUDGET,
    /// not park the caller forever: `req.send()` never resolves and reports
    /// no error while TCP keeps retransmitting, and the SSE idle guard only
    /// arms after headers arrive. This test serves the clock — it expects the
    /// header-timeout error string from `stream_with_key`, proving the new
    /// select arm fires; before the fix this request simply hung.
    #[test]
    fn a_stream_that_never_sends_headers_errors_within_the_header_budget() {
        // A server that accepts the connection and then sends NOTHING.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // Accept and hold the socket open, writing never.
            let (_s, _keep) = listener.accept().expect("accept");
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
        let c = cfg("custom", &format!("http://127.0.0.1:{port}"), &["k"]);
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        // Override the budget (env is the production knob): 2s budget against a
        // server that would hold the connection 5s, so only the CLOCK can end it.
        let prev = std::env::var("CODIFA_HEADER_WAIT_SECS").ok();
        std::env::set_var("CODIFA_HEADER_WAIT_SECS", "2");
        let mut silent = |_sig: StreamSignal<'_>| {};
        let mut sink: SignalSink<'_> = &mut silent;
        let started = std::time::Instant::now();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(async {
            stream_chat(
                &http_client(),
                &c,
                &msgs,
                None,
                &mut sink,
                None,
                None,
            )
            .await
            .expect_err("header timeout must produce an error")
        });
        // Drop the IO runtime BEFORE the timing assert: its background workers
        // keep the accept-thread's sockets alive past the scope otherwise.
        rt.shutdown_timeout(std::time::Duration::from_millis(200));
        match prev {
            Some(v) => std::env::set_var("CODIFA_HEADER_WAIT_SECS", v),
            None => std::env::remove_var("CODIFA_HEADER_WAIT_SECS"),
        }
        // The clock, not the 5s hold, released us: under the hold time.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "must fail via the header budget, not after the server hold"
        );
        assert_eq!(err.0, 0);
        assert!(
            err.1.contains("no response headers"),
            "unexpected error: {err:?}"
        );
    }

    fn cfg(provider: &str, base: &str, keys: &[&str]) -> LlmConfig {
        LlmConfig {
            provider: provider.into(),
            headers: Vec::new(),
            provider_id: provider.into(),
            model: "m".into(),
            base_url: base.into(),
            api_keys: keys.iter().map(|s| s.to_string()).collect(),
            temperature: None,
            max_tokens: None,
            timeout_secs: 30,
            reasoning_level: String::new(),
            model_reasoning: false,
            auto_think: false,
        }
    }

    #[test]
    fn header_pairs_reads_both_shapes_and_drops_blank_names() {
        // Array of {key, value} — what the form saves.
        let arr = json!([
            {"key": "x-opencode-client", "value": "cli"},
            {"key": "  ", "value": "ignored"},
            {"key": " x-opencode-session "},
        ]);
        assert_eq!(
            header_pairs(Some(&arr)),
            vec![
                ("x-opencode-client".to_string(), "cli".to_string()),
                // A missing value is an empty one, not a dropped pair.
                ("x-opencode-session".to_string(), String::new()),
            ]
        );
        // Plain object shape.
        assert_eq!(
            header_pairs(Some(&json!({"x-opencode-client": "cli"}))),
            vec![("x-opencode-client".to_string(), "cli".to_string())]
        );
        // JSON TEXT — the shape `GET /models` receives over the query string.
        // It used to fall through to the empty list, so the model list was the
        // one request that never carried the row's headers.
        assert_eq!(
            header_pairs(Some(&json!(
                r#"[{"key":"x-opencode-client","value":"cli"}]"#
            ))),
            vec![("x-opencode-client".to_string(), "cli".to_string())]
        );
        assert!(header_pairs(None).is_empty());
        assert!(header_pairs(Some(&json!("nope"))).is_empty());
    }

    #[test]
    fn custom_headers_reads_the_named_row_only() {
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "zen".to_string(),
            json!({"headers": [{"key": "x-opencode-client", "value": "cli"}]}),
        );
        providers.insert("other".to_string(), json!({"kind": "custom"}));
        assert_eq!(
            custom_headers(&providers, "zen"),
            vec![("x-opencode-client".to_string(), "cli".to_string())]
        );
        // A row without headers, and an unknown id, both yield an empty list.
        assert!(custom_headers(&providers, "other").is_empty());
        assert!(custom_headers(&providers, "missing").is_empty());
    }

    #[test]
    fn has_header_matches_case_insensitively() {
        let h = vec![("authorization".to_string(), "Bearer x".to_string())];
        assert!(has_header(&h, "Authorization"));
        assert!(!has_header(&h, "x-api-key"));
        assert!(!has_header(&[], "Authorization"));
    }

    #[test]
    fn base_normalization_matches_providers_py() {
        assert_eq!(normalize_base("anthropic", "https://api.anthropic.com/v1/"), "https://api.anthropic.com");
        assert_eq!(normalize_base("ollama", "http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("ollama", "http://localhost:11434/v1"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("custom", "https://x.example/v1/"), "https://x.example/v1");
    }

    #[test]
    fn anthropic_body_caches_the_stable_prefix() {
        let mut c = cfg("anthropic", "https://api.anthropic.com", &["k"]);
        c.max_tokens = Some(8192);
        c.temperature = Some(0.5);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["model"], "m");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["stream"], true);
        // The system prompt is promoted to ONE cached text block (a bare string
        // cannot carry a cache marker).
        assert_eq!(body["system"][0]["text"], "SYS");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        // The last message is the prefix the NEXT round-trip resends.
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        // System is lifted out of `messages` and no OpenAI-only key leaks in.
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openai_compatible_body_keeps_tools_and_has_no_cache_control() {
        let c = cfg("custom", "http://localhost:20128/v1", &["k"]);
        let tools = vec![json!({"type": "function", "function": {"name": "grep"}})];
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, Some(&tools));
        // The tool array IS sent on this arm, untouched and unmarked — an
        // OpenAI-compatible gateway caches its own prefix and an unknown field
        // would be rejected.
        assert_eq!(body["tools"][0]["function"]["name"], "grep");
        assert!(body["tools"][0].get("cache_control").is_none());
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert!(!body.to_string().contains("cache_control"));
    }

    #[test]
    fn openai_compatible_body_opts_into_parallel_tool_calls() {
        // MEASURED (trace `mvxsy14e`): 16 of 19 rounds carried ONE call while the
        // model demonstrably could batch (the same turn opened with three 2-call
        // rounds). The prompt rule alone did not hold; the protocol default on
        // many OpenAI-compatible gateways serialises unless told otherwise, and
        // every extra round re-sends the whole conversation.
        let c = cfg("openrouter", "https://openrouter.ai/api/v1", &["k"]);
        let tools = vec![json!({"type": "function", "function": {"name": "grep"}})];
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        let body = build_request_body(&c, &msgs, Some(&tools));
        assert_eq!(body["parallel_tool_calls"], json!(true));
        // OpenRouter's own usage-accounting switch: without it the stream may
        // omit `usage` — and with it the cache-hit numbers the meter reads.
        assert_eq!(body["usage"], json!({"include": true}));

        // Only when tools are actually offered: the flag is meaningless — and an
        // unknown field to a strict gateway — on a call that carries none.
        let no_tools = build_request_body(&c, &msgs, None);
        assert!(no_tools.get("parallel_tool_calls").is_none());
        let empty_tools = build_request_body(&c, &msgs, Some(&[]));
        assert!(empty_tools.get("parallel_tool_calls").is_none());

        // The Anthropic wire format names this differently and rejects unknown
        // top-level fields, so the flag must never leak onto that arm.
        let a = cfg("anthropic", "https://api.anthropic.com", &["k"]);
        let abody = build_request_body(&a, &msgs, Some(&tools));
        assert!(abody.get("parallel_tool_calls").is_none());

        // And a gateway that refuses the field is recognized so the request is
        // retried once without it instead of failing the step.
        assert!(rejects_parallel_tool_calls(400, "unknown field parallel_tool_calls"));
        assert!(!rejects_parallel_tool_calls(400, "context length exceeded"));
        assert!(!rejects_parallel_tool_calls(500, "parallel_tool_calls"));
    }

    #[test]
    fn openai_compatible_body_asks_the_gateway_to_report_stream_usage() {
        let c = cfg("custom", "http://localhost:20128/v1", &["k"]);
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["stream_options"]["include_usage"], true);
        // Token counting is an OpenAI-stream concern only: the Anthropic and
        // Google arms speak their own protocols and must not gain the field.
        for kind in ["anthropic", "google"] {
            let other = build_request_body(&cfg(kind, "https://x.example", &["k"]), &msgs, None);
            assert!(
                other.get("stream_options").is_none(),
                "{kind} must not carry stream_options"
            );
        }
    }

    #[test]
    fn a_rejected_stream_options_field_is_recognized() {
        assert!(rejects_stream_options(400, "unknown field \"stream_options\""));
        assert!(rejects_stream_options(400, "Unexpected property: STREAM_OPTIONS"));
        // Only a rejection OF THAT FIELD is retried: any other 400, and the
        // same text on a transport/server status, is a real failure.
        assert!(!rejects_stream_options(400, "context length exceeded"));
        assert!(!rejects_stream_options(500, "stream_options"));
    }

    #[test]
    fn google_streams_the_openai_shape_with_its_tools() {
        // The native streaming body had no way to declare tools. The system
        // prompt tells the model to call them, so Gemini answered with
        // `MALFORMED_FUNCTION_CALL`; the compat endpoint takes the same
        // messages/tools every other provider gets.
        let mut c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        c.model = "models/gemini-flash-latest".into();
        let tools = vec![json!({
            "type": "function",
            "function": {"name": "grep", "description": "search", "parameters": {"type": "object"}}
        })];
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, Some(&tools));
        // OpenAI-compatible shape, with the bare model id.
        assert_eq!(body["model"], "gemini-flash-latest");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["tools"][0]["function"]["name"], "grep");
        assert_eq!(body["parallel_tool_calls"], json!(true));
        // The native fields would be rejected by the compat endpoint.
        assert!(body.get("contents").is_none());
        assert!(body.get("systemInstruction").is_none());
        assert!(!body.to_string().contains("cache_control"));
    }

    #[test]
    fn google_model_name_strips_the_models_prefix() {
        // Google's own model listing hands out `models/…` ids; saved selections
        // carry them verbatim. The URL builders add `models/` themselves, so the
        // prefix MUST be stripped here — repeated prefixes included.
        assert_eq!(google_model_name("models/gemini-flash-latest"), "gemini-flash-latest");
        assert_eq!(google_model_name("models/models/gemini-2.5-pro"), "gemini-2.5-pro");
        assert_eq!(google_model_name(" gemini-3.5-flash "), "gemini-3.5-flash");
        assert_eq!(google_model_name("/models/gemini-3.5-flash"), "gemini-3.5-flash");
        // Bare ids (the catalog's spelling) pass through untouched.
        assert_eq!(google_model_name("gemini-2.5-flash"), "gemini-2.5-flash");
    }

    #[test]
    fn google_urls_do_not_double_the_models_segment() {
        // The saved id `models/gemini-flash-latest` used to interpolate verbatim
        // into `…/v1beta/models/models/…:generateContent` — a 404 with an EMPTY
        // body, which surfaced as `failed: ` with no reason at all.
        let mut c = cfg("google", "https://generativelanguage.googleapis.com/v1beta/openai", &["k"]);
        c.model = "models/gemini-flash-latest".into();
        let (url, header, _) = endpoint_and_auth(&c, "k");
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"
        );
        assert_eq!(header, "x-goog-api-key");
    }

    #[test]
    fn an_empty_error_body_still_names_the_status() {
        // A Google 404 arrives with zero bytes; the old raw passthrough turned
        // that into an empty error string (`failed: `), hiding the cause.
        assert_eq!(
            nonempty_error_body(404, String::new()),
            "HTTP 404 (empty body)"
        );
        // A body that only carries whitespace is equally silent.
        assert_eq!(
            nonempty_error_body(502, "  \n".into()),
            "HTTP 502 (empty body)"
        );
        // A real body passes through untouched — key-error classification and
        // upstream-down detection read it verbatim.
        assert_eq!(
            nonempty_error_body(429, r#"{"error":{"status":"RESOURCE_EXHAUSTED"}}"#.into()),
            r#"{"error":{"status":"RESOURCE_EXHAUSTED"}}"#
        );
    }

    #[test]
    fn key_error_detection_mirrors_llm_py() {
        assert!(is_key_error(401, ""));
        assert!(is_key_error(429, ""));
        // Python's _is_key_error also matches key-flavored messages on any status.
        assert!(is_key_error(400, "invalid api key"));
        assert!(is_key_error(500, "Invalid API Key provided"));
        assert!(!is_key_error(500, "context overflow"));
    }

    #[test]
    fn extract_openai_completion() {
        let v = json!({
            "choices": [{ "message": { "content": "hello" } }],
            "usage": { "input_tokens": 3, "output_tokens": 5 }
        });
        let r = extract_completion("custom", &v).unwrap();
        assert_eq!(r.text, "hello");
        assert_eq!(r.usage.unwrap()["input_tokens"], 3);
    }

    #[test]
    fn extract_anthropic_completion() {
        let v = json!({
            "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }],
            "usage": { "input_tokens": 1 }
        });
        let r = extract_completion("anthropic", &v).unwrap();
        assert_eq!(r.text, "ab");
    }

    #[test]
    fn a_cloud_kind_without_a_key_is_refused_before_any_network_call() {
        let c = http_client();
        // openrouter needs a credential by definition; the URL is unreachable
        // on purpose — reaching it would mean the refusal fired too late.
        let c0 = cfg("openrouter", "http://127.0.0.1:1", &[]);
        assert!(tokio_test_block(&c, &c0).contains("no api key"));
    }

    /// Serves ONE response and hands the captured request bytes back.
    /// `Connection: close` + no Content-Length: reqwest reads to EOF.
    fn serve_one(response: String) -> (u16, std::sync::mpsc::Receiver<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 16384];
            let n = std::io::Read::read(&mut sock, &mut buf).unwrap_or(0);
            let _ = tx.send(buf[..n].to_vec());
            use std::io::Write as _;
            sock.write_all(response.as_bytes()).ok();
        });
        (port, rx)
    }

    #[test]
    fn a_keyless_local_one_shot_reaches_the_server_without_an_auth_header() {
        let body = r#"{"choices":[{"message":{"content":"local hi"}}]}"#;
        let (port, rx) = serve_one(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
        ));
        let c = cfg("ollama", &format!("http://127.0.0.1:{port}"), &[]);
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { complete(&http_client(), &c, "s", "u").await })
            .expect("a keyless local call must succeed");
        assert_eq!(out.text, "local hi");
        let req = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the request must reach the local server");
        let head = String::from_utf8_lossy(&req).to_lowercase();
        assert!(head.contains("post /v1/chat/completions"), "ollama /v1 path: {head}");
        assert!(!head.contains("authorization"), "no auth header on a keyless call: {head}");
    }

    #[test]
    fn a_keyless_custom_endpoint_attempts_the_call() {
        // The `custom` kind is how every localhost gateway is wired: no keys
        // must still ATTEMPT the request (it did not before — the call died
        // with "no api key configured" before any I/O). A refused connection
        // proves the attempt happened: the error is transport, not keys.
        let c = cfg("custom", "http://127.0.0.1:1", &[]);
        let err = tokio_test_block(&http_client(), &c);
        assert!(!err.contains("no api key"), "{err}");
    }

    #[test]
    fn a_keyless_local_stream_reaches_the_server() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
        let (port, _rx) = serve_one(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{sse}"
        ));
        let c = cfg("ollama", &format!("http://127.0.0.1:{port}"), &[]);
        let msgs = vec![json!({"role": "user", "content": "u"})];
        let mut silent = |_sig: StreamSignal<'_>| {};
        let mut sink: SignalSink<'_> = &mut silent;
        let acc = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                stream_chat(&http_client(), &c, &msgs, None, &mut sink, None, None).await
            })
            .expect("a keyless local stream must run");
        assert_eq!(acc.text, "hi");
    }

    #[test]
    fn sse_frames_end_on_crlf_lf_or_cr() {
        // Google streams CRLF, most OpenAI-compatible gateways stream LF, and
        // the spec also allows bare CR. All three must delimit a frame.
        let crlf = "data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\n\n";
        let (start, end) = sse_frame_end(crlf).expect("CRLF frame");
        assert_eq!(&crlf[..start], "data: {\"a\":1}");
        assert_eq!(&crlf[end..], "data: {\"b\":2}\n\n");

        let lf = "data: {}\n\nrest";
        assert_eq!(sse_frame_end(lf), Some((8, 10)));

        let cr = "data: {}\r\rrest";
        assert_eq!(sse_frame_end(cr), Some((8, 10)));

        // A partial frame (no blank line yet) stays buffered.
        assert_eq!(sse_frame_end("data: {\"candidates\":"), None);
    }

    #[test]
    fn a_google_stream_uses_the_compat_endpoint_and_parses_crlf_frames() {
        // Google's compat SSE may terminate frames with CRLF; the reader used
        // to split on "\n\n" only, so not a single frame was parsed and a
        // healthy answer failed as "returned no content".
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi \"}}]}\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"there\"},",
            "\"finish_reason\":\"stop\"}],",
            "\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\r\n\r\n",
        );
        let (port, rx) = serve_one(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{sse}"
        ));
        let c = cfg("google", &format!("http://127.0.0.1:{port}"), &["k"]);
        let msgs = vec![json!({"role": "user", "content": "u"})];
        let tools = vec![json!({
            "type": "function",
            "function": {"name": "grep", "parameters": {"type": "object"}}
        })];
        let mut silent = |_sig: StreamSignal<'_>| {};
        let mut sink: SignalSink<'_> = &mut silent;
        let acc = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                stream_chat(
                    &http_client(),
                    &c,
                    &msgs,
                    Some(&tools),
                    &mut sink,
                    None,
                    None,
                )
                .await
            })
            .expect("a CRLF Gemini stream must parse");
        assert_eq!(acc.text, "Hi there");
        assert_eq!(acc.finish_reason, "stop");
        assert_eq!(acc.usage.as_ref().unwrap()["completion_tokens"], 2);

        // The call reached the OpenAI-compatible endpoint, tools included —
        // the native endpoint would have silently dropped them.
        let req = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the request must reach the local server");
        let wire = String::from_utf8_lossy(&req);
        let head = wire.to_lowercase();
        assert!(
            head.contains("post /v1beta/openai/chat/completions"),
            "google compat path: {head}"
        );
        assert!(head.contains("authorization: bearer k"), "{head}");
        assert!(wire.contains("\"tools\""), "tools must be declared: {wire}");
        assert!(wire.contains("\"parallel_tool_calls\":true"), "{wire}");
    }

    #[test]
    fn google_compat_tool_calls_keep_their_thought_signature() {
        // Gemini 3 returns a thought signature beside each tool call and
        // REJECTS the next round when the replayed call lacks it (HTTP 400,
        // "Function call is missing a thought_signature"). The accumulator has
        // to carry the object through, not just id/name/arguments.
        let mut acc = StreamAcc::default();
        let mut out: Vec<String> = Vec::new();
        let mut sink = |t: &str| out.push(t.to_string());
        apply_sse_payload(
            "google",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run_terminal","arguments":"{\"command\":"},"extra_content":{"google":{"thought_signature":"sig-1"}}}]}}]}"#,
            &mut acc,
            &mut sink,
        );
        apply_sse_payload(
            "google",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}"#,
            &mut acc,
            &mut sink,
        );
        apply_sse_payload(
            "google",
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            &mut acc,
            &mut sink,
        );
        let call = &acc.tool_calls[0];
        assert_eq!(call["id"], "call_1");
        assert_eq!(call["function"]["name"], "run_terminal");
        assert_eq!(call["function"]["arguments"], "{\"command\":\"ls\"}");
        assert_eq!(call["extra_content"]["google"]["thought_signature"], "sig-1");
        assert_eq!(acc.finish_reason, "tool_calls");
        assert!(out.is_empty());
    }

    #[test]
    fn sse_payloads_accumulate_openai_deltas() {
        let mut acc = StreamAcc::default();
        let mut deltas: Vec<String> = Vec::new();
        let mut sink = |d: &str| deltas.push(d.to_string());
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"he"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"llo"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "read", "arguments": "{\"file"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "Path\":\"a\"}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":2}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.text, "hello");
        assert_eq!(deltas, vec!["he".to_string(), "llo".to_string()]);
        assert_eq!(acc.finish_reason, "tool_calls");
        assert_eq!(acc.tool_calls.len(), 1);
        assert_eq!(acc.tool_calls[0]["function"]["name"], "read");
        assert_eq!(acc.tool_calls[0]["function"]["arguments"].as_str().unwrap(), r#"{"filePath":"a"}"#);
        assert_eq!(acc.usage.clone().unwrap()["input_tokens"], 2);
        // Terminal marker.
        {
            let mut sink = |_: &str| {};
            assert!(apply_sse_payload("custom", "[DONE]", &mut acc, &mut sink));
        }
    }

    #[test]
    fn empty_streamed_name_never_wipes_a_good_one() {
        // Some providers send the tool NAME in the first delta and then
        // `"name":""` on every later delta. The accumulator used to overwrite
        // blindly, erasing the good name: the call then reached the dispatch
        // guard as `unknown tool ""` and burned a whole round-trip.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"grep","arguments":"{\"pat"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        // Args-only delta: no `name` key at all — must keep the good name.
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\":\"x\"}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        // Explicit empty name — must STILL keep the good name.
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":""}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.tool_calls[0]["function"]["name"], "grep");
        assert_eq!(
            acc.tool_calls[0]["function"]["arguments"].as_str().unwrap(),
            r#"{"pattern":"x"}"#
        );
    }

    #[test]
    fn a_billing_refusal_streamed_as_content_is_latched_before_any_text() {
        // Pollinations streams the refusal as one ordinary content delta. It
        // must be latched as the stream's error BEFORE `on_delta`, otherwise
        // every retry appends the billing message to the chat.
        let refusal = "The account behind this API key doesn't have enough credits. \
                       Please top up or complete a quest, then try again.";
        let payload = json!({
            "choices": [{"delta": {"content": refusal}, "finish_reason": null}]
        })
        .to_string();
        let mut acc = StreamAcc::default();
        let mut deltas: Vec<String> = Vec::new();
        let mut sink = |t: &str| deltas.push(t.to_string());
        assert!(apply_sse_payload("custom", &payload, &mut acc, &mut sink));
        assert!(acc.text.is_empty(), "refusal must not become assistant text");
        assert!(deltas.is_empty(), "refusal must not be forwarded to the UI");
        assert!(
            acc.error.as_deref().unwrap_or_default().contains("enough credits"),
            "{:?}",
            acc.error
        );
    }

    #[test]
    fn sse_payloads_accumulate_anthropic_deltas() {
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_start","message":{"usage":{"input_tokens":7}}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.text, "hi");
        assert_eq!(acc.finish_reason, "end_turn");
        let usage = acc.usage.unwrap();
        assert_eq!(usage["input_tokens"], 7);
        assert_eq!(usage["output_tokens"], 3);
    }

    #[test]
    fn missing_index_opens_new_slots_and_slots_are_well_formed() {
        // A provider that omits `index` used to fold EVERY streamed call into
        // slot 0 (the `unwrap_or(0)`), leaving the following calls nameless —
        // which the dispatch guard reported as `unknown tool ""`. Each
        // id/name-bearing delta must open its own slot instead.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read","arguments":"{}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"c2","function":{"name":"grep","arguments":"{}"}}]}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.tool_calls.len(), 2);
        assert_eq!(acc.tool_calls[0]["function"]["name"], "read");
        assert_eq!(acc.tool_calls[1]["function"]["name"], "grep");

        // A slot created by an out-of-order index is structurally complete
        // (`function.name`/`arguments` exist), never a bare `{}` — so a reader
        // can never hit `unknown tool ""` from a missing key.
        let mut acc2 = StreamAcc::default();
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"glob","arguments":"{}"}}]}}]}"#,
            &mut acc2,
            &mut sink
        ));
        assert_eq!(acc2.tool_calls.len(), 3);
        assert!(acc2.tool_calls[0]["function"]["name"].is_string());
        assert!(acc2.tool_calls[1]["function"]["name"].is_string());
        assert_eq!(acc2.tool_calls[2]["function"]["name"], "glob");
    }

    #[test]
    fn reasoning_effort_follows_the_merge_and_keeps_every_named_token() {
        // The UI exposes ONE top option (stored as `xhigh`); a legacy stored
        // `max` must produce the EXACT same token for every kind — otherwise
        // the same visible "Max" level sends different requests.
        for kind in ["openrouter", "nvidia", "cloudflare", "custom", "ollama", "openai"] {
            assert_eq!(
                reasoning_effort_for_kind(kind, "xhigh"),
                reasoning_effort_for_kind(kind, "max"),
                "xhigh and max must map identically for kind {kind}"
            );
        }
        // A level only reaches this mapping when a source enumerated it for the
        // model, so the token travels unchanged — collapsing `xhigh` to `high`
        // sent a token such a gateway rejects.
        for kind in ["openrouter", "nvidia", "cloudflare", "custom"] {
            assert_eq!(reasoning_effort_for_kind(kind, "xhigh"), Some("xhigh"));
        }
        assert_eq!(reasoning_effort_for_kind("custom", "medium"), Some("medium"));
        // Budget providers carry no effort token at all.
        assert_eq!(reasoning_effort_for_kind("anthropic", "xhigh"), None);
        assert_eq!(reasoning_effort_for_kind("google", "max"), None);
        assert_eq!(reasoning_effort_for_kind("custom", "none"), None);
        // Budgets for the two spellings are identical too.
        assert_eq!(thinking_budget_for("xhigh"), thinking_budget_for("max"));
    }

    #[test]
    fn reasoning_deltas_are_measured_not_streamed() {
        // A reasoning model emits its "thinking" tokens before the answer does.
        // They must NOT be forwarded as visible text (that is what crawled the
        // UI), but their ARRIVAL has to be observable — otherwise the pill can
        // only ever say "Working" while the model is plainly thinking.
        let mut acc = StreamAcc::default();
        let mut streamed: Vec<String> = Vec::new();
        {
            let mut sink = |d: &str| streamed.push(d.to_string());
            // OpenRouter / DeepSeek family name it `reasoning`.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"reasoning":"let me think"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, "let me think".len());
            // Several gateways use `reasoning_content`.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"reasoning_content":"more"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, "let me thinkmore".len());
            // The real answer still streams normally.
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"content":"done"}}]}"#,
                &mut acc,
                &mut sink
            ));
            // A payload with neither (usage / role) must not change the count,
            // so the pill cannot be flickered off by them.
            let before = acc.reasoning_len;
            assert!(!apply_sse_payload(
                "custom",
                r#"{"choices":[{"delta":{"role":"assistant"}}]}"#,
                &mut acc,
                &mut sink
            ));
            assert_eq!(acc.reasoning_len, before);
        }
        assert_eq!(acc.text, "done");
        assert_eq!(acc.reasoning_len, "let me thinkmore".len());
        // Nothing but the real answer ever reached the delta sink: reasoning is
        // measured for the pill, never rendered as visible text.
        assert_eq!(streamed, vec!["done".to_string()]);
    }

    #[test]
    fn anthropic_thinking_deltas_are_measured_not_streamed() {
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(acc.reasoning_len, 3);
        assert!(acc.text.is_empty());
    }

    #[test]
    fn a_stream_error_frame_on_a_200_is_a_real_error() {
        // A gateway can answer 200 and report the failure INSIDE the stream. The
        // parser only ever read `choices`, so that frame was ignored outright and
        // the turn finished as a silent success with an empty bubble — exactly
        // what a model that cannot serve the request looked like.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(apply_sse_payload(
            "nvidia",
            r#"{"error":{"message":"Upstream request failed: Endpoint is unavailable."}}"#,
            &mut acc,
            &mut sink
        ));
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("Upstream request failed"), "{err}");
        // The class matters end to end: a dead endpoint is a MODEL-side
        // rejection, so the next configured model takes the call instead of the
        // same one being retried, and no key is blamed for it.
        assert!(should_fall_back(&err));
        assert!(!is_key_error(0, &err));

        // FastAPI-shaped error bodies name the reason in `detail`.
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "custom",
            r#"{"detail":"no available endpoint"}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(
            finish_stream("custom", acc).unwrap_err().1,
            "custom reported an error mid-stream: no available endpoint"
        );
    }

    #[test]
    fn provider_error_shapes_are_recognized_without_naming_the_provider() {
        // Every provider words a failure differently, so the guard keys on the
        // SHAPE, never on the provider name — the same call has to work for a
        // gateway added tomorrow.
        for provider in [
            "nvidia",
            "openrouter",
            "cloudflare",
            "custom",
            "ollama",
            "anthropic",
            "google",
        ] {
            let mut acc = StreamAcc::default();
            let mut sink = |_: &str| {};
            assert!(
                apply_sse_payload(
                    provider,
                    r#"{"error":{"message":"boom"}}"#,
                    &mut acc,
                    &mut sink
                ),
                "{provider} missed an OpenAI-shaped error frame"
            );
            let err = finish_stream(provider, acc).unwrap_err().1;
            assert!(err.contains("boom"), "{err}");
        }

        // Anthropic reports a mid-stream failure with no `error` object at all.
        let mut acc = StreamAcc::default();
        let mut sink = |_: &str| {};
        assert!(apply_sse_payload(
            "anthropic",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(finish_stream("anthropic", acc)
            .unwrap_err()
            .1
            .contains("Overloaded"));
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "anthropic",
            r#"{"type":"error","message":"Overloaded"}"#,
            &mut acc,
            &mut sink
        ));
        assert!(finish_stream("anthropic", acc)
            .unwrap_err()
            .1
            .contains("Overloaded"));

        // Google sends no message at all: the status/code pair is the reason.
        let mut acc = StreamAcc::default();
        assert!(apply_sse_payload(
            "google",
            r#"{"error":{"code":400,"status":"INVALID_ARGUMENT"}}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(
            finish_stream("google", acc).unwrap_err().1,
            "google reported an error mid-stream: INVALID_ARGUMENT (code 400)"
        );

        // The one-shot path (title, compact, model test) reads the same shapes.
        assert!(extract_completion(
            "google",
            &json!({"error": {"code": 403, "status": "PERMISSION_DENIED"}})
        )
        .err()
        .unwrap()
        .1
        .contains("PERMISSION_DENIED"));
        assert_eq!(
            extract_completion(
                "anthropic",
                &json!({"type": "error", "message": "Overloaded"})
            )
            .err()
            .unwrap()
            .1,
            "Overloaded"
        );

        // HEALTHY frames of every provider shape keep flowing as text, and a
        // `null` error key (several APIs always send it) is not a failure: a
        // false positive here would kill a working turn.
        let mut acc = StreamAcc::default();
        let mut out = String::new();
        let mut sink = |t: &str| out.push_str(t);
        assert!(!apply_sse_payload(
            "custom",
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "anthropic",
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "google",
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert!(!apply_sse_payload(
            "custom",
            r#"{"error":null,"choices":[{"delta":{"content":"!"}}]}"#,
            &mut acc,
            &mut sink
        ));
        assert_eq!(out, "hihihi!");
        assert!(finish_stream("custom", acc).is_ok());
    }

    #[test]
    fn a_stream_with_no_output_is_not_a_silent_success() {
        let mut acc = StreamAcc::default();
        acc.finish_reason = "stop".into();
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("returned no content"), "{err}");
        assert!(err.contains("'stop'"), "{err}");
        assert!(should_fall_back(&err));

        // Reasoning that never reached an answer: same verdict, and the hint
        // says where the budget went.
        let mut acc = StreamAcc::default();
        acc.reasoning_len = 42;
        let err = finish_stream("nvidia", acc).unwrap_err().1;
        assert!(err.contains("streaming reasoning"), "{err}");

        // Whitespace-only output is an empty answer, not content.
        let mut acc = StreamAcc::default();
        acc.text = "\n".into();
        assert!(finish_stream("nvidia", acc).is_err());

        // Real output — text or a tool call — stays a success.
        let mut acc = StreamAcc::default();
        acc.text = "hi".into();
        assert!(finish_stream("nvidia", acc).is_ok());
        let mut acc = StreamAcc::default();
        acc.tool_calls
            .push(json!({"function": {"name": "read", "arguments": "{}"}}));
        assert!(finish_stream("nvidia", acc).is_ok());

        // A mid-turn steer ended the request on purpose: the agent re-issues the
        // step, so an empty accumulator is the expected outcome.
        let mut acc = StreamAcc::default();
        acc.interrupted = true;
        assert!(finish_stream("nvidia", acc).is_ok());
    }

    #[test]
    fn a_one_shot_error_body_reports_its_reason() {
        // 200 + `{"error": …}` on the non-streaming path used to come back as an
        // empty text SUCCESS, so every caller (title, compact, model test) showed
        // a blank result instead of the provider's own message.
        let v = json!({"error": {"message": "quota exhausted", "type": "insufficient_quota"}});
        assert_eq!(
            extract_completion("custom", &v).err().unwrap().1,
            "quota exhausted"
        );
        let v = json!({"detail": "no available endpoint"});
        assert_eq!(
            extract_completion("custom", &v).err().unwrap().1,
            "no available endpoint"
        );
        // A healthy response is untouched.
        let v = json!({"choices": [{"message": {"content": "ok"}}]});
        assert_eq!(extract_completion("custom", &v).unwrap().text, "ok");
    }

    #[test]
    fn a_billing_refusal_delivered_as_content_is_an_error_not_a_reply() {
        // Pollinations answers 200 and puts the refusal in message.content with
        // usage all zeros. The model test used to tick on this because it only
        // checked "non-empty", while every real turn showed the refusal as the
        // assistant's answer.
        let refusal = "The account behind this API key doesn't have enough credits. \
                       Please top up or complete a quest, then try again.";
        let v = json!({
            "choices": [{"message": {"role": "assistant", "content": refusal}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        });
        assert_eq!(extract_completion("custom", &v).err().unwrap().1, refusal);

        // The same wording WITH real usage is a model discussing billing, not a
        // refusal — it must stay a normal answer.
        let v = json!({
            "choices": [{"message": {"role": "assistant", "content": refusal}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}
        });
        assert!(extract_completion("custom", &v).is_ok());

        // A normal zero-usage reply is still accepted.
        let v = json!({
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        });
        assert_eq!(extract_completion("custom", &v).unwrap().text, "OK");

        // Streaming path: the same refusal must fail the turn instead of
        // "succeeding" with the refusal stored as the answer.
        let mut acc = StreamAcc::default();
        acc.text = refusal.to_string();
        acc.usage = Some(json!({"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}));
        let err = finish_stream("custom", acc).unwrap_err().1;
        assert!(err.contains("refused the request"), "{err}");
    }

    #[test]
    fn interrupt_signal_wakes_a_parked_waiter_and_stamps_generations() {
        // Mid-turn steer: the stream read loop selects on this signal, so a raise
        // must wake a waiter that is ALREADY parked (a lost wakeup would put the
        // steer back to "waits for the whole model reply" — the reported bug).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let sig = InterruptSignal::new();
            let base = sig.generation();
            assert!(!sig.interrupted_since(base));
            let waiter = async {
                sig.wait_for(base).await;
                true
            };
            let raiser = async {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                sig.raise();
            };
            let (woke, _) = tokio::join!(waiter, raiser);
            assert!(woke, "a parked waiter must be woken by raise()");
            assert!(sig.interrupted_since(base));
        });
    }

    #[test]
    fn a_raise_from_an_earlier_window_never_cancels_a_new_request() {
        // The bug behind "sometimes the steer works, sometimes it waits": a raise
        // that landed while NO stream was parked used to leak into the next
        // request (or be wiped by reset()). The generation stamp makes each
        // stream see only raises that happened AFTER it started.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let sig = InterruptSignal::new();
            // A steer lands while the agent is between model calls.
            sig.raise();
            // The NEXT request starts: it stamps the current generation, so that
            // older raise is NOT its own — it must not be interrupted.
            let base = sig.generation();
            assert!(!sig.interrupted_since(base));
            // A second steer lands while this request is live: that one IS its
            // own and must fire immediately.
            sig.raise();
            assert!(sig.interrupted_since(base));
            // wait_for resolves without parking (counter already ahead).
            let gen = sig.wait_for(base).await;
            assert_eq!(gen, base + 1);
        });
    }

    fn tokio_test_block(client: &Client, c: &LlmConfig) -> String {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { complete(client, c, "s", "u").await.err().unwrap() })
    }

    /// A tiny valid inline image: the mime prefix is what the per-provider
    /// translation switches on, the payload is opaque.
    const PNG_URL: &str = "data:image/png;base64,AAAA";

    #[test]
    fn anthropic_thinking_budget_distinguishes_every_level() {
        // Every slider step must change the wire request. The old flat
        // `budget.min(2048)` collapsed Low..Max onto the same body, so the
        // slider was cosmetic on Anthropic.
        let low = anthropic_budget_for("low").unwrap();
        let medium = anthropic_budget_for("medium").unwrap();
        let high = anthropic_budget_for("high").unwrap();
        let top = anthropic_budget_for("xhigh").unwrap();
        assert!(
            low < medium && medium < high && high < top,
            "budgets must grow with the level: {low} {medium} {high} {top}"
        );
        // `max` is an exact alias of `xhigh` — one UI option, one request.
        assert_eq!(anthropic_budget_for("max"), Some(top));
        assert_eq!(anthropic_budget_for("none"), None);
        assert_eq!(anthropic_budget_for(""), None);
    }

    #[test]
    fn anthropic_body_carries_the_budget_and_raises_max_tokens() {
        let mut c = cfg("anthropic", "https://api.anthropic.com", &["k"]);
        c.model_reasoning = true;
        c.reasoning_level = "high".into();
        c.max_tokens = Some(4096);
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        let body = build_request_body(&c, &msgs, None);
        let budget = anthropic_budget_for("high").unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], budget);
        // Anthropic rejects the call unless max_tokens > budget_tokens, so the
        // cap must be RAISED to fit the budget instead of the budget lowered.
        assert!(
            body["max_tokens"].as_u64().unwrap() > budget as u64,
            "max_tokens must exceed the thinking budget: {body}"
        );
    }

    #[test]
    fn reasoning_is_gated_by_the_model_capability_flag() {
        let msgs = vec![json!({"role": "user", "content": "hi"})];
        // A level alone is not enough: a model that is not flagged
        // reasoning-capable gets NO parameter (the same gate the Python
        // sidecar had).
        let mut c = cfg("custom", "https://x.example/v1", &["k"]);
        c.reasoning_level = "high".into();
        assert!(build_request_body(&c, &msgs, None)
            .get("reasoning_effort")
            .is_none());
        c.model_reasoning = true;
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "high");
        // A level only reaches this mapping when a source enumerated it for the
        // model, so the top level travels verbatim on every kind.
        c.reasoning_level = "xhigh".into();
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "xhigh");
        // A legacy stored `max` is the same option and sends the same token.
        c.reasoning_level = "max".into();
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "xhigh");
        // Gateways that FORWARD the effort string keep it verbatim.
        let mut g = cfg("openrouter", "https://openrouter.ai/api/v1", &["k"]);
        g.auto_think = true;
        g.reasoning_level = "xhigh".into();
        assert_eq!(build_request_body(&g, &msgs, None)["reasoning_effort"], "xhigh");
        // None / empty send nothing at all.
        g.reasoning_level = "none".into();
        assert!(build_request_body(&g, &msgs, None)
            .get("reasoning_effort")
            .is_none());
        g.reasoning_level = String::new();
        assert!(build_request_body(&g, &msgs, None)
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn google_streams_reasoning_effort_but_the_native_one_shot_keeps_its_budget() {
        let mut c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        c.model_reasoning = true;
        c.reasoning_level = "medium".into();
        let msgs = vec![json!({"role": "user", "content": "hi"})];

        // Streaming chat: the compat endpoint REJECTS `generationConfig`
        // outright, so the standard effort token must be sent instead.
        let stream = build_request_body(&c, &msgs, None);
        assert_eq!(stream["reasoning_effort"], "medium");
        assert!(stream.get("generationConfig").is_none());

        // Its top level has no `xhigh` on the wire; it folds onto `high`.
        c.reasoning_level = "xhigh".into();
        assert_eq!(build_request_body(&c, &msgs, None)["reasoning_effort"], "high");

        // One-shot title/compact/vision calls keep the NATIVE body, where the
        // token budget is the correct field (and `reasoning_effort` is not).
        c.reasoning_level = "medium".into();
        let one_shot = one_shot_body(&c, "SYS", "hi", &[]);
        assert_eq!(
            one_shot["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            thinking_budget_for("medium").unwrap()
        );
        assert!(one_shot.get("reasoning_effort").is_none());
    }

    #[test]
    fn an_image_block_renders_in_each_provider_shape() {
        // The agent emits ONE neutral block shape; the three endpoints each get
        // their own wire shape from here.
        let blocks = json!([
            { "type": "text", "text": "what is this" },
            { "type": IMAGE_BLOCK_TYPE, "data_url": PNG_URL },
        ]);
        // OpenAI-compatible: the data URL rides verbatim.
        let openai = map_content("custom", &blocks);
        assert_eq!(openai[1]["type"], "image_url");
        assert_eq!(openai[1]["image_url"]["url"], PNG_URL);
        // Anthropic: raw base64 plus a media type, never a data URL.
        let anthropic = map_content("anthropic", &blocks);
        assert_eq!(anthropic[1]["type"], "image");
        assert_eq!(anthropic[1]["source"]["type"], "base64");
        assert_eq!(anthropic[1]["source"]["media_type"], "image/png");
        assert_eq!(anthropic[1]["source"]["data"], "AAAA");
        // Gemini: inlineData.
        let google = map_content("google", &blocks);
        assert_eq!(google[1]["inlineData"]["mimeType"], "image/png");
        assert_eq!(google[1]["inlineData"]["data"], "AAAA");
        // A malformed / truncated data URL is DROPPED (the turn's text still
        // gets through) instead of poisoning the whole request with a 400.
        for bad in ["data:image/png;base64,", "data:;base64,AAAA", "not-an-image"] {
            let blocks = json!([{ "type": IMAGE_BLOCK_TYPE, "data_url": bad }]);
            assert!(
                map_content("custom", &blocks).as_array().unwrap().is_empty(),
                "a malformed data URL must be dropped, got {bad}"
            );
        }
    }

    #[test]
    fn a_text_only_turn_keeps_the_plain_string_content_shape() {
        // Regression guard: the multimodal translation must not touch a
        // text-only conversation — every provider path is byte-compared.
        let c = cfg("custom", "https://x.example/v1", &["k"]);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["messages"][1]["content"], "hi");
    }

    #[test]
    fn google_stream_images_use_the_openai_image_url_shape() {
        // A Google chat image rides the compat message shape, NOT the native
        // `inlineData` part — sending that would be an unknown content block.
        // The native shape still serves the one-shot vision it is built for.
        let c = cfg("google", "https://generativelanguage.googleapis.com", &["k"]);
        let msgs = vec![
            json!({"role": "system", "content": "SYS"}),
            json!({"role": "user", "content": [
                { "type": "text", "text": "describe" },
                { "type": IMAGE_BLOCK_TYPE, "data_url": PNG_URL },
            ]}),
        ];
        let body = build_request_body(&c, &msgs, None);
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["content"][1]["type"], "image_url");
        assert_eq!(
            body["messages"][1]["content"][1]["image_url"]["url"],
            PNG_URL
        );
        assert!(body.get("contents").is_none());

        let one_shot = one_shot_body(&c, "SYS", "describe", &[PNG_URL.into()]);
        assert_eq!(one_shot["contents"][0]["parts"][1]["inlineData"]["data"], "AAAA");
        assert_eq!(one_shot["systemInstruction"]["parts"][0]["text"], "SYS");
    }

    /// A dead upstream endpoint must not be mistaken for a key problem: the key
    /// loop would spend every configured key on the same doomed call.
    #[test]
    fn an_unavailable_endpoint_is_not_a_key_error() {
        assert!(!is_key_error(
            429,
            "{\"error\":{\"message\":\"Upstream request failed: Endpoint is \
             unavailable.\"}}"
        ));
        // A genuine rate limit still tries the next key: another key has its own
        // quota.
        assert!(is_key_error(429, "429 Too Many Requests"));
    }

    /// A key the provider refused sits out the cooldown: it moves to the BACK
    /// of the ladder so live keys are tried first, and a success clears the
    /// mark at once (the quota may come back before the window ends). The
    /// registry is process-global and the suite runs in parallel, so every
    /// test uses its own key strings.
    #[test]
    fn a_rejected_key_sits_out_the_cooldown_then_rejoins() {
        let hot = "cooldown-test-hot-key".to_string();
        let spare = "cooldown-test-spare-key".to_string();
        let keys = vec![hot.clone(), spare.clone()];

        mark_key_dead(&hot);
        // The cold key is still attempted — as the last rung, not the first.
        assert_eq!(key_attempt_order(&keys), vec![spare.clone(), hot.clone()]);

        mark_key_ok(&hot);
        assert_eq!(key_attempt_order(&keys), keys.clone());
    }

    /// An EXPIRED cooldown must look exactly like a never-marked key: the
    /// window is a plain Instant comparison, so a deadline in the past drops
    /// out of the ordering without any explicit sweep.
    #[test]
    fn an_expired_cooldown_returns_the_key_to_the_front() {
        let hot = "cooldown-test-expired-key".to_string();
        let spare = "cooldown-test-expired-spare".to_string();
        let keys = vec![hot.clone(), spare.clone()];

        cooldown_lock().insert(hot.clone(), Instant::now() - Duration::from_secs(1));
        assert_eq!(key_attempt_order(&keys), keys.clone());
    }

    /// When EVERY key is cooling the request must not get a shorter ladder
    /// than before: all keys run in the original order, so a momentary 429 on
    /// the first key cannot turn into "no key tried at all".
    #[test]
    fn when_every_key_is_cooling_the_original_order_runs() {
        let a = "cooldown-test-all-a".to_string();
        let b = "cooldown-test-all-b".to_string();
        let keys = vec![a.clone(), b.clone()];

        mark_key_dead(&a);
        mark_key_dead(&b);
        assert_eq!(key_attempt_order(&keys), keys.clone());
    }

    /// The fallback rule: ONLY a model that cannot serve us may be replaced.
    #[test]
    fn fallback_only_for_a_model_side_rejection() {
        // A refused key/account or a model the provider does not serve: another
        // model can work, so the next fallback must be tried.
        assert!(should_fall_back(
            "key rejected (401): {\"error\":{\"message\":\"Invalid API key\"}}"
        ));
        assert!(should_fall_back("key rejected (403): forbidden"));
        assert!(should_fall_back("no api key configured"));
        assert!(should_fall_back("model `gpt-x` not found"));
        // A model that answers with nothing usable is not working either.
        assert!(should_fall_back("the model returned an empty description"));
        assert!(should_fall_back("returned an empty summary"));
        // A stream that ended with no output, and a gateway error carried INSIDE
        // a 200 stream: both name a model that cannot serve the request.
        assert!(should_fall_back(
            "nvidia returned no content — the stream finished with 'stop'"
        ));
        assert!(should_fall_back(
            "nvidia reported an error mid-stream: \"Upstream request failed: Endpoint is \
             unavailable.\""
        ));

        // Everything else stays on the SAME model: another model cannot fix the
        // network, and spending the whole list on one hiccup hides the reason.
        assert!(!should_fall_back("provider sent no response within 90s"));
        assert!(!should_fall_back(
            "error sending request for url (http://x/v1/chat/completions): \
             error trying to connect: tcp connect error: Connection refused (os error 61)"
        ));
        assert!(!should_fall_back("provider stream sent no data for 60s"));
        assert!(!should_fall_back("aborted by user"));
        assert!(!should_fall_back("429 Too Many Requests"));
        // The real one from the field: a gateway answers 429 for an upstream
        // failure. The status says "rate limit", the body says the model's
        // endpoint is gone — the body wins, because retrying that model cannot
        // help and the user's fallbacks sat unused.
        assert!(should_fall_back(
            "{\"error\":{\"message\":\"[429]: Upstream request failed: \
             Endpoint is unavailable.\",\"code\":\"rate_limit_exceeded\"}}"
        ));
        // The SAME gateway failure carried on a 503, in the exact shape the
        // renderer shows it (observed in the field): `[503]` plus
        // `service_unavailable` reads like a provider hiccup, but the body names
        // the model's dead upstream endpoint, so the next fallback must take the
        // call instead of retrying a model that cannot serve it.
        assert!(should_fall_back(
            r#"explore failed: {"error":{"message":"[503]: {\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}","type":"server_error","code":"service_unavailable"}}"#
        ));
        // A router with no live backend for the model (the user's banner:
        // `explore failed: No ready deployment`) cannot serve it either: the next
        // fallback takes the call instead of the same dead model being retried.
        assert!(should_fall_back("explore failed: No ready deployment"));
        assert!(should_fall_back(
            "{\"error\":{\"message\":\"No deployments available for selected model\"}}"
        ));
        // A BARE 5xx with no such body is the provider breaking, not the model:
        // it keeps the SAME model and retries it.
        assert!(!should_fall_back("503 Service Unavailable"));
        assert!(!should_fall_back(
            "{\"error\":{\"message\":\"Internal server error\"}}"
        ));
        // A 5xx key rejection is the PROVIDER breaking, not the model.
        assert!(!should_fall_back("key rejected (500): upstream exploded"));
        assert!(!should_fall_back(""));
    }

    /// The user's banner: `Compact failed — every summarizer model failed —
    /// oc/deepseek-v4.1-flash-free: key rejected (429): {"error":{"message":"[429]:
    /// {\"type\":\"FreeUsageLimitError\",\"message\":\"Free usage limit reached.
    /// Subscribe to OpenCode Go to keep going\"}","code":"rate_limit_exceeded"}}`
    ///
    /// The status says "rate limit" and the gateway appends
    /// `rate_limit_exceeded`, so the plain rate-limit gate read it as a
    /// temporary hiccup — but the body says the account's allowance for THAT
    /// model is gone. No number of repeats brings it back, while the next
    /// configured model may live on a different account entirely, so this must
    /// hand the call on. The chat model was the only model ever tried.
    #[test]
    fn an_exhausted_allowance_moves_to_the_next_model_despite_the_429() {
        assert!(should_fall_back(
            r#"key rejected (429): {"error":{"message":"[429]: {\"type\":\"FreeUsageLimitError\",\"message\":\"Free usage limit reached. Subscribe to OpenCode Go to keep going\"}","code":"rate_limit_exceeded"}}"#
        ));
        // The OpenAI-shaped wording of the same verdict, and the plain quota
        // body a 429 often carries.
        assert!(should_fall_back(
            "{\"error\":{\"message\":\"You exceeded your current quota\",\"code\":\"insufficient_quota\"}}"
        ));
        assert!(should_fall_back("insufficient_quota"));
        // A genuine rate limit is still NOT a fallback: waiting fixes it, and
        // another model cannot clear it. The route/anthropic wording has no
        // quota signal in it, so it must keep the same model.
        assert!(!should_fall_back("key rejected (429): Rate limit reached for gpt-x"));
        assert!(!should_fall_back("key rejected (429): too many requests"));
    }

    // ------------------------------------------------------------------
    // NormalizedUsage: provider usage by PAYLOAD SHAPE, not provider name
    // ------------------------------------------------------------------

    #[test]
    fn an_anthropic_payload_is_additive_and_includes_the_write() {
        // Raw Anthropic usage: input EXCLUDES the cache fields. The inclusive
        // billed input is input + read + write — the plan's own fixture
        // (2_000 + 18_000 + 1_000 = 21_000) is what the compaction trigger
        // must compare against MAIN_FOLD_MIN_TOKENS.
        let u = NormalizedUsage::from_payload(&json!({
            "input_tokens": 2_000u64,
            "output_tokens": 150u64,
            "cache_read_input_tokens": 18_000u64,
            "cache_creation_input_tokens": 1_000u64,
        }))
        .unwrap();
        assert_eq!(u.input_total, 21_000);
        assert_eq!(u.output_tokens, 150);
        assert_eq!(u.cache_read, 18_000);
        assert_eq!(u.cache_write, 1_000);
        assert!(u.cache_read_reported && u.cache_write_reported);
        assert_eq!(u.reported_input, 2_000, "the raw figure stays available");
    }

    #[test]
    fn an_anthropic_compatible_gateway_is_caught_by_shape_not_name() {
        // A custom endpoint speaking Anthropic's wire format: the normalizer
        // never sees a provider name — the cache field names ARE the shape.
        let u = NormalizedUsage::from_payload(&json!({
            "input_tokens": 900u64,
            "output_tokens": 40u64,
            "cache_read_input_tokens": 12_000u64,
        }))
        .unwrap();
        assert_eq!(u.input_total, 12_900);
        assert_eq!(u.cache_read, 12_000);
        assert!(u.cache_read_reported);
        assert!(!u.cache_write_reported, "write absent stays not-reported");
        assert_eq!(u.cache_write, 0);
    }

    #[test]
    fn openai_style_subset_payloads_never_double_count() {
        // prompt_tokens already covers the cached part: input_total is the
        // reported input itself, and read is a SLICE of it, never added on.
        let u = NormalizedUsage::from_payload(&json!({
            "prompt_tokens": 21_000u64,
            "completion_tokens": 88u64,
            "prompt_tokens_details": { "cached_tokens": 18_000u64 },
        }))
        .unwrap();
        assert_eq!(u.input_total, 21_000, "subset: the reported input IS the total");
        assert_eq!(u.cache_read, 18_000);
        assert_eq!(u.cache_write, 0);
        assert!(u.cache_read_reported);
        assert!(!u.cache_write_reported);
    }

    #[test]
    fn deepseek_and_google_vocabularies_map_to_the_subset_shape() {
        let ds = NormalizedUsage::from_payload(&json!({
            "prompt_tokens": 21_000u64,
            "prompt_cache_hit_tokens": 18_000u64,
            "completion_tokens": 10u64,
        }))
        .unwrap();
        assert_eq!(ds.input_total, 21_000);
        assert_eq!(ds.cache_read, 18_000);
        let g = NormalizedUsage::from_payload(&json!({
            "promptTokenCount": 21_000u64,
            "candidatesTokenCount": 10u64,
            "cachedContentTokenCount": 18_000u64,
        }))
        .unwrap();
        assert_eq!(g.input_total, 21_000);
        assert_eq!(g.cache_read, 18_000);
        assert_eq!(g.output_tokens, 10);
    }

    #[test]
    fn unknown_cache_state_stays_unknown_and_zero_stays_zero() {
        // A gateway that reports no cache field at all: NOT reported — a
        // ruler must print "not reported", never a fabricated 0% hit rate.
        let none = NormalizedUsage::from_payload(&json!({
            "prompt_tokens": 5_000u64, "completion_tokens": 7u64,
        }))
        .unwrap();
        assert_eq!(none.cache_read, 0);
        assert!(!none.cache_read_reported);
        // A REAL zero (the cache genuinely missed) is distinguishable.
        let zero = NormalizedUsage::from_payload(&json!({
            "prompt_tokens": 5_000u64,
            "completion_tokens": 7u64,
            "prompt_tokens_details": { "cached_tokens": 0u64 },
        }))
        .unwrap();
        assert_eq!(zero.cache_read, 0);
        assert!(zero.cache_read_reported, "reported 0 stays a real zero");
        // No recognizable input field: not a usage payload at all.
        assert!(NormalizedUsage::from_payload(&json!({ "foo": 1 })).is_none());
        assert!(NormalizedUsage::from_payload(&Value::Null).is_none());
    }

    /// Every sanitized usage fixture under tests/fixtures/usage — the five
    /// provider shapes the plan pinned, hand-calculated expectations each.
    fn usage_fixtures() -> Vec<(String, Value)> {
        let dir = format!("{}/tests/fixtures/usage", env!("CARGO_MANIFEST_DIR"));
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("usage fixtures dir") {
            let p = entry.unwrap().path();
            if p.extension().is_some_and(|e| e == "json") {
                let text = std::fs::read_to_string(&p).unwrap();
                out.push((p.file_name().unwrap().to_string_lossy().to_string(),
                          serde_json::from_str(&text).unwrap()));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn the_usage_fixtures_match_hand_calculated_values() {
        let expected: &[(&str, u64, u64, u64, bool, bool)] = &[
            // (file, input_total, read, write, read_reported, write_reported)
            ("anthropic-compatible.json", 12_900, 12_000, 0, true, false),
            ("anthropic.json", 21_000, 18_000, 1_000, true, true),
            ("deepseek.json", 21_000, 18_000, 0, true, false),
            ("google.json", 21_000, 18_000, 0, true, false),
            ("openai-cold.json", 5_000, 0, 0, true, false),
            ("openai.json", 21_000, 18_000, 0, true, false),
        ];
        let fixtures = usage_fixtures();
        assert_eq!(fixtures.len(), expected.len(), "fixture set changed: {:?}", fixtures.iter().map(|(n, _)| n).collect::<Vec<_>>());
        for ((file, payload), (want_file, total, read, write, rrep, wrep)) in
            fixtures.iter().zip(expected)
        {
            assert_eq!(file, want_file, "fixture order");
            let u = NormalizedUsage::from_payload(payload)
                .unwrap_or_else(|| panic!("{file}: not a usage payload"));
            assert_eq!(u.input_total, *total, "{file}: inclusive input");
            assert_eq!(u.cache_read, *read, "{file}");
            assert_eq!(u.cache_write, *write, "{file}");
            assert_eq!(u.cache_read_reported, *rrep, "{file}");
            assert_eq!(u.cache_write_reported, *wrep, "{file}");
        }
    }

    /// The fixtures stay SANITIZED: only the usage object lives here — never a
    /// request body, never a header, never a key. The lint walks every file
    /// under tests/fixtures and fails on anything that looks like prompt text
    /// or a credential, so a future "real" fixture cannot smuggle secrets into
    /// the repository.
    #[test]
    fn fixtures_stay_sanitized() {
        const FORBIDDEN: &[&str] = &[
            "authorization",
            "api_key",
            "apikey",
            "sk-",
            "bearer ",
            "\"messages\"",
            "system prompt",
            "private key",
            "password",
        ];
        fn walk(dir: &std::path::Path, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("fixtures dir") {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    walk(&p, hits);
                } else if let Ok(text) = std::fs::read_to_string(&p) {
                    let lower = text.to_lowercase();
                    for bad in FORBIDDEN {
                        if lower.contains(bad) {
                            hits.push(format!("{}: contains {bad:?}", p.display()));
                        }
                    }
                }
            }
        }
        let dir = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
        let mut hits = Vec::new();
        walk(std::path::Path::new(&dir), &mut hits);
        assert!(hits.is_empty(), "unsanitized fixture content:\n{}", hits.join("\n"));
    }
