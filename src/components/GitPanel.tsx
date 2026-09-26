import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { DiffView } from "./ToolCallView";
import {
  gitStatus,
  gitDiff,
  gitCommit,
  gitLog,
  type GitStatus,
  type GitDiff,
  type GitCommitInfo,
} from "../lib/api";

/** برچسب و رنگ کد وضعیت porcelain (xy) — خوانا به‌جای M/?? خام. */
function statusMeta(xy: string): { label: string; cls: string } {
  const x = xy[0]?.trim() ?? "";
  const y = xy[1]?.trim() ?? "";
  if (x === "?" || y === "?") return { label: "New", cls: "st-new" };
  if (x === "A" || y === "A") return { label: "Added", cls: "st-add" };
  if (x === "D" || y === "D") return { label: "Deleted", cls: "st-del" };
  if (x === "R" || y === "R") return { label: "Renamed", cls: "st-ren" };
  if (x === "U" || y === "U") return { label: "Unmerged", cls: "st-conf" };
  if (x === "M" || y === "M") return { label: "Modified", cls: "st-mod" };
  return { label: xy.trim() || "?", cls: "st-mod" };
}

/**
 * پنل گیت — وضعیت working tree، diff فایل انتخابی، فرم commit و تاریخچه.
 * همه‌ی عملیات از endpointهای امن sidecar (/git/*) می‌گذرند؛ هیچ دستور
 * شل اجرا نمی‌شود.
 */
export function GitPanel() {
  // root چتِ فعال (مثل CodeMapPanel) — s.root سراسری ممکنه با workspace چت
  // فعلی فرق داشته باشد و آن‌گاه commitهای ورک‌اسپیس اشتباه نمایش داده می‌شود.
  const root = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [message, setMessage] = useState("");
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    setError(null);
    try {
      const st = await gitStatus(root);
      if ("error" in st) {
        setStatus(null);
        setError(st.error ?? "git status failed");
        return;
      }
      setStatus(st);
      const log = await gitLog(root, 10);
      if (!("error" in log)) setCommits(log.commits);
    } finally {
      setLoading(false);
    }
  }, [root]);

  // بارگذاری اولیه هنگام باز شدن پنل.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // بستن با کلیک بیرون.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // diff فایل انتخابی.
  useEffect(() => {
    if (!open || !root) return;
    let cancelled = false;
    void (async () => {
      const d = await gitDiff(root, selected);
      if (!cancelled) setDiff("error" in d ? null : d);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, root, selected, status]);

  const commit = async () => {
    if (!root || !message.trim()) return;
    setCommitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await gitCommit(root, message.trim(), true);
      if ("error" in res) {
        setError(res.error ?? "commit failed");
        return;
      }
      setNotice(`committed ${res.commit}`);
      setMessage("");
      setSelected("");
      await refresh();
    } finally {
      setCommitting(false);
    }
  };

  const dirtyCount = status?.entries.length ?? 0;

  return (
    <div className="git-panel" ref={panelRef}>
      <button
        className="dir-toggle"
        title="Git — status, diff and commit"
        onClick={() => setOpen((o) => !o)}
      >
        ⎇{dirtyCount > 0 && <span className="git-badge">{dirtyCount}</span>}
      </button>
      {open && (
        <div className="git-list" dir="ltr">
          <div className="git-head">
            <span className="git-branch">{status?.branch || "…"}</span>
            <button
              className="checkpoints-refresh"
              title="Refresh"
              onClick={() => void refresh()}
            >
              ⟳
            </button>
          </div>
          <div className="git-scroll">
            {loading ? (
              <div className="checkpoints-empty">loading…</div>
            ) : error ? (
              <div className="checkpoints-error">{error}</div>
            ) : (
              <>
                {dirtyCount === 0 && (
                  <div className="checkpoints-empty">working tree clean</div>
                )}
                {status?.entries.map((e) => {
                  const meta = statusMeta(e.xy);
                  return (
                    <button
                      key={e.path}
                      className={`git-file${selected === e.path ? " selected" : ""}`}
                      onClick={() => setSelected(selected === e.path ? "" : e.path)}
                    >
                      <span className={`git-xy ${meta.cls}`}>{meta.label}</span>
                      <span className="git-path">{e.path}</span>
                    </button>
                  );
                })}
                {selected && (
                  <div className="git-diff-wrap">
                    {diff?.diff ? (
                      <DiffView diff={diff.diff} />
                    ) : (
                      <div className="checkpoints-empty">no changes</div>
                    )}
                    {diff?.truncated && (
                      <div className="checkpoints-empty">… (diff truncated)</div>
                    )}
                  </div>
                )}
                {commits.length > 0 && (
                  <div className="git-log">
                    {commits.map((c) => (
                      <div key={c.hash} className="git-log-row">
                        <span className="git-hash">{c.hash}</span>
                        <span className="git-subject">{c.subject}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="git-commit-form">
            <input
              type="text"
              placeholder="commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
              }}
            />
            <button
              className="git-commit-btn"
              disabled={committing || !message.trim() || dirtyCount === 0}
              onClick={() => void commit()}
            >
              {committing ? "…" : "Commit"}
            </button>
          </div>
          {notice && <div className="git-notice">{notice}</div>}
        </div>
      )}
    </div>
  );
}
