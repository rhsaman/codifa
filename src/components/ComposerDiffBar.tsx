import { useEffect, useState } from "react";
import { gitBranches, gitCheckout, gitDiff, gitStatus } from "../lib/api";
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
            title="Current branch — click to switch"
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
      {files > 0 && (onCommit || onUndo) && (
        <span className="composer-diff-actions">
          {onCommit && (
            <button
              type="button"
              className="composer-diff-btn commit"
              disabled={disabled}
              title="Generate commit message and commit"
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
