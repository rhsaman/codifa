// Unit tests for the browser panel's per-tab sizing memory.
// Run: npx esbuild tests/browserPanelMemory.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/browserPanelMemory.test.mjs && node /tmp/browserPanelMemory.test.mjs
import {
  DEFAULT_FIT_TO_PANE,
  browserFitKey,
  clearBrowserFit,
  loadBrowserFit,
  saveBrowserFit,
} from "../src/lib/browserPanelMemory";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    failed++;
  }
}

console.log("browserPanelMemory:");

// A tab id is the memory key; a chat without a tab falls back to the chat id.
check("tab id wins over chat id", browserFitKey("tab-1", "chat-1") === "tab-1");
check("missing tab id falls back to chat", browserFitKey("", "chat-1") === "chat-1");
check("undefined tab id falls back to chat", browserFitKey(undefined, "chat-1") === "chat-1");
check("blank tab id falls back to chat", browserFitKey("   ", "chat-1") === "chat-1");

// First mount has nothing to restore — the panel must keep its own defaults.
check("unknown key has no memory", loadBrowserFit("tab-1") === null);
// Regression guard: the default is FOLLOW, so a splitter drag reflows the
// page. An OFF default froze the emulated viewport at one width.
check("first mount follows the pane", DEFAULT_FIT_TO_PANE === true);

// A remount (chat switch) restores exactly what the user left behind, so the
// follow toggle does not silently reset to the default on every return.
saveBrowserFit("tab-1", { fitToPane: false });
const restored = loadBrowserFit("tab-1");
check("restores the follow toggle", restored !== null && restored.fitToPane === false);

// Memory is per tab, never shared across chats.
check("a different tab stays unknown", loadBrowserFit("tab-2") === null);

// The later write wins (the panel re-saves on every change).
saveBrowserFit("tab-1", { fitToPane: true });
const updated = loadBrowserFit("tab-1");
check("later save overwrites", updated !== null && updated.fitToPane === true);

// A closed session forgets its intent, so a fresh launch starts at the default.
clearBrowserFit("tab-1");
check("cleared key is unknown again", loadBrowserFit("tab-1") === null);

process.exit(failed === 0 ? 0 : 1);
