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
function computeContextUsed(chat, systemPrompt, contextWindow) {
  const msgs = chat?.messages ?? [];
  const active = msgs.filter((m) => !m.compacted);
  const estimated = Math.round(
    estimateContextChars(chat, systemPrompt, contextWindow) / CHARS_PER_TOKEN
  );
  let best = estimated;
  for (const m of active) {
    const u = m.usage;
    if (!u || m.role !== "assistant") continue;
    const parts = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.reasoningTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    const reported = u.contextTokens != null ? u.contextTokens : u.totalTokens != null ? u.totalTokens : parts;
    if (reported > best) best = reported;
  }
  return best;
}

// test/contextUsed.test.ts
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
console.log("\u06F1) realTotal includes output + cache (latest turn total, like opencode overflow.ts):");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: { inputTokens: 5e3, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used = input + output (5900), output included", used === 5900, used);
  const chat2 = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: { inputTokens: 5e3, outputTokens: 900, totalTokens: 7100, cacheReadTokens: 1200, cacheWriteTokens: 0 }
    }
  ]);
  check(
    "used = cache-inclusive total (7100 = 5000+900+1200)",
    computeContextUsed(chat2, "sys", 2e5) === 7100,
    computeContextUsed(chat2, "sys", 2e5)
  );
}
console.log("\u06F2) meter reflects the TRUE context (system + full history), not just the latest message:");
{
  const chat = mkChat([
    { role: "user", content: "big" },
    { role: "assistant", content: "big", outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 } },
    { role: "user", content: "small follow-up" },
    { role: "assistant", content: "small", outputTokens: 10, usage: { inputTokens: 2e3, outputTokens: 10, totalTokens: 2010 } }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check(
    "used is the peak context, not just the latest (>= estimate, > 2010)",
    used >= est(chat) && used > 2010,
    { used, est: est(chat) }
  );
}
console.log("\u06F2\u0628) compacted turns are excluded from the estimated context:");
{
  const chat = mkChat([
    { role: "user", content: "big" },
    { role: "assistant", content: "big", outputTokens: 5, usage: { inputTokens: 999999, outputTokens: 5, totalTokens: 1000004 }, compacted: true },
    { role: "user", content: "small follow-up" },
    { role: "assistant", content: "small", outputTokens: 10, usage: { inputTokens: 2e3, outputTokens: 10, totalTokens: 2010 } }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used = estimate of non-compacted history", used === est(chat) && used > 2010, { used, est: est(chat) });
}
console.log("\u06F3) provider reports a real total \u2192 meter trusts it (output included):");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      outputTokens: 10,
      usage: { inputTokens: 99999, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used includes output (100009)", used === 100009, used);
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
console.log("\u06F5) meter reflects the true context (system + history), larger than bare message usage:");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 30 } }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  const expected = est(chat);
  check("used = true context estimate (>= message usage)", used === expected && used > 180, { used, expected });
}
console.log("\u06F6) cached provider: cache tokens are counted, not dropped (opencode parity):");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5e3, cacheWriteTokens: 200 }
    }
  ]);
  const used = computeContextUsed(chat, "sys", 2e5);
  check("used = input + output + cache.read + cache.write (5350)", used === 5350, used);
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
