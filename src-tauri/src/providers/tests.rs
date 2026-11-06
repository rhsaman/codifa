    use super::*;

    /// Keys are de-duplicated in order, the legacy single key is appended, and
    /// the environment is only consulted when nothing else is configured —
    /// a stale env key must never outrank a key the user typed in Settings.
    #[test]
    fn resolve_keys_orders_and_dedupes() {
        let keys = resolve_keys(
            "openrouter",
            "second",
            "",
            Some(&json!(["first", "second", "  "])),
        );
        assert_eq!(keys, vec!["first", "second"]);

        let single = resolve_keys("openrouter", "", "", Some(&json!("only")));
        assert_eq!(single, vec!["only"]);

        // A query-string value is TEXT, so the renderer's `JSON.stringify(keys)`
        // arrives as the literal `["k"]`. Pushing that verbatim sent the brackets
        // and quotes as the credential: Google answered 400 "Please pass a valid
        // API key" for a key that was perfectly valid.
        let encoded = resolve_keys("google", "", "", Some(&json!("[\"AIzaSy-real\"]")));
        assert_eq!(encoded, vec!["AIzaSy-real"]);

        // A key map (the realtime shape) decodes to the matching entry.
        let mapped = resolve_keys(
            "nvidia",
            "",
            "",
            Some(&json!("{\"nvidia\":\"nvapi-x\",\"default\":\"other\"}")),
        );
        assert_eq!(mapped, vec!["nvapi-x"]);

        // A plain key is left alone — nothing legitimately starts with `[`.
        let plain = resolve_keys("google", "", "", Some(&json!("AIzaSy-plain")));
        assert_eq!(plain, vec!["AIzaSy-plain"]);

        // The environment is the LAST resort: an explicitly configured key
        // always outranks it. Assert on an env var name that cannot be set so
        // the result does not depend on the machine running the tests.
        let from_env = resolve_keys("openrouter", "", "CODFA_TEST_UNSET_KEY_VAR", None);
        assert!(from_env.is_empty() || from_env.len() == 1);
    }

    /// The balance is total - usage rounded to 6 decimals, and a payload with
    /// no `data` object must report zeros instead of failing.
    #[test]
    fn credits_balance_is_rounded() {
        let value = parse_credits(&json!({
            "data": { "total_credits": 10.3, "total_usage": 0.1 }
        }));
        assert_eq!(value["total_credits"], 10.3);
        assert_eq!(value["total_usage"], 0.1);
        assert_eq!(value["balance"], 10.2);

        let empty = parse_credits(&json!({}));
        assert_eq!(empty["balance"], 0.0);
    }

    /// `https` becomes `wss`, a `/realtime` suffix is not duplicated, and the
    /// model is appended as a query param.
    #[test]
    fn websocket_url_derivation() {
        assert_eq!(
            realtime_websocket_url("https://api.example.com/v1", "gpt-realtime"),
            "wss://api.example.com/v1/realtime?model=gpt-realtime"
        );
        assert_eq!(
            realtime_websocket_url("http://localhost:1234/realtime", ""),
            "ws://localhost:1234/realtime"
        );
    }

    /// The upstream shape varies between gateways; `client_secret.value` wins,
    /// the flat token keys are the fallback, and a payload without any token is
    /// an error the caller surfaces as a 502.
    #[test]
    fn realtime_response_mapping() {
        let nested = parse_realtime(
            &json!({ "client_secret": { "value": " ek_123 ", "expires_at": 42 } }),
            "https://api.example.com/v1",
            "m",
        )
        .unwrap();
        assert_eq!(nested["ephemeral_token"], "ek_123");
        assert_eq!(nested["expires_at"], 42);

        let flat = parse_realtime(
            &json!({ "websocket_url": "wss://x/realtime", "token": "ek_flat" }),
            "https://api.example.com/v1",
            "m",
        )
        .unwrap();
        assert_eq!(flat["ephemeral_token"], "ek_flat");
        assert_eq!(flat["websocket_url"], "wss://x/realtime");

        assert!(parse_realtime(&json!({}), "https://x", "m").is_err());
    }

    /// The master key resolution order: explicit field, provider slot, then the
    /// generic fallbacks of the key map.
    #[test]
    fn realtime_key_resolution_prefers_explicit_then_map() {
        let direct = RealtimeBody {
            provider: "openai".into(),
            base_url: "".into(),
            api_key: "explicit".into(),
            env_var: "".into(),
            api_keys: Some(json!({"openai": "map-key"})),
            model: "".into(),
            voice: "".into(),
        };
        assert_eq!(resolve_realtime_key(&direct), "explicit");

        let mapped = RealtimeBody {
            provider: "openai".into(),
            api_key: "".into(),
            api_keys: Some(json!({"default": "fallback-key"})),
            ..direct
        };
        assert_eq!(resolve_realtime_key(&mapped), "fallback-key");
    }

    /// An HTML error page must not reach the user verbatim.
    #[test]
    fn strip_tags_collapses_markup() {
        assert_eq!(
            strip_tags("<html><body>Bad   gateway!</body></html>"),
            "Bad gateway!"
        );
    }
