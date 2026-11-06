    use super::*;

    fn cfg(kind: &str, base: &str, keys: Value) -> Value {
        json!({ "kind": kind, "baseUrl": base, "apiKeys": keys })
    }

    /// The ladder puts the primary rung first with the requested model, then
    /// every routable fallback with its OWN model; rows naming a missing or
    /// deleted provider are skipped instead of poisoning the ladder.
    #[test]
    fn ladder_orders_primary_then_fallbacks() {
        let providers = std::collections::HashMap::from([
            ("a".to_string(), cfg("openai", "https://a/v1", json!(["k1"]))),
            ("b".to_string(), cfg("google", "https://b", json!(["k2"]))),
        ]);
        let ladder = media_ladder(
            "a",
            "gpt-image-1",
            &[
                json!({"providerId": "b", "model": "gemini-2.5-flash-image"}),
                json!({"providerId": "gone", "model": "x"}),
                json!({"providerId": "", "model": "y"}),
            ],
            &providers,
        );
        assert_eq!(ladder.len(), 2);
        assert_eq!(ladder[0].base_url, "https://a/v1");
        assert_eq!(ladder[0].model, "gpt-image-1");
        assert_eq!(ladder[0].keys, vec!["k1"]);
        assert_eq!(ladder[1].kind, "google");
        assert_eq!(ladder[1].model, "gemini-2.5-flash-image");

        // An empty provider id (slot not configured) with NO routable fallback
        // leaves an empty ladder — the caller reports "not configured".
        assert!(media_ladder("", "", &[], &providers).is_empty());
    }

    /// The legacy single-key field feeds the ladder when `apiKeys` is absent,
    /// and the environment is the last resort.
    #[test]
    fn target_reads_legacy_key_then_env() {
        let legacy = json!({ "kind": "openai", "baseUrl": "https://x/v1/", "apiKey": "sk-legacy" });
        let t = target_from_cfg(&legacy, "m").unwrap();
        assert_eq!(t.base_url, "https://x/v1"); // trailing slash trimmed
        assert_eq!(t.keys, vec!["sk-legacy"]);

        // No keys anywhere: an unset env leaves the rung KEYLESS (still usable
        // for keyless gateways), not None — a missing key must surface as the
        // provider's own 401, not as a mysterious "no provider".
        let keyless = json!({ "kind": "openai", "baseUrl": "https://x/v1" });
        let t = target_from_cfg(&keyless, "m").unwrap();
        assert!(t.keys.is_empty());

        // No base URL at all: not a rung.
        assert!(target_from_cfg(&json!({ "kind": "openai" }), "m").is_none());
    }

    /// A Google provider row carries the OpenAI-compat base
    /// (`…/v1beta/openai`) so chat keeps working; every media URL must still
    /// land on `…/v1beta/models/…`. Appending straight to the saved base sent
    /// image/video calls to `…/v1beta/openai/models/…` — a 404 each time.
    #[test]
    fn google_media_urls_use_the_native_prefix() {
        let compat = "https://generativelanguage.googleapis.com/v1beta/openai";
        assert_eq!(
            gemini_media_url(compat, "models/gemini-2.5-flash-image:generateContent"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent"
        );
        // The bare native base and a trailing slash must resolve identically.
        for base in [
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/",
        ] {
            assert_eq!(
                gemini_media_url(base, "/models/veo-3:predictLongRunning"),
                "https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning"
            );
        }
        // A gateway that keeps a path prefix in front of the suffix survives.
        assert_eq!(
            gemini_media_url("https://proxy/gemini/v1beta/openai", "models/m:generateContent"),
            "https://proxy/gemini/v1beta/models/m:generateContent"
        );
    }

    #[test]
    fn openai_request_shapes() {
        let body = openai_images_request("gpt-image-1", "a cat", Some("1024x1536"));
        assert_eq!(body["model"], "gpt-image-1");
        assert_eq!(body["size"], "1024x1536");
        assert_eq!(body["response_format"], "b64_json");
        assert_eq!(body["n"], 1);

        let plain = openai_images_request("m", "p", None);
        assert!(plain.get("size").is_none());

        let fields = openai_edit_fields("gpt-image-1", "make it night", Some("512x512"));
        assert_eq!(fields[0], ("model".into(), "gpt-image-1".into()));
        assert_eq!(fields[1], ("prompt".into(), "make it night".into()));
        assert_eq!(fields[2], ("size".into(), "512x512".into()));
    }

    /// Every `/images` answer shape a gateway ships: b64 in data[], a URL, or
    /// a flattened top-level b64 (proxies).
    #[test]
    fn openai_parse_covers_b64_url_and_flat() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake");
        let payload = openai_images_parse(&json!({ "data": [{ "b64_json": b64 }] })).unwrap();
        match payload {
            ImagePayload::Bytes(bytes, mime) => {
                assert_eq!(bytes, b"\x89PNG fake");
                assert_eq!(mime, "image/png");
            }
            _ => panic!("expected bytes"),
        }

        let url = openai_images_parse(&json!({ "data": [{ "url": "https://cdn/x.png" }] })).unwrap();
        assert!(matches!(url, ImagePayload::Url(u) if u == "https://cdn/x.png"));

        let flat = openai_images_parse(&json!({ "data": [], "b64_json": b64 }));
        // Flattened shapes are OUT of contract (data[] missing/empty errors) —
        // the error names the problem instead of panicking.
        assert!(flat.is_err());
    }

    #[test]
    fn gemini_body_and_parse() {
        let body = gemini_image_body("a cat", Some((&b"IMG"[..], "image/png")));
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["text"], "a cat");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/png");
        assert_eq!(
            parts[1]["inlineData"]["data"],
            base64::engine::general_purpose::STANDARD.encode(b"IMG")
        );

        let b64 = base64::engine::general_purpose::STANDARD.encode(b"JPEGDATA");
        let resp = json!({ "candidates": [{ "content": { "parts": [
            { "text": "here you go" },
            { "inlineData": { "mimeType": "image/jpeg", "data": b64 } }
        ] } }] });
        match gemini_image_parse(&resp).unwrap() {
            ImagePayload::Bytes(bytes, mime) => {
                assert_eq!(bytes, b"JPEGDATA");
                assert_eq!(mime, "image/jpeg");
            }
            _ => panic!("expected bytes"),
        }

        // Text-only response: the note becomes the error so the model learns
        // WHY nothing was generated (safety block, quota, …).
        let err = gemini_image_parse(&json!({ "candidates": [{ "content": { "parts": [
            { "text": "blocked for safety" }
        ] } }] })).unwrap_err();
        assert!(err.contains("blocked for safety"));
    }

    #[test]
    fn sora_body_and_status() {
        let body = sora_create_body("sora-2", "waves", Some(8), Some("1280x720"));
        assert_eq!(body["model"], "sora-2");
        assert_eq!(body["seconds"], "8"); // the API takes the seconds as a STRING
        assert_eq!(body["size"], "1280x720");

        assert!(matches!(
            sora_status_parse(&json!({ "status": "in_progress" })),
            VideoJobState::Running
        ));
        assert!(matches!(
            sora_status_parse(&json!({ "status": "completed" })),
            VideoJobState::Done
        ));
        match sora_status_parse(&json!({ "status": "failed", "error": { "message": "quota" } })) {
            VideoJobState::Failed(e) => assert_eq!(e, "quota"),
            _ => panic!("expected failure"),
        }
    }

    #[test]
    fn veo_body_and_operation_parse() {
        let body = veo_predict_body("a bird", Some((&b"IMG"[..], "image/png")), Some(12), Some("720x1280"));
        assert_eq!(body["instances"][0]["prompt"], "a bird");
        assert_eq!(body["instances"][0]["image"]["mimeType"], "image/png");
        // Veo caps at 8s: the request is clamped, not forwarded to fail upstream.
        assert_eq!(body["parameters"]["durationSeconds"], 8);
        assert_eq!(body["parameters"]["aspectRatio"], "9:16");

        let done = json!({ "done": true, "response": { "generateVideoResponse": {
            "generatedSamples": [{ "video": { "uri": "https://f/files/a:download" } }]
        } } });
        assert_eq!(
            veo_operation_video_uri(&done).unwrap().as_deref(),
            Some("https://f/files/a:download")
        );

        // Newer shape (videos[].gcsUri) and the pending state both parse.
        let newer = json!({ "done": true, "response": { "videos": [{ "gcsUri": "https://f/b" }] } });
        assert_eq!(veo_operation_video_uri(&newer).unwrap().as_deref(), Some("https://f/b"));
        assert!(veo_operation_video_uri(&json!({ "done": false })).unwrap().is_none());

        let failed = json!({ "done": true, "error": { "message": "safety" } });
        assert_eq!(veo_operation_video_uri(&failed).unwrap_err(), "safety");
    }

    #[test]
    fn naming_and_markdown() {
        let now = chrono::Utc::now();
        let p = new_media_path("image", "png", now);
        assert!(p.starts_with("media/image-"));
        assert!(p.ends_with(".png"));
        assert_eq!(p.matches('-').count(), 3); // kind-, date-, time- tag
        // Two names minted in the same second must still differ.
        assert_ne!(p, new_media_path("image", "png", now));

        assert_eq!(codifa_media_ref("media/a.png"), "codifa-media://media/a.png");

        let row = media_file_row("media/a.mp4", 123, "video/mp4");
        assert_eq!(row["url"], "codifa-media://media/a.mp4");
        assert_eq!(row["bytes"], 123);

        assert_eq!(ext_for_mime("image/jpeg", "png"), "jpg");
        assert_eq!(ext_for_mime("video/mp4", "bin"), "mp4");
        assert_eq!(ext_for_mime("weird/mime", "png"), "png");
    }

    #[test]
    fn ffprobe_parsing() {
        let body = json!({
            "format": { "duration": "3.5" },
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720, "avg_frame_rate": "30000/1001" },
                { "codec_type": "audio", "codec_name": "aac" }
            ]
        });
        let info = ffprobe_parse(&body).unwrap();
        assert_eq!(info.duration_secs, 3.5);
        assert_eq!(info.width, 1280);
        assert_eq!(info.height, 720);
        assert!((info.fps - 29.97).abs() < 0.01);
        assert_eq!(info.video_codec, "h264");
        assert_eq!(info.audio_codec, "aac");

        let line = media_info_line("media/a.mp4", &info);
        assert!(line.starts_with("media/a.mp4: 3.50s, 1280x720"));
        assert!(line.contains("video=h264"));

        assert!(ffprobe_parse(&json!({})).is_err());
    }

    #[test]
    fn mask_region_args() {
        let obj = json!({ "x": 10, "y": 20, "w": 100, "h": 50 });
        assert_eq!(
            MaskRegion::from_args(&obj),
            Some(MaskRegion { x: 10, y: 20, w: 100, h: 50 })
        );
        // The array spelling and zero origins both parse.
        assert_eq!(
            MaskRegion::from_args(&json!([0, 0, 640, 480])),
            Some(MaskRegion { x: 0, y: 0, w: 640, h: 480 })
        );
        // Zero area is refused: it would reach a provider as a useless mask.
        assert_eq!(MaskRegion::from_args(&json!([5, 5, 0, 100])), None);
        assert_eq!(MaskRegion::from_args(&json!({ "x": 1, "y": 1 })), None);
    }

    #[test]
    fn data_url_and_openrouter_parse() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNGxx");
        let url = format!("data:image/png;base64,{b64}");
        let (bytes, mime) = parse_data_url(&url).unwrap();
        assert_eq!(bytes, b"\x89PNGxx");
        assert_eq!(mime, "image/png");
        assert!(parse_data_url("https://cdn/x.png").is_none());

        let resp = json!({ "choices": [{ "message": {
            "images": [{ "image_url": { "url": url } }]
        } }] });
        match openrouter_image_parse(&resp).unwrap() {
            ImagePayload::Bytes(b, m) => {
                assert_eq!(b, b"\x89PNGxx");
                assert_eq!(m, "image/png");
            }
            _ => panic!("expected bytes"),
        }

        // An https answer is forwarded for the caller to download.
        let remote = openrouter_image_parse(&json!({ "choices": [{ "message": {
            "images": [{ "image_url": { "url": "https://cdn/x.png" } }]
        } }] }))
        .unwrap();
        assert!(matches!(remote, ImagePayload::Url(u) if u == "https://cdn/x.png"));

        // Text-only = the model's own refusal, carried as the error.
        let refused = openrouter_image_parse(&json!({ "choices": [{ "message": {
            "content": "I cannot generate that"
        } }] }))
        .unwrap_err();
        assert!(refused.contains("I cannot generate that"));
    }

    #[test]
    fn openrouter_body_carries_modalities_and_reference() {
        let body = openrouter_image_body("ag/gemini-image", "a cat", Some((&b"IMG"[..], "image/png")));
        assert_eq!(body["model"], "ag/gemini-image");
        assert_eq!(body["modalities"], json!(["image", "text"]));
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert!(content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    /// The edits mask: transparent exactly inside the region (OpenAI's "edit
    /// here" convention), opaque elsewhere, and both outputs are the INPUT's
    /// size so the multipart pair can never mismatch.
    #[test]
    fn edit_pngs_mask_matches_region() {
        // A 4x4 red PNG.
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let (input_png, mask_png) =
            build_edit_pngs(&png, MaskRegion { x: 1, y: 1, w: 2, h: 2 }).unwrap();
        let decoded = image::load_from_memory(&input_png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (4, 4));
        let mask = image::load_from_memory(&mask_png).unwrap().to_rgba8();
        assert_eq!(mask.get_pixel(0, 0).0[3], 255); // outside = opaque
        assert_eq!(mask.get_pixel(1, 1).0[3], 0); // inside = transparent
        assert_eq!(mask.get_pixel(2, 2).0[3], 0);
        assert_eq!(mask.get_pixel(3, 0).0[3], 255);
    }

    #[test]
    fn virtual_paths_are_chat_scoped_and_contained() {
        // The virtual path embeds the SANITIZED chat slug: a hostile chat id
        // cannot become a path component.
        assert_eq!(
            media_virtual("../evil/chat", "a.png"),
            format!("{MEDIA_DIR}/chat-evil/a.png").replace("chat-evil", &crate::skills::safe_file("../evil/chat", "chat"))
        );
        // Directory components in the requested name are stripped: the file
        // always lands DIRECTLY in the chat's media folder.
        assert_eq!(
            media_virtual("c1", "../../etc/passwd"),
            format!("{MEDIA_DIR}/{}/passwd", crate::skills::safe_file("c1", "chat"))
        );

        let tmp = std::env::temp_dir().join(format!("codifa-mtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let data_root = tmp.to_string_lossy().into_owned();

        // A virtual path resolves INSIDE the media root and accepts the
        // "media/" prefix spelling the tool results carry.
        let p = resolve_media_virtual(&data_root, "media/c1/x.png").unwrap();
        assert!(p.starts_with(tmp.join(MEDIA_DIR).join(crate::skills::safe_file("c1", "chat"))));

        // Traversal is refused outright.
        assert!(resolve_media_virtual(&data_root, "media/c1/../../etc/passwd").is_err());
        assert!(resolve_media_virtual(&data_root, "").is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn composite_region_touches_only_the_patch() {
        // A 10x10 base, all red; a 4x4 all-blue patch pasted at (3,3) with
        // NO feather — everything outside (3..7, 3..7) must stay EXACTLY red,
        // which is the "edit only what I marked" guarantee.
        let mut base = image::RgbaImage::from_pixel(10, 10, image::Rgba([255, 0, 0, 255]));
        let patch = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 255, 255]));
        composite_region(&mut base, patch, 3, 3, 0);
        assert_eq!(base.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(base.get_pixel(9, 9).0, [255, 0, 0, 255]);
        assert_eq!(base.get_pixel(2, 3).0, [255, 0, 0, 255]);
        assert_eq!(base.get_pixel(7, 5).0, [255, 0, 0, 255]);
        assert_eq!(base.get_pixel(4, 4).0, [0, 0, 255, 255]);
    }

    #[test]
    fn composite_region_feathers_the_rim() {
        // With feather=2 the outermost ring keeps mostly the base color and
        // the center goes fully to the patch — the seam cannot show a hard
        // rectangle edge.
        let mut base = image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 0, 255]));
        let patch = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 255, 255]));
        composite_region(&mut base, patch, 2, 2, 2);
        // Outermost rim: feather t=0 — untouched base, no hard edge.
        assert_eq!(base.get_pixel(2, 2).0, [255, 0, 0, 255]);
        // One step in (d_edge=1, feather=2): a 50/50 blend of base and patch.
        assert_eq!(base.get_pixel(3, 3).0, [128, 0, 127, 255]);
    }

    #[test]
    fn crop_context_clamps_to_bounds() {
        let img = image::RgbaImage::from_pixel(20, 20, image::Rgba([0, 0, 0, 255]));
        // A region hugging the bottom-right corner: the crop clamps and never
        // exceeds the image, and stays at least 1x1.
        let (crop, rect) = crop_with_context(
            &img,
            MaskRegion { x: 18, y: 18, w: 5, h: 5 },
            4,
        );
        assert_eq!(rect.x, 14);
        assert_eq!(rect.y, 14);
        assert_eq!(rect.w, 6);
        assert_eq!(rect.h, 6);
        assert_eq!(crop.dimensions(), (6, 6));
    }

    #[test]
    fn summary_line_carries_markdown_and_provider() {
        let media = GeneratedMedia {
            rel_path: "media/image-x.png".into(),
            bytes: 9,
            mime: "image/png".into(),
        };
        let line = generated_summary("image", &media, "openrouter");
        assert!(line.contains("![media/image-x.png](codifa-media://media/image-x.png)"));
        assert!(line.contains("via openrouter"));
        assert!(line.contains("VERBATIM"));
    }
