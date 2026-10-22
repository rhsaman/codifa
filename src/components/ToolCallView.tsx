import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  type KeyboardEvent,
} from "react";
import type { ToolActivity, SearchResultItem } from "../types";
import { useStore } from "../lib/store";
import { diffStatsFromUnified, terminalOutputText } from "../lib/toolActivity";
import { reviewPathOf } from "../lib/reviewTurn";
import { parseDiffRows, parseSideBySide } from "../lib/reviewDiff";
import { countOccurrences } from "../lib/diffSearch";
import {
  buildCommentSpans,
  commentSyntax,
  splitCommentSegments,
  type CommentSpan,
} from "../lib/diffComments";
import { highlightSideLines, languageOfPath } from "../lib/highlight";
import { copyToClipboard } from "../lib/clipboard";
import { useViewerTabs } from "../lib/viewerTabs";
import { api } from "../lib/fs";
import { restoreCheckpoint } from "../lib/api";
import { fixZwsp, prepareContent } from "../lib/bidi";
import { fileBasename } from "../lib/fileTypes";
import { handleLinkClick } from "../lib/link";
import { useDragScroll } from "../lib/useDragScroll";
import { FileChip, FileIcon, openWorkspaceFile } from "./FileIcon";
import { createPortal } from "react-dom";
import { commentFileSelection } from "../lib/fileComments";
import { toWorkspacePath } from "../lib/fileTree";
import { selectionBarPos } from "../lib/selectionBar";
import { bareToolName, mcpServerOf } from "../lib/mcpTools";
import { diffPopupPos, type DiffPopPos } from "../lib/hoverCardPos";

/** Shared 500ms ticker for all running-tool clocks. Multi-window can mount
 *  dozens of tool rows; one interval driving every live clock keeps CPU and
 *  wake-ups flat instead of one timer per row. */
const TICK_MS = 500;
let sharedTickId: ReturnType<typeof setInterval> | null = null;
const tickListeners = new Set<() => void>();

function ensureSharedTick(): void {
  if (sharedTickId !== null) return;
  sharedTickId = setInterval(() => {
    for (const cb of tickListeners) cb();
  }, TICK_MS);
  const t = sharedTickId as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

function releaseSharedTick(): void {
  if (tickListeners.size === 0 && sharedTickId !== null) {
    clearInterval(sharedTickId);
    sharedTickId = null;
  }
}

/** Live clock for a running tool row. Ticks every 500ms while `running`,
 *  frozen otherwise — backed by the single shared ticker above. */
export function useRunningClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const cb = () => setNow(Date.now());
    tickListeners.add(cb);
    ensureSharedTick();
    return () => {
      tickListeners.delete(cb);
      releaseSharedTick();
    };
  }, [running]);
  return now;
}

const TOOL_LABEL: Record<string, string> = {
  write_file: "Write File",
  edit_file: "Edit File",
  list_files: "List Directory",
  read: "Read File",
  grep: "Search Files",
  glob: "Search Files",
  find_symbol: "Find Symbol",
  web_search: "Web Search",
  run_terminal: "Ran a command",
  run_tests: "Ran related tests",
  search_memory: "Search Memory",
  memory: "Memory",
  ask_user: "Ask User",
  fetch_url: "Fetch URL",
  explore: "Explore",
  vision: "Vision",
  create_skill: "Create Skill",
  create_mcp: "Create MCP",
  load_skill: "Load Skill",
  update_plan: "Update Plan",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_commit: "Git Commit",
  git_log: "Git Log",
  current_time: "Current Time",
  system_stats: "System Stats",
  computer: "Computer",
  search_console: "Search Console",
};

/** Foreign names for a tool we DO have, mapped to the canonical name.
 *
 *  Models are trained on other agents' vocabularies (`read_client`, `read_file`,
 *  `view_file`, `shell`, `todos`…), so a run can contain calls under a name that
 *  is not ours. `toolLabel` falls back to the RAW name for anything missing from
 *  TOOL_LABEL, which rendered a second, duplicate-looking chip ("Read File ×4"
 *  beside "read_client ×2"). Normalizing here merges old AND new history into
 *  one chip — the backend resolves the same aliases before dispatch. */
export const TOOL_ALIAS: Record<string, string> = {
  read_client: "read",
  read_file: "read",
  readfile: "read",
  view_file: "read",
  read_text_file: "read",
  get_file: "read",
  search_files: "grep",
  search_content: "grep",
  ripgrep: "grep",
  find_files: "glob",
  list_dir: "glob",
  ls: "glob",
  list_directory: "glob",
  shell: "run_terminal",
  bash: "run_terminal",
  sh: "run_terminal",
  run_command: "run_terminal",
  execute_command: "run_terminal",
  search_web: "web_search",
  websearch: "web_search",
  skill: "load_skill",
  create_file: "write_file",
  writefile: "write_file",
  str_replace: "edit_file",
  replace_in_file: "edit_file",
  todos: "update_plan",
  todo_write: "update_plan",
  write_todos: "update_plan",
  update_todos: "update_plan",
  ask: "ask_user",
  ask_question: "ask_user",
  permission: "confirm_action",
  request_permission: "confirm_action",
};

/** Canonical tool name for a raw one (case / dash / underscore-insensitive). */
export function canonicalTool(tool: string): string {
  const aliased =
    TOOL_ALIAS[tool] ??
    TOOL_ALIAS[tool.trim().toLowerCase().replace(/[-\s]/g, "_")] ??
    tool;
  // Case-only variants of a REAL name (`Read`, `read_File`) still normalize.
  const direct = Object.keys(TOOL_LABEL).find(
    (k) => k.toLowerCase() === aliased.trim().toLowerCase(),
  );
  return direct ?? aliased;
}

/** Small glyph per tool category, shown at the head of each collapsed-group
 *  timeline row — lets the eye scan a run of calls without reading every
 *  label (mirrors Claude-app's trace icons). */
const TOOL_ICON: Record<string, string> = {
  run_terminal: "❯",
  run_tests: "🧪",
  list_files: "📁",
  read: "📄",
  grep: "🔍",
  glob: "🔍",
  find_symbol: "🔎",
  web_search: "🌐",
  fetch_url: "🌐",
  search_memory: "🧠",
  memory: "🧠",
  ask_user: "❓",
  explore: "🔍",
  vision: "🖼",
  create_skill: "⚙",
  create_mcp: "🔌",
  load_skill: "📘",
  update_plan: "📝",
  git_status: "🌿",
  git_diff: "📊",
  git_commit: "✅",
  git_log: "🕘",
  current_time: "🕒",
  system_stats: "📊",
  computer: "🖥",
  search_console: "🔎",
};
function toolIcon(tool: string): string {
  return TOOL_ICON[tool] ?? "•";
}

/** MCP tools arrive as `mcp__<server>__<tool>`: show the bare tool name with
 *  the connector as a suffix so the card stays readable. A tool whose name is
 *  unique across the enabled connectors arrives BARE already. */
export function toolLabel(tool: string): string {
  const server = mcpServerOf(tool);
  if (server) return `${bareToolName(tool)} · ${server}`;
  const canonical = canonicalTool(tool);
  return TOOL_LABEL[canonical] ?? canonical;
}

/** Natural-language piece per tool category for the group header sentence
 *  ("9 commands, 3 searches, 2 notes") — the Claude-app-style summary line
 *  instead of a raw tool-name tally. */
const TOOL_NOUN: Record<string, [string, string]> = {
  run_terminal: ["command", "commands"],
  run_tests: ["test run", "test runs"],
  list_files: ["file listing", "file listings"],
  read: ["file read", "file reads"],
  grep: ["search", "searches"],
  glob: ["search", "searches"],
  find_symbol: ["symbol lookup", "symbol lookups"],
  web_search: ["web search", "web searches"],
  fetch_url: ["page fetch", "page fetches"],
  search_memory: ["memory search", "memory searches"],
  memory: ["note", "notes"],
  ask_user: ["question", "questions"],
  explore: ["explore run", "explore runs"],
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
      const name = toolLabel(tool);
      return n > 1 ? `${name} ×${n}` : name;
    })
    .join(", ");
}

/** A sub-agent card (explore) — renders with the dedicated sub-agent card
 *  layout and its "explore" CSS class. There is ONE sub-agent tool name:
 *  pre-rename transcripts that recorded the old `task`/`subagent` names are
 *  folded into `explore` at BOTH ingest points (normalizeToolName in
 *  makeToolActivity for the live stream, normalizeToolActivity for the store's
 *  load migration), so a card reaching this predicate always says `explore`. */
export const isSubagentCard = (a: ToolActivity) => a.tool === "explore";

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
  // Click-opened diff preview. The content is snapshotted by the hook at open
  // time (see `useDiffPreview`), so a streaming `diff` event can neither
  // unmount the card nor reset the scroll/selection inside it. A row click goes
  // through to the Review panel — the preview opens only from the `Review ↗`
  // pill.
  const preview = useDiffPreview();
  const running = activities.some((a) => a.activity.status === "running");
  const { adds, dels } = editGroupStats(activities);
  // Live clock so the group total ticks while any file edit is still running.
  const now = useRunningClock(running);
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
      const { content: current } = (await api.fsRead(root, path)) ?? {};
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
                {/* A div with button semantics, not a real <button>: the
                    `Review ↗` pill below is a real button and must not be
                    nested inside another one. */}
                <div
                  className="edit-group-row-main"
                  role="button"
                  tabIndex={0}
                  title={path ? toWorkspacePath(root, path) : undefined}
                  onClick={() => messageId && openReview(messageId, path)}
                  onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (messageId) openReview(messageId, path);
                    }
                  }}
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
                    {entry.activity.diff && (
                      <button
                        type="button"
                        className="trace-row-review"
                        title="Preview diff"
                        onClick={(e) => {
                          // The pill sits inside the row's clickable area, which
                          // opens the Review panel: this click is the preview,
                          // not the panel.
                          e.stopPropagation();
                          preview.open(
                            e.currentTarget.closest(".edit-group-row"),
                            entry.activity.diff,
                            reviewPathOf(entry.activity),
                          );
                        }}
                      >
                        Review ↗
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {preview.snap &&
        typeof document !== "undefined" &&
        createPortal(
          <DiffPreview
            diff={preview.snap.diff}
            path={preview.snap.path}
            pos={preview.snap.pos}
            onClose={preview.close}
            onPress={preview.keep}
          />,
          document.body,
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

export function IconChevron({
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

/** Running → spinner, done → check, error → ✗, denied → ⏹. Exported so the
 *  explore/sub-agent card shows the exact same glyphs as every tool row. */
export function StatusIcon({ status }: { status: ToolActivity["status"] }) {
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

/** Human label for a web-search engine kind (`duckduckgo` → DuckDuckGo). The
 *  backend reports the kind that actually answered the query — a fallback may
 *  have served it, so the settings primary is not necessarily the right one. */
function webProviderLabel(kind: string): string {
  switch (kind) {
    case "duckduckgo":
      return "DuckDuckGo";
    case "tavily":
      return "Tavily";
    default:
      return kind;
  }
}

/** Tools whose rows are web hits/fetched pages rather than files. */
function isWebRow(activity: ToolActivity): boolean {
  return activity.tool === "web_search" || activity.tool === "fetch_url";
}

/** The hits of a `web_search` / `fetch_url` row. Rendered at the bottom of the
 *  row's OWN expanded body — never as a sibling block hanging outside the tool
 *  call — so folding the call tucks the list back inside it. Web rows therefore
 *  start expanded (see `TraceRow` / `ToolSingleRow`). */
const InlineWebResults = memo(function InlineWebResults({
  activity,
}: {
  activity: ToolActivity;
}) {
  const rows = activity.items ?? activity.results;
  if (!isWebRow(activity) || !rows || rows.length === 0) return null;
  return (
    <div className="trace-row-inline-results">
      <WebResultLinks items={rows} />
    </div>
  );
});

/** How many web hits the collapsed list shows before "+N more". */
const WEB_RESULTS_VISIBLE = 3;

/** Shared, beautifully-styled list of web_search result links. Rendered in
 *  EVERY tool view (full card, single row, timeline row) so the links the
 *  model found are always visible — not just in the expanded card. Pure
 *  presentational component (no store/fullscreen hooks) so it can be
 *  unit-tested in isolation.
 *
 *  Collapsed to `WEB_RESULTS_VISIBLE` rows: a 5-10 hit search used to render a
 *  wall of full-height cards that pushed every following tool row off screen.
 *  The hidden rows open IN PLACE — these are links the user clicks, so the
 *  FileResultLinks pattern (dump the rest into the side panel) would make them
 *  unusable.
 *
 *  Each row may carry `fetched` from the backend: `true` = real page content
 *  reached the model, `false` = the fetch failed and only the snippet did. That
 *  flag and the "N results · M fetched" line are the only way to tell a thin
 *  answer caused by a broken fetch from one caused by bad results. */
export const WebResultLinks = memo(function WebResultLinks({
  items,
}: {
  items: SearchResultItem[];
}) {
  // Hooks run before the empty-list bail-out (rules of hooks).
  const [showAll, setShowAll] = useState(false);
  if (!items || items.length === 0) return null;
  // Only rows that actually carry the flag count — an old transcript shows no
  // badge and no count line at all.
  const fetchInfo = items.filter((it) => typeof it.fetched === "boolean");
  const fetchedCount = fetchInfo.filter((it) => it.fetched).length;
  const visible = showAll ? items : items.slice(0, WEB_RESULTS_VISIBLE);
  const hidden = items.length - visible.length;
  return (
    <>
      {fetchInfo.length > 0 && (
        <div className="web-results-head" dir="auto">
          <span className="web-results-count">
            {`${items.length} result${items.length === 1 ? "" : "s"}`}
          </span>
          <span className="web-results-sep" aria-hidden="true">
            ·
          </span>
          <span
            className={`web-results-fetched${fetchedCount === 0 ? " none" : ""}`}
            title="Results whose real page content was fetched. The rest reached the model as a short snippet only."
          >
            {`${fetchedCount} fetched`}
          </span>
        </div>
      )}
      <ul className="web-results" dir="auto">
        {visible.map((it, i) => {
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
              {/* Flag only the EXCEPTION (snippet-only) rows: a chip on every
                  successfully fetched row would just be noise on a 10-row list,
                  while a missing page is the thing worth noticing. */}
              {it.fetched === false && (
                <span
                  className="web-result-fetched"
                  title="This page could not be fetched — only the short search snippet reached the model."
                >
                  snippet
                </span>
              )}
              <span className="web-result-host">{host}</span>
              <span className="web-result-arrow" aria-hidden="true">
                ↗
              </span>
            </a>
          </li>
        );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="web-result-more-btn"
          onClick={() => setShowAll(true)}
          title="Show every result"
        >
          {`+${hidden} more`}
        </button>
      )}
      {showAll && items.length > WEB_RESULTS_VISIBLE && (
        <button
          type="button"
          className="web-result-more-btn"
          onClick={() => setShowAll(false)}
        >
          Show less
        </button>
      )}
    </>
  );
});

/** متن خروجی ترمینال (`run_terminal`): آیتم‌ها فقط فیلد `content` دارند
 *  (بدون `file`/`path`/`url`) پس `FileResultLinks` خالی رندر می‌شود.
 *  خروجی بلند با `trace-expand-pre` اسکرول عمودی می‌خورد. */
export const TerminalResultText = function TerminalResultText({
  items,
  fallbackText,
}: {
  items: unknown;
  /** Plain `event.result` string when the sidecar sent no result rows. */
  fallbackText?: string;
}) {
  const text = terminalOutputText(items) || fallbackText || "";
  if (!text) return null;
  // Long output scrolls inside this block (.trace-terminal-output max-height);
  // it never hops to the side panel (user request).
  return (
    <pre
      className="trace-expand-val trace-expand-pre trace-terminal-output"
      dir="ltr"
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
  // Dedupe identical entries (same file + line + text). A read with several
  // ranges on one file emits one result per window, so without this the list
  // shows the same path N times. Distinct lines (grep hits) keep their own
  // rows since the line/text part of the key differs.
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const it of items) {
    const file = String(it.file ?? it.path ?? "");
    if (!file) continue;
    const line =
      it.line !== undefined && it.line !== null ? String(it.line) : "";
    const text = String(it.text ?? "");
    const key = `${file}\0${line}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  if (deduped.length === 0) return null;
  // Every hit renders right here and the list scrolls (.file-results carries a
  // max-height): the row expands IN PLACE — results never hop to the side
  // panel (user request).
  return (
    <ul className="file-results" dir="ltr" aria-label={`${tool} results`}>
      {deduped.map((it, i) => {
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
              // Basename only in the UI — the full path stays in the tooltip.
              display={`${fileBasename(file)}${line ? `:${line}` : ""}`}
            />
            {text && <span className="file-result-text">{text}</span>}
          </li>
        );
      })}
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

/** Args the row head/subtitle already states for one tool: repeating them as
 *  `key: value` chips only adds noise (`name:ponytail` beside the skill's own
 *  name). Scoped per tool so e.g. `create_skill` keeps showing its `name`. */
const REDUNDANT_ARG_KEYS: Record<string, Set<string>> = {
  load_skill: new Set(["name", "file", "query"]),
};

/** Remaining args rendered as clean `key: value` chips inside the card head —
 *  no raw JSON blob in the body. */
function ToolArgs({
  args,
  tool,
}: {
  args: Record<string, unknown>;
  tool?: string;
}) {
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(tool ?? "")];
  const entries = Object.entries(args).filter(
    ([k]) =>
      !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k) && !skip?.has(k),
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

/** Expanded-body arg dump. Shared by both row variants so they can never drift,
 *  and filtered so a tool's already-stated args are not printed twice. */
function argsTextFor(activity: ToolActivity): string {
  const args = activity.args;
  if (!args) return "";
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(activity.tool)];
  return Object.entries(args)
    .filter(([k]) => !skip?.has(k))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** One-line row detail: the skill name for `load_skill` (its backend summary is
 *  only the tool name, which the label already shows), else the backend
 *  summary, else whatever the args say. */
function rowDetail(activity: ToolActivity): string {
  if (canonicalTool(activity.tool) === "load_skill") {
    const name = String(activity.args?.name ?? activity.args?.file ?? "");
    if (name) return shortArg(name, 60);
  }
  return activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
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

/** یک خط دیف: سینتکس‌هایلایتِ همان زبان فایل (با رنگ‌های تم فعال)،
 *  و اگر زبانی برایش ثبت نشده باشد فقط کامنت‌هایش کم‌رنگ می‌شوند.
 *  وقتی کوئری جست‌وجو فعال است، رخدادها با <mark> هایلایت می‌شوند و
 *  رخداد فعال (`activeHit`) کلاس متمایز می‌گیرد تا با دکمه‌های عقب/جلو دیده شود. */
function DiffLineText({
  text,
  path,
  html,
  commentSpans,
  query,
  hitBase = 0,
  activeHit = -1,
  activeRef,
}: {
  text: string;
  path?: string;
  /** HTML سینتکس‌هایلایت‌شدهٔ همین خط — متنِ کاملِ یک سمت با هم هایلایت
   *  می‌شود تا توکن‌های چندخطی رنگشان را از دست ندهند. */
  html?: string;
  commentSpans?: CommentSpan[];
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
  // highlight.js already colours comments (--text-dim) and keeps a block
  // comment coloured across every line it spans, so the manual splitter below
  // is only the fallback for extensions it has no grammar for.
  if (html != null) {
    return (
      <span
        className="diff-code"
        dir="auto"
        dangerouslySetInnerHTML={{ __html: html === "" ? "\n" : html }}
      />
    );
  }
  const segments = splitCommentSegments(text, commentSpans);
  if (segments.length === 1 && !segments[0].comment) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.comment ? (
          <span key={i} className="diff-comment">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
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

/** Build the quoted string for a diff highlight, embedding line info
 *  directly so no API change is needed. Falls back to `[path] text` when
 *  no line number is found in the DOM. */
export function diffQuoteForSelection(
  container: HTMLElement,
  sel: Selection,
  path: string,
  text: string,
): string {
  const nums: number[] = [];
  const collect = (node: Node | null) => {
    if (!node) return;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || typeof el.closest !== "function") return;
    const lined = el.closest("[data-lineno]");
    if (lined) {
      const n = parseInt(lined.getAttribute("data-lineno") ?? "", 10);
      if (Number.isFinite(n)) {
        nums.push(n);
        return;
      }
    }
    const row = el.closest(".diff-u-row, .diff-line");
    if (row) {
      const numText = row.querySelector(".diff-u-num")?.textContent?.trim() ?? "";
      const n = parseInt(numText, 10);
      if (numText !== "" && Number.isFinite(n)) {
        nums.push(n);
        return;
      }
      const all = Array.from(container.querySelectorAll(".diff-u-row, .diff-line"));
      const idx = all.indexOf(row);
      if (idx >= 0) nums.push(idx + 1);
    }
  };
  collect(sel.anchorNode);
  if (sel.focusNode && sel.focusNode !== sel.anchorNode) collect(sel.focusNode);
  if (nums.length === 0) return `[${path}] ${text}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return `[${path} line ${min}] ${text}`;
  return `[${path} lines ${min}-${max}] ${text}`;
}

/** دیف به سبک کدکس — واکنش‌گرا: در عرض کم تک‌ستونی، در عرض زیاد دوستونی.
 *  هر جفت delete+add به دو خط جدا (قرمز سپس سبز) باز می‌شود.
 *  `query` رخدادهای جست‌وجو را هایلایت می‌کند؛ `activeHit` ایندکس محلی
 *  رخداد فعال داخل همین دیف است (‎-1‎ یعنی هیچ‌کدام) که خودکار اسکرول می‌شود.
 *  `layout` حالت نما را اجبار می‌کند (`auto` عرض کانتینر را با ناظر تغییراندازه
 *  می‌سنجد) و `threshold` آستانه‌ی سوییچ خودکار است. */
/** Click-opened preview of an edit/write diff, floating over the chat.
 *
 *  The diff never opens inline (Codex-style: the card stays one quiet line), so
 *  the `Review ↗` pill on each row opens this card instead — the change can be
 *  read without leaving the transcript — while a click on the row itself still
 *  sends the whole turn to the side Review panel. It renders the very same
 *  `DiffView` the Review panel uses, so colours and layout match.
 *
 *  Deliberately click-only. An earlier version followed the pointer and could
 *  not work: the card lands exactly where the cursor already is, so the row
 *  underneath reported `pointerleave` the moment the card appeared and closed
 *  the thing that had just opened.
 */
const DiffPreview = memo(function DiffPreview({
  diff,
  path,
  pos,
  onClose,
  onPress,
}: {
  diff: string;
  path?: string;
  pos: DiffPopPos;
  onClose: () => void;
  /** Keeps a press inside the card from counting as an outside press. */
  onPress?: () => void;
}) {
  const basename = path ? path.split("/").pop() ?? path : "";
  return (
    <div
      className="diff-preview-card"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 9998,
      }}
      role="dialog"
      aria-label={basename ? `Diff preview for ${basename}` : "Diff preview"}
      dir="ltr"
      onPointerDown={onPress}
    >
      {/* The head renders even without a path so the ✕ is always reachable. */}
      <div className="diff-preview-head">
        {path && <FileIcon path={path} size={16} />}
        <span className="diff-preview-path" dir="auto" title={path}>
          {basename}
        </span>
        <button
          type="button"
          className="diff-preview-close"
          title="Close preview"
          aria-label="Close diff preview"
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      {/* select → Copy / Reply exactly like the Review panel. Both the toolbar
          and the comment editor are portaled to document.body, i.e. OUTSIDE
          this card: the hook that owns it keeps presses on them from closing
          it (see `useDiffPreview`). */}
      <div className="diff-preview-body">
        <DiffView diff={diff} path={path} layout="unified" />
      </div>
    </div>
  );
});

/** Click-opened diff preview state, shared by the three edit surfaces (edit
 *  card, trace row, grouped edit rows).
 *
 *  No hover behaviour by design: the card would be portaled on top of the
 *  cursor, so the row underneath reports `pointerleave` the moment it appears
 *  and a hover-opened card closes itself immediately (that was the very bug
 *  this replaced). It opens from the `Review ↗` pill, anchored to the row that
 *  owns it, and closes on ✕, Escape, or a press outside it.
 */
function useDiffPreview() {
  // The OPEN SNAPSHOT, not a live view. While the agent streams, every diff
  // event replaces `activity` with a fresh object and briefly blanks
  // `activity.diff`; a portal gated on the live value therefore unmounted and
  // remounted the card mid-read, which reset both scroll offsets and destroyed
  // any text selection inside it (a DOM selection cannot survive its node being
  // removed). Freezing diff/path at open time is what makes reading + selecting
  // stable while the turn is still running.
  const [snap, setSnap] = useState<
    { diff: string; path?: string; pos: DiffPopPos } | null
  >(null);
  // When it was opened. The press that opened it is still propagating up to
  // document while the listeners below get attached, so a press immediately
  // after an open is ignored instead of closing what it just opened.
  const openedAt = useRef(0);
  const open = useCallback((el: Element | null | undefined, diff: string | undefined, path?: string) => {
    if (!el || !diff || typeof window === "undefined") return;
    openedAt.current = Date.now();
    setSnap({
      diff,
      path,
      pos: diffPopupPos(
        el.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      ),
    });
  }, []);
  const close = useCallback(() => setSnap(null), []);
  /** A press landed inside the card: same grace as opening, so interacting with
   *  the diff (scrolling by dragging, selecting) never closes it. */
  const keep = useCallback(() => {
    openedAt.current = Date.now();
  }, []);
  useEffect(() => {
    if (!snap) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSnap(null);
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== "function") return;
      // The Copy/Reply toolbar and the comment editor are portaled to
      // document.body — outside the card — so pressing them must keep it open.
      if (t.closest(".diff-preview-card, .fv-sel-bar, .fv-comment-float")) return;
      if (Date.now() - openedAt.current < 250) return;
      setSnap(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [snap]);
  return { snap, open, close, keep };
}

export function DiffView({
  diff,
  path,
  query,
  activeHit = -1,
  layout = "auto",
  threshold = DIFF_SIDE_BY_SIDE_THRESHOLD,
  commentable = true,
}: {
  diff: string;
  path?: string;
  query?: string;
  activeHit?: number;
  layout?: DiffLayoutMode;
  threshold?: number;
  commentable?: boolean;
}) {
  const rows = parseDiffRows(diff);
  const sideItems = parseSideBySide(diff);
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
  // Syntax highlighting for the diff: each file side is highlighted as ONE
  // text (not line by line), so a token that spans lines — doc comment,
  // template literal, docstring — keeps its colour on all of its lines. The
  // result is keyed by gutter line number and shared by both layouts.
  const lang = languageOfPath(path);
  const { beforeHtml, afterHtml, beforeSpans, afterSpans } = useMemo(() => {
    const before: { lineNo: number; text: string }[] = [];
    const after: { lineNo: number; text: string }[] = [];
    for (const row of rows) {
      if ("text" in row) continue;
      if (row.type === "add") {
        after.push({ lineNo: row.aLine, text: row.after });
      } else if (row.type === "del") {
        before.push({ lineNo: row.bLine, text: row.before });
      } else {
        before.push({ lineNo: row.bLine, text: row.before });
        after.push({ lineNo: row.aLine, text: row.after });
      }
    }
    const syntax = commentSyntax(path);
    return {
      beforeHtml: highlightSideLines(before, lang),
      afterHtml: highlightSideLines(after, lang),
      beforeSpans: buildCommentSpans(before, syntax),
      afterSpans: buildCommentSpans(after, syntax),
    };
  }, [rows, path, lang]);

  const activeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff]);
  const chatId = useStore((s) => s.activeChatId);
  const [box, setBox] = useState<{ base: string; x: number; y: number } | null>(null);
  // Copy/Reply toolbar armed by a highlight — same two-step flow as the file
  // viewer: a selection never yanks focus into the textarea, the editor opens
  // only after Reply.
  const [selBar, setSelBar] = useState<{ base: string; x: number; y: number } | null>(null);
  const [note, setNote] = useState("");
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Focus without scrolling so the diff highlight stays put (same as FileViewerPanel).
  useEffect(() => {
    if (!box) return;
    const id = requestAnimationFrame(() => {
      try {
        commentInputRef.current?.focus?.({ preventScroll: true } as FocusOptions);
      } catch {
        commentInputRef.current?.focus?.();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [box]);
  // Outside press dismisses like Esc (no send); presses inside the diff only move the box.
  useEffect(() => {
    if (!box && !selBar) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(".fv-comment-float, .fv-sel-bar")) return;
      const container = measureRef.current;
      if (container && t instanceof Element && container.contains(t)) return;
      setBox(null);
      setSelBar(null);
      setNote("");
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [box, selBar]);
  if (rows.length === 0) return null;
  const closeBox = () => {
    setBox(null);
    setNote("");
  };
  const closeSelBar = () => {
    setSelBar(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  };
  /** Reply: open the comment editor at the armed toolbar position. */
  const openBox = () => {
    if (!selBar) return;
    setBox({ base: selBar.base, x: selBar.x, y: selBar.y });
    setSelBar(null);
    setNote("");
  };
  /** Copy: put the highlighted text on the clipboard and dismiss the toolbar.
   *  The LIVE selection wins over the frozen diff quote — the quote carries a
   *  "[path line N]" header for the agent, which must never reach the
   *  clipboard when the user only asked to copy the highlighted text. */
  const copySelection = () => {
    if (!selBar) return;
    let live = "";
    try {
      live = window.getSelection()?.toString().trim() ?? "";
    } catch {
      live = "";
    }
    void copyToClipboard(live || selBar.base);
    closeSelBar();
  };
  const sendBox = (queued?: boolean) => {
    if (!box || !chatId) {
      closeBox();
      return;
    }
    const filePath = path ?? "diff";
    const trimmed = note.trim();
    const quote = trimmed ? `${box.base}\n\nNote: ${trimmed}` : box.base;
    // Extract line range from the frozen diff quote ([path line N] /
    // [path lines A-B]) so the agent message carries File/Lines directly.
    const lineMatch = box.base.match(/\[.* lines? (\d+(?:-\d+)?)\]/);
    const target = lineMatch ? `${filePath}:${lineMatch[1]}` : filePath;
    commentFileSelection(chatId, target, quote, { queue: queued });
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* keep highlight on failure */
    }
    closeBox();
  };
  const refreshHighlight = () => {
    if (!commentable) return;
    // Freeze while the editor is open: focusing its textarea must not rewrite
    // the frozen quote (a new highlight requires closing first).
    if (box) return;
    const container = measureRef.current;
    if (!container) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || !container.contains(sel.anchorNode)) return;
    if (sel.isCollapsed) {
      if (selBar) setSelBar(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      if (selBar) setSelBar(null);
      return;
    }
    const filePath = path ?? "diff";
    const base = diffQuoteForSelection(container, sel, filePath, text.slice(0, 500));
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (rect && typeof window !== "undefined") {
        setSelBar({
          base,
          ...selectionBarPos(rect, window.innerWidth, window.innerHeight),
        });
        return;
      }
    } catch {
      /* fall through to default position */
    }
    setSelBar({ base, x: 16, y: 96 });
  };
  // شمارنده‌ی ترتیبی رخدادها در ترتیب رندر خط‌ها.
  let hitCursor = 0;
  const renderRow = (
    key: number | string,
    cls: "diff-u-add" | "diff-u-del" | "diff-u-ctx",
    gutter: string,
    lineNo: number,
    text: string,
    side: "before" | "after" | "both",
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
            html={
              side === "before"
                ? beforeHtml.get(lineNo)
                : side === "after"
                  ? afterHtml.get(lineNo)
                  : (afterHtml.get(lineNo) ?? beforeHtml.get(lineNo))
            }
            commentSpans={
              side === "before"
                ? beforeSpans.get(lineNo)
                : side === "after"
                  ? afterSpans.get(lineNo)
                  : (afterSpans.get(lineNo) ?? beforeSpans.get(lineNo))
            }
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
    side: "before" | "after",
  ) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    // Side-by-side cells carry the same −/+ marker + coloured left bar as the
    // unified rows. The `.diff-line-del/-add .diff-u-gutter` rules depend on
    // this span existing — without it the column had no add/remove cue at all
    // (the row background is transparent by design).
    const marker =
      cls === "diff-line-del" ? "-" : cls === "diff-line-add" ? "+" : " ";
    return (
      <span key={key} className={`diff-line ${cls}`}>
        <span className="diff-u-gutter">{empty ? "" : marker}</span>
        <span className="diff-u-num">{!empty && lineNo >= 0 ? lineNo : ""}</span>
        <span className="diff-u-text">
          {!empty ? (
            <DiffLineText
              text={text}
              path={path}
              html={
                side === "before"
                  ? beforeHtml.get(lineNo)
                  : afterHtml.get(lineNo)
              }
              commentSpans={
                side === "before"
                  ? beforeSpans.get(lineNo)
                  : afterSpans.get(lineNo)
              }
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
                    return renderSideCell(`${ri}-b`, "", r.bLine, r.before, false, "before");
                  if (r.type === "del" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-b`,
                      "diff-line-del",
                      r.bLine,
                      r.before,
                      false,
                      "before",
                    );
                  return renderSideCell(`${ri}-b`, "diff-line-empty", -1, "", true, "before");
                })}
              </pre>
            </div>
            <div className="diff-col diff-col-after">
              <pre className="diff-col-code">
                {contents.map((r, ri) => {
                  if ("text" in r) return null;
                  if (r.type === "same")
                    return renderSideCell(`${ri}-a`, "", r.aLine, r.after, false, "after");
                  if (r.type === "add" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-a`,
                      "diff-line-add",
                      r.aLine,
                      r.after,
                      false,
                      "after",
                    );
                  return renderSideCell(`${ri}-a`, "diff-line-empty", -1, "", true, "after");
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
          return renderRow(i, "diff-u-ctx", " ", row.aLine, row.after, "both");
        if (row.type === "del")
          return renderRow(i, "diff-u-del", "-", row.bLine, row.before, "before");
        if (row.type === "add")
          return renderRow(i, "diff-u-add", "+", row.aLine, row.after, "after");
        // mod: خط قدیمی قرمز + خط جدید سبز، هر دو با شماره‌ی خودشان.
        return [
          renderRow(`${i}-d`, "diff-u-del", "-", row.bLine, row.before, "before"),
          renderRow(`${i}-a`, "diff-u-add", "+", row.aLine, row.after, "after"),
        ];
      })}
    </div>
  );

  return (
    <div
      ref={measureRef}
      className="diff-responsive"
      data-layout={showSide ? "side-by-side" : "unified"}
      onMouseUp={refreshHighlight}
      onKeyUp={refreshHighlight}
    >
      {showSide ? renderSide() : renderUnified()}
      {commentable && selBar && !box && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-sel-bar"
              style={{ position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="fv-sel-btn"
                title="Copy"
                aria-label="Copy selection"
                onClick={copySelection}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>
              <button
                type="button"
                className="fv-sel-btn"
                title="Reply"
                aria-label="Reply to selection"
                onClick={openBox}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
              </button>
            </div>,
            document.body,
          )
        : null}
      {commentable && box && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-comment-float"
              style={{
                position: "fixed",
                left: box.x,
                top: box.y,
                zIndex: 9999,
              }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <textarea
                ref={commentInputRef}
                className="fv-comment-input"
                dir="auto"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onMouseUp={(e) => e.stopPropagation()}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    try {
                      window.getSelection()?.removeAllRanges();
                    } catch {
                      /* ignore */
                    }
                    closeBox();
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendBox(true);
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendBox(false);
                  }
                }}
                rows={2}
                placeholder="Write a comment… Enter to send, Esc to cancel"
                aria-label="Comment on diff highlight"
              />
            </div>,
            document.body,
          )
        : null}
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
  // A run that contains a web call opens by default: the hits live INSIDE those
  // rows, so a collapsed head would hide the search payload behind a click.
  const [open, setOpen] = useState(() =>
    activities.some(({ activity }) => isWebRow(activity)),
  );
  const running = activities.some((a) => a.activity.status === "running");
  // Live clock so the group total ticks while any call is still running.
  const now = useRunningClock(running);
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
  // Sub-agent cards (explore) are NOT counted into the label pills:
  // each one gets its own pill carrying the short description of what it is
  // looking for, so two parallel explores are distinguishable at a glance
  // instead of collapsing into a single "Explore ×2".
  const subagentPills = activities
    .filter(({ activity }) => isSubagentCard(activity))
    .map(({ activity, index }) => ({
      key: index,
      label: toolLabel(activity.tool),
      desc: shortArg(String(activity.args?.description ?? ""), 70),
      running: activity.status === "running",
    }));
  const toolCounts = activities.reduce<Record<string, number>>((acc, a) => {
    if (isSubagentCard(a.activity)) return acc;
    const label = toolLabel(a.activity.tool);
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
          {subagentPills.map(({ key, label, desc, running }) => (
            <span
              key={`sub-${key}`}
              className={`trace-pill trace-pill-sub${running ? " running" : ""}`}
              title={desc || label}
            >
              {label}
              {desc && <span className="trace-pill-desc">{desc}</span>}
            </span>
          ))}
        </span>
        {searchEngines.map((engine) => (
          <span
            key={engine}
            className="trace-row-engine"
            title="Web search provider"
          >
            {webProviderLabel(engine)}
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
      {/* The hits of a search belong to the individual `web_search` row: they
          are rendered INSIDE that row while it is expanded, so a collapsed
          group head stays a single compact line. */}
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
 *  old path-only summary missed (run_terminal, memory, fetch_url…). */
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

  // load_skill: the skill's own name is the whole story — printing `name:x`
  // as a `key:value` arg (the generic fallback below) reads like machine output.
  if (canonicalTool(activity.tool) === "load_skill") {
    const skill = String(args.name ?? args.file ?? "");
    if (skill) return shortArg(skill, 60);
    const q = String(args.query ?? "");
    return q ? shortArg(q, 48) : "";
  }

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
    // Basename only — the full path must not clutter the row head.
    const slash = p.lastIndexOf("/");
    parts.push(slash >= 0 ? p.slice(slash + 1) : p);
  }

  // grep/glob/web_search: pattern or query — capped: the sub-agent merges
  // alternatives into one big `a|b|c` regex, which as raw text is unreadable.
  const pattern = String(args.pattern ?? args.query ?? "");
  if (pattern) parts.push(shortArg(pattern, 48));

  // explore: the short description (the full card shows it as the task chip)
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
  hideResult,
}: {
  activity: ToolActivity;
  /** Suppress the prose result block (used by the collapsed cascade preview,
   *  where a `read` would otherwise paste an entire file into the card). */
  hideResult?: boolean;
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
    <>
      <div
        className={`tool-sub-row ${activity.status}${running ? " running" : ""}`}
      >
        <StatusIcon status={activity.status} />
        <span className="tool-sub-name">
          {toolLabel(activity.tool)}
        </span>
        <span className="tool-sub-args" title={subSummary}>
          {subSummary}
        </span>
        {/* The backend stamps the tool NAME as the summary; for a skill load
            that only repeats the label, so the row would read
            "Load Skill  ponytail  load_skill". */}
        {activity.summary && canonicalTool(activity.tool) !== "load_skill" && (
          <span className="tool-sub-summary">{fixZwsp(activity.summary)}</span>
        )}
        <span className="tool-ms">{fmtTime(ms)}</span>
      </div>
      {/* Text-output tools (LSP lookups, memory search, read windows) have no
          file rows of their own, so their prose result is the only output —
          show it under the row. */}
      {activity.resultText && !hideResult && (
        <pre className="tool-sub-result" dir="auto">
          {activity.resultText}
        </pre>
      )}
    </>
  );
});

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
  // edit_file / write_file and web rows always start open: a diff and a search
  // result list are the payload of their row, so a collapsed line would hide
  // them. A fold click still tucks the content inside the call.
  const [expanded, setExpanded] = useState(
    () =>
      activity.tool === "edit_file" ||
      activity.tool === "write_file" ||
      isWebRow(activity),
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
  const label = toolLabel(activity.tool);
  const detail = rowDetail(activity);

  const argsText = argsTextFor(activity);

  const isEdit =
    activity.tool === "edit_file" || activity.tool === "write_file";
  // Every row expands IN PLACE: args / result / results stay inside the row
  // (long bodies scroll) — a click never opens the side panel (user request).
  const onHeadClick = () => setExpanded((e) => !e);

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
          <span className="trace-row-engine" title="Web search provider">
            {webProviderLabel(activity.engine)}
          </span>
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
          {/* The backend stamps the tool NAME as the summary; for a skill load
              that only repeats the head label — the skill name is the real
              detail. */}
          {activity.summary &&
            canonicalTool(activity.tool) !== "load_skill" && (
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
          {activity.resultText && activity.tool !== "run_terminal" && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Result</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">
                {activity.resultText}
              </pre>
            </div>
          )}
          {/* The hits of a `web_search` / `fetch_url` row belong to THIS row:
              they render at the bottom of its own expanded body — never as a
              sibling block hanging outside the tool call — and the row starts
              expanded so the payload shows without a second click. Folding the
              row tucks them back inside the collapsed call. */}
          {isWebRow(activity) && <InlineWebResults activity={activity} />}
          {/* The `Results` section below is the FILE-path list (read / grep /
              terminal); web rows already rendered their links above. */}
          {!isWebRow(activity) &&
            (((activity.items ?? activity.results)?.length ?? 0) > 0 ||
              (activity.tool === "run_terminal" &&
                Boolean(activity.resultText))) && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                  fallbackText={activity.resultText}
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
        {toolLabel(activity.tool)}
      </span>
      {detail && (
        <span className="tool-timeline-detail" title={detail}>
          {detail}
        </span>
      )}
      <StatusIcon status={activity.status} />
      <span className="tool-ms">{fmtTime(ms)}</span>
      {(activity.items ?? activity.results) &&
        (activity.items ?? activity.results)!.length > 0 &&
        (activity.tool === "web_search" || activity.tool === "fetch_url" ? (
          <WebResultLinks items={activity.items ?? activity.results!} />
        ) : (
          <FileResultLinks
            tool={activity.tool}
            items={(activity.items ??
              activity.results) as unknown as Array<Record<string, unknown>>}
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
          <ToolSubRow activity={a} hideResult />
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
  // A web row starts EXPANDED: the search hits are its payload, so they should
  // be visible inside the call from the first paint (a blank one-line row hides
  // the very thing the user asked for). Folding it tucks the list back into the
  // collapsed call. Every other tool starts collapsed.
  const [expanded, setExpanded] = useState(() => isWebRow(activity));
  // Edit rows open their diff preview from the `Review ↗` pill (click) and send
  // a plain row click to the side Review panel.
  const preview = useDiffPreview();
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
  const label = toolLabel(activity.tool);
  const detail = rowDetail(activity);

  const argsText = argsTextFor(activity);

  const isEdit =
    activity.tool === "edit_file" || activity.tool === "write_file";
  const openReview = useViewerTabs((s) => s.openReview);
  const onHeadClick = () => {
    // Only a write row leaves the chat: its diff opens in the Review panel.
    // Every other row expands IN PLACE — args / result / results stay inside
    // the row (long bodies scroll), never the side panel (user request).
    if (isEdit) {
      if (messageId) openReview(messageId, reviewPathOf(activity));
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
      {/* A div with button semantics, not a real <button>: the `Review ↗` pill
          below is a real button and must not be nested inside another one. */}
      <div
        className="trace-row-head"
        role="button"
        tabIndex={0}
        /* کارت ویرایش دیف را در چت باز نمی‌کند — کلیک، ترن را در پنل Review
           سمت راست نشان می‌دهد (سبک کدکس). بقیهٔ ردیف‌ها مثل قبل باز/بسته. */
        onClick={onHeadClick}
        title={isEdit ? "Review changes in the side panel" : undefined}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onHeadClick();
          }
        }}
      >
        <StatusIcon status={activity.status} />
        <span className="trace-pill">{label}</span>
        {activity.tool === "web_search" && activity.engine && (
          <span className="trace-row-engine" title="Web search provider">
            {webProviderLabel(activity.engine)}
          </span>
        )}
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
        <span className="trace-row-end">
          {isEdit && diffStats && (
            <span className="trace-row-diff-stats">{diffStats}</span>
          )}
          {isEdit && activity.diff && (
            <button
              type="button"
              className="trace-row-review"
              title="Preview diff"
              onClick={(e) => {
                // The pill sits inside the row's clickable area, which opens the
                // Review panel: this click is the preview, not the panel.
                e.stopPropagation();
                preview.open(
                  e.currentTarget.closest(".trace-row.single"),
                  activity.diff,
                  reviewPathOf(activity),
                );
              }}
            >
              Review ↗
            </button>
          )}
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <IconChevron open={expanded} className="trace-row-chev" />
        </span>
      </div>
      {expanded ? (
        <div className="trace-row-expand">
          {ms ? (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Duration</span>
              <span className="trace-expand-val">{fmtTime(ms)}</span>
            </div>
          ) : null}
          {/* The backend stamps the tool NAME as the summary; for a skill load
              that only repeats the head label — the skill name is the real
              detail. */}
          {activity.summary &&
            canonicalTool(activity.tool) !== "load_skill" && (
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
          {activity.resultText && activity.tool !== "run_terminal" && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Result</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">
                {activity.resultText}
              </pre>
            </div>
          )}
          {/* The hits of a `web_search` / `fetch_url` row belong to THIS row:
              they render at the bottom of its own expanded body — never as a
              sibling block hanging outside the tool call — and the row starts
              expanded so the payload shows without a second click. Folding the
              row tucks them back inside the collapsed call. */}
          {isWebRow(activity) && <InlineWebResults activity={activity} />}
          {/* The `Results` section below is the FILE-path list (read / grep /
              terminal); web rows already rendered their links above. */}
          {!isWebRow(activity) &&
            (((activity.items ?? activity.results)?.length ?? 0) > 0 ||
              (activity.tool === "run_terminal" &&
                Boolean(activity.resultText))) && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                  fallbackText={activity.resultText}
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
      {preview.snap &&
        typeof document !== "undefined" &&
        createPortal(
          <DiffPreview
            diff={preview.snap.diff}
            path={preview.snap.path}
            pos={preview.snap.pos}
            onClose={preview.close}
            onPress={preview.keep}
          />,
          document.body,
        )}
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
      {fileBasename(path)}
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
  // The card's `Review ↗` pill opens the diff preview; a click on the head still
  // opens the Review panel.
  const preview = useDiffPreview();
  // سبک کدکس: کارت ویرایش کوچک می‌ماند و دیف هرگز داخل چت باز نمی‌شود؛
  // کلیک روی خودِ کارت (یا دکمهٔ Review) دیف را در پنل سمت راست نشان می‌دهد.
  const openReview = useViewerTabs((s) => s.openReview);
  const root = useStore((s) => s.root);
  // چت فعال از store — fallback وقتی caller (ChatMessage) chatId را پاس نمی‌دهد.
  const activeChatId = useStore((s) => s.activeChatId);
  // Sub-agent (explore) cards are collapsible and start collapsed: the nested
  // read/grep/glob sub-list is noisy, so it stays hidden until clicked.
  const [collapsed, setCollapsed] = useState(isSubagentCard(activity));
  // Explore cards fold their report; terminal cards fold their output — both
  // toggle in place instead of hijacking clicks to the side panel.
  const collapsible =
    (activity.tool === "explore" &&
      ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary))) ||
    activity.tool === "run_terminal";

  const toolRunning = activity.status === "running" || (activity.children?.some((c) => c.status === "running") ?? false);
  const now = useRunningClock(toolRunning);
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
  /** The skill a `load_skill` call loaded. The label only says "Load Skill", and
   *  the raw `name` arg chip is stripped as redundant (REDUNDANT_ARG_KEYS), so
   *  without this the head never states WHICH skill the turn pulled in. */
  const skillName =
    canonicalTool(activity.tool) === "load_skill"
      ? String(
          activity.args?.name ?? activity.args?.file ?? activity.args?.query ?? "",
        )
      : "";

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
      const { content: current } = (await api.fsRead(root, path)) ?? {};
      const oldContent = applyReverseDiff(activity.diff, current ?? "");
      const ok = await api.fsWrite(root, path, oldContent);
      if (ok) onReverted?.();
    } finally {
      setReverting(false);
    }
  };

  return (
    <div
      className={`tool-card ${activity.status}${
        activity.tool === "explore" ? " explore" : ""
      }`}
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
        title={
          isWrite
            ? "Review changes in the side panel"
            : activity.tool === "run_terminal"
              ? "Toggle command output"
              : undefined
        }
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
          ) : (
            toolLabel(activity.tool)
          )}
        </span>
        {/* The head must say WHICH skill was loaded: the label is only
            "Load Skill" and the raw `name` arg is filtered out of the chips. */}
        {skillName && (
          <span className="tool-skill" title={`Skill: ${skillName}`} dir="ltr">
            {skillName}
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
        {activity.args && activity.args.filePath !== undefined && !isWrite && (
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
            {fixZwsp(
              String(activity.args.description).length > 120
                ? `${String(activity.args.description).slice(0, 120)}…`
                : String(activity.args.description),
            )}
          </span>
        )}
        {activity.tool === "explore" &&
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
        {/* Sub-agent cards render their own description badge above — dumping
            the raw args here garbled the head row (overlapping key fragments). */}
        {activity.args && !isSubagentCard(activity) && (
          <ToolArgs args={activity.args} tool={activity.tool} />
        )}
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
          {isWrite && activity.diff && (
            <button
              className="tool-review-btn"
              title="Preview diff"
              onClick={(e) => {
                e.stopPropagation();
                preview.open(
                  e.currentTarget.closest(".tool-card"),
                  activity.diff,
                  writePath,
                );
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
        activity.tool === "explore" &&
        activity.children &&
        activity.children.length > 0 && (
          <ToolCascade activities={activity.children} />
        )}
      {/* کارت‌های ویرایش (edit_file/write_file) کوچک می‌مانند — بدون بدنه؛
          دیف فقط در پنل Review سمت راست باز می‌شود (سبک کدکس). */}
      {!collapsed && !isWrite && (
        <div className="tool-card-body">
          {/* The backend stamps a tool's summary with its own NAME; for a skill
              load that only repeats the head label, so the body stays empty. */}
          {activity.summary &&
            !isWrite &&
            canonicalTool(activity.tool) !== "load_skill" && (
              <div className="tool-summary">{fixZwsp(activity.summary)}</div>
            )}
          {/* A `read` result IS the file window: it is a code dump, not a
              one-line summary — render it as a clamped pre (same block the
              terminal output uses) so the card body cannot balloon. */}
          {activity.tool === "read" && activity.resultText && (
            <pre
              className="trace-expand-val trace-expand-pre trace-terminal-output"
              dir="ltr"
            >
              {activity.resultText}
            </pre>
          )}
          {activity.tool === "explore" &&
            activity.children &&
            activity.children.length > 0 && (
              <div className="tool-sub-list">
                {activity.children.map((child, i) => (
                  <ToolSubRow
                    key={`${child.tool}-${i}-${child.callId ?? i}`}
                    activity={child}
                    // A read child carries the whole file window; the sub-row
                    // already names the path, so keep the list scannable and
                    // leave the content to the Explore side panel.
                    hideResult={child.tool === "read"}
                  />
                ))}
              </div>
            )}
          {(activity.tool === "web_search" || activity.tool === "fetch_url") &&
            (activity.items ?? activity.results) &&
            (activity.items ?? activity.results)!.length > 0 && (
              <WebResultLinks items={(activity.items ?? activity.results)!} />
            )}
          {activity.tool === "run_terminal" &&
            (((activity.items ?? activity.results)?.length ?? 0) > 0 ||
              Boolean(activity.resultText)) && (
              <>
                <span className="trace-expand-key">Output</span>
                <TerminalResultText
                  items={activity.items ?? activity.results}
                  fallbackText={activity.resultText}
                />
              </>
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
      {preview.snap &&
        typeof document !== "undefined" &&
        createPortal(
          <DiffPreview
            diff={preview.snap.diff}
            path={preview.snap.path}
            pos={preview.snap.pos}
            onClose={preview.close}
            onPress={preview.keep}
          />,
          document.body,
        )}
    </div>
  );
});
