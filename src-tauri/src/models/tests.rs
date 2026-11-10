    use super::*;

    /// A stale catalog must be dropped, not merely ignored on read.
    ///
    /// The cache had NO removal path: one entry per (provider, url) ever asked
    /// for stayed for the life of the process, each holding a full model
    /// catalog. This calls the REAL write path, so the prune cannot silently
    /// drift away from what production does.
    #[test]
    fn a_stale_model_catalog_is_pruned_on_write() {
        {
            let mut guard = model_cache().lock().unwrap();
            guard.clear();
            guard.insert(
                "stale-provider|http://x".into(),
                (
                    Instant::now() - Duration::from_secs(MODEL_CACHE_SECS + 1),
                    Value::Array(vec![json!({ "id": "stale" })]),
                ),
            );
        }

        store_model_catalog(
            "live-provider|http://y".to_string(),
            vec![json!({ "id": "fresh" })],
        );

        let guard = model_cache().lock().unwrap();
        assert!(
            !guard.contains_key("stale-provider|http://x"),
            "the stale entry must be gone after a write"
        );
        let (at, data) = guard.get("live-provider|http://y").expect("fresh entry");
        assert!(at.elapsed() < Duration::from_secs(MODEL_CACHE_SECS));
        assert_eq!(data, &Value::Array(vec![json!({ "id": "fresh" })]));
        drop(guard);
        model_cache().lock().unwrap().clear();
    }

    #[test]
    fn context_prefers_provider_fields_then_capabilities() {
        let entry = json!({"context_length": 128000});
        assert_eq!(entry_context(&entry), Some(128000));
        let nested = json!({"capabilities": {"contextWindow": 200000}});
        assert_eq!(entry_context(&nested), Some(200000));
        assert_eq!(entry_context(&json!({})), None);
    }

    #[test]
    fn pricing_normalizes_to_usd_per_million() {
        let entry = json!({"pricing": {"prompt": "0.0000008", "completion": "0.000002"}});
        let out = entry_pricing(&entry).unwrap();
        let inp = out["input"].as_f64().unwrap();
        assert!((inp - 0.8).abs() < 1e-9, "got {inp}");
    }

    #[test]
    fn vision_reads_openrouter_and_models_dev_shapes() {
        // OpenRouter's live payload.
        let openrouter = json!({
            "architecture": { "input_modalities": ["text", "image"] }
        });
        assert_eq!(entry_vision(&openrouter), Some(true));
        // The same model without image input is explicitly text-only.
        let text_only = json!({
            "architecture": { "input_modalities": ["text"] }
        });
        assert_eq!(entry_vision(&text_only), Some(false));
        // models.dev's catalog shape.
        let dev = json!({ "modalities": { "input": ["text", "image", "pdf"] } });
        assert_eq!(entry_vision(&dev), Some(true));
        // Old OpenRouter modality string.
        let legacy = json!({ "architecture": { "modality": "text+image->text" } });
        assert_eq!(entry_vision(&legacy), Some(true));
        // A silent payload is UNKNOWN, not text-only.
        assert_eq!(entry_vision(&json!({ "id": "mystery" })), None);
        // Explicit boolean flags.
        assert_eq!(entry_vision(&json!({ "supports_vision": true })), Some(true));
        assert_eq!(entry_vision(&json!({ "vision": false })), Some(false));
    }

    #[test]
    fn models_dev_vision_fills_a_silent_provider_payload() {
        let catalog = json!({
            "openrouter": {
                "models": {
                    "nvidia/nemotron-3-super-120b-a12b": {
                        "modalities": { "input": ["text"], "output": ["text"] }
                    },
                    "google/gemini-3.6-flash": {
                        "modalities": { "input": ["text", "image"], "output": ["text"] }
                    }
                }
            }
        });
        let mut text_only = Row {
            id: "nvidia/nemotron-3-super-120b-a12b".into(),
            context: None,
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut text_only, &catalog, "openrouter", "");
        assert_eq!(text_only.vision, Some(false));

        let mut vision = Row {
            id: "google/gemini-3.6-flash".into(),
            context: None,
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut vision, &catalog, "openrouter", "");
        assert_eq!(vision.vision, Some(true));

        // A provider that already said `true` is never downgraded by the gap-fill.
        let mut provider_wins = Row {
            id: "nvidia/nemotron-3-super-120b-a12b".into(),
            context: None,
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: Some(true),
        };
        apply_models_dev(&mut provider_wins, &catalog, "openrouter", "");
        assert_eq!(provider_wins.vision, Some(true));
    }

    #[test]
    fn multi_vendor_detection_counts_prefixes() {
        let rows = vec![
            row("nvidia/llama"),
            row("groq/llama"),
            row("gemini/flash"),
        ];
        assert!(is_multi_vendor_catalog(&rows));
        assert!(!is_multi_vendor_catalog(&vec![row("llama3"), row("qwen2.5")]));
    }

    #[test]
    fn local_probe_is_limited_to_local_endpoints() {
        for local in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:8080/v1",
            "http://[::1]:1234",
            "http://172.16.5.9:8000/v1",
            "http://192.168.1.20:8000/v1",
            "http://10.0.0.7:8000",
            "http://gpu-box:8000/v1",
            "http://host.local:11434",
        ] {
            assert!(is_local_endpoint(local), "{local} must be probed");
        }
        for remote in [
            "https://integrate.api.nvidia.com/v1",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "https://172.32.0.1/v1",
            "https://172.15.0.1/v1",
            "https://11.0.0.1/v1",
            "",
        ] {
            assert!(!is_local_endpoint(remote), "{remote} must NOT be probed");
        }
    }

    #[test]
    fn cloudflare_account_comes_from_the_base_url_or_the_env() {
        // The endpoint the UI builds from the row's Account ID field.
        assert_eq!(
            cloudflare_account("https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"),
            Some("abc123".to_string())
        );
        // The unexpanded template is not an id — and the UI never sends one.
        assert_eq!(
            cloudflare_account("https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1"),
            None
        );
        assert_eq!(cloudflare_account("https://api.cloudflare.com/client/v4/accounts//ai/v1"), None);
        assert_eq!(cloudflare_account("https://api.cloudflare.com/client/v4"), None);
        assert_eq!(cloudflare_account(""), None);
    }

    #[test]
    fn cloudflare_endpoint_requires_an_account_id() {
        let err = models_endpoint("cloudflare", "https://api.cloudflare.com/client/v4")
            .expect_err("a missing account id must fail loudly");
        assert!(err.contains("account id"), "{err}");
    }

    fn row(id: &str) -> ModelRow {
        let mut m = ModelRow::new();
        m.insert("id".to_string(), Value::String(id.to_string()));
        m
    }

    #[test]
    fn google_and_opencode_ids_are_normalized_for_the_catalog() {
        assert_eq!(models_dev_id("google", "models/gemini-2.5-flash", ""), "gemini-2.5-flash");
        assert_eq!(
            models_dev_id("custom", "opencode/deepseek-v4-flash-free", "https://opencode.ai/x"),
            "deepseek-v4-flash-free"
        );
        assert_eq!(models_dev_id("nvidia", "nvidia/llama", ""), "nvidia/llama");
    }

    /// Tier 1 of the capacity rule: models.dev WINS over the provider's own
    /// payload, even when the provider reports a different (smaller) number.
    ///
    /// This is the regression lock for the "it compacts way before my setting"
    /// report: trusting a gateway's placeholder window (opencode advertises 4k)
    /// made auto-compaction fire at a fraction of the model's real window. The
    /// provider value must only survive when the catalog has no entry at all.
    #[test]
    fn models_dev_context_wins_over_the_provider_payload() {
        let catalog = json!({
            "openai": {
                "models": {
                    "gpt-4o": { "limit": { "context": 128_000, "output": 16_384 } }
                }
            }
        });

        // Provider payload said 4000 (a placeholder); the catalog says 128k.
        let mut provider_says_4k = Row {
            id: "gpt-4o".into(),
            context: Some(4_000),
            max_output: Some(4_096),
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut provider_says_4k, &catalog, "openai", "");
        assert_eq!(
            provider_says_4k.context,
            Some(128_000),
            "the catalog window must override the provider's placeholder"
        );
        // max_output only fills a gap — the provider already knew its own.
        assert_eq!(provider_says_4k.max_output, Some(4_096));

        // No provider value at all: the catalog still fills it.
        let mut provider_says_nothing = Row {
            id: "gpt-4o".into(),
            context: None,
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut provider_says_nothing, &catalog, "openai", "");
        assert_eq!(provider_says_nothing.context, Some(128_000));
        assert_eq!(provider_says_nothing.max_output, Some(16_384));

        // A model the catalog does not know keeps the provider's number (tier 2).
        let mut unknown_to_catalog = Row {
            id: "some-proprietary-model".into(),
            context: Some(200_000),
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut unknown_to_catalog, &catalog, "openai", "");
        assert_eq!(
            unknown_to_catalog.context,
            Some(200_000),
            "without a catalog entry the provider's own value must survive"
        );
    }

    /// The provider-prefixed catalog key must be found too: NVIDIA-style
    /// gateways report `nvidia/<model>` while the catalog stores the bare id
    /// under the `nvidia` key (see `models_dev_keys`).
    #[test]
    fn models_dev_context_resolves_provider_prefixed_ids() {
        let catalog = json!({
            "nvidia": {
                "models": { "deepseek-v3": { "limit": { "context": 163_840 } } }
            }
        });
        let mut row = Row {
            id: "deepseek-ai/deepseek-v3".into(),
            context: Some(8_192),
            max_output: None,
            pricing: None,
            reasoning: None,
            thinking_levels: None,
            vision: None,
        };
        apply_models_dev(&mut row, &catalog, "nvidia", "https://integrate.api.nvidia.com/v1");
        assert_eq!(
            row.context,
            Some(163_840),
            "the prefixed id must resolve to the catalog entry, not fall through"
        );
    }

    // --- per-model thinking levels -----------------------------------------

    fn levels(entry: Value, kind: &str) -> Option<Vec<String>> {
        entry_thinking_levels(&entry, kind)
    }

    fn owned(levels: &[&str]) -> Option<Vec<String>> {
        Some(levels.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn thinking_levels_are_only_what_a_source_named() {
        // 9router-style entry: thinking is a switch and the effort is NOT
        // graded, so the source names no level. No on-token is invented here —
        // and this is NOT a "no thinking" verdict either: `None` keeps the
        // composer's list visible while `level_from_source` still refuses any
        // level this model was not described with.
        let entry = json!({
            "id": "minimax-m3.1-flash-free",
            "capabilities": {
                "reasoning": true,
                "thinkingEffortSupported": false,
                "thinkingCanDisable": true
            }
        });
        assert_eq!(levels(entry, "custom"), None);
    }

    #[test]
    fn a_level_the_kind_cannot_encode_is_not_offered() {
        // Anthropic has no `reasoning_effort` wire: a token its budget tables do
        // not know cannot be turned into a request, so it is not offered either.
        let entry = json!({
            "reasoning_options": [{ "type": "effort", "values": ["low", "minimal"] }]
        });
        assert_eq!(levels(entry, "anthropic"), owned(&["low"]));
    }

    #[test]
    fn thinking_levels_keep_every_token_a_source_enumerated() {
        // The source named the levels, so it decides them: collapsing `xhigh`
        // onto `high` sent a request such a gateway answers with 400.
        let entry = json!({"reasoning_options": [{
            "type": "effort",
            "values": ["none", "low", "medium", "high", "xhigh"]
        }]});
        for kind in ["openai", "openrouter", "custom"] {
            assert_eq!(
                levels(entry.clone(), kind),
                owned(&["none", "low", "medium", "high", "xhigh"])
            );
        }
        // An enumeration that omits the switch keeps the picker without it.
        let sparse = json!({
            "reasoning": {"supported_efforts": ["low", "medium", "xhigh"], "mandatory": true}
        });
        assert_eq!(
            levels(sparse, "custom"),
            owned(&["low", "medium", "xhigh"])
        );
    }

    #[test]
    fn thinking_levels_prefer_the_enumerated_tokens() {
        // `max` is the legacy alias of `xhigh`: the enumeration names it, so the
        // top step is offered — but only once.
        let entry = json!({"reasoning_options": [{"type": "effort", "values": ["low", "high", "max"]}]});
        assert_eq!(levels(entry, "openrouter"), owned(&["low", "high", "xhigh"]));
    }

    #[test]
    fn thinking_levels_stay_unknown_when_nothing_describes_the_model() {
        // Silence must never be guessed into a ladder.
        assert_eq!(levels(json!({"id": "mystery"}), "openai"), None);
        // An explicit no-reasoning flag really is an empty set.
        assert_eq!(levels(json!({"reasoning": false}), "openai"), Some(Vec::new()));
    }

    #[test]
    fn a_source_naming_no_level_keeps_the_full_list() {
        // A flag alone says the model reasons, not WHICH levels it takes: no
        // ladder is invented. It is also not a "no thinking" verdict, so the
        // composer keeps its list and only the enumerated levels may be sent.
        assert_eq!(levels(json!({"reasoning": true}), "openai"), None);
        // A bare switch (effort not graded) is the same case: nothing named.
        assert_eq!(
            levels(json!({"reasoning_options": [{"type": "toggle"}]}), "openai"),
            None
        );
        // Only an explicit "off" is a verdict, and it hides the picker.
        assert_eq!(levels(json!({"reasoning": false}), "openai"), Some(Vec::new()));
    }

    /// A source stated a model reasons but named budgets, not effort tokens:
    /// that is still no level vocabulary, so no ladder is fabricated here.
    #[test]
    fn budget_only_sources_keep_the_full_list() {
        let effort_budgets = json!({
            "reasoning": true,
            "reasoning_options": [{"type": "budget_tokens", "min": 1024}]
        });
        assert_eq!(levels(effort_budgets.clone(), "anthropic"), None);
        // The budget kinds honour an enumeration exactly like any other kind.
        let enumerated = json!({
            "reasoning_options": [{"type": "effort", "values": ["low", "high"]}]
        });
        assert_eq!(levels(enumerated, "anthropic"), owned(&["low", "high"]));
        assert_eq!(levels(effort_budgets, "openai"), None);
    }
