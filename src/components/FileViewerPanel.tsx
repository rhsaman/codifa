import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/fs";
import { useStore } from "../lib/store";
import { copyToClipboard } from "../lib/clipboard";
import { IMAGE_EXTS, extOf, fileBasename } from "../lib/fileTypes";
import { FileIcon } from "./FileIcon";
import { getHighlightedLines } from "./ChatMessage";

/** Never paint more than this many characters of ONE file: a multi-megabyte
 *  log would freeze the tab. Copy keeps the FULL text. */
const FILE_RENDER_CAP = 400_000;

/** Docked viewer tab for one workspace file: line-numbered, syntax
 *  highlighted, with an optional target line highlighted and scrolled into
 *  view (opened via file chips / code-map jumps). Images render inline,
 *  binary files show a notice. Relative paths are read against the
 *  workspace root captured at open time (survives chat switches). */
export function FileViewerPanel({
  filePath,
  fileLine,
  fileRoot,
}: {
  filePath: string;
  fileLine?: number;
  fileRoot?: string;
}) {
  const storeRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const root = fileRoot || storeRoot;
  // Absolute path for external editors / image reads (plain string join — the
  // renderer has no node:path).
  const absPath = filePath.startsWith("/")
    ? filePath
    : `${(root || "").replace(/\/+$/, "")}/${filePath}`;
  const ext = extOf(filePath);
  const isImage = IMAGE_EXTS.has(ext);

  const [state, setState] = useState<{
    loading: boolean;
    content?: string;
    imageData?: string;
    error?: string;
  }>({ loading: true });
  const [copied, setCopied] = useState(false);
  const [extNote, setExtNote] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const [opening, setOpening] = useState<null | "nvim" | "vscode">(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
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
        // fs:read resolves (root, rel) and refuses to escape the root, so an
        // absolute path is read as (dir, basename) — its own containment.
        const res = filePath.startsWith("/")
          ? await api.fsRead(
              filePath.slice(0, filePath.lastIndexOf("/")) || "/",
              filePath.slice(filePath.lastIndexOf("/") + 1),
            )
          : await api.fsRead(root, filePath);
        if (!alive) return;
        setState(
          res?.content != null
            ? { loading: false, content: res.content }
            : { loading: false, error: "File not found (or unreadable) at this path." },
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
  }, [filePath, root, isImage]);

  const content = state.content ?? "";
  const binary = !state.loading && content.includes("\u0000");
  const capped = !state.loading && content.length > FILE_RENDER_CAP;
  const shown = capped ? content.slice(0, FILE_RENDER_CAP) : content;
  const lines = useMemo(() => (binary ? [] : shown.split("\n")), [shown, binary]);
  const highlighted = useMemo(
    () => (binary ? [] : getHighlightedLines(shown, ext)),
    [shown, ext, binary],
  );

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

  const dirPart = filePath.includes("/")
    ? `${filePath.slice(0, filePath.lastIndexOf("/"))}/`
    : "";

  const openExternalFile = async (editor: "nvim" | "vscode") => {
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
    <div className="file-viewer" dir="ltr">
      <div className="file-viewer-head">
        <FileIcon path={filePath} size={18} />
        {dirPart && <span className="file-viewer-dir">{dirPart}</span>}
        <span className="file-viewer-name" title={filePath}>
          {fileBasename(filePath)}
        </span>
        {fileLine ? <span className="file-viewer-line">:{fileLine}</span> : null}
        <span className="file-viewer-spacer" />
        <div className="fv-open-wrap" ref={openMenuRef}>
          <button
            type="button"
            className="fv-open-btn"
            title="Open this file in an external editor"
            aria-haspopup="menu"
            aria-expanded={openMenu}
            onClick={() => setOpenMenu((o) => !o)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
            </svg>
            <span>Open in</span>
            <span className={`fv-open-chev${openMenu ? " open" : ""}`} aria-hidden="true">▾</span>
          </button>
          {openMenu && (
            <div className="fv-open-menu" role="menu" dir="ltr">
              <button
                type="button"
                className="fv-open-item"
                role="menuitem"
                disabled={opening !== null}
                title="Open in the running Neovim instance (or a new terminal)"
                onClick={() => void openExternalFile("nvim")}
              >
                <span className="fv-open-icon fv-open-icon-nvim" aria-hidden="true">NV</span>
                <span className="fv-open-text">
                  <span className="fv-open-label">Neovim{opening === "nvim" ? " — opening…" : ""}</span>
                  <span className="fv-open-hint">Running instance, else new terminal</span>
                </span>
              </button>
              <button
                type="button"
                className="fv-open-item"
                role="menuitem"
                disabled={opening !== null}
                title="Open in VS Code"
                onClick={() => void openExternalFile("vscode")}
              >
                <span className="fv-open-icon fv-open-icon-vscode" aria-hidden="true">VS</span>
                <span className="fv-open-text">
                  <span className="fv-open-label">VS Code{opening === "vscode" ? " — opening…" : ""}</span>
                  <span className="fv-open-hint">code CLI, else vscode:// handler</span>
                </span>
              </button>
            </div>
          )}
        </div>
        {state.content != null && !binary && (
          <button
            type="button"
            className={`fv-copy${copied ? " copied" : ""}`}
            onClick={copy}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        )}
      </div>
      {state.loading && <div className="file-viewer-note">Loading…</div>}
      {state.error && <div className="file-viewer-note">⚠ {state.error}</div>}
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
      {state.content != null && !binary && !isImage && (
        <div className="file-viewer-body" ref={bodyRef}>
          <pre className="file-viewer-pre hljs">
            {lines.map((_, i) => {
              const n = i + 1;
              return (
                <span
                  key={i}
                  data-line={n}
                  className={`fv-line${n === fileLine ? " target" : ""}`}
                >
                  <span className="fv-gutter" aria-hidden="true">
                    {n}
                  </span>
                  <span
                    className="fv-text"
                    dangerouslySetInnerHTML={{
                      __html: highlighted[i] === "" ? "\n" : highlighted[i],
                    }}
                  />
                </span>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
