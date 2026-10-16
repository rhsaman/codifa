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
function formatTokensK(n) {
  if (n >= 1e6) {
    const m = n / 1e6;
    return `${m.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString("en-US")}K`;
  return Math.round(n).toLocaleString("en-US");
}
function contextPercent(used, windowSize, reserved = 0) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round(used / windowSize * 100);
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
var CONTEXT_BREAKDOWN_LABELS = {
  messages: "Messages",
  systemTools: "System tools",
  systemPrompt: "System prompt",
  skills: "Skills",
  mcpTools: "MCP tools",
  meta: "Meta context"
};
var CONTEXT_BREAKDOWN_ORDER = [
  "messages",
  "systemTools",
  "systemPrompt",
  "skills",
  "mcpTools",
  "meta"
];
function averageCacheHitRate(usages) {
  let hit = 0;
  let denom = 0;
  for (const u of usages) {
    const read = u.cacheReadTokens ?? 0;
    const write = u.cacheWriteTokens ?? 0;
    const cache = read + write;
    const input = u.inputTokens ?? 0;
    if (input <= 0 && cache <= 0) continue;
    const base = input >= cache ? Math.max(0, input) : input + cache;
    if (base <= 0) continue;
    hit += read;
    denom += base;
  }
  if (denom <= 0) return null;
  return Math.min(100, Math.max(0, hit / denom * 100));
}
function contextBarSegmentPercent(rowTokens, total, window) {
  if (window != null && window > 0) return Math.max(0, rowTokens / window * 100);
  if (total > 0) return Math.max(0, rowTokens / total * 100);
  return 0;
}
function computeContextBreakdown(total, parts, window, cacheHitRate) {
  const safeTotal = Math.max(0, Math.round(total));
  const rows = CONTEXT_BREAKDOWN_ORDER.map((key) => {
    const tokens = Math.max(0, Math.round(parts[key] ?? 0));
    return {
      key,
      label: CONTEXT_BREAKDOWN_LABELS[key],
      tokens,
      percent: safeTotal > 0 ? tokens / safeTotal * 100 : 0
    };
  });
  rows.sort((a, b) => b.tokens - a.tokens);
  return {
    total: safeTotal,
    window,
    percent: contextPercent(safeTotal, window),
    rows,
    cacheHitRate
  };
}
function estimateBreakdownParts(chat, systemPrompt, opts = {}) {
  const msgs = chat?.messages ?? [];
  let msgChars = 0;
  let metaChars = 0;
  for (const m of msgs) {
    if (!m.compacted) continue;
    metaChars += m.content.length;
    if (m.thinking) metaChars += m.thinking.length;
  }
  if (opts.metaChars != null) metaChars = opts.metaChars;
  const active = msgs.filter((m) => !m.compacted);
  const talk = active.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "system"
  );
  const { settled, live } = budgetedSettledHistory(talk);
  for (const m of settled) {
    msgChars += m.content.length;
    if (m.thinking) msgChars += m.thinking.length;
    for (const act of m.toolActivity ?? []) {
      msgChars += act.tool.length;
      if (act.args) msgChars += JSON.stringify(act.args).length;
      if (act.summary) msgChars += act.summary.length;
      if (act.diff) msgChars += act.diff.length;
    }
  }
  if (live) {
    msgChars += live.content.length;
    if (live.thinking) msgChars += live.thinking.length;
    for (const act of live.toolActivity ?? []) {
      msgChars += act.tool.length;
      if (act.args) msgChars += JSON.stringify(act.args).length;
      if (act.summary) msgChars += act.summary.length;
      if (act.diff) msgChars += act.diff.length;
    }
  }
  const messages = Math.round(msgChars / CHARS_PER_TOKEN);
  const systemPromptTokens = opts.systemPromptChars != null ? Math.round(opts.systemPromptChars / CHARS_PER_TOKEN) : Math.round((systemPrompt.length + 16e3) / CHARS_PER_TOKEN);
  const systemToolsTokens = opts.systemToolsChars != null ? Math.round(opts.systemToolsChars / CHARS_PER_TOKEN) : 0;
  const metaTokens = Math.round(metaChars / CHARS_PER_TOKEN);
  const skillsTokens = Math.round((opts.skillsChars ?? 0) / CHARS_PER_TOKEN);
  const mcpTokens = Math.round((opts.mcpChars ?? 0) / CHARS_PER_TOKEN);
  return {
    messages,
    systemTools: systemToolsTokens,
    systemPrompt: systemPromptTokens,
    skills: skillsTokens,
    mcpTools: mcpTokens,
    meta: metaTokens
  };
}
function buildContextBreakdown(chat, systemPrompt, window, opts = {}) {
  const parts = estimateBreakdownParts(chat, systemPrompt, opts);
  const actual = Math.max(
    0,
    computeContextUsed(chat, systemPrompt, window ?? void 0)
  );
  const known = parts.messages + parts.systemTools + parts.systemPrompt + parts.skills + parts.mcpTools + parts.meta;
  const hasRealTools = opts.systemToolsChars != null;
  let scaled = parts;
  if (actual > 0 && known !== actual) {
    if (known <= 0) {
      scaled = { ...parts, systemTools: actual };
    } else if (known < actual) {
      if (hasRealTools) {
        scaled = { ...parts, messages: parts.messages + (actual - known) };
      } else {
        scaled = { ...parts, systemTools: parts.systemTools + (actual - known) };
      }
    } else {
      const estSum = parts.messages + parts.meta;
      const excess = known - actual;
      if (estSum > 0 && excess <= estSum) {
        const keep = estSum - excess;
        const k = keep / estSum;
        scaled = {
          ...parts,
          messages: Math.round(parts.messages * k),
          meta: Math.round(parts.meta * k)
        };
        const estDrift = keep - (scaled.messages + scaled.meta);
        if (estDrift !== 0) {
          scaled = { ...scaled, messages: Math.max(0, scaled.messages + estDrift) };
        }
      } else {
        const k = known > 0 ? actual / known : 0;
        scaled = {
          messages: Math.round(parts.messages * k),
          systemTools: Math.round(parts.systemTools * k),
          systemPrompt: Math.round(parts.systemPrompt * k),
          skills: Math.round(parts.skills * k),
          mcpTools: Math.round(parts.mcpTools * k),
          meta: Math.round(parts.meta * k)
        };
        const sum = Object.values(scaled).reduce((s, v) => s + v, 0);
        const drift = actual - sum;
        if (drift !== 0) {
          scaled = { ...scaled, systemTools: Math.max(0, scaled.systemTools + drift) };
        }
      }
    }
  }
  const total = actual;
  const usages = (chat?.messages ?? []).filter((m) => !m.compacted && m.role === "assistant" && m.usage).map((m) => m.usage);
  return computeContextBreakdown(total, scaled, window, averageCacheHitRate(usages));
}
function isContextPopoverOpen(openForChatId, activeChatId, total) {
  return openForChatId !== null && openForChatId === activeChatId && total > 0;
}
function formatBreakdownPercent(pct) {
  const v = Math.round(Math.max(0, pct) * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

// tests/contextBreakdown.test.ts
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    console.log(`  \u2717 ${name}`);
    if (extra !== void 0) console.log("    got:", JSON.stringify(extra));
    globalThis.__FAILED = true;
  }
}
function mkChat(messages) {
  return { id: "c1", mode: "ask", messages };
}
console.log("\u06F1) computeContextBreakdown: percentages, ordering, window:");
{
  const bd = computeContextBreakdown(
    1e3,
    {
      messages: 960,
      systemTools: 30,
      systemPrompt: 2,
      skills: 1,
      mcpTools: 1,
      meta: 6
    },
    1e4,
    87.5
  );
  check("total passthrough", bd.total === 1e3, bd.total);
  check("window passthrough", bd.window === 1e4, bd.window);
  check("window percent (1000/10000 = 10%)", bd.percent === 10, bd.percent);
  check("cache hit rate passthrough", bd.cacheHitRate === 87.5, bd.cacheHitRate);
  check("rows sorted heaviest first", bd.rows[0]?.key === "messages", bd.rows.map((r) => r.key));
  check(
    "second row is system tools (30 > 6 > 2)",
    bd.rows[1]?.key === "systemTools" && bd.rows[2]?.key === "meta",
    bd.rows.map((r) => r.key)
  );
  check("messages = 96%", Math.abs(bd.rows[0].percent - 96) < 1e-9, bd.rows[0].percent);
  check("system tools = 3%", Math.abs(bd.rows[1].percent - 3) < 1e-9, bd.rows[1].percent);
  const sum = bd.rows.reduce((s, r) => s + r.percent, 0);
  check("row percentages sum to 100", Math.abs(sum - 100) < 1e-9, sum);
  check("labels come from CONTEXT_BREAKDOWN_LABELS", bd.rows[0].label === "Messages", bd.rows[0].label);
}
console.log("\u06F2) computeContextBreakdown edge cases (zero total, negative parts):");
{
  const zero = computeContextBreakdown(
    0,
    { messages: 0, systemTools: 0, systemPrompt: 0, skills: 0, mcpTools: 0, meta: 0 },
    1e5,
    null
  );
  check("total 0 -> all row percents 0", zero.rows.every((r) => r.percent === 0), zero.rows.map((r) => r.percent));
  check("total 0 -> window percent 0", zero.percent === 0, zero.percent);
  check("no cache rate -> null", zero.cacheHitRate === null);
  const neg = computeContextBreakdown(
    100,
    { messages: -50, systemTools: 10, systemPrompt: 0, skills: 0, mcpTools: 0, meta: 0 },
    null,
    null
  );
  check("negative part clamped to 0", neg.rows.find((r) => r.key === "messages")?.tokens === 0);
  check("unknown window -> percent null", neg.percent === null, neg.percent);
}
console.log("\u06F3) averageCacheHitRate: subset vs additive convention + empty:");
{
  const subset = averageCacheHitRate([
    { inputTokens: 9e4, outputTokens: 0, totalTokens: 9e4, cacheReadTokens: 87e3 }
  ]);
  check("subset: 87000/90000 = 96.67%", subset != null && Math.abs(subset - 87e3 / 9e4 * 100) < 1e-9, subset);
  const additive = averageCacheHitRate([
    { inputTokens: 3e3, outputTokens: 0, totalTokens: 9e3, cacheReadTokens: 6e3 }
  ]);
  check("additive: 6000/(3000+6000) = 66.67%", additive != null && Math.abs(additive - 6e3 / 9e3 * 100) < 1e-9, additive);
  const mixed = averageCacheHitRate([
    { inputTokens: 1e3, outputTokens: 0, totalTokens: 1e3, cacheReadTokens: 500 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  ]);
  check("zero-usage turn skipped", mixed != null && Math.abs(mixed - 50) < 1e-9, mixed);
  check("no usages -> null", averageCacheHitRate([]) === null);
  const coldWrite = averageCacheHitRate([
    { inputTokens: 3e3, outputTokens: 0, totalTokens: 9e3, cacheWriteTokens: 6e3 }
  ]);
  check("additive cold write-only turn -> 0% hit", coldWrite === 0, coldWrite);
  const warmWrite = averageCacheHitRate([
    { inputTokens: 3e3, outputTokens: 0, totalTokens: 9500, cacheReadTokens: 6e3, cacheWriteTokens: 500 }
  ]);
  check(
    "additive warm: 6000/(3000+6000+500)",
    warmWrite != null && Math.abs(warmWrite - 6e3 / 9500 * 100) < 1e-9,
    warmWrite
  );
  const subsetWrite = averageCacheHitRate([
    { inputTokens: 9e4, outputTokens: 0, totalTokens: 9e4, cacheReadTokens: 87e3, cacheWriteTokens: 2e3 }
  ]);
  check(
    "subset with write: 87000/90000",
    subsetWrite != null && Math.abs(subsetWrite - 87e3 / 9e4 * 100) < 1e-9,
    subsetWrite
  );
}
console.log("\u06F4) estimateBreakdownParts: defaults and caller overrides:");
{
  const compacted = "old summary that was compacted";
  const chat = mkChat([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "system", content: compacted, compacted: true }
  ]);
  const d = estimateBreakdownParts(chat, "sys");
  check("messages exclude compacted summaries (9 chars / 4)", d.messages === Math.round(9 / 4), d.messages);
  check("system prompt = 3 chars / 4", d.systemPrompt === Math.round(3 / 4), d.systemPrompt);
  check("systemTools has NO fixed floor (default 0)", d.systemTools === 0, d.systemTools);
  check("meta = compacted summary content", d.meta === Math.round(compacted.length / 4), d.meta);
  check("skills/mcp default to 0", d.skills === 0 && d.mcpTools === 0, d);
  const o = estimateBreakdownParts(chat, "sys", {
    systemToolsChars: 8,
    metaChars: 4,
    skillsChars: 12,
    mcpChars: 4
  });
  check("override system tools", o.systemTools === 2, o.systemTools);
  check("override meta", o.meta === 1, o.meta);
  check("override skills", o.skills === 3, o.skills);
  check("override mcp", o.mcpTools === 1, o.mcpTools);
}
console.log("\u06F5) buildContextBreakdown: scales estimates to the real meter total:");
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      usage: {
        inputTokens: 1e3,
        outputTokens: 1e3,
        totalTokens: 2e3,
        cacheReadTokens: 800,
        cacheWriteTokens: 0
      }
    }
  ]);
  const bd = buildContextBreakdown(chat, "sys", 1e4);
  check("total = provider-reported meter total (2000)", bd.total === 2e3, bd.total);
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0);
  check("scaled rows sum exactly to the total (no rounding drift)", sum === 2e3, sum);
  check("six rows", bd.rows.length === 6, bd.rows.length);
  check("window percent = 2000/10000 = 20%", bd.percent === 20, bd.percent);
  check("cache hit rate = 800/1000 = 80%", bd.cacheHitRate != null && Math.abs(bd.cacheHitRate - 80) < 1e-9, bd.cacheHitRate);
  const tools = bd.rows.find((r) => r.key === "systemTools");
  check("remainder = 2000 - messages(1) - prompt(1) = 1998", tools?.tokens === 1998, tools?.tokens);
}
console.log("\u06F5\u0628) buildContextBreakdown: estimate overshoot shrinks proportionally:");
{
  const chat = mkChat([
    { role: "user", content: "x".repeat(4e3) },
    { role: "assistant", content: "ok", usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1e3 } }
  ]);
  const bd = buildContextBreakdown(chat, "sys", 1e4);
  check("total = provider total (1000)", bd.total === 1e3, bd.total);
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0);
  check("rows sum to the real total after shrink", sum === 1e3, sum);
}
console.log("\u06F5\u062C) fresh chat: no fake floors \u2014 remainder is exactly the real total:");
{
  const chat = mkChat([]);
  const bd = buildContextBreakdown(chat, "", 2e5);
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0);
  check("rows sum to the meter total", sum === bd.total, { sum, total: bd.total });
  const tools = bd.rows.find((r) => r.key === "systemTools");
  check("systemTools holds the whole remainder", tools?.tokens === bd.total, tools?.tokens);
}
console.log("\u06F6) isContextPopoverOpen: chat-scoped and requires a non-zero total:");
{
  check("same chat + total > 0 -> open", isContextPopoverOpen("c1", "c1", 100) === true);
  check("different chat -> closed", isContextPopoverOpen("c1", "c2", 100) === false);
  check("never opened -> closed", isContextPopoverOpen(null, "c1", 100) === false);
  check("zero total -> closed", isContextPopoverOpen("c1", "c1", 0) === false);
}
console.log("\u06F7) formatBreakdownPercent: at most one decimal:");
{
  check('0 -> "0%"', formatBreakdownPercent(0) === "0%", formatBreakdownPercent(0));
  check('96.78 -> "96.8%"', formatBreakdownPercent(96.78) === "96.8%", formatBreakdownPercent(96.78));
  check('98.7 -> "98.7%"', formatBreakdownPercent(98.7) === "98.7%", formatBreakdownPercent(98.7));
  check('0.6 -> "0.6%"', formatBreakdownPercent(0.6) === "0.6%", formatBreakdownPercent(0.6));
  check('0.04 -> "0%"', formatBreakdownPercent(0.04) === "0%", formatBreakdownPercent(0.04));
  check('100 -> "100%"', formatBreakdownPercent(100) === "100%", formatBreakdownPercent(100));
}
console.log("\u06F8) real reported parts (ctx_parts) beat estimates:");
{
  const chat = mkChat([{ role: "user", content: "hi" }]);
  const bd = buildContextBreakdown(chat, "sys", 1e4, {
    systemPromptChars: 8e3,
    skillsChars: 1200,
    mcpChars: 400
  });
  const find = (k) => bd.rows.find((r) => r.key === k)?.tokens;
  check("system prompt = 8000/4 = 2000", find("systemPrompt") === 2e3, find("systemPrompt"));
  check("skills = 1200/4 = 300", find("skills") === 300, find("skills"));
  check("mcp = 400/4 = 100", find("mcpTools") === 100, find("mcpTools"));
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0);
  check("rows still sum to the meter total", sum === bd.total, { sum, total: bd.total });
  const chat2 = mkChat([
    { role: "user", content: "x".repeat(4e3) },
    { role: "assistant", content: "ok", usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1e3 } }
  ]);
  const bd2 = buildContextBreakdown(chat2, "sys", 1e4, { systemPromptChars: 800 });
  const sp2 = bd2.rows.find((r) => r.key === "systemPrompt")?.tokens;
  check("real system prompt preserved on overshoot", sp2 === 200, sp2);
  const chat3 = mkChat([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", usage: { inputTokens: 5e3, outputTokens: 100, totalTokens: 5100 } }
  ]);
  const bd3 = buildContextBreakdown(chat3, "sys", 1e5, { systemToolsChars: 12e3, mcpChars: 400 });
  const tools3 = bd3.rows.find((r) => r.key === "systemTools")?.tokens;
  check("real system tools preserved (12000/4 = 3000)", tools3 === 3e3, tools3);
}
{
  const chat = mkChat([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" }
  ]);
  const bd = buildContextBreakdown(chat, "sys", 1e5);
  const find = (k) => bd.rows.find((r) => r.key === k)?.tokens;
  const sum = bd.rows.reduce((s, r) => s + r.tokens, 0);
  check("rows still sum to the meter total", sum === bd.total, { sum, total: bd.total });
  check("system tools holds the unmeasured schemas (not 0)", (find("systemTools") ?? 0) > 0, find("systemTools"));
}
console.log("9) contextBarSegmentPercent: fill-scaled against the window:");
{
  const total = 108124;
  const window = 1048576;
  check(
    "segment = tokens/window (105900/1M ~ 10.1%)",
    Math.abs(contextBarSegmentPercent(105900, total, window) - 105900 / window * 100) < 1e-9,
    contextBarSegmentPercent(105900, total, window)
  );
  const sum = [105900, 1300, 910, 14, 0, 0].reduce(
    (s, t) => s + contextBarSegmentPercent(t, total, window),
    0
  );
  check("segments sum to the usage percent (10.31%)", Math.abs(sum - total / window * 100) < 1e-9, sum);
  check(
    "no window -> falls back to composition (sums to 100%)",
    Math.abs(
      [105900, 1300, 910, 14, 0, 0].reduce(
        (s, t) => s + contextBarSegmentPercent(t, total, null),
        0
      ) - 100
    ) < 1e-9
  );
  check("zero total without window -> 0", contextBarSegmentPercent(50, 0, null) === 0);
  check("negative row clamped to 0", contextBarSegmentPercent(-5, total, window) === 0);
}
console.log("10) formatTokensK: window label keeps percent-consistent precision:");
{
  check('1048576 -> "1.05M"', formatTokensK(1048576) === "1.05M", formatTokensK(1048576));
  check('1000000 -> "1M"', formatTokensK(1e6) === "1M", formatTokensK(1e6));
  check('2000000 -> "2M"', formatTokensK(2e6) === "2M", formatTokensK(2e6));
  check('2500000 -> "2.5M"', formatTokensK(25e5) === "2.5M", formatTokensK(25e5));
  check('200000 -> "200K"', formatTokensK(2e5) === "200K", formatTokensK(2e5));
  check('824100 -> "824K"', formatTokensK(824100) === "824K", formatTokensK(824100));
  check('2365100 -> "2.37M"', formatTokensK(2365100) === "2.37M", formatTokensK(2365100));
  check('900 -> "900"', formatTokensK(900) === "900", formatTokensK(900));
}
console.log("\u06F1\u06F1) threshold-scaled ring: 100% at the auto-compaction threshold:");
{
  const raw = 2e5;
  const usable = Math.round(raw * (50 / 100));
  const atThreshold = contextPercent(1e5, usable);
  const halfThreshold = contextPercent(5e4, usable);
  check("usable = 50% of raw (100k)", usable === 1e5, usable);
  check("100k used with 50% threshold -> 100 (ring full)", Math.round(atThreshold ?? 0) === 100, atThreshold);
  check("50k used with 50% threshold -> 50", Math.round(halfThreshold ?? 0) === 50, halfThreshold);
  const over = contextPercent(15e4, usable);
  check("over threshold clamps to 100 in the ring", Math.min(100, Math.round(over ?? 0)) === 100, over);
  const bd = computeContextBreakdown(
    1e5,
    { messages: 9e4, systemTools: 8e3, systemPrompt: 1e3, skills: 500, mcpTools: 500, meta: 0 },
    usable,
    null
  );
  check("breakdown percent = 100 at threshold", bd.percent === 100, bd.percent);
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
