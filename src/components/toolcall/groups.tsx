import { fixZwsp, prepareContent } from '../../lib/bidi'
import { parseDownloadProgress } from '../../lib/downloadProgress'
import { fileBasename } from '../../lib/fileTypes'
import { reviewPathOf } from '../../lib/reviewTurn'
import { diffStatsFromUnified, editTargetOf } from '../../lib/toolActivity'
import { useViewerTabs } from '../../lib/viewerTabs'
import type { ToolActivity } from '../../types'
import { openWorkspaceFile } from '../FileIcon'
import { Fragment, KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ToolArgs, argsTextFor, fmtArgValue, rowDetail } from './args'
import { DiffPreview, useDiffPreview } from './diff'
import { IconSparkle, fmtTime } from './editGroup'
import { IconChevron, StatusIcon, TerminalRowIcon } from './icons'
import { canonicalTool, isSubagentCard, toolIcon, toolLabel, useRunningClock } from './naming'
import { FileResultLinks, InlineWebResults, MEDIA_TOOLS, MediaResultLinks, TerminalResultText, WebResultLinks, isWebRow, resultRows, webProviderLabel } from './results'

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
  // Every run starts collapsed — including runs with web calls, whose hits are
  // one click away inside the expanded rows.
  const [open, setOpen] = useState(false);
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
export function shortArg(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function subArgSummary(activity: ToolActivity): string {
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

  // read/write/edit/list_files: path + real line range (mirrors the card head).
  // A batch edit names its file per `edits[]` entry, so the plain `path` read
  // left the row blank for exactly the shape the schema advertises.
  const path = String(args.filePath ?? editTargetOf(args) ?? "");
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
    // Range items are objects ({path, offset, limit}): flatten each to its
    // "path:offset:limit" (or bare "path") so they never render as [object Object].
    const rs = rangesRaw
      .map((r) => {
        if (typeof r === "string") return r;
        if (r && typeof r === "object" && "path" in r) {
          const o = r as { path?: unknown; offset?: unknown; limit?: unknown };
          return [o.path, o.offset, o.limit].filter((v) => v != null).join(":");
        }
        return "";
      })
      .filter(Boolean);
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
export const TraceRow = memo(function TraceRow({
  activity,
}: {
  activity: ToolActivity;
}) {
  const [now, setNow] = useState(() => Date.now());
  // edit_file / write_file rows always start open: a diff is the payload of the
  // row, so a collapsed line would hide it. A fold click still tucks the content
  // inside the call. Web rows stay collapsed like every other tool.
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
            (resultRows(activity).length > 0 ||
              (activity.tool === "run_terminal" &&
                Boolean(activity.resultText))) && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                  fallbackText={activity.resultText}
                />
              ) : MEDIA_TOOLS.has(activity.tool) ? (
                // Generated media renders as REAL thumbnails/playables here —
                // FileResultLinks' icon+name rows hid the picture entirely.
                <MediaResultLinks items={resultRows(activity)} />
              ) : (
                <FileResultLinks tool={activity.tool} items={resultRows(activity)} />
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
export const ToolTimelineRow = memo(function ToolTimelineRow({
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
      {resultRows(activity).length > 0 &&
        (MEDIA_TOOLS.has(activity.tool) ? (
          <MediaResultLinks items={resultRows(activity)} />
        ) : activity.tool === "web_search" || activity.tool === "fetch_url" ? (
          <WebResultLinks items={activity.items ?? activity.results!} />
        ) : (
          <FileResultLinks tool={activity.tool} items={resultRows(activity)} />
        ))}
    </div>
  );
});

/** How many of the newest calls the collapsed preview shows. */
export const PREVIEW_COUNT = 3;

/** Collapsed preview: the newest PREVIEW_COUNT calls as a cascading stack of
 *  mini-cards (each newer card overlaps the one above it). Always shows the
 *  last 3, so as new calls stream in the preview live-updates to the newest. */
export const ToolCascade = memo(function ToolCascade({
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
  // Every row starts collapsed, web included; the search hits live inside the
  // expanded body, one click away. Folding keeps the list tucked in the call.
  const [expanded, setExpanded] = useState(false);
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
            (resultRows(activity).length > 0 ||
              (activity.tool === "run_terminal" &&
                Boolean(activity.resultText))) && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              {activity.tool === "run_terminal" ? (
                <TerminalResultText
                  items={activity.items ?? activity.results}
                  fallbackText={activity.resultText}
                />
              ) : MEDIA_TOOLS.has(activity.tool) ? (
                // Generated media renders as REAL thumbnails/playables here —
                // FileResultLinks' icon+name rows hid the picture entirely.
                <MediaResultLinks items={resultRows(activity)} />
              ) : (
                <FileResultLinks tool={activity.tool} items={resultRows(activity)} />
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
export function ToolPathSpan({ path }: { path: string }) {
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
      {fileBasename(path)}
    </span>
  );
}

/** Live output tail of a RUNNING terminal command (tool_output events).
 *  Auto-scrolls to the newest line on every tail update — the user watches a
 *  download/build stream in without scrolling. */
export const LiveTerminalTail = function LiveTerminalTail({ tail }: { tail: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      className="trace-expand-val trace-expand-pre trace-terminal-output tool-live-output"
      dir="auto"
    >
      {tail}
    </pre>
  );
};

/** Determinate progress bar for a running download parsed out of the live
 *  tail (curl meter / curl bar / wget). Quiet by design — one bar, one meta
 *  line, no animation beyond the fill width. */
export function DownloadProgressBar({ progress }: { progress: NonNullable<ReturnType<typeof parseDownloadProgress>> }) {
  const pct = Math.max(0, Math.min(100, progress.percent));
  const meta: string[] = [];
  if (progress.received && progress.total) meta.push(`${progress.received} / ${progress.total}`);
  else if (progress.received) meta.push(progress.received);
  else if (progress.total) meta.push(progress.total);
  if (progress.speed) meta.push(progress.speed);
  if (progress.eta) meta.push(`eta ${progress.eta}`);
  return (
    <div className="tool-download-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="tool-download-progress-track">
        <div className="tool-download-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="tool-download-progress-meta" dir="ltr">
        <span className="tool-download-progress-pct">{pct % 1 === 0 ? pct : pct.toFixed(1)}%</span>
        {meta.length > 0 && <span className="tool-download-progress-detail">{meta.join(" · ")}</span>}
      </div>
    </div>
  );
}

