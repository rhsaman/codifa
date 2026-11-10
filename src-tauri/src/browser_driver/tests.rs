    use super::*;

    /// The two live tests drive ONE shared Chromium; each click now carries a
    /// post-action capture, so they are slow enough to interleave (a parallel
    /// run once stole the other's front tab mid-click). Serialized on this
    /// lock; poisoned locks fall through so one failure never wedges the rest.
    static LIVE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn every_action_has_a_description_and_a_known_name() {
        // The tool schema and the route table are generated from ACTIONS, so a
        // missing description would ship an unusable tool.
        for (name, desc) in ACTIONS {
            assert!(!name.is_empty());
            assert!(!desc.is_empty(), "{name} has no description");
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{name} must be snake_case"
            );
        }
        // No duplicates: two rows with one name would advertise the tool twice.
        let mut names: Vec<&str> = ACTIONS.iter().map(|(n, _)| *n).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total);
    }

    #[test]
    fn browser_evaluate_says_it_cannot_reach_the_apps_modules() {
        // Traced: nine consecutive `browser_evaluate` rounds died on
        // `React is not defined` / `h is not a function`, because the model tried
        // to hand-build elements inside an eval that runs in PAGE scope. Naming
        // the limit in the tool description is what stops that loop before its
        // first round.
        let (_, desc) = ACTIONS
            .iter()
            .find(|(name, _)| *name == "browser_evaluate")
            .expect("browser_evaluate must exist");
        let lower = desc.to_lowercase();
        assert!(lower.contains("page scope"), "{desc}");
        assert!(lower.contains("not available"), "{desc}");
        // ...and it must point at the DOM tools instead of leaving the model
        // with no alternative.
        assert!(lower.contains("browser_click"), "{desc}");
    }

    #[test]
    fn evaluate_accepts_the_argument_names_models_actually_send() {
        // Traced: the call failed with "evaluate needs expression" while the
        // model had sent a perfectly good `script`. Every spelling is a valid
        // expression; rejecting one costs a full round-trip.
        assert_eq!(
            evaluate_script(&json!({"expression": "1+1"})),
            Some("1+1")
        );
        assert_eq!(evaluate_script(&json!({"script": "document.title"})), Some("document.title"));
        assert_eq!(evaluate_script(&json!({"code": " document.body.innerText "})), Some("document.body.innerText"));
        assert_eq!(evaluate_script(&json!({"js": "location.href"})), Some("location.href"));
        assert_eq!(evaluate_script(&json!({"expression": "   "})), None);
        assert_eq!(evaluate_script(&json!({})), None);
    }

    #[test]
    fn a_top_level_return_is_wrapped_instead_of_failing() {
        // Traced: `SyntaxError: Illegal return statement`. Runtime.evaluate takes
        // an expression, so a snippet shaped like a function body must run inside
        // one.
        let wrapped = wrap_top_level_return("const rows = [1, 2];\nreturn rows.length;");
        assert!(wrapped.starts_with("(function(){"), "{wrapped}");
        assert!(wrapped.ends_with("})()"), "{wrapped}");
        assert!(wrapped.contains("return rows.length;"), "{wrapped}");
        // A bare return (no value) is still a statement.
        assert!(wrap_top_level_return("return;").starts_with("(function(){"));
        // Awaiting snippets need an ASYNC body; the driver awaits the promise.
        let awaited = wrap_top_level_return("const x = await foo();\nreturn x;");
        assert!(awaited.starts_with("(async function(){"), "{awaited}");
        // Plain expressions and already-wrapped snippets are untouched.
        assert_eq!(wrap_top_level_return("document.title"), "document.title");
        assert_eq!(
            wrap_top_level_return("(function(){ return 1; })()"),
            "(function(){ return 1; })()"
        );
        assert_eq!(wrap_top_level_return("(() => 1)()"), "(() => 1)()");
        // A return inside a one-line callback is legal where it stands; wrapping
        // is still safe, but the detector only looks at line starts.
        assert_eq!(
            wrap_top_level_return("[1].map(function(x){return x;})"),
            "[1].map(function(x){return x;})"
        );
    }

    #[test]
    fn find_accepts_pattern_and_query_aliases() {
        assert_eq!(find_needle(&json!({"text": "hello"})), Some("hello"));
        assert_eq!(find_needle(&json!({"pattern": "hello"})), Some("hello"));
        assert_eq!(find_needle(&json!({"query": "  hello  "})), Some("hello"));
        assert_eq!(find_needle(&json!({"needle": "hello"})), Some("hello"));
        assert_eq!(find_needle(&json!({"text": "  "})), None);
        assert_eq!(find_needle(&json!({})), None);
    }

    #[test]
    fn upload_paths_accept_a_string_a_json_string_and_an_array() {
        // Traced: `file_upload needs paths` while the model had sent
        // `"paths": "[\\"/tmp/a.png\\"]"` — a JSON array in a string.
        assert_eq!(
            upload_paths(&json!({"paths": "/tmp/a.png"})),
            vec!["/tmp/a.png".to_string()]
        );
        assert_eq!(
            upload_paths(&json!({"paths": "[\"/tmp/a.png\",\"/tmp/b.png\"]"})),
            vec!["/tmp/a.png".to_string(), "/tmp/b.png".to_string()]
        );
        assert_eq!(
            upload_paths(&json!({"paths": ["/tmp/a.png", "  ", "/tmp/b.png"]})),
            vec!["/tmp/a.png".to_string(), "/tmp/b.png".to_string()]
        );
        assert!(upload_paths(&json!({})).is_empty());
        assert!(upload_paths(&json!({"paths": []})).is_empty());
    }

    #[test]
    fn an_unchanged_snapshot_answers_without_re_rendering_the_page() {
        let snap = fixture_snapshot();
        let short = unchanged_snapshot_text(&snap, 4, SNAPSHOT_SUMMARY_CHARS, false, false);
        assert!(short.contains("unchanged since refs v4"), "{short}");
        assert!(short.contains("still valid"), "{short}");
        // The whole point: the page body and its entry list are NOT resent.
        assert!(!short.contains("Unique main paragraph"), "{short}");
        assert!(!short.contains("Main Button"), "{short}");
        // The explicit re-read still renders the page (once per version).
        let full = unchanged_snapshot_text(&snap, 4, SNAPSHOT_MAX_CHARS, true, false);
        assert!(full.contains("Main Button"), "{full}");
        assert!(full.contains("Unique main paragraph"), "{full}");
        // Asking `full=true` again on the same unchanged version must not
        // resend the page: traced runs repeated it 14 times.
        let repeat = unchanged_snapshot_text(&snap, 4, SNAPSHOT_MAX_CHARS, true, true);
        assert!(repeat.contains("already sent"), "{repeat}");
        assert!(!repeat.contains("Main Button"), "{repeat}");
        assert!(!repeat.contains("Unique main paragraph"), "{repeat}");
        // A plain snapshot after a full render is still the short note.
        let plain = unchanged_snapshot_text(&snap, 4, SNAPSHOT_SUMMARY_CHARS, false, true);
        assert!(!plain.contains("Main Button"), "{plain}");
    }

    #[test]
    fn a_printed_ref_is_not_an_array_index() {
        // Regression: refs are monotonic across snapshots, so the FIRST ref of a
        // later snapshot is not `entries[0]`'s index. Reading the ref directly as
        // an index made ref [1] resolve to the SECOND element — the live test
        // clicked the input instead of the button because of exactly this.
        assert_eq!(ref_index(1, 2, 1), Some(0)); // first ref -> first entry
        assert_eq!(ref_index(1, 2, 2), Some(1));
        assert_eq!(ref_index(3, 2, 3), Some(0)); // later snapshot: base 3, ref 3
        assert_eq!(ref_index(3, 2, 4), Some(1));
        // A ref beyond this snapshot's range belongs to a NEWER one.
        assert_eq!(ref_index(3, 2, 5), None);
        // A ref below the base belongs to an OLDER snapshot.
        assert_eq!(ref_index(5, 2, 3), None);
        // Empty snapshot hands out nothing.
        assert_eq!(ref_index(7, 0, 7), None);
    }

    #[test]
    fn refs_parse_in_every_spelling_the_model_uses() {        assert_eq!(ref_of(&json!({"ref": 7})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "@7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "e7"})), Some(7));
        assert_eq!(ref_of(&json!({"ref": "ref=7"})), None);
        assert_eq!(ref_of(&json!({})), None);
    }

    #[test]
    fn modifiers_map_to_the_cdp_bitmask() {
        assert_eq!(modifier_bits(&json!({"modifiers": ["Alt"]})), 1);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Control"]})), 2);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Meta"]})), 4);
        assert_eq!(modifier_bits(&json!({"modifiers": ["Shift"]})), 8);
        assert_eq!(
            modifier_bits(&json!({"modifiers": ["Meta", "Shift"]})),
            12
        );
        assert_eq!(modifier_bits(&json!({})), 0);
        // Unknown names are ignored rather than turning into a stray bit.
        assert_eq!(modifier_bits(&json!({"modifiers": ["hyper"]})), 0);
    }

    #[test]
    fn named_and_character_keys_resolve_to_cdp_triples() {
        assert_eq!(key_triple("Enter").unwrap().0, 13);
        assert_eq!(key_triple("escape").unwrap().1, "Escape");
        assert_eq!(key_triple("PageDown").unwrap().0, 34);
        let (code, key, dom) = key_triple("a").unwrap();
        assert_eq!((code, key.as_str(), dom.as_str()), (65, "a", "KeyA"));
        let (code, _, dom) = key_triple("5").unwrap();
        assert_eq!((code, dom.as_str()), (53, "Digit5"));
        assert!(key_triple("F13").is_none());
        assert!(key_triple("").is_none());
    }

    #[test]
    fn stale_errors_are_the_only_ones_that_reconnect() {
        assert!(is_stale("the browser connection is closed"));
        assert!(is_stale("cdp error: No target with given id found"));
        assert!(is_stale("Session with given id not found."));
        // A command-level failure must NOT throw the connection away.
        assert!(!is_stale("element not found (null)"));
        assert!(!is_stale("node is not an element"));
        assert!(!is_stale("cdp Input.dispatchMouseEvent timed out"));
    }

    #[test]
    fn a_snapshot_signature_changes_with_the_page() {
        let a = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Save", "x": 1, "y": 2}],
            "text": "hello",
        });
        let b = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Save", "x": 1, "y": 2}],
            "text": "hello",
        });
        let c = json!({
            "url": "https://x/",
            "title": "X",
            "entries": [{"role": "button", "name": "Dele", "x": 1, "y": 2}],
            "text": "hello",
        });
        assert_eq!(signature(&a), signature(&b));
        assert_ne!(signature(&a), signature(&c));
    }

    #[test]
    fn unknown_actions_are_rejected_before_any_browser_is_started() {
        // `with_driver` LAUNCHES the browser when the chat has no tab, so the
        // name check must happen first: otherwise a hallucinated tool name
        // spawns a Chromium and only then fails. `is_known` is the pure gate run
        // uses for exactly that reason, so it is asserted directly here instead
        // of by calling `run` (which would start a real browser on the valid
        // path and make the test depend on the machine).
        assert!(is_known("navigate"));
        assert!(is_known("snapshot"));
        assert!(is_known("tabs"));
        assert!(!is_known("teleport"));
        assert!(!is_known(""));
        assert!(!is_known("browser_navigate"));
        // Every advertised action must pass the gate, or the tool is unusable.
        for (name, _) in ACTIONS {
            assert!(is_known(name.trim_start_matches("browser_")), "{name}");
        }
    }

    #[test]
    fn the_tool_name_the_action_name_and_the_schema_agree() {
        // Three surfaces are generated from ACTIONS (tool name, `action_of`
        // suffix, schema properties). A row that one of them misses ships a tool
        // the dispatcher cannot route, so the correspondence is asserted.
        for (name, _) in ACTIONS {
            let action = action_of(name).unwrap_or_else(|| panic!("action_of({name})"));
            assert!(handles(name));
            assert_eq!(
                action,
                name.trim_start_matches("browser_"),
                "{name} disagrees with its action"
            );
            let props = action_props(action);
            assert!(
                props.is_object(),
                "{action} must map to a properties object"
            );
            // An action with no parameters at all is legitimate (status,
            // navigate_back, snapshot), so only the shape is checked.
        }
        assert!(action_of("browser_teleport").is_none());
        assert!(!handles("teleport"));
    }

    #[test]
    fn an_unknown_action_is_rejected_by_name() {
        let err = run("teleport", &json!({}), "no-such-chat").unwrap_err();
        assert!(err.contains("unknown browser action"), "{err}");
    }

    /// End-to-end against a REAL Chromium: navigate, snapshot for refs, click a
    /// ref, type into a ref, read a value back. Ignored by default because it
    /// starts a browser and needs one installed; run with
    /// `cargo test --bin codifa -- --ignored live_driver_drives_a_real_page`.
    #[test]
    #[ignore]
    fn live_driver_drives_a_real_page() {
        let _guard = LIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let chat = format!("live-{}", std::process::id());
        let page = "data:text/html,<title>T</title><body>\
            <button id=b onclick=\"this.textContent='Clicked'\">Go</button>\
            <input id=i aria-label=\"Name\">\
            <div id=out></div></body>";
        let nav = run("navigate", &json!({"url": page}), &chat).expect("navigate");
        assert!(!nav.is_empty());

        // The navigate result already carries the summary and its refs. A
        // second plain snapshot on the unchanged page is the SHORT note now
        // (refs still valid), so the button ref comes from `nav`.
        let snap = run("snapshot", &json!({}), &chat).expect("snapshot");
        assert!(snap.contains("unchanged"), "snapshot resent the page: {snap}");
        assert!(nav.contains("[1]"), "navigate handed out no refs: {nav}");

        // The button's ref is the one whose line names the button. Match the
        // REF LINE specifically: the page URL is echoed above the list and also
        // contains the handler's source text, so a looser match picked the URL
        // line (which carries no ref) and failed the parse.
        let button_ref = nav
            .lines()
            .find(|l| l.starts_with("- [") && l.contains("button"))
            .and_then(|l| l.split('[').nth(1))
            .and_then(|r| r.split(']').next())
            .and_then(|r| r.parse::<i64>().ok())
            .expect("no ref for the button");

        let clicked = run("click", &json!({"ref": button_ref}), &chat).expect("click");
        assert!(!clicked.is_empty());

        let after = run("evaluate", &json!({"expression": "document.body.innerText"}), &chat)
            .expect("evaluate");
        assert!(
            after.contains("Clicked"),
            "the click did not fire the handler: {after}"
        );

        // Typing goes through a ref too.
        run("type", &json!({"selector": "#i", "text": "hello"}), &chat).expect("type");
        let value = run(
            "evaluate",
            &json!({"expression": "document.querySelector('#i').value"}),
            &chat,
        )
        .expect("read back");
        assert!(value.contains("hello"), "typed text did not land: {value}");
    }

    /// `- [ref] label (region)` rows of a rendered snapshot, in print order —
    /// the map the acceptance gate compares between the summary and the full
    /// render of the same snapshot.
    fn ref_label_map(text: &str) -> Vec<(usize, String)> {
        text.lines()
            .filter_map(|l| {
                let rest = l.strip_prefix("- [")?;
                let close = rest.find(']')?;
                let r: usize = rest[..close].trim().parse().ok()?;
                Some((r, rest[close + 2..].trim().to_string()))
            })
            .collect()
    }

    fn fixture_snapshot() -> Snapshot {
        // DOM order — what querySelectorAll returned: nav links first, then
        // the main content, then the footer. Refs are assigned in THIS order;
        // only the print order differs.
        let entries = vec![
            SnapEntry { role: "link".into(), name: "Menu Alpha".into(), region: "nav".into(), nth: 0 },
            SnapEntry { role: "link".into(), name: "Menu Beta".into(), region: "nav".into(), nth: 0 },
            SnapEntry { role: "heading".into(), name: "Sign in".into(), region: "dialog".into(), nth: 0 },
            SnapEntry { role: "button".into(), name: "Main Button".into(), region: "main".into(), nth: 0 },
            SnapEntry { role: "textbox".into(), name: "Search".into(), region: "main".into(), nth: 0 },
            SnapEntry { role: "link".into(), name: "Footer Link".into(), region: "footer".into(), nth: 0 },
        ];
        let mut display_order: Vec<usize> = (0..entries.len()).collect();
        display_order.sort_by_key(|&i| region_rank(&entries[i].region));
        Snapshot {
            url: "http://fixture.test/page".into(),
            title: "Fixture".into(),
            entries,
            display_order,
            headings: vec![("h1".into(), "Main Title".into())],
            main_text: "Unique main paragraph the summary must lead with.".into(),
            body_text: "Unique main paragraph the summary must lead with. Menu Alpha Menu Beta Footer Link".into(),
            base_ref: 10,
            sig: 0,
        }
    }

    #[test]
    fn render_puts_main_and_dialog_before_page_furniture() {
        let snap = fixture_snapshot();
        let text = render_snapshot(&snap, SNAPSHOT_SUMMARY_CHARS, false);
        let order: Vec<String> = ref_label_map(&text)
            .into_iter()
            .map(|(_, label)| label)
            .collect();
        // main/dialog first (in DOM order among themselves), nav last.
        let at = |name: &str| order.iter().position(|l| l.contains(name)).unwrap_or_else(|| panic!("{name} missing: {text}"));
        assert!(at("Main Button") < at("Menu Alpha"), "{text}");
        assert!(at("Sign in") < at("Menu Alpha"), "{text}");
        assert!(at("Footer Link") > at("Menu Beta"), "{text}");
        // The main TEXT leads the whole render, before any entry.
        assert!(
            text.find("Unique main paragraph").unwrap() < text.find("Main Button").unwrap(),
            "{text}"
        );
    }

    #[test]
    fn every_render_prints_the_same_ref_for_the_same_element() {
        // THE contract: a ref the model saw in a navigate summary resolves to
        // the same element in the full snapshot. All three budgets render the
        // same base_ref + index for every entry they share.
        let snap = fixture_snapshot();
        let nav = render_snapshot(&snap, SNAPSHOT_NAV_CHARS, false);
        let summary = render_snapshot(&snap, SNAPSHOT_SUMMARY_CHARS, false);
        let full = render_snapshot(&snap, SNAPSHOT_MAX_CHARS, true);
        let nav_map = ref_label_map(&nav);
        let summary_map = ref_label_map(&summary);
        let full_map = ref_label_map(&full);
        assert!(!nav_map.is_empty() && !summary_map.is_empty() && !full_map.is_empty());
        for (r, label) in nav_map.iter().chain(&summary_map) {
            let same = full_map
                .iter()
                .find(|(fr, _)| fr == r)
                .unwrap_or_else(|| panic!("ref {r} from a smaller render is missing in full"));
            assert_eq!(label, &same.1, "ref {r} means different things across renders");
        }
        // And a smaller render never INVENTS a label for a ref.
        assert!(nav_map.len() <= summary_map.len());
        assert!(summary_map.len() <= full_map.len());
    }

    #[test]
    fn a_tight_budget_drops_the_furniture_and_says_so() {
        let snap = fixture_snapshot();
        // Small but livable: the header and main text fit, the nav/footer
        // entries are what goes first, and the model is told how many more
        // exist and how to get them.
        let tight = render_snapshot(&snap, SNAPSHOT_SUMMARY_CHARS.min(420), false);
        assert!(tight.contains("Main Button"), "{tight}");
        assert!(tight.contains("Unique main paragraph"), "{tight}");
        assert!(!tight.contains("Footer Link"), "{tight}");
        assert!(tight.contains("more interactive elements"), "{tight}");
        assert!(tight.contains("full=true"), "{tight}");
        assert!(tight.len() <= 480, "render blew its budget: {}", tight.len());
        // Full keeps everything and carries the body text.
        let full = render_snapshot(&snap, SNAPSHOT_MAX_CHARS, true);
        assert!(full.contains("Footer Link"), "{full}");
        assert!(full.contains("Page text:"), "{full}");
        // A page whose body text IS its main text must not print itself twice.
        let flat = Snapshot { body_text: snap.main_text.clone(), ..snap };
        let full_flat = render_snapshot(&flat, SNAPSHOT_MAX_CHARS, true);
        assert_eq!(full_flat.matches("Unique main paragraph").count(), 1, "{full_flat}");
    }

    #[test]
    fn page_furniture_survives_a_content_heavy_page() {
        // Traced on Instagram: the feed's 100+ main entries consumed the whole
        // 6K summary, so the nav/header rows carrying the account/Profile link
        // were never printed. The browser agent then clicked a feed AUTHOR and
        // reported that stranger's profile as the logged-in account. The
        // furniture must survive a long main list: it is how the model
        // navigates (and identifies the session).
        let mut entries: Vec<SnapEntry> = (0..80)
            .map(|i| SnapEntry {
                role: "button".into(),
                name: format!("Feed action {i} with a deliberately long accessible name"),
                region: "main".into(),
                nth: 0,
            })
            .collect();
        entries.push(SnapEntry {
            role: "link".into(),
            name: "Profile".into(),
            region: "nav".into(),
            nth: 0,
        });
        let mut display_order: Vec<usize> = (0..entries.len()).collect();
        display_order.sort_by_key(|&i| region_rank(&entries[i].region));
        let snap = Snapshot {
            url: "https://fixture.test/feed".into(),
            title: "Feed".into(),
            entries,
            display_order,
            headings: vec![],
            main_text: "A long feed of posts.".into(),
            body_text: String::new(),
            base_ref: 1,
            sig: 0,
        };
        let text = render_snapshot(&snap, SNAPSHOT_SUMMARY_CHARS, false);
        assert!(text.contains("Profile"), "nav link was dropped: {text}");
        assert!(
            text.contains("Feed action 0"),
            "the summary still has to carry content: {text}"
        );
        assert!(text.len() <= SNAPSHOT_SUMMARY_CHARS + 120, "render blew its budget");
    }

    /// The REAL-page gate (plan §1): a local HTTP fixture with nav before
    /// main, real Chromium, summary and full must agree on refs, clicking a
    /// summary ref must hit the intended element, and the main text must
    /// appear before the menu. Ignored by default; run with
    /// `CODIFA_BROWSER_TESTS=1 cargo test --bin codifa -- --ignored real_page_summary_and_full_agree_on_refs`.
    #[test]
    #[ignore]
    fn real_page_summary_and_full_agree_on_refs() {
        let _guard = LIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if std::env::var("CODIFA_BROWSER_TESTS").is_err() {
            eprintln!("skipping: set CODIFA_BROWSER_TESTS=1 to run the real-page browser gate");
            return;
        }
        let page = r##"<!doctype html><html><head><title>Fixture</title></head><body>
<nav><a href="#a">Menu Alpha</a><a href="#b">Menu Beta</a></nav>
<main><h1>Main Title</h1>
<p>Unique main paragraph for the summary ordering check.</p>
<button id="counter" onclick="document.getElementById('out').textContent='clicked '+(++n)">Main Button</button>
<span id="out">unclicked</span></main>
<footer><a href="#f">Footer Link</a></footer>
<script>var n=0;</script>
</body></html>"##;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // Serve until the process ends; the test outlives a handful of
            // requests (navigate + two snapshots + evaluate) and no more.
            let body = page.as_bytes();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
                let _ = std::io::Write::write_all(&mut stream, body);
            }
        });

        let chat = format!("real-page-{}", std::process::id());
        let url = format!("http://127.0.0.1:{port}/");
        // ONE call: navigate must come back with the page's summary already.
        let nav = run("navigate", &json!({"url": url}), &chat).expect("navigate");
        assert!(nav.contains("Main Button"), "navigate carried no summary: {nav}");
        assert!(nav.contains("Unique main paragraph"), "{nav}");

        let summary = nav.clone();
        // A plain snapshot of the unchanged page is now a short note, and the
        // explicit `full=true` still re-renders for the comparison below.
        let unchanged = run("snapshot", &json!({}), &chat).expect("snapshot");
        assert!(unchanged.contains("unchanged"), "{unchanged}");
        let full = run("snapshot", &json!({"full": true}), &chat).expect("full snapshot");
        // A second `full=true` on the same unchanged version is a short note,
        // not another copy of the page.
        let repeated = run("snapshot", &json!({"full": true}), &chat).expect("repeat full snapshot");
        assert!(repeated.contains("already sent"), "{repeated}");
        assert!(!repeated.contains("Main Button"), "{repeated}");
        let summary_map = ref_label_map(&summary);
        let full_map = ref_label_map(&full);
        assert!(!summary_map.is_empty(), "no refs in summary: {summary}");
        // Same ref → same element in both renders (the unchanged-page note
        // rides along; the maps below it are what matters).
        for (r, label) in &summary_map {
            let same = full_map
                .iter()
                .find(|(fr, _)| fr == r)
                .unwrap_or_else(|| panic!("summary ref {r} missing in full: {full}"));
            assert_eq!(label, &same.1, "ref {r} disagrees between summary and full");
        }
        // Main text before menu text.
        let main_at = summary.find("Unique main paragraph").expect("main text");
        let menu_at = summary.find("Menu Alpha").expect("menu");
        assert!(main_at < menu_at, "menu outranked the main text: {summary}");

        // Clicking the summary's ref hits the intended element.
        let button_ref = summary_map
            .iter()
            .find(|(_, l)| l.contains("Main Button"))
            .expect("no ref for Main Button")
            .0 as i64;
        run("click", &json!({"ref": button_ref}), &chat).expect("click");
        let out = run(
            "evaluate",
            &json!({"expression": "document.getElementById('out').textContent"}),
            &chat,
        )
        .expect("evaluate");
        assert!(
            out.contains("clicked 1"),
            "the summary ref did not hit the main button: {out}"
        );

        drop(server);
    }
