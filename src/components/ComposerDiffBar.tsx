import { useEffect, useState } from "react";
import { gitDiff, gitStatus } from "../lib/api";
import { buildUncommittedFiles, sumDiffStats } from "../lib/uncommitted";
import { useViewerTabs } from "../lib/viewerTabs";

/** Uncommitted-changes bar above the composer input, Codex style: "N files changed +A -D".
 *  Clicking the summary opens the git-diff panel for all uncommitted changes.
 *  Renders nothing when there are no changes. */
export function ComposerDiffBar({
  root,
  onCommit,
  onUndo,
  disabled,
}: {
  root: string | null;
  onCommit?: () => void;
  onUndo?: () => void;
  disabled?: boolean;
}) {
  const openGitDiff = useViewerTabs((s) => s.openGitDiff);
  const [files, setFiles] = useState(0);
  const [adds, setAdds] = useState(0);
  const [dels, setDels] = useState(0);

  useEffect(() => {
    if (!root) {
      setFiles(0);
      setAdds(0);
      setDels(0);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [st, unstaged, staged] = await Promise.all([
          gitStatus(root),
          gitDiff(root),
          gitDiff(root, "", true),
        ]);
        if (cancelled) return;
        const statusPaths =
          "error" in st ? [] : st.entries.map((e) => e.path);
        const unstagedDiff = "error" in unstaged ? "" : unstaged.diff;
        const stagedDiff = "error" in staged ? "" : staged.diff;
        const list = buildUncommittedFiles(
          statusPaths,
          unstagedDiff,
          stagedDiff,
        );
        const totals = sumDiffStats(list);
        setFiles(list.length);
        setAdds(totals.adds);
        setDels(totals.dels);
      } catch {
        /* خطای گیت نوار را مخفی نگه می‌دارد — غیرحیاتی */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  if (!root || files === 0) return null;
  return (
    <div className="composer-diff-bar" dir="ltr">
      <button
        type="button"
        className="composer-diff-main"
        title="Show all uncommitted changes"
        onClick={openGitDiff}
      >
        <span className="composer-diff-dot" aria-hidden="true" />
        <span className="composer-diff-text">
          {files} file{files > 1 ? "s" : ""} changed
        </span>
        <span className="composer-diff-counts">
          <span className="review-count-add">+{adds}</span>
          <span className="review-count-del">-{dels}</span>
        </span>
        <span className="composer-diff-open" aria-hidden="true">
          ▸
        </span>
      </button>
      {(onCommit || onUndo) && (
        <span className="composer-diff-actions">
          {onCommit && (
            <button
              type="button"
              className="composer-diff-btn commit"
              disabled={disabled}
              title="Commit via agent"
              onClick={(e) => {
                e.stopPropagation();
                onCommit();
              }}
            >
              Commit
            </button>
          )}
          {onUndo && (
            <button
              type="button"
              className="composer-diff-btn undo"
              disabled={disabled}
              title="Discard uncommitted changes"
              onClick={(e) => {
                e.stopPropagation();
                onUndo();
              }}
            >
              Undo
            </button>
          )}
        </span>
      )}
    </div>
  );
}
