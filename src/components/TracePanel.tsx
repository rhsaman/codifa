import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";
import { useTracePanel, type TraceTab } from "../lib/tracePanel";
import { clearChatTraces, getChatTraces } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import type { TraceEntry } from "../types";
import { layaConfidencePct, layaReasonLabel, layaRouteLabel } from "./LayaLabels";

const TABS: Array<[TraceTab, string]> = [
  ["all", "All"],
  ["laya", "Laya"],
  ["llm", "LLM"],
  ["prompt", "Prompts"],
  ["tool", "Tools"],
];

/** خلاصه تمیز یک ورودی برای ردیف تاشو — fallback وقتی summary خالی است. */
export function traceRowTitle(entry: TraceEntry): string {
  if ((entry.summary || "").trim()) return entry.summary;
  if (entry.kind === "llm") return `${entry.model || "llm"} · ${entry.tokens?.total ?? 0} tokens`;
  if (entry.kind === "prompt") return `prompt · ${(entry.prompt || "").length} chars`;
  if (entry.kind === "tool") {
    const name = String((entry.detail as Record<string, unknown> | undefined)?.name || entry.model || "tool");
    return name;
  }
  return "laya decision";
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

/** زمان نمایشی کوتاه (HH:MM:SS). */
function timeLabel(at: number): string {
  try {
    const d = new Date((at || 0) * 1000);
    return d.toLocaleTimeString();
  } catch {
    return "";
  }
}

/** هایلایت رخدادهای کوئری داخل متن (برای سرچ داخل پرامپت/پاسخ). */
function highlightHits(text: string, query: string): React.ReactNode {
  const q = (query || "").trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={key++} className="trace-hit">
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
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  return (
    <button
      type="button"
      className="trace-copy-btn"
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

/** بلوک متن (پرامپت/پاسخ/آرگومان) با لیبل، کپی و هایلایت سرچ. */
function TextBlock({
  label,
  text,
  query,
  kind,
}: {
  label: string;
  text: string;
  query?: string;
  kind: "prompt" | "result" | "json";
}) {
  if (!text) return null;
  return (
    <div className="trace-prompt-block" dir="ltr">
      <div className="trace-prompt-actions">
        <span className="trace-block-label">{label}</span>
        <CopyButton text={text} label="Copy" />
      </div>
      <pre className={kind === "json" ? "trace-detail-json" : "trace-prompt-text"}>
        {query?.trim() ? highlightHits(text, query) : text}
      </pre>
    </div>
  );
}

/** شماره قدم یک ورودی (از detail.step) — مبنای گروه‌بندی پنل. خالص برای تست. */
export function traceStep(entry: TraceEntry): number | null {
  const s = (entry.detail as Record<string, unknown> | undefined)?.step;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** کلید پایدار یک گروه قدم — لنگر به قدیمی‌ترین ردیف گروه تا با prepend لاگ جدید (پولینگ) کلید گروه‌های موجود عوض نشود و حالت باز آن‌ها نپرد. خالص برای تست. */
export function traceGroupKey(step: number | null, entries: TraceEntry[]): string {
  const anchor = entries.length > 0 ? entries[entries.length - 1].id : "empty";
  return step !== null ? `step-${step}-${anchor}` : `other-${anchor}`;
}

/** گروه‌بندی consecutive بر اساس step — ترتیب ورودی حفظ می‌شود، خالص برای تست. */
export function groupTracesByStep(entries: TraceEntry[]): Array<{ step: number | null; entries: TraceEntry[] }> {
  const groups: Array<{ step: number | null; entries: TraceEntry[] }> = [];
  for (const e of entries) {
    const s = traceStep(e);
    const last = groups[groups.length - 1];
    if (last && last.step === s) last.entries.push(e);
    else groups.push({ step: s, entries: [e] });
  }
  return groups;
}

/** ردیف تاشوی یک ورودی لاگ — تک‌خطی فشرده چپ‌چین مثل لنگ‌اسمیت. */
export function TraceRow({ entry, query, defaultOpen }: { entry: TraceEntry; query?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  const prompt = entry.prompt || "";
  const result = String((entry as { result?: string }).result || "");
  const status = String(detail.status || (entry.error ? "error" : "") || "").toLowerCase();

  // هنگام سرچ، ردیف‌های منطبق خودکار باز شوند تا پرامپت/پاسخ دیده شود.
  useEffect(() => {
    if (query?.trim()) setOpen(true);
    else if (defaultOpen !== undefined) setOpen(Boolean(defaultOpen));
  }, [query, defaultOpen]);

  const tokens = entry.tokens;
  const tokenTotal = tokens?.total ?? 0;
  const step = traceStep(entry);
  const title = traceRowTitle(entry);

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
          {query?.trim() ? highlightHits(title, query) : title}
        </span>
        {tokenTotal > 0 ? <span className="trace-meta-chip trace-panel-chip">{tokenTotal} tok</span> : null}
        {step !== null ? <span className="trace-meta-chip trace-panel-chip">step {step}</span> : null}
        {status ? <span className={`trace-status-chip status-${status}`}>{status}</span> : null}
        <span className="trace-panel-time">{timeLabel(entry.at)}</span>
        <span className="trace-panel-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="trace-row-body trace-panel-body">
          {entry.kind === "laya" && (
            <div className="trace-laya-meta">
              <span className={`laya-route-badge route-${String(detail.route || "normal").toLowerCase()}`}>
                {layaRouteLabel(String(detail.route || "normal"))}
              </span>
              <span className="trace-meta-chip">{layaConfidencePct(Number(detail.confidence ?? 0))}٪</span>
              <span className={`trace-status-chip ${detail.handled ? "status-done" : "status-error"}`}>
                {detail.handled ? "handled" : "fallback"}
              </span>
              {detail.reason ? (
                <span className="trace-meta-reason" title={String(detail.reason)}>
                  {layaReasonLabel(String(detail.reason)) || String(detail.reason)}
                </span>
              ) : null}
              {detail.model ? <span className="trace-meta-chip">{String(detail.model)}</span> : null}
              {typeof detail.elapsed_ms === "number" ? (
                <span className="trace-meta-chip">{Number(detail.elapsed_ms)}ms</span>
              ) : null}
            </div>
          )}
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
                <span className="trace-meta-chip">step {Number(detail.step)}</span>
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
              label={entry.kind === "tool" ? "Args (prompt)" : "Prompt"}
              text={prompt}
              query={query}
              kind="prompt"
            />
          ) : null}
          {result ? (
            <TextBlock
              label={entry.kind === "tool" ? "Result" : "Response"}
              text={result}
              query={query}
              kind="prompt"
            />
          ) : null}
          {!prompt && !result ? (
            <pre className="trace-detail-json" dir="ltr">
              {query?.trim()
                ? highlightHits(JSON.stringify(detail, null, 2), query)
                : JSON.stringify(detail, null, 2)}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** سربرگ تاشوی یک قدم — ردیف‌های هم‌قدم را زیر یک هدر جمع می‌کند. */
export function TraceStepGroup({
  step,
  entries,
  query,
}: {
  step: number | null;
  entries: TraceEntry[];
  query?: string;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (query?.trim()) setOpen(true);
  }, [query]);
  const tokens = entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  return (
    <section className="trace-panel-step" aria-label={step !== null ? `Step ${step}` : "Other"}>
      <button
        className="trace-panel-step-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="trace-panel-step-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="trace-panel-step-title">{step !== null ? `Step ${step}` : "Other"}</span>
        <span className="trace-panel-step-meta">
          {entries.length} events{tokens > 0 ? ` · ${tokens} tok` : ""}
        </span>
      </button>
      {open && (
        <div className="trace-panel-step-rows">
          {entries.map((entry, i) => (
            <TraceRow key={entry.id} entry={entry} query={query} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </section>
  );
}

/** پنل لاگ چت جاری — مثل گیت‌دیف به‌صورت اورلی روی چت باز می‌شود؛
 *  همه لاگ‌ها در یک صفحه با تب‌های فیلتر (All/Laya/LLM/Prompts/Tools)،
 *  ردیف‌های تاشو، سرچ داخل پرامپت/پاسخ و به‌روزرسانی زنده مثل لنگ‌اسمیت. */
export function TracePanel() {
  const { tab, setTab, close } = useTracePanel();
  const activeChatId = useStore((s) => s.activeChatId);
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
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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

  // گرفتن همه لاگ‌ها یک‌جا + پولینگ زنده تا لاگ‌های جدید خودکار بیایند.
  const fetchAll = useCallback(async (silent: boolean) => {
    if (!activeChatId) {
      setEntries([]);
      return;
    }
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const out = await getChatTraces(activeChatId);
      if (Array.isArray(out)) {
        setEntries(out);
        if (!silent) setError(null);
      } else if (!silent) {
        setEntries([]);
        setError(out.error ?? "trace request failed");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await fetchAll(false);
    })();
    // پولینگ زنده هر ۲ ثانیه تا حین اجرای چت، لاگ‌ها لایو اضافه شوند.
    const timer = window.setInterval(() => {
      if (!cancelled) void fetchAll(true);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeChatId, fetchAll]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length, laya: 0, llm: 0, prompt: 0, tool: 0 };
    for (const e of entries) {
      if (e.kind in c) c[e.kind] += 1;
    }
    return c;
  }, [entries]);

  const visible = useMemo(() => {
    const byTab = tab === "all" ? entries : entries.filter((e) => e.kind === tab);
    const filtered = filterTraces(byTab, query);
    return filtered.slice().reverse();
  }, [entries, tab, query]);

  const totalTokens = useMemo(
    () => entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0),
    [entries],
  );

  const panel = (
    <div
      className={`review-overlay${fullscreen ? " fullscreen" : ""}`}
      dir="ltr"
      style={{ "--review-w": `${width}px` } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="review-scrim" aria-hidden="true" onClick={close} />
      {!fullscreen && (
        <div
          className="review-overlay-resize-handle"
          title="Drag to resize"
          onMouseDown={startResize}
        />
      )}
      <aside className="review-panel review-floating-panel" dir="ltr" aria-label="Chat traces">
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
              >
                {label}
                <span className="trace-tab-count">{counts[key] ?? 0}</span>
              </button>
            ))}
          </span>
          <span className="review-header-actions">
            <span className="trace-live-dot" title="Live — auto refresh every 2s">
              <span className="trace-live-pulse" aria-hidden="true" /> Live
            </span>
            <button
              className="review-header-btn"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => void fetchAll(false)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            </button>
            <button
              className="review-header-btn"
              title="Clear traces"
              aria-label="Clear traces"
              onClick={() => {
                if (!activeChatId) return;
                void (async () => {
                  await clearChatTraces(activeChatId);
                  setEntries([]);
                })();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            </button>
            <button
              className="review-header-btn"
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => setFullscreen((v) => !v)}
            >
              {fullscreen ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="21" y2="3" /><line x1="14" y1="10" x2="3" y2="21" /></svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              )}
            </button>
            <button
              className="review-header-btn"
              title="Close"
              aria-label="Close"
              onClick={close}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </span>
        </div>
        <div className="trace-subheader">
          <span className="trace-subheader-text">
            {entries.length} events{totalTokens > 0 ? ` · ${totalTokens} tokens` : ""}
          </span>
        </div>
        <div className="review-search-row">
          <label className="review-search" dir="ltr">
            <span aria-hidden="true">🔍</span>
            <input
              className="review-search-input"
              type="search"
              placeholder="Search prompts, responses, args…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() ? (
              <span className="review-search-count">{visible.length} hits</span>
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
          <div className="trace-panel-list">
            {groupTracesByStep(visible).map((g) => (
              <TraceStepGroup
                key={traceGroupKey(g.step, g.entries)}
                step={g.step}
                entries={g.entries}
                query={query}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  );

  if (typeof document === "undefined") return panel;
  return createPortal(panel, document.body);
}
