/**
 * Media Editor — the manual surface for generated/edited images and clips
 * (viewer kind `media`).
 *
 * Everything here is OPTIONAL sugar over the same operations the agent's tools
 * perform: crop/trim/merge run through POST /media/edit (the SAME ffmpeg
 * helpers `edit_video` uses), and the ask box composes a precise instruction —
 * the media path, the selected rectangle (as coordinates AND as a cropped
 * inline image the vision model sees) or the selected time range — and sends
 * it as a real turn (queued transparently while a turn is already running).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/fs";
import { peekSidecarUrl } from "../lib/api";
import { sendOrQueue } from "../lib/chatSends";
import { downloadMedia } from "../lib/saveMedia";
import { isMediaVideoPath, mediaFileUrl } from "../lib/mediaUrl";
import { useViewerTabs } from "../lib/viewerTabs";

type Rect = { x: number; y: number; w: number; h: number };

interface MediaEditResponse {
  ok?: boolean;
  files?: string[];
  message?: string;
  detail?: string;
}

const MERGE_QUEUE_KEY = "coder:media-merge-queue";

function loadMergeQueue(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MERGE_QUEUE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveMergeQueue(paths: string[]): void {
  try {
    localStorage.setItem(MERGE_QUEUE_KEY, JSON.stringify(paths));
  } catch {
    /* storage unavailable */
  }
}

/** POST /media/edit — one local ffmpeg operation. Returns the first created
 *  file so the caller can open it in a fresh editor tab. */
async function mediaEdit(
  root: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<{ files: string[]; message: string }> {
  const base = peekSidecarUrl();
  if (!base) throw new Error("backend not reachable yet");
  const res = await fetch(`${base.replace(/\/+$/, "")}/media/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, chat_id: chatId, ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as MediaEditResponse;
  if (!res.ok) throw new Error(data.detail || `media edit failed (${res.status})`);
  return { files: data.files ?? [], message: data.message ?? "" };
}

export function MediaEditorPanel({
  filePath,
  fileRoot,
  chatId,
}: {
  filePath: string;
  fileRoot?: string;
  chatId?: string;
}) {
  const storeRoot = useStore((s) => s.root);
  const root = fileRoot || storeRoot;
  const cid = chatId ?? useStore((s) => s.activeChatId) ?? "";
  const isVideo = isMediaVideoPath(filePath);
  const base = peekSidecarUrl();
  const src = useMemo(() => mediaFileUrl(filePath, base), [filePath, base]);

  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The result of a crop/trim opens as a NEW media tab so the original stays.
  const openResult = useCallback(
    (files: string[]) => {
      const first = files[0];
      if (first) {
        useViewerTabs.getState().openMedia(first, root, cid || undefined);
      }
    },
    [root, cid],
  );

  const run = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const out = await mediaEdit(root, cid, body);
        setNotice(out.message || "done");
        openResult(out.files);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [root, cid, openResult],
  );

  return (
    <div className="media-editor" dir="auto">
      <div className="media-editor-head">
        <span className="media-editor-path" dir="ltr" title={filePath}>
          {filePath}
        </span>
        <button
          type="button"
          className="btn tiny secondary"
          onClick={() => {
            setError(null);
            void downloadMedia(src, filePath)
              .then((outcome) => {
                if (outcome === "saved") setNotice("Saved.");
                else if (outcome === "downloaded") setNotice("Downloaded.");
              })
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
          }}
          title="Save a copy anywhere on disk"
        >
          Download
        </button>
        <button
          type="button"
          className="btn tiny secondary"
          onClick={() => setReload((n) => n + 1)}
          title="Re-read the file from disk (after a regeneration)"
        >
          Refresh
        </button>
      </div>

      {isVideo ? (
        <VideoEditor
          key={`${src}#${reload}`}
          src={src}
          filePath={filePath}
          root={root}
          cid={cid}
          busy={busy}
          run={run}
          onNotice={setNotice}
        />
      ) : (
        <ImageEditor
          key={`${src}#${reload}`}
          src={src}
          filePath={filePath}
          root={root}
          cid={cid}
          busy={busy}
          run={run}
          onNotice={setNotice}
        />
      )}

      {busy && <div className="media-editor-status">Working — {busy}…</div>}
      {notice && <div className="media-editor-status ok">{notice}</div>}
      {error && <div className="media-editor-status err">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared ask-the-agent box: a real input, a real send
// ---------------------------------------------------------------------------

function AskAgentBox({
  cid,
  composePrompt,
  regionDataUrl,
  disabled,
}: {
  cid: string;
  /** Builds the final prompt from what the user typed. */
  composePrompt: (typed: string) => string;
  /** The cropped selection sent as an inline image (vision models see it). */
  regionDataUrl?: () => string | undefined;
  disabled?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const send = () => {
    const text = typed.trim();
    if (!text || !cid) return;
    const prompt = composePrompt(text);
    const image =
      regionDataUrl?.() !== undefined
        ? [{ path: "", name: "selection", dataUrl: regionDataUrl?.() }]
        : undefined;
    const outcome = sendOrQueue(cid, prompt, image);
    setStatus(
      outcome === "sent"
        ? "Sent to the agent — the reply appears in the chat."
        : outcome === "queued"
          ? "Queued — it will send when the current turn finishes."
          : "Chat not available.",
    );
    if (outcome !== "unavailable") setTyped("");
  };
  return (
    <div className="media-editor-ask" dir="ltr">
      <textarea
        className="media-editor-ask-input"
        // The chrome is English/LTR, but the TEXT the user types follows its
        // own language (dir=auto): a Persian sentence still renders RTL.
        dir="auto"
        rows={2}
        placeholder="What should I change? Type here, Enter to send"
        value={typed}
        disabled={disabled}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        type="button"
        className="btn tiny primary"
        disabled={disabled || !typed.trim() || !cid}
        onClick={send}
      >
        Send to agent
      </button>
      {status && <span className="media-editor-hint" dir="ltr">{status}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image editor: zoom/pan + rectangle select + crop + download + ask
// ---------------------------------------------------------------------------

function ImageEditor({
  src,
  filePath,
  root,
  cid,
  busy,
  run,
}: {
  src: string;
  filePath: string;
  root: string;
  cid: string;
  busy: string | null;
  run: (label: string, body: Record<string, unknown>) => Promise<void>;
  onNotice?: (msg: string | null) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // Selection in NATURAL image pixels — what a mask/region needs.
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ x: number; y: number; mode: "pan" | "select" } | null>(null);

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRect(null);
  };

  const toNatural = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = imgRef.current?.getBoundingClientRect();
    if (!box || !natural.w || !natural.h) return { x: 0, y: 0 };
    // The CSS transform already scales the rendered box, so mapping through
    // the CURRENT box size lands directly in natural pixels.
    return {
      x: ((clientX - box.left) / box.width) * natural.w,
      y: ((clientY - box.top) / box.height) * natural.h,
    };
  };

  // The overlay rect is computed in DISPLAY coordinates so it tracks zoom/pan:
  // kept in natural px, converted once per render via the img box ratio.
  const displayRect = (() => {
    const box = imgRef.current?.getBoundingClientRect();
    if (!box || !rect || !natural.w || !natural.h) return null;
    const sx = box.width / natural.w;
    const sy = box.height / natural.h;
    return {
      left: rect.x * sx,
      top: rect.y * sy,
      width: rect.w * sx,
      height: rect.h * sy,
    };
  })();

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const start = toNatural(e.clientX, e.clientY);
    drag.current = { x: start.x, y: start.y, mode: e.shiftKey ? "pan" : "select" };
    if (drag.current.mode === "select") setRect({ x: start.x, y: start.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "pan") {
      setOffset((o) => ({ x: o.x + e.movementX, y: o.y + e.movementY }));
      return;
    }
    const cur = toNatural(e.clientX, e.clientY);
    setRect({
      x: Math.min(d.x, cur.x),
      y: Math.min(d.y, cur.y),
      w: Math.abs(cur.x - d.x),
      h: Math.abs(cur.y - d.y),
    });
  };

  const onPointerUp = () => {
    drag.current = null;
    setRect((r) => (r && r.w > 4 && r.h > 4 ? r : null));
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(8, Math.max(0.2, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  };

  /** Crop the selected region off-screen to a PNG data URL — the inline copy
   *  the vision model actually SEES alongside the coordinates. */
  const regionDataUrl = (): string | undefined => {
    if (!rect) return undefined;
    const img = imgRef.current;
    if (!img) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w));
    canvas.height = Math.max(1, Math.round(rect.h));
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    try {
      ctx.drawImage(
        img,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return canvas.toDataURL("image/png");
    } catch {
      // Cross-origin taint — skip the inline copy, the coordinates still go.
      return undefined;
    }
  };

  return (
    <div className="media-editor-body">
      <div
        className="media-editor-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: "crosshair", overflow: "hidden", position: "relative" }}
      >
        <img
          ref={imgRef}
          className="media-editor-img"
          src={src}
          alt={filePath}
          crossOrigin="anonymous"
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "center" }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
        {displayRect && (
          <div
            className="media-editor-selection"
            style={{
              position: "absolute",
              left: displayRect.left,
              top: displayRect.top,
              width: displayRect.width,
              height: displayRect.height,
            }}
          />
        )}
      </div>

      <div className="media-editor-tools">
        {rect && natural.w > 0 && (
          <span className="media-editor-hint" dir="ltr">
            {Math.round(rect.x)},{Math.round(rect.y)} · {Math.round(rect.w)}×{Math.round(rect.h)} px
          </span>
        )}
        <button type="button" className="btn tiny secondary" onClick={reset}>Fit</button>
        <button
          type="button"
          className="btn tiny secondary"
          disabled={!rect || !!busy}
          onClick={() => void run("Cropping", {
            action: "crop",
            path: filePath,
            x: Math.round(rect?.x ?? 0),
            y: Math.round(rect?.y ?? 0),
            w: Math.round(rect?.w ?? 0),
            h: Math.round(rect?.h ?? 0),
          })}
        >
          Crop selection
        </button>
      </div>

      <AskAgentBox
        cid={cid}
        disabled={!!busy}
        regionDataUrl={rect ? regionDataUrl : undefined}
        composePrompt={(typed) => {
          const r = rect;
          const region =
            r && natural.w > 0
              ? ` edit the selected region (x=${Math.round(r.x)}, y=${Math.round(r.y)}, w=${Math.round(r.w)}, h=${Math.round(r.h)}) with the edit_image tool: `
              : ` edit this image with the edit_image tool: `;
          return `${filePath} —${region}${typed}`;
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video editor: player + in/out + trim + merge queue + ask
// ---------------------------------------------------------------------------

function VideoEditor({
  src,
  filePath,
  root,
  cid,
  busy,
  run,
}: {
  src: string;
  filePath: string;
  root: string;
  cid: string;
  busy: string | null;
  run: (label: string, body: Record<string, unknown>) => Promise<void>;
  onNotice?: (msg: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [queue, setQueue] = useState<string[]>(() => loadMergeQueue());

  const persistQueue = (next: string[]) => {
    setQueue(next);
    saveMergeQueue(next);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setTime(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, []);

  const setIn = () => setRange((r) => ({ start: videoRef.current?.currentTime ?? 0, end: r?.end ?? duration }));
  const setOut = () => setRange((r) => ({ start: r?.start ?? 0, end: videoRef.current?.currentTime ?? duration }));
  const playSelection = () => {
    const v = videoRef.current;
    if (!v || !range) return;
    v.currentTime = range.start;
    void v.play();
    const stop = () => {
      if (v.currentTime >= range.end) {
        v.pause();
        v.removeEventListener("timeupdate", stop);
      }
    };
    v.addEventListener("timeupdate", stop);
  };

  return (
    <div className="media-editor-body">
      <video ref={videoRef} className="media-editor-video" src={src} controls preload="metadata" />

      <div className="media-editor-tools">
        <span className="media-editor-hint" dir="ltr">
          {time.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
        <button
          type="button"
          className="btn tiny secondary"
          onClick={setIn}
          disabled={!!busy}
          title="Mark the START of the range at the current playhead"
        >
          Mark start
        </button>
        <button
          type="button"
          className="btn tiny secondary"
          onClick={setOut}
          disabled={!!busy}
          title="Mark the END of the range at the current playhead"
        >
          Mark end
        </button>
        {range && (
          <span className="media-editor-hint" dir="ltr">
            {range.start.toFixed(2)}s–{range.end.toFixed(2)}s
          </span>
        )}
        {range && range.end > range.start && (
          <>
            <button type="button" className="btn tiny secondary" onClick={playSelection}>
              Preview range
            </button>
            <button
              type="button"
              className="btn tiny secondary"
              disabled={!!busy}
              onClick={() => void run("Trimming", {
                action: "trim",
                path: filePath,
                start: range.start,
                end: range.end,
              })}
            >
              Trim selection
            </button>
          </>
        )}
      </div>

      <div className="media-editor-hint" dir="auto">
        Play the clip, pause at a moment, then “Mark start” / “Mark end” to
        define a range — preview it, trim it, or tell the agent what to change
        in that range.
      </div>

      <AskAgentBox
        cid={cid}
        disabled={!!busy}
        composePrompt={(typed) => {
          const span =
            range && range.end > range.start
              ? ` edit the ${range.start.toFixed(2)}s–${range.end.toFixed(2)}s range with the edit_video tool: `
              : ` edit this clip with the edit_video tool: `;
          return `${filePath} —${span}${typed}`;
        }}
      />

      <div className="media-editor-queue">
        <div className="media-editor-queue-head">
          <span className="field-label">Merge queue</span>
          <button
            type="button"
            className="btn tiny secondary"
            disabled={!!busy || queue.includes(filePath)}
            onClick={() => persistQueue([...queue, filePath])}
          >
            Add current
          </button>
          <button
            type="button"
            className="btn tiny"
            disabled={!!busy || queue.length < 2}
            onClick={() => void run("Merging", { action: "merge", paths: queue })}
          >
            Merge {queue.length} clips
          </button>
          <button
            type="button"
            className="btn tiny secondary"
            disabled={queue.length === 0}
            onClick={() => persistQueue([])}
          >
            Clear
          </button>
        </div>
        {queue.map((p, i) => (
          <div key={`${p}-${i}`} className="media-editor-queue-row">
            <span dir="ltr" className="media-editor-queue-path" title={p}>{p}</span>
            <button
              type="button"
              className="btn tiny secondary"
              disabled={i === 0}
              onClick={() => {
                const next = [...queue];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                persistQueue(next);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn tiny secondary"
              disabled={i === queue.length - 1}
              onClick={() => {
                const next = [...queue];
                [next[i + 1], next[i]] = [next[i], next[i + 1]];
                persistQueue(next);
              }}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn tiny secondary"
              onClick={() => persistQueue(queue.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
