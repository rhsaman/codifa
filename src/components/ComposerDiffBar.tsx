import { useEffect, useState } from "react";
import { gitDiff, gitStatus } from "../lib/api";
import { buildUncommittedFiles, sumDiffStats } from "../lib/uncommitted";
import { useViewerTabs } from "../lib/viewerTabs";

/** نوار تغییرات بالای اینپوت به سبک کدکس: «N files changed +A -D».
 *  با کلیک، پنل گیت‌دیف (کل تغییرات uncommitted) باز می‌شود.
 *  وقتی تغییری نیست هیچ‌چیز رندر نمی‌کند. */
export function ComposerDiffBar({ root }: { root: string | null }) {
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
    <button
      type="button"
      className="composer-diff-bar"
      dir="ltr"
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
  );
}
