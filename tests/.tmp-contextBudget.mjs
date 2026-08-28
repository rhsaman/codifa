// test/_globals.ts
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
  localStorage: {
    _d: {},
    getItem(k) {
      return this._d[k] ?? null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    }
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => ({ ok: true, data: null });
      }
    }
  )
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.openExternal = async () => {
};

// src/lib/bidi.ts
var PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
var RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);

// src/lib/context.ts
var CHARS_PER_TOKEN = 4;
var PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
function budgetedSettledHistory(talk) {
  const live = talk.length > 0 && talk[talk.length - 1].streaming ? talk[talk.length - 1] : null;
  const rest = live ? talk.slice(0, -1) : talk;
  const settled = rest;
  return { settled, live };
}
function estimateContextChars(chat, systemPrompt, contextWindow) {
  const msgs = chat?.messages ?? [];
  let chars = 0;
  chars += systemPrompt.length;
  chars += 16e3;
  const active = msgs.filter((m) => !m.compacted);
  const talk = active.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "system"
  );
  const { settled, live } = budgetedSettledHistory(talk);
  for (const m of settled) {
    chars += m.content.length;
    if (m.thinking) chars += m.thinking.length;
  }
  if (live) {
    chars += live.content.length;
    if (live.thinking) chars += live.thinking.length;
    for (const act of live.toolActivity ?? []) {
      chars += act.tool.length;
      if (act.args) chars += JSON.stringify(act.args).length;
      if (act.summary) chars += act.summary.length;
      if (act.diff) chars += act.diff.length;
    }
  }
  return chars;
}
function estimateContextTokens(chat, systemPrompt, contextWindow) {
  return Math.round(estimateContextChars(chat, systemPrompt, contextWindow) / CHARS_PER_TOKEN);
}

// test/contextBudget.test.ts
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    console.log(`  \u2717 ${name}`);
    if (extra !== void 0) console.log("    got:", JSON.stringify(extra));
    globalThis.__FAILED = true;
  }
}
function mkChat(messages, mode = "ask") {
  return { id: "c1", mode, messages };
}
var SYSTEM = "system prompt base";
console.log("\u06F1) \u0633\u0648\u06CC\u06CC\u0686 mode \u0646\u0628\u0627\u06CC\u062F \u06A9\u0627\u0646\u062A\u06A9\u0633\u062A \u0631\u0627 \u06A9\u0645 \u06A9\u0646\u062F (\u0628\u062F\u0648\u0646 MODE_HISTORY_CAPS):");
{
  const msgs = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message number ${i} with some reasonable length text`
  }));
  const ask = estimateContextTokens(mkChat(msgs, "ask"), SYSTEM, 2e5);
  const coder = estimateContextTokens(mkChat(msgs, "coder"), SYSTEM, 2e5);
  check("ask \u0648 coder \u06CC\u06A9\u0633\u0627\u0646 \u0645\u062D\u0627\u0633\u0628\u0647 \u0645\u06CC\u200C\u06A9\u0646\u0646\u062F (\u0633\u0642\u0641 \u0628\u0647\u200C\u0627\u0632\u0627\u06CC mode \u0646\u062F\u0627\u0631\u06CC\u0645)", ask === coder, { ask, coder });
}
console.log("\u06F2) \u0647\u0631 turn \u067E\u06CC\u0627\u0645 \u06A9\u0645 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F (\u0628\u062F\u0648\u0646 \u067E\u0646\u062C\u0631\u0647\u0654 \u0644\u063A\u0632\u0627\u0646 maxHistory):");
{
  const msgs = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message number ${i} with some reasonable length text`
  }));
  const all = estimateContextTokens(mkChat(msgs, "ask"), SYSTEM, 2e5);
  const first10 = estimateContextTokens(mkChat(msgs.slice(0, 10), "ask"), SYSTEM, 2e5);
  check("\u06F3\u06F0 \u067E\u06CC\u0627\u0645 \u0628\u06CC\u0634\u062A\u0631 \u0627\u0632 \u06F1\u06F0 \u067E\u06CC\u0627\u0645 \u0645\u062D\u0627\u0633\u0628\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F (\u067E\u06CC\u0627\u0645\u200C\u0647\u0627\u06CC \u06F1\u06F1 \u062A\u0627 \u06F3\u06F0 \u0631\u06CC\u062E\u062A\u0647 \u0646\u0634\u062F\u0647\u200C\u0627\u0646\u062F)", all > first10 + 150, { all, first10 });
}
console.log("\u06F3) \u062A\u0627\u0631\u06CC\u062E\u0686\u0647\u0654 \u06A9\u0627\u0645\u0644 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F (\u0645\u062B\u0644 opencode):");
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(400)
    // ~100 tokens each
  }));
  const ten = estimateContextTokens(mkChat(mk(10), "ask"), SYSTEM, 2e5);
  const thirty = estimateContextTokens(mkChat(mk(30), "ask"), SYSTEM, 2e5);
  check("\u06F3\u06F0 \u067E\u06CC\u0627\u0645 \u062D\u062F\u0648\u062F \u06F2\u06F0 \u067E\u06CC\u0627\u0645 \u0627\u0636\u0627\u0641\u0647 \u0646\u0633\u0628\u062A \u0628\u0647 \u06F1\u06F0 \u067E\u06CC\u0627\u0645 \u062F\u0627\u0631\u062F (\u062E\u0637\u06CC\u060C \u0628\u062F\u0648\u0646 slice)", thirty > ten + 1500, { ten, thirty });
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
