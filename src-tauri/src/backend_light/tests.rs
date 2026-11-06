    use super::*;
    use tower::util::ServiceExt;

    /// Model id the live tests assert on: distinctive enough that a bug which
    /// sends the chat's model instead of the slot's can never pass by luck.
    const MOCK_MODEL: &str = "slot-mock/sentinel-model";

    #[test]
    fn slot_target_reads_the_renderer_camel_case_provider_config() {
        // The renderer sends provider configs as camelCase (`apiKeys`,
        // `baseUrl`). Reading only `apiKeys` left the key list empty for every
        // cross-provider slot, so /chats/title failed with "no api key
        // configured" and a new chat stayed untitled.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p1".to_string(),
            serde_json::json!({
                "kind": "openai",
                "baseUrl": "http://camel/v1",
                "apiKeys": ["sk-camel"],
            }),
        );
        let (model, base, keys, pid) =
            resolve_slot_target("p1/gpt-x", "parent", "http://parent/v1", &[], "parent-id", &providers);
        assert_eq!(model, "gpt-x");
        assert_eq!(base, "http://camel/v1");
        assert_eq!(keys, vec!["sk-camel".to_string()]);
        // The effective provider id rides along for usage attribution.
        assert_eq!(pid, "p1");

        // The sidecar's own snake_case contract keeps working.
        let mut snake = std::collections::HashMap::new();
        snake.insert(
            "p2".to_string(),
            serde_json::json!({"base_url": "http://snake/v1", "api_keys": ["sk-snake"]}),
        );
        let (_, base2, keys2, _) =
            resolve_slot_target("p2/m", "parent", "http://parent/v1", &[], "parent-id", &snake);
        assert_eq!(base2, "http://snake/v1");
        assert_eq!(keys2, vec!["sk-snake".to_string()]);

        // A single `apiKey` is honoured, and an unknown provider id falls back
        // to the parent's base + keys instead of losing them.
        let mut single = std::collections::HashMap::new();
        single.insert("p3".to_string(), serde_json::json!({"apiKey": "sk-one"}));
        let (_, base3, keys3, _) =
            resolve_slot_target("p3/m", "parent", "http://parent/v1", &["sk-parent".into()], "parent-id", &single);
        assert_eq!(base3, "http://parent/v1");
        assert_eq!(keys3, vec!["sk-one".to_string()]);
        let (_, base4, keys4, pid4) =
            resolve_slot_target("ghost/m", "parent", "http://parent/v1", &["sk-parent".into()], "parent-id", &single);
        assert_eq!(base4, "http://parent/v1");
        assert_eq!(keys4, vec!["sk-parent".to_string()]);
        // Unknown provider: falls back to the parent, id included.
        assert_eq!(pid4, "parent-id");
    }

    #[test]
    fn slot_target_never_lends_the_parents_key_to_another_endpoint() {
        // The user's 401: a slot (or fallback) whose provider is on a DIFFERENT
        // base URL but whose stored key list is empty. Borrowing the parent's
        // key there sends the chat provider's key to a foreign endpoint, and the
        // provider answers a bare "Invalid API key" that names no model — the
        // failure looks like the fallback never ran. An empty list is the honest
        // answer: llm::complete reports "no api key configured" instead.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "keyless".to_string(),
            serde_json::json!({"kind": "custom", "baseUrl": "http://other/v1"}),
        );
        let (_, base, keys, pid) = resolve_slot_target(
            "keyless/m",
            "parent",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            &providers,
        );
        assert_eq!(base, "http://other/v1");
        assert!(keys.is_empty(), "the parent's key must not cross endpoints, got {keys:?}");
        assert_eq!(pid, "keyless");

        // The SAME endpoint is a different story: there the parent's key is the
        // right key, and dropping it would break a slot that shares the chat's
        // provider but has no key list of its own.
        let mut shared = std::collections::HashMap::new();
        shared.insert(
            "same".to_string(),
            serde_json::json!({"kind": "custom", "baseUrl": "http://parent/v1"}),
        );
        let (_, _, keys, _) = resolve_slot_target(
            "same/m",
            "parent",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            &shared,
        );
        assert_eq!(keys, vec!["sk-parent".to_string()]);
    }

    #[test]
    fn other_slot_group_reads_whichever_key_holds_the_pick() {
        // Tools → "Other" writes ONE model for compact/web/title, but a stale
        // settings file can carry the pick under any single key. Reading only
        // "compact" is what made the commit message and the chat title run on
        // the main model while Settings showed the picked one.
        let mut m = std::collections::HashMap::new();
        m.insert("title".to_string(), "prov-b/side-model".to_string());
        m.insert("web".to_string(), "prov-b/side-model".to_string());
        assert_eq!(other_slot_entry(&m), "prov-b/side-model");
        // An explicit compact entry wins (it is the group's first key).
        m.insert("compact".to_string(), "prov-c/first".to_string());
        assert_eq!(other_slot_entry(&m), "prov-c/first");
        // Sentinels are ignored in favour of a real pick.
        let mut sentinels = std::collections::HashMap::new();
        sentinels.insert("compact".to_string(), "main model".to_string());
        sentinels.insert("web".to_string(), "prov-b/side-model".to_string());
        assert_eq!(other_slot_entry(&sentinels), "prov-b/side-model");
        // Nothing usable → the caller falls back to the main model.
        let mut none = std::collections::HashMap::new();
        none.insert("title".to_string(), "main".to_string());
        assert_eq!(other_slot_entry(&none), "");
        assert_eq!(other_slot_entry(&std::collections::HashMap::new()), "");

        let mut levels = std::collections::HashMap::new();
        levels.insert("title".to_string(), "low".to_string());
        assert_eq!(other_slot_level(&levels), "low");
        levels.insert("compact".to_string(), "high".to_string());
        assert_eq!(other_slot_level(&levels), "high");
        assert_eq!(other_slot_level(&std::collections::HashMap::new()), "");
    }

    #[test]
    fn slot_kind_follows_the_slot_provider_not_the_parent() {
        // A cross-provider slot (an anthropic decision/title model while the
        // chat runs on openrouter) must resolve to the SLOT's kind: the kind
        // selects the URL path + auth header, so inheriting the parent's kind
        // sent every call to the wrong endpoint and the slot silently failed.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p2".to_string(),
            serde_json::json!({"kind": "anthropic", "baseUrl": "http://a/v1"}),
        );
        assert_eq!(resolve_slot_kind("p2/claude-x", "openrouter", &providers), "anthropic");
        // Bare model, unknown provider id and an empty slot keep the parent.
        assert_eq!(resolve_slot_kind("claude-x", "openrouter", &providers), "openrouter");
        assert_eq!(resolve_slot_kind("ghost/m", "openrouter", &providers), "openrouter");
        assert_eq!(resolve_slot_kind("", "openrouter", &providers), "openrouter");
        // A provider entry without a kind also keeps the parent.
        providers.insert("p3".to_string(), serde_json::json!({"baseUrl": "http://b/v1"}));
        assert_eq!(resolve_slot_kind("p3/m", "openrouter", &providers), "openrouter");
    }

    #[tokio::test]
    async fn git_status_serves_natively_and_fallback_proxies() {
        let app = router(new_state(std::env::temp_dir()));
        let root = env!("CARGO_MANIFEST_DIR");

        // Native route: /git/status against this repo (a real git checkout).
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/git/status?root={root}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["branch"].is_string(), "branch missing: {body}");
        assert!(body["entries"].is_array());

        // Invalid root -> 400 with the same message as the Python layer.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/git/status?root=/nonexistent-xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        // /system-prompts is now NATIVE (appstate::system_prompts_get) — it
        // must return 200 with the canonical prompt keys.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/system-prompts")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn agent_terminals_lists_and_stops_over_http() {
        // The renderer's Terminals section polls GET /agent-terminals for the
        // ACTIVE chat and posts Stop here — this exercises that whole surface
        // against a real background process.
        let app = router(new_state(std::env::temp_dir()));
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let info = crate::agent_terminals::spawn(&root, "chat-router-test", "sleep 30").unwrap();

        // The chat filter is on the wire: this chat's row is visible…
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/agent-terminals?chat_id=chat-router-test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let rows = body["terminals"].as_array().expect("terminals array");
        assert!(rows.iter().any(|r| r["id"] == info.id && r["running"] == true));

        // …and another chat's filter does not see it.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/agent-terminals?chat_id=some-other-chat")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(!body["terminals"].as_array().unwrap().iter().any(|r| r["id"] == info.id));

        // Stop over POST — the button's call.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/agent-terminals/stop")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "id": info.id }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], true);

        // An empty id is a 400, not a silent no-op.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/agent-terminals/stop")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "id": "" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }

    #[tokio::test]
    async fn native_errors_are_json_detail_not_plain_text() {
        // The renderer reads `body.detail` on a non-ok response. A plain-text
        // body was swallowed into a generic "<op> failed (400)" — the reason
        // for a failed Commit stayed invisible. Every native error must carry
        // the message under `detail`.
        let app = router(new_state(std::env::temp_dir()));

        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/git/status?root=/nonexistent-xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["detail"], "invalid project root");

        // A missing repo must never be answered with an empty body either.
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills/file?name=nope&file=skill.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["detail"].is_string(), "missing detail: {body}");
    }

    #[tokio::test]
    async fn cors_headers_on_every_response_and_preflight() {
        let app = router(new_state(std::env::temp_dir()));

        // Preflight: OPTIONS must be answered here with the allow headers —
        // the webview sends it before any JSON POST.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri("/chat/stream")
                    .header("origin", "tauri://localhost")
                    .header("access-control-request-method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 204);
        assert_eq!(
            res.headers()["access-control-allow-origin"],
            "*"
        );

        // Native route responses carry the headers too (the webview origin is
        // cross-origin to this port).
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills")
                    .header("origin", "http://localhost:5173")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn chat_stream_is_always_native() {
        // No Python fallback: an empty body fails native deserialization
        // with a 400 — never a sidecar 503.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/stream")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }

    #[tokio::test]
    async fn skills_and_mcp_serve_natively() {
        // Isolated data root so the test never touches the real ~/.codifa.
        let tmp = std::env::temp_dir().join(format!("codifa-test-{}", std::process::id()));
        // A skill and a connector both live inside a bundle now, so the fixture
        // builds the folder the writer would.
        let bundle = tmp.join("plugins").join("learn-from-docs");
        let skills_dir = bundle.join("skills").join("learn-from-docs");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            bundle.join("plugin.json"),
            r#"{"name":"Learn from Docs","slug":"learn-from-docs","enabled":true}"#,
        )
        .unwrap();
        std::fs::write(
            skills_dir.join("skill.md"),
            "---\nname: Learn from Docs\ndescription: d\n---\n\n# Learn from Docs\nbody",
        )
        .unwrap();
        let app = router(new_state(tmp.clone()));

        // Native skills list.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/skills")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["skills"][0]["name"], "Learn from Docs");
        // Frontmatter is stripped; the markdown body (incl. heading) remains.
        assert_eq!(
            body["skills"][0]["content"].as_str().unwrap().trim(),
            "# Learn from Docs\nbody"
        );

        // Native connector save + list + delete round-trip, through the BUNDLE
        // routes: a connector is a part of a bundle, not a store entry.
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/plugins/mcp/save")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"docker","cfg":{"command":"docker"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);

        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/plugins/mcp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["connectors"][0]["name"], "docker");
        assert_eq!(body["connectors"][0]["cfg"]["command"], "docker");

        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/plugins/mcp/delete")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"docker"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/plugins/mcp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["connectors"].as_array().map(Vec::len), Some(0));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn normalize_compact_usage_maps_provider_key_families() {
        // OpenAI-compatible (the user's river provider): prompt_tokens family.
        let u = normalize_compact_usage(
            Some(json!({ "prompt_tokens": 120, "completion_tokens": 45 })),
            "zai-org/GLM-5.3-Flash",
            "river",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 120);
        assert_eq!(u["output_tokens"], 45);
        assert_eq!(u["model"], "zai-org/GLM-5.3-Flash");
        assert_eq!(u["provider_id"], "river");

        // Anthropic keys pass through; Gemini camelCase maps too.
        let u = normalize_compact_usage(
            Some(json!({ "input_tokens": 7, "output_tokens": 3 })),
            "m",
            "p",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 7);
        let u = normalize_compact_usage(
            Some(json!({ "promptTokenCount": 9, "candidatesTokenCount": 2 })),
            "m",
            "",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 9);
        assert_eq!(u["output_tokens"], 2);
        // An ANTHROPIC-SHAPED payload leaves INCLUSIVE: the frontend's cost
        // math subtracts read+write from input, so the raw exclusive number
        // used to undercount every Anthropic call.
        let u = normalize_compact_usage(
            Some(json!({
                "input_tokens": 2_000u64,
                "output_tokens": 3u64,
                "cache_read_input_tokens": 18_000u64,
                "cache_creation_input_tokens": 1_000u64,
            })),
            "m",
            "p",
        )
        .unwrap();
        assert_eq!(u["input_tokens"], 21_000);
        assert_eq!(u["cache_read_tokens"], 18_000);
        assert_eq!(u["cache_write_tokens"], 1_000);
        // An empty provider id is omitted, never stored as "".
        let no_provider = normalize_compact_usage(
            Some(json!({ "promptTokenCount": 9, "candidatesTokenCount": 2 })),
            "m",
            "",
        )
        .unwrap();
        assert!(no_provider.get("provider_id").is_none());

        // Missing/empty usage -> None (frontend skips accrual entirely).
        assert!(normalize_compact_usage(None, "m", "p").is_none());
        assert!(normalize_compact_usage(Some(json!(null)), "m", "p").is_none());
    }

    #[tokio::test]
    async fn model_probe_rejects_an_empty_selection() {
        // The probe moved native (it was the last live consumer of the
        // LangChain model factory); the 400 contract must survive the move.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"provider":"custom","model":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"provider":"custom","models":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }

    /// One live OpenAI-compatible upstream on 127.0.0.1: records every
    /// request body and answers a fixed completion + usage. Returns the base
    /// URL and a channel of the bodies it received.
    async fn spawn_mock_upstream() -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = serde_json::from_slice(&buf[head_end + 4..]).unwrap_or(Value::Null);
                    let _ = tx.send(body);
                    let resp = concat!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n",
                        "content-length: 96\r\nconnection: close\r\n\r\n",
                        "{\"choices\":[{\"message\":{\"content\":\"ok summary\"}}]",
                        ",\"usage\":{\"input_tokens\":21,\"output_tokens\":7}}"
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// An OpenAI-compatible upstream that answers 401 for one model and a
    /// completion for any other, recording `(model, authorization)` per request.
    /// Used to prove WHICH key each rung of a chain actually sent.
    async fn spawn_key_recording_upstream(
        reject_model: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<(String, String)>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let tx = tx.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let n = sock.read(&mut tmp).await.unwrap();
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let auth = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("authorization:"))
                        .map(|v| v.trim().to_string())
                        .unwrap_or_default();
                    let body = serde_json::from_slice::<Value>(&buf[head_end + 4..])
                        .unwrap_or(Value::Null);
                    let model = body["model"].as_str().unwrap_or_default().to_string();
                    let _ = tx.send((model.clone(), auth));
                    let (status, payload) = if model == reject_model {
                        (
                            "401 Unauthorized",
                            r#"{"error":{"message":"Invalid API key","type":"invalid_request_error"}}"#
                                .to_string(),
                        )
                    } else {
                        (
                            "200 OK",
                            r#"{"choices":[{"message":{"content":"ok summary"}}],"usage":{"input_tokens":21,"output_tokens":7}}"#
                                .to_string(),
                        )
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn compact_walks_the_slots_own_fallbacks_and_never_the_chat_model() {
        // A tool falls back on the models the user picked FOR IT, top to bottom,
        // and on nothing else. Two properties proved together:
        //  * each rung carries the key of the provider it actually calls (a slot
        //    key on another provider's endpoint is the 401 that looked like the
        //    fallbacks were never tried);
        //  * the CHAT model is never appended. It used to be, so a summariser
        //    that failed on every model the user configured for it still
        //    "succeeded" on a model they had not chosen for the job.
        let (mock_base, mut rx) = spawn_key_recording_upstream("dead-model").await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-prov",
            "model": "chat-model",
            "base_url": format!("{mock_base}/v1"),
            "api_keys": ["sk-chat"],
            // Sent by the renderer, and deliberately ignored by the route.
            "fallback_model": "chat-model",
            "fallback_api_keys": ["sk-chat"],
            "fallback_provider_id": "chat-prov",
            "subagent_models": { "compact": "slot-a/dead-model" },
            "tool_fallbacks": { "compact": ["slot-b/backup-model"] },
            "providers": {
                "slot-a": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-a"] },
                "slot-b": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-b"] },
                "chat-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-chat"] }
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);

        let first = rx.recv().await.expect("the slot model was never called");
        assert_eq!(first.0, "dead-model");
        assert_eq!(first.1, "bearer sk-a", "rung 0 must use ITS OWN provider's key");
        let second = rx
            .recv()
            .await
            .expect("the slot's own fallback was never reached");
        assert_eq!(second.0, "backup-model");
        assert_eq!(second.1, "bearer sk-b", "rung 1 must use ITS OWN provider's key");
        assert!(
            rx.try_recv().is_err(),
            "the chat model must never be appended to a tool's fallback list"
        );
        assert_eq!(out["summary"], "ok summary");
        assert!(out.get("error").is_none() || out["error"].is_null());
    }

    #[tokio::test]
    async fn compact_attributes_the_usage_to_the_rung_that_answered() {
        // Rung 0 dies on a real provider rejection, so the USER's own fallback
        // answers. The usage event must name THAT provider and THAT model: it
        // used to report rung 0's pair, which billed a compaction the fallback
        // served to a provider that never answered.
        let (mock_base, _rx) = spawn_key_recording_upstream("dead-model").await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-prov",
            "model": "chat-model",
            "base_url": format!("{mock_base}/v1"),
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": "slot-a/dead-model" },
            "tool_fallbacks": { "compact": ["slot-b/backup-model"] },
            "providers": {
                "slot-a": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-a"] },
                "slot-b": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-b"] }
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);
        assert_eq!(out["summary"], "ok summary");
        assert_eq!(
            out["usage"]["provider_id"], "slot-b",
            "usage must name the rung that answered, got {out}"
        );
        assert_eq!(out["usage"]["model"], "backup-model");
    }

    #[tokio::test]
    async fn model_probe_reports_a_failure_per_model_without_failing_the_batch() {
        // An unreachable provider must mark that model failed (no green tick)
        // while the batch itself still answers 200 — the UI ticks per model.
        let app = router(new_state(std::env::temp_dir()));
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/models/test-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"provider":"custom","base_url":"http://127.0.0.1:1","api_keys":["k"],"models":["m"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let item = &body["results"][0];
        assert_eq!(item["model"], "m");
        assert_eq!(item["ok"], false);
        assert!(
            item["error"].as_str().is_some_and(|e| !e.is_empty()),
            "a failed probe must carry the reason: {body}"
        );
    }

    /// Split an SSE compaction body (`data: {json}\n\n`) into its progress ticks
    /// and the single result frame. `/chat/compact` streams both now, so a test
    /// can no longer read one plain JSON body.
    fn parse_compact_sse(bytes: &[u8]) -> (Vec<Value>, Value) {
        let text = String::from_utf8_lossy(bytes);
        let mut progress = Vec::new();
        let mut result = Value::Null;
        for frame in text.split("\n\n") {
            for line in frame.lines() {
                let Some(raw) = line.strip_prefix("data: ") else { continue };
                let Ok(v) = serde_json::from_str::<Value>(raw.trim()) else { continue };
                if v.get("compact_progress").and_then(|p| p.as_bool()) == Some(true) {
                    progress.push(v);
                } else {
                    result = v;
                }
            }
        }
        (progress, result)
    }

    #[tokio::test]
    async fn compact_live_uses_the_slot_model_provider_and_reasoning() {
        // A cross-provider compact slot must: (1) hit THAT provider's base URL
        // with the slot's model id, (2) apply the slot's own reasoning effort
        // (max), and (3) attribute the usage to the slot's provider id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "openrouter",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": format!("slot-prov/{MOCK_MODEL}") },
            "subagent_thinking": { "compact": "max" },
            "model_reasoning": true,
            "providers": {
                "slot-prov": {
                    "kind": "custom",
                    "baseUrl": format!("{mock_base}/v1"),
                    "apiKeys": ["sk-slot"],
                    // The levels the model was described with. Only a level a
                    // source named may be sent for it.
                    "thinkingLevelsMap": { MOCK_MODEL: ["none", "low", "medium", "high", "xhigh"] }
                }
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);

        let sent = rx.recv().await.expect("mock upstream saw no request");
        assert_eq!(sent["model"], MOCK_MODEL, "the slot model must be sent, got {sent}");
        assert_eq!(sent["reasoning_effort"], "xhigh", "slot thinking=max must reach the wire verbatim, since its source enumerated it, got {sent}");
        let usage = &out["usage"];
        assert_eq!(usage["model"], MOCK_MODEL);
        assert_eq!(usage["provider_id"], "slot-prov", "usage must be attributed to the effective provider, got {usage}");
        assert_eq!(usage["input_tokens"], 21);
        assert_eq!(out["summary"], "ok summary");
    }

    #[tokio::test]
    async fn compact_live_without_a_slot_uses_the_chat_model_and_provider() {
        // Empty slot = the chat's own model/provider, attributed to the chat's id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": MOCK_MODEL,
            "base_url": format!("{mock_base}/v1"),
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (progress, out) = parse_compact_sse(&bytes);
        let sent = rx.recv().await.expect("mock upstream saw no request");
        let usage = &out["usage"];
        // The stream must report real work, not just the result: a run starts
        // with a preparing tick and reports the summarizer call itself.
        assert!(!progress.is_empty(), "no progress frames were streamed");
        assert_eq!(progress[0]["phase"], "preparing");
        assert!(
            progress.iter().any(|p| p["phase"] == "summarizing"),
            "no summarizing tick, got {progress:?}"
        );
        assert!(progress.iter().any(|p| p["budget_secs"].as_u64().unwrap_or(0) > 0));
        assert_eq!(sent["model"], MOCK_MODEL);
        assert_eq!(usage["provider_id"], "chat-provider");
    }

    #[tokio::test]
    async fn title_live_uses_the_title_slot_model_and_provider() {
        // The title slot routes cross-provider: the request must go to THAT
        // provider and the reported usage must carry ITS id.
        let (mock_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "openrouter",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "title": format!("title-prov/{MOCK_MODEL}") },
            "providers": {
                "title-prov": { "kind": "custom", "baseUrl": format!("{mock_base}/v1"), "apiKeys": ["sk-title"] }
            },
            "text": "hello world this is the first message"
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chats/title")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        let sent = rx.recv().await.expect("mock upstream saw no request");
        assert_eq!(sent["model"], MOCK_MODEL, "title must run on the slot model, got {sent}");
        let usage = &out["usage"];
        assert_eq!(usage["provider_id"], "title-prov", "title usage must be attributed to the slot provider, got {usage}");
        assert_eq!(usage["model"], MOCK_MODEL);
        assert!(out["title"].as_str().is_some_and(|t| !t.is_empty()), "a title must come back: {out}");
    }

    #[test]
    fn a_slash_is_a_provider_prefix_only_for_a_configured_provider() {
        // The user's 404: `oc/deepseek-v4.1-flash-free` was stored bare, then
        // split at the FIRST slash — provider `oc` (which does not exist) and
        // the model truncated to `deepseek-v4.1-flash-free`, sent to the chat
        // provider's endpoint. Only a KNOWN provider id may be taken as a
        // prefix; otherwise the whole string is the model id.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "9router".to_string(),
            serde_json::json!({"kind": "custom", "baseUrl": "http://r/v1", "apiKeys": ["sk-r"]}),
        );
        let (pid, model) = split_slot_entry("oc/deepseek-v4.1-flash-free", &providers);
        assert_eq!(pid, "");
        assert_eq!(model, "oc/deepseek-v4.1-flash-free");

        // A configured head IS a prefix, and the model keeps its own slashes.
        let (pid, model) = split_slot_entry("9router/oc/deepseek-v4.1-flash-free", &providers);
        assert_eq!(pid, "9router");
        assert_eq!(model, "oc/deepseek-v4.1-flash-free");

        // No slash at all: a bare model id.
        let (pid, model) = split_slot_entry("z-ai/glm-5.3", &providers);
        assert_eq!(pid, "");
        assert_eq!(model, "z-ai/glm-5.3");
    }

    #[test]
    fn a_bare_slash_bearing_model_still_routes_to_the_parent() {
        // End to end through the resolver: the provider id must NOT be invented
        // from the model's own namespace, or the call lands on a provider that
        // does not exist (or guesses the parent's endpoint with a truncated id).
        let providers = std::collections::HashMap::new();
        let (model, base, keys, pid) =
            resolve_slot_target("oc/deepseek-v4.1-flash-free", "chat", "http://c/v1", &["sk-c".into()], "chat-prov", &providers);
        assert_eq!(model, "oc/deepseek-v4.1-flash-free");
        assert_eq!(base, "http://c/v1");
        assert_eq!(keys, vec!["sk-c".to_string()]);
        assert_eq!(pid, "chat-prov");
    }

    #[test]
    fn slot_chain_keeps_the_arranged_order_without_repeats() {
        // The chain is what a tool's own model failure walks down: the tool's
        // model first, then its fallback list in the order the user arranged it
        // (the settings row has up/down buttons), with unreachable repeats
        // dropped so one dead model cannot be paid for twice.
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "p1".to_string(),
            serde_json::json!({"kind": "openai", "baseUrl": "http://one/v1", "apiKeys": ["sk-one"]}),
        );
        providers.insert(
            "p2".to_string(),
            serde_json::json!({"kind": "anthropic", "baseUrl": "http://two/v1", "apiKeys": ["sk-two"]}),
        );
        let fallbacks = vec![
            "p2/fb-a".to_string(),
            // Same provider+model as the slot's own model: dropped.
            "p1/gpt-x".to_string(),
            "p2/fb-b".to_string(),
            "".to_string(),
            // An unknown HEADING is not a provider prefix: `ghost/fb-c` is a
            // model id that merely contains a slash, routed like any other bare
            // model. Slicing it would invent provider `ghost` AND truncate the
            // model to `fb-c` — a 404 on the parent's endpoint.
            "ghost/fb-c".to_string(),
        ];
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &fallbacks,
            "parent-model",
            "http://parent/v1",
            &["sk-parent".to_string()],
            "parent-id",
            "custom",
            &providers,
        );
        let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(models, vec!["gpt-x", "fb-a", "fb-b", "ghost/fb-c"]);
        // Each rung routes to ITS OWN provider — base URL, keys and endpoint
        // kind — exactly like the slot entry itself.
        assert_eq!(chain[1].1, "http://two/v1");
        assert_eq!(chain[1].2, vec!["sk-two".to_string()]);
        assert_eq!(chain[1].3, "p2");
        assert_eq!(chain[1].4, "anthropic");
        assert_eq!(chain[3].1, "http://parent/v1");
        assert_eq!(chain[3].3, "parent-id");
        assert_eq!(chain[3].4, "custom");

        // Re-arranging the list (what the up/down buttons do) re-orders the
        // chain: the try order is the LIST order, nothing else.
        let flipped = vec!["p2/fb-b".to_string(), "p2/fb-a".to_string()];
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &flipped,
            "parent-model",
            "http://parent/v1",
            &[],
            "parent-id",
            "custom",
            &providers,
        );
        let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(models, vec!["gpt-x", "fb-b", "fb-a"]);
    }

    #[test]
    fn slot_chain_starts_at_the_slot_model_every_call() {
        // Nothing about a chain survives the call it was built for: a fallback
        // is an escape hatch for ONE failing call, never a new default.
        let providers = std::collections::HashMap::new();
        let fallbacks = vec!["fb-x".to_string(), "fb-y".to_string()];
        for _ in 0..2 {
            let chain = resolve_slot_chain(
                "",
                &fallbacks,
                "parent-model",
                "http://parent/v1",
                &[],
                "parent-id",
                "custom",
                &providers,
            );
            assert_eq!(chain[0].0, "parent-model");
            assert_eq!(chain[0].3, "parent-id");
            let models: Vec<&str> = chain.iter().map(|s| s.0.as_str()).collect();
            assert_eq!(models, vec!["parent-model", "fb-x", "fb-y"]);
        }
        // A slot with no fallbacks is exactly one rung long.
        let chain = resolve_slot_chain(
            "p1/gpt-x",
            &[],
            "parent-model",
            "http://parent/v1",
            &[],
            "parent-id",
            "custom",
            &providers,
        );
        assert_eq!(chain.len(), 1);
    }

    #[test]
    fn other_slot_fallbacks_read_the_group_first_list() {
        // The "Other" row writes compact/web/title together, so its fallback
        // list lives under the same keys and is read with the same precedence
        // as its model.
        let mut m = std::collections::HashMap::new();
        m.insert("title".to_string(), vec!["p2/t".to_string()]);
        m.insert("web".to_string(), vec!["p2/w".to_string()]);
        assert_eq!(other_slot_fallbacks(&m), ["p2/w".to_string()]);
        m.insert("compact".to_string(), vec!["p2/c".to_string()]);
        assert_eq!(other_slot_fallbacks(&m), ["p2/c".to_string()]);
        // An empty list under the first key must not hide a real one.
        let mut sparse = std::collections::HashMap::new();
        sparse.insert("compact".to_string(), Vec::new());
        sparse.insert("title".to_string(), vec!["p2/t".to_string()]);
        assert_eq!(other_slot_fallbacks(&sparse), ["p2/t".to_string()]);
        assert!(other_slot_fallbacks(&std::collections::HashMap::new()).is_empty());
    }

    /// An OpenAI-compatible upstream that always rejects with 401 — the
    /// "provider refuses the key" failure a dead provider produces.
    async fn spawn_rejecting_upstream() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { break };
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = r#"{"error":{"message":"Invalid API key"}}"#;
                    let resp = format!(
                        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// The same upstream, answering the user's REAL failure: a 429 whose body
    /// says the account's free allowance is used up. Distinguished from the 401
    /// upstream because the two reach the chain by different routes — a 401 is
    /// already model-side, so a 429 that must ALSO fall through is the case
    /// worth pinning.
    async fn spawn_quota_exhausted_upstream() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { break };
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = r#"{"error":{"message":"[429]: {\"type\":\"FreeUsageLimitError\",\"message\":\"Free usage limit reached.\"}","code":"rate_limit_exceeded"}}"#;
                    let resp = format!(
                        "HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// An OpenAI-compatible upstream that answers 200 with a billing refusal
    /// inside `message.content` (Pollinations' drained-account shape). The
    /// model named `broke` gets the refusal; any other model gets a real "OK".
    async fn spawn_content_error_upstream() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf: Vec<u8> = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                    let len: usize = head
                        .split("\r\n")
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while buf.len() < head_end + 4 + len {
                        let Ok(n) = sock.read(&mut tmp).await else { break };
                        if n == 0 { break; }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let req = String::from_utf8_lossy(&buf[head_end + 4..]).to_ascii_lowercase();
                    let (content, usage) = if req.contains("\"model\":\"broke\"") {
                        (
                            "The account behind this API key doesn't have enough credits. \
                             Please top up or complete a quest, then try again.",
                            r#"{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}"#,
                        )
                    } else {
                        ("OK", r#"{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}"#)
                    };
                    let body = format!(
                        r#"{{"id":"x","object":"chat.completion","choices":[{{"index":0,"message":{{"role":"assistant","content":"{content}"}},"finish_reason":"stop"}}],"usage":{usage}}}"#
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_model_probe_rejects_a_billing_refusal_returned_as_content() {
        // The reported bug: the model test showed a green tick, then chat
        // displayed "The account behind this API key doesn't have enough
        // credits…" as the assistant's answer. The refusal is a normal 200
        // completion with zero usage, so a non-empty reply check passed it.
        let base = spawn_content_error_upstream().await;
        let body = |model: &str| ModelTestBody {
            provider: "custom".into(),
            base_url: format!("{base}/v1"),
            api_keys: vec!["k".into()],
            model: model.into(),
            models: Vec::new(),
            headers: None,
            provider_id: "p".into(),
        };
        let err = probe_model(&body("broke"), "broke").await.unwrap_err();
        assert!(err.contains("enough credits"), "{err}");
        // The healthy model on the same upstream still passes.
        assert_eq!(probe_model(&body("ok"), "ok").await.unwrap(), "OK");
    }

    #[test]
    fn a_probe_prompt_is_chat_sized_and_unique() {
        // Free tiers gate on prompt size: Refuseless 402s from ~2 000 chars.
        // A tiny probe therefore ticked while every real chat was refused, so
        // the probe must be at least that large.
        let a = probe_prompt();
        let b = probe_prompt();
        assert!(a.len() >= MODEL_TEST_PROMPT_CHARS, "len {}", a.len());
        assert!(a.contains("Reply with the single word: OK"), "{a}");
        // The instruction is last so the model answers it, not the filler.
        assert!(
            a.rfind("Reply with the single word: OK").unwrap() >= MODEL_TEST_PROMPT_CHARS,
            "{a}"
        );
        // The nonce makes every probe unique: a gateway cannot serve a cached
        // "OK" from before the account ran out of credit.
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn compact_live_walks_the_other_slots_fallback_when_the_key_is_rejected() {
        // The live failure this fixes: the "Other" slot's own provider rejects
        // the key, and the compact used to die with
        // "Compact failed — key rejected (401)" even though the user had a
        // fallback configured. The fallback list must be walked automatically
        // and the compaction must finish on the fallback model.
        let dead_base = spawn_rejecting_upstream().await;
        let (good_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_key": "sk-chat",
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": format!("dead-prov/{MOCK_MODEL}") },
            "providers": {
                "dead-prov": { "kind": "custom", "baseUrl": format!("{dead_base}/v1"), "apiKeys": ["sk-dead"] },
                "good-prov": { "kind": "custom", "baseUrl": format!("{good_base}/v1"), "apiKeys": ["sk-good"] }
            },
            "tool_fallbacks": { "compact": [format!("good-prov/{MOCK_MODEL}")] },
            // The renderer ALWAYS sends the chat model as the summariser's
            // last resort. That used to be the only rung honoured, which threw
            // the Tools fallback list away — the exact bug this pins. Here the
            // chat model is broken too, so only the Tools list can answer.
            "fallback_provider": "custom",
            "fallback_model": "chat/last-resort",
            "fallback_base_url": format!("{dead_base}/v1"),
            "fallback_api_keys": ["sk-dead"],
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);
        // The GOOD provider is the one that must receive the summariser call —
        // and it must receive the slot's own model, resolved through the
        // fallback's OWN provider config (its keys and base URL).
        let sent = rx.recv().await.expect("the fallback provider saw no request");
        assert_eq!(sent["model"], MOCK_MODEL);
        assert_eq!(
            out["summary"], "ok summary",
            "the fallback must answer the compaction, got {out}"
        );
        assert!(
            out["error"].is_null(),
            "a walked chain must not report an error, got {out}"
        );
    }

    #[tokio::test]
    async fn compact_walks_past_a_quota_exhausted_429_to_the_users_own_fallback() {
        // The exact banner the user reported:
        // `Compact failed — every summarizer model failed — oc/deepseek-v4.1-flash-free:
        //  key rejected (429): … FreeUsageLimitError … rate_limit_exceeded`.
        //
        // Only ONE model was ever named, although the user had two fallbacks
        // configured for the "Other" slot. The 429 body carried a quota verdict
        // (the account's free allowance for that model is gone), but the
        // rate-limit gate classified it as a temporary hiccup, so the walk
        // stopped at rung 0 and the user's list was never reached. The rung now
        // spends its own budget and hands the call to the next model.
        let exhausted_base = spawn_quota_exhausted_upstream().await;
        let (good_base, mut rx) = spawn_mock_upstream().await;
        let app = router(new_state(std::env::temp_dir()));
        let body = json!({
            "provider": "custom",
            "provider_id": "chat-provider",
            "model": "main/m-main",
            "base_url": "http://chat-provider.example/v1",
            "api_keys": ["sk-chat"],
            "subagent_models": { "compact": "oc/deepseek-v4.1-flash-free" },
            "providers": {
                "oc": { "kind": "custom", "baseUrl": format!("{exhausted_base}/v1"), "apiKeys": ["sk-oc"] },
                "zai": { "kind": "custom", "baseUrl": format!("{good_base}/v1"), "apiKeys": ["sk-zai"] }
            },
            "tool_fallbacks": {
                "compact": [format!("zai/{MOCK_MODEL}")]
            },
            "history": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "world" }
            ]
        });
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/chat/compact")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let (_progress, out) = parse_compact_sse(&bytes);
        let sent = rx
            .recv()
            .await
            .expect("the user's own fallback provider saw no request");
        assert_eq!(sent["model"], MOCK_MODEL);
        assert_eq!(
            out["summary"], "ok summary",
            "a quota-exhausted first model must hand the work to the next, got {out}"
        );
        assert!(
            out["error"].is_null(),
            "the summary succeeded, so no error may be reported, got {out}"
        );
    }
