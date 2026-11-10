/** Unit: the two sidebar chords and their keyboard precedence.
 *
 *  Reported breakage:
 *    • Ctrl+X then W revealed nothing / focused the wrong place.
 *    • After that chord the sidebar had to be closed by hand: pressing the
 *      chord again while the caret sat on the active workspace HEADER did
 *      nothing, because the caret was "inside the sidebar but not inside the
 *      workspace LIST" and the toggle guard refused to close.
 *    • On a Persian layout the prefix chord (Ctrl+X, physical KeyX) matched
 *      but the second key arrived as "و" from e.key when `code` was absent
 *      (synthetic events, some IME paths) — the shortcut table lost it.
 *
 *  This pins the pure rules: layout independence, prefix arming, and the
 *  "one chord toggles" decision as a function of sidebar state + caret. */
import assert from "node:assert/strict";
import {
  physicalKey,
  panelToggleTarget,
  PREFIX_KEY,
  PREFIX_SHORTCUTS,
} from "../src/lib/shortcuts.ts";

const checks: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => checks.push([name, fn]);

/** Persian (standard) layout, physical key -> the character e.key reports. */
const PERSIAN: Record<string, string> = {
  KeyX: "خ",
  KeyW: "ص",
  KeyB: "ذ",
  KeyE: "ث",
  KeyJ: "ت",
};

function keyEvent(code: string, key?: string, mods: Partial<{
  ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
}> = {}) {
  return {
    code,
    key: key ?? PERSIAN[code] ?? code.slice(3).toLowerCase(),
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

// --- prefix chord ------------------------------------------------------------
test("Ctrl+X arms the prefix on a Latin layout", () => {
  const e = keyEvent("KeyX", "x", { ctrlKey: true });
  assert.equal(physicalKey(e), PREFIX_KEY);
});

test("Ctrl+X arms the prefix on a PERSIAN layout (e.key is خ)", () => {
  const e = keyEvent("KeyX", "خ", { ctrlKey: true });
  assert.equal(physicalKey(e), PREFIX_KEY, "physical key must win over e.key");
});

test("the second key is resolved physically too (ص -> w)", () => {
  const e = keyEvent("KeyW", "ص");
  assert.equal(physicalKey(e), "w");
  assert.ok(PREFIX_SHORTCUTS[physicalKey(e)], "w must exist in the shortcut table");
});

test("an event WITHOUT code falls back to the lowercased e.key", () => {
  assert.equal(physicalKey({ code: "", key: "W" }), "w");
  assert.equal(physicalKey({ code: "", key: "ص" }), "ص");
});

// --- sidebar toggle chord ----------------------------------------------------
test("Ctrl+B toggles the sidebar, Ctrl+Shift+B the right pane", () => {
  assert.equal(panelToggleTarget(keyEvent("KeyB", "b", { ctrlKey: true })), "sidebar");
  assert.equal(
    panelToggleTarget(keyEvent("KeyB", "ذ", { ctrlKey: true, shiftKey: true })),
    "right",
  );
});

test("Ctrl+B on a Persian layout still hits the sidebar", () => {
  assert.equal(panelToggleTarget(keyEvent("KeyB", "ذ", { ctrlKey: true })), "sidebar");
});

test("Cmd+H / a non-B key is not a panel toggle", () => {
  assert.equal(panelToggleTarget(keyEvent("KeyH", "h", { metaKey: true })), null);
});

// --- the W action is registered ---------------------------------------------
test("Ctrl+X W maps to the workspaces action, never to a slash command", () => {
  const sc = PREFIX_SHORTCUTS.w;
  assert.ok(sc, "w must be bound");
  assert.equal(sc.action, "workspaces");
  assert.equal(sc.cmd, "");
});

/**
 * The decision Ctrl+X W makes, mirrored from App.tsx. Kept here as the
 * REGRESSION PIN: the toggle must close from anywhere in the sidebar (the
 * workspace LIST, the opened folder's header, the back button, the search
 * box) as long as the Chats view is showing — not only from the list body.
 */
function workspacesAction(args: {
  sidebarOpen: boolean;
  view: "chats" | "files";
  focusInsideSidebar: boolean;
  listRendered: boolean;
}): "close" | "reveal-and-focus" {
  const atSidebar =
    args.sidebarOpen && args.view === "chats" && args.focusInsideSidebar;
  if (atSidebar) return "close";
  return "reveal-and-focus";
}

test("W closes the sidebar when the caret is in the workspace list", () => {
  assert.equal(
    workspacesAction({ sidebarOpen: true, view: "chats", focusInsideSidebar: true, listRendered: true }),
    "close",
  );
});

test("W closes the sidebar from the opened folder HEADER (the reported bug)", () => {
  // The header is NOT inside .sidebar-ws-list — the old guard demanded it and
  // therefore refused to close, forcing a manual toggle.
  assert.equal(
    workspacesAction({ sidebarOpen: true, view: "chats", focusInsideSidebar: true, listRendered: false }),
    "close",
  );
});

test("W reveals + focuses when the sidebar is closed", () => {
  assert.equal(
    workspacesAction({ sidebarOpen: false, view: "chats", focusInsideSidebar: false, listRendered: false }),
    "reveal-and-focus",
  );
});

test("W on the Files view reveals the workspace list", () => {
  assert.equal(
    workspacesAction({ sidebarOpen: true, view: "files", focusInsideSidebar: true, listRendered: true }),
    "reveal-and-focus",
  );
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`    ${(err as Error).message}`);
  }
}
console.log(failed === 0 ? `\n${checks.length} passed` : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
