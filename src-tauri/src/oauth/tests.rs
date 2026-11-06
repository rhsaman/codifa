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
