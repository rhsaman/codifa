    use super::*;

    #[test]
    fn applescript_literal_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_literal(r#"a"b\c"#), r#"a\"b\\c"#);
    }

    #[test]
    fn windows_parser_keeps_only_real_windows() {
        // Third row has a bogus size (menu bar item) and must be dropped; the
        // last row is truncated and must not panic.
        let raw = "Finder\ttabs\t10\t20\t800\t600\nSafari\tDocs\t0\t0\t1440\t900\n\
                   SystemUIServer\t\t0\t-22\t1440\t22\nSafari\tbroken\t5\n";
        let got = parse_windows(raw);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].app, "Finder");
        assert_eq!(got[0].width, 800.0);
        assert_eq!(got[1].title, "Docs");
    }

    #[test]
    fn display_at_matches_the_display_holding_the_point() {
        let screens = [
            Display { x: 0, y: 0, width: 1440, height: 900, scale: 1.0, primary: true },
            Display { x: 1440, y: 0, width: 1920, height: 1080, scale: 2.0, primary: false },
        ];
        assert_eq!(display_at(&screens, 100.0, 100.0), Some(0));
        assert_eq!(display_at(&screens, 1500.0, 500.0), Some(1));
        // The right edge is exclusive: 2880 belongs to no display.
        assert_eq!(display_at(&screens, 3400.0, 500.0), None);
    }
