import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ToolActivity, SearchResultItem } from "../types";
import { useStore } from "../lib/store";
import { diffStatsFromUnified, terminalOutputText } from "../lib/toolActivity";
import { reviewPathOf } from "../lib/reviewTurn";
import { parseDiffRows, parseSideBySide } from "../lib/reviewDiff";
import { countOccurrences } from "../lib/diffSearch";
import { copyToClipboard } from "../lib/clipboard";
import { useViewerTabs } from "../lib/viewerTabs";
import { api } from "../lib/fs";
import { restoreCheckpoint } from "../lib/api";
import { fixZwsp, prepareContent } from "../lib/bidi";
import { handleLinkClick } from "../lib/link";
import { useDragScroll } from "../lib/useDragScroll";
import { FileChip, FileIcon, openWorkspaceFile } from "./FileIcon";

const TOOL_LABEL: Record<string, string> = {
  write_file: "Write File",
  edit_file: "Edit File",
  list_files: "List Directory",
  read: "Read File",
  grep: "Search Files",
  glob: "Search Files",
  web_search: "Web Search",
  run_terminal: "Ran a command",
  search_memory: "Search Memory",
  memory: "Memory",
  ask_user: "Ask User",
  fetch_url: "Fetch URL",
  task: "Task",
  vision: "Vision",
  create_skill: "Create Skill",
  create_mcp: "Create MCP",
  update_plan: "Update Plan",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_commit: "Git Commit",
  git_log: "Git Log",
  current_time: "Current Time",
  computer: "Computer",
  search_console: "Search Console",
};

/** Small glyph per tool category, shown at the head of each collapsed-group
 *  timeline row — lets the eye scan a run of calls without reading every
 *  label (mirrors Claude-app's trace icons). */
const TOOL_ICON: Record<string, string> = {
  run_terminal: "❯",
  list_files: "📁",
  read: "📄",
  grep: "🔍",
  glob: "🔍",
  web_search: "🌐",
  fetch_url: "🌐",
  search_memory: "🧠",
  memory: "🧠",
  ask_user: "❓",
  task: "🧩",
  vision: "🖼",
  create_skill: "⚙",
  create_mcp: "🔌",
  update_plan: "📝",
  git_status: "🌿",
  git_diff: "📊",
  git_commit: "✅",
  git_log: "🕘",
  current_time: "🕒",
  computer: "🖥",
  search_console: "🔎",
};
function toolIcon(tool: string): string {
  return TOOL_ICON[tool] ?? "•";
}

/** Natural-language piece per tool category for the group header sentence
 *  ("9 commands, 3 searches, 2 notes") — the Claude-app-style summary line
 *  instead of a raw tool-name tally. */
const TOOL_NOUN: Record<string, [string, string]> = {
  run_terminal: ["command", "commands"],
  list_files: ["file listing", "file listings"],
  read: ["file read", "file reads"],
  grep: ["search", "searches"],
  glob: ["search", "searches"],
  web_search: ["web search", "web searches"],
  fetch_url: ["page fetch", "page fetches"],
  search_memory: ["memory search", "memory searches"],
  memory: ["note", "notes"],
  ask_user: ["question", "questions"],
  task: ["sub-agent call", "sub-agent calls"],
  vision: ["image lookup", "image lookups"],
  create_skill: ["skill saved", "skills saved"],
  create_mcp: ["connector added", "connectors added"],
  update_plan: ["plan update", "plan updates"],
  git_status: ["status check", "status checks"],
  git_diff: ["diff check", "diff checks"],
  git_commit: ["commit", "commits"],
  git_log: ["log lookup", "log lookups"],
  current_time: ["time check", "time checks"],
  computer: ["desktop action", "desktop actions"],
  search_console: ["console query", "console queries"],
};
function groupSummary(activities: ToolActivity[]): string {
  const counts: Record<string, number> = {};
  for (const a of activities) counts[a.tool] = (counts[a.tool] || 0) + 1;
  return Object.entries(counts)
    .map(([tool, n]) => {
      const name = TOOL_LABEL[tool] ?? tool;
      return n > 1 ? `${name} ×${n}` : name;
    })
    .join(", ");
}

/** A task card running the background sub-agent (opencode-style subagent;
 *  "explore"/"general" are legacy pre-rename types the backend still accepts). */
export const isSubagentCard = (a: ToolActivity) =>
  a.tool === "task" &&
  (a.args?.subagent_type === "subagent" ||
    a.args?.subagent_type === "explore" ||
    a.args?.subagent_type === "general");

/** Legacy alias kept for existing tests/callers. */
export const isExploreCard = isSubagentCard;

/** ابزارهای ویرایش فایل — ران‌های پشت‌سرهم آن‌ها در یک گروه ویرایش جدا
 *  (ToolEditGroupView) جمع می‌شوند و هرگز با گروه ابزارهای فقط‌خواندنی
 *  (ToolGroupView) قاطی نمی‌شوند. */
export const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export const isEditActivity = (a: ToolActivity) => EDIT_TOOLS.has(a.tool);

/** جمع +N -M چند فعالیت ویرایش (ترجیحاً diffStats ذخیره‌شده، وگرنه محاسبه
 *  از روی متن دیف) — برای هدر گروه ویرایش. */
export function editGroupStats(
  activities: { activity: ToolActivity }[],
): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const { activity } of activities) {
    if (!activity.diff) continue;
    const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
    adds += s.adds;
    dels += s.dels;
  }
  return { adds, dels };
}

/** گروه ویرایش جدا (Claude/Codex-style): ران پشت‌سرهم edit_file/write_file
 *  در یک کارت جمع با هدر «N files · +A -D» و یک ردیف تکی به‌ازای هر فایل.
 *  هر ردیف Undo و Review تکی خودش را حفظ می‌کند (کلیک روی ردیف هم ترن را در
 *  پنل Review سمت راست باز می‌کند). */
export const ToolEditGroupView = memo(function ToolEditGroupView({
  activities,
  messageId,
  chatId,
  onReverted,
}: {
  activities: { activity: ToolActivity; index: number }[];
  messageId?: string;
  chatId?: string;
  onReverted?: (index: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const openReview = useViewerTabs((s) => s.openReview);
  const root = useStore((s) => s.root);
  const activeChatId = useStore((s) => s.activeChatId);
  const [reverting, setReverting] = useState<number | null>(null);
  const running = activities.some((a) => a.activity.status === "running");
  const { adds, dels } = editGroupStats(activities);
  // Live clock so the group total ticks while any file edit is still running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const totalMs = activities.reduce((sum, a) => {
    const act = a.activity;
    if (act.status === "running" && act.startedAt) return sum + Math.max(0, now - act.startedAt);
    return sum + (act.elapsedMs || 0);
  }, 0);

  const revertOne = async (entry: { activity: ToolActivity; index: number }) => {
    if (!root) return;
    setReverting(entry.index);
    try {
      const cid = chatId ?? activeChatId;
      if (entry.activity.checkpoint != null && cid) {
        const res = await restoreCheckpoint(cid, entry.activity.checkpoint, root);
        if (res.ok) {
          onReverted?.(entry.index);
          return;
        }
      }
      if (!entry.activity.diff) return;
      const path = reviewPathOf(entry.activity);
      if (!path) return;
      const { content: current } = await api.fsRead(root, path);
      const oldContent = applyReverseDiff(entry.activity.diff, current ?? "");
      const ok = await api.fsWrite(root, path, oldContent);
      if (ok) onReverted?.(entry.index);
    } finally {
      setReverting(null);
    }
  };

  return (
    <div className={`tool-edit-group ${open ? "open" : ""} ${running ? "running" : "done"}`}>
      <button className="trace-head edit-group-head" onClick={() => setOpen((o) => !o)}>
        <span className="edit-group-icon" aria-hidden="true">✎</span>
        <span className="trace-head-pills">
          <span className="trace-pill edit-group-pill">
            {activities.length} file{activities.length === 1 ? "" : "s"} edited
          </span>
        </span>
        <span className="trace-head-right">
          {(adds > 0 || dels > 0) && (
            <span className="edit-group-stats" dir="ltr">
              <span className="review-count-add">{`+${adds}`}</span>{" "}
              <span className="review-count-del">{`-${dels}`}</span>
            </span>
          )}
          {totalMs > 0 && <span className="trace-time">{fmtTime(totalMs)}</span>}
          <IconChevron open={open} className="trace-chev" />
        </span>
      </button>
      {open && (
        <div className="edit-group-list">
          {activities.map((entry) => {
            const path = reviewPathOf(entry.activity);
            const base = path.split("/").pop() || path;
            const st = entry.activity.diff
              ? (entry.activity.diffStats ?? diffStatsFromUnified(entry.activity.diff))
              : null;
            const stats = st && (st.adds || st.dels) ? `+${st.adds} -${st.dels}` : null;
            return (
              <div
                key={entry.index}
                className={`edit-group-row ${entry.activity.status}${entry.activity.reverted ? " reverted" : ""}`}
              >
                <button
                  className="edit-group-row-main"
                  title={path || undefined}
                  onClick={() => messageId && openReview(messageId, path)}
                >
                  <StatusIcon status={entry.activity.status} />
                  <FileIcon path={path} size={20} />
                  <span className="edit-group-file" dir="auto">{base}</span>
                  <span className="edit-group-row-end">
                    {stats && (
                      <span className="trace-row-diff-stats" dir="ltr">{stats}</span>
                    )}
                    {entry.activity.reverted && (
                      <span className="reverted-tag">reverted</span>
                    )}
                    {(() => {
                      const act = entry.activity;
                      const ms = act.status === "running" && act.startedAt ? Math.max(0, now - act.startedAt) : act.elapsedMs;
                      return ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null;
                    })()}
                    {messageId && entry.activity.diff && (
                      <span className="trace-row-review" aria-hidden="true">Review ↗</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function fmtTime(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  // بیش از ۶۰ ثانیه: دقیقه + ثانیه (مثل Claude.ai که «1m 12s» نشان می‌دهد)
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}

/* ——— High-quality SVG icons ——— */
function IconSparkle({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 1L14.5 9.5L23 12L14.5 14.5L12 23L9.5 14.5L1 12L9.5 9.5Z" />
    </svg>
  );
}

function IconChevron({
  open,
  className,
}: {
  open?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`${className ?? ""} ${open ? "open" : ""}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transition: "transform 0.18s ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function StatusIcon({ status }: { status: ToolActivity["status"] }) {
  if (status === "running") return <span className="spinner" />;
  if (status === "error") return <IconX className="status-err" />;
  if (status === "denied") return <span className="status-denied">⏹</span>;
  return <IconCheck className="status-ok" />;
}

/** Mini shell-prompt glyph (chevron + underscore) for terminal trace rows —
 *  the terminal counterpart of the file squircle: one quiet theme-accent mark
 *  that lets the eye pick command rows out of a run of calls. */
function TerminalRowIcon() {
  return (
    <svg
      className="trace-row-term-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7l5 5-5 5" />
      <path d="M13 17h6" />
    </svg>
  );
}

/** Extract a clean host label (e.g. "github.com") from a URL for the
 *  favicon + source chip. Falls back to the raw URL when it can't parse. */
function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Shared, beautifully-styled list of web_search result links. Rendered in
 *  EVERY tool view (full card, single row, timeline row) so the links the
 *  model found are always visible — not just in the expanded card. Pure
 *  presentational component (no store/fullscreen hooks) so it can be
 *  unit-tested in isolation. */
export const WebResultLinks = memo(function WebResultLinks({
  items,
}: {
  items: SearchResultItem[];
}) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="web-results" dir="auto">
      {items.map((it, i) => {
        const host = hostOf(it.url);
        return (
          <li key={i} className="web-result">
            <a
              className="web-result-link"
              href={it.url}
              target="_blank"
              rel="noreferrer"
              title={it.url}
              onClick={(e) => {
                // Open external links in the OS browser, not inside the app's
                // own BrowserWindow. window.coder.openExternal → shell.openExternal.
                handleLinkClick(
                  e,
                  it.url,
                  (url) => void window.coder.openExternal(url),
                );
              }}
            >
              <span className="web-result-favicon" aria-hidden="true">
                {host ? (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
                    alt=""
                    loading="lazy"
                    width={16}
                    height={16}
                  />
                ) : (
                  <span className="web-result-glyph">🔗</span>
                )}
              </span>
              <span className="web-result-text">
                <span className="web-result-title">{it.title || it.url}</span>
                {it.snippet && (
                  <span className="web-result-snippet">{it.snippet}</span>
                )}
              </span>
              <span className="web-result-host">{host}</span>
              <span className="web-result-arrow" aria-hidden="true">
                ↗
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
});

/** متن خروجی ترمینال (`run_terminal`): آیتم‌ها فقط فیلد `content` دارند
 *  (بدون `file`/`path`/`url`) پس `FileResultLinks` خالی رندر می‌شود.
 *  خروجی بلند با `trace-expand-pre` اسکرول عمودی می‌خورد. */
export const TerminalResultText = function TerminalResultText({
  items,
}: {
  items: unknown;
}) {
  const text = terminalOutputText(items);
  if (!text) return null;
  // Long output is clipped here anyway — open the full text in the side panel.
  const long = text.length > 600;
  return (
    <pre
      className={`trace-expand-val trace-expand-pre trace-terminal-output${long ? " clickable" : ""}`}
      dir="ltr"
      title={long ? "Open the full output in the side panel" : undefined}
      onClick={
        long
          ? () =>
              useViewerTabs.getState().openText("Terminal output", text, "text")
          : undefined
      }
    >
      {text}
    </pre>
  );
};

/** نمایش نتایج grep/glob به‌صورت لیست مسیر فایل (با شمارهٔ خط) — نه لینک وب.
 *  آیتم‌های این ابزارها فیلد `url` ندارند، پس نباید از WebResultLinks (مخصوص
 *  web_search/fetch_url) استفاده شوند؛ وگرنه به‌جای مسیر فایل فقط آیکون 🔗
 *  نمایش داده می‌شد. */
export const FileResultLinks = memo(function FileResultLinks({
  tool,
  items,
}: {
  tool: string;
  items: Array<Record<string, unknown>>;
}) {
  if (!items || items.length === 0) return null;
  const VISIBLE = 3;
  const visible = items.slice(0, VISIBLE);
  const extra = items.length - visible.length;
  return (
    <ul className="file-results" dir="ltr">
      {visible.map((it, i) => {
        const file = String(it.file ?? it.path ?? "");
        if (!file) return null;
        const line =
          it.line !== undefined && it.line !== null ? String(it.line) : "";
        const text = String(it.text ?? "");
        return (
          <li key={i} className="file-result">
            <FileChip
              path={file}
              line={line ? Number(line) : undefined}
              display={`${file}${line ? `:${line}` : ""}`}
            />
            {text && <span className="file-result-text">{text}</span>}
          </li>
        );
      })}
      {extra > 0 && (
        <li className="file-result-more" key="more">
          <button
            type="button"
            className="file-result-more-btn"
            title="Open all results in the side panel"
            onClick={() =>
              useViewerTabs
                .getState()
                .openText(
                  `${tool} results`,
                  // Markdown list so the side panel renders every path as a
                  // clickable file chip (inline `code` -> FileChip) instead of
                  // a wall of raw text.
                  items
                    .map((it) => {
                      const f = String(it.file ?? it.path ?? "");
                      const ln = it.line != null ? `:${String(it.line)}` : "";
                      // A backtick in the matched line would end the inline
                      // code span early — swap it so the path chip stays put.
                      const tx = String(it.text ?? "")
                        .replace(/`/g, "'")
                        .slice(0, 300);
                      return `- \`${f}${ln}\`${tx ? ` — ${tx}` : ""}`;
                    })
                    .join("\n"),
                  "md",
                )
            }
          >
            +{extra} more
          </button>
        </li>
      )}
    </ul>
  );
});

/** Keys already rendered as dedicated chips in the tool-card head. */
const HEADER_SHOWN_KEYS = new Set([
  "command",
  "path",
  "filePath",
  "offset",
  "limit",
  "start",
  "end",
  "query",
  "pattern",
  "task",
  "description",
  "subagent_type",
  "prompt",
  "task_id",
  "text",
  "subject",
  "paths",
  "engine",
]);

/** Huge payloads that are never worth showing inline (the diff shows them). */
const HIDDEN_KEYS = new Set(["content", "old_string", "new_string"]);

function fmtArgValue(v: unknown): string {
  if (typeof v === "string") return fixZwsp(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(fmtArgValue).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Remaining args rendered as clean `key: value` chips inside the card head —
 *  no raw JSON blob in the body. */
function ToolArgs({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(
    ([k]) => !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k),
  );
  if (entries.length === 0) return null;
  return (
    <span className="tool-args" dir="ltr">
      {entries.map(([k, v]) => (
        <span key={k} className="tool-arg">
          <span className="tool-arg-key">{k}</span>
          <span className="tool-arg-val">{fmtArgValue(v)}</span>
        </span>
      ))}
    </span>
  );
}

/** هایلایت ساده‌ی TOML: کلید نارنجی، رشته زرد-سبز، کامنت خاکستری.
 *  فقط برای فایل‌های toml اعمال می‌شود (DiffView بر اساس مسیر تصمیم می‌گیرد). */
function TomlLine({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#")) return <span className="toml-comment">{text}</span>;
  const eq = text.indexOf("=");
  if (eq < 0) return <>{text}</>;
  const key = text.slice(0, eq).trimEnd();
  const rest = text.slice(eq);
  const value = rest.slice(1).trimStart();
  const isString = value.startsWith('"') || value.startsWith("'");
  return (
    <>
      <span className="toml-key">{key}</span>
      <span className="toml-eq"> = </span>
      <span className={isString ? "toml-string" : "toml-value"}>
        {rest.slice(1).trimStart()}
      </span>
    </>
  );
}

/** متن یک خط دیف: برای toml هایلایت‌دار، بقیه ساده.
 *  وقتی کوئری جست‌وجو فعال است، رخدادها با <mark> هایلایت می‌شوند؛
 *  رخداد فعال (`activeHit`) کلاس متمایز می‌گیرد تا با دکمه‌های عقب/جلو دیده شود. */
function DiffLineText({
  text,
  path,
  query,
  hitBase = 0,
  activeHit = -1,
  activeRef,
}: {
  text: string;
  path?: string;
  query?: string;
  hitBase?: number;
  activeHit?: number;
  activeRef?: { current: HTMLElement | null };
}) {
  const q = (query ?? "").trim();
  if (q)
    return (
      <>{highlightParts(text, q, hitBase, activeHit, activeRef)}</>
    );
  if (path && path.split("?")[0].toLowerCase().endsWith(".toml")) {
    return <TomlLine text={text} />;
  }
  return <>{text}</>;
}

/** متن را به تکه‌های عادی/هایلایت می‌شکند (case-insensitive).
 *  `base` ایندکس سراسری اولین رخداد این خط است؛ رخدادی که ایندکسش با
 *  `active` برابر شود کلاس فعال می‌گیرد و `activeRef` رویش ست می‌شود. */
function highlightParts(
  text: string,
  query: string,
  base: number,
  active: number,
  activeRef?: { current: HTMLElement | null },
) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  let ordinal = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      if (i < text.length) out.push(<span key={k++}>{text.slice(i)}</span>);
      break;
    }
    if (j > i) out.push(<span key={k++}>{text.slice(i, j)}</span>);
    const idx = base + ordinal;
    ordinal++;
    const isActive = idx === active;
    out.push(
      <mark
        key={k++}
        className={isActive ? "diff-hit diff-hit-active" : "diff-hit"}
        {...(isActive ? { "aria-current": "true" as const } : {})}
        ref={
          isActive && activeRef
            ? (el: HTMLElement | null) => {
                activeRef.current = el;
              }
            : undefined
        }
      >
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return out;
}

/** آستانه‌ی پیش‌فرض عرض (پیکسل) برای سوییچ خودکار دیف به دوستونی. */
export const DIFF_SIDE_BY_SIDE_THRESHOLD = 768;

/** حالت نمای دیف: خودکار (بر اساس عرض)، تک‌ستونی اجباری، یا دوستونی اجباری. */
export type DiffLayoutMode = "auto" | "unified" | "side-by-side";

/** تصمیم خالص برای نمایش دوستونی — جدا نگه داشته شده تا مستقیم تست شود. */
export function shouldShowSideBySide(
  width: number,
  threshold: number = DIFF_SIDE_BY_SIDE_THRESHOLD,
): boolean {
  return width >= threshold;
}

/** دیف به سبک کدکس — واکنش‌گرا: در عرض کم تک‌ستونی، در عرض زیاد دوستونی.
 *  هر جفت delete+add به دو خط جدا (قرمز سپس سبز) باز می‌شود.
 *  `query` رخدادهای جست‌وجو را هایلایت می‌کند؛ `activeHit` ایندکس محلی
 *  رخداد فعال داخل همین دیف است (‎-1‎ یعنی هیچ‌کدام) که خودکار اسکرول می‌شود.
 *  `layout` حالت نما را اجبار می‌کند (`auto` عرض کانتینر را با ناظر تغییراندازه
 *  می‌سنجد) و `threshold` آستانه‌ی سوییچ خودکار است. */
export function DiffView({
  diff,
  path,
  query,
  activeHit = -1,
  layout = "auto",
  threshold = DIFF_SIDE_BY_SIDE_THRESHOLD,
}: {
  diff: string;
  path?: string;
  query?: string;
  activeHit?: number;
  layout?: DiffLayoutMode;
  threshold?: number;
}) {
  const rows = parseDiffRows(diff);
  const sideItems = parseSideBySide(diff);
  if (rows.length === 0) return null;
  const drag = useDragScroll<HTMLDivElement>();
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const update = (w: number) => setMeasuredWidth(w);
    update(el.clientWidth || 0);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [diff]);
  // Forced side-by-side still respects a measured narrow container (SSR
  // falls back to true until the first measure) so the view stays
  // responsive instead of locking two columns in a narrow panel.
  const showSide =
    layout === "unified"
      ? false
      : layout === "side-by-side"
        ? measuredWidth > 0
          ? shouldShowSideBySide(measuredWidth, threshold)
          : true
        : shouldShowSideBySide(measuredWidth, threshold);
  const activeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff]);
  // شمارنده‌ی ترتیبی رخدادها در ترتیب رندر خط‌ها.
  let hitCursor = 0;
  const renderRow = (
    key: number | string,
    cls: "diff-u-add" | "diff-u-del" | "diff-u-ctx",
    gutter: string,
    lineNo: number,
    text: string,
  ) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q) hitCursor += countOccurrences(text, q);
    return (
      <div key={key} className={`diff-u-row ${cls}`}>
        <span className="diff-u-gutter">{gutter}</span>
        <span className="diff-u-num">{lineNo >= 0 ? lineNo : ""}</span>
        <span className="diff-u-text">
          <DiffLineText
            text={text}
            path={path}
            query={query}
            hitBase={base}
            activeHit={activeHit}
            activeRef={activeRef}
          />
        </span>
      </div>
    );
  };

  // سلول یک سمت نمای دوستونی با هایلایت جست‌وجو و شماره‌ی خط.
  const renderSideCell = (
    key: number | string,
    cls: string,
    lineNo: number,
    text: string,
    empty: boolean,
  ) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    return (
      <span key={key} className={`diff-line ${cls}`}>
        <span className="diff-u-num">{!empty && lineNo >= 0 ? lineNo : ""}</span>
        <span className="diff-u-text">
          {!empty ? (
            <DiffLineText
              text={text}
              path={path}
              query={query}
              hitBase={base}
              activeHit={activeHit}
              activeRef={activeRef}
            />
          ) : (
            "\u00a0"
          )}
        </span>
      </span>
    );
  };

  const renderSide = () => (
    <div className="diff-columns" dir="ltr" {...drag}>
      <div className="diff-columns-head">
        <div className="diff-col-header diff-col-before">Before</div>
        <div className="diff-col-header diff-col-after">After</div>
      </div>
      {sideItems.map((item) => {
        if (item.kind === "gap") {
          return (
            <div key={item.key} className="diff-gap">
              {item.count} unmodified lines
            </div>
          );
        }
        const metas = item.rows.filter((r) => "text" in r);
        const contents = item.rows.filter((r) => !("text" in r));
        return (
          <div key={item.key} className="diff-hunk-pair">
            {metas.map((m, mi) => (
              <div key={`${item.key}-m${mi}`} className={`diff-u-meta ${m.type}`}>
                {"text" in m ? m.text : ""}
              </div>
            ))}
            <div className="diff-col diff-col-before">
              <pre className="diff-col-code">
                {contents.map((r, ri) => {
                  if ("text" in r) return null;
                  if (r.type === "same")
                    return renderSideCell(`${ri}-b`, "", r.bLine, r.before, false);
                  if (r.type === "del" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-b`,
                      "diff-line-del",
                      r.bLine,
                      r.before,
                      false,
                    );
                  return renderSideCell(`${ri}-b`, "diff-line-empty", -1, "", true);
                })}
              </pre>
            </div>
            <div className="diff-col diff-col-after">
              <pre className="diff-col-code">
                {contents.map((r, ri) => {
                  if ("text" in r) return null;
                  if (r.type === "same")
                    return renderSideCell(`${ri}-a`, "", r.aLine, r.after, false);
                  if (r.type === "add" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-a`,
                      "diff-line-add",
                      r.aLine,
                      r.after,
                      false,
                    );
                  return renderSideCell(`${ri}-a`, "diff-line-empty", -1, "", true);
                })}
              </pre>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderUnified = () => (
    <div className="diff-unified" dir="ltr" {...drag}>
      {rows.flatMap((row, i) => {
        if ("text" in row) {
          return (
            <div key={i} className={`diff-u-meta ${row.type}`}>
              {row.text}
            </div>
          );
        }
        if (row.type === "same")
          return renderRow(i, "diff-u-ctx", " ", row.aLine, row.after);
        if (row.type === "del")
          return renderRow(i, "diff-u-del", "-", row.bLine, row.before);
        if (row.type === "add")
          return renderRow(i, "diff-u-add", "+", row.aLine, row.after);
        // mod: خط قدیمی قرمز + خط جدید سبز، هر دو با شماره‌ی خودشان.
        return [
          renderRow(`${i}-d`, "diff-u-del", "-", row.bLine, row.before),
          renderRow(`${i}-a`, "diff-u-add", "+", row.aLine, row.after),
        ];
      })}
    </div>
  );

  return (
    <div
      ref={measureRef}
      className="diff-responsive"
      data-layout={showSide ? "side-by-side" : "unified"}
    >
      {showSide ? renderSide() : renderUnified()}
    </div>
  );
}

type DiffItem = { kind: "ctx" | "del" | "add" | "marker"; text: string };
type Hunk = { newStart: number; items: DiffItem[] };

/** Parse a unified diff into hunks (with the new-file start line of each). */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let cur: Hunk | null = null;
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = hunkRe.exec(line);
    if (m) {
      cur = { newStart: parseInt(m[2], 10), items: [] };
      hunks.push(cur);
    } else if (cur) {
      if (line.startsWith("\\")) cur.items.push({ kind: "marker", text: "" });
      else if (line.startsWith("+"))
        cur.items.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-"))
        cur.items.push({ kind: "del", text: line.slice(1) });
      else cur.items.push({ kind: "ctx", text: line.slice(1) });
    }
  }
  return hunks;
}

/**
 * Reverse-apply a unified diff onto the current file content to recover the
 * pre-write contents. Unchanged gap lines (not shown in the diff) are taken
 * from the current file using each hunk's new-file start line.
 */
function applyReverseDiff(diff: string, current: string): string {
  const cur = current.split("\n");
  if (current.endsWith("\n")) cur.pop();
  const hunks = parseHunks(diff);
  const out: string[] = [];
  let ci = 0;
  let oldEofNoNewline = false;
  for (const hunk of hunks) {
    const target = hunk.newStart - 1;
    while (ci < target && ci < cur.length) {
      out.push(cur[ci]);
      ci++;
    }
    let prev: DiffItem["kind"] | null = null;
    for (const item of hunk.items) {
      if (item.kind === "marker") {
        if (prev === "del" || prev === "ctx") oldEofNoNewline = true;
        prev = null;
        continue;
      }
      if (item.kind === "ctx") {
        prev = "ctx";
        out.push(ci < cur.length ? cur[ci] : item.text);
        ci++;
      } else if (item.kind === "add") {
        prev = "add";
        ci++;
      } else {
        prev = "del";
        out.push(item.text);
      }
    }
  }
  for (; ci < cur.length; ci++) out.push(cur[ci]);
  let content = out.join("\n");
  if (!oldEofNoNewline) content += "\n";
  return content;
}

/** Claude-app style trace group: a single collapsible summary line ("9
 *  commands, 3 searches, 2 notes") for a run of consecutive non-write tool
 *  activities. Collapsed by default — no preview stack. Expanding reveals a
 *  flat vertical timeline (icon + label + status per call), not a stack of
 *  full cards, matching Claude.ai's own tool-trace UI. */
export const ToolGroupView = memo(function ToolGroupView({
  activities,
  captions,
}: {
  activities: { activity: ToolActivity; index: number }[];
  /** Per-call narration lines: captions[i] is the model's narration that
   *  preceded activities[i]. Rendered as rows inside the expanded panel
   *  (above their own call), and the LAST non-null one becomes the head's
   *  summary title (Claude.ai keeps the latest caption as the collapsed
   *  summary). */
  captions?: (string | null)[];
}) {
  const [open, setOpen] = useState(false);
  const running = activities.some((a) => a.activity.status === "running");
  // Live clock so the group total ticks while any call is still running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const totalMs = activities.reduce((sum, a) => {
    const act = a.activity;
    if (act.status === "running" && act.startedAt) return sum + Math.max(0, now - act.startedAt);
    return sum + (act.elapsedMs || 0);
  }, 0);
  // Always show tool names + counts as the main status text. The narration
  // line (if any) rides along as the caption — always in the head, plus the
  // first row of the expanded panel (see renderSegments in ChatMessage.tsx).
  // Build per-LABEL pills (not per-tool): grep and glob share the label
  // "Search Files", so counting by raw tool name produced TWO identical
  // "Search Files" pills side by side (one with ×N, one without) instead of
  // a single merged "Search Files ×N".
  const toolCounts = activities.reduce<Record<string, number>>((acc, a) => {
    const label = TOOL_LABEL[a.activity.tool] ?? a.activity.tool;
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const searchEngines = [
    ...new Set(
      activities
        .filter(({ activity }) => activity.tool === "web_search" && activity.engine)
        .map(({ activity }) => activity.engine as string),
    ),
  ];
  // The head shows the LAST narration (Claude.ai's collapsed summary title).
  const headCaption = (() => {
    if (!captions) return undefined;
    for (let i = captions.length - 1; i >= 0; i--) {
      if (captions[i]) return captions[i] as string;
    }
    return undefined;
  })();

  return (
    <div
      className={`tool-group ${open ? "open" : ""} ${running ? "running" : "done"}`}
    >
      <button
        className={`trace-head ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconSparkle className="trace-sparkle" />
        <span className="trace-head-pills">
          {Object.entries(toolCounts).map(([label, n]) => (
            <span key={label} className="trace-pill">
              {label}
              {n > 1 && <span className="trace-pill-count">×{n}</span>}
            </span>
          ))}
        </span>
        {searchEngines.map((engine) => (
          <span key={engine} className="trace-row-engine">
            {engine}
          </span>
        ))}
        {headCaption && (
          <span className="trace-head-caption" dir="auto" title={prepareContent(headCaption)}>
            {prepareContent(headCaption)}
          </span>
        )}
        <span className="trace-head-right">
          {totalMs > 0 && (
            <span className="trace-time">{fmtTime(totalMs)}</span>
          )}
          <IconChevron open={open} className="trace-chev" />
        </span>
      </button>
      {open && (
        <div className="trace-list">
          {activities.map(({ activity, index }, i) => (
            <Fragment key={index}>
              {captions?.[i] && (
                <div className="trace-narration" dir="auto">
                  {prepareContent(captions[i] as string)}
                </div>
              )}
              <TraceRow activity={activity} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
});

/** Compact one-line detail for a collapsed tool row. Mirrors the chips the
 *  full card head shows (command/path/pattern/description/memory text/url…),
 *  so a collapsed preview never shows an empty row for tools whose args the
 *  old path-only summary missed (run_terminal, memory, fetch_url, task…). */
/** Cap a raw arg string for sub-row display: merged grep regexes and shell
 *  commands otherwise dump a wall of `|`-joined noise into every row. The
 *  full text stays in the row's title tooltip. */
function shortArg(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function subArgSummary(activity: ToolActivity): string {
  const args = activity.args;
  if (!args) return "";
  const parts: string[] = [];

  // run_terminal: the shell command
  if (args.command !== undefined && args.command !== "") {
    parts.push(shortArg(String(args.command), 80));
  }

  // read/write/edit/list_files: path + real line range (mirrors the card head)
  const path = String(args.filePath ?? args.path ?? "");
  if (path) {
    let p = path;
    const startRaw = args.offset ?? args.start;
    const limitRaw = args.limit;
    const st = Number(startRaw);
    const lm = Number(limitRaw);
    if (
      startRaw !== undefined &&
      startRaw !== "" &&
      Number.isFinite(st) &&
      st >= 0
    ) {
      // Show the real range (mirrors the main tool card) instead of a fake "…".
      if (
        limitRaw !== undefined &&
        limitRaw !== "" &&
        Number.isFinite(lm) &&
        lm > 0
      ) {
        p += `:${st}–${st + lm - 1}`;
      } else {
        p += `:${st}`;
      }
    } else if (
      limitRaw !== undefined &&
      limitRaw !== "" &&
      Number.isFinite(lm) &&
      lm > 0
    ) {
      p += `:1–${lm}`;
    }
    parts.push(p);
  }

  // grep/glob/web_search: pattern or query — capped: the sub-agent merges
  // alternatives into one big `a|b|c` regex, which as raw text is unreadable.
  const pattern = String(args.pattern ?? args.query ?? "");
  if (pattern) parts.push(shortArg(pattern, 48));

  // task: the short description (the full card shows it as the task chip)
  const description = String(args.description ?? "");
  if (description) parts.push(shortArg(description, 60));

  // memory: the remembered text / subject
  const memText = String(args.text ?? args.subject ?? "");
  if (memText) parts.push(shortArg(memText, 48));

  // fetch_url: the URL
  const url = String(args.url ?? "");
  if (url) parts.push(shortArg(url, 60));

  // web_search: engine badge
  const engine = String(args.engine ?? "");
  if (engine) parts.push(engine);

  // sub-agent fan-out: parallel read args (filePaths / paths / ranges).
  // Prefer ranges (already "file:offset:limit") over raw filePaths to
  // avoid the duplicated "filePaths:a,b ranges:a:1:200,b:350:70" line.
  const rangesRaw = (args as Record<string, unknown>).ranges;
  if (Array.isArray(rangesRaw) && rangesRaw.length > 0) {
    const rs = rangesRaw.map((r) => String(r)).filter(Boolean);
    if (rs.length > 0) parts.push(rs.length > 2 ? `${rs.slice(0, 2).join(", ")} +${rs.length - 2} more` : rs.join(", "));
  } else if (typeof rangesRaw === "string" && rangesRaw) {
    parts.push(rangesRaw);
  } else {
    const listRaw =
      (args as Record<string, unknown>).filePaths ??
      (args as Record<string, unknown>).paths;
    if (Array.isArray(listRaw) && listRaw.length > 0) {
      const ps = listRaw.map((p) => String(p)).filter(Boolean);
      if (ps.length > 0) parts.push(ps.length > 2 ? `${ps.slice(0, 2).join(", ")} +${ps.length - 2} more` : ps.join(", "));
    }
  }

  // Fallback: any remaining args as `key:value` chips (same as ToolArgs in the
  // card head) so no tool ever collapses to an empty row.
  const covered = new Set([
    "command",
    "path",
    "filePath",
    "filePaths",
    "paths",
    "ranges",
    "include",
    "includes",
    "offset",
    "limit",
    "start",
    "end",
    "query",
    "pattern",
    "description",
    "text",
    "subject",
    "url",
    "engine",
    "content",
    "old_string",
    "new_string",
    "prompt",
    "subagent_type",
    "task_id",
  ]);
  const rest = Object.entries(args)
    .filter(([k]) => !covered.has(k))
    .map(([k, v]) => `${k}:${fmtArgValue(v)}`);
  if (rest.length > 0) parts.push(rest.join(" "));

  return parts.join(" · ");
}

/** Non-collapsable row for ONE sub-agent tool call (explore's internal
 *  read/grep/glob). Distinct from a collapse card: always fully expanded, no
 *  chevron, compact single-line with the same detail (path/pattern/status/ms)
 *  a closed card would show. */
export const ToolSubRow = memo(function ToolSubRow({
  activity,
}: {
  activity: ToolActivity;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = activity.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const ms =
    running && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs;
  const subSummary = subArgSummary(activity);
  return (
    <div
      className={`tool-sub-row ${activity.status}${running ? " running" : ""}`}
    >
      <StatusIcon status={activity.status} />
      <span className="tool-sub-name">
        {TOOL_LABEL[activity.tool] ?? activity.tool}
      </span>
      <span className="tool-sub-args" title={subSummary}>
        {subSummary}
      </span>
      {activity.summary && (
        <span className="tool-sub-summary">{activity.summary}</span>
      )}
      <span className="tool-ms">{fmtTime(ms)}</span>
    </div>
  );
});

/** Minimum output length (chars) for a tool row to open its full output as a
 *  text tab in the side panel instead of expanding inline — long outputs read
 *  like diff/plan on the right; short ones stay a quick inline peek. */
const TRACE_TEXT_PANEL_MIN = 600;

/** A code fence that can never appear inside the payload itself: one backtick
 *  longer than the longest ` run in the text (min 3), so embedded markdown
 *  fences or template literals never terminate the block early. */
function fenceFor(s: string): string {
  let max = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}

/** Markdown dump of a tool row's output (summary/args/diff/terminal) — the
 *  body the side panel opens for long rows. Bold section labels + fenced
 *  blocks so the markdown text view renders args/diff/output with the code
 *  block chrome instead of collapsing the lines into paragraphs. */
function traceRowOutputText(activity: ToolActivity, argsText: string): string {
  const parts: string[] = [];
  if (activity.summary) parts.push(`**Summary**\n\n${fixZwsp(activity.summary)}`);
  if (argsText) {
    const f = fenceFor(argsText);
    parts.push(`**Args**\n\n${f}\n${argsText}\n${f}`);
  }
  if (activity.diff) {
    const f = fenceFor(activity.diff);
    parts.push(`**Diff**\n\n${f}diff\n${activity.diff}\n${f}`);
  }
  if (activity.tool === "run_terminal") {
    const out = terminalOutputText(activity.items ?? activity.results);
    if (out) {
      const f = fenceFor(out);
      parts.push(`**Output**\n\n${f}\n${out}\n${f}`);
    }
  }
  return parts.join("\n\n");
}

/** One row in a Claude-style trace group: a single quiet line per call with
 *  a tool icon, a short description (the model's arg summary or activity
 *  summary), and a right-side chevron `›` so the row reads as a list item you
 *  can scan, not a mini-card. Mirrors Claude.ai's own trace row layout (icon
 *  + short text + chevron), not the spine-and-circle timeline the old version
 *  used. */
const TraceRow = memo(function TraceRow({
  activity,
}: {
  activity: ToolActivity;
}) {
  const [now, setNow] = useState(() => Date.now());
  // edit_file / write_file همیشه باز باشن (diff نشون بدن)
  const [expanded, setExpanded] = useState(
    () => activity.tool === "edit_file" || activity.tool === "write_file",
  );
  const running = activity.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const ms =
    running && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs;
  const label = TOOL_LABEL[activity.tool] ?? activity.tool;
  const detail = activity.summary
    ? fixZwsp(activity.summary)
    : subArgSummary(activity);

  const argsText = activity.args
    ? Object.entries(activity.args)
      .map(
        ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      )
      .join("\n")
    : "";

  const isEdit =
    activity.tool === "edit_file" || activity.tool === "write_file";
  // Long outputs open as a text tab in the side panel (like diff/plan);
  // short ones keep the quick inline expand.
  const outputText = traceRowOutputText(activity, argsText);
  const sideTitle = `${label} — ${detail.slice(0, 40)}`;
  const onHeadClick = () => {
    if (!isEdit && outputText.length > TRACE_TEXT_PANEL_MIN) {
      useViewerTabs.getState().openText(sideTitle, outputText, "md");
      return;
    }
    setExpanded((e) => !e);
  };

  return (
    <div
      className={`trace-row ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`}
    >
      <button
        className="trace-row-head"
        onClick={onHeadClick}
      >
        <span className="trace-row-bullet" aria-hidden="true">
          {running ? (
            <span className="spinner" />
          ) : activity.tool === "run_terminal" ? (
            <TerminalRowIcon />
          ) : (
            "•"
          )}
        </span>
        <span className="trace-pill">{label}</span>
        {activity.tool === "web_search" && activity.engine && (
          <span className="trace-row-engine">{activity.engine}</span>
        )}
        <span className="trace-row-detail" dir="auto" title={detail ?? ""}>
          {detail}
        </span>
        <span className="trace-row-end">
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <StatusIcon status={activity.status} />
          <IconChevron open={expanded} className="trace-row-chev" />
        </span>
      </button>
      {expanded && (
        <div className="trace-row-expand">
          {ms ? (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Duration</span>
              <span className="trace-expand-val">{fmtTime(ms)}</span>
            </div>
          ) : null}
          {activity.summary && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Summary</span>
              <span className="trace-expand-val" dir="auto">
                {fixZwsp(activity.summary)}
              </span>
            </div>
          )}
          {argsText && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Args</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">
                {argsText}
              </pre>
            </div>
          )}
          {activity.diff && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Diff</span>
              <pre
                className="trace-expand-val trace-expand-pre trace-expand-diff"
                dir="auto"
              >
                {activity.diff}
              </pre>
            </div>
          )}
          {(activity.items ?? activity.results) &&
            (activity.items ?? activity.results)!.length > 0 && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "web_search" ||
                activity.tool === "fetch_url" ? (
                <WebResultLinks
                  items={(activity.items ?? activity.results)!}
                />
              ) : activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                />
              ) : (
                <FileResultLinks
                  tool={activity.tool}
                  items={
                    (activity.items ??
                      activity.results) as unknown as Array<
                      Record<string, unknown>
                    >
                  }
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** Legacy timeline row, kept exported in case any caller still imports it
 *  directly. New code should use TraceRow instead — Claude.ai's trace UI is a
 *  flat list of quiet rows, not a spine-and-circle timeline. */
const ToolTimelineRow = memo(function ToolTimelineRow({
  activity,
}: {
  activity: ToolActivity;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = activity.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const ms =
    running && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs;
  const detail = subArgSummary(activity);
  return (
    <div className={`tool-timeline-item ${activity.status}`}>
      <span className="tool-timeline-icon" aria-hidden="true">
        {running ? <span className="spinner" /> : toolIcon(activity.tool)}
      </span>
      <span className="tool-timeline-label">
        {TOOL_LABEL[activity.tool] ?? activity.tool}
      </span>
      {detail && (
        <span className="tool-timeline-detail" title={detail}>
          {detail}
        </span>
      )}
      <StatusIcon status={activity.status} />
      <span className="tool-ms">{fmtTime(ms)}</span>
      {activity.items &&
        activity.items.length > 0 &&
        (activity.tool === "web_search" || activity.tool === "fetch_url" ? (
          <WebResultLinks items={activity.items} />
        ) : (
          <FileResultLinks
            tool={activity.tool}
            items={activity.items as unknown as Array<Record<string, unknown>>}
          />
        ))}
    </div>
  );
});

/** How many of the newest calls the collapsed preview shows. */
const PREVIEW_COUNT = 3;

/** Collapsed preview: the newest PREVIEW_COUNT calls as a cascading stack of
 *  mini-cards (each newer card overlaps the one above it). Always shows the
 *  last 3, so as new calls stream in the preview live-updates to the newest. */
const ToolCascade = memo(function ToolCascade({
  activities,
}: {
  activities: ToolActivity[];
}) {
  // Chronological order: oldest on top, newest at the bottom (reads like a log).
  const last = activities.slice(-PREVIEW_COUNT);
  const listRef = useRef<HTMLDivElement>(null);
  const prevTops = useRef<Map<string, number>>(new Map());
  const firstRun = useRef(true);

  // FLIP: when the list changes, glide every card from its previous spot to its
  // new one (brand-new cards rise in from below) instead of letting the layout
  // jump — that jump is what made the preview feel like it was shaking.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const items = Array.from(el.children) as HTMLElement[];
    const nextTops = new Map<string, number>();
    const glide =
      "transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease";
    for (const item of items) {
      const key = item.dataset.key ?? "";
      const next = item.offsetTop;
      const prev = prevTops.current.get(key);
      if (firstRun.current) {
        nextTops.set(key, next);
        continue;
      }
      if (prev === undefined) {
        // brand-new card: rise in from below
        item.style.transition = "none";
        item.style.transform = "translateY(14px)";
        item.style.opacity = "0";
        void item.offsetHeight;
        item.style.transition = glide;
        item.style.transform = "";
        item.style.opacity = "";
      } else if (prev !== next) {
        // moved card: invert the jump, then glide to the new spot
        item.style.transition = "none";
        item.style.transform = `translateY(${prev - next}px)`;
        void item.offsetHeight;
        item.style.transition = glide;
        item.style.transform = "";
      }
      nextTops.set(key, next);
    }
    prevTops.current = nextTops;
    firstRun.current = false;
  }, [last]);

  return (
    <div className="tool-cascade" ref={listRef}>
      {last.map((a, i) => (
        <div
          key={a.callId ?? `${a.tool}-${i}`}
          data-key={a.callId ?? `${a.tool}-${i}`}
          className="tool-cascade-item"
          style={{ zIndex: i + 1 }}
        >
          <ToolSubRow activity={a} />
        </div>
      ))}
    </div>
  );
});

/** The model's short narration line ("what I'm about to do") rendered as its
 *  OWN row inside the trace card — above the tool call(s) it precedes —
 *  matching Claude.ai, where narration lines and tool rows interleave inside
 *  one card instead of the caption being squeezed into the tool row's head.
 *  See renderSegments in ChatMessage.tsx for how narration lines get
 *  attached to the call(s) that follow them. */
export const TraceNarration = memo(function TraceNarration({
  text,
}: {
  text: string;
}) {
  return (
    <div className="trace-narration" dir="auto">
      {prepareContent(text)}
    </div>
  );
});

/**
 * A SINGLE read-only tool call rendered as ONE cohesive row — not a header
 * bolted onto an empty body (which is what a lone ToolCallView looks like for
 * grep/read/glob/search). Anthropic-frontend principles: one clear unit,
 * restrained chrome, icon + short description + chevron in a single quiet line.
 * Used for standalone single calls; multi-call runs still collapse into a
 * group. Mirrors Claude.ai's own trace row layout.
 */
export const ToolSingleRow = memo(function ToolSingleRow({
  activity,
  messageId,
}: {
  activity: ToolActivity;
  /** id پیام مالک این فراخوانی — کلیک روی کارت ویرایش، ترن همین پیام را در
   *  پنل Review سمت راست باز می‌کند (سبک کدکس). */
  messageId?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const running = activity.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const ms =
    running && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs;
  const label = TOOL_LABEL[activity.tool] ?? activity.tool;
  const detail = activity.summary
    ? fixZwsp(activity.summary)
    : subArgSummary(activity);

  const argsText = activity.args
    ? Object.entries(activity.args)
      .map(
        ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      )
      .join("\n")
    : "";

  const isEdit =
    activity.tool === "edit_file" || activity.tool === "write_file";
  const openReview = useViewerTabs((s) => s.openReview);
  // Long outputs open as a text tab in the side panel (like diff/plan);
  // short ones keep the quick inline expand.
  const outputText = traceRowOutputText(activity, argsText);
  const sideTitle = `${label} — ${detail.slice(0, 40)}`;
  const onHeadClick = () => {
    if (isEdit) {
      if (messageId) openReview(messageId, reviewPathOf(activity));
      return;
    }
    if (outputText.length > TRACE_TEXT_PANEL_MIN) {
      useViewerTabs.getState().openText(sideTitle, outputText, "md");
      return;
    }
    setExpanded((e) => !e);
  };

  /** Compute +/- stats from diff — از مقدار ذخیره‌شده روی event در Chat.tsx
   *  استفاده می‌کند وگرنه خودش از روی متن حساب می‌کند. */
  const diffStats = (() => {
    if (!activity.diff) return null;
    const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
    return s.adds || s.dels ? `+${s.adds} -${s.dels}` : null;
  })();

  return (
    <div
      className={`trace-row single ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`}
    >
      <button
        className="trace-row-head"
        /* کارت ویرایش دیف را در چت باز نمی‌کند — کلیک، ترن را در پنل Review
           سمت راست نشان می‌دهد (سبک کدکس). بقیهٔ ردیف‌ها مثل قبل باز/بسته. */
        onClick={onHeadClick}
        title={isEdit ? "Review changes in the side panel" : undefined}
      >
        <StatusIcon status={activity.status} />
        <span className="trace-pill">{label}</span>
        {isEdit ? (
          <span
            className="trace-row-detail"
            dir="auto"
            title={reviewPathOf(activity)}
          >
            {reviewPathOf(activity)
              .split("/")
              .pop()}
          </span>
        ) : (
          <span className="trace-row-detail" dir="auto" title={detail ?? ""}>
            {detail}
          </span>
        )}
        {activity.tool === "web_search" && activity.engine && (
          <span className="trace-row-engine">{activity.engine}</span>
        )}
        <span className="trace-row-end">
          {isEdit && diffStats && (
            <span className="trace-row-diff-stats">{diffStats}</span>
          )}
          {isEdit && messageId && activity.diff && (
            <span className="trace-row-review" aria-hidden="true">
              Review ↗
            </span>
          )}
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <IconChevron open={expanded} className="trace-row-chev" />
        </span>
      </button>
      {expanded ? (
        <div className="trace-row-expand">
          {ms ? (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Duration</span>
              <span className="trace-expand-val">{fmtTime(ms)}</span>
            </div>
          ) : null}
          {activity.summary && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Summary</span>
              <span className="trace-expand-val" dir="auto">
                {fixZwsp(activity.summary)}
              </span>
            </div>
          )}
          {argsText && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Args</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">
                {argsText}
              </pre>
            </div>
          )}
          {activity.diff && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Diff</span>
              <pre
                className="trace-expand-val trace-expand-pre trace-expand-diff"
                dir="auto"
              >
                {activity.diff}
              </pre>
            </div>
          )}
          {(activity.items ?? activity.results) &&
            (activity.items ?? activity.results)!.length > 0 && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "web_search" ||
                activity.tool === "fetch_url" ? (
                <WebResultLinks
                  items={(activity.items ?? activity.results)!}
                />
              ) : activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                />
              ) : (
                <FileResultLinks
                  tool={activity.tool}
                  items={
                    (activity.items ??
                      activity.results) as unknown as Array<
                      Record<string, unknown>
                    >
                  }
                />
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

/** Clickable file path in the tool-card head: opens the file in the side
 *  panel without toggling the card itself (stopPropagation on click/key). */
function ToolPathSpan({ path }: { path: string }) {
  const open = (e: { stopPropagation: () => void; preventDefault?: () => void }) => {
    e.stopPropagation();
    openWorkspaceFile(path);
  };
  return (
    <span
      className="tool-path tool-path-open"
      dir="ltr"
      role="button"
      tabIndex={0}
      title={`${path} — open in the side panel`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      }}
    >
      <FileIcon path={path} size={20} />
      {path}
    </span>
  );
}

export const ToolCallView = memo(function ToolCallView({
  activity,
  chatId,
  messageId,
  onReverted,
}: {
  activity: ToolActivity;
  /** id چت فعلی — برای restore از checkpoint (snapshot) در revert. */
  chatId?: string;
  /** id پیام مالک این فراخوانی — دکمهٔ Review برای باز کردن ترن همان پیام. */
  messageId?: string;
  onReverted?: () => void;
}) {
  const [reverting, setReverting] = useState(false);
  // سبک کدکس: کارت ویرایش کوچک می‌ماند و دیف هرگز داخل چت باز نمی‌شود؛
  // کلیک روی خودِ کارت (یا دکمهٔ Review) دیف را در پنل سمت راست نشان می‌دهد.
  const openReview = useViewerTabs((s) => s.openReview);
  const root = useStore((s) => s.root);
  // چت فعال از store — fallback وقتی caller (ChatMessage) chatId را پاس نمی‌دهد.
  const activeChatId = useStore((s) => s.activeChatId);
  // Task cards (background sub-agents) are collapsible and start
  // collapsed: the nested read/grep/glob sub-list is noisy, so it stays
  // hidden until clicked.
  const [collapsed, setCollapsed] = useState(isSubagentCard(activity));
  const collapsible =
    activity.tool === "task" &&
    ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary));

  // Live elapsed time while the tool is still running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (
      activity.status !== "running" &&
      !activity.children?.some((c) => c.status === "running")
    )
      return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [activity.status, activity.children?.some((c) => c.status === "running")]);
  const ms =
    activity.status === "running" && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs;

  const isWrite =
    activity.tool === "write_file" || activity.tool === "edit_file";
  /** مسیر فایلِ کارت نوشتن (path یا filePath) — برای هدر و پنل Review. */
  const writePath = reviewPathOf(activity);
  const readPaths = Array.isArray(activity.args?.paths)
    ? (activity.args.paths as string[])
    : [];

  const fetchSummary = activity.tool === "fetch_url" ? activity.summary : "";

  const revert = async () => {
    if (!root) return;
    setReverting(true);
    try {
      // مسیر ترجیحی: restore از snapshot (checkpoint) — حتی وقتی مدل بعد از
      // این تغییر، فایل را دوباره عوض کرده باشد درست کار می‌کند. مسیر قدیمی
      // (reverse-diff) فقط fallback کارت‌های قدیمی بدون checkpoint است.
      // chatId از prop می‌آید و در نبودش از چت فعال store (فراخوانی از
      // ChatMessage که chatId را ندارد).
      const cid = chatId ?? activeChatId;
      if (activity.checkpoint != null && cid) {
        const res = await restoreCheckpoint(cid, activity.checkpoint, root);
        if (res.ok) {
          onReverted?.();
          return;
        }
      }
      if (!activity.diff) return;
      const path = String(activity.args?.path ?? activity.args?.filePath ?? "");
      const { content: current } = await api.fsRead(root, path);
      const oldContent = applyReverseDiff(activity.diff, current ?? "");
      const ok = await api.fsWrite(root, path, oldContent);
      if (ok) onReverted?.();
    } finally {
      setReverting(false);
    }
  };

  return (
    <div
      className={`tool-card ${activity.status}${isSubagentCard(activity) ? " explore" : ""}`}
    >
      <div
        className={`tool-card-head${collapsible ? " collapsible" : ""}${isWrite ? " write-head" : ""}`}
        onClick={
          isWrite
            ? () => messageId && openReview(messageId, writePath)
            : collapsible
              ? () => setCollapsed((c) => !c)
              : undefined
        }
        role={isWrite || collapsible ? "button" : undefined}
        tabIndex={isWrite || collapsible ? 0 : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        title={isWrite ? "Review changes in the side panel" : undefined}
        onKeyDown={
          isWrite || collapsible
            ? (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (isWrite) {
                  if (messageId) openReview(messageId, writePath);
                } else {
                  setCollapsed((c) => !c);
                }
              }
            }
            : undefined
        }
      >
        <StatusIcon status={activity.status} />
        <span className="tool-name">
          {isWrite ? (
            <>
              <span className="tool-verb">
                {activity.tool === "write_file" ? "Wrote" : "Edited"}
              </span>
              <span className="tool-file" title={writePath}>
                <FileIcon path={writePath} size={20} />
                <span className="tool-file-name" dir="ltr">
                  {writePath.split("/").pop() ?? writePath}
                </span>
              </span>
            </>
          ) : isSubagentCard(activity) ? (
            "sub-agent"
          ) : (
            (TOOL_LABEL[activity.tool] ?? activity.tool)
          )}
        </span>
        {activity.tool === "task" && !!activity.args?.subagent_type && (
          <span className="tool-badge">
            {String(activity.args.subagent_type)}
          </span>
        )}
        {activity.tool === "web_search" && activity.engine && (
          <span className="tool-badge tool-engine-badge">
            {activity.engine}
          </span>
        )}
        {activity.args && activity.args.command !== undefined && (
          <span className="tool-cmd">{String(activity.args.command)}</span>
        )}
        {activity.args && activity.args.path !== undefined && !isWrite && (
          <ToolPathSpan path={String(activity.args.path)} />
        )}
        {activity.args && activity.args.filePath !== undefined && (
          <ToolPathSpan path={String(activity.args.filePath)} />
        )}
        {activity.args &&
          activity.args.filePath !== undefined &&
          (String(activity.args.offset ?? 1) !== "1" ||
            Number(activity.args.limit ?? 2000) < 2000) && (
            <span className="tool-path">
              {`${activity.args.offset ?? 1}–${Number(activity.args.offset ?? 1) + Number(activity.args.limit ?? 2000) - 1}`}
            </span>
          )}
        {activity.args && activity.args.start !== undefined && (
          <span className="tool-path">
            {String(activity.args.start)}
            {activity.args.end !== undefined && activity.args.end !== -1
              ? `–${String(activity.args.end)}`
              : "+"}
          </span>
        )}
        {activity.args && activity.args.query !== undefined && (
          <span className="tool-cmd">
            {fixZwsp(String(activity.args.query))}
          </span>
        )}
        {activity.args && activity.args.pattern !== undefined && (
          <span className="tool-cmd">
            {fixZwsp(String(activity.args.pattern))}
          </span>
        )}
        {activity.args && activity.args.description !== undefined && (
          <span
            className="tool-cmd tool-task"
            title={String(activity.args.description)}
          >
            {fixZwsp(String(activity.args.description))}
          </span>
        )}
        {activity.tool === "task" &&
          activity.children &&
          activity.children.length > 0 && (
            <span className="tool-badge tool-sub-count">
              {activity.children.length} call
              {activity.children.length === 1 ? "" : "s"}
            </span>
          )}
        {activity.tool === "memory" && activity.args && (
          <span className="tool-cmd">
            {fixZwsp(String(activity.args.text || activity.args.subject || ""))}
          </span>
        )}
        {readPaths.length > 0 && (
          <>
            {readPaths.slice(0, 2).map((p, i) => (
              <ToolPathSpan key={i} path={p} />
            ))}
            {readPaths.length > 2 && (
              <span className="tool-path tool-more">
                +{readPaths.length - 2} more
              </span>
            )}
          </>
        )}
        {fetchSummary && (
          <span className="tool-cmd">{fixZwsp(fetchSummary)}</span>
        )}
        {activity.args && <ToolArgs args={activity.args} />}
        {/* Trailing meta in ONE group pinned to the right edge by a single
            auto margin — without this the row only reached the right edge
            when the timer happened to render (write cards have no timer). */}
        <span className="tool-card-head-end">
          {ms ? <span className="tool-ms">{fmtTime(ms)}</span> : null}
          {isWrite &&
            activity.diff &&
            (() => {
              const adds = (activity.diff.match(/^\+[^+]/gm) || []).length;
              const dels = (activity.diff.match(/^-[^-]/gm) || []).length;
              return adds + dels > 0 ? (
                <span className="tool-diff-stats">
                  <span className="review-count-add">+{adds}</span>{" "}
                  <span className="review-count-del">-{dels}</span>
                </span>
              ) : null;
            })()}
          {isWrite && activity.diff && messageId && (
            <button
              className="tool-review-btn"
              title="Open in Review panel"
              onClick={(e) => {
                e.stopPropagation();
                openReview(messageId, writePath);
              }}
            >
              Review ↗
            </button>
          )}
          {isWrite && activity.reverted && (
            <span className="reverted-tag">reverted</span>
          )}
          {collapsible && (
            <span className={`chev${collapsed ? "" : " open"}`}>▾</span>
          )}
        </span>
      </div>

      {collapsed &&
        activity.tool === "task" &&
        activity.children &&
        activity.children.length > 0 && (
          <ToolCascade activities={activity.children} />
        )}
      {/* کارت‌های ویرایش (edit_file/write_file) کوچک می‌مانند — بدون بدنه؛
          دیف فقط در پنل Review سمت راست باز می‌شود (سبک کدکس). */}
      {!collapsed && !isWrite && (
        <div className="tool-card-body">
          {activity.summary && !isWrite && (
            <div className="tool-summary">{fixZwsp(activity.summary)}</div>
          )}
          {activity.tool === "task" &&
            activity.children &&
            activity.children.length > 0 && (
              <div className="tool-sub-list">
                {activity.children.map((child, i) => (
                  <ToolSubRow
                    key={`${child.tool}-${i}-${child.callId ?? i}`}
                    activity={child}
                  />
                ))}
              </div>
            )}
          {activity.tool === "web_search" &&
            (activity.items ?? activity.results) &&
            (activity.items ?? activity.results)!.length > 0 && (
              <WebResultLinks items={(activity.items ?? activity.results)!} />
            )}
          {activity.tool === "run_terminal" &&
            (activity.items ?? activity.results) &&
            (activity.items ?? activity.results)!.length > 0 && (
              <TerminalResultText
                items={activity.items ?? activity.results}
              />
            )}
          {/* فقط ابزارهای غیر-ویرایش دیف را در چت نشان می‌دهند. */}
          {activity.diff && (
            <DiffView
              diff={activity.diff}
              path={reviewPathOf(activity)}
            />
          )}
        </div>
      )}
    </div>
  );
});
