"""Document tool helpers: read / create / edit for PDF, Word, Excel, text.

Pure logic with no tool-callback coupling so plain tests can cover round-trips.
The agent-facing tool wrappers (``read_document`` / ``write_document``) live in
``tools.make_tool_callbacks`` and call into this module via
``asyncio.to_thread``.

Supported formats:
- read:   .pdf (per-page text extraction), .docx (paragraphs + tables as
          markdown), .xlsx/.xlsm/.xls (sheets as TSV), .csv and any text file.
- create: .pdf (markdown-lite → PDF, Unicode font when one is available),
          .docx (markdown-lite: # headings, - bullets, **bold**), .xlsx
          (JSON rows or TSV/CSV table), plain text for everything else.
- edit:   .docx (find/replace, append markdown-lite), .xlsx (set cell,
          append rows), .pdf (extract pages, merge, delete pages).
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import re
from typing import Any

MAX_DOC_BYTES = 100 * 1024 * 1024  # refuse to parse files beyond 100 MB
MAX_DOC_READ_CHARS = 24_000  # per-call text cap (paginate via pages/sheet)
MAX_XLSX_ROWS = 800
MAX_XLSX_COLS = 60
MAX_XLSX_SHEETS = 12

_TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".log", ".xml", ".html", ".htm",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".c", ".h", ".cpp", ".rs", ".go",
    ".java", ".rb", ".php", ".sh", ".sql", ".css", ".scss", ".vue", ".swift",
    ".kt", ".tex", ".rst", ".adoc", ".env", ".gitignore", ".svg",
}

# Arabic / Persian / Hebrew and friends need reshaping + bidi before a PDF
# renderer draws them (PDF has no shaping engine of its own).
_RTL_RE = re.compile(r"[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]")

# Candidate Unicode fonts, best coverage first (macOS / Linux / Windows).
_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/vazirmatn/Vazirmatn-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/opentype/noto/NotoSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


class DocError(ValueError):
    """A user-facing document error (message goes straight to the model)."""


# ---------------------------------------------------------------------------
# shared parsing helpers
# ---------------------------------------------------------------------------

def _check_size(path: str) -> None:
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise DocError(f"cannot stat file: {exc}") from exc
    if size > MAX_DOC_BYTES:
        raise DocError(
            f"file is {size / 1e6:.0f} MB — too large to parse (limit "
            f"{MAX_DOC_BYTES / 1e6:.0f} MB)"
        )


def _ext(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def _parse_rows(content: str) -> list[list[str]]:
    """Parse table content as JSON rows or TSV/CSV text.

    Accepts: a JSON array of arrays, a JSON array of objects (objects become
    data rows under one header row), or plain TSV/CSV text (tab-split when the
    first line contains tabs, else csv.reader for quoted CSV).
    """
    raw = (content or "").strip()
    if not raw:
        raise DocError("empty table content — pass JSON rows or TSV/CSV text")
    if raw[0] in "[{":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise DocError(f"content looks like JSON but does not parse: {exc}") from exc
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list) or not data:
            raise DocError("JSON content must be a non-empty array of rows")
        if all(isinstance(r, dict) for r in data):
            keys: list[str] = []
            for r in data:
                for k in r:
                    if str(k) not in keys:
                        keys.append(str(k))
            rows = [[str(k) for k in keys]]
            for r in data:
                rows.append([str(r.get(k, "")) for k in keys])
            return rows
        return [
            [str(c) for c in r] if isinstance(r, (list, tuple)) else [str(r)]
            for r in data
        ]
    first = raw.splitlines()[0]
    if "\t" in first:
        return [[c.strip() for c in line.split("\t")] for line in raw.splitlines()]
    try:
        return [row for row in csv.reader(io.StringIO(raw))]
    except csv.Error as exc:
        raise DocError(f"cannot parse table content: {exc}") from exc


def _render_table(rows: list[list[str]], max_rows: int, max_cols: int) -> str:
    lines = []
    for r in rows[:max_rows]:
        # Trim trailing empty cells (openpyxl pads to the sheet dimension) so
        # rows render as compact TSV.
        cells = [str(c) for c in r[:max_cols]]
        while cells and cells[-1] == "":
            cells.pop()
        lines.append("\t".join(cells))
    if len(rows) > max_rows:
        lines.append(f"[truncated: {len(rows) - max_rows} more rows — narrow the read]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

def _pdf_read(path: str, pages: str = "") -> str:
    _check_size(path)
    from pypdf import PdfReader

    try:
        reader = PdfReader(path)
    except Exception as exc:
        raise DocError(f"cannot open PDF: {exc}") from exc
    total = len(reader.pages)
    if total == 0:
        raise DocError("PDF has no pages")
    indices = _parse_page_ranges(pages, total)
    out: list[str] = [f"PDF: {total} page(s), showing {len(indices)}"]
    shown = 0
    for i in indices:
        try:
            text = (reader.pages[i].extract_text() or "").strip()
        except Exception:  # noqa: BLE001 — one broken page must not kill the read
            text = ""
        if not text:
            text = "[no extractable text — scanned/image page?]"
        out.append(f"=== page {i + 1} ===\n{text}")
        shown += len(text)
        if shown >= MAX_DOC_READ_CHARS:
            out.append(f"[truncated at {MAX_DOC_READ_CHARS} chars — re-read with `pages`]")
            break
    return "\n\n".join(out)


def _parse_page_ranges(spec: str, total: int) -> list[int]:
    """Parse a 1-based inclusive page spec like "3" / "1-3,7" (default: all)."""
    if not (spec or "").strip():
        return list(range(min(total, 200)))
    picked: dict[int, None] = {}
    for part in spec.split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", part)
        if not m:
            raise DocError(f"invalid page spec {part!r} — use e.g. \"1-3,7\"")
        a = int(m.group(1))
        b = int(m.group(2) or m.group(1))
        for p in range(max(1, a), min(total, b) + 1):
            picked[p - 1] = None
    if not picked:
        raise DocError(f"page spec {spec!r} selects no pages (PDF has {total})")
    return sorted(picked)


def _find_unicode_font() -> str | None:
    for cand in _FONT_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return None


def _shape_rtl(text: str) -> str:
    """Reshape + bidi-reorder text containing Arabic-script characters."""
    if not _RTL_RE.search(text):
        return text
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display

        return get_display(arabic_reshaper.reshape(text))
    except Exception:  # noqa: BLE001 — shaping is best-effort
        return text


def _pdf_create(path: str, content: str) -> str:
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos

    pdf = FPDF()
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()
    font_loaded = False
    font_path = _find_unicode_font()
    if font_path:
        try:
            pdf.add_font("uni", "", font_path)
            # Same file for the bold style: fpdf needs every style registered,
            # headings render with fake bold.
            pdf.add_font("uni", "B", font_path)
            pdf.set_font("uni", size=11)
            font_loaded = True
        except Exception:  # noqa: BLE001, S110 — fall back to a core font
            pass
    if not font_loaded:
        pdf.set_font("helvetica", size=11)

    def write_line(text: str, size: int = 11, style: str = "", indent: int = 0) -> None:
        pdf.set_font("uni" if font_loaded else "helvetica", style=style, size=size)
        if indent:
            pdf.set_x(pdf.l_margin + indent)
        pdf.multi_cell(0, 7, _shape_rtl(text), new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    for kind, text in _markdown_blocks(content):
        if kind == "rule":
            pdf.add_page()
        elif kind == "heading":
            level = min(6, max(1, _heading_level(text)))
            write_line(
                _strip_bold(text.lstrip("#").strip()),
                size=max(12, 19 - level * 2),
                style="B",
            )
        elif kind == "bullet":
            write_line(f"• {text}", indent=4)
        else:
            write_line(text)
    try:
        pdf.output(path)
    except Exception as exc:
        raise DocError(f"cannot write PDF: {exc}") from exc
    note = ""
    if not font_loaded:
        note = " (no Unicode font found — non-latin characters may be lost)"
    return f"created PDF {path} ({len(content)} chars of source){note}"


def _pdf_edit(
    path: str, dest: str = "", pages: str = "", source: str = ""
) -> str:
    from pypdf import PdfReader, PdfWriter

    _check_size(path)
    reader = PdfReader(path)
    total = len(reader.pages)
    if dest and pages:
        writer = PdfWriter()
        for i in _parse_page_ranges(pages, total):
            writer.add_page(reader.pages[i])
        with open(dest, "wb") as fh:
            writer.write(fh)
        return f"extracted pages [{pages}] of {path} ({total} pages) into {dest}"
    if source:
        _check_size(source)
        src_reader = PdfReader(source)
        writer = PdfWriter()
        for p in reader.pages:
            writer.add_page(p)
        for p in src_reader.pages:
            writer.add_page(p)
        tmp = path + ".tmp.pdf"
        with open(tmp, "wb") as fh:
            writer.write(fh)
        os.replace(tmp, path)
        return f"merged {source} ({len(src_reader.pages)} pages) into {path} (now {total + len(src_reader.pages)} pages)"
    if pages:
        drop = set(_parse_page_ranges(pages, total))
        keep = [i for i in range(total) if i not in drop]
        if not keep:
            raise DocError("refusing to delete every page of the PDF")
        writer = PdfWriter()
        for i in keep:
            writer.add_page(reader.pages[i])
        tmp = path + ".tmp.pdf"
        with open(tmp, "wb") as fh:
            writer.write(fh)
        os.replace(tmp, path)
        return f"deleted pages [{pages}] from {path} (now {len(keep)} pages)"
    raise DocError(
        "pdf edit needs `dest`+`pages` (extract), `source` (merge) or `pages` (delete)"
    )


# ---------------------------------------------------------------------------
# Word (.docx)
# ---------------------------------------------------------------------------

def _markdown_blocks(content: str) -> list[tuple[str, str]]:
    """Split markdown-lite text into (kind, text) blocks.

    kinds: heading (keeps its #'s), bullet, rule (`---` → page break in PDF),
    paragraph. Inline **bold** stays in the text for renderers that support
    runs (docx) and is stripped by renderers that do not (pdf).
    """
    blocks: list[tuple[str, str]] = []
    for raw in (content or "").replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        if re.match(r"^\s*-{3,}\s*$", line):
            blocks.append(("rule", ""))
        elif re.match(r"^#{1,6}\s+", line):
            blocks.append(("heading", line))
        elif re.match(r"^[-*•]\s+", line):
            blocks.append(("bullet", re.sub(r"^[-*•]\s+", "", line)))
        elif re.match(r"^\d+[.)]\s+", line):
            blocks.append(("bullet", re.sub(r"^\d+[.)]\s+", "", line)))
        else:
            blocks.append(("paragraph", line))
    return blocks


def _heading_level(text: str) -> int:
    return len(text) - len(text.lstrip("#"))


def _strip_bold(text: str) -> str:
    return re.sub(r"\*\*(.+?)\*\*", r"\1", text)


def _docx_add_blocks(doc: Any, content: str) -> None:
    for kind, text in _markdown_blocks(content):
        if kind == "rule":
            continue
        if kind == "heading":
            level = min(6, max(1, _heading_level(text)))
            doc.add_heading(_strip_bold(text.lstrip("#").strip()), level=level)
        elif kind == "bullet":
            p = doc.add_paragraph(style="List Bullet")
            _docx_runs(p, text)
        else:
            p = doc.add_paragraph()
            _docx_runs(p, text)


def _docx_runs(paragraph: Any, text: str) -> None:
    """Add runs to a paragraph, honoring **bold** spans.

    The split runs on the ORIGINAL text — stripping the markers first (the
    old behavior) made the bold pattern unmatchable, so `**bold**` silently
    rendered as plain text.
    """
    for part in re.split(r"(\*\*.+?\*\*)", text or ""):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            paragraph.add_run(part[2:-2]).bold = True
        else:
            paragraph.add_run(part)


def _docx_all_paragraphs(doc: Any) -> list[Any]:
    """Body paragraphs AND table-cell paragraphs, in document order."""
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    out: list[Any] = []
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            out.append(Paragraph(child, doc))
        elif child.tag == qn("w:tbl"):
            table = Table(child, doc)
            for row in table.rows:
                for cell in row.cells:
                    out.extend(cell.paragraphs)
    return out


def _docx_read(path: str) -> str:
    _check_size(path)
    from docx import Document

    try:
        doc = Document(path)
    except Exception as exc:
        raise DocError(f"cannot open Word file: {exc}") from exc
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    lines: list[str] = []
    chars = 0
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            para = Paragraph(child, doc)
            text = para.text.strip()
            if not text:
                continue
            style = (para.style.name or "").lower() if para.style is not None else ""
            m = re.match(r"heading (\d)", style)
            if m:
                lines.append("#" * int(m.group(1)) + " " + text)
            elif "list bullet" in style or "list number" in style:
                lines.append("- " + text)
            else:
                lines.append(text)
        elif child.tag == qn("w:tbl"):
            table = Table(child, doc)
            rows = [
                [c.text.strip().replace("\n", " ") for c in row.cells]
                for row in table.rows
            ]
            lines.append(_render_table(rows, MAX_XLSX_ROWS, MAX_XLSX_COLS))
        chars += len(lines[-1]) if lines else 0
        if chars > MAX_DOC_READ_CHARS:
            lines.append(f"[truncated at {MAX_DOC_READ_CHARS} chars]")
            break
    return "\n".join(lines) if lines else "[empty document]"


def _docx_create(path: str, content: str) -> str:
    from docx import Document

    doc = Document()
    _docx_add_blocks(doc, content)
    _ensure_parent(path)
    try:
        doc.save(path)
    except Exception as exc:
        raise DocError(f"cannot write Word file: {exc}") from exc
    return f"created Word document {path} ({len(content)} chars of source)"


def _docx_edit(
    path: str, content: str = "", find: str = "", replace: str = ""
) -> str:
    from docx import Document

    _check_size(path)
    if not find and not content:
        raise DocError(
            "docx edit needs `find`+`replace` (replace text) or `content` (append)"
        )
    try:
        doc = Document(path)
    except Exception as exc:
        raise DocError(f"cannot open Word file: {exc}") from exc
    replaced = 0
    if find:
        for para in _docx_all_paragraphs(doc):
            if find not in para.text:
                continue
            full = para.text.replace(find, replace)
            replaced += para.text.count(find)
            runs = para.runs
            if runs:
                runs[0].text = full
                for r in runs[1:]:
                    r.text = ""
            else:
                para.add_run(full)
        if not replaced:
            # Report as an error so the model retries instead of telling the
            # user "done" while nothing changed.
            raise DocError(
                f"find text {find!r} not found in the document — nothing replaced"
            )
    if content:
        _docx_add_blocks(doc, content)
    try:
        doc.save(path)
    except Exception as exc:
        raise DocError(f"cannot save Word file: {exc}") from exc
    parts = []
    if find:
        parts.append(f"replaced {replaced} occurrence(s) of {find!r}")
    if content:
        parts.append(f"appended {len(content)} chars")
    return f"edited {path}: " + ", ".join(parts)


def _coerce_bold(value: Any) -> bool | None:
    """Coerce an LLM-provided bold flag to bool/None.

    The model sometimes sends 'true'/'True' strings instead of JSON booleans;
    without this python-docx raises TypeError and the style call fails.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("", "none", "null"):
            return None
        if v in ("true", "1", "yes", "on"):
            return True
        if v in ("false", "0", "no", "off"):
            return False
    raise DocError(f"invalid bold {value!r} — use true or false")


def _coerce_size(value: Any) -> float:
    """Coerce an LLM-provided size to float (accepts numeric strings)."""
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        v = value.strip()
        if not v:
            return 0
        try:
            return float(v)
        except ValueError:
            raise DocError(f"invalid size {value!r} — use a number like 12") from None
    raise DocError(f"invalid size {value!r} — use a number like 12")


def _apply_run_font(run: Any, font: str, size: float, bold: bool | None, color: str) -> None:
    """Apply font family / size / bold / color to one docx run.

    The family is ALSO written to the complex-script (``w:cs``) and east-asian
    slots — Word renders Persian/Arabic text from the cs slot, so without it a
    "change the font" request silently does nothing on RTL text.
    """
    bold = _coerce_bold(bold)
    size = _coerce_size(size)
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    if font:
        run.font.name = font
        r_pr = run._element.get_or_add_rPr()
        r_fonts = r_pr.get_or_add_rFonts()
        r_fonts.set(qn("w:cs"), font)
        r_fonts.set(qn("w:eastAsia"), font)
    if size:
        run.font.size = Pt(size)
        # Word renders RTL text from w:szCs while the HTML preview reads
        # w:sz, so mirror the size into both slots.
        r_pr = run._element.get_or_add_rPr()
        sz_cs = r_pr.find(qn("w:szCs"))
        if sz_cs is None:
            sz_cs = OxmlElement("w:szCs")
            r_pr.append(sz_cs)
        sz_cs.set(qn("w:val"), str(round(float(size) * 2)))
    if bold is not None:
        run.font.bold = bold
        # Same split for bold: preview reads w:b, Word RTL reads w:bCs.
        r_pr = run._element.get_or_add_rPr()
        b_cs = r_pr.find(qn("w:bCs"))
        if b_cs is None:
            b_cs = OxmlElement("w:bCs")
            r_pr.append(b_cs)
        if bold:
            if b_cs.get(qn("w:val")) is not None:
                del b_cs.attrib[qn("w:val")]
        else:
            b_cs.set(qn("w:val"), "false")
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def _docx_style(
    path: str,
    font: str = "",
    size: float = 0,
    bold: bool | None = None,
    color: str = "",
    find: str = "",
) -> str:
    from docx import Document

    bold = _coerce_bold(bold)
    size = _coerce_size(size)
    _check_size(path)
    if not font and not size and bold is None and not color:
        raise DocError(
            "style needs at least one of `font`, `size`, `bold`, `color`"
        )
    color = _validate_hex(color)
    try:
        doc = Document(path)
    except Exception as exc:
        raise DocError(f"cannot open Word file: {exc}") from exc
    styled = 0
    for para in _docx_all_paragraphs(doc):
        if find and find not in para.text:
            continue
        for run in para.runs:
            _apply_run_font(run, font, size, bold, color)
            styled += 1
    if not styled:
        raise DocError(
            f"no text runs matched{f' {find!r}' if find else ''} — nothing styled"
        )
    try:
        doc.save(path)
    except Exception as exc:
        raise DocError(f"cannot save Word file: {exc}") from exc
    what = ", ".join(
        filter(None, [
            f"font={font}" if font else "",
            f"size={size:g}pt" if size else "",
            f"bold={bold}" if bold is not None else "",
            f"color=#{color}" if color else "",
        ])
    )
    scope = f"text matching {find!r}" if find else "whole document"
    return f"styled {styled} run(s) ({what}) in {scope} — {path}"


# ---------------------------------------------------------------------------
# Excel (.xlsx / .xlsm)
# ---------------------------------------------------------------------------

def _xlsx_read(path: str, sheet: str = "") -> str:
    _check_size(path)
    import openpyxl

    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        names = list(wb.sheetnames)
        wanted = [sheet] if sheet else names[:MAX_XLSX_SHEETS]
        if sheet and sheet not in names:
            raise DocError(
                f"sheet {sheet!r} not found — sheets: {', '.join(names[:20])}"
            )
        out: list[str] = [f"Excel: {len(names)} sheet(s)"]
        for name in wanted:
            ws = wb[name]
            rows: list[list[str]] = []
            truncated = False
            for r, row in enumerate(
                ws.iter_rows(values_only=True, max_col=MAX_XLSX_COLS)
            ):
                if r >= MAX_XLSX_ROWS:
                    truncated = True
                    break
                rows.append(["" if c is None else str(c) for c in row])
            out.append(f"### sheet: {name} ({ws.max_row} rows)\n" + _render_table(
                rows, MAX_XLSX_ROWS, MAX_XLSX_COLS
            ))
            if truncated:
                out.append(
                    f"[sheet {name!r} truncated at {MAX_XLSX_ROWS} rows]"
                )
        return "\n\n".join(out)
    finally:
        wb.close()


def _xls_read(path: str, sheet: str = "") -> str:
    # Low-memory legacy .xls read: open on demand and load only the
    # requested sheet, capped by the shared row/col limits.
    _check_size(path)
    try:
        import xlrd
    except ImportError as exc:
        raise DocError("reading .xls needs the 'xlrd' package") from exc
    try:
        book = xlrd.open_workbook(path, on_demand=True)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        try:
            names = list(book.sheet_names())
        except Exception as exc:
            raise DocError(f"cannot list sheets: {exc}") from exc
        if not names:
            raise DocError("workbook has no sheets")
        if sheet:
            if sheet not in names:
                raise DocError(
                    f"sheet {sheet!r} not found — sheets: {', '.join(names[:20])}"
                )
            wanted = [sheet]
        else:
            wanted = names[:MAX_XLSX_SHEETS]
        out: list[str] = [f"Excel: {len(names)} sheet(s)"]
        for name in wanted:
            try:
                ws = book.sheet_by_name(name)
            except Exception as exc:
                raise DocError(f"cannot open sheet {name!r}: {exc}") from exc
            try:
                total_rows = ws.nrows
                nrows = min(total_rows, MAX_XLSX_ROWS)
                ncols = min(ws.ncols, MAX_XLSX_COLS)
                rows: list[list[str]] = []
                for r in range(nrows):
                    row: list[str] = []
                    for c in range(ncols):
                        try:
                            v = ws.cell_value(r, c)
                        except Exception:  # noqa: BLE001 — one bad cell skips
                            v = ""
                        if v == "" or v is None:
                            row.append("")
                        elif isinstance(v, float) and v.is_integer():
                            row.append(str(int(v)))
                        else:
                            row.append(str(v))
                    rows.append(row)
                out.append(
                    f"### sheet: {name} ({total_rows} rows)\n"
                    + _render_table(rows, MAX_XLSX_ROWS, MAX_XLSX_COLS)
                )
                if total_rows > MAX_XLSX_ROWS:
                    out.append(f"[sheet {name!r} truncated at {MAX_XLSX_ROWS} rows]")
            finally:
                try:
                    book.unload_sheet(name)
                except Exception:  # noqa: BLE001, S110 — best effort cleanup
                    pass
        return "\n\n".join(out)
    finally:
        try:
            book.release_resources()
        except Exception:  # noqa: BLE001, S110 — best effort cleanup
            pass


def _xls_render_html(path: str, sheet: str = "", pages: str = "") -> str:
    # Paginated HTML grid for legacy .xls with the shared row/col caps so
    # large files render without filling RAM. `pages` (e.g. "1-200") picks
    # 1-based row ranges; empty renders the first window.
    _check_size(path)
    try:
        import xlrd
    except ImportError as exc:
        raise DocError("rendering .xls needs the 'xlrd' package") from exc
    try:
        book = xlrd.open_workbook(path, on_demand=True)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        names = list(book.sheet_names())
        if not names:
            raise DocError("workbook has no sheets")
        if sheet and sheet not in names:
            raise DocError(
                f"sheet {sheet!r} not found — sheets: {', '.join(names[:20])}"
            )
        wanted = [sheet] if sheet else names[:MAX_XLSX_SHEETS]
        parts: list[str] = []
        for name in wanted:
            try:
                ws = book.sheet_by_name(name)
            except Exception as exc:
                raise DocError(f"cannot open sheet {name!r}: {exc}") from exc
            try:
                total_rows = ws.nrows
                ncols = min(ws.ncols, MAX_XLSX_COLS)
                if (pages or "").strip() and total_rows:
                    wanted_rows = _parse_page_ranges(pages, total_rows)[:MAX_XLSX_ROWS]
                else:
                    wanted_rows = list(range(min(total_rows, MAX_XLSX_ROWS)))
                header = "".join(
                    f"<th>{_col_letter(c)}</th>" for c in range(ncols)
                )
                head_html = f"<thead><tr><th></th>{header}</tr></thead>"
                body_rows: list[str] = []
                for r in wanted_rows:
                    tds: list[str] = []
                    for c in range(ncols):
                        try:
                            v = ws.cell_value(r, c)
                        except Exception:  # noqa: BLE001 — one bad cell skips
                            v = ""
                        if v == "" or v is None:
                            val = ""
                        elif isinstance(v, float) and v.is_integer():
                            val = str(int(v))
                        else:
                            val = _html_escape(str(v))
                        if r == 0:
                            tds.append(f'<th dir="auto">{val}</th>')
                        else:
                            tds.append(f'<td dir="auto">{val}</td>')
                    body_rows.append(f"<tr><th>{r + 1}</th>{''.join(tds)}</tr>")
                parts.append(f'<h3 dir="auto">{_html_escape(name)}</h3>')
                parts.append(
                    '<table border="1" cellpadding="4" cellspacing="0" '
                    'style="border-collapse:collapse;white-space:pre">'
                    + head_html
                    + "<tbody>"
                    + "".join(body_rows)
                    + "</tbody></table>"
                )
                if (pages or "").strip():
                    parts.append(
                        f"<p><em>[showing {len(wanted_rows)} of {total_rows} rows — rows {_html_escape(pages)}]</em></p>"
                    )
                else:
                    parts.append(
                        f"<p><em>[showing {len(wanted_rows)} of {total_rows} rows]</em></p>"
                    )
            finally:
                try:
                    book.unload_sheet(name)
                except Exception:  # noqa: BLE001, S110 — best effort cleanup
                    pass
        return "\n".join(parts) or "<p>[empty workbook]</p>"
    finally:
        try:
            book.release_resources()
        except Exception:  # noqa: BLE001, S110 — best effort cleanup
            pass


def _col_letter(idx: int) -> str:
    """Convert a 0-based column index to Excel letters (0 -> A, 26 -> AA)."""
    name = ""
    n = idx + 1
    while n:
        n, rem = divmod(n - 1, 26)
        name = chr(65 + rem) + name
    return name


def _csv_load_rows(path: str) -> tuple[list[list[str]], str]:
    """Load CSV rows with delimiter sniffing, capped to shared limits."""
    _check_size(path)
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            sample = fh.read(8192)
            fh.seek(0)
            try:
                delimiter = csv.Sniffer().sniff(
                    sample, delimiters=[",", ";", "\t", "|"]
                ).delimiter
            except Exception:  # noqa: BLE001 — fall back to comma
                delimiter = ","
            try:
                rows = [row for row in csv.reader(fh, delimiter=delimiter)]
            except csv.Error as exc:
                raise DocError(f"cannot parse CSV: {exc}") from exc
    except OSError as exc:
        raise DocError(f"cannot read file: {exc}") from exc
    capped: list[list[str]] = []
    for row in rows:
        capped.append([str(c) for c in row[:MAX_XLSX_COLS]])
    return capped, delimiter


def _csv_read(path: str, pages: str = "") -> str:
    """Read a CSV file as TSV text with pagination via `pages` like "1-120"."""
    rows, _ = _csv_load_rows(path)
    total = len(rows)
    if not total:
        return "[empty csv]"
    if (pages or "").strip():
        indices = _parse_page_ranges(pages, total)[:MAX_XLSX_ROWS]
    else:
        indices = list(range(min(total, MAX_XLSX_ROWS)))
    picked = [rows[i] for i in indices if 0 <= i < total]
    out = [f"CSV: {total} row(s), showing {len(picked)}"]
    out.append(_render_table(picked, MAX_XLSX_ROWS, MAX_XLSX_COLS))
    out.append(f"[showing {len(picked)} of {total} rows]")
    return "\n\n".join(out)


def _csv_render_html(path: str, pages: str = "", sheet: str = "") -> str:
    """Render a CSV file as an Excel-like HTML grid with header and row numbers."""
    _ = sheet  # sheet is ignored for CSV, kept for dispatch compatibility
    rows, _ = _csv_load_rows(path)
    total = len(rows)
    if not total:
        return "<p>[empty csv]</p>"
    ncols = min(max((len(r) for r in rows), default=0), MAX_XLSX_COLS)
    if not ncols:
        return "<p>[empty csv]</p>"
    if (pages or "").strip():
        indices = _parse_page_ranges(pages, total)[:MAX_XLSX_ROWS]
    else:
        indices = list(range(min(total, MAX_XLSX_ROWS)))
    header = "".join(f"<th>{_col_letter(c)}</th>" for c in range(ncols))
    head_html = f"<thead><tr><th></th>{header}</tr></thead>"
    body_rows: list[str] = []
    for i in indices:
        if i >= total:
            continue
        row = rows[i]
        padded = row[:ncols] + [""] * (ncols - len(row[:ncols]))
        cells: list[str] = []
        for val in padded:
            esc = _html_escape(val)
            if i == 0:
                cells.append(f'<th dir="auto">{esc}</th>')
            else:
                cells.append(f'<td dir="auto">{esc}</td>')
        body_rows.append(f"<tr><th>{i + 1}</th>{''.join(cells)}</tr>")
    table = (
        '<table border="1" cellpadding="4" cellspacing="0" '
        'style="border-collapse:collapse;white-space:pre">'
        + head_html
        + "<tbody>"
        + "".join(body_rows)
        + "</tbody></table>"
    )
    note = f"<p><em>[showing {len(body_rows)} of {total} rows]</em></p>"
    return f"<h3>CSV</h3>\n{table}\n{note}"


def _xlsx_create(path: str, content: str, sheet: str = "") -> str:
    import openpyxl

    rows = _parse_rows(content)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet or "Sheet1"
    for row in rows:
        ws.append(row)
    _ensure_parent(path)
    try:
        wb.save(path)
    except Exception as exc:
        raise DocError(f"cannot write Excel file: {exc}") from exc
    return f"created Excel file {path} ({ws.max_row} rows × {ws.max_column} cols)"


def _xlsx_edit(
    path: str, content: str = "", sheet: str = "", cell: str = "", value: str = ""
) -> str:
    import openpyxl

    _check_size(path)
    if not cell and not content:
        raise DocError(
            "xlsx edit needs `cell`+`value` (set one cell) or `content` (append rows)"
        )
    try:
        wb = openpyxl.load_workbook(path)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        if cell:
            ws = wb[sheet] if sheet and sheet in wb.sheetnames else wb.active
            if sheet and sheet not in wb.sheetnames:
                ws = wb.create_sheet(sheet)
            ws[cell] = _coerce_value(value)
            saved = f"set {ws.title}!{cell}"
        if content:
            rows = _parse_rows(content)
            if sheet and sheet in wb.sheetnames:
                ws2 = wb[sheet]
            elif sheet:
                ws2 = wb.create_sheet(sheet)
            else:
                ws2 = wb.active
            for row in rows:
                ws2.append(row)
            saved = f"appended {len(rows)} row(s) to {ws2.title}"
        try:
            wb.save(path)
        except Exception as exc:
            raise DocError(f"cannot save Excel file: {exc}") from exc
        return f"edited {path}: {saved}"
    finally:
        wb.close()


MAX_XLSX_STYLE_CELLS = 20_000


def _xlsx_style(
    path: str,
    font: str = "",
    size: float = 0,
    bold: bool | None = None,
    color: str = "",
    sheet: str = "",
    cell: str = "",
    rng: str = "",
) -> str:
    import openpyxl
    from openpyxl.styles import Font

    bold = _coerce_bold(bold)
    size = _coerce_size(size)
    _check_size(path)
    if not font and not size and bold is None and not color:
        raise DocError(
            "style needs at least one of `font`, `size`, `bold`, `color`"
        )
    color = _validate_hex(color)
    try:
        wb = openpyxl.load_workbook(path)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        if sheet and sheet not in wb.sheetnames:
            raise DocError(
                f"sheet {sheet!r} not found — sheets: {', '.join(wb.sheetnames[:20])}"
            )
        ws = wb[sheet] if sheet else wb.active
        if rng:
            try:
                groups = ws[rng]
            except Exception as exc:
                raise DocError(
                    f"invalid range {rng!r} — use e.g. \"A1:C10\""
                ) from exc
            if isinstance(groups, openpyxl.cell.cell.Cell):
                groups = ((groups,),)
        elif cell:
            groups = ((ws[cell],),)
        else:
            if (ws.max_row or 0) * (ws.max_column or 0) > MAX_XLSX_STYLE_CELLS:
                raise DocError(
                    f"sheet {ws.title!r} is too large to style whole — pass a "
                    "`rng` like \"A1:D50\" or a `cell`"
                )
            groups = tuple(
                tuple(row) for row in ws.iter_rows(max_col=MAX_XLSX_COLS)
            )
        # openpyxl Font replaces the whole font of a cell — build it once.
        kw: dict[str, Any] = {}
        if font:
            kw["name"] = font
        if size:
            kw["size"] = size
        if bold is not None:
            kw["bold"] = bold
        if color:
            kw["color"] = f"00{color}"
        styled = 0
        for row in groups:
            for c in row:
                c.font = Font(**kw)
                styled += 1
        try:
            wb.save(path)
        except Exception as exc:
            raise DocError(f"cannot save Excel file: {exc}") from exc
        what = ", ".join(
            filter(None, [
                f"font={font}" if font else "",
                f"size={size:g}" if size else "",
                f"bold={bold}" if bold is not None else "",
                f"color=#{color}" if color else "",
            ])
        )
        target = rng or (f"cell {cell}" if cell else f"sheet {ws.title!r}")
        return f"styled {styled} cell(s) ({what}) in {ws.title}!{target} — {path}"
    finally:
        wb.close()


def _coerce_value(value: str) -> Any:
    """Store numeric-looking values as numbers, everything else as text."""
    v = (value or "").strip()
    if re.fullmatch(r"-?\d+", v):
        try:
            return int(v)
        except ValueError:
            return v
    if re.fullmatch(r"-?\d*\.\d+", v):
        try:
            return float(v)
        except ValueError:
            return v
    return value


# ---------------------------------------------------------------------------
# text files
# ---------------------------------------------------------------------------

def _text_read(path: str) -> str:
    _check_size(path)
    try:
        with open(path, "rb") as fh:
            data = fh.read(MAX_DOC_READ_CHARS * 4 + 4)
    except OSError as exc:
        raise DocError(f"cannot read file: {exc}") from exc
    text = data.decode("utf-8", errors="replace")
    if len(text) > MAX_DOC_READ_CHARS:
        text = text[:MAX_DOC_READ_CHARS] + f"\n[truncated at {MAX_DOC_READ_CHARS} chars]"
    return text


# ---------------------------------------------------------------------------
# dispatchers
# ---------------------------------------------------------------------------

def _ensure_parent(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _validate_hex(color: str) -> str:
    """Normalize a color to 6 uppercase hex digits (``#abc`` → ``AABBCC``).

    Empty input is a no-op (the caller skips the color attribute).
    """
    c = (color or "").strip().lstrip("#")
    if not c:
        return ""
    if re.fullmatch(r"[0-9a-fA-F]{3}", c):
        c = "".join(ch * 2 for ch in c)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        raise DocError(
            f"invalid color {color!r} — use 6 hex digits like \"FF0000\""
        )
    return c.upper()


# ---------------------------------------------------------------------------
# rich rendering for the UI viewer (styled HTML / PDF page images)
# ---------------------------------------------------------------------------

MAX_PDF_PREVIEW_PAGES = 12
MAX_PDF_PREVIEW_ZOOM = 1.4


def _html_escape(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _run_style(font_name: str = "", size_pt: float = 0, bold: bool | None = None,
               italic: bool | None = None, color: str = "") -> str:
    """Inline CSS for a docx run / xlsx cell (only non-default attributes)."""
    css: list[str] = []
    if font_name:
        css.append(f"font-family:{_html_escape(font_name)}")
    if size_pt:
        css.append(f"font-size:{size_pt:g}pt")
    if bold:
        css.append("font-weight:700")
    if italic:
        css.append("font-style:italic")
    if color:
        css.append(f"color:#{color}")
    return ";".join(css)


def _docx_render_html(path: str) -> str:
    """Render a .docx as styled HTML (headings, lists, bold/italic, fonts,
    colors, tables) so the viewer shows the real document, not raw text."""
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    _check_size(path)
    try:
        doc = Document(path)
    except Exception as exc:
        raise DocError(f"cannot open Word file: {exc}") from exc

    def run_html(run: Any) -> str:
        text = _html_escape(run.text)
        if not text:
            return ""
        f = run.font
        style = _run_style(
            font_name=f.name or "",
            size_pt=(f.size.pt if f.size else 0),
            bold=f.bold if f.bold is True else None,
            italic=f.italic if f.italic is True else None,
            color=(str(f.color.rgb) if f.color and f.color.rgb else ""),
        )
        return f'<span style="{style}">{text}</span>' if style else text

    def para_html(para: Any) -> str:
        inner = "".join(run_html(r) for r in para.runs)
        if not inner.strip():
            return ""
        style_name = (para.style.name or "").lower() if para.style is not None else ""
        align = para.alignment
        align_css = ""
        if align is not None:
            align_css = {1: "center", 2: "right", 3: "justify"}.get(
                int(align), ""
            )
            align_css = f" text-align:{align_css};" if align_css else ""
        m = re.match(r"heading (\d)", style_name)
        if m:
            lvl = min(6, int(m.group(1)))
            return f'<h{lvl} dir="auto">{inner}</h{lvl}>'
        if "list bullet" in style_name or "list number" in style_name:
            return f'<li dir="auto">{inner}</li>'
        return f'<p dir="auto" style="margin:6px 0;{align_css}">{inner}</p>'

    parts: list[str] = []
    list_open = False
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            html = para_html(Paragraph(child, doc))
            if not html:
                continue
            is_li = html.startswith("<li>")
            if is_li and not list_open:
                parts.append("<ul>")
                list_open = True
            elif not is_li and list_open:
                parts.append("</ul>")
                list_open = False
            parts.append(html)
        elif child.tag == qn("w:tbl"):
            if list_open:
                parts.append("</ul>")
                list_open = False
            table = Table(child, doc)
            rows_html: list[str] = []
            for row in table.rows:
                cells = "".join(
                    "<td dir='auto'>"
                    + "".join(run_html(r) for p in cell.paragraphs for r in p.runs)
                    + "</td>"
                    for cell in row.cells
                )
                rows_html.append(f"<tr>{cells}</tr>")
            parts.append(
                '<table border="1" cellpadding="6" cellspacing="0" '
                'style="border-collapse:collapse;margin:8px 0">'
                + "".join(rows_html)
                + "</table>"
            )
    if list_open:
        parts.append("</ul>")
    return "\n".join(parts) or "<p>[empty document]</p>"


def _xlsx_render_html(path: str, sheet: str = "", pages: str = "") -> str:
    """Render an .xlsx as styled HTML grids (values + per-cell fonts) so the
    viewer shows a real spreadsheet look. `pages` (e.g. "1-200") paginates
    1-based row ranges; empty renders the first window."""
    import openpyxl

    _check_size(path)
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    except Exception as exc:
        raise DocError(f"cannot open Excel file: {exc}") from exc
    try:
        names = list(wb.sheetnames)
        if sheet and sheet not in names:
            raise DocError(
                f"sheet {sheet!r} not found — sheets: {', '.join(names[:20])}"
            )
        wanted = [sheet] if sheet else names[:MAX_XLSX_SHEETS]
        parts: list[str] = []
        for name in wanted:
            ws = wb[name]
            total_rows = ws.max_row or 0
            if (pages or "").strip() and total_rows:
                picked = set(_parse_page_ranges(pages, total_rows))
            else:
                picked = set()
            cells_html: list[str] = []
            truncated = False
            shown = 0
            for n_rows, row in enumerate(
                ws.iter_rows(max_col=MAX_XLSX_COLS)
            ):
                if picked and n_rows not in picked:
                    continue
                if shown >= MAX_XLSX_ROWS:
                    truncated = True
                    break
                tds: list[str] = []
                for c in row:
                    val = "" if c.value is None else _html_escape(str(c.value))
                    # read_only EmptyCells carry font=None — treat as default.
                    f = getattr(c, "font", None)
                    style = _run_style(
                        font_name=(f.name or "") if f is not None else "",
                        size_pt=(f.size if f is not None and f.size else 0),
                        bold=(f.bold if f is not None and f.bold is True else None),
                        italic=(f.italic if f is not None and f.italic is True else None),
                        color=(
                            str(f.color.rgb)[2:]
                            if f is not None and f.color and f.color.rgb and len(str(f.color.rgb)) == 8
                            else ""
                        ),
                    )
                    tds.append(f'<td dir="auto" style="{style}">{val}</td>')
                cells_html.append(f"<tr>{''.join(tds)}</tr>")
                shown += 1
            parts.append(f'<h3 dir="auto">{_html_escape(name)}</h3>')
            parts.append(
                '<table border="1" cellpadding="4" cellspacing="0" '
                'style="border-collapse:collapse;white-space:pre">'
                + "".join(cells_html)
                + "</table>"
            )
            if picked:
                parts.append(
                    f"<p><em>[showing {shown} of {total_rows} rows — rows {_html_escape(pages)}]</em></p>"
                )
            elif truncated:
                parts.append(
                    f"<p><em>[truncated at {MAX_XLSX_ROWS} rows]</em></p>"
                )
        return "\n".join(parts) or "<p>[empty workbook]</p>"
    finally:
        wb.close()


def render_pdf_pages(path: str, pages: str = "") -> list[str]:
    """Rasterize PDF pages to JPEG data URLs for the visual viewer."""
    try:
        import pymupdf as fitz
    except ImportError as exc:  # pragma: no cover
        raise DocError(
            "PDF visual preview is unavailable (pymupdf not installed)"
        ) from exc
    _check_size(path)
    try:
        doc = fitz.open(path)
    except Exception as exc:
        raise DocError(f"cannot open PDF: {exc}") from exc
    try:
        total = len(doc)
        if total == 0:
            raise DocError("PDF has no pages")
        indices = _parse_page_ranges(pages, total)
        indices = indices[:MAX_PDF_PREVIEW_PAGES]
        out: list[str] = []
        for i in indices:
            pix = doc[i].get_pixmap(
                matrix=fitz.Matrix(MAX_PDF_PREVIEW_ZOOM, MAX_PDF_PREVIEW_ZOOM)
            )
            b64 = base64.b64encode(pix.tobytes("jpeg")).decode("ascii")
            out.append(f"data:image/jpeg;base64,{b64}")
        return out
    finally:
        doc.close()


def render_document(path: str, sheet: str = "", pages: str = "") -> str:
    """Render a docx/xlsx/xls/csv as styled HTML for the viewer (dispatch by ext)."""
    ext = _ext(path)
    if ext == ".docx":
        return _docx_render_html(path)
    if ext in (".xlsx", ".xlsm"):
        return _xlsx_render_html(path, sheet, pages)
    if ext == ".xls":
        return _xls_render_html(path, sheet, pages)
    if ext == ".csv":
        return _csv_render_html(path, pages)
    raise DocError(f"HTML rendering is not supported for {ext or 'this file type'}")


def read_document(path: str, sheet: str = "", pages: str = "") -> str:
    """Read a document's text (dispatches by extension). Raises DocError."""
    ext = _ext(path)
    if ext == ".pdf":
        return _pdf_read(path, pages)
    if ext in (".docx",):
        return _docx_read(path)
    if ext in (".xlsx", ".xlsm"):
        return _xlsx_read(path, sheet)
    if ext == ".xls":
        return _xls_read(path, sheet)
    if ext == ".csv":
        return _csv_read(path, pages)
    if ext == ".doc":
        raise DocError(".doc is the legacy Word format — re-save as .docx first")
    return _text_read(path)


def create_document(path: str, content: str = "", sheet: str = "") -> str:
    """Create (or overwrite) a document (dispatches by extension)."""
    ext = _ext(path)
    if not (content or "").strip():
        raise DocError("create needs non-empty `content`")
    if ext == ".pdf":
        return _pdf_create(path, content)
    if ext == ".docx":
        return _docx_create(path, content)
    if ext in (".xlsx", ".xlsm"):
        return _xlsx_create(path, content, sheet)
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return f"created {ext or 'text'} file {path} ({len(content)} chars)"


def edit_document(
    path: str,
    content: str = "",
    dest: str = "",
    sheet: str = "",
    cell: str = "",
    value: str = "",
    find: str = "",
    replace: str = "",
    pages: str = "",
    source: str = "",
) -> str:
    """Edit an existing document (dispatches by extension)."""
    ext = _ext(path)
    if ext == ".pdf":
        return _pdf_edit(path, dest=dest, pages=pages, source=source)
    if ext == ".docx":
        return _docx_edit(path, content=content, find=find, replace=replace)
    if ext in (".xlsx", ".xlsm"):
        return _xlsx_edit(path, content=content, sheet=sheet, cell=cell, value=value)
    if ext == ".doc":
        raise DocError(".doc is the legacy Word format — re-save as .docx first")
    raise DocError(
        f"{ext or 'this file type'} is a text file — use edit_file / write_file instead"
    )


def style_document(
    path: str,
    font: str = "",
    size: float = 0,
    bold: bool | None = None,
    color: str = "",
    find: str = "",
    sheet: str = "",
    cell: str = "",
    rng: str = "",
) -> str:
    """Apply font / size / bold / color to an existing document."""
    bold = _coerce_bold(bold)
    size = _coerce_size(size)
    ext = _ext(path)
    if ext == ".docx":
        return _docx_style(
            path, font=font, size=size, bold=bold, color=color, find=find
        )
    if ext in (".xlsx", ".xlsm"):
        return _xlsx_style(
            path,
            font=font,
            size=size,
            bold=bold,
            color=color,
            sheet=sheet,
            cell=cell,
            rng=rng,
        )
    if ext == ".pdf":
        raise DocError(
            "PDF fonts cannot be edited in place — recreate the PDF with "
            "write_document action='create' instead"
        )
    raise DocError(f"styling is not supported for {ext or 'this file type'} files")
