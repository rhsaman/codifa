    use super::*;

    #[test]
    fn frontmatter_names_tools_and_body() {
        let raw = "---\nname: reviewer\ndescription: Reviews a diff\ntools: read, grep\n---\n\nYou review.\n";
        let p = parse_profile(raw, "fallback");
        assert_eq!(p["name"], "reviewer");
        assert_eq!(p["description"], "Reviews a diff");
        assert_eq!(p["tools"], json!(["grep", "read"]));
        assert_eq!(p["prompt"], "You review.");
    }

    #[test]
    fn block_list_tools_are_read_too() {
        let raw = "---\nname: x\ntools:\n  - read\n  - find_symbol\n---\nbody";
        let p = parse_profile(raw, "x");
        assert_eq!(p["tools"], json!(["find_symbol", "read"]));
    }

    #[test]
    fn a_nameless_profile_falls_back_to_its_file_stem() {
        let p = parse_profile("no frontmatter here", "judge");
        assert_eq!(p["name"], "judge");
        assert_eq!(p["prompt"], "no frontmatter here");
    }
