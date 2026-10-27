import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";
import { useTracePanel, type TraceTab } from "../lib/tracePanel";
import { useViewerTabs } from "../lib/viewerTabs";
import { ViewerFullscreenButton } from "./ViewerFullscreenButton";
import { clearChatTraces, getChatTraces } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import type { TraceEntry } from "../types";
import { countOccurrences, countTraceEntryHits, stepHitIndex } from "../lib/diffSearch";

type ActiveRef = { current: HTMLElement | null };

const TABS: Array<[TraceTab, string]> = [
  ["all", "All"],
  ["llm", "LLM"],
  ["prompt", "Prompts"],
  ["tool", "Tools"],
  ["fold", "Folds"],
];

/** Only top-level tool calls count as tools so the Tools tab matches chat cards. Chat shows one card per tool invocation, while the trace stream holds a separate tool_result entry per call, so tool_result must not be counted or listed in the Tools tab. Sub-agent calls (detail.sub) are nested under the parent card in chat, so they are excluded as well. */
export function isToolTraceKind(kind: string): boolean {
  return kind === "tool";
}

export function isSubToolTrace(entry: TraceEntry): boolean {
  return Boolean((entry.detail as Record<string, unknown> | undefined)?.sub);
}

/** Pure tab counts for tests: All counts every entry, Tools counts only top-level tool calls (sub-agent trace views include their own sub tools). */
export function getTraceTabCounts(entries: TraceEntry[], includeSub = false): Record<string, number> {
  const c: Record<string, number> = { all: entries.length, llm: 0, prompt: 0, tool: 0, fold: 0 };
  for (const e of entries) {
    const raw = e.kind as string;
    if (raw === "tool") {
      if (!includeSub && isSubToolTrace(e)) continue;
      c.tool += 1;
    } else if (raw in c) {
      c[raw] += 1;
    }
  }
  return c;
}

/** خلاصه تمیز یک ورودی برای ردیف تاشو — fallback وقتی summary خالی است. */
export function traceRowTitle(entry: TraceEntry): string {
  if ((entry.summary || "").trim()) return entry.summary;
  if (entry.kind === "llm") return `${entry.model || "llm"} · ${entry.tokens?.total ?? 0} tokens`;
  if (entry.kind === "prompt") return `prompt · ${(entry.prompt || "").length} chars`;
  if ((entry.kind as string) === "fold") {
    const d = (entry.detail as Record<string, unknown> | undefined) || {};
    return `fold · ${d.folded ?? "?"} result(s), ${d.removed_chars ?? 0} chars out`;
  }
  if (entry.kind === "tool" || (entry.kind as string) === "tool_result") {
    const name = String((entry.detail as Record<string, unknown> | undefined)?.name || entry.model || "tool");
    return name;
  }
  return "trace entry";
}

/** فیلتر لاگ‌ها با کوئری جست‌وجو (خلاصه + پرامپت + پاسخ + جزئیات). خالص برای تست. */
export function filterTraces(entries: TraceEntry[], query: string): TraceEntry[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const hay = `${e.summary || ""}\n${e.prompt || ""}\n${(e as { result?: string }).result || ""}\n${e.model || ""}\n${e.error || ""}\n${JSON.stringify(e.detail ?? {})}`.toLowerCase();
    return hay.includes(q);
  });
}

/** یک ورودی تریس به متن ساده برای کپی — عنوان، متا، پرامپت/نتیجه و جزئیات. خالص برای تست. */
export function formatTraceEntryAsText(entry: TraceEntry): string {
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const lines = [`[${timeLabel(entry.at)}] ${entry.kind.toUpperCase()} ${traceRowTitle(entry)}`];
  const meta: string[] = [];
  if (typeof entry.turn === "number" && Number.isFinite(entry.turn) && Number(entry.turn) > 0)
    meta.push(`turn=${Number(entry.turn)}`);
  if (entry.model) meta.push(`model=${entry.model}`);
  if (entry.tokens?.total) meta.push(`tokens=${entry.tokens.total}`);
  if (typeof detail.step === "number") meta.push(`step=${Number(detail.step)}`);
  const status = String(detail.status || (entry.error ? "error" : "") || "");
  if (status) meta.push(`status=${status}`);
  if (meta.length > 0) lines.push(`  ${meta.join(" · ")}`);
  if (entry.error) lines.push(`  error: ${entry.error}`);
  if (entry.prompt) lines.push(`  prompt:\n${entry.prompt}`);
  const result = String((entry as { result?: string }).result || "");
  if (result) lines.push(`  result:\n${result}`);
  // An empty detail object is noise — only print it when it carries data.
  const detailKeys = Object.keys(entry.detail ?? {});
  if (!entry.prompt && !result && detailKeys.length > 0) lines.push(`  detail: ${JSON.stringify(entry.detail)}`);
  return lines.join("\n");
}

/** کل نمای فعلی (فیلترشده با تب/سرچ) به متن ساده برای کپی یک‌جا. خالص برای تست. */
export function formatTracesAsText(entries: TraceEntry[]): string {
  return entries.map(formatTraceEntryAsText).join("\n\n");
}

/** One turn group as plain text for per-turn copy — header + entries. Pure. */
export function formatTurnAsText(
  turn: number | null,
  inferred: number,
  entries: TraceEntry[],
): string {
  const label = turn !== null ? `Turn ${turn}` : `Turn ${inferred}`;
  const preview = turnUserPreview(entries);
  const head = preview ? `${label}: ${preview}` : label;
  const body = formatTracesAsText(entries);
  return body ? `${head}\n${body}` : head;
}

/** زمان نمایشی کوتاه (HH:MM:SS). */
function timeLabel(at: number): string {
  try {
    const d = new Date((at || 0) * 1000);
    return d.toLocaleTimeString();
  } catch {
    return "";
  }
}

/** هایلایت رخدادهای کوئری داخل متن — مثل دیف با رخداد فعال و اسکرول خودکار. */
function highlightHits(
  text: string,
  query: string,
  base = -1,
  active = -1,
  activeRef?: ActiveRef,
): React.ReactNode {
  const q = (query || "").trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  let ordinal = 0;
  const navigable = base >= 0 && active >= 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    const idx = navigable ? base + ordinal : -1;
    ordinal++;
    const isActive = navigable && idx === active;
    parts.push(
      <mark
        key={key++}
        className={isActive ? "trace-hit trace-hit-active" : "trace-hit"}
        {...(isActive ? { "aria-current": "true" as const } : {})}
        ref={
          isActive && activeRef
            ? (el: HTMLElement | null) => {
                activeRef.current = el;
              }
            : undefined
        }
      >
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
    if (parts.length > 200) {
      parts.push(text.slice(i));
      break;
    }
  }
  return <>{parts}</>;
}

/** دکمه کپی مطمئن (الکترون + وب + fallback) با فیدبک Copied. */
function CopyButton({ text, label, title }: { text: string; label: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const hint = title ?? (typeof label === "string" ? label : "Copy");
  return (
    <button
      type="button"
      className="trace-copy-btn"
      title={hint}
      aria-label={hint}
      onClick={(e) => {
        e.stopPropagation();
        void (async () => {
          const ok = await copyToClipboard(text);
          if (ok) {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          }
        })();
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/** دکمه کپی نمای فعلی تریس (با تب/سرچ فیلترشده) — بدون فیلتر همه، با فیلتر فقط همان‌ها. */
function CopyTracesButton({ entries, query, tab }: { entries: TraceEntry[]; query: string; tab: TraceTab }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const filtered = query.trim() !== "" || tab !== "all";
  const title = entries.length === 0
    ? "Nothing to copy"
    : filtered
      ? `Copy filtered traces (${entries.length})`
      : `Copy all traces (${entries.length})`;
  return (
    <button
      type="button"
      className="review-header-btn"
      title={title}
      aria-label={title}
      disabled={entries.length === 0}
      onClick={() => {
        void (async () => {
          const ok = await copyToClipboard(formatTracesAsText(entries));
          if (ok) {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          }
        })();
      }}
    >
      {copied ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

/** بلوک متن (پرامپت/پاسخ/آرگومان) با لیبل، کپی و هایلایت سرچ. */
function TextBlock({
  label,
  text,
  query,
  kind,
  hitBase = -1,
  activeHit = -1,
  activeRef,
}: {
  label: string;
  text: string;
  query?: string;
  kind: "prompt" | "result" | "json";
  hitBase?: number;
  activeHit?: number;
  activeRef?: ActiveRef;
}) {
  if (!text) return null;
  return (
    <div className="trace-prompt-block" dir="ltr">
      <div className="trace-prompt-actions">
        <span className="trace-block-label">{label}</span>
        <CopyButton text={text} label="Copy" />
      </div>
      <pre className={kind === "json" ? "trace-detail-json" : "trace-prompt-text"}>
        {query?.trim() ? highlightHits(text, query, hitBase, activeHit, activeRef) : text}
      </pre>
    </div>
  );
}

/** Step number of an entry (from detail.step) — shown as a chip on the row. */
export function traceStep(entry: TraceEntry): number | null {
  const s = (entry.detail as Record<string, unknown> | undefined)?.step;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** Chat turn number of an entry (from entry.turn) — basis for turn grouping. */
export function traceTurn(entry: TraceEntry): number | null {
  const t = (entry as { turn?: unknown }).turn;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
}

/** Group entries (chronological, oldest first) by chat turn.
 *  Entries with a known turn group by it; legacy entries without a turn
 *  start a new inferred group on each prompt entry. Pure, for tests. */
export function groupTracesByTurn(
  entries: TraceEntry[],
): Array<{ turn: number | null; inferred: number; entries: TraceEntry[] }> {
  const groups: Array<{ turn: number | null; inferred: number; entries: TraceEntry[] }> = [];
  let inferred = 0;
  for (const e of entries) {
    const t = traceTurn(e);
    const last = groups[groups.length - 1];
    if (t !== null) {
      if (last && last.turn === t) last.entries.push(e);
      else {
        inferred += 1;
        groups.push({ turn: t, inferred, entries: [e] });
      }
    } else {
      // Legacy entry without turn: a prompt entry starts a new turn.
      if (last && last.turn === null && e.kind !== "prompt") last.entries.push(e);
      else {
        inferred += 1;
        groups.push({ turn: null, inferred, entries: [e] });
      }
    }
  }
  return groups;
}

/** Short user-text preview for a turn group, from its prompt entry. */
export function turnUserPreview(entries: TraceEntry[]): string {
  const p = entries.find((e) => e.kind === "prompt");
  const full = (p?.prompt || "").trim();
  if (!full) {
    const first = (entries[0]?.summary || "").trim();
    return first.slice(0, 100);
  }
  const marker = "[user]";
  const idx = full.lastIndexOf(marker);
  const userText = (idx >= 0 ? full.slice(idx + marker.length) : full).trim().replace(/\s+/g, " ");
  return userText.slice(0, 120);
}

/** Searchable parts of an entry — same order as `TraceRow` renders. */
export function traceEntrySearchParts(entry: TraceEntry): {
  title: string;
  prompt: string;
  result: string;
  detailJson: string;
} {
  const title = traceRowTitle(entry);
  const prompt = entry.prompt || "";
  const result = String((entry as { result?: string }).result || "");
  // An empty detail object is noise — hide it instead of rendering "{}".
  const detailJson =
    !prompt && !result && Object.keys(entry.detail ?? {}).length > 0
      ? JSON.stringify(entry.detail, null, 2)
      : "";
  return { title, prompt, result, detailJson };
}

/** ردیف تاشوی یک ورودی لاگ — تک‌خطی فشرده چپ‌چین مثل لنگ‌اسمیت. */
export function TraceRow({
  entry,
  query,
  defaultOpen,
  hitBase = -1,
  activeHit = -1,
  activeRef,
}: {
  entry: TraceEntry;
  query?: string;
  defaultOpen?: boolean;
  hitBase?: number;
  activeHit?: number;
  activeRef?: ActiveRef;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const prompt = entry.prompt || "";
  const result = String((entry as { result?: string }).result || "");
  const status = String(detail.status || (entry.error ? "error" : "") || "").toLowerCase();

  // دیفالت بسته؛ فقط هنگام سرچ خودکار باز شود تا پرامپت/پاسخ دیده شود.
  // با پاک شدن سرچ به حالت دیفالت (بسته) برمی‌گردد.
  useEffect(() => {
    if (query?.trim()) setOpen(true);
    else setOpen(Boolean(defaultOpen));
  }, [query, defaultOpen]);

  const tokens = entry.tokens;
  const tokenTotal = tokens?.total ?? 0;
  const step = traceStep(entry);
  const title = traceRowTitle(entry);
  const q = (query || "").trim();
  const titleCount = q ? countOccurrences(title, q) : 0;
  const promptBase = hitBase >= 0 ? hitBase + titleCount : -1;
  const promptCount = q ? countOccurrences(prompt, q) : 0;
  const resultBase = promptBase >= 0 ? promptBase + promptCount : -1;
  const resultCount = q ? countOccurrences(result, q) : 0;
  const detailText =
    !prompt && !result && Object.keys(detail).length > 0
      ? JSON.stringify(detail, null, 2)
      : "";
  const detailBase = resultBase >= 0 ? resultBase + resultCount : -1;

  return (
    <div className={`trace-panel-item${open ? " open" : ""}`}>
      <button
        className={`trace-panel-row${open ? " selected" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`trace-panel-dot kind-${entry.kind}`} aria-hidden="true" />
        <span className={`trace-kind-badge kind-${entry.kind}`}>{entry.kind}</span>
        <span className="trace-panel-title" title={title}>
          {query?.trim()
            ? highlightHits(title, query, hitBase, activeHit, activeRef)
            : title}
        </span>
        {tokenTotal > 0 ? <span className="trace-meta-chip trace-panel-chip">{tokenTotal} tok</span> : null}
        {step !== null ? <span className="trace-meta-chip trace-panel-chip">step {step}</span> : null}
        {status ? <span className={`trace-status-chip status-${status}`}>{status}</span> : null}
        <span className="trace-panel-time">{timeLabel(entry.at)}</span>
        <span className="trace-panel-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="trace-row-body trace-panel-body">
          {entry.kind === "llm" && (
            <div className="trace-llm-meta">
              {entry.model ? <span className="trace-meta-chip">{entry.model}</span> : null}
              {tokens ? (
                <span className="trace-meta-chip">
                  in {tokens.input ?? 0} · out {tokens.output ?? 0} · total {tokens.total ?? 0}
                </span>
              ) : null}
              {detail.provider || detail.provider_id ? (
                <span className="trace-meta-chip">
                  {String(detail.provider_id || detail.provider || "")}
                </span>
              ) : null}
              {typeof detail.step === "number" ? (
                <span className="trace-meta-chip">
                  step {Number(detail.step)}
                  {typeof detail.steps_max === "number" ? `/${Number(detail.steps_max)}` : ""}
                </span>
              ) : null}
              {typeof detail.finish_reason === "string" && detail.finish_reason ? (
                <span className="trace-meta-chip">{String(detail.finish_reason)}</span>
              ) : null}
              {typeof detail.prompt_messages === "number" ? (
                <span className="trace-meta-chip">{Number(detail.prompt_messages)} msgs in</span>
              ) : null}
              {typeof detail.wire_tokens_est === "number" ? (
                <span className="trace-meta-chip">
                  ~{Number(detail.wire_tokens_est)} prompt tok
                </span>
              ) : null}
              {typeof detail.reply_chars === "number" && Number(detail.reply_chars) > 0 ? (
                <span className="trace-meta-chip">{Number(detail.reply_chars)} chars out</span>
              ) : null}
              {typeof detail.reasoning_chars === "number" && Number(detail.reasoning_chars) > 0 ? (
                <span className="trace-meta-chip">{Number(detail.reasoning_chars)} B thinking</span>
              ) : null}
              {Array.isArray(detail.tool_calls) && detail.tool_calls.length > 0 ? (
                <span className="trace-meta-chip">
                  → {(detail.tool_calls as unknown[]).map(String).join(", ")}
                </span>
              ) : null}
              {entry.error ? <span className="trace-meta-error">{entry.error}</span> : null}
            </div>
          )}
          {entry.kind === "tool" && (
            <div className="trace-llm-meta">
              {detail.name ? <span className="trace-meta-chip">{String(detail.name)}</span> : null}
              {entry.model ? <span className="trace-meta-chip">{entry.model}</span> : null}
              {typeof detail.step === "number" && Number(detail.step) > 0 ? (
                <span className="trace-meta-chip">step {Number(detail.step)}</span>
              ) : null}
              {typeof detail.result_chars === "number" ? (
                <span className="trace-meta-chip">{Number(detail.result_chars)} chars out</span>
              ) : null}
              {entry.error ? <span className="trace-meta-error">{entry.error}</span> : null}
            </div>
          )}
          {entry.kind === "prompt" && detail.mode ? (
            <div className="trace-llm-meta">
              <span className="trace-meta-chip">{String(detail.mode)}</span>
              <span className="trace-meta-chip">{(prompt || "").length} chars</span>
            </div>
          ) : null}
          {prompt ? (
            <TextBlock
              label={
                entry.kind === "tool"
                  ? "Args (prompt)"
                  : entry.kind === "llm"
                    ? "Prompt (sent to model)"
                    : "Prompt"
              }
              text={prompt}
              query={query}
              kind="prompt"
              hitBase={promptBase}
              activeHit={activeHit}
              activeRef={activeRef}
            />
          ) : null}
          {result ? (
            <TextBlock
              label={entry.kind === "tool" ? "Result" : "Response"}
              text={result}
              query={query}
              kind="prompt"
              hitBase={resultBase}
              activeHit={activeHit}
              activeRef={activeRef}
            />
          ) : null}
          {!prompt && !result && detailText ? (
            <pre className="trace-detail-json" dir="ltr">
              {query?.trim()
                ? highlightHits(detailText, query, detailBase, activeHit, activeRef)
                : detailText}
            </pre>
          ) : null}
          {!prompt && !result && !detailText ? (
            <div className="trace-empty-body">No prompt/response recorded for this entry.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Collapsible header for one chat turn — its traces listed flat below it. */
export function TraceTurnGroup({
  turn,
  inferred,
  entries,
  query,
  hitBases,
  activeHit = -1,
  activeRef,
  defaultOpen = true,
}: {
  turn: number | null;
  inferred: number;
  entries: TraceEntry[];
  query?: string;
  hitBases?: number[];
  activeHit?: number;
  activeRef?: ActiveRef;
  defaultOpen?: boolean;
}) {
  // Default open so traces stay visible; auto-open on search to show hits.
  const [open, setOpen] = useState(Boolean(defaultOpen));
  useEffect(() => {
    if (query?.trim()) setOpen(true);
    else setOpen(Boolean(defaultOpen));
  }, [query, defaultOpen]);
  const tokens = entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  const label = turn !== null ? `Turn ${turn}` : `Turn ${inferred}`;
  const copyText = useMemo(
    () => formatTurnAsText(turn, inferred, entries),
    [turn, inferred, entries],
  );
  return (
    <section className="trace-panel-step" aria-label={label}>
      <div className="trace-panel-step-head">
        <button
          type="button"
          className="trace-panel-step-toggle"
          aria-expanded={open}
          aria-label={`${label} — toggle traces`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="trace-panel-step-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="trace-panel-step-title">{label}</span>
          <span className="trace-panel-step-meta">
            {entries.length} events{tokens > 0 ? ` · ${tokens} tok` : ""}
          </span>
        </button>
        <CopyButton text={copyText} label="Copy" title={`Copy ${label} traces (${entries.length})`} />
      </div>
      {open && (
        <div className="trace-panel-step-rows">
          {entries.map((entry, i) => (
            <TraceRow
              key={entry.id}
              entry={entry}
              query={query}
              defaultOpen={false}
              hitBase={hitBases?.[i] ?? -1}
              activeHit={activeHit}
              activeRef={activeRef}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Chat trace panel — overlay over chat, flat trace list with filter tabs. */
/** How many entries one trace page holds. Sized from the real logs: a typical
 *  entry is 4-5 KB (worst case ~36 KB for a re-logged system prompt), so a page
 *  stays well under a megabyte while still filling the panel several times over.
 *  This mirrors the Rust default in `trace.rs`. */
const TRACE_PAGE = 200;

export function TracePanel(props?: {
  chatId?: string
  initialTab?: TraceTab
  docked?: boolean
  onClose?: () => void
  /** Background sub-agent job id: when set, shows only that job's trace. */
  taskId?: string
  /** Short label for a sub-agent trace tab (job description). */
  traceTitle?: string
}) {
  const docked = props?.docked ?? false
  const store = useTracePanel();
  const storeTab = store.tab
  const storeSetTab = store.setTab
  const storeClose = store.close
  const [dockedTab, setDockedTab] = useState<TraceTab>(props?.initialTab ?? 'all')
  const tab = docked ? dockedTab : storeTab
  const setTab = docked ? setDockedTab : storeSetTab
  const close = props?.onClose ?? storeClose
  const storeActiveChatId = useStore((s) => s.activeChatId);
  const activeChatId = props?.chatId ?? storeActiveChatId;
  const taskId = (props?.taskId ?? "").trim();
  const traceTitle = (props?.traceTitle ?? "").trim();
  const [fullscreen, setFullscreen] = useState(false);
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 720;
    const vw =
      typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1024;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:traceWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const fallback = Math.round(vw / 2) - 12;
    const n = Number.isFinite(saved) ? saved : fallback;
    return Math.max(320, Math.min(vw - 24, n));
  });
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Pagination: `entries` holds the newest page plus every older page the user
  // scrolled into. The whole log used to be fetched on every 2s poll — a long
  // chat's log is several MB (the system prompt is re-logged on every LLM call)
  // and the panel renders one screenful, so the rest was pure heap.
  const [olderLoading, setOlderLoading] = useState(false);
  // Whole-log totals + per-kind counts from the server: the tab badges must not
  // shrink just because only a page (or two) of entries is in memory.
  const [serverCounts, setServerCounts] = useState<{
    all: number;
    llm: number;
    prompt: number;
    tool: number;
    fold: number;
  } | null>(null);
  // Entries the active filter can still reveal above what is loaded.
  const [serverTotal, setServerTotal] = useState(0);
  // True once an older page request came back empty (log start reached).
  const [reachedStart, setReachedStart] = useState(false);

  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (docked && useViewerTabs.getState().fullscreen) {
          useViewerTabs.getState().setFullscreen(false);
          return;
        }
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, docked]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(320, Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)));
      setWidth(w);
      try {
        localStorage.setItem("coder:traceWidth", String(w));
      } catch {
        /* حافظه در دسترس نیست */
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragCleanup.current = onUp;
  };

  // The newest page + live polling so new entries appear on their own.
  //
  // The poll asks only for the newest page and MERGES it by id: replacing the
  // array would throw away every older page the user scrolled into, and
  // re-fetching the whole log on a timer is what put the file's full size into
  // the renderer heap. A log that grew past one page between two polls would
  // drop the middle, so the page size is the bound on how much can be missed —
  // 200 entries is minutes of work, and the oldest page boundary is recovered by
  // scrolling up.
  const fetchSeqRef = useRef(0);
  const fetchAll = useCallback(
    async (silent: boolean) => {
      if (!activeChatId) {
        setEntries([]);
        setServerCounts(null);
        setServerTotal(0);
        setReachedStart(false);
        return;
      }
      const mySeq = ++fetchSeqRef.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const out = await getChatTraces(activeChatId, undefined, taskId || undefined, {
          limit: TRACE_PAGE,
          before: 0,
          sub: Boolean(taskId),
        });
        if (mySeq !== fetchSeqRef.current) return;
        if ("traces" in out) {
          const page = out.traces;
          setServerCounts(out.counts);
          setServerTotal(out.total);
          setEntries((prev) => {
            // A fresh chat, or a poll after a clear: nothing to merge into.
            if (prev.length === 0) return page;
            const have = new Set(prev.map((e) => e.id));
            const fresh = page.filter((e) => !have.has(e.id));
            if (fresh.length === 0) return prev;
            // Trim from the OLDEST end past two pages: off-screen entries above
            // the viewport cost DOM and heap for no benefit, and the user can
            // always scroll back up to re-fetch them.
            const merged = [...prev, ...fresh];
            const cap = TRACE_PAGE * 2;
            return merged.length > cap ? merged.slice(merged.length - cap) : merged;
          });
          if (!silent) setError(null);
        } else if (!silent) {
          setEntries([]);
          setServerCounts(null);
          setServerTotal(0);
          setError((out as { error?: string })?.error ?? "trace request failed");
        }
      } catch (e) {
        if (mySeq !== fetchSeqRef.current) return;
        if (!silent) {
          setEntries([]);
          setServerCounts(null);
          setServerTotal(0);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (mySeq !== fetchSeqRef.current) return;
        if (!silent) setLoading(false);
      }
    },
    [activeChatId, taskId],
  );

  /** Fetch the page above the oldest entry currently held.
   *
   *  `before` counts entries back from the END of the log under the ACTIVE
   *  filter, so the cursor is simply "how many filtered entries I already
   *  have" — no ids to track and no way to skip a row.
   */
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    if (!activeChatId || loadingOlderRef.current || reachedStart) return;
    loadingOlderRef.current = true;
    setOlderLoading(true);
    try {
      const activeFilter = taskId ? undefined : tab === "all" ? undefined : tab;
      const before = visibleCountRef.current;
      const out = await getChatTraces(activeChatId, activeFilter, taskId || undefined, {
        limit: TRACE_PAGE,
        before,
        sub: Boolean(taskId),
      });
      if ("traces" in out && Array.isArray(out.traces)) {
        const older = out.traces;
        setServerCounts(out.counts);
        setServerTotal(out.total);
        if (older.length === 0) {
          setReachedStart(true);
        } else {
          setEntries((prev) => {
            const have = new Set(prev.map((e) => e.id));
            const fresh = older.filter((e) => !have.has(e.id));
            if (fresh.length === 0) {
              // Everything in the page is already loaded: the cursor is past
              // the start of the log.
              setReachedStart(true);
              return prev;
            }
            return [...fresh, ...prev];
          });
        }
      }
    } catch {
      /* keep what we have; scrolling again retries */
    } finally {
      loadingOlderRef.current = false;
      setOlderLoading(false);
    }
  }, [activeChatId, taskId, tab, reachedStart]);

  useEffect(() => {
    if (!activeChatId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void fetchAll(false).catch(() => {});
    // پولینگ زنده هر ۲ ثانیه تا حین اجرای چت، لاگ‌ها لایو اضافه شوند.
    const timer = window.setInterval(() => {
      if (!cancelled) void fetchAll(true).catch(() => {});
    }, 2000);
    return () => {
      cancelled = true;
      // درخواست قدیمی اگر بعداً برگردد نادیده گرفته می‌شود (fetchSeqRef)
      fetchSeqRef.current++;
      window.clearInterval(timer);
    };
  }, [activeChatId, fetchAll]);

  const counts = useMemo(() => getTraceTabCounts(entries, Boolean(taskId)), [entries, taskId]);

  // The tab badges must reflect the WHOLE log, not the pages in memory: once
  // only a page is loaded, counting `entries` locally would shrink every badge.
  const badges = useMemo(
    () => (serverCounts ? serverCounts : counts),
    [serverCounts, counts],
  );

  const visible = useMemo(() => {
    const subView = Boolean(taskId);
    const byTab =
      tab === "all"
        ? entries
        : tab === "tool"
          ? entries.filter((e) => isToolTraceKind(e.kind as string) && (subView || !isSubToolTrace(e)))
          : entries.filter((e) => e.kind === tab);
    // Chronological: oldest at top, newest at bottom (scroll up for history).
    return filterTraces(byTab, query);
  }, [entries, tab, query, taskId]);

  // "How many filtered entries do I already hold" — the `before` cursor for the
  // next older page. Kept in a ref so `loadOlder` never needs `visible` as a
  // dependency (that would recreate it on every poll-set-entries).
  const visibleCountRef = useRef(0);
  useEffect(() => {
    visibleCountRef.current = visible.length;
  }, [visible.length]);

  const turnGroups = useMemo(() => groupTracesByTurn(visible), [visible]);

  const totalTokens = useMemo(
    () => entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0),
    [entries],
  );

  const searchParts = useMemo(
    () => (query.trim() ? visible.map((e) => traceEntrySearchParts(e)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, tab, entries],
  );
  const hitCounts = useMemo(
    () =>
      query.trim()
        ? searchParts.map((p) => countTraceEntryHits(p, query))
        : [],
    [searchParts, query],
  );
  const matchCount = hitCounts.reduce((n, c) => n + c, 0);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => {
    setActiveIndex(matchCount > 0 ? 0 : -1);
  }, [query, tab, entries.length]);
  const activeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);
  const stepSearch = (dir: 1 | -1) => {
    setActiveIndex((cur) => stepHitIndex(cur, matchCount, dir));
  };
  const baseById = useMemo(() => {
    const m = new Map<string, number>();
    let acc = 0;
    for (let i = 0; i < visible.length; i++) {
      m.set(visible[i].id, acc);
      acc += hitCounts[i] ?? 0;
    }
    return m;
  }, [visible, hitCounts]);

  // Stick to bottom on new traces (chronological list); scrolling up pauses it
  // and, near the top, pulls in the next older page.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  // Height of the content above the viewport before an older page is prepended,
  // used to keep the viewport exactly where the user was (no jump).
  const prependAnchorRef = useRef<number | null>(null);
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = nearBottom;
    setStuck(nearBottom);
    // Near the top: ask for the previous page. Anchored before the state update
    // so the layout effect below can restore the scroll offset.
    if (el.scrollTop < 160) {
      if (prependAnchorRef.current == null) {
        prependAnchorRef.current = el.scrollHeight;
      }
      void loadOlder();
    }
  }, [loadOlder]);
  // Prepending older entries grows the list above the viewport; shift the scroll
  // position by exactly that growth so the reading position does not jump.
  useLayoutEffect(() => {
    const el = listRef.current;
    const prev = prependAnchorRef.current;
    if (!el || prev == null) return;
    if (el.scrollHeight !== prev) {
      el.scrollTop += el.scrollHeight - prev;
      prependAnchorRef.current = null;
    }
  }, [entries.length]);
  useEffect(() => {
    if (stickRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [visible.length, tab, activeChatId]);
  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    setStuck(true);
    listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0, behavior: "smooth" });
  }, []);

  // A filter/search that starts over must re-arm the "no older page" flag, or a
  // tab switch would leave the panel convinced it had reached the log start.
  useEffect(() => {
    setReachedStart(false);
    prependAnchorRef.current = null;
  }, [activeChatId, tab, taskId]);


  const panel = (
    <div
      className={docked ? "review-docked-wrap" : `review-overlay${fullscreen ? " fullscreen" : ""}`}
      dir="ltr"
      style={docked ? undefined : ({ "--review-w": `${width}px` } as React.CSSProperties)}
      onClick={(e) => e.stopPropagation()}
    >
      {!docked && <div className="review-scrim" aria-hidden="true" onClick={close} />}
      {!docked && !fullscreen && (
        <div
          className="review-overlay-resize-handle"
          title="Drag to resize"
          onMouseDown={startResize}
        />
      )}
      <aside className={docked ? "review-panel review-docked-panel" : "review-panel review-floating-panel"} dir="ltr" aria-label="Chat traces">
        <div className="review-header">
          <span className="review-source" role="tablist" aria-label="Trace filter">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={`review-source-btn${tab === key ? " active" : ""}`}
                onClick={() => setTab(key)}
                title={key === "all" ? "Show everything" : `Filter: ${label}`}
                aria-label={`${label}, ${badges[key] ?? 0} items`}
              >
                <span className="trace-tab-label">{label}</span>
                <span className="trace-tab-count">{badges[key] ?? 0}</span>
              </button>
            ))}
          </span>
          <span className="review-header-actions">
            <CopyTracesButton entries={visible} query={query} tab={tab} />
            <button
              className="review-header-btn"
              title="Clear traces"
              aria-label="Clear traces"
              onClick={() => {
                if (!activeChatId) return;
                void (async () => {
                  const out = await clearChatTraces(activeChatId);
                  if ("error" in out) {
                    setError(out.error);
                    return;
                  }
                  setEntries([]);
                  setServerCounts(null);
                  setServerTotal(0);
                  setReachedStart(false);
                })();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            </button>
            {!docked && <ViewerFullscreenButton docked={docked} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen((v) => !v)} />}
            {!docked && (
              <button
                className="review-header-btn"
                title="Close"
                aria-label="Close"
                onClick={close}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </span>
        </div>
        <div className="trace-subheader">
          <span className="trace-subheader-text">
            {taskId ? `Sub-agent ${traceTitle || taskId.slice(0, 8)} · ` : ""}
            {serverCounts
              ? `${entries.length} of ${serverTotal} events`
              : `${entries.length} events`}
            {totalTokens > 0 ? ` · ${totalTokens} tokens` : ""}
          </span>
        </div>
        <div className="review-search-row">
          <label className="review-search" dir="ltr">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
            <input
              className="review-search-input"
              type="search"
              placeholder="Search prompts, responses, args…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matchCount > 0) {
                  e.preventDefault();
                  stepSearch(e.shiftKey ? -1 : 1);
                }
              }}
            />
            {query.trim() ? (
              matchCount > 0 ? (
                <span className="review-search-nav">
                  <span className="review-search-count">
                    {activeIndex + 1}/{matchCount}
                  </span>
                  <button
                    type="button"
                    className="review-search-btn"
                    title="Previous match (Shift+Enter)"
                    aria-label="Previous match"
                    onClick={() => stepSearch(-1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="review-search-btn"
                    title="Next match (Enter)"
                    aria-label="Next match"
                    onClick={() => stepSearch(1)}
                  >
                    ↓
                  </button>
                </span>
              ) : (
                <span className="review-search-count">0 hits</span>
              )
            ) : null}
          </label>
        </div>
        {loading ? (
          <div className="review-empty">loading…</div>
        ) : error ? (
          <div className="review-empty">{error}</div>
        ) : visible.length === 0 ? (
          <div className="review-empty">
            {query.trim() ? `No traces match “${query.trim()}”.` : "No traces yet for this chat."}
          </div>
        ) : (
          <div className="trace-panel-list" ref={listRef} onScroll={onListScroll}>
            {(olderLoading || (!reachedStart && serverTotal > visible.length)) && (
              <div className="trace-load-older">
                {olderLoading ? "loading older…" : "scroll up for older events"}
              </div>
            )}
            {turnGroups.map((g) => (
              <TraceTurnGroup
                key={g.turn !== null ? `turn-${g.turn}` : `turn-inferred-${g.inferred}`}
                turn={g.turn}
                inferred={g.inferred}
                entries={g.entries}
                query={query}
                hitBases={g.entries.map((e) => baseById.get(e.id) ?? 0)}
                activeHit={activeIndex}
                activeRef={activeRef}
              />
            ))}
          </div>
        )}
        {!stuck && visible.length > 0 && (
          <button
            type="button"
            className="trace-jump-latest"
            onClick={jumpToLatest}
            title="Jump to latest traces"
          >
            ↓ Latest
          </button>
        )}
      </aside>
    </div>
  );

  if (docked || typeof document === "undefined") return panel;
  return createPortal(panel, document.body);
}
