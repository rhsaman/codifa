import { useEffect, useMemo, useRef, useState } from "react";
import { useVimScroll } from "../lib/useVimScroll";
import { markVimRegion } from "../lib/panePointer";
import { focusChatInput } from "../lib/chatFocus";
import { createPortal } from "react-dom";
import { buildReviewTurn } from "../lib/reviewTurn";
import { buildUncommittedFiles } from "../lib/uncommitted";
import { countDiffHits, filterFilesByQuery, locateHit, stepHitIndex } from "../lib/diffSearch";
import { parseDiffRows } from "../lib/reviewDiff";
import { splitUnifiedDiffByFile } from "../lib/reviewDiff";
import { diffStatsFromUnified } from "../lib/toolActivity";
import { providerApiKeys, useStore } from "../lib/store";
import { useReviewPanel, type ReviewSource } from "../lib/reviewPanel";
import { useViewerTabs } from "../lib/viewerTabs";
import { useDiffScrollbars } from "../lib/useDiffScrollbars";
import { onGitChange } from "../lib/liveEvents";
import { ViewerFullscreenButton } from "./ViewerFullscreenButton";
import { ComposerDiffBar } from "./ComposerDiffBar";
import {
  gitAutoCommit,
  gitDiff,
  gitDiscard,
  gitLog,
  gitPush,
  gitShow,
  gitStatus,
  type CompactUsage,
  type GitCommitInfo,
} from "../lib/api";
import { normalizeUsageModel } from "../lib/usage";
import { otherSlotLevel, otherSlotModel, toolFallbackEntries } from "../lib/toolSlots";
import { supportsReasoning } from "../lib/thinking";
import { modelReasoning, modelThinkingLevels } from "../lib/context";
import { levelFromSource } from "../lib/thinking-options";
import { DiffView } from "./ToolCallView";
import { FileIcon } from "./FileIcon";
import { splitWorkspaceFiles, toWorkspacePath } from "../lib/fileTree";

/** فایل تغییرکرده با دیف و آمار — برای لیست پنل. */
export interface ReviewFileItem {
  path: string;
  diff: string;
  adds: number;
  dels: number;
}

interface GitFile extends ReviewFileItem {}

/** آستانه‌ی پیش‌فرض عرض پنل (پیکسل) برای نمایش دوستونی دیف. */
export const REVIEW_SIDE_BY_SIDE_THRESHOLD = 900;

/** "Source preview" — open the original file, complete, in its own viewer
 *  tab (FileViewerPanel), jumping to the first changed line of the diff. */
const REVIEW_SOURCES: [ReviewSource, string][] = [
  ["turn", "Last Turn"],
  ["uncommitted", "Uncommitted"],
  ["committed", "Committed"],
];

function openSourcePreview(path: string, diff: string, root?: string) {
  const hm = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff);
  const line = hm ? parseInt(hm[1], 10) : undefined;
  useViewerTabs.getState().openFile(path, Number.isFinite(line) ? line : undefined, root);
}

/** Body of the opened file: a slim toolbar with the "Source preview" opener
 *  (full file in its own viewer tab) above the diff. */
function ReviewFileBody({
  file,
  query,
  activeHit,
  wide,
  root,
}: {
  file: ReviewFileItem;
  query: string;
  activeHit: number;
  wide: boolean;
  root?: string;
}) {
  return (
    <div className="review-file-body">
      <div className="review-file-toolbar">
        <button
          type="button"
          className="review-source-preview-btn"
          title="Open the full file in its own tab"
          aria-label={`Source preview — open ${file.path} in a new tab`}
          onClick={() => openSourcePreview(file.path, file.diff, root)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          Source preview
        </button>
      </div>
      {file.diff ? (
        <DiffView
          diff={file.diff}
          path={file.path}
          query={query}
          activeHit={activeHit}
          layout={wide ? "side-by-side" : "auto"}
          commentable
        />
      ) : (
        <div className="review-empty">New file — no diff available yet.</div>
      )}
    </div>
  );
}

/** آکاردئون خالص لیست فایل‌ها: هر ردیف فایل، دیف خودش را دقیقاً زیر همان
 *  ردیف باز می‌کند. بدون وابستگی به استور تا در SSR هم قابل تست باشد؛
 *  `selectedPath` خالی یعنی همه بسته. `query` رخدادهای جست‌وجو را هایلایت می‌کند
 *  و `activeHit` ایندکس محلی رخداد فعال داخل فایل باز است.
 *  `wide` وقتی پنل پهن (یا فول‌اسکرین) است دیف را دوستونی می‌کند. */
export function ReviewFileAccordion({
  files,
  selectedPath,
  onSelect,
  query = "",
  activeHit = -1,
  wide = false,
  root,
}: {
  files: ReviewFileItem[];
  selectedPath: string;
  onSelect: (path: string) => void;
  query?: string;
  activeHit?: number;
  wide?: boolean;
  root?: string;
}) {
  // This list is the diff pane's scroller (it owns both axes — see the
  // `.review-files` comment), so it gets the animated overlay bars.
  const listRef = useRef<HTMLDivElement | null>(null);
  useDiffScrollbars(listRef, files.length);
  return (
    <div className="review-files" ref={listRef}>
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
              <span className="review-file-ext">
                <FileIcon path={f.path} size={20} />
              </span>
              <span className="review-file-path" title={f.path}>
                {toWorkspacePath(root, f.path)}
              </span>
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
                <ReviewFileBody
                  file={f}
                  query={query}
                  activeHit={activeHit}
                  wide={wide}
                  root={root}
                />
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
 *  داده‌ی ترن از `messageId` در استور خوانده می‌شود تا حین استریم زنده بماند.
 *  در حالت docked داخل گروه viewer رندر می‌شود (بدون اورلی/اسکریم/ریسایز)؛ در
 *  غیر این صورت مثل حالت مطالعه به‌صورت اورلی روی چت باز می‌شود. */
export function ReviewPanel(props?: {
  messageId?: string | null
  initialSource?: ReviewSource
  initialPath?: string
  initialRev?: string
  docked?: boolean
  onClose?: () => void
  /** Owner chat for split panes: the git root follows this chat instead of
   *  the globally focused chat, so two panes never mirror each other. */
  chatId?: string
}) {
  const docked = props?.docked ?? false
  const store = useReviewPanel();
  const storeMessageId = store.messageId
  const storeSelectedPath = store.selectedPath
  const storeSelectPath = store.selectPath
  const storeClose = store.close
  const storeSource = store.source
  const storeSetSource = store.setSource
  const messageId = props?.messageId !== undefined ? props.messageId : storeMessageId
  const close = props?.onClose ?? storeClose
  const [dockedSource, setDockedSource] = useState<ReviewSource>(props?.initialSource ?? 'turn')
  const [dockedPath, setDockedPath] = useState(props?.initialPath ?? '')
  // Sync when the single review tab is updated in place (e.g. git diff open
  // then Review clicked on a chat edit): ViewerContent remounts via key, but
  // keep state in sync as well so the selected file/source never goes stale.
  useEffect(() => {
    if (props?.initialSource) setDockedSource(props.initialSource);
  }, [props?.initialSource]);
  useEffect(() => {
    if (props?.initialPath !== undefined) setDockedPath(props.initialPath);
  }, [props?.initialPath]);
  const source = docked ? dockedSource : storeSource
  const setSource = docked ? setDockedSource : storeSetSource
  const selectedPath = docked ? dockedPath : storeSelectedPath
  const selectPath = docked ? setDockedPath : storeSelectPath
  // حالت فول‌اسکرین — پنل کل ویوپورت را می‌گیرد (مثل فول‌اسکرین دیف).
  const [fullscreen, setFullscreen] = useState(false);

  // عرض پنل — با درگ لبه (مثل مطالعه، چون اورلی به راست داک شده) و
  // ذخیره‌ی محلی تا بین بازشدن‌ها حفظ شود. در فول‌اسکرین نادیده گرفته می‌شود.
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 720;
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
    const fallback = Math.round(vw / 2) - 12;
    const n = Number.isFinite(saved) ? saved : fallback;
    return Math.max(320, Math.min(vw - 24, n));
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
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Esc پنل را می‌بندد (مثل حالت مطالعه). در حالت docked اگر viewer
  // فول‌اسکرین باشد، Esc اول از فول‌اسکرین خارج می‌شود.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (docked && useViewerTabs.getState().fullscreen) {
          useViewerTabs.getState().setFullscreen(false);
          return;
        }
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, docked]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(
        320,
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

  // ریشه‌ی پروژه برای کوئری‌های گیت — در حالت اسپلیت از چت مالک برگه،
  // وگرنه از چت فعال.
  const ownerChatId = props?.chatId
  const root = useStore(
    (s) => s.chats.find((c) => c.id === (ownerChatId ?? s.activeChatId))?.root ?? s.root,
  );

  // Only edits INSIDE this root belong here — see `isReviewablePath`.
  const turn = useMemo(
    () =>
      messageId && activities ? buildReviewTurn(messageId, activities, root) : null,
    [messageId, activities, root],
  );

  // ---- Git bar actions (the bar moved here from the composer/app bar) ----
  // Chat context is derived from the store so the bar works in every panel
  // variant (docked, floating, message-attached) with no prop plumbing.
  const [isCommitting, setIsCommitting] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const gitChat = useStore((s) => s.chats.find((c) => c.id === (ownerChatId ?? s.activeChatId)));
  const gitProvider = useStore((s) => {
    const overrideId = s.chats.find((c) => c.id === (ownerChatId ?? s.activeChatId))?.providerId;
    return (
      s.settings.providers.find(
        (x) => x.id === (overrideId ?? s.settings.activeProviderId),
      ) ?? s.settings.providers[0]
    );
  });
  // Git actions stay available while the chat is streaming: the agent only
  // edits files inside tool calls, and a commit snapshots whatever is on disk
  // at that moment. Concurrent clicks of the same action are guarded by the
  // per-action flags (isCommitting / isUndoing / isPushing) below.
  const handleGitCommit = () => {
    if (!root || !gitChat || isCommitting) return;
    void (async () => {
      setIsCommitting(true);
      try {
        // Commit messages run on the Tools → "Other" model group
        // (Settings → Tools → Other): a one-line message needs a small fast
        // model, not the main chat model. `otherSlotModel` resolves the same
        // value the settings row displays; empty = follow the chat's model.
        const st = useStore.getState();
        const otherEntry = otherSlotModel(st.subagentModels);
        let commitProvider = gitProvider;
        let commitModel = gitChat.model ?? gitProvider?.model;
        if (otherEntry && commitProvider) {
          const slash = otherEntry.indexOf("/");
          const prefix = slash > 0 ? otherEntry.slice(0, slash) : "";
          const modelName = slash > 0 ? otherEntry.slice(slash + 1) : otherEntry;
          const explicitProvider = prefix
            ? st.settings.providers.find(
                (p) => p.id === prefix || p.kind === prefix,
              )
            : undefined;
          if (explicitProvider) {
            commitProvider = explicitProvider;
            commitModel = modelName;
          } else if (!prefix && modelName) {
            commitModel = modelName;
          }
        }
        if (!commitProvider) return;
        const res = await gitAutoCommit(
          root,
          {
            kind: commitProvider.kind,
            model: commitModel,
            baseUrl: commitProvider.baseUrl,
            apiKeys: providerApiKeys(commitProvider),
            id: commitProvider.id,
            // Reasoning effort follows the "Other" group's own slider when the
            // message runs on that group's model; with no slot set the call is
            // a main-model call and uses the chat's level.
            thinkingLevel: levelFromSource(
              modelThinkingLevels(commitProvider, commitModel),
              supportsReasoning(
                commitModel,
                commitProvider.kind,
                modelReasoning(commitProvider, commitModel),
              )
                ? otherEntry
                  ? otherSlotLevel(st.subagentThinking)
                  : gitChat.thinkingLevel ?? "xhigh"
                : "",
            ),
            modelReasoning:
              modelReasoning(commitProvider, commitModel) ??
              supportsReasoning(
                commitModel,
                commitProvider.kind,
                modelReasoning(commitProvider, commitModel),
              ),
          },
          Object.fromEntries(st.settings.providers.map((p) => [p.id, p])),
          {
            // The "Other" group's fallback list (Settings → Tools): without it the
            // backend only tries the first model and fails on its first error.
            subagentModels: st.subagentModels ?? {},
            toolFallbacks: toolFallbackEntries(st.toolFallbacks),
            // A "Main model" rung means the CHAT's model, which differs from the
            // commit's primary pick whenever the Other group names one.
            main:
              otherEntry && gitProvider
                ? {
                    kind: gitProvider.kind,
                    model: gitChat.model ?? gitProvider.model,
                    baseUrl: gitProvider.baseUrl,
                    apiKeys: providerApiKeys(gitProvider),
                    id: gitProvider.id,
                  }
                : undefined,
          },
        );
        if ("error" in res) {
          useStore.getState().setChatCmdError(ownerChatId ?? st.activeChatId, res.error);
        } else if (res.usage) {
          // Bill the commit-message call into the chat's cumulative usage,
          // grouped under the provider that ACTUALLY ran it — mirroring the
          // compact path. No usage on the heuristic fallback (no model call).
          const cu: CompactUsage = res.usage;
          const pid = cu.provider_id || cu.provider || commitProvider.id;
          useStore.getState().accrueChatUsage(
            ownerChatId ?? st.activeChatId,
            pid,
            normalizeUsageModel(pid, cu.model || commitModel),
            {
              input: cu.input_tokens ?? 0,
              output: cu.output_tokens ?? 0,
              cacheRead: cu.cache_read_tokens ?? 0,
              cacheWrite: cu.cache_write_tokens ?? 0,
            },
          );
        }
      } finally {
        setIsCommitting(false);
      }
    })();
  };
  const handleGitUndo = () => {
    // The bar arms the undo (two-click confirm) — window.confirm is
    // unreliable in Tauri's WKWebView, so no dialog here.
    if (!root || isUndoing) return;
    void (async () => {
      setIsUndoing(true);
      try {
        const res = await gitDiscard(root);
        if ("error" in res) {
          useStore.getState().setChatCmdError(ownerChatId ?? useStore.getState().activeChatId, res.error);
        }
      } finally {
        setIsUndoing(false);
      }
    })();
  };
  const handleGitPush = () => {
    if (!root || isPushing) return;
    void (async () => {
      setIsPushing(true);
      try {
        const res = await gitPush(root);
        if ("error" in res) {
          useStore.getState().setChatCmdError(ownerChatId ?? useStore.getState().activeChatId, res.error);
        }
      } finally {
        setIsPushing(false);
      }
    })();
  };
  // ---- Source selector as ONE dropdown (was three separate tab buttons) ----
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSourceMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sourceMenuOpen]);

  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  // Latest silent loader — the /ws/events subscription lives in its own
  // effect (keyed on root only) and pulls the trigger through this ref.
  const gitLoadRef = useRef<((silent: boolean) => void) | null>(null);
  // Bumped after a branch switch/create so the file list refetches at once.
  const [gitTick, setGitTick] = useState(0);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [rev, setRev] = useState(props?.initialRev ?? "HEAD");
  useEffect(() => {
    if (props?.initialRev !== undefined) setRev(props.initialRev);
  }, [props?.initialRev]);
  const [query, setQuery] = useState("");

  // بارگذاری دیف uncommitted: ترکیب staged و unstaged تا فایل‌های استیج‌شده
  // هم آمار واقعی داشته باشند (نه +0 -0)، بعد تفکیک per-file.
  // LIVES: a 5s background beat (and window focus) refreshes the list SILENTLY
  // — no loading flag, no error flash, and the list object only changes when
  // something actually changed, so the DOM never flickers. Visible loading is
  // reserved for tab switches and explicit refreshes (gitTick).
  useEffect(() => {
    if (source !== "uncommitted" || !root) return;
    let cancelled = false;
    const sameGitFiles = (
      a: GitFile[],
      b: GitFile[],
    ) =>
      a.length === b.length &&
      a.every((f, i) => f.path === b[i].path && f.adds === b[i].adds && f.dels === b[i].dels);
    const load = async (silent: boolean) => {
      gitLoadRef.current = (s) => void load(s);
      if (!silent) {
        setGitLoading(true);
        setGitError(null);
      }
      try {
        const [st, unstaged, staged] = await Promise.all([
          gitStatus(root),
          gitDiff(root),
          gitDiff(root, "", true),
        ]);
        if (cancelled) return;
        if ("error" in unstaged) {
          // Background ticks keep the last good list; visible loads report it.
          if (!silent) {
            setGitFiles([]);
            setGitError(unstaged.error ?? "git diff failed");
          }
          return;
        }
        // فایل‌های untracked در diff نیستند — `buildUncommittedFiles` آن‌ها را
        // از status اضافه می‌کند و staged/unstaged را per-file ادغام می‌کند.
        const statusPaths = "error" in st ? [] : st.entries.map((e) => e.path);
        const stagedDiff = "error" in staged ? "" : staged.diff;
        const next = buildUncommittedFiles(statusPaths, unstaged.diff, stagedDiff);
        setGitFiles((prev) =>
          silent && sameGitFiles(prev, next) ? prev : next,
        );
      } catch {
        // Silent tick transport errors keep the last good list.
      } finally {
        if (!cancelled && !silent) setGitLoading(false);
      }
    };
    void load(false);
    // Live push via /ws/events + a slow silent poll as a dead-socket fallback.
    const timer = setInterval(() => void load(true), 30000);
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      gitLoadRef.current = null;
    };
  }, [source, root, gitTick]);

  // Live: the backend pushes a change event whenever the workspace git state
  // moves — refresh silently (no loading flag, no flicker).
  useEffect(() => {
    if (!root) return;
    return onGitChange(root, () => gitLoadRef.current?.(true));
  }, [root]);

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
  // فایل‌های بیرونِ ورک‌اسپیس (مثلاً مسیر مطلق داخل پوشهٔ موقت سیستم) در لیست
  // نمی‌آیند: پنل Review «تغییرات این پروژه» را نشان می‌دهد و اجازهٔ نوشتن در
  // پوشهٔ موقت برای ابزار هست، ولی آن فایل‌ها بخشی از پروژه نیستند.
  const { inside: files, outside: outsideFiles } = useMemo(
    () => splitWorkspaceFiles(source === "turn" ? turnFiles : gitFiles, root),
    [source, turnFiles, gitFiles, root],
  );
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

  // انتخاب آکاردئون: همهٔ فایل‌ها به‌صورت پیش‌فرض بسته‌اند. فقط دو حالت باز
  // می‌کند: (۱) درخواست صریح — کلیک Review روی ادیت چت / تب بازِ داک‌شده،
  // (۲) فایلی که خود کاربر قبلاً باز کرده و هنوز در لیست هست. انتخابِ
  // باقی‌مانده از منبع قبلی (تعویض منبع، استریم جدید) به‌جای پرش به اولین
  // فایل، بسته می‌شود.
  const dockedWant = docked ? (props?.initialPath ?? "") : "";
  useEffect(() => {
    if (files.length === 0) return;
    if (dockedWant && files.some((f) => f.path === dockedWant)) {
      if (selectedPath !== dockedWant) selectPath(dockedWant);
      return;
    }
    const has = files.some((f) => f.path === selectedPath);
    if (selectedPath && !has) selectPath("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, turn?.files, gitFiles, dockedWant]);

  // فایل بازِ آکاردئون — وقتی کاربر همه را می‌بندد (`selectedPath` خالی) هیچ
  // فایلی باز نمی‌ماند، پس fallback به فایل اول نداریم.
  const selected = files.find((f) => f.path === selectedPath) ?? null;

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
  // در حالت docked همیشه `auto`: هر DiffView عرض واقعی کانتینر خودش را با
  // ResizeObserver می‌سنجد و زیر آستانه دوستونی تک‌ستونی می‌شود — پس در viewer باریک
  // (مانیتور کوچک) دیف خوانا می‌ماند.
  const wide = docked ? false : (fullscreen || width >= REVIEW_SIDE_BY_SIDE_THRESHOLD);
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
        wide={wide}
        root={root}
      />
    );
  };

  const panelRef = useRef<HTMLDivElement>(null)
  useVimScroll(panelRef)

  // The floating (non-docked) popup opens over the chat while the caret still
  // sits in the chat composer. useVimScroll treats a caret in an editable field
  // as TYPING and never scrolls, so h/j/k/l did nothing there (the docked diff
  // is entered through focusAppPane, which moves the caret). Take the caret into
  // the popup on open and hand it back to the chat when it closes.
  useEffect(() => {
    if (docked) return;
    const el = panelRef.current;
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    markVimRegion(el);
    return () => {
      const a = document.activeElement;
      if (a && a !== document.body) return; // focus already moved somewhere real
      const id = useStore.getState().activeChatId;
      if (id) requestAnimationFrame(() => focusChatInput(id));
    };
  }, [docked]);

  const panel = (
    <div
      ref={panelRef}
      className={docked ? "review-docked-wrap" : `review-overlay${fullscreen ? " fullscreen" : ""}`}
      dir="ltr"
      style={docked ? undefined : ({ "--review-w": `${width}px` } as React.CSSProperties)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* اسکریم نرم — فقط کلیک‌های پشت پنل را می‌گیرد؛ بستن با دکمه ✕ (کلیک
          بیرون پنل عمداً نمی‌بندد). */}
      {!docked && <div className="review-scrim" aria-hidden="true" />}
      {/* دستگیره‌ی درگ لبه — تغییرعرض مثل مطالعه (در فول‌اسکرین مخفی). */}
      {!docked && !fullscreen && (
        <div
          className="review-overlay-resize-handle"
          title="Drag to resize"
          onMouseDown={startResize}
        />
      )}
      <aside className={docked ? "review-panel review-docked-panel" : "review-panel review-floating-panel"} dir="ltr">
      <div className="review-header">
        <span className="review-source" ref={sourceMenuRef}>
          <button
            type="button"
            className="review-source-btn current"
            aria-haspopup="listbox"
            aria-expanded={sourceMenuOpen}
            title="Diff source"
            onClick={() => setSourceMenuOpen((o) => !o)}
          >
            {REVIEW_SOURCES.find(([key]) => key === source)?.[1]}
            <svg
              className="review-source-caret"
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {sourceMenuOpen && (
            <div className="review-source-menu" role="listbox" aria-label="Diff source">
              {REVIEW_SOURCES.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={source === key}
                  className={`review-source-item${source === key ? " active" : ""}`}
                  onClick={() => {
                    setSourceMenuOpen(false);
                    switchSource(key);
                  }}
                >
                  <span>{label}</span>
                  {source === key && (
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </span>
        {totals && (
          <span className="review-counts">
            <span className="review-count-add">+{totals.adds}</span>
            <span className="review-count-del">-{totals.dels}</span>
          </span>
        )}
        <span className="review-header-actions">
          <ComposerDiffBar
            root={root}
            isCommitting={isCommitting}
            isUndoing={isUndoing}
            isPushing={isPushing}
            onCommit={handleGitCommit}
            onUndo={handleGitUndo}
            onPush={handleGitPush}
            onError={setGitError}
            onBranchChanged={() => setGitTick((t) => t + 1)}
          />
          {!docked && <ViewerFullscreenButton docked={docked} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen((v) => !v)} />}
          {!docked && (
            <button
              className="review-header-btn"
              title="Close"
              aria-label="Close"
              onClick={close}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </span>
      </div>
      <div className="review-search-row">
        <label className="review-search" dir="ltr">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
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
          <div className="review-empty">
            {query.trim()
              ? `No files match “${query.trim()}”.`
              : "No files from this turn are inside the workspace."}
          </div>
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
      {outsideFiles.length > 0 && (
        <div className="review-note" dir="auto">
          {outsideFiles.length} file{outsideFiles.length === 1 ? "" : "s"} outside
          this workspace {outsideFiles.length === 1 ? "is" : "are"} hidden —{" "}
          {outsideFiles
            .slice(0, 3)
            .map((f) => toWorkspacePath(root, f.path))
            .join(", ")}
          {outsideFiles.length > 3 ? " …" : ""}
        </div>
      )}
      </aside>
    </div>
  );

  // مثل حالت مطالعه از پورتال به body رندر می‌شود تا `position: fixed`
  // نسبت به ویوپورت باشد و چت پشت آن کوچک نشود. در SSR (بدون document)
  // مستقیم رندر می‌شود تا تست سلامت خروجی را ببیند. در حالت docked مستقیم
  // داخل گروه viewer رندر می‌شود تا در split layout شرکت کند.
  if (docked || typeof document === "undefined") return panel;
  return createPortal(panel, document.body);
}
