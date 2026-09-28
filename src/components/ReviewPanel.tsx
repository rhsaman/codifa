import { useEffect, useMemo, useRef, useState } from "react";
import { buildReviewTurn } from "../lib/reviewTurn";
import { buildUncommittedFiles } from "../lib/uncommitted";
import { countDiffHits, filterFilesByQuery, locateHit, stepHitIndex } from "../lib/diffSearch";
import { parseDiffRows } from "../lib/reviewDiff";
import { splitUnifiedDiffByFile } from "../lib/reviewDiff";
import { diffStatsFromUnified } from "../lib/toolActivity";
import { useStore } from "../lib/store";
import { useReviewPanel, type ReviewSource } from "../lib/reviewPanel";
import { copyToClipboard } from "../lib/clipboard";
import { gitDiff, gitLog, gitShow, gitStatus, type GitCommitInfo } from "../lib/api";
import { DiffView } from "./ToolCallView";

/** پسوند فایل برای بج کدکس (`css`, `tsx`, …) — فایل بدون پسوند «file». */
function extLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "file";
}

/** فایل تغییرکرده با دیف و آمار — برای لیست پنل. */
export interface ReviewFileItem {
  path: string;
  diff: string;
  adds: number;
  dels: number;
}

interface GitFile extends ReviewFileItem {}

/** آکاردئون خالص لیست فایل‌ها: هر ردیف فایل، دیف خودش را دقیقاً زیر همان
 *  ردیف باز می‌کند. بدون وابستگی به استور تا در SSR هم قابل تست باشد؛
 *  `selectedPath` خالی یعنی همه بسته. `query` رخدادهای جست‌وجو را هایلایت می‌کند
 *  و `activeHit` ایندکس محلی رخداد فعال داخل فایل باز است. */
export function ReviewFileAccordion({
  files,
  selectedPath,
  onSelect,
  query = "",
  activeHit = -1,
}: {
  files: ReviewFileItem[];
  selectedPath: string;
  onSelect: (path: string) => void;
  query?: string;
  activeHit?: number;
}) {
  return (
    <div className="review-files">
      {files.map((f) => {
        const isOpen = f.path === selectedPath;
        return (
          <div
            key={f.path}
            className={`review-file-block${isOpen ? " open" : ""}`}
          >
            <button
              className={`review-file-row${isOpen ? " selected" : ""}`}
              aria-expanded={isOpen}
              onClick={() => onSelect(isOpen ? "" : f.path)}
            >
              <span className="review-file-ext">{extLabel(f.path)}</span>
              <span className="review-file-path">{f.path}</span>
              <span className="review-file-counts">
                <span className="review-count-add">+{f.adds}</span>
                <span className="review-count-del">-{f.dels}</span>
              </span>
              <span className="review-file-open" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>
            {isOpen && (
              <div className="review-diff">
                {f.diff ? (
                  <DiffView
                    diff={f.diff}
                    path={f.path}
                    query={query}
                    activeHit={activeHit}
                  />
                ) : (
                  <div className="review-empty">
                    New file — no diff available yet.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** پنل Review به سبک کدکس — تب `Review` با فیلتر منبع (ترن / uncommitted /
 *  committed)، لیست فایل‌های تغییرکرده، و دیف تک‌ستونی فایل انتخاب‌شده.
 *  داده‌ی ترن از `messageId` در استور خوانده می‌شود تا حین استریم زنده بماند. */
export function ReviewPanel() {
  const { messageId, selectedPath, selectPath, close, source, setSource } =
    useReviewPanel();
  const [copied, setCopied] = useState(false);

  // عرض پنل — با درگ لبه‌ی چپ (مثل سایدبار، معکوس چون به راست داک شده) و
  // ذخیره‌ی محلی تا بین بازشدن‌ها حفظ شود.
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 520;
    const vw =
      typeof window.innerWidth === "number" &&
      Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1024;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:reviewWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const fallback = Math.round(vw * 0.46);
    const n = Number.isFinite(saved) ? saved : fallback;
    return Math.max(340, Math.min(vw - 24, n));
  });
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => Math.max(340, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(
        340,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)),
      );
      setWidth(w);
      try {
        localStorage.setItem("coder:reviewWidth", String(w));
      } catch {
        /* حافظه در دسترس نیست — عرض فقط حفظ نمی‌شود */
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

  // فعالیت‌های ابزار پیام جاری — مستقیم از استور تا با هر رویداد جدید به‌روز شود.
  const activities = useStore(
    (s) =>
      s.chats
        .find((c) => c.messages.some((m) => m.id === messageId))
        ?.messages.find((m) => m.id === messageId)?.toolActivity,
  );

  const turn = useMemo(
    () => (messageId && activities ? buildReviewTurn(messageId, activities) : null),
    [messageId, activities],
  );

  // ریشه‌ی پروژه برای کوئری‌های گیت — از چت فعال.
  const root = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [rev, setRev] = useState("HEAD");
  const [query, setQuery] = useState("");

  // بارگذاری دیف uncommitted: ترکیب staged و unstaged تا فایل‌های استیج‌شده
  // هم آمار واقعی داشته باشند (نه +0 -0)، بعد تفکیک per-file.
  useEffect(() => {
    if (source !== "uncommitted" || !root) return;
    let cancelled = false;
    void (async () => {
      setGitLoading(true);
      setGitError(null);
      try {
        const [st, unstaged, staged] = await Promise.all([
          gitStatus(root),
          gitDiff(root),
          gitDiff(root, "", true),
        ]);
        if (cancelled) return;
        if ("error" in unstaged) {
          setGitFiles([]);
          setGitError(unstaged.error ?? "git diff failed");
          return;
        }
        // فایل‌های untracked در diff نیستند — `buildUncommittedFiles` آن‌ها را
        // از status اضافه می‌کند و staged/unstaged را per-file ادغام می‌کند.
        const statusPaths = "error" in st ? [] : st.entries.map((e) => e.path);
        const stagedDiff = "error" in staged ? "" : staged.diff;
        setGitFiles(
          buildUncommittedFiles(statusPaths, unstaged.diff, stagedDiff),
        );
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root]);

  // تاریخچه‌ی کامیت‌ها برای فیلتر committed.
  useEffect(() => {
    if (source !== "committed" || !root) return;
    let cancelled = false;
    void (async () => {
      const log = await gitLog(root, 10);
      if (!cancelled && !("error" in log)) setCommits(log.commits);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root]);

  // بارگذاری دیف یک کامیت خاص.
  useEffect(() => {
    if (source !== "committed" || !root) return;
    let cancelled = false;
    void (async () => {
      setGitLoading(true);
      setGitError(null);
      try {
        const d = await gitShow(root, rev);
        if (cancelled) return;
        if ("error" in d) {
          setGitFiles([]);
          setGitError(d.error ?? "git show failed");
          return;
        }
        setGitFiles(
          splitUnifiedDiffByFile(d.diff).map((p) => {
            const s = diffStatsFromUnified(p.diff);
            return { path: p.path, diff: p.diff, adds: s.adds, dels: s.dels };
          }),
        );
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root, rev]);

  const turnFiles: GitFile[] = useMemo(
    () =>
      turn?.files.map((f) => ({
        path: f.path,
        diff: f.diff,
        adds: f.adds,
        dels: f.dels,
      })) ?? [],
    [turn],
  );
  const files = source === "turn" ? turnFiles : gitFiles;
  const visibleFiles = filterFilesByQuery(files, query);
  // تعداد رخدادهای قابل‌ناوبری هر فایل (فقط داخل دیف — مثل هایلایت `DiffView`).
  const hitCounts = useMemo(
    () =>
      query.trim()
        ? visibleFiles.map((f) => countDiffHits(parseDiffRows(f.diff), query))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, source, turn?.files, gitFiles],
  );
  const matchCount = hitCounts.reduce((n, c) => n + c, 0);
  // ایندکس سراسری رخداد فعال (‎-1‎ یعنی هیچ‌کدام) — با تغییر کوئری/لیست ریست.
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => {
    setActiveIndex(matchCount > 0 ? 0 : -1);
  }, [query, source, turn?.files, gitFiles]);
  const activeLoc =
    activeIndex >= 0 ? locateHit(hitCounts, activeIndex) : null;
  const stepSearch = (dir: 1 | -1) => {
    setActiveIndex((cur) => {
      const next = stepHitIndex(cur, matchCount, dir);
      const loc = next >= 0 ? locateHit(hitCounts, next) : null;
      // اگر رخداد بعدی در فایل دیگری است، آن فایل را باز کن تا دیده شود.
      if (loc) {
        const target = visibleFiles[loc.fileIndex]?.path;
        if (target && target !== selectedPath) selectPath(target);
      }
      return next;
    });
  };
  const totals =
    source === "turn"
      ? turn
        ? { adds: turn.adds, dels: turn.dels }
        : null
      : {
          adds: files.reduce((n, f) => n + f.adds, 0),
          dels: files.reduce((n, f) => n + f.dels, 0),
        };

  // انتخاب پیش‌فرض: با تغییر منبع، فایل اول باز می‌شود؛ در غیر این صورت اگر
  // انتخاب فعلی حین استریم ناپدید شد به اولین فایل برمی‌گردد. بستن دستی همهٔ
  // فایل‌ها (`selectedPath` خالی) تا وقتی منبع عوض نشده حفظ می‌شود.
  const prevSource = useRef(source);
  useEffect(() => {
    if (files.length === 0) return;
    const sourceChanged = prevSource.current !== source;
    prevSource.current = source;
    const has = files.some((f) => f.path === selectedPath);
    if (sourceChanged || (selectedPath && !has)) selectPath(files[0]?.path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, turn?.files, gitFiles]);

  // فایل بازِ آکاردئون — وقتی کاربر همه را می‌بندد (`selectedPath` خالی) هیچ
  // فایلی باز نمی‌ماند، پس fallback به فایل اول نداریم.
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  const copyDiff = async () => {
    if (!selected) return;
    const ok = await copyToClipboard(selected.diff);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const switchSource = (next: ReviewSource) => {
    setSource(next);
    setGitError(null);
    setQuery("");
    setActiveIndex(-1);
  };

  // آکاردئون فایل‌ها: هر ردیف فایل، دیف خودش را دقیقاً زیر همان ردیف باز
  // می‌کند (به‌جای لیست بالا و یک دیف مشترک پایین). کلیک روی ردیف باز، آن را
  // می‌بندد؛ فقط یک فایل هم‌زمان باز می‌ماند (`selectedPath`).
  // `query` لیست را به فایل‌های منطبق فیلتر می‌کند و رخدادها را هایلایت می‌کند؛
  // رخداد فعال فقط داخل فایل باز هایلایت متمایز می‌گیرد.
  const renderFileList = (list: GitFile[]) => {
    const openIdx = list.findIndex((f) => f.path === (selected?.path ?? ""));
    const openLocal =
      activeLoc && activeLoc.fileIndex === openIdx
        ? activeLoc.localIndex
        : -1;
    return (
      <ReviewFileAccordion
        files={list}
        selectedPath={selected?.path ?? ""}
        onSelect={selectPath}
        query={query}
        activeHit={openLocal}
      />
    );
  };

  return (
    <aside className="review-panel" dir="ltr" style={{ width }}>
      <div
        className="review-resize-handle"
        title="Drag to resize"
        onMouseDown={startResize}
      />
      <div className="review-tabs">
        <span className="review-tab">
          Review
          <button className="review-tab-x" title="Close" onClick={close}>
            ✕
          </button>
        </span>
      </div>
      <div className="review-header">
        <span className="review-source" role="tablist" aria-label="Diff source">
          {(
            [
              ["turn", "Last Turn"],
              ["uncommitted", "Uncommitted"],
              ["committed", "Committed"],
            ] as [ReviewSource, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={source === key}
              className={`review-source-btn${source === key ? " active" : ""}`}
              onClick={() => switchSource(key)}
            >
              {label}
            </button>
          ))}
        </span>
        {totals && (
          <span className="review-counts">
            <span className="review-count-add">+{totals.adds}</span>
            <span className="review-count-del">-{totals.dels}</span>
          </span>
        )}
        <span className="review-header-actions">
          <button
            className={`review-icon-btn${copied ? " copied" : ""}`}
            title="Copy diff"
            onClick={() => void copyDiff()}
          >
            {copied ? "✓" : "⧉"}
          </button>
        </span>
      </div>
      <div className="review-search-row">
        <label className="review-search" dir="ltr">
          <span aria-hidden="true">🔍</span>
          <input
            className="review-search-input"
            type="search"
            placeholder="Search in diffs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matchCount > 0) {
                e.preventDefault();
                stepSearch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {query.trim() ? (
            matchCount > 0 ? (
              <span className="review-search-nav">
                <span className="review-search-count">
                  {activeIndex + 1}/{matchCount}
                </span>
                <button
                  type="button"
                  className="review-search-btn"
                  title="Previous match (Shift+Enter)"
                  aria-label="Previous match"
                  onClick={() => stepSearch(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="review-search-btn"
                  title="Next match (Enter)"
                  aria-label="Next match"
                  onClick={() => stepSearch(1)}
                >
                  ↓
                </button>
              </span>
            ) : (
              <span className="review-search-count">0 hits</span>
            )
          ) : null}
        </label>
      </div>
      {source === "committed" && (
        <div className="review-rev-row">
          <label className="review-rev-label" htmlFor="review-rev">
            Commit
          </label>
          <select
            id="review-rev"
            className="review-rev-select"
            value={rev}
            onChange={(e) => setRev(e.target.value)}
          >
            <option value="HEAD">HEAD (latest)</option>
            {commits.map((c) => (
              <option key={c.hash} value={c.hash}>
                {c.hash} — {c.subject}
              </option>
            ))}
          </select>
        </div>
      )}

      {source === "turn" ? (
        !turn ? (
          <div className="review-empty">No changes in this turn.</div>
        ) : visibleFiles.length === 0 ? (
          <div className="review-empty">No files match “{query.trim()}”.</div>
        ) : (
          renderFileList(visibleFiles)
        )
      ) : gitLoading ? (
        <div className="review-empty">loading…</div>
      ) : gitError ? (
        <div className="review-empty">{gitError}</div>
      ) : files.length === 0 ? (
        <div className="review-empty">
          {source === "uncommitted"
            ? "Working tree clean — no uncommitted changes."
            : "No files changed in this commit."}
        </div>
      ) : visibleFiles.length === 0 ? (
        <div className="review-empty">No files match “{query.trim()}”.</div>
      ) : (
        renderFileList(visibleFiles)
      )}
    </aside>
  );
}
