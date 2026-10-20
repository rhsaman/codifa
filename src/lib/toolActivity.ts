import type { DiffStats, SearchResultItem, SidecarEvent, ToolActivity } from "../types";

/** Extract the +N / -M tally from a unified diff string (the `+++` / `---`
 *  file-header lines are skipped). */
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
 * Turn-level +N / -M tally over the edit_file/write_file activities (the
 * Codex-style Review header). Only the tools buildReviewTurn lists are
 * counted, so the header total always matches the listed files; activities
 * without a diff are skipped.
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
 * Sub-agent (explore) events carry a `branch` id and must nest under that
 * branch's OWN card. A sub-event must resolve/attach based on `branch` (and its
 * per-call `call_id`) EVEN WHEN the parent card is already `"done"` — see
 * `resolveToolResult` below.
 */

/** Canonical tool name for one card. The explore sub-agent used to be recorded
 *  under the name `task` (and `subagent`); both are folded into `explore` so
 *  every `tool ===` comparison, the label/icon maps and the backend history
 *  payload see ONE name. Applied at the two ingest points: `makeToolActivity`
 *  (live stream) and the store's load migration (pre-rename transcripts). */
export function normalizeToolName(tool?: string): string {
  const t = tool ?? "tool";
  return t === "task" || t === "subagent" ? "explore" : t;
}

/** Recursively normalize a card and its nested children (one-time, on load). */
export function normalizeToolActivity(acts: ToolActivity[]): ToolActivity[] {
  return acts.map((a) => {
    const out: ToolActivity = a.tool === "explore" ? a : { ...a, tool: normalizeToolName(a.tool) };
    if (Array.isArray(out.children)) out.children = normalizeToolActivity(out.children);
    return out;
  });
}

/** Build a fresh "running" tool card from a `tool` event. */
export function makeToolActivity(event: SidecarEvent): ToolActivity {
  return {
    tool: normalizeToolName(event.tool),
    args: event.args,
    // Some backends put the change on the tool event itself (the tool callback
    // can arrive before the dedicated `diff` event), so carry it over here
    // instead of losing the edit until a second event shows up.
    summary: event.summary,
    diff: event.diff,
    diffStats: event.diff ? diffStatsFromUnified(event.diff) : undefined,
    checkpoint: event.checkpoint,
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
    // The backend ships the structured web rows (`results`) on the tool_result
    // event. Carrying them over at creation time means a card that is created
    // from a finished event (replayed transcript, or a provider that emits the
    // rows on the start event) never loses its render payload.
    results: asResultRows(event.results as unknown as SearchResultItem[]),
    engine: event.engine,
    resultText: typeof event.result === "string" ? event.result : undefined,
  };
}

/** Fold a re-emitted card into the card already on the timeline. The later
 *  event may carry richer fields (the tool callback arrives after the stream
 *  part, or the `diff` event merged in Chat.tsx lands separately), so every
 *  field prefers the incoming value and falls back to the stored one. Keeping
 *  `diff`/`diffStats`/`checkpoint`/`summary` alive across re-emits is what
 *  lets Review show the change instead of "No changes in this turn." */
function mergeReEmit(existing: ToolActivity, incoming: ToolActivity): ToolActivity {
  return {
    ...existing,
    args: incoming.args ?? existing.args,
    model: incoming.model ?? existing.model,
    summary: incoming.summary ?? existing.summary,
    diff: incoming.diff ?? existing.diff,
    diffStats: incoming.diffStats ?? existing.diffStats,
    checkpoint: incoming.checkpoint ?? existing.checkpoint,
    // A re-emitted start event must not wipe the rows a previous result event
    // already produced — the model still needs the links on screen.
    items: incoming.items ?? existing.items,
    results: incoming.results ?? existing.results,
    resultText: incoming.resultText ?? existing.resultText,
    engine: incoming.engine ?? existing.engine,
    // The stream-part re-emit of a sub-agent card carries NO branch id (only
    // the backend's Branch-wrapped ToolStart does). Dropping the stored branch
    // here orphaned every later sub-event: they matched no card, got promoted
    // to top-level cards in the chat, and the Explore panel showed "No tool
    // calls". The branch must survive re-emits.
    branch: incoming.branch ?? existing.branch,
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
    // Legacy events without a branch id belong to the most recent sub-agent
    // card only — nesting them into EVERY such card duplicated the same
    // sub-tool across parallel explores.
    let lastTaskIdx = -1;
    if (branch === undefined) {
      for (let i = 0; i < activities.length; i++) {
        if (activities[i].tool === "explore") lastTaskIdx = i;
      }
    }
    const next = activities.map((a, idx) => {
      if (a.tool === "explore") {
        // Parallel fan-out: nest each branch's sub-events under ITS OWN card.
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
          // The re-emit may carry a richer status/args (e.g. the tool callback
          // arrives AFTER the stream part), so it wins field by field.
          const merged = mergeReEmit(dup.existing, act);
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
      const merged = mergeReEmit(dupTop.existing, act);
      const arr = next.slice();
      arr[dupTop.idx] = merged;
      return arr;
    }
    return [...next, act];
  }
  // Top-level path: drop the duplicate if the same callId is already there.
  const dup = findExisting(activities);
  if (dup) {
    const merged = mergeReEmit(dup.existing, act);
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
 * children, matched by `branch` (now without requiring a sub-agent tool name,
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
      // A sub-result belongs to ONE branch: another explore's card must not
      // look inside, or two parallel explores whose providers reuse tool-call
      // ids ("call_0") would resolve each other's children.
      if (gotBranch && act.branch !== undefined && act.branch !== event.branch) {
        return act;
      }
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
      (gotId &&
        (sub || act.status === "running" || WEB_TOOLS.has(act.tool)) &&
        act.callId === event.call_id);
    // Sub-results attach regardless of status; top-level results keep requiring
    // a still-running target (existing behaviour).
    const target = idMatch;
    // Branch matching is the legacy path for events that carry no id. An
    // event with a provider id resolves ONLY its own call: every child of an
    // explore shares the explore's branch, so matching on the branch alone
    // marked all of its still-running siblings done on the first result.
    const branchMatch =
      gotBranch && typeof event.id !== "string" && act.branch === event.branch;
    const fallback =
      !gotId &&
      !gotBranch &&
      typeof event.id !== "string" &&
      act.tool === event.tool &&
      (sub || act.status === "running" || WEB_TOOLS.has(act.tool));

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
        items:
          // Args-derived items FIRST: the native (Rust) result rows carry only
          // bare filenames, while the tool's own args hold the real (absolute)
          // path — event.results must not override them with unresolvable
          // names ("No file exists at this path" on click). Python-sidecar
          // events have no result string and fall through to event.results.
          // EXCEPTION: for the web tools the backend already sends the REAL
          // rows (search hits / the fetched page) in `event.results`, and the
          // result text is a DISTILLED answer with no links in it — so the
          // JSON payload wins and the filename scan is skipped entirely.
          // An older backend sent a single OBJECT for `fetch_url`; wrap it so a
          // stale/replayed transcript can never hand the renderer a non-array.
          (WEB_TOOLS.has(act.tool) ? asResultRows(event.results) : undefined) ??
          (typeof event.result === "string"
            ? (filesFromNativeResult(act.tool, event.result, act.args ?? event.args) as
                unknown as SearchResultItem[] | undefined)
            : undefined) ??
          asResultRows(event.results) ??
          // A repeated/late result event (a retry, or `resolveStuckActivities`
          // resolving the card a second time) carries no rows of its own — the
          // already-rendered links must survive instead of being replaced by
          // `undefined`, which made the results vanish from the card.
          act.items ??
          act.results,
        model: event.model || act.model,
        elapsedMs: now - (act.startedAt ?? now),
        // Text-output tools (LSP lookups, memory search) return prose with no
        // file paths, so `items` above stays empty — keep the raw text so the
        // card can render it instead of showing nothing.
        resultText:
          typeof event.result === "string" && TEXT_RESULT_TOOLS.has(act.tool)
            ? event.result
            : act.resultText,
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

/** Tools whose native result is plain prose with no file paths (LSP lookups,
 *  memory search, explore reports) — plus `read`, whose result is the file
 *  content itself. `filesFromNativeResult` returns null for the prose tools, so
 *  their text is kept verbatim in `ToolActivity.resultText` and rendered as-is;
 *  without this the whole result was dropped and the card showed no output at
 *  all. For explore this text is also the ONLY record of the findings: the
 *  backend's history recap reads `resultText` to tell the next turn what was
 *  already researched (see history_recap in agent.rs), so dropping it made the
 *  main agent re-delegate the same question.
 *
 *  `read` is the special case: `filesFromNativeResult` DOES give it a chip (the
 *  path), but only the path — the window it returned is nowhere else in the
 *  activity, so a read row in the explore panel expanded to nothing. Keep the
 *  text and let the renderers drop the redundant path chip when both exist. */
export const TEXT_RESULT_TOOLS = new Set([
  "find_symbol",
  "lsp_symbols",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_diagnostics",
  "search_memory",
  "save_memory",
  "explore",
  "read",
]);

/** Tools whose result rows come from the BACKEND as structured JSON
 *  (`event.results`) rather than from a filename scan of the result text. A
 *  `web_search` answer is DISTILLED prose with no links in it, so the scan
 *  would find nothing and the card would lose its result list. */
export const WEB_TOOLS = new Set(["web_search", "fetch_url"]);

/** Normalise a web tool's structured rows to an ARRAY.
 *
 *  `web_search` sends an array of hits; an earlier `fetch_url` sent a single
 *  object for the one fetched page, which made the shared `WebResultLinks`
 *  renderer (a `.map` over the rows) show nothing and left a latent
 *  `items.map is not a function` for any future unguarded consumer. Old
 *  transcripts are replayed through here too, so the renderer can rely on the
 *  array shape unconditionally. */
function asResultRows(
  results: SearchResultItem[] | Record<string, unknown> | undefined,
): SearchResultItem[] | undefined {
  if (!results) return undefined;
  if (Array.isArray(results)) return results;
  if (typeof results === "object") return [results as unknown as SearchResultItem];
  return undefined;
}

/** Extract file rows from a native (Rust) tool's plain-text result so the UI
 *  renders clickable file chips (icon + basename) instead of a raw text dump.
 *  File-targeting tools take the path from their args (read's result IS the
 *  file content); grep/glob/LSP outputs are scanned for path-like tokens. */
export function filesFromNativeResult(
  tool: string,
  result: string,
  args?: Record<string, unknown>,
): Array<Record<string, unknown>> | null {
  if (!result) return null;
  // read accepts BOTH shapes: a single filePath string and a filePaths
  // array (the batch form the model actually sends — see the Read File
  // cards). Only the string was read before, so batch reads produced no
  // argPath and the chip fell back to a bare filename from the result
  // text, which the viewer could not resolve ("No file exists").
  const argList: string[] = Array.isArray(args?.filePaths)
    ? (args?.filePaths as unknown[]).map(String)
    : [];
  const argPath = String(args?.filePath ?? args?.path ?? argList[0] ?? "");
  if (tool === "read" || tool === "write_file" || tool === "edit_file") {
    if (argList.length > 1) return argList.map((f) => ({ file: f }));
    return argPath ? [{ file: argPath }] : null;
  }
  // Textual tools whose result is not a file listing. Memory results are
  // prose/snippets — a filename regex-scaned out of them must not become a
  // chip that hides the actual memory text.
  if (
    tool === "run_terminal" ||
    tool === "explore" ||
    tool === "search_memory" ||
    tool === "save_memory"
  )
    return null;
  const re = /((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?/g;
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  // The scope the tool ran in (args.path) — bare filenames found in the
  // result are resolved against it so the chip opens the real file.
  const scopeDir = String(args?.path ?? args?.filePath ?? "").replace(/\/+$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(result)) !== null && out.length < 50) {
    let file = m[1];
    // Skip prose fragments like "e.g" — require a known code extension or a
    // directory component so only real paths become chips.
    if (
      !file.includes("/") &&
      !/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|json|toml|md|css|scss|html|yaml|yml|txt|sh|go|java|rb|php|c|cpp|h|hpp|sql|lock|svg|png|jpg)$/i.test(file)
    )
      continue;
    // Absolute paths must keep their leading slash: the regex above strips
    // it, so "/Users/x/y.ts" became "Users/x/y.ts" which the viewer then
    // resolved against the workspace root and failed with "No file exists".
    if (result[m.index - 1] === "/") file = `/${file}`;
    // A bare filename ("store.ts") is only resolvable inside the tool's
    // scope directory — join it so the chip points at the real file.
    else if (!file.includes("/") && scopeDir) file = `${scopeDir}/${file}`;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({ file, line: m[2] ? Number(m[2]) : undefined });
  }
  return out.length > 0 ? out : null;
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

/** True when every row only carries the path the tool was GIVEN — no output of
 *  its own. `terminalOutputText` falls back to `row.file`, so such rows print
 *  the bare path as if it were the result: a `read` row showed its own filename
 *  and nothing else, which looked like the read had returned nothing. */
export function pathOnlyItems(items: unknown): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((row) => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    const body = r.content ?? r.snippet ?? r.text ?? r.title ?? r.url ?? r.path;
    return body === undefined || body === null || String(body) === "";
  });
}

/** Everything one tool call produced, as one block: search/terminal output, a
 *  diff, or prose/source text. `read` is the case this guards — it carries BOTH
 *  a path row (from its args) and the file window in `resultText`, so printing
 *  the rows first buried the content under a bare filename. */
export function toolCallBody(activity: ToolActivity): string {
  const parts: string[] = [];
  const items = activity.items ?? activity.results;
  if (!(activity.resultText && pathOnlyItems(items))) {
    const out = terminalOutputText(items);
    if (out) parts.push(out);
  }
  if (activity.diff) parts.push(activity.diff);
  if (activity.resultText) parts.push(activity.resultText);
  return parts.join("\n\n");
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
