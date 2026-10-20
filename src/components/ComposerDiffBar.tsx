import { useEffect, useState } from "react";
import { gitBranches, gitCheckout, gitDiff, gitStatus } from "../lib/api";
import { buildUncommittedFiles, sumDiffStats } from "../lib/uncommitted";
import { splitWorkspaceFiles } from "../lib/fileTree";
import { useViewerTabs } from "../lib/viewerTabs";

/** Uncommitted-changes bar above the composer input, Codex style: "N files changed +A -D".
 *  Clicking the summary opens the git-diff panel for all uncommitted changes.
 *  Renders nothing when there are no changes. */
export function ComposerDiffBar({
  root,
  onCommit,
  onUndo,
  onPush,
  disabled,
  isCommitting,
  isUndoing,
  isPushing,
}: {
  root: string | null;
  onCommit?: () => void;
  onUndo?: () => void;
  onPush?: () => void;
  disabled?: boolean;
  isCommitting?: boolean;
  isUndoing?: boolean;
  isPushing?: boolean;
}) {
  const openGitDiff = useViewerTabs((s) => s.openGitDiff);
  const [files, setFiles] = useState(0);
  const [adds, setAdds] = useState(0);
  const [dels, setDels] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [switching, setSwitching] = useState(false);

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
        // فقط فایل‌های داخل ورک‌اسپیس شمرده می‌شوند — همان فیلتری که پنل Review
        // روی لیست می‌زند، وگرنه نشانِ «تعداد فایل تغییرکرده» با لیست یکی نمی‌شد.
        const inWorkspace = splitWorkspaceFiles(list, root).inside;
        const totals = sumDiffStats(inWorkspace);
        setFiles(inWorkspace.length);
        setAdds(totals.adds);
        setDels(totals.dels);
      } catch {
        /* Git errors keep the bar hidden — non-critical. */
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

  useEffect(() => {
    if (!root) {
      setBranches([]);
      setCurrent("");
      return;
    }
    let cancelled = false;
    const loadBranches = async () => {
      try {
        const res = await gitBranches(root);
        if (cancelled || "error" in res) return;
        setBranches(res.branches);
        setCurrent(res.current);
      } catch {
        /* branch list is non-critical — bar still shows diff counts */
      }
    };
    void loadBranches();
    const timer = setInterval(() => void loadBranches(), 10000);
    const onFocus = () => void loadBranches();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  const handleBranchChange = async (name: string) => {
    if (!root || !name || name === current || switching || disabled) return;
    if (name === "__new__") {
      const next = window.prompt("New branch name:");
      if (!next || !next.trim()) return;
      setSwitching(true);
      try {
        const res = await gitCheckout(root, next.trim(), true);
        if (!( "error" in res)) {
          setCurrent(res.current);
          setBranches((b) => (b.includes(res.current) ? b : [...b, res.current]));
        }
      } finally {
        setSwitching(false);
      }
      return;
    }
    setSwitching(true);
    try {
      const res = await gitCheckout(root, name);
      if (!("error" in res)) setCurrent(res.current);
    } finally {
      setSwitching(false);
    }
  };

  if (!root) return null;
  if (files === 0 && branches.length === 0) return null;
  return (
    <div className="composer-diff-bar" dir="ltr">
      {branches.length > 0 && (
        <span
          className="composer-diff-branch-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          <svg
            className="composer-diff-git-icon"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <select
            className="composer-diff-branch"
            value={branches.includes(current) ? current : ""}
            disabled={disabled || switching}
            title={current ? `Branch: ${current} — click to switch` : "Current branch — click to switch"}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              void handleBranchChange(e.target.value);
            }}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            <option value="__new__">+ New branch…</option>
          </select>
        </span>
      )}
      {files > 0 && (
      <button
        type="button"
        className="composer-diff-main"
        title="Show all uncommitted changes"
        onClick={() => openGitDiff()}
      >
        <span className="composer-diff-text">
          {files} file{files > 1 ? "s" : ""} changed
        </span>
        <span className="composer-diff-counts">
          <span className="review-count-add">+{adds}</span>
          <span className="review-count-del">-{dels}</span>
        </span>
      </button>
      )}
      {files > 0 && (onCommit || onUndo || onPush) && (
        <span className="composer-diff-actions">
          {onUndo && (
            <button
              type="button"
              className="composer-diff-btn undo"
              disabled={disabled || isUndoing}
              data-tip="Undo"
              aria-label={isUndoing ? "Undoing" : "Undo"}
              onClick={(e) => {
                e.stopPropagation();
                onUndo();
              }}
            >
              {isUndoing ? (
                <svg
                  className="composer-diff-spinner"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <g>
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 12 12"
                      to="360 12 12"
                      dur="0.8s"
                      repeatCount="indefinite"
                    />
                    <path
                      d="M21 12a9 9 0 1 1-6.2-8.56"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </g>
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 7v6h6" />
                  <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
                </svg>
              )}
            </button>
          )}
          {onCommit && (
            <button
              type="button"
              className="composer-diff-btn commit"
              disabled={disabled || isCommitting}
              data-tip="Commit"
              aria-label={isCommitting ? "Committing" : "Commit"}
              onClick={(e) => {
                e.stopPropagation();
                onCommit();
              }}
            >
              {isCommitting ? (
                <svg
                  className="composer-diff-spinner"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <g>
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 12 12"
                      to="360 12 12"
                      dur="0.8s"
                      repeatCount="indefinite"
                    />
                    <path
                      d="M21 12a9 9 0 1 1-6.2-8.56"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </g>
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3" />
                  <line x1="3" y1="12" x2="9" y2="12" />
                  <line x1="15" y1="12" x2="21" y2="12" />
                </svg>
              )}
            </button>
          )}
          {onPush && (
            <button
              type="button"
              className="composer-diff-btn push"
              disabled={disabled || isPushing}
              data-tip="Push"
              aria-label={isPushing ? "Pushing" : "Push"}
              onClick={(e) => {
                e.stopPropagation();
                onPush();
              }}
            >
              {isPushing ? (
                <svg
                  className="composer-diff-spinner"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <g>
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 12 12"
                      to="360 12 12"
                      dur="0.8s"
                      repeatCount="indefinite"
                    />
                    <path
                      d="M21 12a9 9 0 1 1-6.2-8.56"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </g>
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 16V4" />
                  <path d="m6 10 6-6 6 6" />
                  <path d="M4 20h16" />
                </svg>
              )}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
