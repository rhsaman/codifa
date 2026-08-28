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
function contextPercent(used, windowSize, reserved = 0) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round(used / windowSize * 100);
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
function priceForModel(pricingMap, model) {
  if (!pricingMap || !model) return null;
  const norm = (m) => (m || "").replace(/^models\//, "");
  const bare = (m) => norm(m).split("/").pop() || m;
  const candidates = [model, norm(model), bare(model)];
  for (const c of candidates) {
    const hit = pricingMap[c];
    if (hit) return hit;
  }
  const targetBare = bare(model);
  for (const [k, v] of Object.entries(pricingMap)) {
    if (norm(k) === norm(model) || bare(k) === targetBare) return v;
  }
  return null;
}
function computeUsageCost(price, u) {
  if (!price) return null;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  return (u.input - cacheRead - cacheWrite) / 1e6 * price.input + cacheRead / 1e6 * (price.cacheRead ?? price.input) + cacheWrite / 1e6 * (price.cacheWrite ?? price.input) + u.output / 1e6 * price.output;
}

// test/context.test.ts
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    console.log(`  \u2717 ${name}`);
    if (extra !== void 0) console.log("    got:", JSON.stringify(extra));
    globalThis.__FAILED = true;
  }
}
var est = (chat, sp = "") => Math.round(estimateContextChars(chat, sp, 2e5) / CHARS_PER_TOKEN);
var mkMsg = (role, usage, content = "") => ({
  id: Math.random().toString(),
  role,
  content,
  usage,
  compacted: false
});
console.log("\u06F1) meter reflects the FULL context (system + all history), not just the latest message:");
{
  const small = {
    messages: [
      mkMsg("user", null, "x".repeat(200)),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50 }, "y".repeat(200))
    ]
  };
  const big = {
    messages: [
      mkMsg("user", null, "x".repeat(200)),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50 }, "y".repeat(200)),
      mkMsg("user", null, "x".repeat(200)),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50 }, "y".repeat(200)),
      mkMsg("user", null, "x".repeat(200)),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50 }, "y".repeat(200))
    ]
  };
  const smallUsed = computeContextUsed(small, "", 2e5);
  const bigUsed = computeContextUsed(big, "", 2e5);
  check("\u0686\u062A \u0628\u0627 \u062A\u0627\u0631\u06CC\u062E\u0686\u0647\u0654 \u0628\u06CC\u0634\u062A\u0631 \u06A9\u0627\u0646\u062A\u06A9\u0633\u062A \u0628\u0632\u0631\u06AF\u062A\u0631\u06CC \u0646\u0634\u0627\u0646 \u0645\u06CC\u200C\u062F\u0647\u062F", bigUsed > smallUsed, { smallUsed, bigUsed });
  check("\u0645\u062A\u0631 \u0632\u06CC\u0631\u0650 \u06AF\u0632\u0627\u0631\u0634 \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 \u0646\u0645\u06CC\u200C\u0627\u0641\u062A\u062F (\u0628\u0631\u0622\u0648\u0631\u062F \u0648\u0627\u0642\u0639\u06CC)", bigUsed > 150, bigUsed);
}
console.log("\u06F2) contextPercent uses raw window (no reserved subtraction):");
{
  check("100000/200000 = 50% \u0646\u0647 55.5%", contextPercent(1e5, 2e5) === 50, contextPercent(1e5, 2e5));
}
console.log("\u06F3) computeContextUsed falls back to a positive estimate when no usage (no 0% collapse):");
{
  const chat = { messages: [mkMsg("user", null), mkMsg("assistant", null)] };
  const used = computeContextUsed(chat, "big system prompt", 2e5);
  check("\u0648\u0642\u062A\u06CC usage \u0646\u06CC\u0633\u062A \u0628\u0631\u0622\u0648\u0631\u062F \u0645\u062B\u0628\u062A \u0628\u0631\u0645\u06CC\u200C\u06AF\u0631\u062F\u062F (\u0646\u0647 0)", used > 0, used);
}
console.log("\u06F4) trusts the provider when it reports the LARGER full context (incl. cache):");
{
  const chat = {
    messages: [
      mkMsg("user", null),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50, totalTokens: 99999, cacheReadTokens: 5e3 })
    ]
  };
  const used = computeContextUsed(chat, "", 2e5);
  check("\u0645\u062A\u0631 \u0645\u0642\u062F\u0627\u0631 \u0628\u0632\u0631\u06AF\u062A\u0631 \u06AF\u0632\u0627\u0631\u0634\u200C\u0634\u062F\u0647 \u0631\u0627 \u0645\u06CC\u200C\u067E\u0630\u06CC\u0631\u062F (99999)", used === 99999, used);
}
console.log("\u06F5) compacted messages are excluded from the estimated context:");
{
  const chat = {
    messages: [
      mkMsg("user", null),
      { ...mkMsg("assistant", { inputTokens: 1, outputTokens: 1 }, "z".repeat(400)), compacted: true },
      mkMsg("user", null),
      mkMsg("assistant", { inputTokens: 100, outputTokens: 50 })
    ]
  };
  const used = computeContextUsed(chat, "", 2e5);
  const expected = est(chat, "");
  check("\u0645\u062A\u0631 \u0628\u0631\u0622\u0648\u0631\u062F \u062A\u0627\u0631\u06CC\u062E\u0686\u0647\u0654 \u063A\u06CC\u0631\u0650\u0641\u0634\u0631\u062F\u0647 \u0627\u0633\u062A", used === expected, { used, expected });
}
console.log("\u06F7) pricing lookup tolerates id mismatches (models/ prefix, bare id):");
{
  const pm = { "hy3-free": { input: 0.5, output: 1.5, cacheRead: 0.05 } };
  check("exact id matches", priceForModel(pm, "hy3-free")?.input === 0.5);
  check("models/ prefix matches", priceForModel(pm, "models/hy3-free")?.input === 0.5);
  check("provider-prefixed bare id matches", priceForModel(pm, "myhost/hy3-free")?.input === 0.5);
  check("unknown model -> null (renders \u2014)", priceForModel(pm, "nope") === null);
}
console.log("\u06F8) usage cost splits cached tokens at the cheaper rate (subset convention):");
{
  const u = { input: 18194, output: 599, cacheRead: 16512, cacheWrite: 0 };
  const price = { input: 0.5, output: 1.5, cacheRead: 0.05 };
  const expected = 1682 / 1e6 * 0.5 + 16512 / 1e6 * 0.05 + 599 / 1e6 * 1.5;
  const got = computeUsageCost(price, u);
  check("cost matches hand-computed value", Math.abs(got - expected) < 1e-9, { got, expected });
  check("null price -> null (renders \u2014)", computeUsageCost(null, u) === null);
}
if (globalThis.__FAILED) {
  console.error("\nFAILED");
  process.exit(1);
} else {
  console.log("\nALL PASSED");
}
