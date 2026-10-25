// Unit tests for the browser panel's per-tab sizing memory.
// Run: npx esbuild src/lib/browserPanelMemory.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/browserPanelMemory.test.mjs && node /tmp/browserPanelMemory.test.mjs
import {
  browserFitKey,
  clearBrowserFit,
  loadBrowserFit,
  saveBrowserFit,
} from "./browserPanelMemory";

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

// A remount (chat switch) restores exactly what the user left behind: this is
// the regression — follow mode silently switched back ON and the cap fell to
// the default width, so the panel re-fitted a size the user had set.
saveBrowserFit("tab-1", { fitToPane: false, capW: 1440 });
const restored = loadBrowserFit("tab-1");
check("restores the follow toggle", restored !== null && restored.fitToPane === false);
check("restores the width cap", restored !== null && restored.capW === 1440);

// Memory is per tab, never shared across chats.
check("a different tab stays unknown", loadBrowserFit("tab-2") === null);

// The later write wins (the panel re-saves on every change).
saveBrowserFit("tab-1", { fitToPane: true, capW: 900 });
const updated = loadBrowserFit("tab-1");
check("later save overwrites", updated !== null && updated.fitToPane === true && updated.capW === 900);

// A closed session forgets its intent, so a fresh launch starts at the default.
clearBrowserFit("tab-1");
check("cleared key is unknown again", loadBrowserFit("tab-1") === null);

process.exit(failed === 0 ? 0 : 1);
