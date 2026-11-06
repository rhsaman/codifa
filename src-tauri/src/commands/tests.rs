    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codifa-rs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The old comparison read `v2.1.0-rc1` as `[2,1,0]` and pushed an RC to
    /// the whole stable base. A prerelease must only be offered to prerelease
    /// builds.
    #[test]
    fn version_compare_offers_prereleases_only_to_prerelease_builds() {
        assert!(!is_newer("2.0.2", "2.1.0-rc1"), "stable user must not see an RC");
        assert!(!is_newer("2.1.0", "2.1.0-rc1"), "the release wins over its own rc");
        assert!(is_newer("2.1.0-rc1", "2.1.0"), "rc → final is an upgrade");
        assert!(is_newer("2.1.0-rc1", "2.2.0-rc1"), "prerelease base moves are offered");
        assert!(is_newer("2.1.0-rc9", "2.1.0-rc10"), "rc10 > rc9 numerically");
        assert!(!is_newer("2.1.0-rc10", "2.1.0-rc9"));
        assert!(!is_newer("2.0.1", "nightly"), "a tag with no numbers never wins");
    }

    #[test]
    fn version_compare_plain_and_v_prefix() {
        assert!(is_newer("1.4.9", "1.4.10"));
        assert!(is_newer("v1.4.9", "v1.4.10"));
        assert!(!is_newer("2.0.2", "2.0.2"));
        assert!(!is_newer("2.0.2", "2.0.1"));
        assert!(is_newer("2.0.2", "2.1.0"));
    }

    /// `asset_sha256` reads GitHub's `digest` (`sha256:<hex>`) or a site
    /// feed's `sha256`, and refuses malformed values so a truncated hash can
    /// never pass for a pin.
    #[test]
    fn asset_sha256_parses_both_feed_shapes_and_refuses_garbage() {
        let gh = serde_json::json!({"digest": "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"});
        assert_eq!(
            asset_sha256(&gh).unwrap(),
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        let site = serde_json::json!({"sha256": "aabbCCDDEEFF00112233445566778899aabbccddeeff00112233445566778899"});
        assert_eq!(
            asset_sha256(&site).unwrap(),
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
        );
        let short = serde_json::json!({"digest": "sha256:deadbeef"});
        assert_eq!(asset_sha256(&short), None);
        let none = serde_json::json!({"name": "x.dmg"});
        assert_eq!(asset_sha256(&none), None);
    }

    /// A site feed must normalize into the GitHub asset shape the picker
    /// consumes, and its sha256 must survive as a digest.
    #[tokio::test]
    async fn site_feed_normalizes_into_github_shape() {
        // No local server: exercise the malformed-document guards only —
        // anything without a version or assets must normalize to None.
        let bad = fetch_site_feed("http://127.0.0.1:9/no-such-feed.json").await;
        assert!(bad.is_none(), "an unreachable feed falls through to GitHub");
    }

    /// The update receipt: a cached installer is only reused when its sha256
    /// still matches what the feed pinned.
    #[test]
    fn file_sha256_hashes_bytes_stably() {
        let dir = temp_root("sha");
        let p = dir.join("blob");
        std::fs::write(&p, b"codifa").unwrap();
        let h = file_sha256(&p).unwrap();
        assert_eq!(h.len(), 64);
        assert_eq!(h, file_sha256(&p).unwrap(), "same bytes, same hash");
        std::fs::write(&p, b"codifa!").unwrap();
        assert_ne!(h, file_sha256(&p).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Launching a program for the user must not leave a zombie behind.
    ///
    /// The `open`-style helpers only spawn; nothing waits. Three `<defunct>`
    /// children were still listed after eight hours of uptime. `reap_detached`
    /// must collect the exit status instead.
    #[test]
    fn a_detached_child_is_reaped() {
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("spawn");
        let pid = child.id();
        assert!(reap_detached(child));
        // The reaper runs on its own thread, so poll briefly: a reaped pid stops
        // existing, and `kill(pid, 0)` then fails with ESRCH.
        let mut reaped = false;
        for _ in 0..200 {
            #[cfg(unix)]
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                reaped = true;
                break;
            }
            #[cfg(not(unix))]
            {
                let _ = pid;
                reaped = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(reaped, "pid {pid} was never reaped — it would show as <defunct>");
    }

    #[test]
    fn image_attachment_downscales_past_the_model_limit() {
        let big = image::DynamicImage::from(image::RgbaImage::new(IMAGE_MAX_DIM + 512, 64));
        let got = image_attachment(big, IMAGE_MAX_DIM).expect("attachment");
        let path = got["path"].as_str().expect("path").to_owned();
        assert!(got["dataUrl"].as_str().expect("dataUrl").starts_with("data:image/"));
        let decoded = image::open(&path).expect("decode");
        assert!(
            decoded.width() <= IMAGE_MAX_DIM && decoded.height() <= IMAGE_MAX_DIM,
            "{}x{}",
            decoded.width(),
            decoded.height()
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn resolve_safe_accepts_absolute_path_inside_root() {
        let root = temp_root("abs-in");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let file = root.join("sub/a.ts");
        std::fs::write(&file, "x").unwrap();
        let got = resolve_safe(&root, &file.to_string_lossy()).unwrap();
        assert_eq!(got, file.canonicalize().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_safe_rejects_absolute_path_outside_root() {
        let root = temp_root("abs-out");
        let outside = std::env::temp_dir().join(format!("codifa-rs-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        let err = resolve_safe(&root, &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("escapes"), "{err}");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(&outside).ok();
    }

    #[test]
    fn resolve_safe_keeps_relative_paths_root_scoped() {
        let root = temp_root("rel");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        let got = resolve_safe(&root, "src/a.ts").unwrap();
        assert_eq!(got, root.join("src/a.ts").canonicalize().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fs_read_serves_relative_and_absolute_paths() {
        let root = temp_root("read");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/a.ts");
        std::fs::write(&file, "hello").unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let rel = fs_read(root_s.clone(), "src/a.ts".into()).unwrap().unwrap();
        assert_eq!(rel["content"].as_str(), Some("hello"));
        let abs = fs_read(root_s, file.to_string_lossy().into_owned())
            .unwrap()
            .unwrap();
        assert_eq!(abs["content"].as_str(), Some("hello"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_data_url_is_cached_and_re_reads_a_changed_file() {
        let root = temp_root("imgcache");
        let src = root.join("a.png");
        std::fs::write(&src, b"\x89PNG-one").unwrap();
        let path = src.to_string_lossy().into_owned();
        let first = image_data_url(&path).unwrap();
        // The agent re-reads the images of every turn's history; the second read
        // must not touch the disk again at all.
        assert_eq!(first, image_data_url(&path).unwrap(), "repeat read must hit the cache");
        // A changed file must never be served the stale entry. A different LENGTH
        // guarantees a different (mtime, len) key regardless of clock granularity.
        std::fs::write(&src, b"\x89PNG-two-longer").unwrap();
        let third = image_data_url(&path).unwrap();
        assert_ne!(first, third, "a changed file must be re-read");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_image_passes_a_small_png_through_untouched() {
        let root = temp_root("passthrough");
        let src = root.join("small.png");
        let img = image::RgbImage::from_pixel(16, 16, image::Rgb([10u8, 20, 30]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&src, image::ImageFormat::Png)
            .unwrap();
        let original = std::fs::read(&src).unwrap();
        let out = normalize_image(src.to_string_lossy().into_owned()).unwrap();
        // Nothing to encode: a readable format inside the size cap is copied
        // byte-for-byte, so re-encoding it only burned CPU for no gain.
        let path = out["path"].as_str().unwrap();
        assert_ne!(
            path,
            src.to_string_lossy(),
            "the image must be copied so the history keeps a stable path"
        );
        assert!(
            path.ends_with(".png"),
            "the copy must keep the original format: {path}"
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            original,
            "an already-valid small image must not be re-encoded"
        );
        let url = out["dataUrl"].as_str().unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(bytes, original, "the model must receive the ORIGINAL bytes");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalize_image_shrinks_to_the_cap_losslessly_and_never_grows() {
        let root = temp_root("shrink");
        let src = root.join("big.png");
        // A solid colour is the clearest losslessness probe: a LOSSY encoder
        // (JPEG-style) shifts the value, a lossless one returns it exactly.
        let color = image::Rgb([200u8, 60, 30]);
        let img = image::RgbImage::from_pixel(4096, 64, color);
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&src, image::ImageFormat::Png)
            .unwrap();

        let out = normalize_image(src.to_string_lossy().into_owned()).unwrap();
        let url = out["dataUrl"].as_str().unwrap();
        assert!(
            url.starts_with("data:image/webp;base64,") || url.starts_with("data:image/png;base64,"),
            "unexpected mime in {url}"
        );
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 2048, "must shrink to the largest edge cap");
        assert_eq!(decoded.height(), 32, "the aspect ratio must be preserved");
        assert_eq!(
            decoded.to_rgb8().get_pixel(5, 5),
            &color,
            "the encode must be LOSSLESS: the model must see the same pixels"
        );

        // Independently encoded PNG of the same resized image: the chosen bytes
        // may never exceed it, so making screenshots smaller can never make any
        // request bigger.
        let resized = image::open(&src)
            .unwrap()
            .resize(2048, 32, image::imageops::FilterType::Lanczos3);
        let mut png: Vec<u8> = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert!(
            bytes.len() <= png.len(),
            "the encode must not grow the payload: {} > {}",
            bytes.len(),
            png.len()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_mime_is_sniffed_from_the_bytes_not_the_name() {
        // A screenshot saved WITHOUT a suffix (or under the wrong one) used to be
        // dropped, because the extension was the only mime source.
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a"), Some("image/gif"));
        let mut webp = Vec::from(*b"RIFF____WEBP");
        assert_eq!(sniff_image_mime(&mut webp), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"not an image"), None);

        let root = temp_root("sniff");
        let src = root.join("screenshot"); // no extension at all
        image::DynamicImage::from(image::RgbImage::from_pixel(
            20,
            10,
            image::Rgb([9u8, 9, 9]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let url = image_data_url(&src.to_string_lossy()).expect("sniffed mime must read");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_cap_follows_the_provider_and_the_cache_keeps_both_sizes() {
        let root = temp_root("cap");
        let src = root.join("big.png");
        image::DynamicImage::from(image::RgbImage::from_pixel(
            3000,
            100,
            image::Rgb([30u8, 90, 200]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let path = src.to_string_lossy().into_owned();
        let anthropic = image_data_url_for(&path, "anthropic").expect("url");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(anthropic.split_once(',').unwrap().1)
            .unwrap();
        // Claude resizes to 1568 px before patching, so shipping more is upload
        // time for pixels the encoder never reads.
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1568);
        // The other cap must not be served the anthropic entry from the cache.
        let other = image_data_url_for(&path, "openai").expect("url");
        assert_ne!(other, anthropic, "the cap is part of the cache key");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_steps_sees_a_marker_path_and_nothing_for_a_text_file() {
        let root = temp_root("readimg");
        let src = root.join("shot.png");
        image::DynamicImage::from(image::RgbImage::from_pixel(
            8,
            8,
            image::Rgb([1u8, 2, 3]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();
        let text = root.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();

        let note = image_read_note(&src.to_string_lossy()).expect("an image has a note");
        assert_eq!(image_read_path(&note).as_deref(), Some(src.to_string_lossy().as_ref()));
        assert!(note.contains("image/png"), "{note}");
        assert!(
            image_read_note(&text.to_string_lossy()).is_none(),
            "a text file must fall through to the normal window"
        );
        assert_eq!(image_read_path("plain text"), None);
        std::fs::remove_dir_all(&root).ok();
    }
