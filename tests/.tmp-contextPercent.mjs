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
var PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
function contextPercent(used, windowSize, reserved = 0) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round(used / windowSize * 100);
}
function scaleReserved(cw, headroom) {
  if (cw <= 0) return headroom;
  const cap = Math.max(2e3, Math.round(cw * 0.1));
  return Math.min(headroom, cap);
}

// test/contextPercent.test.ts
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    console.log(`  \u2717 ${name}`);
    if (extra !== void 0) console.log("    got:", JSON.stringify(extra));
    globalThis.__FAILED = true;
  }
}
console.log("\u06F1) reserved=0 \u2192 percentage relative to the whole window (opencode usable == window):");
{
  check("used=0 \u2192 0%", contextPercent(0, 2e5, 0) === 0);
  check("used=100000, window=200000 \u2192 50%", contextPercent(1e5, 2e5, 0) === 50);
  check("used=200000 \u2192 100%", contextPercent(2e5, 2e5, 0) === 100);
}
console.log("\u06F2) reserved>0 \u2192 percentage relative to RAW window (opencode: meter is raw, headroom NOT subtracted):");
{
  const reserved = 2e4;
  const window = 2e5;
  check("scaleReserved(200k, 20k) = 20000", scaleReserved(window, reserved) === 2e4, scaleReserved(window, reserved));
  check("used=180000 \u2192 90% (raw window, not usable)", contextPercent(18e4, window, reserved) === 90, contextPercent(18e4, window, reserved));
  check("used=90000 \u2192 45% (raw)", contextPercent(9e4, window, reserved) === 45, contextPercent(9e4, window, reserved));
  check("used=100000 \u2192 50% (raw)", contextPercent(1e5, window, reserved) === 50, contextPercent(1e5, window, reserved));
}
console.log("\u06F3) small window \u2192 reserved clamped down (opencode clamps buffer to maxOutputTokens):");
{
  const window = 2e4;
  const reserved = 2e4;
  check("scaleReserved(20k, 20k) = 2000", scaleReserved(window, reserved) === 2e3, scaleReserved(window, reserved));
  check("used=18000 \u2192 90% (raw window)", contextPercent(18e3, window, reserved) === 90, contextPercent(18e3, window, reserved));
}
console.log("\u06F4) edge cases:");
{
  check("window=0 \u2192 null", contextPercent(100, 0, 0) === null);
  check("window=null \u2192 null", contextPercent(100, null, 0) === null);
  check("used == window \u2192 100% (raw)", contextPercent(2e5, 2e5, 2e4) === 100, contextPercent(2e5, 2e5, 2e4));
  check("reserved >= window \u2192 relative to raw window", contextPercent(5e4, 1e5, 1e5) === 50, contextPercent(5e4, 1e5, 1e5));
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
