import type { DiffStats, SidecarEvent, ToolActivity } from "../types";

/** شمارش +N -M را از رشته‌ی unified diff استخراج می‌کند (خطوط +++/--- نادیده گرفته می‌شوند). */
export function diffStatsFromUnified(diff: string): DiffStats {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
}

/**
 * جمع +N -M سطح یک ترن را از روی فعالیت‌های edit_file/write_file حساب می‌کند
 * (برای هدر Review به سبک کدکس). فقط ابزارهایی که در buildReviewTurn لیست
 * می‌شوند شمرده می‌شوند تا عدد هدر با جمع فایل‌های لیست یکی باشد؛
 * فعالیت‌های بدون diff نادیده گرفته می‌شوند.
 */
export function aggregateTurnStats(activities: ToolActivity[]): DiffStats {
  let adds = 0;
  let dels = 0;
  const walk = (list: ToolActivity[]) => {
    for (const a of list) {
      if (
        (a.tool === "edit_file" || a.tool === "write_file") &&
        a.diff
      ) {
        const s = a.diffStats ?? diffStatsFromUnified(a.diff);
        adds += s.adds;
        dels += s.dels;
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  return { adds, dels };
}

/**
 * Pure helpers for folding tool / sub-agent events into the `toolActivity`
 * timeline. Kept free of React/store state so they can be unit-tested in
 * isolation (see tests/toolNesting.test.ts).
 *
 * Sub-agent (explore/task) events carry a `branch` id and must nest under that
 * branch's OWN card. A sub-event must resolve/attach based on `branch` (and its
 * per-call `call_id`) EVEN WHEN the parent task card is already `"done"` — see
 * `resolveToolResult` below.
 */

/** Build a fresh "running" tool card from a `tool` event. */
export function makeToolActivity(event: SidecarEvent): ToolActivity {
  return {
    tool: event.tool ?? "tool",
    args: event.args,
    status: "running",
    startedAt: Date.now(),
    // Prefer the provider-native string id when present (Anthropic tool_use.id,
    // OpenAI tool_call_id). Falls back to the LangChain numeric call_id so the
    // existing sub-agent pairing still works. See SidecarEvent.call_id and
    // SidecarEvent.id.
    callId:
      (typeof event.id === "string" && event.id) ||
      (typeof event.call_id === "number" ? event.call_id : undefined),
    sub: event.sub,
    branch: typeof event.branch === "number" ? event.branch : undefined,
    model: event.model || undefined,
  };
}

/**
 * Fold a `tool` event into the activity list. Sub-agent tool calls nest INSIDE
 * the matching `task` card (by `branch`), regardless of that card's status —
 * a late sub-tool that arrives after the parent resolved must still be nested,
 * not dropped.
 *
 * Dedupes: a tool event whose ``callId`` (or provider-native ``id``) already
 * has a matching card is a re-emit (the stream list-parts and the tool
 * callback can both surface the same call). The existing card is updated in
 * place instead of appended, so a duplicate "I'll search" pair doesn't render
 * as two stacked tool cards in the timeline.
 */
export function applyToolEvent(
  activities: ToolActivity[],
  event: SidecarEvent,
): ToolActivity[] {
  const act = makeToolActivity(event);
  // De-dup key: prefer provider-native id (string), fall back to call_id.
  // Bump the key in one place so nested-sub matching below stays in sync.
  const dedupKey = act.callId;
  const findExisting = (
    list: ToolActivity[],
  ): { idx: number; existing: ToolActivity } | null => {
    if (dedupKey === undefined) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].callId === dedupKey) return { idx: i, existing: list[i] };
    }
    return null;
  };
  if (event.sub) {
    const branch = typeof event.branch === "number" ? event.branch : undefined;
    let matched = false;
    // Legacy events without a branch id belong to the most recent task card
    // only — nesting them into EVERY task card duplicated the same sub-tool
    // across parallel explores.
    let lastTaskIdx = -1;
    if (branch === undefined) {
      for (let i = 0; i < activities.length; i++) {
        if (activities[i].tool === "task") lastTaskIdx = i;
      }
    }
    const next = activities.map((a, idx) => {
      if (a.tool === "task") {
        // Parallel fan-out: nest each branch's sub-events under ITS OWN task
        // card. Legacy single-branch events (no branch id) nest into the task
        // card. Match regardless of status so a done parent still receives its
        // late children.
        if (branch !== undefined) {
          if (a.branch !== branch) return a;
        } else if (idx !== lastTaskIdx) {
          return a;
        }
        matched = true;
        const childList = a.children ?? [];
        // De-dup a sub-event whose callId is already on the card.
        const dup = findExisting(childList);
        if (dup) {
          const merged: ToolActivity = {
            ...dup.existing,
            // The re-emit may carry a richer status/args (e.g. the tool
            // callback arrives AFTER the stream part), so prefer non-empty
            // values from the incoming event.
            args: act.args ?? dup.existing.args,
            model: act.model ?? dup.existing.model,
          };
          const nextChildren = childList.slice();
          nextChildren[dup.idx] = merged;
          return { ...a, children: nextChildren };
        }
        return { ...a, children: [...childList, act] };
      }
      return a;
    });
    if (matched) return next;
    // Orphan sub-event: no task card (or no matching branch) exists — e.g.
    // the parent card was trimmed, deduped, or never streamed. Dropping it
    // here made the tool appear in the trace (unconditional trace write) but
    // vanish from chat. Promote it to a top-level card so chat never loses a
    // tool the trace shows.
    const dupTop = findExisting(next);
    if (dupTop) {
      const merged: ToolActivity = {
        ...dupTop.existing,
        args: act.args ?? dupTop.existing.args,
        model: act.model ?? dupTop.existing.model,
      };
      const arr = next.slice();
      arr[dupTop.idx] = merged;
      return arr;
    }
    return [...next, act];
  }
  // Top-level path: drop the duplicate if the same callId is already there.
  const dup = findExisting(activities);
  if (dup) {
    const merged: ToolActivity = {
      ...dup.existing,
      args: act.args ?? dup.existing.args,
      model: act.model ?? dup.existing.model,
    };
    const next = activities.slice();
    next[dup.idx] = merged;
    return next;
  }
  return [...activities, act];
}

/**
 * Fold a `tool_result` event into the activity list. A sub-agent result
 * resolves its target by `call_id` or `branch` — and unlike top-level results
 * it does NOT require the target to still be `"running"`. That is what keeps a
 * sub-result from being silently dropped when the parent branch card (or its
 * nested child) is already `"done"`.
 *
 * The `event.sub && isTop` guard deliberately skips matching the top-level
 * branch card itself: resolving a sub-result there would flip a still-running
 * branch card to `"done"` on its FIRST sub-search (the "parallel explores
 * freeze / only one comes" bug). Sub-results only ever attach to nested
 * children, matched by `branch` (now without requiring `act.tool === "task"`,
 * so grep/glob/read children resolve too).
 */
export function resolveToolResult(
  activities: ToolActivity[],
  event: SidecarEvent,
): ToolActivity[] {
  const now = Date.now();
  const gotId = typeof event.call_id === "number";
  const gotBranch = typeof event.branch === "number";
  const sub = event.sub === true;

  const resolved = (act: ToolActivity, isTop: boolean): ToolActivity => {
    // Sub-results never resolve the top-level branch card directly (only its
    // nested children), so a still-running card isn't marked done prematurely.
    // Exception: an orphan sub-event promoted to a top-level card (no parent
    // task card) carries `sub=true` itself — it must resolve by id like any
    // other card, otherwise the promoted card stays "running" forever.
    if (sub && isTop && act.sub !== true) {
      if (act.children && act.children.length > 0) {
        const children = act.children.map((c) => resolved(c, false));
        if (children.some((c, i) => c !== act.children![i])) {
          return { ...act, children };
        }
      }
      return act;
    }

    // Resolve by provider-native id (``event.id``) when present — Anthropic /
    // Gemini stream that as a string, so a numeric-only match would miss. Falls
    // back to the LangChain numeric ``call_id`` to keep the existing sub-agent
    // pairing working.
    const idMatch =
      (typeof event.id === "string" &&
        event.id !== "" &&
        act.callId === event.id) ||
      (gotId && (sub || act.status === "running") && act.callId === event.call_id);
    // Sub-results attach regardless of status; top-level results keep requiring
    // a still-running target (existing behaviour).
    const target = idMatch;
    const branchMatch = gotBranch && act.branch === event.branch;
    const fallback =
      !gotId &&
      !gotBranch &&
      typeof event.id !== "string" &&
      act.tool === event.tool &&
      (sub || act.status === "running");

    if (target || branchMatch || fallback) {
      return {
        ...act,
        status:
          event.status === "error"
            ? "error"
            : event.status === "denied"
              ? "denied"
              : "done",
        summary: event.summary,
        engine: event.engine,
        items: event.results,
        model: event.model || act.model,
        elapsedMs: now - (act.startedAt ?? now),
      };
    }
    if (act.children && act.children.length > 0) {
      const children = act.children.map((c) => resolved(c, false));
      if (children.some((c, i) => c !== act.children![i])) {
        return { ...act, children };
      }
    }
    return act;
  };

  return activities.map((a) => resolved(a, true));
}

/** Extract plain terminal text from tool result rows (`results`/`items`).
 *  `run_terminal` emits `[{content: "$ cmd\nEXIT CODE: …\n…"}]` — no
 *  `file`/`path`/`url` fields — so `FileResultLinks`/`WebResultLinks` render
 *  nothing. This helper reads `content`/`snippet`/`text` first and falls back
 *  to the other row fields, so RESULTS never stays empty. */
export function terminalOutputText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  const parts: string[] = [];
  for (const row of items as Array<Record<string, unknown>>) {
    if (!row || typeof row !== "object") continue;
    const value =
      row.content ?? row.snippet ?? row.text ?? row.title ?? row.url ?? row.path ?? row.file;
    if (value !== undefined && value !== null && String(value) !== "") {
      parts.push(String(value));
    }
  }
  return parts.join("\n");
}

/**
 * Force all "running" cards (including nested children) to "done" with an
 * elapsed time. Used by `resolveStuckCards` in Chat.tsx when a stream ends
 * without a `tool_result` for every started card (backend crash, stop,
 * reconnect, lost SSE). Recursion is needed because sub-agent task cards
 * nest grep/read children that also get stuck at "running" status.
 */
export function resolveStuckActivities(
  activities: ToolActivity[],
  now: number = Date.now(),
): ToolActivity[] {
  const resolve = (a: ToolActivity): ToolActivity => {
    const children = a.children?.map(resolve);
    const childrenChanged =
      children && a.children && children.some((c, i) => c !== a.children![i]);
    if (a.status === "running") {
      return {
        ...a,
        status: "done" as const,
        elapsedMs: now - (a.startedAt ?? now),
        ...(childrenChanged ? { children } : {}),
      };
    }
    return childrenChanged ? { ...a, children } : a;
  };
  return activities.map(resolve);
}
