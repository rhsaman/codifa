import io

CSS = "src/styles/global.css"
src = io.open(CSS, encoding="utf-8").read()

START = "/* --- vertical viewer tab rail"
END = "/* --- explore (sub-agent run)"

i = src.index(START)
j = src.index(END)

NEW = r'''/* --- viewer pane: tab strip above the page-icon rail ---------------------
   Tabs live in a horizontal strip ABOVE the content, each painting its own
   icon and name, so they can never read as one more page icon in the rail
   pinned to the pane's right edge. The rail keeps a FIXED width and holds
   page icons only. */
.viewer-pane-body {
  position: relative;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--viewer-rail-width);
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  min-width: 0;
  --viewer-rail-width: 42px;
}

/* The strip spans the pane's full width and scrolls on its own axis, so a long
   list of open files never squeezes the rail's icons or the content. */
.viewer-pane-body > .viewer-pane-tabs {
  grid-column: 1 / -1;
  grid-row: 1;
  min-width: 0;
  border-bottom: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--bg-panel) 55%, transparent);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  /* An in-body strip never drags the frameless window: dragging a tab must
     reorder it, not move the window. */
  -webkit-app-region: no-drag;
}

.viewer-pane-body > .viewer-pane-tabs .tab-bar.viewer-tabs {
  -webkit-app-region: no-drag;
}

.viewer-pane-body > .viewer-content {
  grid-column: 1;
  grid-row: 2;
  min-height: 0;
  min-width: 0;
}

/* Page icons only. The rail scrolls when the icons outgrow the pane height. */
.viewer-pane-body .viewer-pane-head {
  grid-column: 2;
  grid-row: 2;
  position: static;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 6px 4px;
  border: 0;
  border-left: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: none;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /* The rail must never act as the frameless window's drag region, or
     hovering/clicking its icons gets swallowed. */
  -webkit-app-region: no-drag;
}

/* Panel/collapse icons lead the rail: pinned to its top edge. */
.viewer-pane-body .viewer-pane-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  margin: 0;
  padding: 0;
}

/* A tab in the strip: icon + name, never dimmed. Translucent rows read as
   disabled, so the active tab is claimed by its own surface and accent and a
   hovered row gets a solid surface. */
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab {
  position: relative;
  opacity: 1;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--text) 4%, transparent);
  border-color: transparent;
}

.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:not(.active):hover,
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:focus-visible {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 12%, var(--bg-hover));
  border-color: color-mix(in srgb, currentColor 20%, transparent);
}

.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab.active {
  color: var(--text);
  background: color-mix(in srgb, var(--link) 14%, var(--bg-panel));
  border-color: color-mix(in srgb, var(--link) 26%, transparent);
}

/* The name is always painted inside the tab. */
.viewer-pane-body > .viewer-pane-tabs .editor-tab-label {
  display: inline-block;
}

/* Hovering swaps the tab's icon for a ✕ — one control per square, and the name
   neither moves nor disappears. The button covers exactly the icon's square
   (the tab's `padding-inline-start` plus the 20px icon). */
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab .editor-tab-close {
  position: absolute;
  top: 50%;
  left: 11px;
  z-index: 2;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  transform: translateY(-50%);
  border-radius: 6px;
  opacity: 0;
  pointer-events: none;
}

.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:hover .editor-tab-close,
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:focus-visible .editor-tab-close,
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:focus-within .editor-tab-close {
  opacity: 1;
  pointer-events: auto;
}

.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab .editor-tab-close:hover {
  transform: translateY(-50%) scale(1.1);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 18%, transparent);
}

/* …and the icon under the ✕ goes invisible instead of `display: none`, so the
   row keeps its metrics and the name never shifts. */
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:hover .viewer-tab-icon,
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:focus-visible .viewer-tab-icon,
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab:focus-within .viewer-tab-icon {
  opacity: 0;
  pointer-events: none;
}

/* The dragged tab is ghosted in its landing slot (inline CSS `order` moves it
   there), so the drop target is the row itself instead of an insertion line. */
.viewer-pane-body > .viewer-pane-tabs .editor-tab.viewer-tab.drop-preview {
  opacity: 0.6;
  border-color: color-mix(in srgb, var(--link) 55%, transparent);
  background: color-mix(in srgb, var(--link) 12%, transparent);
  outline: 1px dashed color-mix(in srgb, var(--link) 50%, transparent);
  outline-offset: -3.5px;
}

/* Rail buttons (tab list, fullscreen, page icons) are icon squares: one
   full-width row each, glyph centered on the rail's axis. Every page icon is a
   `.titlebar-icon-btn`, so a new page inherits the row geometry for free. */
.viewer-pane-body .viewer-pane-head .tab-list-btn,
.viewer-pane-body .viewer-pane-head .editor-tab-new,
.viewer-pane-body .viewer-pane-head .editor-tab-full,
.viewer-pane-body .viewer-pane-head .titlebar-icon-btn,
.viewer-pane-body .viewer-pane-head .viewer-schedule-btn,
.viewer-pane-body .viewer-pane-head .viewer-inbox-btn {
  width: 100%;
  height: 30px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
}

.viewer-pane-body .viewer-pane-head .viewer-pane-full {
  width: 100%;
}

/* The wraps keep their horizontal-bar paddings otherwise; in the rail every
   button must fill the row so its glyph lands on the shared center line. */
.viewer-pane-body .viewer-pane-head .tab-list-wrap {
  padding: 0;
}

'''

out = src[:i] + NEW + src[j:]
io.open(CSS, "w", encoding="utf-8").write(out)
print("css spliced:", len(src), "->", len(out))

# --- drop the now-dead spacer / head-tab-bar rules from the horizontal section
DEAD = [
    """
.viewer-pane-head .tab-bar.viewer-tabs {
  flex: 0 1 auto;
  min-width: 0;
  border-bottom: none;
}
""",
    """
.viewer-pane-spacer {
  flex: 1 1 auto;
  min-width: 8px;
}
""",
    """/* Keep the flexible spacer when tabs are empty so the icons above it do not
   migrate to the bottom edge. */
.viewer-pane-head:has(.tab-bar.viewer-tabs:empty) .viewer-pane-spacer {
  display: block;
  flex: 1 1 auto;
}
""",
]
s2 = io.open(CSS, encoding="utf-8").read()
for d in DEAD:
    if d in s2:
        s2 = s2.replace(d, "")
    else:
        print("WARN not found:", d.strip().splitlines()[0])
io.open(CSS, "w", encoding="utf-8").write(s2)
print("dead rules removed")
