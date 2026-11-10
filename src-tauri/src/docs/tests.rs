    use super::*;

    #[test]
    fn page_ranges_parse_specs_and_default_to_all() {
        assert_eq!(parse_page_ranges("", 5).unwrap(), vec![0, 1, 2, 3, 4]);
        assert_eq!(parse_page_ranges("2", 5).unwrap(), vec![1]);
        assert_eq!(parse_page_ranges("1-3,5", 5).unwrap(), vec![0, 1, 2, 4]);
        // No 200-page window: the default is EVERY page, however long the PDF.
        assert_eq!(parse_page_ranges("", 250).unwrap().len(), 250);
        // A reversed range and an out-of-range page select nothing — same as
        // the Python layer, which raised DocError for both.
        assert!(parse_page_ranges("3-2", 5).is_err());
        assert!(parse_page_ranges("x", 5).is_err());
        assert!(parse_page_ranges("9", 5).is_err());
    }

    #[test]
    fn pptx_slides_read_as_text() {
        let path = std::env::temp_dir().join(format!("codifa-pptx-{}.pptx", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (n, text) in [(1, "Quarterly numbers"), (2, "Next steps")] {
            zip.start_file(
                format!("ppt/slides/slide{n}.xml"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            let xml = format!(
                r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p><a:p><a:r><a:t>bullet</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
            );
            std::io::Write::write_all(&mut zip, xml.as_bytes()).unwrap();
        }
        zip.finish().unwrap();

        let text = read_document(&path.to_string_lossy(), "", "", 0).unwrap();
        assert!(text.contains("PPTX: 2 slide(s)"), "{text}");
        assert!(
            text.contains("=== slide 1 ===") && text.contains("Quarterly numbers"),
            "{text}"
        );
        assert!(
            text.contains("=== slide 2 ===") && text.contains("Next steps") && text.contains("bullet"),
            "{text}"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn render_table_trims_trailing_cells_and_notes_truncation() {
        let rows = vec![
            vec!["a".into(), "b".into(), "".into()],
            vec!["c".into(), "".into(), "".into()],
        ];
        assert_eq!(render_table(&rows, 10, 10), "a\tb\nc");
        let many: Vec<Vec<String>> = (0..3)
            .map(|i| vec![format!("r{i}")])
            .collect();
        assert!(render_table(&many, 2, 10).ends_with("[truncated: 1 more rows — narrow the read]"));
    }

    #[test]
    fn csv_sniffing_picks_the_real_delimiter() {
        assert_eq!(sniff_delimiter("a,b,c\n1,2,3"), ',');
        assert_eq!(sniff_delimiter("a;b;c\n1;2;3"), ';');
        assert_eq!(sniff_delimiter("a\tb\tc"), '\t');
        assert_eq!(sniff_delimiter("a|b"), '|');
    }

    #[test]
    fn cell_formatting_matches_the_python_output() {
        use calamine::Data;
        assert_eq!(cell_to_string(&Data::Float(3.0)), "3");
        assert_eq!(cell_to_string(&Data::Float(2.5)), "2.5");
        assert_eq!(cell_to_string(&Data::Int(7)), "7");
        assert_eq!(cell_to_string(&Data::String("x".into())), "x");
        assert_eq!(cell_to_string(&Data::Empty), "");
    }

    #[test]
    fn doc_read_rejects_a_path_outside_the_workspace() {
        let out = handle_doc_read(DocReadBody {
            root: "/tmp".into(),
            path: "../../etc/hosts".into(),
            format: "text".into(),
            sheet: String::new(),
            pages: String::new(),
            max_chars: 0,
        });
        assert!(out["error"].is_string());
    }

    #[test]
    fn text_read_truncates_at_the_cap_and_honors_a_bigger_one() {
        let path = std::env::temp_dir().join(format!("codifa-doc-cap-{}.md", std::process::id()));
        std::fs::write(&path, "x".repeat(50)).unwrap();
        // Small cap: cut with the marker — the viewer's page size behaviour.
        let capped = read_text_file(&path, 10).unwrap();
        assert!(capped.ends_with("[truncated at 10 chars]"));
        // Cap >= the char count: the whole file comes back, marker-free —
        // what the viewer relies on for long READMEs.
        let full = read_text_file(&path, 50).unwrap();
        assert_eq!(full, "x".repeat(50));
        std::fs::remove_file(&path).ok();
    }

    /// A one-page PDF with exact xref offsets, so a strict parser accepts it.
    fn minimal_pdf(text: &str) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n".to_vec();
        let content = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET\n");
        let objects = [
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            "<</Type/Pages/Kids[3 0 R]/Count 1>>".to_string(),
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R\
             /Resources<</Font<</F1 5 0 R>>>>>>"
                .to_string(),
            format!("<</Length {}>>\nstream\n{content}endstream", content.len()),
            "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>".to_string(),
        ];
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in &offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    #[test]
    fn pdf_reads_even_when_html_follows_the_final_eof() {
        // A real upload (a signed bank statement) carried the delivering HTML
        // page after its last `%%EOF`. lopdf finds the trailer by scanning only
        // the final 512 bytes for `%%EOF`, so the real one was out of range and
        // the read died with "invalid start value" — the file was unreadable
        // even though every byte of the PDF was there.
        let dir = std::env::temp_dir().join(format!("codifa-pdfjunk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let clean = dir.join("clean.pdf");
        std::fs::write(&clean, minimal_pdf("Hello trailing junk")).unwrap();
        let clean_text = read_document(&clean.to_string_lossy(), "", "", 0).unwrap();
        assert!(clean_text.contains("Hello trailing junk"), "{clean_text}");

        let junked = dir.join("junked.pdf");
        let mut bytes = minimal_pdf("Hello trailing junk");
        bytes.extend_from_slice(
            b"<!DOCTYPE html><html><body>downloaded by a web form</body></html>\n",
        );
        std::fs::write(&junked, bytes).unwrap();
        let text = read_document(&junked.to_string_lossy(), "", "", 0).unwrap();
        assert!(
            text.contains("Hello trailing junk"),
            "appended HTML must not make the PDF unreadable: {text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
