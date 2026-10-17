import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, normPath, resolveWorkspacePath, suggestSimilarFiles, workspaceFiles, type WorkspaceFile } from "../lib/fs";
import { readDocumentText } from "../lib/api";
import { commentFileSelection } from "../lib/fileComments";
import { selectionBarPos } from "../lib/selectionBar";
import { useStore } from "../lib/store";
import { copyToClipboard } from "../lib/clipboard";
import { IMAGE_EXTS, defaultAppForExt, extOf, fileBasename } from "../lib/fileTypes";
import { FileChip, FileIcon } from "./FileIcon";
import { getHighlightedLines } from "./ChatMessage";

/** Native PDF pane: WKWebView renders PDFs itself, so the viewer shows the
 *  file through a Blob object URL instead of backend-rasterized page images.
 *  The URL is created once per file and revoked on unmount/change (leaking one
 *  per opened PDF would pin the whole file in memory for the session). */
function PdfViewer({ base64, title }: { base64: string; title?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // base64 → bytes without a data-URL detour; `atob` yields a binary string
    // that must be widened to bytes or the PDF header is corrupted.
    let bin: string;
    try {
      bin = atob(base64);
    } catch {
      setUrl(null);
      return;
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const objectUrl = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [base64]);
  if (!url) return <div className="file-viewer-note">Preparing PDF…</div>;
  return (
    <iframe
      className="file-viewer-pdf"
      src={url}
      title={title ? `${title} (PDF)` : "PDF"}
    />
  );
}

/** Never paint more than this many characters of ONE file: a multi-megabyte
 *  log would freeze the tab. Copy keeps the FULL text. */
const FILE_RENDER_CAP = 400_000;

/** "Open in" destinations. All of them first try a running Neovim instance;
 *  the terminal entries then launch nvim inside that terminal (Warp's URI
 *  scheme cannot run a command, so it opens a tab at the file's folder). */
type OpenTargetId = "nvim" | "vscode" | "cmux" | "ghostty" | "warp" | "default";

const OPEN_TARGETS: Array<{
  id: OpenTargetId;
  icon: string;
  iconClass: string;
  label: string;
  hint: string;
  title: string;
}> = [
  {
    id: "nvim",
    icon: "NV",
    iconClass: "fv-open-icon-nvim",
    label: "Neovim",
    hint: "Running instance, else new terminal",
    title: "Open in the running Neovim instance (or a new terminal)",
  },
  {
    id: "cmux",
    icon: "CM",
    iconClass: "fv-open-icon-cmux",
    label: "Neovim in cmux",
    hint: "New cmux workspace running nvim",
    title: "Open nvim in a new cmux workspace (opens just the folder in cmux when its CLI refuses external apps)",
  },
  {
    id: "ghostty",
    icon: "GH",
    iconClass: "fv-open-icon-ghostty",
    label: "Neovim in Ghostty",
    hint: "New Ghostty window running nvim",
    title: "Open nvim in a new Ghostty window (requires Ghostty)",
  },
  {
    id: "warp",
    icon: "WP",
    iconClass: "fv-open-icon-warp",
    label: "Neovim in Warp",
    hint: "New Warp tab at the file's folder",
    title: "Open a new Warp tab at the file's folder (Warp cannot be told to run nvim)",
  },
  {
    id: "vscode",
    icon: "VS",
    iconClass: "fv-open-icon-vscode",
    label: "VS Code",
    hint: "code CLI, app bundle, or vscode:// handler",
    title: "Open in VS Code",
  },
];

/** Document formats routed via the backend document reader (/doc/read).
 *  PDF pages render as images, Word/Excel as styled HTML tables, and
 *  legacy/text docs (doc/csv/md) as plain text — so binary Excel never hits
 *  the "Binary file" fallback. Results are mtime-cached backend-side and
 *  the panel re-fetches only when docRev bumps (no polling). */
const DOC_EXTS = new Set(["pdf", "docx", "doc", "xlsx", "xlsm", "xls", "csv", "md"]);
/** Excel extensions that render as an HTML grid and accept a sheet name. */
const SHEET_EXTS = new Set(["xlsx", "xlsm", "xls"]);
/** Grid extensions rendered as an Excel-like table (Excel + CSV). CSV has no sheets. */
const GRID_EXTS = new Set(["xlsx", "xlsm", "xls", "csv"]);
/** Extensions read as plain text via /doc/read (no styled HTML available). */
const DOC_TEXT_EXTS = new Set(["doc", "md"]);

/** Strip HTML tags for search matching (row HTML -> plain text). */
function stripSheetTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

/** Escape a user query for RegExp (search highlight). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap query hits in <mark class="fv-mark"> without breaking HTML tags.
 *  Tag-aware: only text outside <...> is scanned (case-insensitive), so
 *  syntax-highlight spans and table markup stay intact. */
function markQueryHtml(html: string, query: string): string {
  const q = query.trim();
  if (!q) return html;
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(q), "gi");
  } catch {
    return html;
  }
  const parts = html.split(/(<[^>]+>)/g);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.startsWith("<")) continue;
    // Skip HTML entities splitting edge: plain replace is safe here.
    parts[i] = p.replace(re, (m) => `<mark class="fv-mark">${m}</mark>`);
  }
  return parts.join("");
}

/** One Excel sheet as a full-height virtualized grid: only a window of rows
 *  mounts, so an 800-row workbook never mounts tens of thousands of <td>s.
 *  Row HTML comes straight from the server-rendered table (escaped
 *  backend-side, strictly constructed styles), sliced into a visible window
 *  with spacer divs keeping the scroll height. No sheet title is rendered
 *  (the tab already shows the file name). First row renders as a sticky
 *  Excel-like header. Scrollbar stays on the right via dir=ltr. */
function colToLetters(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function VirtualSheetTable({ name, rows, query, activeRow }: { name: string; rows: string[]; query?: string; activeRow?: number }) {
  // App-scrollbar grid (like Word): no inner scroll container — the outer
  // .file-viewer-doc provides the single app scrollbar. Full render up to a
  // cap keeps small/medium sheets cheap; huge sheets show the first window.
  const CAP_ROWS = 2000;
  const total = rows.length;
  const shown = Math.min(total, CAP_ROWS);
  const q = (query ?? "").trim().toLowerCase();
  const visibleHtml = useMemo(() => {
    return rows.slice(0, shown).map((r, idx) => {
      let out = r;
      if (idx === 0) {
        out = out.replace(/<td([^>]*)>/g, '<th$1 style="background:#f2f2f2;font-weight:600;position:sticky;top:0;z-index:1;border:1px solid #d0d0d0;padding:6px 10px;">');
      }
      const isCurrent = activeRow != null && idx === activeRow;
      // Single highlight only: just the current match is marked, so searching
      // a word never highlights it anywhere else.
      if (isCurrent && q.length > 0) {
        out = markQueryHtml(out, query ?? "");
        out = out.replace(/<tr(?=[\s>])/, '<tr data-search-current="1" style="background:#fff3b0;"');
      }
      return out;
    }).join("");
  }, [rows, shown, q, query, activeRow]);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeRow != null && activeRow >= 0 && activeRow < shown) {
      gridRef.current?.querySelector<HTMLElement>(`[data-search-current="1"]`)?.scrollIntoView({ block: "center" });
    }
  }, [activeRow, shown]);
  return (
    <div className="fv-sheet-wrap" data-sheet={name} dir="ltr" style={{ direction: "ltr", textAlign: "left", width: "100%" }}>
      <div ref={gridRef}>
        <table border={1} cellPadding={6} cellSpacing={0} style={{ borderCollapse: "collapse", whiteSpace: "pre", width: "max-content", minWidth: "100%", direction: "ltr", margin: 0, background: "#ffffff", color: "#111111", fontSize: 13, lineHeight: "20px" }}>
          <tbody dangerouslySetInnerHTML={{ __html: visibleHtml }} />
        </table>
      </div>
      {total > shown && (
        <div className="file-viewer-note" dir="auto">
          Showing first {shown.toLocaleString()} of {total.toLocaleString()} rows — refine search or sheet to narrow.
        </div>
      )}
    </div>
  );
}

/** Selectable code text: memoized on the HTML string alone so selection /
 *  comment-popup state changes in the parent never re-set innerHTML (re-setting
 *  it replaces the raw text nodes, collapsing a partial-line native Range
 *  into a whole line / clearing the highlight). Gutter stays outside this
 *  node with user-select:none + pointer-events:none (see CSS), so the live
 *  Selection always lives in this raw text node and partial drags stay partial. */
const CodeText = memo(function CodeText({ html }: { html: string }) {
  return (
    <span
      className="fv-text"
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html === "" ? "\n" : html }}
    />
  );
});

/** Parse a locateSelection locator ("line 42" / "lines 42-45") into [lo,hi]. */
function parseCommentRange(loc: string): [number, number] | null {
  const m = /(\d+)(?:\s*-\s*(\d+))?/.exec(loc);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** Docked viewer tab for one workspace file: line-numbered, syntax
 *  highlighted, with an optional target line highlighted and scrolled into
 *  view (opened via file chips / LSP jumps). Images render inline,
 *  binary files show a notice. Relative paths are read against the
 *  workspace root captured at open time (survives chat switches). */
export function FileViewerPanel({
  filePath,
  fileLine,
  fileRoot,
  chatId,
}: {
  filePath: string;
  fileLine?: number;
  fileRoot?: string;
  /** Owning chat: file tabs are chat-scoped, live edits and comments stay
   *  in this chat. Defaults to the active chat when omitted. */
  chatId?: string;
}) {
  const storeRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const root = fileRoot || storeRoot;
  // Absolute path for external editors / image reads (plain string join — the
  // renderer has no node:path). Invisible bidi marks are stripped first: model
  // output and tool results carry them inside paths, and they made fs_read
  // miss files that exist.
  const cleanFilePath = normPath(filePath);
  const absPath = cleanFilePath.startsWith("/")
    ? cleanFilePath
    : `${(root || "").replace(/\/+$/, "")}/${cleanFilePath}`;
  const ext = extOf(filePath);
  const isImage = IMAGE_EXTS.has(ext);
  // Office documents (Word/Excel/PDF) open in the system default app
  // (Word/Excel/PDF viewer) — code editors are hidden for these types.
  const defaultApp = defaultAppForExt(ext);
  const isOfficeDoc = defaultApp !== null;
  const defaultAppLabel = defaultApp?.label ?? "Default app";
  const defaultTargetIcon = defaultApp?.icon ?? "DOC";
  const visibleTargets:
    | typeof OPEN_TARGETS
    | Array<{
        id: OpenTargetId;
        icon: string;
        iconClass: string;
        label: string;
        hint: string;
        title: string;
      }> = isOfficeDoc
    ? [
        {
          id: "default",
          icon: defaultTargetIcon,
          iconClass: "fv-open-icon-default",
          label: `Open in ${defaultAppLabel}`,
          hint: "System default app",
          title: `Open in ${defaultAppLabel}`,
        },
      ]
    : OPEN_TARGETS;
  // Live editing: every write_document tool_result / write_file+edit_file
  // diff bumps this counter for the touched path, so an open viewer
  // re-fetches and shows the agent's edits as they happen.
  const docRev = useStore((s) => s.docRev[absPath] ?? 0);
  // App-wide RTL/LTR toggle (the app bar switch): the viewer chrome follows
  // it, while each content line keeps its own direction (see row dir below).
  const appDir = useStore((s) => s.dir);
  const activeChatId = useStore((s) => s.activeChatId);
  // Owning chat for live refresh + comments (file tabs are chat-scoped).
  const ownerChatId = chatId ?? activeChatId;

  const [state, setState] = useState<{
    loading: boolean;
    content?: string;
    imageData?: string;
    /** Whole-file base64 of a PDF handed to the webview's own PDF renderer. */
    pdfBase64?: string;
    html?: string;
    pages?: string[];
    error?: string;
  }>({ loading: true });
  const [copied, setCopied] = useState(false);
  const [extNote, setExtNote] = useState<string | null>(null);
  // Close workspace matches shown when the path doesn't exist — model output
  // (plans, summaries) references plenty of paths that were never created or
  // have moved, and a bare "not found" is a dead end.
  const [similar, setSimilar] = useState<WorkspaceFile[]>([]);
  const [openMenu, setOpenMenu] = useState(false);
  const [opening, setOpening] = useState<null | OpenTargetId>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Excel sheet selector: only the requested sheet is parsed backend-side
  // (low-memory on_demand read), so large workbooks stay cheap.
  const [sheet, setSheet] = useState("");
  const [sheetInput, setSheetInput] = useState("");
  // In-viewer search (Ctrl+F + search box): query, open state, match index.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [gridActiveRow, setGridActiveRow] = useState<number | undefined>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  // Frozen native Range clone: opening/focusing the popup must not clear it.
  const savedRangeRef = useRef<Range | null>(null);
  // Comment box text for the highlighted selection.
  const [commentText, setCommentText] = useState("");
  // A stale sheet name must not leak into another file.
  useEffect(() => {
    setSheet("");
    setSheetInput("");
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
    setSelBar(null);
    savedRangeRef.current = null;
  }, [absPath]);
  // Highlighted text for the "Add comment" action (-> owning chat's queue).
  // Selection events only: no timers, no polling. The highlight alone never
  // opens the editor: it only arms a small floating trigger at the highlight
  // position, so dragging a selection is never interrupted by a popup.
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState("");
  // Simple highlight comment: anchor holds viewport coordinates for a
  // fixed-position textarea (no buttons, no chrome). The highlight text is
  // frozen so the open box never depends on live window selection.
  const [anchorPos, setAnchorPos] = useState<{ x: number; y: number } | null>(null);
  // Copy/Reply toolbar armed by a highlight. The comment editor opens only
  // after Reply, so selecting text never yanks focus into a textarea.
  const [selBar, setSelBar] = useState<{ x: number; y: number } | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentQuote, setCommentQuote] = useState("");
  const [commentLoc, setCommentLoc] = useState("");
  // Line locator for the highlight: text rows carry data-line, grid rows
  // fall back to the <tr> index, so the agent can jump straight to the spot.
  const locateSelection = (sel: Selection | null): string => {
    try {
      if (!sel || sel.rangeCount === 0) return "";
      const nodeToEl = (n: Node | null): Element | null =>
        n instanceof Element ? n : (n as Node | null)?.parentElement ?? null;
      const aEl = nodeToEl(sel.anchorNode);
      const fEl = nodeToEl(sel.focusNode);
      const aLine = aEl?.closest?.("[data-line]")?.getAttribute("data-line");
      const fLine = fEl?.closest?.("[data-line]")?.getAttribute("data-line");
      const aNum = aLine ? parseInt(aLine, 10) : NaN;
      const fNum = fLine ? parseInt(fLine, 10) : NaN;
      if (Number.isFinite(aNum) || Number.isFinite(fNum)) {
        const a = Number.isFinite(aNum) ? aNum : fNum;
        const f = Number.isFinite(fNum) ? fNum : aNum;
        const lo = Math.min(a, f);
        const hi = Math.max(a, f);
        return lo === hi ? `line ${lo}` : `lines ${lo}-${hi}`;
      }
      const aRow = aEl?.closest?.("tr");
      if (aRow?.parentElement) {
        const rows = Array.from(aRow.parentElement.children);
        const i = rows.indexOf(aRow) + 1;
        const fRow = fEl?.closest?.("tr");
        // Column letters from the selected cells (Excel A1 style): the agent
        // needs both row and column to jump straight to the cell range.
        const cellOf = (el: Element | null) => el?.closest?.("td, th") ?? null;
        const colOf = (cell: Element | null): number => {
          if (!cell?.parentElement) return NaN;
          return Array.from(cell.parentElement.children).indexOf(cell) + 1;
        };
        const aCol = colOf(cellOf(aEl));
        const fCol = colOf(cellOf(fEl));
        const fmtRowsCols = (r1: number, r2: number | null, c1: number, c2: number | null): string => {
          const rowsPart = r2 != null && r2 !== r1 ? `rows ${Math.min(r1, r2)}-${Math.max(r1, r2)}` : `row ${r1}`;
          const cKnown = (v: number) => Number.isFinite(v) && v > 0;
          if (!cKnown(c1) && (c2 == null || !cKnown(c2))) return rowsPart;
          const lo = cKnown(c1) && c2 != null && cKnown(c2) ? Math.min(c1, c2) : (cKnown(c1) ? c1 : (c2 as number));
          const hi = cKnown(c1) && c2 != null && cKnown(c2) ? Math.max(c1, c2) : lo;
          const colsPart = hi !== lo ? `cols ${colToLetters(lo)}-${colToLetters(hi)}` : `col ${colToLetters(lo)}`;
          return `${rowsPart}, ${colsPart}`;
        };
        if (fRow && fRow !== aRow && fRow.parentElement === aRow.parentElement) {
          const j = rows.indexOf(fRow) + 1;
          return fmtRowsCols(i, j, aCol, fCol);
        }
        if (i > 0) {
          // Multi-cell selection inside one row (e.g. B3:D3) still carries cols.
          const sameRowMultiCol = fRow === aRow && Number.isFinite(aCol) && Number.isFinite(fCol) && aCol !== fCol;
          if (sameRowMultiCol) return fmtRowsCols(i, i, aCol, fCol);
          return fmtRowsCols(i, null, aCol, NaN);
        }
      }
    } catch {
      /* no line info */
    }
    return "";
  };
  // Highlight -> simple box (no timers/polling). Opens for any selection
  // whose anchor or focus sits inside this panel: code lines, single words,
  // grid cells and server-rendered Word/Excel HTML alike. Never closes on
  // focus/typing; closes only via Enter (send), Esc (cancel), outside press
  // with empty draft, or file change.
  const refreshSelection = (target?: EventTarget | null) => {
    const el = target as HTMLElement | null | undefined;
    if (el && typeof el.closest === "function" && el.closest("input, textarea, .fv-comment-float, .fv-comment-input, .fv-search-bar, .fv-sheet-form, .fv-open-menu")) return;
    // Freeze while the popup is open: opening the box (and focusing its
    // textarea) must not clear or rewrite the frozen quote. A new highlight
    // requires closing first (outside click / Esc / send).
    if (commentOpen) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return;
    const anchorInside = !!rootRef.current?.contains(sel.anchorNode);
    const focusInside = !!rootRef.current?.contains(sel.focusNode);
    if (!anchorInside && !focusInside) {
      return;
    }
    const text = (sel.toString().trim() ?? "");
    if (text.length === 0 || text.length > 2000) return;
    if (text === selection) return;
    // Save a clone before any state change/focus: the open must not clear it.
    let savedRect: DOMRect | undefined;
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range) {
        savedRangeRef.current = range.cloneRange();
        savedRect = range.getBoundingClientRect();
      }
    } catch {
      savedRangeRef.current = null;
    }
    setSelection(text);
    const loc = locateSelection(sel);
    setCommentLoc(loc);
    // Frozen quote: set once on open, never rewritten while open (see guard).
    setCommentQuote(text);
    // Arm the Copy/Reply toolbar at the highlight instead of opening the
    // editor: a textarea that grabs focus mid-drag interrupts the selection.
    try {
      const rect = savedRect;
      if (rect && (rect.width > 0 || rect.height > 0) && typeof window !== "undefined") {
        setSelBar(
          selectionBarPos(rect, window.innerWidth, window.innerHeight),
        );
      } else {
        setSelBar((prev) => prev ?? { x: 16, y: 96 });
      }
    } catch {
      setSelBar((prev) => prev ?? { x: 16, y: 96 });
    }
  };
  /** Reply: open the comment editor at the armed toolbar position. */
  const openCommentBox = () => {
    setAnchorPos(selBar ?? { x: 16, y: 96 });
    setSelBar(null);
    setCommentOpen(true);
    // Keep the document scroll stable: focusing without preventScroll yanks
    // the viewer and makes the highlight look like it jumps. Focus never
    // clears the frozen quote; the native Range stays alive (code rows are
    // memoized, so their DOM nodes survive this state change).
    requestAnimationFrame(() => {
      try {
        commentInputRef.current?.focus?.({ preventScroll: true } as FocusOptions);
      } catch {
        commentInputRef.current?.focus?.();
      }
    });
  };
  /** Copy: put the highlighted text on the clipboard and dismiss the toolbar.
   *  The LIVE selection wins over the frozen quote — the user may have
   *  re-selected since the toolbar appeared, and only what is selected now
   *  must land on the clipboard. */
  const copySelection = () => {
    let live = "";
    try {
      live = window.getSelection()?.toString().trim() ?? "";
    } catch {
      live = "";
    }
    void copyToClipboard(live || commentQuote || selection);
    cancelComment();
  };
  // A highlight may end outside the panel, so listen on document. Reads are
  // deferred two frames so single-word/double-click selections commit first.
  // No selectionchange listener: it fires during drags and causes jank.
  useEffect(() => {
    const defer = (t: EventTarget | null) => {
      requestAnimationFrame(() => requestAnimationFrame(() => refreshSelection(t)));
    };
    const onUp = (e: MouseEvent) => defer(e.target);
    const onDbl = (e: MouseEvent) => defer(e.target);
    const onKey = (e: KeyboardEvent) => refreshSelection(e.target);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("dblclick", onDbl);
    document.addEventListener("keyup", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("dblclick", onDbl);
      document.removeEventListener("keyup", onKey);
    };
  }, [commentOpen, selection, commentText]);
  const sendComment = (queued?: boolean) => {
    const base = commentQuote || selection;
    if (!base || !ownerChatId) return;
    const note = commentText.trim();
    // Path with locator (path:42 / path:42-45 for code, path:Sheet1!B3:D5
    // for Excel grids): formatFileComment builds the header and the
    // direct-edit directive, so the agent opens this exact spot without a
    // workspace search. The locator kind matches the file nature — lines
    // for code/text, sheet + cell range for spreadsheets.
    let locSuffix = "";
    const rowsMatch = commentLoc.match(/rows?\s+(\d+)(?:\s*-\s*(\d+))?/i);
    const colsMatch = commentLoc.match(/cols?\s+([A-Z]+)(?:\s*-\s*([A-Z]+))?/i);
    if (rowsMatch) {
      const r1 = parseInt(rowsMatch[1], 10);
      const r2 = rowsMatch[2] ? parseInt(rowsMatch[2], 10) : r1;
      const loR = Math.min(r1, r2);
      const hiR = Math.max(r1, r2);
      const c1 = colsMatch?.[1]?.toUpperCase();
      const c2 = (colsMatch?.[2] ?? c1)?.toUpperCase();
      if (c1) {
        // Sheet name from the frozen range's table (falls back to the sheet
        // filter input): the agent needs it to pick the right worksheet.
        let sheetName = "";
        try {
          const sc = savedRangeRef.current?.startContainer ?? null;
          const scEl = sc instanceof Element ? sc : (sc as Node | null)?.parentElement ?? null;
          sheetName = scEl?.closest?.("[data-sheet]")?.getAttribute("data-sheet") ?? "";
        } catch {
          sheetName = "";
        }
        if (!sheetName) sheetName = sheet.trim();
        const a1 = hiR !== loR || c2 !== c1 ? `${c1}${loR}:${c2}${hiR}` : `${c1}${loR}`;
        const safeSheet = sheetName.includes(" ") || sheetName.includes("'") ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
        locSuffix = sheetName ? `:${safeSheet}!${a1}` : `:${a1}`;
      } else {
        locSuffix = hiR !== loR ? `:rows ${loR}-${hiR}` : `:row ${loR}`;
      }
    } else {
      const locMatch = commentLoc.match(/(\d+)(?:\s*-\s*(\d+))?/);
      locSuffix = locMatch ? (locMatch[2] ? `:${locMatch[1]}-${locMatch[2]}` : `:${locMatch[1]}`) : "";
    }
    const body = note ? `${base}\n\nNote: ${note}` : base;
    commentFileSelection(ownerChatId, `${filePath}${locSuffix}`, body, { queue: queued });
    // sent (no confirmation chrome: the box simply closes)
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
    savedRangeRef.current = null;
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
  };
  const cancelComment = () => {
    savedRangeRef.current = null;
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
    setSelBar(null);
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
  };
  // Clicking anywhere outside the comment box dismisses it like Esc (no send).
  // No in-panel exemption: a click on code/gutter/head while the box is open
  // closes it (refreshSelection is frozen while open, so it never reopens).
  useEffect(() => {
    if (!commentOpen && !selBar) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(".fv-comment-float, .fv-sel-bar")) return;
      cancelComment();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentOpen, selBar]);
  // Ctrl+F opens the in-viewer search; Escape closes it.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const key = ev.key.toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && key === "f") {
        ev.preventDefault();
        ev.stopPropagation();
        setSearchOpen(true);
      } else if (ev.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [searchOpen]);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus?.();
  }, [searchOpen]);
  useEffect(() => {
    setMatchIdx(0);
    setGridActiveRow(undefined);
  }, [query, absPath, state.content, state.html]);

  // Stale-while-revalidate: docRev bumps (live agent edits) must not blank
  // the viewer with a Loading flash — keep showing the previous content
  // while the fresh bytes load in the background.
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    (async () => {
      try {
        if (isImage) {
          const dataUrl = await api.readImage(absPath);
          if (!alive) return;
          setState(
            dataUrl
              ? { loading: false, imageData: dataUrl }
              : { loading: false, error: "Image could not be loaded." },
          );
          return;
        }
        // PDF / Word / Excel: the renderer cannot parse those formats — the
        // backend renders them for the viewer: PDF pages as images, Word and
        // Excel as styled HTML (headings, tables, fonts — uploads under the
        // data root included).
        if (DOC_EXTS.has(ext)) {
          // PDF: the webview renders PDFs natively, so hand it the bytes
          // instead of asking the backend to rasterize pages — no PDF engine
          // is bundled, and the native pane has selection/zoom for free.
          if (ext === "pdf") {
            const b64 = await api.readPdfBase64(absPath);
            if (!alive) return;
            setState(
              b64
                ? { loading: false, pdfBase64: b64 }
                : {
                    loading: false,
                    error: `Could not load this PDF (missing, or larger than 64 MB): ${absPath}`,
                  },
            );
            return;
          }
          const doc = await readDocumentText(root || "", absPath, DOC_TEXT_EXTS.has(ext) ? "text" : "html", SHEET_EXTS.has(ext) && sheet.trim() ? { sheet: sheet.trim() } : undefined);
          if (!alive) return;
          if (doc.error && ext === "csv") {
            const fallback = await readDocumentText(root || "", absPath, "text");
            if (!alive) return;
            if (fallback.content != null) {
              setState({ loading: false, content: fallback.content });
            } else {
              setState({ loading: false, error: doc.error });
            }
          } else if (doc.error) {
            setState({ loading: false, error: doc.error });
          } else if (doc.pages) {
            setState({ loading: false, pages: doc.pages });
          } else if (doc.html != null) {
            setState({ loading: false, html: doc.html });
          } else if (doc.content != null) {
            setState({ loading: false, content: doc.content });
          } else {
            setState({ loading: false, error: "Empty document." });
          }
          return;
        }
        // fs:read resolves (root, rel) and refuses to escape the root, so an
        // absolute path is read as (dir, basename) — its own containment.
        // A trailing ":42" / ":42-45" line suffix inside the path would miss
        // the file — strip it (the line reaches the viewer via its own prop).
        const cleanPath = normPath(filePath.replace(/:\d+(?:-\d+)?$/, ""));
        const readPath = (rel: string) =>
          cleanPath.startsWith("/")
            ? api.fsRead(
                cleanPath.slice(0, cleanPath.lastIndexOf("/")) || "/",
                cleanPath.slice(cleanPath.lastIndexOf("/") + 1),
              )
            : api.fsRead(root, rel);
        let res = await readPath(cleanPath);
        if (res?.content == null) {
          // The chip may carry a bare or stale path (a scoped grep returns
          // "toolNesting.test.ts", a moved file keeps its name). Resolve it
          // against the workspace index before declaring it missing.
          const hit = resolveWorkspacePath(cleanPath, await workspaceFiles(root));
          if (hit) res = await api.fsRead(root, hit.rel);
        }
        if (!alive) return;
        setState(
          res?.content != null
            ? { loading: false, content: res.content }
            : {
                loading: false,
                // Name the attempted path and root: a bare "not found" made
                // this undebuggable when the chip carried a stale path.
                error: `No file exists at this path: ${cleanPath}${root ? ` (workspace: ${root})` : ""} — it may be planned but never created, or it has moved.`,
              },
        );
      } catch (err) {
        if (!alive) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [filePath, root, isImage, ext, absPath, docRev, sheet]);

  // On a failed read, offer the closest workspace files instead of a dead
  // end: same name elsewhere, then same directory, then similar stems.
  useEffect(() => {
    setSimilar([]);
    if (!state.error || !root) return;
    let alive = true;
    (async () => {
      const files = await api.fsWalk(root).catch(() => []);
      if (!alive) return;
      setSimilar(suggestSimilarFiles(filePath, files));
    })();
    return () => {
      alive = false;
    };
  }, [state.error, filePath, root]);

  const content = state.content ?? "";
  const binary = content.includes("\u0000");
  const capped = content.length > FILE_RENDER_CAP;
  const shown = capped ? content.slice(0, FILE_RENDER_CAP) : content;
  const lines = useMemo(() => (binary ? [] : shown.split("\n")), [shown, binary]);
  const highlighted = useMemo(
    () => (binary ? [] : getHighlightedLines(shown, ext)),
    [shown, ext, binary],
  );
  // Virtualized text grid: only a window around the scroll position paints,
  // so a 400k-char log never mounts thousands of rows. No timers — the
  // window follows the body's own scroll event, and docRev drives refetch.
  const ROW_H = 20;
  const WINDOW_ROWS = 250;
  const [viewTop, setViewTop] = useState(0);
  // Reset scroll only when switching files — live content refreshes must
  // preserve the user's scroll position instead of jumping back to the top.
  useEffect(() => {
    setViewTop(0);
    bodyRef.current?.scrollTo?.(0, 0);
  }, [absPath]);
  const totalRows = lines.length;
  // Small/medium files render fully so text selection never loses its
  // anchor nodes to virtualization (unmounting collapses the selection
  // and makes the highlight look like it jumps to the whole line).
  const useVirtual = totalRows > 1000;
  const startRow = useVirtual ? Math.max(0, Math.floor(viewTop / ROW_H) - 20) : 0;
  const endRow = useVirtual ? Math.min(totalRows, startRow + WINDOW_ROWS) : totalRows;
  const topPad = useVirtual ? startRow * ROW_H : 0;
  const bottomPad = useVirtual ? Math.max(0, (totalRows - endRow) * ROW_H) : 0;
  // Deep-linked line must be inside the mounted window, otherwise the
  // scroll-to-line query below finds nothing (virtualized rows don't exist).
  useEffect(() => {
    if (fileLine && fileLine > 0 && totalRows > 0) {
      const targetTop = Math.max(0, (fileLine - 60) * ROW_H);
      setViewTop((prev) => (Math.abs(prev - targetTop) > ROW_H ? targetTop : prev));
    }
  }, [fileLine, totalRows]);

  // Scroll to (and flash) the requested line once the body has painted.
  useEffect(() => {
    if (!fileLine || state.loading || binary) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-line="${fileLine}"]`,
    );
    el?.scrollIntoView({ block: "center" });
  }, [fileLine, state.loading, state.content, binary]);

  const copy = async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // Excel/CSV grid source: server HTML tables parsed into per-sheet row HTML
  // (styles preserved). The backend <h3> sheet name is parsed for keys only
  // and never rendered as a visible title above the grid. Only the requested
  // sheet is fetched (low-memory on-demand read, refresh via docRev only).
  // CSV falls back to client-side parsing of the text content so the table
  // shows even when the backend HTML renderer is unavailable.
  const isGridDoc = GRID_EXTS.has(ext);
  const sheetTables = useMemo(() => {
    if (!isGridDoc) return [] as Array<{ name: string; rows: string[] }>;
    const tables: Array<{ name: string; rows: string[] }> = [];
    try {
      const html = state.html;
      if (html != null) {
        const re = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          const name = m[1].replace(/<[^>]+>/g, "").trim() || "Sheet";
          const body = m[2];
          const rows: string[] = [];
          const rre = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
          let rm: RegExpExecArray | null;
          while ((rm = rre.exec(body)) !== null) rows.push(rm[0]);
          if (rows.length > 0) tables.push({ name, rows });
        }
        if (tables.length === 0) {
          const rre = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
          const rows: string[] = [];
          let rm: RegExpExecArray | null;
          while ((rm = rre.exec(html)) !== null) rows.push(rm[0]);
          if (rows.length > 0) tables.push({ name: sheet.trim() || "Sheet", rows });
        }
      }
      if (tables.length === 0 && ext === "csv" && state.content != null) {
        const escapeCell = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const splitCsvLine = (line: string): string[] => {
          const out: string[] = [];
          let cur = "";
          let quoted = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else { quoted = !quoted; }
            } else if (ch === "," && !quoted) { out.push(cur); cur = ""; } else { cur += ch; }
          }
          out.push(cur);
          return out.map((c) => c.trim());
        };
        const rawLines = state.content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const rows: string[] = rawLines.map((line, idx) => {
          const cells = splitCsvLine(line);
          const tag = idx === 0 ? "th" : "td";
          const tds = cells.map((c) => `<${tag} dir="auto" style="border:1px solid #d0d0d0;padding:6px 10px;${idx === 0 ? "background:#f0f0f0;font-weight:600;" : "background:#ffffff;"}">${escapeCell(c)}</${tag}>`).join("");
          return `<tr>${tds}</tr>`;
        });
        if (rows.length > 0) tables.push({ name: fileBasename(filePath), rows });
      }
    } catch {
      return [];
    }
    return tables;
  }, [isGridDoc, state.html, state.content, sheet, ext, filePath]);

  // In-viewer search matches (cheap string scan, no extra fetch). Grid search
  // scans the first sheet rows; text search scans visible lines.
  const gridRows0 = sheetTables.length > 0 ? sheetTables[0].rows : ([] as string[]);
  const qlow = query.trim().toLowerCase();
  const gridMatches = useMemo(() => {
    if (!qlow || gridRows0.length === 0) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < gridRows0.length; i++) {
      if (stripSheetTags(gridRows0[i]).toLowerCase().includes(qlow)) out.push(i);
      if (out.length > 2000) break;
    }
    return out;
  }, [gridRows0, qlow]);
  const textMatches = useMemo(() => {
    if (!qlow || binary || lines.length === 0) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(qlow)) out.push(i + 1);
      if (out.length > 2000) break;
    }
    return out;
  }, [lines, qlow, binary]);
  const isGridSearch = isGridDoc && sheetTables.length > 0;
  const totalMatches = isGridSearch ? gridMatches.length : textMatches.length;
  const safeMatchIdx = totalMatches > 0 ? matchIdx % totalMatches : 0;
  const activeTextLine = !isGridSearch && totalMatches > 0 ? textMatches[safeMatchIdx] : undefined;
  useEffect(() => {
    if (isGridSearch) setGridActiveRow(totalMatches > 0 ? gridMatches[safeMatchIdx] : undefined);
  }, [isGridSearch, gridMatches, safeMatchIdx, totalMatches]);
  useEffect(() => {
    if (!isGridSearch && activeTextLine != null) {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-line="${activeTextLine}"]`);
      if (!el) setViewTop(Math.max(0, (activeTextLine - 60) * ROW_H));
      else el.scrollIntoView({ block: "center" });
    }
  }, [activeTextLine, isGridSearch]);
  const stepMatch = (dir: 1 | -1) => {
    if (totalMatches === 0) return;
    setMatchIdx((i) => (i + dir + totalMatches) % totalMatches);
  };

  const openExternalFile = async (editor: OpenTargetId) => {
    setExtNote(null);
    setOpening(editor);
    try {
      const res = await api.openFileExternal(absPath, editor);
      if (res.ok) {
        setOpenMenu(false);
      } else {
        setExtNote(res.error || `Could not open in ${editor}.`);
      }
    } catch (err) {
      setExtNote(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  };

  // Close the "Open in" menu on outside pointer-down or Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && openMenuRef.current?.contains(ev.target)) return;
      setOpenMenu(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpenMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  return (
    <div ref={rootRef} className={`file-viewer${commentOpen ? " has-comment-open" : ""}`} dir={appDir} onMouseUp={(e) => { const t = e.target; requestAnimationFrame(() => requestAnimationFrame(() => refreshSelection(t))); }} onKeyUp={(e) => refreshSelection(e.target)}>
      <div className="file-viewer-head" dir="ltr" style={{ direction: "ltr" }}>
        <FileIcon path={filePath} size={20} />
        <span className="file-viewer-name" title={filePath}>
          {fileBasename(filePath)}
        </span>
        {fileLine ? <span className="file-viewer-line">:{fileLine}</span> : null}
        <span className="file-viewer-spacer" />
        <div className="fv-icon-actions" style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <div className="fv-open-wrap" ref={openMenuRef}>
          <button
            type="button"
            className="fv-icon-btn"
            title="Open this file in an external editor"
            aria-haspopup="menu"
            aria-expanded={openMenu}
            aria-label="Open in external editor"
            onClick={() => setOpenMenu((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
            </svg>
          </button>
          {openMenu && (
            <div className="fv-open-menu" role="menu" dir="ltr" style={{ direction: "ltr" }}>
              {visibleTargets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="fv-open-item"
                  role="menuitem"
                  disabled={opening !== null}
                  title={t.title}
                  onClick={() => void openExternalFile(t.id)}
                >
                  <span className={`fv-open-icon ${t.iconClass}`} aria-hidden="true">
                    {t.icon}
                  </span>
                  <span className="fv-open-text">
                    <span className="fv-open-label">
                      {t.label}
                      {opening === t.id ? " — opening…" : ""}
                    </span>
                    <span className="fv-open-hint">{t.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {state.content != null && !binary && (
          <button
            type="button"
            className={`fv-icon-btn${copied ? " copied" : ""}`}
            title={copied ? "Copied" : "Copy file text"}
            aria-label="Copy file text"
            onClick={copy}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            )}
          </button>
        )}
        {SHEET_EXTS.has(ext) && (
          <form
            className="fv-sheet-form"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "nowrap", whiteSpace: "nowrap", flex: "0 0 auto", minWidth: 0 }}
            onSubmit={(e) => {
              e.preventDefault();
              setSheet(sheetInput.trim());
            }}
          >
            <input
              className="fv-sheet-input"
              style={{ width: 92, flex: "0 0 auto" }}
              value={sheetInput}
              onChange={(e) => setSheetInput(e.target.value)}
              placeholder="Sheet name"
              title="Excel sheet name — only this sheet is parsed (cheap for large workbooks)"
              aria-label="Excel sheet name"
            />
            <button
              type="submit"
              className="fv-sheet-btn"
              style={{ flex: "0 0 auto" }}
              title="Load this sheet only"
              aria-label="Load sheet"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
            </button>
            {sheet && (
              <button
                type="button"
                className="fv-sheet-btn"
                style={{ flex: "0 0 auto" }}
                title="Back to all sheets"
                aria-label="Clear sheet filter"
                onClick={() => {
                  setSheet("");
                  setSheetInput("");
                }}
              >
                ✕
              </button>
            )}
          </form>
        )}
        <button
          type="button"
          className="fv-icon-btn"
          title="Search in this file (Ctrl+F)"
          aria-label="Search in this file"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((o) => !o)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        </button>
        {/* highlight opens the simple comment box directly; no header trigger */}
        </div>
      </div>
      {searchOpen && (
        <form
          className="fv-search-bar"
          dir="ltr"
          onSubmit={(e) => { e.preventDefault(); stepMatch(1); }}
        >
          <input
            ref={searchInputRef}
            className="fv-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in file… (Ctrl+F)"
            aria-label="Search in file"
          />
          <span className="fv-search-count">
            {query.trim() ? `${totalMatches} match${totalMatches === 1 ? "" : "es"}${totalMatches > 0 ? ` · ${safeMatchIdx + 1}/${totalMatches}` : ""}` : "Type to search"}
          </span>
          <span className="fv-search-nav">
            <button type="button" className="fv-sheet-btn" title="Previous match (Shift+Enter)" onClick={() => stepMatch(-1)}>↑</button>
            <button type="submit" className="fv-sheet-btn" title="Next match (Enter)">↓</button>
            <button type="button" className="fv-sheet-btn" title="Close search (Esc)" onClick={() => { setSearchOpen(false); setQuery(""); }}>✕</button>
          </span>
        </form>
      )}
      {/* no trigger button: a finished highlight arms the Copy/Reply toolbar */}
      {selBar && !commentOpen && (commentQuote || selection) && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-sel-bar"
              style={{ position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="fv-sel-btn"
                title="Copy"
                aria-label="Copy selection"
                onClick={copySelection}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>
              <button
                type="button"
                className="fv-sel-btn"
                title="Reply"
                aria-label="Reply to selection"
                onClick={openCommentBox}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
              </button>
            </div>,
            document.body,
          )
        : null}
      {commentOpen && (commentQuote || selection) && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-comment-float"
              style={anchorPos ? { position: "fixed", top: anchorPos.y, left: anchorPos.x, zIndex: 9999 } : { position: "fixed", top: 96, left: 16, zIndex: 9999 }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <textarea
                ref={commentInputRef}
                className="fv-comment-input"
                dir="auto"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelComment();
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendComment(true);
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendComment(false);
                  }
                }}
                placeholder="Write a comment… Enter to send, Esc to cancel"
                aria-label="Comment on highlight"
                rows={2}
              />
            </div>,
            document.body,
          )
        : null}
      {state.loading && state.content == null && state.html == null && state.pages == null && state.imageData == null && state.pdfBase64 == null && !state.error && <div className="file-viewer-note">Loading…</div>}
      {state.error && <div className="file-viewer-note">⚠ {state.error}</div>}
      {state.error && similar.length > 0 && (
        <div className="fv-suggest">
          <span className="fv-suggest-label">Closest files in this workspace:</span>
          <div className="fv-suggest-list">
            {similar.map((f) => (
              <FileChip key={f.rel} path={f.rel} display={f.rel} />
            ))}
          </div>
        </div>
      )}
      {extNote && <div className="file-viewer-note">⚠ {extNote}</div>}
      {binary && <div className="file-viewer-note">Binary file — no text preview.</div>}
      {capped && (
        <div className="file-viewer-note">
          Showing the first {FILE_RENDER_CAP.toLocaleString()} characters — the
          full file is {content.length.toLocaleString()} characters.
        </div>
      )}
      {state.imageData && (
        <div className="file-viewer-image">
          <img src={state.imageData} alt={fileBasename(filePath)} />
        </div>
      )}
      {state.pdfBase64 && (
        <PdfViewer base64={state.pdfBase64} title={fileBasename(filePath)} />
      )}
      {state.pages && (
        <div className="file-viewer-pages">
          {state.pages.map((src, i) => (
            <img key={i} src={src} alt={`Page ${i + 1}`} />
          ))}
        </div>
      )}
      {isGridDoc && sheetTables.length > 0 ? (
        <div className="file-viewer-doc fv-grid-doc" dir="ltr" style={{ direction: "ltr", width: "100%", flex: 1, minHeight: 0 }}>
          {sheetTables.map((t) => (
            <VirtualSheetTable key={t.name} name={t.name} rows={t.rows} query={query} activeRow={gridActiveRow} />
          ))}
        </div>
      ) : (
        state.html != null && (
          // Server-generated HTML: every text node is escaped backend-side and
          // the style attributes are strictly constructed (no user HTML passes
          // through), so this is trusted at the same level as any other
          // sidecar response. sanitizeHtml would strip the font styles that
          // make the preview look like the real document.
          <div
            className="file-viewer-doc"
            dir="auto"
            dangerouslySetInnerHTML={{ __html: state.html }}
          />
        )
      )}
      {/* Grid docs render ONLY the table: the CSV client fallback builds the
      // grid from the same text content, so the raw text body must stay hidden
      // or every CSV shows twice (table on top, raw lines below). */}
      {state.content != null && !binary && !isImage && !(isGridDoc && sheetTables.length > 0) && (
        <div className="file-viewer-body" ref={bodyRef} dir="ltr" style={{ direction: "ltr" }} onScroll={(e) => setViewTop(e.currentTarget.scrollTop)}>
          <pre className="file-viewer-pre hljs">
            {topPad > 0 && <span className="fv-pad" aria-hidden="true" style={{ height: topPad }} />}
            {lines.slice(startRow, endRow).map((_, k) => {
              const i = startRow + k;
              const n = i + 1;
              const isSearchCurrent = activeTextLine === n;
              // Frozen-range tint: the native Selection moves into the popup
              // textarea on focus, so paint the quoted line range with a class
              // to keep the highlight visibly anchored while the box is open.
              const cmRange = commentOpen ? parseCommentRange(commentLoc) : null;
              const isCommentTarget = !!cmRange && n >= cmRange[0] && n <= cmRange[1];
              const html = (() => {
                const base = highlighted[i] === "" ? "\n" : highlighted[i];
                if (!qlow || !isSearchCurrent) return base;
                return markQueryHtml(base, query);
              })();
              return (
                <span
                  key={i}
                  data-line={n}
                  className={`fv-line${n === fileLine ? " target" : ""}${isSearchCurrent ? " search-current" : ""}${isCommentTarget ? " comment-target" : ""}`}
                  style={isSearchCurrent ? { background: "#fff3b0" } : undefined}
                >
                  <span className="fv-gutter" aria-hidden="true">
                    {n}
                  </span>
                  <CodeText html={html} />
                </span>
              );
            })}
            {bottomPad > 0 && <span className="fv-pad" aria-hidden="true" style={{ height: bottomPad }} />}
          </pre>
          {totalRows > WINDOW_ROWS && (
            <div className="file-viewer-note">
              Virtualized: showing rows {startRow + 1}–{endRow} of {totalRows} — scroll to load more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
