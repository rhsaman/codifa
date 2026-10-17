//! Native `/doc/read` — a Rust port of `backend/doc_tools.py`'s read/render
//! paths for the right-hand file viewer (and for the agent reading documents).
//!
//! Formats: `.pdf` (text), `.docx` (paragraphs + tables as markdown), `.xlsx`/
//! `.xlsm`/`.xls` (sheets as TSV), `.csv` (TSV, delimiter sniffed) and any text
//! file. `render_document` produces the styled HTML the viewer injects.
//!
//! PDF *visual* preview is deliberately NOT rasterized here: the viewer shows
//! the raw file through the Tauri asset protocol, which the webview renders
//! with its built-in PDF viewer — no pdfium/mupdf binary to bundle.

use std::fs;
use std::io::Read;
use std::path::Path;

use calamine::Reader;
use serde_json::{json, Value};

/// Refuse to parse files beyond 100 MB (mirrors doc_tools.MAX_DOC_BYTES).
const MAX_DOC_BYTES: u64 = 100 * 1024 * 1024;
/// Per-call text cap — the viewer paginates via `pages`/`sheet`.
const MAX_DOC_READ_CHARS: usize = 24_000;
const MAX_XLSX_ROWS: usize = 800;
const MAX_XLSX_COLS: usize = 60;
const MAX_XLSX_SHEETS: usize = 12;
/// Default page window for a PDF text read.
const MAX_PDF_PAGES: usize = 200;

fn check_size(path: &Path) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("cannot stat file: {e}"))?
        .len();
    if size > MAX_DOC_BYTES {
        return Err(format!(
            "file is {} MB — too large to parse (limit {} MB)",
            size / 1_000_000,
            MAX_DOC_BYTES / 1_000_000
        ));
    }
    Ok(())
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

/// Parse a 1-based inclusive page spec like "3" / "1-3,7" (default: first N).
/// Returns 0-based indices (mirrors doc_tools._parse_page_ranges).
fn parse_page_ranges(spec: &str, total: usize) -> Result<Vec<usize>, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Ok((0..total.min(MAX_PDF_PAGES)).collect());
    }
    let mut picked: Vec<usize> = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let a: usize = a
            .parse()
            .map_err(|_| format!("invalid page spec {part:?} — use e.g. \"1-3,7\""))?;
        let b: usize = b
            .parse()
            .map_err(|_| format!("invalid page spec {part:?} — use e.g. \"1-3,7\""))?;
        for p in a.max(1)..=b.min(total) {
            let idx = p - 1;
            if !picked.contains(&idx) {
                picked.push(idx);
            }
        }
    }
    if picked.is_empty() {
        return Err(format!(
            "page spec {spec:?} selects no pages (PDF has {total})"
        ));
    }
    picked.sort_unstable();
    Ok(picked)
}

/// Render rows as compact TSV, trimming trailing empty cells (openpyxl pads to
/// the sheet dimension) and appending a truncation note past `max_rows`.
fn render_table(rows: &[Vec<String>], max_rows: usize, max_cols: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    for row in rows.iter().take(max_rows) {
        let mut cells: Vec<&str> = row
            .iter()
            .take(max_cols)
            .map(|c| c.as_str())
            .collect();
        while matches!(cells.last(), Some(c) if c.is_empty()) {
            cells.pop();
        }
        lines.push(cells.join("\t"));
    }
    if rows.len() > max_rows {
        lines.push(format!(
            "[truncated: {} more rows — narrow the read]",
            rows.len() - max_rows
        ));
    }
    lines.join("\n")
}

/// Convert one spreadsheet cell to the string the Python layer produced.
fn cell_to_string(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // Python rendered `str(int(v))` for integer-valued floats.
            if f.fract() == 0.0 && f.is_finite() && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::Error(e) => format!("{e:?}"),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Text-family readers
// ---------------------------------------------------------------------------

fn read_text_file(path: &Path) -> Result<String, String> {
    check_size(path)?;
    let mut file = fs::File::open(path).map_err(|e| format!("cannot read file: {e}"))?;
    let mut buf = vec![0u8; MAX_DOC_READ_CHARS * 4 + 4];
    let n = file
        .read(&mut buf)
        .map_err(|e| format!("cannot read file: {e}"))?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf).into_owned();
    if text.chars().count() > MAX_DOC_READ_CHARS {
        let cut: String = text.chars().take(MAX_DOC_READ_CHARS).collect();
        return Ok(format!(
            "{cut}\n[truncated at {MAX_DOC_READ_CHARS} chars]"
        ));
    }
    Ok(text)
}

/// Sniff the CSV delimiter the way csv.Sniffer did, restricted to the same set.
fn sniff_delimiter(sample: &str) -> char {
    let mut best = (',', 0usize);
    for cand in [',', ';', '\t', '|'] {
        let count = sample.matches(cand).count();
        if count > best.1 {
            best = (cand, count);
        }
    }
    best.0
}

fn load_csv_rows(path: &Path) -> Result<(Vec<Vec<String>>, char), String> {
    check_size(path)?;
    let mut file = fs::File::open(path).map_err(|e| format!("cannot read file: {e}"))?;
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| format!("cannot read file: {e}"))?;
    // utf-8-sig: strip the BOM the same way Python's codec did.
    let text = String::from_utf8_lossy(&raw)
        .trim_start_matches('\u{feff}')
        .to_string();
    let sample: String = text.chars().take(8192).collect();
    let delimiter = sniff_delimiter(&sample);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("cannot parse CSV: {e}"))?;
        rows.push(
            rec.iter()
                .take(MAX_XLSX_COLS)
                .map(|s| s.to_string())
                .collect(),
        );
    }
    Ok((rows, delimiter))
}

fn read_csv(path: &Path, pages: &str) -> Result<String, String> {
    let (rows, _) = load_csv_rows(path)?;
    let total = rows.len();
    if total == 0 {
        return Ok("[empty csv]".into());
    }
    let indices: Vec<usize> = if pages.trim().is_empty() {
        (0..total.min(MAX_XLSX_ROWS)).collect()
    } else {
        parse_page_ranges(pages, total)?
            .into_iter()
            .take(MAX_XLSX_ROWS)
            .collect()
    };
    let picked: Vec<Vec<String>> = indices
        .iter()
        .filter(|i| **i < total)
        .map(|i| rows[*i].clone())
        .collect();
    Ok(format!(
        "CSV: {total} row(s), showing {}\n\n{}\n\n[showing {} of {total} rows]",
        picked.len(),
        render_table(&picked, MAX_XLSX_ROWS, MAX_XLSX_COLS),
        picked.len()
    ))
}

/// Read a spreadsheet with calamine — covers `.xlsx`/`.xlsm` (openpyxl's job)
/// and `.xls` (xlrd's job) in one path.
fn read_spreadsheet(path: &Path, sheet: &str) -> Result<String, String> {
    check_size(path)?;
    let mut wb = calamine::open_workbook_auto(path)
        .map_err(|e| format!("cannot open Excel file: {e}"))?;
    let names = wb.sheet_names().to_vec();
    let sheet = sheet.trim();
    let wanted: Vec<String> = if !sheet.is_empty() {
        if !names.iter().any(|n| n == sheet) {
            return Err(format!(
                "sheet {sheet:?} not found — sheets: {}",
                names.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        vec![sheet.to_string()]
    } else {
        names.iter().take(MAX_XLSX_SHEETS).cloned().collect()
    };
    let mut out: Vec<String> = vec![format!("Excel: {} sheet(s)", names.len())];
    for name in &wanted {
        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("cannot read sheet {name:?}: {e}"))?;
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut truncated = false;
        for (r, row) in range.rows().enumerate() {
            if r >= MAX_XLSX_ROWS {
                truncated = true;
                break;
            }
            rows.push(row.iter().map(cell_to_string).collect());
        }
        let total_rows = range.rows().count();
        out.push(format!(
            "### sheet: {name} ({total_rows} rows)\n{}",
            render_table(&rows, MAX_XLSX_ROWS, MAX_XLSX_COLS)
        ));
        if truncated {
            out.push(format!("[sheet {name:?} truncated at {MAX_XLSX_ROWS} rows]"));
        }
    }
    Ok(out.join("\n\n"))
}

// ---------------------------------------------------------------------------
// PDF (text)
// ---------------------------------------------------------------------------

fn read_pdf(path: &Path, pages: &str) -> Result<String, String> {
    check_size(path)?;
    let text = pdf_extract::extract_text(path)
        .map_err(|e| format!("cannot open PDF: {e}"))?;
    // pdf-extract separates pages with a form feed when it can; otherwise the
    // whole document is one block.
    let raw_pages: Vec<String> = if text.contains('\u{c}') {
        text.split('\u{c}').map(|p| p.to_string()).collect()
    } else {
        vec![text]
    };
    let total = raw_pages.len();
    let indices = parse_page_ranges(pages, total)?;
    let mut out: Vec<String> = vec![format!(
        "PDF: {total} page(s), showing {}",
        indices.len()
    )];
    let mut shown = 0usize;
    for i in indices {
        let mut body = raw_pages.get(i).cloned().unwrap_or_default();
        body = body.trim().to_string();
        if body.is_empty() {
            body = "[no extractable text — scanned/image page?]".into();
        }
        out.push(format!("=== page {} ===\n{body}", i + 1));
        shown += body.chars().count();
        if shown >= MAX_DOC_READ_CHARS {
            out.push(format!(
                "[truncated at {MAX_DOC_READ_CHARS} chars — re-read with `pages`]"
            ));
            break;
        }
    }
    Ok(out.join("\n\n"))
}

// ---------------------------------------------------------------------------
// DOCX (paragraphs, headings, lists, tables)
// ---------------------------------------------------------------------------

const DOCX_NS: &str =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn read_zip_entry(path: &Path, name: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot read file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("cannot open file: {e}"))?;
    let mut entry = zip
        .by_name(name)
        .map_err(|e| format!("missing {name}: {e}"))?;
    let mut out = String::new();
    entry
        .read_to_string(&mut out)
        .map_err(|e| format!("cannot read {name}: {e}"))?;
    Ok(out)
}

/// Concatenate every `<w:t>` under `node` (runs, tabs and breaks included).
fn wml_text(node: &roxmltree::Node) -> String {
    let mut out = String::new();
    for d in node.descendants() {
        if !d.is_element() {
            continue;
        }
        match d.tag_name().name() {
            "t" => {
                if let Some(t) = d.text() {
                    out.push_str(t);
                }
            }
            "tab" => out.push('\t'),
            "br" => out.push('\n'),
            _ => {}
        }
    }
    out
}

fn docx_paragraph_kind(p: &roxmltree::Node) -> (Option<usize>, bool) {
    let Some(ppr) = p
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == "pPr")
    else {
        return (None, false);
    };
    let mut heading = None;
    let mut is_list = false;
    for c in ppr.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "pStyle" => {
                let val = c.attribute("val").or_else(|| {
                    c.attribute((DOCX_NS, "val"))
                }).unwrap_or_default();
                let lower = val.to_lowercase();
                if let Some(rest) = lower.strip_prefix("heading") {
                    if let Ok(n) = rest.trim().parse::<usize>() {
                        heading = Some(n);
                    }
                }
            }
            "numPr" => is_list = true,
            _ => {}
        }
    }
    (heading, is_list)
}

fn docx_table_rows(tbl: &roxmltree::Node) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for tr in tbl
        .children()
        .filter(|c| c.is_element() && c.tag_name().name() == "tr")
    {
        let mut cells: Vec<String> = Vec::new();
        for tc in tr
            .children()
            .filter(|c| c.is_element() && c.tag_name().name() == "tc")
        {
            // Cell text joins its paragraphs with a space (Python did the same
            // with `c.text.strip().replace("\n", " ")`).
            let text: Vec<String> = tc
                .children()
                .filter(|c| c.is_element() && c.tag_name().name() == "p")
                .map(|p| wml_text(&p).trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            cells.push(text.join(" "));
        }
        rows.push(cells);
    }
    rows
}

/// Walk `body` in document order, emitting markdown-ish lines.
fn docx_body_lines(body: &roxmltree::Node) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for child in body.children().filter(|c| c.is_element()) {
        match child.tag_name().name() {
            "p" => {
                let text = wml_text(&child).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let (heading, is_list) = docx_paragraph_kind(&child);
                let line = if let Some(n) = heading {
                    format!("{} {text}", "#".repeat(n.clamp(1, 6)))
                } else if is_list {
                    format!("- {text}")
                } else {
                    text
                };
                chars += line.chars().count();
                lines.push(line);
            }
            "tbl" => {
                let rows = docx_table_rows(&child);
                let table = render_table(&rows, MAX_XLSX_ROWS, MAX_XLSX_COLS);
                chars += table.chars().count();
                lines.push(table);
            }
            _ => continue,
        }
        if chars > MAX_DOC_READ_CHARS {
            lines.push(format!("[truncated at {MAX_DOC_READ_CHARS} chars]"));
            break;
        }
    }
    lines
}

fn read_docx(path: &Path) -> Result<String, String> {
    check_size(path)?;
    let xml = read_zip_entry(path, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| format!("cannot open Word file: {e}"))?;
    let Some(body) = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "body")
    else {
        return Err("cannot open Word file: no document body".into());
    };
    let lines = docx_body_lines(&body);
    if lines.is_empty() {
        return Ok("[empty document]".into());
    }
    Ok(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// HTML rendering (styled viewer)
// ---------------------------------------------------------------------------

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn rows_to_html_table(rows: &[Vec<String>], max_rows: usize, max_cols: usize) -> String {
    let mut out = String::from("<table>");
    for (r, row) in rows.iter().take(max_rows + 1).enumerate() {
        let tag = if r == 0 { "th" } else { "td" };
        out.push_str("<tr>");
        for cell in row.iter().take(max_cols) {
            out.push_str(&format!("<{tag}>{}</{tag}>", html_escape(cell)));
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
    if rows.len() > max_rows {
        out.push_str(&format!(
            "<p class=\"doc-note\">[truncated: {} more rows]</p>",
            rows.len() - max_rows
        ));
    }
    out
}

fn render_csv_html(path: &Path, pages: &str) -> Result<String, String> {
    let (rows, _) = load_csv_rows(path)?;
    let total = rows.len();
    if total == 0 {
        return Err("empty csv".into());
    }
    let indices: Vec<usize> = if pages.trim().is_empty() {
        (0..total.min(MAX_XLSX_ROWS)).collect()
    } else {
        parse_page_ranges(pages, total)?
            .into_iter()
            .take(MAX_XLSX_ROWS)
            .collect()
    };
    let picked: Vec<Vec<String>> = indices.iter().map(|i| rows[*i].clone()).collect();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(format!(
        "<h3>{}</h3>{}",
        html_escape(&name),
        rows_to_html_table(&picked, MAX_XLSX_ROWS, MAX_XLSX_COLS)
    ))
}

fn render_spreadsheet_html(path: &Path, sheet: &str, pages: &str) -> Result<String, String> {
    check_size(path)?;
    let mut wb = calamine::open_workbook_auto(path)
        .map_err(|e| format!("cannot open Excel file: {e}"))?;
    let names = wb.sheet_names().to_vec();
    let sheet = sheet.trim();
    let wanted: Vec<String> = if !sheet.is_empty() {
        if !names.iter().any(|n| n == sheet) {
            return Err(format!(
                "sheet {sheet:?} not found — sheets: {}",
                names.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        vec![sheet.to_string()]
    } else {
        names.iter().take(MAX_XLSX_SHEETS).cloned().collect()
    };
    let mut out = String::new();
    for name in &wanted {
        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("cannot read sheet {name:?}: {e}"))?;
        let all: Vec<Vec<String>> = range
            .rows()
            .map(|row| row.iter().map(cell_to_string).collect())
            .collect();
        // `pages` paginates 1-based row ranges for the viewer.
        let rows: Vec<Vec<String>> = if pages.trim().is_empty() {
            all.iter().take(MAX_XLSX_ROWS).cloned().collect()
        } else {
            let idx = parse_page_ranges(pages, all.len())?;
            idx.into_iter()
                .take(MAX_XLSX_ROWS)
                .filter_map(|i| all.get(i).cloned())
                .collect()
        };
        // The viewer parses `<h3>name</h3><table>` pairs — keep that shape.
        out.push_str(&format!(
            "<h3>{}</h3>{}",
            html_escape(name),
            rows_to_html_table(&rows, MAX_XLSX_ROWS, MAX_XLSX_COLS)
        ));
    }
    Ok(out)
}

fn render_docx_html(path: &Path) -> Result<String, String> {
    check_size(path)?;
    let xml = read_zip_entry(path, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml)
        .map_err(|e| format!("cannot open Word file: {e}"))?;
    let Some(body) = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "body")
    else {
        return Err("cannot open Word file: no document body".into());
    };
    let mut out = String::new();
    for child in body.children().filter(|c| c.is_element()) {
        match child.tag_name().name() {
            "p" => {
                let text = wml_text(&child).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let (heading, is_list) = docx_paragraph_kind(&child);
                if let Some(n) = heading {
                    let tag = format!("h{}", (n + 1).clamp(1, 6));
                    out.push_str(&format!(
                        "<{tag}>{}</{tag}>",
                        html_escape(&text)
                    ));
                } else if is_list {
                    out.push_str(&format!("<div class=\"doc-li\">{}</div>", html_escape(&text)));
                } else {
                    out.push_str(&format!("<p>{}</p>", html_escape(&text)));
                }
            }
            "tbl" => {
                let rows = docx_table_rows(&child);
                out.push_str(&rows_to_html_table(&rows, MAX_XLSX_ROWS, MAX_XLSX_COLS));
            }
            _ => continue,
        }
    }
    if out.is_empty() {
        return Err("empty document".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Public entry points (dispatch by extension)
// ---------------------------------------------------------------------------

/// Read a document's text (dispatches by extension). Mirrors read_document.
pub fn read_document(path: &str, sheet: &str, pages: &str) -> Result<String, String> {
    let p = Path::new(path);
    match ext_of(path).as_str() {
        ".pdf" => read_pdf(p, pages),
        ".docx" => read_docx(p),
        ".xlsx" | ".xlsm" | ".xls" => read_spreadsheet(p, sheet),
        ".csv" => read_csv(p, pages),
        ".doc" => Err(".doc is the legacy Word format — re-save as .docx first".into()),
        _ => read_text_file(p),
    }
}

/// Render a docx/xlsx/xls/csv as styled HTML for the viewer.
pub fn render_document(path: &str, sheet: &str, pages: &str) -> Result<String, String> {
    let p = Path::new(path);
    match ext_of(path).as_str() {
        ".docx" => render_docx_html(p),
        ".xlsx" | ".xlsm" | ".xls" => render_spreadsheet_html(p, sheet, pages),
        ".csv" => render_csv_html(p, pages),
        other => Err(format!(
            "HTML rendering is not supported for {}",
            if other.is_empty() { "this file type" } else { other }
        )),
    }
}

/// The `/doc/read` request body (mirrors DocReadRequest).
#[derive(serde::Deserialize)]
pub struct DocReadBody {
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub sheet: String,
    #[serde(default)]
    pub pages: String,
}

/// Handle one `/doc/read` call: resolve the path inside the workspace sandbox,
/// then read (text) or render (html) the document. Never returns an HTTP error
/// for a document problem — the viewer surfaces the message verbatim.
pub fn handle_doc_read(body: DocReadBody) -> Value {
    let p = body.path.trim().to_string();
    if p.is_empty() {
        return json!({ "error": "path is required" });
    }
    let root = if body.root.trim().is_empty() {
        std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into())
    } else {
        body.root.trim().to_string()
    };
    let target = match crate::tools::resolve_safe(&root, &p, true, None) {
        Ok(t) => t,
        Err(e) => return json!({ "error": e }),
    };
    let target_str = target.to_string_lossy().to_string();
    let fmt = {
        let f = body.format.trim();
        if f.is_empty() { "text" } else { f }
    };
    let sheet = body.sheet.trim().to_string();
    let pages = body.pages.trim().to_string();
    match fmt {
        "html" => match render_document(&target_str, &sheet, &pages) {
            Ok(html) => json!({ "html": html }),
            Err(e) => json!({ "error": e }),
        },
        "pages" => json!({
            "error": "PDF preview is rendered natively by the viewer (asset protocol)"
        }),
        _ => match read_document(&target_str, &sheet, &pages) {
            Ok(content) => json!({ "content": content }),
            Err(e) => json!({ "error": e }),
        },
    }
}

#[cfg(test)]
mod tests {
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
}
