import { useStore } from "../lib/store";

/** Window-level controls: sidebar toggle, settings, direction switch. The
 *  workspace pill (folder + project name) does NOT live here — it renders in
 *  the chat titlebar (WorkspaceMenuButton), whose free width keeps the name
 *  fully visible; this cluster's home inside the sidebar strip is too narrow
 *  for it. Rendered at the window's top-left in BOTH sidebar states — inside
 *  the sidebar's drag strip when the sidebar is open, inline at the app bar's
 *  solo corner when it is closed — so opening the sidebar never pushes them
 *  to the right. CSS decides which instance is visible (.mac + .solo rules);
 *  the same JSX renders in both hosts. */
export function WindowStripCluster() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const dir = useStore((s) => s.dir);
  const iconProps = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  return (
    <span className="window-strip-cluster">
      <button
        className="icon-btn titlebar-icon-btn"
        aria-label={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        aria-pressed={sidebarOpen}
        onClick={() => useStore.getState().toggleSidebar()}
      >
        <svg {...iconProps}>
          <path d="M3 6h18M3 12h18M3 18h12" />
        </svg>
      </button>
      <button
        className="titlebar-icon-btn"
        aria-label="Open settings (⌘,)"
        title="Settings (⌘,)"
        onClick={() => useStore.getState().setSettingsOpen(true)}
      >
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
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
