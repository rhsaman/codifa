import { restoreCheckpoint } from '../../lib/api'
import { toWorkspacePath } from '../../lib/fileTree'
import { api } from '../../lib/fs'
import { reviewPathOf } from '../../lib/reviewTurn'
import { useStore } from '../../lib/store'
import { diffStatsFromUnified, editTargetsOf } from '../../lib/toolActivity'
import { useViewerTabs } from '../../lib/viewerTabs'
import type { ToolActivity } from '../../types'
import { KeyboardEvent, memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { DiffPreview, applyReverseDiff, useDiffPreview } from './diff'
import { IconChevron, StatusIcon } from './icons'
import { editGroupStats, useRunningClock } from './naming'

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
  // Start → end of the whole group, not the sum of each edit's own duration.
  const totalMs = groupSpanMs(
    activities.map((a) => a.activity),
    now,
  );

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
      // The transcript may trim the aggregate `diff`; the per-file entry for
      // THIS path stays complete, so prefer it for the reverse diff.
      const revertDiff =
        entry.activity.diffs?.find((e) => e.path === path)?.diff ?? entry.activity.diff;
      const { content: current } = (await api.fsRead(root, path)) ?? {};
      const oldContent = applyReverseDiff(revertDiff, current ?? "");
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
            // A batch call names a different file per entry; the row shows the
            // first (the Review panel lists every file), so admit the rest.
            const targets = editTargetsOf(entry.activity.args);
            const more = targets.length > 1 ? targets.length - 1 : 0;
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
                  title={path ? (more ? targets.join("\n") : toWorkspacePath(root, path)) : undefined}
                  onClick={() => messageId && openReview(messageId, path)}
                  onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (messageId) openReview(messageId, path);
                    }
                  }}
                >
                  <StatusIcon status={entry.activity.status} />
                  <span className="edit-group-file" dir="auto">{base}</span>
                  {more > 0 && (
                    <span className="tool-path tool-more" dir="ltr">+{more} more</span>
                  )}
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

/** Wall-clock span of a tool group: the first call's start → the last call's
 *  end (a call still running ends "now"). It is NOT the sum of the calls' own
 *  durations: parallel calls would be counted twice, and the gaps between calls
 *  (the model reasoning, narration) would be dropped. A call without a start
 *  stamp (older transcripts) falls back to summing the durations. */
export function groupSpanMs(acts: ToolActivity[], now: number): number {
  let start = Infinity;
  let end = -Infinity;
  let summed = 0;
  for (const a of acts) {
    const own =
      a.status === "running" && a.startedAt
        ? Math.max(0, now - a.startedAt)
        : a.elapsedMs || 0;
    summed += own;
    if (!a.startedAt) continue;
    start = Math.min(start, a.startedAt);
    end = Math.max(end, a.startedAt + own);
  }
  return start === Infinity ? summed : Math.max(0, end - start);
}

export function fmtTime(ms?: number): string {
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
export function IconSparkle({ className }: { className?: string }) {
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

