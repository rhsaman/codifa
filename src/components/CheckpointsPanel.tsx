import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { listCheckpoints, restoreCheckpoint } from "../lib/api";
import type { CheckpointEntry } from "../lib/api";

/**
 * پنل «Undo to checkpoint» — لیست snapshotهای چت فعال (جدیدترین اول) با
 * دکمه‌ی restore. snapshotها در بک‌اند به‌ازای هر turn (نه هر write) ساخته
 * می‌شوند، پس هر ردیف = کل تغییرات یک نوبت مدل.
 */
export function CheckpointsPanel() {
  const activeChatId = useStore((s) => s.activeChatId);
  // root چتِ فعال — restore باید روی همان workspaceای انجام شود که snapshot از آن گرفته شده.
  const root = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  );
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CheckpointEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busySeq, setBusySeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!activeChatId) return;
    setLoading(true);
    try {
      setItems(await listCheckpoints(activeChatId));
    } finally {
      setLoading(false);
    }
  }, [activeChatId]);

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

  const restore = async (seq: number) => {
    if (!activeChatId || !root) return;
    setBusySeq(seq);
    setError(null);
    try {
      const res = await restoreCheckpoint(activeChatId, seq, root);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // فایل‌هایی که بعد از snapshot تغییر کرده بودند در نتیجه علامت خورده‌اند.
      const changed = res.result.restored.filter((f) => f.changed);
      if (changed.length > 0)
        setError(
          `restored, but ${changed.length} file(s) had changed after this checkpoint and were overwritten`,
        );
      setOpen(false);
    } finally {
      setBusySeq(null);
    }
  };

  return (
    <div className="checkpoints-panel" ref={panelRef}>
      <button
        className="dir-toggle"
        title="Undo to checkpoint — restore files as they were before a model turn"
        onClick={() => setOpen((o) => !o)}
      >
        ↺
      </button>
      {open && (
        <div className="checkpoints-list" dir="ltr">
          <div className="checkpoints-head">
            <span>Checkpoints</span>
            <button
              className="checkpoints-refresh"
              title="Refresh"
              onClick={() => void refresh()}
            >
              ⟳
            </button>
          </div>
          {loading ? (
            <div className="checkpoints-empty">loading…</div>
          ) : items.length === 0 ? (
            <div className="checkpoints-empty">
              no checkpoints yet — one is saved before each model write
            </div>
          ) : (
            items.map((cp) => (
              <div key={cp.seq} className="checkpoint-row">
                <button
                  className="checkpoint-restore"
                  disabled={busySeq != null}
                  title="Restore files to this snapshot"
                  onClick={() => void restore(cp.seq)}
                >
                  {busySeq === cp.seq ? "restoring…" : `#${cp.seq}`}
                </button>
                <span className="checkpoint-meta">
                  {cp.paths.length} file{cp.paths.length === 1 ? "" : "s"}
                  {cp.created
                    ? ` · ${new Date(cp.created * 1000).toLocaleTimeString()}`
                    : ""}
                </span>
              </div>
            ))
          )}
          {error && <div className="checkpoints-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
