import { useEffect, useRef, useState } from "react";
import { api } from "../lib/fs";
import { FinderIcon, FolderIcon, TerminalIcon, isMacOS } from "./MacAppIcons";

/** Single titlebar control for the two workspace shortcuts: the collapsed
 *  pill shows the Finder badge (folder glyph off macOS) plus a chevron and
 *  opens a small menu with "reveal in file manager" and "open terminal".
 *  Replaces the previous pair of separate icon buttons. */
export function WorkspaceMenuButton({ root }: { root?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mac = isMacOS();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element)) return;
      if (!t.closest(".ws-menu-wrap") && !t.closest(".ws-menu")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.right - 168 });
    setOpen(true);
  };

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const reveal = () =>
    root &&
    void api.openWorkspaceFolder(root).then((res) => {
      if (!res.ok) console.warn("[workspace] reveal failed:", res.error);
    });
  const terminal = () =>
    root &&
    void api.openWorkspaceTerminal(root).then((res) => {
      if (!res.ok) console.warn("[workspace] terminal failed:", res.error);
    });

  return (
    <div className="ws-menu-wrap titlebar-ws-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="titlebar-icon-btn workspace-menu-btn"
        aria-label="Workspace actions — reveal in file manager or open terminal"
        title={
          root
            ? `${root} — reveal in ${mac ? "Finder" : "file manager"} / open terminal`
            : "No workspace open — pick a folder first"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!root}
        onClick={toggle}
      >
        {mac ? <FinderIcon /> : <FolderIcon />}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9.5l6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div
          className="ws-menu"
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="ws-menu-btn" role="menuitem" onClick={() => run(reveal)}>
            {mac ? <FinderIcon /> : <FolderIcon />}
            {mac ? "Finder" : "File manager"}
          </button>
          <button type="button" className="ws-menu-btn" role="menuitem" onClick={() => run(terminal)}>
            <TerminalIcon />
            Terminal
          </button>
        </div>
      )}
    </div>
  );
}
