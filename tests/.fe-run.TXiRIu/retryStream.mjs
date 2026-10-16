var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/retry.ts
var retry_exports = {};
__export(retry_exports, {
  AutoRetryScheduler: () => AutoRetryScheduler,
  isKeepTextRetry: () => isKeepTextRetry,
  isRestartPlan: () => isRestartPlan,
  isResumePlan: () => isResumePlan,
  planRetry: () => planRetry,
  resetStreamForRetry: () => resetStreamForRetry,
  resolveRestartUser: () => resolveRestartUser,
  shouldIgnoreLateRetryEvent: () => shouldIgnoreLateRetryEvent,
  shouldPreserveWork: () => shouldPreserveWork
});
function resolveRestartUser(messages, id) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return null;
  if (msg.role === "user") return msg.content.trim() ? msg : null;
  const idx = messages.findIndex((m) => m.id === id);
  const prev = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
  if (!prev || !prev.content.trim()) return null;
  return prev;
}
function isResumePlan(plan) {
  return plan?.action === "resume";
}
function isRestartPlan(plan) {
  return plan?.action === "restart";
}
function shouldPreserveWork(action) {
  return action === "resume";
}
function findFailedAssistant(messages, userMsgId) {
  const idx = messages.findIndex((m) => m.id === userMsgId);
  if (idx === -1) return void 0;
  return messages.slice(idx + 1).find(
    (m) => m.role === "assistant" && (m.retry || m.error || typeof m.content === "string" && m.content.includes("[Interrupted before finishing"))
  );
}
function planRetry(messages, userMsgId, source) {
  const msg = messages.find((m) => m.id === userMsgId);
  if (!msg || msg.role !== "user" || !msg.content.trim()) return null;
  if (source === "banner") {
    const failed2 = findFailedAssistant(messages, userMsgId);
    const target2 = {
      userMsgId,
      continueAssistantId: failed2?.id,
      content: msg.content,
      attachments: msg.attachments ?? [],
      images: msg.images ?? []
    };
    return { action: "resume", target: target2 };
  }
  const target = {
    userMsgId,
    content: msg.content,
    attachments: msg.attachments ?? [],
    images: msg.images ?? []
  };
  return { action: "restart", target };
}
function resetStreamForRetry(content, segments, mode = "resume") {
  if (mode === "restart") {
    const kept2 = (segments ?? []).filter((s) => s.kind === "user" || s.kind === "compact");
    return { content: "", segments: kept2 };
  }
  const kept = (segments ?? []).filter((s) => s.kind !== "text");
  return { content: "", segments: kept };
}
function isKeepTextRetry(reconnecting, fallback) {
  return reconnecting === true || fallback === true;
}
function shouldIgnoreLateRetryEvent(stopped) {
  return stopped;
}
var AutoRetryScheduler;
var init_retry = __esm({
  "src/lib/retry.ts"() {
    "use strict";
    AutoRetryScheduler = class {
      constructor(setTimer = (cb, ms) => setTimeout(cb, ms), clearTimerFn = (id) => clearTimeout(id)) {
        this.setTimer = setTimer;
        this.clearTimerFn = clearTimerFn;
      }
      setTimer;
      clearTimerFn;
      epoch = 0;
      stopped = false;
      timer = null;
      /** True after an explicit Stop, until the next turn begins. */
      get isStopped() {
        return this.stopped;
      }
      /** Arm `cb` after `delayMs`; dropped when Stop/a new turn bumps the epoch. */
      schedule(delayMs, cb) {
        this.clearPending();
        const epoch = this.epoch;
        this.timer = this.setTimer(() => {
          this.timer = null;
          if (epoch !== this.epoch) return;
          cb();
        }, delayMs);
      }
      /** A new turn started: invalidate stale schedules, allow retries again. */
      beginTurn() {
        this.stopped = false;
        this.epoch += 1;
        this.clearPending();
      }
      /** Explicit Stop: drop pending retries and invalidate armed callbacks. */
      stop() {
        this.stopped = true;
        this.epoch += 1;
        this.clearPending();
      }
      clearPending() {
        if (this.timer !== null) {
          this.clearTimerFn(this.timer);
          this.timer = null;
        }
      }
    };
  }
});

// tests/retryStream.test.ts
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
  localStorage: { getItem: () => null, setItem: () => {
  }, removeItem: () => {
  } }
};
globalThis.localStorage = globalThis.window.localStorage;
var { resetStreamForRetry: resetStreamForRetry2 } = await Promise.resolve().then(() => (init_retry(), retry_exports));
var failed = 0;
var check = (n, c, e) => {
  c ? console.log(`  \u2705 ${n}`) : (failed++, console.error(`  \u274C ${n}`, e ?? ""));
};
console.log("resetStreamForRetry: \u067E\u0627\u06A9\u200C\u06A9\u0631\u062F\u0646 \u0645\u062A\u0646 \u0646\u06CC\u0645\u0647\u200C\u06A9\u0627\u0631\u0647\u060C \u062D\u0641\u0638 tool/user:");
{
  const segs = [
    { kind: "text", text: "\u0633\u0644\u0627\u0645 \u0645\u0646 \u062F\u0627\u0631\u0645 " },
    { kind: "tool", index: 0 },
    { kind: "text", text: "\u0641\u0644\u0627\u0646 \u06A9\u0627\u0631 \u0631\u0627 " },
    { kind: "user", id: "u1" }
  ];
  const r = resetStreamForRetry2("\u0633\u0644\u0627\u0645 \u0645\u0646 \u062F\u0627\u0631\u0645 \u0641\u0644\u0627\u0646 \u06A9\u0627\u0631 \u0631\u0627 ", segs);
  check("content \u062E\u0627\u0644\u06CC \u0634\u062F", r.content === "", r);
  check("\u0641\u0642\u0637 text\u0647\u0627 \u062D\u0630\u0641 \u0634\u062F\u0646\u062F", r.segments.length === 2, r.segments);
  check("tool \u062D\u0641\u0638 \u0634\u062F", r.segments[0]?.kind === "tool", r.segments);
  check("user \u062D\u0641\u0638 \u0634\u062F", r.segments[1]?.kind === "user", r.segments);
}
console.log("resetStreamForRetry: \u0648\u0642\u062A\u06CC segments \u062E\u0627\u0644\u06CC \u0628\u0627\u0634\u062F\u060C \u0641\u0642\u0637 content \u0631\u06CC\u0633\u062A \u0645\u06CC\u200C\u0634\u0648\u062F:");
{
  const r = resetStreamForRetry2("\u0645\u062A\u0646 \u0628\u062F\u0648\u0646 segment", void 0);
  check("content \u062E\u0627\u0644\u06CC \u0634\u062F", r.content === "", r);
  check("segments \u0622\u0631\u0627\u06CC\u0647 \u062E\u0627\u0644\u06CC \u0634\u062F", Array.isArray(r.segments) && r.segments.length === 0, r.segments);
}
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
process.exit(0);
