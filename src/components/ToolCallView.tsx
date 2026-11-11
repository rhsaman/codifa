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
  type UIEvent as ReactUIEvent,
} from "react";
import type { ToolActivity, SearchResultItem } from "../types";
import { useStore } from "../lib/store";
import {
  diffStatsFromUnified,
  editTargetOf,
  editTargetsOf,
  isSkillTool,
  MEMORY_TOOLS,
  terminalOutputText,
} from "../lib/toolActivity";
import { parseDownloadProgress } from "../lib/downloadProgress";
import { reviewPathOf } from "../lib/reviewTurn";
import { parseDiffRows, parseSideBySide } from "../lib/reviewDiff";
import { countOccurrences } from "../lib/diffSearch";
import {
  buildCommentSpans,
  commentSyntax,
  splitCommentSegments,
  type CommentSpan,
} from "../lib/diffComments";
import { useDiffScrollbars } from "../lib/useDiffScrollbars";
import { highlightSideLines, languageOfPath } from "../lib/highlight";
import { copyToClipboard } from "../lib/clipboard";
import { useViewerTabs } from "../lib/viewerTabs";
import { api } from "../lib/fs";
import { restoreCheckpoint } from "../lib/api";
import { fixZwsp, prepareContent } from "../lib/bidi";
import { fileBasename } from "../lib/fileTypes";
import { handleLinkClick } from "../lib/link";
import { useDragScroll } from "../lib/useDragScroll";
import { resolveLocalMedia, codifaMediaPath } from "../lib/mediaUrl";
import { ensureSidecar, peekSidecarUrl } from "../lib/api";
import { FileChip, openWorkspaceFile } from "./FileIcon";
import { createPortal } from "react-dom";
import { commentFileSelection } from "../lib/fileComments";
import { toWorkspacePath } from "../lib/fileTree";
import { selectionBarPos } from "../lib/selectionBar";
import { bareToolName, mcpServerOf } from "../lib/mcpTools";
import { diffPopupPos, type DiffPopPos } from "../lib/hoverCardPos";
import { useVimScroll } from "../lib/useVimScroll";
import { markVimRegion } from "../lib/panePointer";
import { focusChatInput } from "../lib/chatFocus";

/** Shared 500ms ticker for all running-tool clocks. Multi-window can mount
 *  dozens of tool rows; one interval driving every live clock keeps CPU and
 *  wake-ups flat instead of one timer per row. */


// Original ToolCallView surface, re-exported verbatim:
export { DIFF_SIDE_BY_SIDE_THRESHOLD } from './toolcall/diff'
export type { DiffLayoutMode } from './toolcall/diff'
export { DiffLineText } from './toolcall/diff'
export { DiffPreview } from './toolcall/diff'
export { DiffView } from './toolcall/diff'
export { DownloadProgressBar } from './toolcall/groups'
export { EDIT_TOOLS } from './toolcall/naming'
export { FileResultLinks } from './toolcall/results'
export { HEADER_SHOWN_KEYS } from './toolcall/args'
export { HIDDEN_KEYS } from './toolcall/args'
export { IconCheck } from './toolcall/icons'
export { IconChevron } from './toolcall/icons'
export { IconSparkle } from './toolcall/editGroup'
export { IconX } from './toolcall/icons'
export { InlineWebResults } from './toolcall/results'
export { LiveTerminalTail } from './toolcall/groups'
export { MEDIA_TOOLS } from './toolcall/results'
export { MediaResultLinks } from './toolcall/results'
export { PREVIEW_COUNT } from './toolcall/groups'
export { REDUNDANT_ARG_KEYS } from './toolcall/args'
export { StatusIcon } from './toolcall/icons'
export { TICK_MS } from './toolcall/naming'
export { TOOL_ALIAS } from './toolcall/naming'
export { TOOL_ICON } from './toolcall/naming'
export { TOOL_LABEL } from './toolcall/naming'
export { TOOL_NOUN } from './toolcall/naming'
export { TerminalResultText } from './toolcall/results'
export { TerminalRowIcon } from './toolcall/icons'
export { TomlLine } from './toolcall/diff'
export { ToolArgs } from './toolcall/args'
export { ToolCascade } from './toolcall/groups'
export { ToolEditGroupView } from './toolcall/editGroup'
export { ToolGroupView } from './toolcall/groups'
export { ToolPathSpan } from './toolcall/groups'
export { ToolSingleRow } from './toolcall/groups'
export { ToolSubRow } from './toolcall/groups'
export { ToolTimelineRow } from './toolcall/groups'
export { TraceNarration } from './toolcall/groups'
export { TraceRow } from './toolcall/groups'
export { WEB_RESULTS_VISIBLE } from './toolcall/results'
export { WebResultLinks } from './toolcall/results'
export { applyReverseDiff } from './toolcall/diff'
export { argsTextFor } from './toolcall/args'
export { canonicalTool } from './toolcall/naming'
export { diffQuoteForSelection } from './toolcall/diff'
export { editGroupStats } from './toolcall/naming'
export { ensureSharedTick } from './toolcall/naming'
export { fmtArgValue } from './toolcall/args'
export { fmtTime } from './toolcall/editGroup'
export { groupSummary } from './toolcall/naming'
export { highlightParts } from './toolcall/diff'
export { hostOf } from './toolcall/results'
export { isEditActivity } from './toolcall/naming'
export { isExploreCard } from './toolcall/naming'
export { isSubagentCard } from './toolcall/naming'
export { isWebRow } from './toolcall/results'
export { parseHunks } from './toolcall/diff'
export { releaseSharedTick } from './toolcall/naming'
export { resultRows } from './toolcall/results'
export { rowDetail } from './toolcall/args'
export { sharedTickId } from './toolcall/naming'
export { shortArg } from './toolcall/groups'
export { shouldShowSideBySide } from './toolcall/diff'
export { subArgSummary } from './toolcall/groups'
export { tickListeners } from './toolcall/naming'
export { subagentDisplayName } from './toolcall/naming'
export { toolIcon } from './toolcall/naming'
export { toolLabel } from './toolcall/naming'
export { useDiffPreview } from './toolcall/diff'
export { useRunningClock } from './toolcall/naming'
export { webProviderLabel } from './toolcall/results'

import { REDUNDANT_ARG_KEYS, ToolArgs } from './toolcall/args'
import { DiffPreview, DiffView, applyReverseDiff, useDiffPreview } from './toolcall/diff'
import { fmtTime } from './toolcall/editGroup'
import { DownloadProgressBar, LiveTerminalTail, ToolCascade, ToolPathSpan, ToolSubRow } from './toolcall/groups'
import { StatusIcon } from './toolcall/icons'
import { activityLabel, canonicalTool, isSubagentCard, subagentDisplayName, useRunningClock } from './toolcall/naming'
import { MEDIA_TOOLS, MediaResultLinks, TerminalResultText, WebResultLinks, resultRows } from './toolcall/results'

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
  const subagentRows = useStore((s) => s.customSubagents);
  // Sub-agent (explore) cards are collapsible and start collapsed: the nested
  // read/grep/glob sub-list is noisy, so it stays hidden until clicked.
  const [collapsed, setCollapsed] = useState(isSubagentCard(activity));
  // Explore cards fold their report; terminal cards fold their output — both
  // toggle in place instead of hijacking clicks to the side panel.
  const collapsible =
    (isSubagentCard(activity) &&
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
  // A batch write names a DIFFERENT file per entry; the head only shows the
  // first (the Review panel's per-file rows carry the rest), so a bare first
  // name would read as the WHOLE change. An honest "+N more" chip admits the
  // call touched more files than it names.
  const writeTargets = isWrite ? editTargetsOf(activity.args) : [];
  const writeMore = writeTargets.length > 1 ? writeTargets.length - 1 : 0;
  // `read` names each file INSIDE `ranges` (one entry per file and window), so
  // the chip row follows ranges first; the bare `paths` list remains only as a
  // fallback for transcripts written before the schema dropped it.
  const readPaths: string[] = Array.isArray(activity.args?.ranges)
    ? (activity.args.ranges as Array<Record<string, unknown>>)
        .map((r) => (typeof r?.path === "string" ? r.path : ""))
        .filter(Boolean)
    : Array.isArray(activity.args?.paths)
      ? (activity.args.paths as string[])
      : [];

  const fetchSummary = activity.tool === "fetch_url" ? activity.summary : "";
  // Live download progress for a RUNNING terminal card: parsed from the
  // streamed output tail (tool_output events) — the newest curl/wget progress
  // line in the tail becomes a real bar; no line matches, no bar.
  const liveProgress = useMemo(
    () =>
      activity.status === "running" &&
      activity.tool === "run_terminal" &&
      activity.liveTail
        ? parseDownloadProgress(activity.liveTail)
        : null,
    [activity.status, activity.tool, activity.liveTail],
  );
  /** The plugin/skill a load call pulled in. The label only says "Load Plugin",
   *  and the raw `slug` arg chip is stripped as redundant
   *  (REDUNDANT_ARG_KEYS), so without this the head never states WHICH plugin
   *  the turn loaded. */
  const skillName = isSkillTool(activity.tool)
    ? String(
        activity.args?.slug ??
          activity.args?.skill ??
          activity.args?.name ??
          activity.args?.file ??
          activity.args?.query ??
          "",
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
    const path = String(activity.args?.filePath ?? editTargetOf(activity.args) ?? "");
      // The transcript may trim the aggregate `diff`; the per-file entry for
      // THIS path stays complete, so prefer it for the reverse diff.
      const revertDiff =
        activity.diffs?.find((e) => e.path === path)?.diff ?? activity.diff;
      const { content: current } = (await api.fsRead(root, path)) ?? {};
      const oldContent = applyReverseDiff(revertDiff, current ?? "");
      const ok = await api.fsWrite(root, path, oldContent);
      if (ok) onReverted?.();
    } finally {
      setReverting(false);
    }
  };

  return (
    <div
      className={`tool-card ${activity.status}${
        isSubagentCard(activity) ? " explore" : ""
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
              <span
                className="tool-file"
                title={writeMore ? writeTargets.join("\n") : writePath}
              >
                <span className="tool-file-name" dir="ltr">
                  {writePath.split("/").pop() ?? writePath}
                </span>
              </span>
              {writeMore > 0 && (
                <span className="tool-path tool-more" dir="ltr">
                  +{writeMore} more
                </span>
              )}
            </>
          ) : isSubagentCard(activity) ? (
            subagentDisplayName(activity.tool, subagentRows)
          ) : (
            // A batch is named after the tools it ran, never "batch" itself.
            activityLabel(activity)
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
          <span className="tool-cmd" title={String(activity.args.command)}>
            {String(activity.args.command)}
          </span>
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
          <span
            className="tool-cmd"
            title={fixZwsp(String(activity.args.query))}
          >
            {fixZwsp(String(activity.args.query))}
          </span>
        )}
        {activity.args && activity.args.pattern !== undefined && (
          <span
            className="tool-cmd"
            title={fixZwsp(String(activity.args.pattern))}
          >
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
        {isSubagentCard(activity) &&
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
          {/* Progress chip keeps a collapsed card honest while its download
              runs — percent visible without expanding the card. */}
          {liveProgress && (
            <span className="tool-progress-chip" dir="ltr">
              ⇣ {liveProgress.percent % 1 === 0 ? liveProgress.percent : liveProgress.percent.toFixed(1)}%
            </span>
          )}
          {ms ? <span className="tool-ms">{fmtTime(ms)}</span> : null}
          {isWrite &&
            activity.diff &&
            (() => {
              // The saved transcript trims `diff` to MAX_TOOL_TEXT; the
              // ingest-recomputed `diffStats` came from the FULL diff, so it
              // stays exact after reload while a regex recount would not.
              const s =
                activity.diffStats ??
                {
                  adds: (activity.diff.match(/^\+[^+]/gm) || []).length,
                  dels: (activity.diff.match(/^-[^-]/gm) || []).length,
                };
              return s.adds + s.dels > 0 ? (
                <span className="tool-diff-stats">
                  <span className="review-count-add">+{s.adds}</span>{" "}
                  <span className="review-count-del">-{s.dels}</span>
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
        isSubagentCard(activity) &&
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
            activity.tool !== "batch" &&
            activity.tool !== "batch_search" &&
            !isSkillTool(activity.tool) && (
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
          {/* A skill load's result IS its body. The head only says "Load Skill
              · <name>" and the backend summary repeats the tool name, so the
              card body used to be empty while the prose leaked out as file
              chips. Clamp it like terminal output — the body can be long. */}
          {isSkillTool(activity.tool) && activity.resultText && (
              <pre
                className="trace-expand-val trace-expand-pre trace-terminal-output"
                dir="auto"
              >
                {activity.resultText}
              </pre>
            )}
          {isSubagentCard(activity) &&
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
          {MEDIA_TOOLS.has(activity.tool) && resultRows(activity).length > 0 && (
            <MediaResultLinks items={resultRows(activity)} />
          )}
          {MEMORY_TOOLS.has(activity.tool) && activity.resultText && (
            <pre
              className="trace-expand-val trace-expand-pre trace-terminal-output"
              dir="auto"
            >
              {activity.resultText}
            </pre>
          )}
          {activity.tool === "run_terminal" &&
            activity.status === "running" &&
            activity.liveTail && (
              <>
                {liveProgress && <DownloadProgressBar progress={liveProgress} />}
                <span className="trace-expand-key">Live output</span>
                <LiveTerminalTail tail={activity.liveTail} />
              </>
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
