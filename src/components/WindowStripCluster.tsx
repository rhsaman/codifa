import { useStore } from "../lib/store";

/** Window-level controls: sidebar toggle, workspace picker, direction
 *  switch. Rendered at the window's top-left in BOTH sidebar states —
 *  inside the sidebar's drag strip when the sidebar is open, inline at the
 *  app bar's solo corner when it is closed — so opening the sidebar never
 *  pushes them to the right. CSS decides which instance is visible
 *  (.mac + .solo rules); the same JSX renders in both hosts. */
export function WindowStripCluster() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const dir = useStore((s) => s.dir);
  return (
    <span className="window-strip-cluster">
      <button
        className="icon-btn titlebar-icon-btn"
        aria-label={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        aria-pressed={sidebarOpen}
        onClick={() => useStore.getState().toggleSidebar()}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      </button>
      <button
        className="workspace-btn"
        aria-label="Open workspace folder"
        title={activeChatRoot || "No workspace open — pick a folder for this chat"}
        onClick={() =>
          void window.coder.selectFolder().then((d) => {
            if (!d) return;
            const st = useStore.getState();
            st.setChatRoot(st.activeChatId, d);
          })
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        <span className="workspace-btn-label">{activeChatRoot ? activeChatRoot.split("/").filter(Boolean).pop() : "Open workspace"}</span>
      </button>
      <button
        className="titlebar-icon-btn dir-text-btn"
        onClick={() => useStore.getState().toggleDir()}
        title={dir === "rtl" ? "Right-to-left — click for LTR" : "Left-to-right — click for RTL"}
      >
        {dir === "rtl" ? "RTL" : "LTR"}
      </button>
    </span>
  );
}
