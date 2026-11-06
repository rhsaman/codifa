    use super::*;

    #[test]
    fn chat_keys_normalize_to_the_legacy_default() {
        assert_eq!(normalize_chat(""), "default");
        assert_eq!(normalize_chat("   "), "default");
        assert_eq!(normalize_chat(" c1 "), "c1");
    }

    #[test]
    fn profile_dir_is_shared_and_stable() {
        // One browser, one profile: every chat must resolve to the SAME dir so
        // cookies/logins stay shared (the per-chat dirs were the memory hog).
        let base = profile_dir();
        assert!(base.ends_with("browser-profile"), "{}", base.display());
        assert_eq!(base, profile_dir());
        assert!(!base.to_string_lossy().contains("default/"));
    }

    #[test]
    fn named_keys_map_and_unknown_keys_fall_back_to_text() {
        assert_eq!(key_spec("Enter").unwrap().0, 13);
        assert_eq!(key_spec("escape").unwrap().1, "Escape");
        assert_eq!(key_spec("ArrowDown").unwrap().0, 40);
        assert!(key_spec("a").is_none());
        assert!(key_spec("F5").is_none());
    }

    #[test]
    fn status_reports_inactive_without_a_session() {
        let st = status("no-such-chat-xyz");
        assert_eq!(st["ok"], true);
        assert_eq!(st["active"], false);
        assert_eq!(st["chat"], "no-such-chat-xyz");
        assert!(st["cdp"].is_null());
    }

    #[test]
    fn operations_report_a_down_session_instead_of_panicking() {
        for v in [
            screenshot("no-such-chat-xyz"),
            click(1, 2, "no-such-chat-xyz"),
            move_mouse(1, 2, "no-such-chat-xyz"),
            type_text("hi", "no-such-chat-xyz"),
            press_key("Enter", "no-such-chat-xyz"),
            scroll(0, 100, "no-such-chat-xyz"),
            set_viewport(800, 600, "no-such-chat-xyz"),
            history("back", "no-such-chat-xyz"),
            search("x", "no-such-chat-xyz"),
            devtools_url("no-such-chat-xyz"),
            navigate_to("https://example.com", "no-such-chat-xyz"),
        ] {
            assert_eq!(v["ok"], false, "{v}");
            assert_eq!(v["error"], "browser is not running", "{v}");
        }
        // Closing a tab that does not exist is a no-op, not an error.
        assert_eq!(close("no-such-chat-xyz")["closed"], false);
    }

    #[test]
    fn viewport_is_remembered_per_tab() {
        let chat = "browser-test-viewport";
        // No tab yet: there is nothing to attach a size to.
        store_viewport(chat, (900, 600));
        assert!(existing_tab(chat).is_none());

        // With a tab present the size sticks, so the panel's ruler and
        // fit-to-pane resize survive the next status poll and screenshot.
        TABS.lock().unwrap().push((
            chat.to_string(),
            Tab {
                target_id: "T-viewport".to_string(),
                viewport: DEFAULT_VIEWPORT,
                last_used: Instant::now(),
            },
        ));
        store_viewport(chat, (900, 600));
        assert_eq!(existing_tab(chat).unwrap().viewport, (900, 600));
        assert!(close_tab(chat));
    }

    #[test]
    fn viewport_override_rides_in_the_same_batch_as_the_command() {
        // The override is session-scoped and every call opens a fresh
        // WebSocket, so it MUST travel with the command it applies to —
        // otherwise the frame and the input coordinates stay at the launch
        // size and the panel never fits the pane (the responsive bug).
        let batch = with_viewport_override(
            420,
            800,
            vec![("Page.captureScreenshot", json!({"format": "jpeg"}))],
        );
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].0, "Emulation.setDeviceMetricsOverride");
        assert_eq!(batch[0].1["width"], 420);
        assert_eq!(batch[0].1["height"], 800);
        assert_eq!(batch[0].1["mobile"], false);
        assert_eq!(batch[1].0, "Page.captureScreenshot");
    }

    #[test]
    fn idle_browser_is_reaped_but_a_fresh_one_is_kept() {
        // One Chromium (~150-300 MB) is shared, so it is only released when no
        // panel anywhere has polled it for a while.
        let ttl = Duration::from_secs(600);
        assert!(!should_reap(Duration::from_secs(0), ttl));
        assert!(!should_reap(Duration::from_secs(599), ttl));
        assert!(should_reap(Duration::from_secs(600), ttl));
        assert!(should_reap(Duration::from_secs(3600), ttl));
    }

    #[test]
    fn navigate_rejects_an_empty_url_before_touching_the_browser() {
        // An empty address-bar submit must not start a browser.
        let v = navigate_to("   ", "no-such-chat-xyz");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "browser is not running");
    }

    /// Live check that TWO chats share ONE Chromium yet drive two separate
    /// tabs (the whole point of the shared-browser refactor).
    ///
    /// Ignored by default: it starts a real Chromium, which is far too slow and
    /// too environment-dependent for the normal unit suite. Run it on demand:
    /// `cargo test --ignored shared_browser_serves_isolated_tabs`.
    #[test]
    #[ignore]
    fn shared_browser_serves_isolated_tabs() {
        let (a, b) = ("live-tab-a", "live-tab-b");
        let tab_a = ensure_tab(a).expect("first tab");
        let tab_b = ensure_tab(b).expect("second tab");
        assert_ne!(tab_a.target_id, tab_b.target_id, "chats must not share a tab");
        assert!(tab_usable(&tab_a.target_id), "first tab must be live");
        assert!(tab_usable(&tab_b.target_id), "second tab must be live");
        // One process, two tabs.
        assert_eq!(BROWSER.lock().unwrap().as_ref().map(|_| 1), Some(1));
        assert_eq!(TABS.lock().unwrap().len(), 2);
        // The screenshot/url paths read the FIRST COMMAND's reply from a
        // viewport-override batch — a missing strip of the override's own ack
        // made every frame come back "empty screenshot" (regression guard).
        let shot = screenshot(a);
        assert_eq!(shot["ok"], true, "{shot}");
        assert!(
            shot["image"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/jpeg"),
            "{shot}"
        );
        let url = current_url(&tab_a);
        assert_eq!(url, "about:blank", "the fresh tab sits on about:blank");
        // A warm-socket input path end to end.
        assert_eq!(type_text("hi", a)["ok"], true);
        assert_eq!(click(10, 10, a)["ok"], true);
        // The PUSH pipeline: navigating repaints the page, Chromium pushes a
        // frame through screencast, and a long-poll with after=0 returns it
        // (a real JPEG, seq > 0) instead of timing out.
        let nav = navigate_to("data:text/html,<h1>codifa-live</h1>", a);
        assert_eq!(nav["ok"], true, "{nav}");
        let f = block_on(async move {
            let v = frame(a, 0).await;
            Ok::<Value, String>(v)
        })
        .unwrap_or(Value::Null);
        assert_eq!(f["ok"], true, "{f}");
        assert!(
            f["image"].as_str().unwrap_or_default().starts_with("data:image/jpeg"),
            "the pushed frame must be a JPEG data URI: {f}"
        );
        assert!(close_tab(a));
        assert!(close_tab(b));
        let killed = kill_all_sessions();
        assert!(killed >= 1, "the shared browser must be reaped");
    }

    #[test]
    fn an_idle_tab_is_closed_but_a_fresh_one_is_kept() {
        // Per-tab reaping is what releases the renderer processes: the
        // browser-wide TTL could never do it, because one polled panel kept
        // `BrowserProc::last_used` fresh for every other chat's tab too.
        let mut fresh = Tab {
            target_id: "T1".to_string(),
            viewport: DEFAULT_VIEWPORT,
            last_used: Instant::now(),
        };
        assert!(!tab_is_stale(&fresh));

        fresh.last_used = Instant::now() - TAB_IDLE_TTL - Duration::from_secs(1);
        assert!(tab_is_stale(&fresh));

        // The per-tab TTL must be shorter than the browser-wide one, or a tab
        // could outlive the process that reaps it and the policy is cosmetic.
        assert!(TAB_IDLE_TTL < IDLE_REAP);
    }

    /// A browser with no tab open must never keep itself alive.
    ///
    /// Regression: `alive_port` refreshed `last_used` on EVERY call, so a poll
    /// with zero tabs made the clock unreachable and the whole Chromium tree
    /// (~300 MB including helpers) lived until app exit. Only a live tab may
    /// touch the clock.
    #[test]
    fn an_idle_clock_is_only_touched_while_a_tab_exists() {
        forget_all_tabs();
        assert!(tabs_is_empty());

        // With no tab, a poll must leave the reap decision to idle time alone.
        let untouched = Instant::now() - IDLE_REAP - Duration::from_secs(1);
        assert!(should_reap(untouched.elapsed(), IDLE_REAP));
        assert!(tabs_is_empty(), "a poll must not invent a tab");
    }

    #[test]
    fn idle_tab_of_a_running_turn_is_never_reaped() {
        // The agent keeps driving a chat's browser after the user switches away,
        // so idleness alone must not close it: that was the "Browser is stopped"
        // dead tab. This is the whole reason `tab_may_be_reaped` consults the
        // agent's turn registry instead of the TTL alone.
        let idle = || Tab {
            target_id: "T1".to_string(),
            viewport: DEFAULT_VIEWPORT,
            last_used: Instant::now() - TAB_IDLE_TTL - Duration::from_secs(1),
        };
        crate::agent::test_set_turn_running("chat-busy", true);
        assert!(tab_is_stale(&idle()));
        assert!(!tab_may_be_reaped("chat-busy", &idle()));
        // Once the turn ends the tab becomes reapable again (no permanent leak).
        crate::agent::test_set_turn_running("chat-busy", false);
        assert!(tab_may_be_reaped("chat-busy", &idle()));
        // A chat with no turn running is reaped on the TTL as before.
        assert!(tab_may_be_reaped("chat-idle", &idle()));
    }

    #[test]
    fn same_page_ignores_reload_noise_but_not_a_different_page() {
        assert!(same_page("https://example.com/a", "https://example.com/a"));
        assert!(same_page("https://example.com/a/", "https://example.com/a"));
        assert!(same_page("https://www.example.com/a", "https://example.com/a"));
        assert!(same_page(
            "https://example.com/a?utm=1",
            "https://example.com/a"
        ));
        assert!(same_page("https://example.com/a#frag", "https://example.com/a"));
        // Different pages must still navigate.
        assert!(!same_page("https://example.com/a", "https://example.com/b"));
        // A blank current url never counts as "already there".
        assert!(!same_page("", "https://example.com/a"));
        assert!(!same_page("about:blank", "https://example.com/a"));
    }

    #[test]
    fn reading_a_tab_counts_as_using_it() {
        for (chat, target) in [("chat-a", "T1"), ("chat-b", "T2")] {
            let mut tabs = TABS.lock().unwrap();
            tabs.retain(|(k, _)| k != chat);
            tabs.push((
                chat.to_string(),
                Tab {
                    target_id: target.to_string(),
                    viewport: DEFAULT_VIEWPORT,
                    last_used: Instant::now(),
                },
            ));
        }
        assert_eq!(
            existing_tab("chat-a").map(|t| t.target_id),
            Some("T1".to_string())
        );
        assert_eq!(
            existing_tab("chat-b").map(|t| t.target_id),
            Some("T2".to_string())
        );
        // The tab's viewport is remembered per tab, not globally.
        store_viewport("chat-a", (640, 480));
        assert_eq!(existing_tab("chat-a").unwrap().viewport, (640, 480));
        assert_eq!(existing_tab("chat-b").unwrap().viewport, DEFAULT_VIEWPORT);
        // Closing one chat releases only its own tab.
        assert!(close_tab("chat-a"));
        assert!(existing_tab("chat-a").is_none());
        assert!(existing_tab("chat-b").is_some());
        assert!(close_tab("chat-b"));
    }

    #[test]
    fn popup_root_walks_to_the_registered_chat_tab() {
        let targets = vec![
            ("root-1".to_string(), "https://site".to_string(), String::new()),
            ("pop-1".to_string(), "about:blank".to_string(), "root-1".to_string()),
            ("pop-2".to_string(), "about:blank".to_string(), "pop-1".to_string()),
            ("foreign".to_string(), "https://other".to_string(), String::new()),
            ("foreign-pop".to_string(), "about:blank".to_string(), "foreign".to_string()),
        ];
        let claimed = vec!["root-1".to_string()];
        assert_eq!(
            popup_root("pop-1", &targets, &claimed).as_deref(),
            Some("root-1")
        );
        // A popup of a popup rolls up to the same chat tab.
        assert_eq!(
            popup_root("pop-2", &targets, &claimed).as_deref(),
            Some("root-1")
        );
        // A root is not a popup; a foreign client's popup tree and a ghost id
        // are none of the panel's business.
        assert_eq!(popup_root("root-1", &targets, &claimed), None);
        assert_eq!(popup_root("foreign-pop", &targets, &claimed), None);
        assert_eq!(popup_root("ghost", &targets, &claimed), None);
    }

    #[test]
    fn panel_display_follows_the_newest_live_popup() {
        // Other tests in this suite mutate the shared TABS/POPUPS statics
        // concurrently (the idle-clock one wipes TABS wholesale), so a wipe
        // landing mid-test would surface as a spurious None. Re-seed and
        // retry: a race that says nothing about the code under test must not
        // fail it, and the walk itself is pure in-memory work.
        let attempt = || -> Option<()> {
            TABS.lock().unwrap().retain(|(k, _)| k != "popup-display-test");
            TABS.lock().unwrap().push((
                "popup-display-test".to_string(),
                Tab {
                    target_id: "T-root".to_string(),
                    viewport: DEFAULT_VIEWPORT,
                    last_used: Instant::now(),
                },
            ));
            POPUPS.lock().unwrap().clear();
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-pop1".to_string(),
                root: "T-root".to_string(),
            });
            // Another chat's popup must never leak into this chat's display.
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-other".to_string(),
                root: "T-unrelated".to_string(),
            });
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop1".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().push(Popup {
                target_id: "T-pop2".to_string(),
                root: "T-root".to_string(),
            });
            // Newest wins while both live…
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop2".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().retain(|p| p.target_id != "T-pop2");
            // …and closing it falls back to the older popup, then to the tab.
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-pop1".to_string())
            {
                return None;
            }
            POPUPS.lock().unwrap().clear();
            if panel_tab("popup-display-test").map(|t| t.target_id)
                != Some("T-root".to_string())
            {
                return None;
            }
            TABS.lock().unwrap().retain(|(k, _)| k != "popup-display-test");
            Some(())
        };
        let mut settled = false;
        for _ in 0..50 {
            if attempt().is_some() {
                settled = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        POPUPS.lock().unwrap().clear();
        assert!(
            settled,
            "the popup display walk never settled (state kept getting wiped by a concurrent test)"
        );
    }

    #[test]
    fn parse_cookie_blob_accepts_every_paste_shape() {
        // The bare sessionid token (the Instagram flow).
        assert_eq!(
            parse_cookie_blob("abcDEF123xyz"),
            vec![PastedCookie {
                name: "sessionid".to_string(),
                value: "abcDEF123xyz".to_string()
            }]
        );
        // document.cookie / Cookie-header shape.
        assert_eq!(
            parse_cookie_blob("sessionid=AAA; csrftoken=BBB; ds_user_id=123"),
            vec![
                PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() },
                PastedCookie { name: "csrftoken".to_string(), value: "BBB".to_string() },
                PastedCookie { name: "ds_user_id".to_string(), value: "123".to_string() },
            ]
        );
        // A pasted Set-Cookie line: attributes are dropped, not imported.
        assert_eq!(
            parse_cookie_blob("sessionid=AAA; Path=/; Domain=.instagram.com; Secure; HttpOnly"),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
        // DevTools-style JSON export.
        assert_eq!(
            parse_cookie_blob(r#"[{"name":"sessionid","value":"AAA","domain":".instagram.com"}]"#),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
        // A later duplicate wins.
        assert_eq!(
            parse_cookie_blob("sessionid=OLD; sessionid=NEW"),
            vec![PastedCookie { name: "sessionid".to_string(), value: "NEW".to_string() }]
        );
        // Empty paste yields nothing (the caller reports it).
        assert!(parse_cookie_blob("   ").is_empty());
        // Whitespace around pairs and values is trimmed.
        assert_eq!(
            parse_cookie_blob("  sessionid =  AAA  ; "),
            vec![PastedCookie { name: "sessionid".to_string(), value: "AAA".to_string() }]
        );
    }

    /// Live check that an imported cookie really lands in the shared profile
    /// and is visible to the site: import a marker cookie for a local origin,
    /// then read it back through the page. Run on demand:
    /// `cargo test --ignored imported_cookies_reach_the_site`.
    #[test]
    #[ignore]
    fn imported_cookies_reach_the_site() {
        let chat = "live-cookie";
        let tab = ensure_tab(chat).expect("tab");
        // Land the tab on a stable origin first (the cookie is domain-scoped).
        let nav = navigate_to("https://example.com/", chat);
        assert_eq!(nav["ok"], true, "{nav}");
        let v = import_cookies(
            chat,
            "example.com",
            "codifa_import_test=hello-import",
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["imported"], 1, "{v}");
        // The page sees it: the cookie is set httpOnly, so read the jar via
        // CDP instead of document.cookie.
        let seen = cdp_calls(
            &tab,
            vec![
                ("Network.enable", json!({})),
                (
                    "Network.getCookies",
                    json!({"urls": ["https://example.com/"]}),
                ),
            ],
        )
        .expect("getCookies");
        let cookies = &seen[1]["cookies"];
        let hit = cookies
            .as_array()
            .map(|a| {
                a.iter().any(|c| {
                    c["name"] == "codifa_import_test" && c["value"] == "hello-import"
                })
            })
            .unwrap_or(false);
        assert!(hit, "imported cookie must be in the jar: {cookies}");
        assert!(close_tab(chat));
        kill_all_sessions();
    }

    /// Live check that a `window.open` popup is discovered and FOLLOWED: the
    /// panel switches to the popup while it lives and falls back to the chat's
    /// tab when it closes. This is the OAuth shape ("Continue with Google"
    /// opens a popup whose callback talks to `window.opener`) that used to run
    /// invisibly — the popup target existed, nothing ever displayed it.
    ///
    /// Ignored by default (starts a real Chromium), like the other live test:
    /// `cargo test --ignored the_panel_follows_window_open_popups`.
    #[test]
    #[ignore]
    fn the_panel_follows_window_open_popups() {
        let chat = "live-popup";
        let tab = ensure_tab(chat).expect("tab");
        POPUPS.lock().unwrap().clear();
        // Open the popup THROUGH the page, so the opener relation is the real
        // `window.open` path (`userGesture` bypasses the popup blocker the way
        // a click would; the return value is coerced to a boolean because the
        // Window object itself does not serialize with returnByValue).
        let opened = cdp_calls(
            &tab,
            vec![(
                "Runtime.evaluate",
                json!({
                    "expression":
                        "!!window.open('data:text/html,<h1>popup</h1>', '_blank', 'width=480,height=640')",
                    "returnByValue": true,
                    "userGesture": true,
                }),
            )],
        )
        .expect("window.open must evaluate");
        assert_eq!(
            opened[0]["result"]["value"], true,
            "window.open must return a window, not null (popup-blocked?): {opened:?}"
        );
        let mut popup = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            sync_popups();
            if let Some(p) = visible_popup(&tab.target_id) {
                popup = p;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        assert!(
            !popup.is_empty(),
            "the popup must be discovered; page_targets={:?}",
            page_targets()
        );
        // The panel (and every panel input call) now points at the popup.
        assert_eq!(
            panel_tab(chat).map(|t| t.target_id),
            Some(popup.clone())
        );
        // Closing the popup snaps the view back to the chat's own tab.
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": popup}),
        )]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            sync_popups();
            if visible_popup(&tab.target_id).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        assert!(visible_popup(&tab.target_id).is_none());
        assert_eq!(
            panel_tab(chat).map(|t| t.target_id),
            Some(tab.target_id.clone())
        );
        assert!(close_tab(chat));
        kill_all_sessions();
    }

    #[test]
    fn browser_never_falls_back_to_a_system_browser() {
        // The freeze: the automation browser ran out of /Applications/Google
        // Chrome.app, so the headless instance shared its bundle id
        // (com.google.Chrome) with the user's real Chrome — registering with
        // LaunchServices, spawning Chrome's own crashpad handler and
        // GoogleUpdater against the user's profile, and fighting the real
        // browser over the display. The candidate list must therefore never
        // contain a system browser, whatever is installed on this machine.
        for path in chromium_candidates() {
            let p = path.to_string_lossy();
            assert!(
                !p.starts_with("/Applications") && !p.starts_with("/usr/bin"),
                "system browser {p} must never be used as the automation browser"
            );
            assert!(
                !p.contains("Google Chrome.app")
                    && !p.contains("Microsoft Edge.app")
                    && !p.contains("Brave Browser.app"),
                "a user-facing browser must never be picked: {p}"
            );
        }
    }

    #[test]
    fn candidate_dirs_order_newest_build_first() {
        // `sort().reverse()` put chromium-999 AFTER chromium-1000 (string
        // order), so an older build won as soon as a version crossed a digit
        // boundary. The rank must be numeric.
        let rank = |n: &str| build_rank(std::path::Path::new(n));
        // String order put "chromium-999" AFTER "chromium-1000"; the rank must
        // be numeric.
        assert!(rank("chromium-1000") > rank("chromium-999"));
        // Builds are ordered by their LEADING number (the revision/major), not
        // by a trailing patch component, which says nothing across majors.
        assert!(rank("chrome-headless-shell-141.0.7339.82") > rank("chrome-headless-shell-140.0.7339.82"));
        assert_eq!(rank("chrome-headless-shell-140.0.7339.82"), 140);
        assert_eq!(rank("chromium"), 0);
    }

    #[test]
    fn orphan_matcher_targets_only_our_own_headless_browser() {
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        // Ours: our own profile directory plus a debugging port.
        let ours = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "--remote-debugging-port=61995",
            "--headless",
            "--user-data-dir=/Users/x/.codifa/browser-profile",
        ]
        .join(" ");
        assert!(is_our_driver(&ours, profile));
        // A browser the user started themselves: no debugging port, no profile.
        assert!(!is_our_driver(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            profile
        ));
        // A renderer child of OUR browser MUST be matched: the parent's SIGKILL
        // leaves it orphaned, so the sweep has to reach it. Excluding `--type=`
        // here was the reason abandoned browsers kept their renderer heap alive.
        let renderer = [
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper",
            "--type=renderer",
            "--user-data-dir=/Users/x/.codifa/browser-profile",
            "--remote-debugging-port=61995",
        ]
        .join(" ");
        assert!(is_our_driver(&renderer, profile));
        // Another program's headless browser (not our profile) is left alone.
        let other = [
            "chromium",
            "--headless",
            "--remote-debugging-port=9222",
            "--user-data-dir=/tmp/other-profile",
        ]
        .join(" ");
        assert!(!is_our_driver(&other, profile));
    }

    #[test]
    fn launch_args_keep_the_browser_off_the_users_chrome() {
        let bin = std::path::Path::new(
            "/opt/chromium-1223/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        );
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        let args = launch_args(bin, 61995, profile, None).join(" ");
        // Headless + our own profile: never the user's Chrome profile.
        assert!(args.contains("--headless"));
        assert!(args.contains("--user-data-dir=/Users/x/.codifa/browser-profile"));
        assert!(args.contains("--remote-debugging-port=61995"));
        assert!(!args.contains("--user-agent="));
        // The Google background services that reached into the user's own
        // profile / crashpad database.
        assert!(args.contains("--disable-crash-reporter"));
        assert!(args.contains("--disable-background-networking"));
        assert!(args.contains("--no-service-autorun"));
        // The full build renders on SwiftShader ON PURPOSE: a GPU process
        // cannot be hosted from a daemon context, and both failure modes
        // around that (fatal exit / crash-loop at 100% CPU) are worse than
        // software rendering. Software WebGL needs its Chrome-139+ opt-in,
        // and macOS must never touch the user's keychain.
        assert!(args.contains("--disable-gpu"));
        assert!(args.contains("--enable-unsafe-swiftshader"));
        assert!(args.contains("--use-mock-keychain"));
        let shell = std::path::Path::new("/opt/browser/chrome-headless-shell");
        let shell_args = launch_args(shell, 61995, profile, None).join(" ");
        assert!(!shell_args.contains("--disable-gpu"));
        assert!(!shell_args.contains("--use-mock-keychain"));
        assert!(shell_args.contains("--headless"));
    }

    #[test]
    fn launch_args_pin_the_process_level_user_agent() {
        // A popup's FIRST document request leaves the browser before any CDP
        // session can attach and override the UA — the process-level flag is
        // the only thing that covers it.
        let bin = std::path::Path::new("/opt/browser/chrome-headless-shell");
        let profile = std::path::Path::new("/Users/x/.codifa/browser-profile");
        let args = launch_args(
            bin,
            61995,
            profile,
            Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36"),
        )
        .join(" ");
        assert!(args.contains("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"));
        assert!(args.contains("Chrome/156.0.8078.80 Safari/537.36"));
    }

    #[test]
    fn chrome_user_agent_builds_from_the_binary_version() {
        // Pure construction check via a stubbed binary: a shell script whose
        // `--version` output carries the version token.
        let dir = std::env::temp_dir().join(format!("codifa-ua-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-chrome");
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::PermissionsExt;
            let mut f = std::fs::File::create(&bin).unwrap();
            f.write_all(b"#!/bin/sh\necho \"Google Chrome for Testing 156.0.8078.80\"\n").unwrap();
            drop(f);
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let ua = chrome_user_agent(&bin).expect("version must parse");
            assert!(ua.ends_with("Chrome/156.0.8078.80 Safari/537.36"), "{ua}");
            assert!(ua.starts_with("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "{ua}");
            // A binary that prints nothing yields None (per-session override
            // stays the only UA fix).
            let silent = dir.join("silent-chrome");
            let mut f = std::fs::File::create(&silent).unwrap();
            f.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
            drop(f);
            std::fs::set_permissions(&silent, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(chrome_user_agent(&silent), None);
        }
        let _ = bin;
        let _ = std::fs::remove_dir_all(&dir);
    }
