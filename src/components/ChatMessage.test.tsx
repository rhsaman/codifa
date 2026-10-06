// Unit test for user-message edit + resubmit-from-same-point.
// Contract (shared with the ChatMessage onEdit chunk):
//   onEdit(messageId: string, newText: string) + `editingDisabled` prop.
//   Submit path = truncateTo(messageId) then re-add the user message with the
//   new text, so everything at/below the edited message is dropped and the
//   turn resubmits from that same point. Empty edits are rejected (no-op).
// Run: npx esbuild src/components/ChatMessage.test.tsx --bundle
//        --platform=node --format=esm --packages=external
//        --external:electron --outfile=tests/.tmp-chatmessage.mjs \
//        && node tests/.tmp-chatmessage.mjs
import fs from "node:fs";

export {};

// Mock the Electron bridge / storage before importing the store (same mock
// shape as tests/retryStore.test.ts).
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return async () => {};
      },
    },
  ),
};
;(globalThis as any).localStorage = (globalThis as any).window.localStorage;

const { useStore } = await import("../lib/store");

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

/** Mirror of the onEdit submit path: reject empty, else truncate + resubmit. */
function submitEdit(chatId: string, messageId: string, newText: string): boolean {
  if (!newText.trim()) return false;
  const st = useStore.getState();
  if (!st.truncateTo(messageId)) return false;
  st.addMessage(chatId, { role: "user", content: newText });
  return true;
}

const messagesOf = (chatId: string) =>
  useStore.getState().chats.find((c) => c.id === chatId)!.messages;

console.log("1) edit middle user message -> history truncated, new text resent:");
{
  const s = useStore.getState();
  const chatId = s.newChat("ask");
  s.addMessage(chatId, { role: "user", content: "first question" });
  s.addMessage(chatId, { role: "assistant", content: "first answer" });
  const u2 = s.addMessage(chatId, { role: "user", content: "second question" });
  const a2 = s.addMessage(chatId, { role: "assistant", content: "second answer" });

  check("submitEdit succeeds", submitEdit(chatId, u2.id, "second question (edited)") === true);
  const after = messagesOf(chatId);
  check(
    "everything at/below the edited message was dropped",
    after.length === 3 &&
      after[0]!.role === "user" &&
      after[0]!.content === "first question" &&
      after[1]!.role === "assistant" &&
      after[1]!.content === "first answer",
    after.map((m) => m.content),
  );
  check(
    "new text resent as a fresh user message from the same point",
    after[2]!.role === "user" &&
      after[2]!.content === "second question (edited)" &&
      after[2]!.id !== u2.id,
    after[2],
  );
  check(
    "stale reply is gone from history",
    !after.some((m) => m.id === a2.id || m.content === "second answer"),
    after.map((m) => m.id),
  );
}

console.log("2) edit first message -> all below removed, resubmit from start:");
{
  const s = useStore.getState();
  const chatId = s.newChat("ask");
  const u1 = s.addMessage(chatId, { role: "user", content: "hello" });
  s.addMessage(chatId, { role: "assistant", content: "hi there" });
  s.addMessage(chatId, { role: "user", content: "follow up" });

  check("submitEdit succeeds", submitEdit(chatId, u1.id, "hello (edited)") === true);
  const after = messagesOf(chatId);
  check(
    "only the edited message remains",
    after.length === 1 && after[0]!.role === "user" && after[0]!.content === "hello (edited)",
    after,
  );
}

console.log("3) empty edit -> rejected, history untouched:");
{
  const s = useStore.getState();
  const chatId = s.newChat("ask");
  const u1 = s.addMessage(chatId, { role: "user", content: "keep me" });
  s.addMessage(chatId, { role: "assistant", content: "reply" });
  const before = messagesOf(chatId).map((m) => m.id);

  check("whitespace edit rejected", submitEdit(chatId, u1.id, "   ") === false);
  check("empty-string edit rejected", submitEdit(chatId, u1.id, "") === false);
  const after = messagesOf(chatId);
  check(
    "history untouched after rejected edits",
    after.map((m) => m.id).join(",") === before.join(","),
    after.map((m) => m.id),
  );
}

console.log("4) unknown message id -> no-op, history untouched:");
{
  const s = useStore.getState();
  const chatId = s.newChat("ask");
  s.addMessage(chatId, { role: "user", content: "keep me" });
  const before = messagesOf(chatId).map((m) => m.id);

  check("unknown id rejected", submitEdit(chatId, "no-such-id", "new text") === false);
  check(
    "history untouched",
    messagesOf(chatId).map((m) => m.id).join(",") === before.join(","),
    before,
  );
}

console.log("5) edit styles present in global.css:");
{
  const css = fs.readFileSync("src/styles/global.css", "utf8");
  check("pencil button class (.msg-copy.msg-edit)", css.includes(".msg-copy.msg-edit"));
  check("disabled edit button style", css.includes(".msg-copy.msg-edit:disabled"));
  check("inline edit box (.msg-edit-wrap)", css.includes(".msg-edit-wrap"));
  check("edit textarea (.msg-edit-input)", css.includes(".msg-edit-input"));
  check("save/cancel buttons (.msg-edit-save/.msg-edit-cancel)", css.includes(".msg-edit-save") && css.includes(".msg-edit-cancel"));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll user-message edit checks passed");
// The store keeps timers alive (persistSoon etc.) — force-exit so the script
// terminates cleanly instead of hanging.
process.exit(0);
