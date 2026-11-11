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

/** An absolute filesystem path (POSIX or Windows) — NOT a virtual `media/…`
 *  path. Those live outside the chat's media sandbox and may therefore miss
 *  the sidecar's media route; they get the desktop-bridge data-URL fallback. */
function isAbsFsPath(p: string): boolean {
  return /^[/\\]/.test(p) || /^[a-zA-Z]:[/\\]/.test(p);
}

const FILE_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="9" cy="9" r="1.6" />
    <path d="M21 15.5 16 10.5 5.5 21" />
  </svg>
);
const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);
const REFRESH_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-2.3 6.3" />
    <path d="M20 4v7h-7" />
  </svg>
);
const OPEN_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </svg>
);
const ZOOM_IN_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 6v12M6 12h12" />
  </svg>
);
const ZOOM_OUT_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 12h12" />
  </svg>
);

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
  const cleanPath = filePath.trim();

  // Primary source: the sidecar media route (original bytes, chat-scoped
  // sandbox + workspace fallback). An ABSOLUTE path outside both sandboxes —
  // a screenshot in /var/folders, a file the agent read from anywhere — 404s
  // there, so on first failure the desktop bridge reads it as a data URL
  // (images only; the same source FileViewerPanel uses).
  const directUrl = useMemo(
    () => (base ? mediaFileUrl(cleanPath, base, root) : null),
    [cleanPath, base, root],
  );
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ w?: number; h?: number; seconds?: number }>({});
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = fallbackSrc ?? directUrl;

  const handleLoadError = useCallback(() => {
    if (fallbackSrc) {
      setLoadError("The file could not be decoded.");
      return;
    }
    if (!isAbsFsPath(cleanPath)) {
      setLoadError("This media file is missing or unreadable.");
      return;
    }
    api
      .readImage(cleanPath)
      .then((dataUrl) => {
        if (dataUrl) setFallbackSrc(dataUrl);
        else setLoadError("This file is missing, or too large to display.");
      })
      .catch(() => setLoadError("This file is missing, or too large to display."));
  }, [cleanPath, fallbackSrc]);

  const refresh = useCallback(() => {
    setFallbackSrc(null);
    setLoadError(null);
    setMeta({});
    setReload((n) => n + 1);
  }, []);

  const openExternally = useCallback(() => {
    if (api.openFileExternal) {
      void api
        .openFileExternal(cleanPath, "default")
        .then((r) => {
          if (r && r.ok === false && r.error) setError(r.error);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [cleanPath]);

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

  const name = cleanPath.split(/[\\/]/).pop() || cleanPath;
  const dirTail = cleanPath.slice(0, cleanPath.length - name.length).replace(/[\\/]$/, "");
  const dims =
    meta.w && meta.h
      ? `${meta.w}×${meta.h}`
      : meta.seconds
        ? `${meta.seconds.toFixed(1)}s`
        : null;

  return (
    <div className="media-editor" dir="auto">
      <div className="media-editor-head">
        <span className="media-editor-fileicon" aria-hidden="true">
          {FILE_ICON}
        </span>
        <span className="media-editor-title" dir="ltr">
          <span className="media-editor-filename" title={cleanPath}>
            {name}
          </span>
          {dirTail && (
            <span className="media-editor-dir" dir="ltr" title={cleanPath}>
              {dirTail}
            </span>
          )}
        </span>
        {dims && (
          <span className="media-editor-badge" dir="ltr">
            {dims}
          </span>
        )}
        <span className="media-editor-badge media-editor-badge-kind" dir="ltr">
          {isVideo ? "video" : "image"}
        </span>
        <span className="media-editor-actions">
          <button
            type="button"
            className="media-editor-iconbtn"
            onClick={() => {
              setError(null);
              void downloadMedia(src ?? cleanPath, cleanPath, fallbackSrc ?? undefined)
                .then((outcome) => {
                  if (outcome === "saved") setNotice("Saved.");
                  else if (outcome === "downloaded") setNotice("Downloaded.");
                })
                .catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
            }}
            title="Save a copy anywhere on disk"
            aria-label="Download"
          >
            {DOWNLOAD_ICON}
          </button>
          <button
            type="button"
            className="media-editor-iconbtn"
            onClick={refresh}
            title="Re-read the file from disk (after a regeneration)"
            aria-label="Refresh"
          >
            {REFRESH_ICON}
          </button>
          <button
            type="button"
            className="media-editor-iconbtn"
            onClick={openExternally}
            title="Open with the default app"
            aria-label="Open externally"
          >
            {OPEN_ICON}
          </button>
        </span>
      </div>

      {loadError ? (
        <div className="media-editor-body">
          <div className="media-editor-canvas media-editor-canvas-empty">
            <div className="media-editor-missing">
              <span className="media-editor-missing-glyph" aria-hidden="true">
                {isVideo ? "🎬" : "🖼️"}
              </span>
              <span className="media-editor-missing-text">{loadError}</span>
              <span className="media-editor-missing-path" dir="ltr">
                {cleanPath}
              </span>
              <button type="button" className="btn tiny secondary" onClick={refresh}>
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : isVideo ? (
        <VideoEditor
          key={`${src}#${reload}`}
          src={src}
          filePath={filePath}
          root={root}
          cid={cid}
          busy={busy}
          run={run}
          onError={handleLoadError}
          onMeta={setMeta}
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
          onError={handleLoadError}
          onMeta={setMeta}
        />
      )}

      {busy && <div className="media-editor-status is-busy">Working — {busy}…</div>}
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
        ? "Sent — the reply appears in the chat."
        : outcome === "queued"
          ? "Queued — sends when the current turn finishes."
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
        placeholder="What should I change? Type here…"
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
      <div className="media-editor-ask-foot">
        <span className="media-editor-ask-hint">
          <kbd>Enter ↵</kbd> send · <kbd>Shift+Enter</kbd> newline
        </span>
        <button
          type="button"
          className="btn tiny primary"
          disabled={disabled || !typed.trim() || !cid}
          onClick={send}
        >
          Send to agent
        </button>
      </div>
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
  onError,
  onMeta,
}: {
  src: string | null;
  filePath: string;
  root: string;
  cid: string;
  busy: string | null;
  run: (label: string, body: Record<string, unknown>) => Promise<void>;
  onError: () => void;
  onMeta?: (m: { w?: number; h?: number }) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // Selection in NATURAL image pixels — what a mask/region needs.
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ x: number; y: number; mode: "pan" | "select" } | null>(null);

  const clampScale = (s: number) => Math.min(8, Math.max(0.2, s));

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRect(null);
  }, [src]);

  // The header shows the real pixel size (and the crop rescale uses it).
  useEffect(() => {
    onMeta?.({ w: natural.w || undefined, h: natural.h || undefined });
  }, [natural, onMeta]);

  // Escape clears the selection without touching zoom/pan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRect(null);
    };
    const el = canvasRef.current;
    el?.addEventListener("keydown", onKey);
    return () => el?.removeEventListener("keydown", onKey);
  }, []);

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

  // The overlay rect is computed in CANVAS coordinates so it tracks zoom/pan:
  // kept in natural px, mapped through the img box position every render.
  const displayRect = (() => {
    const canvasBox = canvasRef.current?.getBoundingClientRect();
    const box = imgRef.current?.getBoundingClientRect();
    if (!canvasBox || !box || !rect || !natural.w || !natural.h) return null;
    const sx = box.width / natural.w;
    const sy = box.height / natural.h;
    return {
      left: box.left - canvasBox.left + rect.x * sx,
      top: box.top - canvasBox.top + rect.y * sy,
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
    setScale((s) => clampScale(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
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

  if (!src) {
    // The sidecar origin is not known yet — nothing to fetch (the panel
    // re-renders once peekSidecarUrl() resolves).
    return (
      <div className="media-editor-body">
        <div className="media-editor-canvas media-editor-canvas-empty">
          <div className="media-editor-missing">
            <span className="media-editor-missing-glyph" aria-hidden="true">🖼️</span>
            <span className="media-editor-missing-text">Waiting for the backend…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="media-editor-body">
      <div
        ref={canvasRef}
        className="media-editor-canvas"
        tabIndex={-1}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- editor canvas */}
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
          onError={onError}
        />
        {displayRect && (
          <div
            className="media-editor-selection"
            style={{
              left: displayRect.left,
              top: displayRect.top,
              width: displayRect.width,
              height: displayRect.height,
            }}
          >
            <span className="media-editor-sel-size" dir="ltr">
              {Math.round(rect!.w)} × {Math.round(rect!.h)}
            </span>
          </div>
        )}
      </div>

      <div className="media-editor-toolbar">
        <span className="media-editor-toolgroup">
          <button
            type="button"
            className="media-editor-toolbtn"
            onClick={() => setScale((s) => clampScale(s / 1.25))}
            title="Zoom out"
            aria-label="Zoom out"
          >
            {ZOOM_OUT_ICON}
          </button>
          <button
            type="button"
            className="media-editor-zoompct"
            onClick={() => setScale(1)}
            title="Reset zoom to 100%"
            dir="ltr"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="media-editor-toolbtn"
            onClick={() => setScale((s) => clampScale(s * 1.25))}
            title="Zoom in"
            aria-label="Zoom in"
          >
            {ZOOM_IN_ICON}
          </button>
          <span className="media-editor-toolsep" />
          <button type="button" className="media-editor-toolbtn wide" onClick={reset}>
            Fit
          </button>
        </span>

        <span className="media-editor-toolhint" dir="ltr">
          drag to select · shift-drag to pan
        </span>

        <span className="media-editor-toolspring" />

        {rect && natural.w > 0 && (
          <span className="media-editor-hint" dir="ltr">
            {Math.round(rect.x)},{Math.round(rect.y)} · {Math.round(rect.w)}×{Math.round(rect.h)} px
          </span>
        )}
        {rect && (
          <button
            type="button"
            className="btn tiny secondary"
            onClick={() => setRect(null)}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className={`btn tiny ${rect ? "primary" : "secondary"}`}
          disabled={!rect || !!busy}
          onClick={() => void run("Cropping", {
            action: "crop",
            path: filePath,
            x: Math.round(rect?.x ?? 0),
            y: Math.round(rect?.y ?? 0),
            w: Math.round(rect?.w ?? 0),
            h: Math.round(rect?.h ?? 0),
            src_w: natural.w,
            src_h: natural.h,
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
  onError,
  onMeta,
}: {
  src: string | null;
  filePath: string;
  root: string;
  cid: string;
  busy: string | null;
  run: (label: string, body: Record<string, unknown>) => Promise<void>;
  onError: () => void;
  onMeta?: (m: { seconds?: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [queue, setQueue] = useState<string[]>(() => loadMergeQueue());

  useEffect(() => {
    onMeta?.({ seconds: duration > 0 ? duration : undefined });
  }, [duration, onMeta]);

  const persistQueue = (next: string[]) => {
    setQueue(next);
    saveMergeQueue(next);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setTime(v.currentTime);
    const onMeta2 = () => setDuration(v.duration || 0);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta2);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta2);
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

  if (!src) {
    return (
      <div className="media-editor-body">
        <div className="media-editor-canvas media-editor-canvas-empty">
          <div className="media-editor-missing">
            <span className="media-editor-missing-glyph">🎬</span>
            <span>Waiting for the backend…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="media-editor-body">
      <div className="media-editor-canvas media-editor-canvas-video">
        <video ref={videoRef} className="media-editor-video" src={src} controls preload="metadata" onError={onError} />
      </div>

      <div className="media-editor-toolbar">
        <span className="media-editor-toolgroup">
          <span className="media-editor-hint" dir="ltr">
            {time.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
        </span>
        <span className="media-editor-toolspring" />
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
        {range && range.end > range.start && (
          <>
            <span className="media-editor-hint" dir="ltr">
              {range.start.toFixed(2)}s–{range.end.toFixed(2)}s
            </span>
            <button type="button" className="btn tiny secondary" onClick={playSelection}>
              Preview
            </button>
            <button
              type="button"
              className="btn tiny primary"
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
                [next[i + 1], next[i]] = [next[i], next[i - 1]];
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
