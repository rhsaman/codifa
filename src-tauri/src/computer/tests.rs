    use super::*;

    #[test]
    fn schema_advertises_every_action() {
        let actions = schema()["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for expected in [
            "screenshot",
            "list_screens",
            "click",
            "double_click",
            "right_click",
            "move",
            "drag",
            "type",
            "key",
            "scroll",
        ] {
            assert!(
                actions.iter().any(|a| a.as_str() == Some(expected)),
                "missing {expected}"
            );
        }
        // Drag, the screenshot targeting arguments and the mouse-button
        // arguments must be describable, or the model has no way to issue them.
        let props = &schema()["function"]["parameters"]["properties"];
        for expected in ["to_x", "to_y", "display", "window", "button", "clicks", "reason"] {
            assert!(
                props[expected].is_object(),
                "the schema must declare `{expected}`: a model cannot pass an argument it was never told about"
            );
        }
    }

    #[test]
    fn permission_reason_names_the_act_and_its_target() {
        // The permission card must answer "allow WHAT?", not repeat the tool
        // name. Each action states its own act and, when it has one, target.
        assert_eq!(
            permission_reason(
                &json!({"action": "screenshot", "reason": "The user asked me to read the crash dialog"})
            ),
            "The user asked me to read the crash dialog"
        );
        assert_eq!(
            permission_reason(&json!({"action": "screenshot", "window": "Chrome"})),
            "Take a screenshot of the `Chrome` window."
        );
        assert_eq!(
            permission_reason(&json!({"action": "click", "x": 10, "y": 20})),
            "Click the desktop at (10, 20)."
        );
        assert_eq!(
            permission_reason(&json!({"action": "click", "x": 10, "y": 20, "button": "right"})),
            "Right-click the desktop at (10, 20)."
        );
        assert_eq!(
            permission_reason(&json!({"action": "type", "text": "hello"})),
            "Type \"hello\" into an app."
        );
        assert_eq!(
            permission_reason(&json!({"action": "key", "key": "return"})),
            "Press the `return` key on the desktop."
        );
        assert_eq!(
            permission_reason(
                &json!({"action": "drag", "x": 1, "y": 2, "to_x": 3, "to_y": 4})
            ),
            "Drag the mouse from (1, 2) to (3, 4)."
        );
        assert_eq!(
            permission_reason(&json!({"action": "screenshot"})),
            "Take a screenshot of the desktop."
        );
    }

    #[test]
    fn key_codes_cover_the_documented_names() {
        assert_eq!(key_code("return"), Some(36));
        assert_eq!(key_code("Escape"), Some(53));
        assert_eq!(key_code("nope"), None);
    }

    #[test]
    fn unknown_action_is_rejected_without_touching_the_desktop() {
        let err = run(&json!({"action": "explode"})).unwrap_err();
        assert!(err.contains("unknown computer action"), "{err}");
    }

    #[test]
    fn missing_coordinates_are_reported() {
        let err = run(&json!({"action": "click"})).unwrap_err();
        assert!(err.contains("`x` and `y` are required"), "{err}");
    }

    #[test]
    fn unknown_button_is_rejected() {
        let err = run(&json!({"action": "click", "x": 1, "y": 1, "button": "middle"})).unwrap_err();
        assert!(err.contains("\"left\" or \"right\""), "{err}");
    }

    #[test]
    fn shot_names_are_unique() {
        // Two captures in the same millisecond must not share a path: the image
        // cache and the history re-read both key off the file.
        let a = shot_path().unwrap();
        let b = shot_path().unwrap();
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains("codifa-computer"));
    }

    #[test]
    fn prepare_never_upscales_and_respects_the_edge_cap() {
        let display = Display {
            x: 0,
            y: 0,
            width: 1600,
            height: 1000,
            scale: 2.0,
            primary: true,
        };
        // A 2x capture of a 1600x1000 display becomes 1600x1000 (1px per point).
        let big = image::DynamicImage::from(image::RgbaImage::new(3200, 2000));
        let got = prepare(big, &display);
        assert_eq!((got.width(), got.height()), (1600, 1000));

        // A 1x display holding an already-small image is left alone.
        let small_display = Display { scale: 1.0, width: 800, height: 600, ..display };
        let small = image::DynamicImage::from(image::RgbaImage::new(800, 600));
        let got = prepare(small, &small_display);
        assert_eq!((got.width(), got.height()), (800, 600));

        // Anything longer than the cap is cut to it.
        let huge = image::DynamicImage::from(image::RgbaImage::new(6000, 3000));
        let got = prepare(huge, &small_display);
        assert_eq!(got.width(), MAX_IMAGE_EDGE);
        assert_eq!(got.height(), MAX_IMAGE_EDGE / 2);
    }
