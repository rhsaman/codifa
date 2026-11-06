    use super::*;

    #[test]
    fn page_ranges_parse_specs_and_default_to_all() {
        assert_eq!(parse_page_ranges("", 5).unwrap(), vec![0, 1, 2, 3, 4]);
        assert_eq!(parse_page_ranges("2", 5).unwrap(), vec![1]);
        assert_eq!(parse_page_ranges("1-3,5", 5).unwrap(), vec![0, 1, 2, 4]);
        // A reversed range and an out-of-range page select nothing — same as
        // the Python layer, which raised DocError for both.
        assert!(parse_page_ranges("3-2", 5).is_err());
        assert!(parse_page_ranges("x", 5).is_err());
        assert!(parse_page_ranges("9", 5).is_err());
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
        });
        assert!(out["error"].is_string());
    }
