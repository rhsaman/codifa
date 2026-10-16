// tests/_globals.ts
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
var FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
var DIGITS_RE = `[0-9${FA_DIGITS}]`;
var LINE_RANGE_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*[-\u2013\u2014~]\\s*(${DIGITS_RE}+))?`
);
var LINE_RANGE_CONN_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)\\s+(?:\u062A\u0627|\u0627\u0644\u06CC)\\s+(${DIGITS_RE}+)`
);
var PATH_RE = new RegExp(
  `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`
);
var BARE_RANGE_FENCE_RE = new RegExp(
  "^```\\s*([\\w-]+):(" + DIGITS_RE + "+)-(" + DIGITS_RE + "+)\\s*$"
);
var MIXED_WORD_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);
var SCRIPT_BOUNDARY_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);

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
function computeContextUsed(chat, systemPrompt, contextWindow) {
  const msgs = chat?.messages ?? [];
  const active = msgs.filter((m) => !m.compacted);
  let last = null;
  for (const m of active) {
    const u = m.usage;
    if (u && m.role === "assistant") last = u;
  }
  if (last && (last.inputTokens ?? 0) > 0) {
    const providerTotal = Math.max(last.totalTokens ?? 0, last.inputTokens ?? 0);
    if (providerTotal > 0) return providerTotal;
  }
  return estimateContextTokens(chat, systemPrompt, contextWindow);
}

// tests/contextUsed.test.ts
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
var est = (chat, sp = "sys") => Math.round(estimateContextChars(chat, sp, 2e5) / CHARS_PER_TOKEN);
console.log("\u06F1) meter = opencode sum of the latest turn (input+output+reasoning+cache):");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", usage: { inputTokens: 5e3, outputTokens: 900, totalTokens: 5900 } }
  ]);
  check("used = input+output (5900)", computeContextUsed(chat, "sys", 2e5) === 5900, computeContextUsed(chat, "sys", 2e5));
  const chat2 = mkChat([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", usage: { inputTokens: 5e3, outputTokens: 900, totalTokens: 7100, cacheReadTokens: 1200, cacheWriteTokens: 0 } }
  ]);
  check(
    "used = input+output+cacheRead (7100)",
    computeContextUsed(chat2, "sys", 2e5) === 7100,
    computeContextUsed(chat2, "sys", 2e5)
  );
}
console.log("\u06F1\u0628) reasoning tokens are included in the meter (opencode parity):");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: { inputTokens: 5e3, outputTokens: 900, reasoningTokens: 1500, cacheReadTokens: 1200, cacheWriteTokens: 300, totalTokens: 8900 }
    }
  ]);
  check(
    "used = input+output+reasoning+cacheRead+cacheWrite (8900)",
    computeContextUsed(chat, "sys", 2e5) === 8900,
    computeContextUsed(chat, "sys", 2e5)
  );
}
console.log('\u06F2) meter follows the LATEST turn, not a historical peak (no "stuck at old peak"):');
{
  const chat = mkChat([
    { role: "user", content: "big" },
    { role: "assistant", content: "big", usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: "user", content: "small follow-up" },
    { role: "assistant", content: "small", usage: { inputTokens: 2e3, outputTokens: 10, totalTokens: 2010 } }
  ]);
  check("used = latest turn sum (2010)", computeContextUsed(chat, "sys", 2e5) === 2010, computeContextUsed(chat, "sys", 2e5));
}
console.log("\u06F2\u0628) compacted turns are excluded from the meter:");
{
  const chat = mkChat([
    { role: "user", content: "big" },
    { role: "assistant", content: "big", usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 }, compacted: true },
    { role: "user", content: "small follow-up" },
    { role: "assistant", content: "small", usage: { inputTokens: 2e3, outputTokens: 10, totalTokens: 2010 } }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used = latest non-compacted sum (2010)", used === 2010, { used });
}
console.log("\u06F3) usage parts but no input_tokens yet \u2192 falls back to the history estimate:");
{
  const chat = mkChat([
    { role: "user", content: "x".repeat(2e3) },
    { role: "assistant", content: "ok", usage: { outputTokens: 50 } }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used = history estimate, not just last-message parts", used === est(chat) && used > 150, { used, est: est(chat) });
}
console.log("\u06F4) no usage yet \u2192 returns a positive estimate (no 0% collapse):");
{
  const chat = mkChat([
    { role: "user", content: "hello there friend" },
    { role: "assistant", content: "hi" }
    // no usage object
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used is a positive estimate when no usage event yet", used > 0, used);
}
console.log("\u06F5) subset provider: backend sends real cache_read but total_tokens already folds it into input:");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 150 }
    }
  ]);
  check("used = total_tokens (150, cache NOT double-counted for subset)", computeContextUsed(chat, "sys", 2e5) === 150, computeContextUsed(chat, "sys", 2e5));
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
