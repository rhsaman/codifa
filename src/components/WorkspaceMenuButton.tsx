import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/fs";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import { workspaceDisplayFor } from "../lib/chatWindowMeta";
import { FinderIcon, FolderIcon, TerminalIcon, isMacOS } from "./MacAppIcons";

/** The workspace pill in the app bar: folder icon + the CURRENT PROJECT NAME
 *  + chevron, opening a small menu (change folder / reveal in file manager /
 *  open terminal). Lives in the chat-column titlebar — never in the sidebar's
 *  strip, whose fixed width used to squeeze the name away. The label lays out
 *  at its own content width (capped, ellipsized) so the project name is always
 *  readable, in both RTL and LTR. */
export function WorkspaceMenuButton({ root }: { root?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mac = isMacOS();
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const workspaces = useStore((s) => s.workspaces);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const ws = workspaceDisplayFor(activeChatRoot ?? root, workspaces, workspaceColors);

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
    if (r) setPos({ top: r.bottom + 6, left: r.right - 190 });
    setOpen(true);
  };

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const reveal = () =>
    ws.root &&
    void api.openWorkspaceFolder(ws.root).then((res) => {
      if (!res.ok) console.warn("[workspace] reveal failed:", res.error);
    });
  // In-app only: the terminal never leaves the app, so this opens a fresh
  // terminal tab in the right pane sitting at the workspace root.
  const terminal = () => {
    if (!ws.root) return;
    const v = useViewerTabs.getState();
    v.setPaneOpen(true);
    v.openTerminal({ cwd: ws.root, fresh: true });
  };

  return (
    <div className="ws-menu-wrap titlebar-ws-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="titlebar-icon-btn workspace-menu-btn"
        style={{ "--ws": ws.color } as CSSProperties}
        aria-label="Workspace — change folder, reveal in file manager or open terminal"
        title={ws.root ? `${ws.label} — ${ws.root}` : "No workspace open — pick a folder for this chat"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {mac ? <FinderIcon /> : <FolderIcon />}
        <span className="workspace-btn-label">{ws.root ? ws.label : "Open workspace"}</span>
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
          <button
            type="button"
            className="ws-menu-btn"
            role="menuitem"
            disabled={!ws.root}
            onClick={() => run(reveal)}
          >
            {mac ? <FinderIcon /> : <FolderIcon />}
            {mac ? "Finder" : "File manager"}
          </button>
          <button
            type="button"
            className="ws-menu-btn"
            role="menuitem"
            disabled={!ws.root}
            onClick={() => run(terminal)}
          >
            <TerminalIcon />
            Terminal
          </button>
        </div>
      )}
    </div>
  );
}
