import { useEffect, useRef, useState } from "react";
import { ensureSidecar } from "../lib/api";
import {
  DEFAULT_VIEWPORT_SIZE,
  WIDTH_SLIDER_MAX,
  WIDTH_SLIDER_MIN,
  clampViewportSize,
} from "../lib/browserViewport";

/** Pointer position as percentages inside a bounding box — pure so the
 *  letterboxed-frame mapping can be unit-tested without a DOM. */
export function pctInBox(
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: box.width ? ((clientX - box.left) / box.width) * 100 : 0,
    y: box.height ? ((clientY - box.top) / box.height) * 100 : 0,
  };
}

/** The sidecar reports business failures as HTTP 200 + {ok:false,error};
 *  return that message so callers can throw it — otherwise a failed
 *  launch/navigate looks like a silent no-op in the panel. */
export function backendError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { ok?: unknown; error?: unknown };
  return b.ok === false ? String(b.error || "request failed") : null;
}

/** Live view of the shared in-app virtual browser (headless Chromium).
 *  Chrome-style shell: ONE omnibox (address) in the toolbar, history controls,
 *  a manual Dimensions row (numeric W/H inputs + horizontal common-width
 *  chips, no device names), and a keyboard-focusable stage that forwards
 *  typing straight to the page — so the panel never shows a second input box.
 *  The user's real mouse and keyboard are never touched. */
export function BrowserPanel() {
  const [image, setImage] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [active, setActive] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: DEFAULT_VIEWPORT_SIZE.width, h: DEFAULT_VIEWPORT_SIZE.height });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Virtual cursor overlay position (percent of the rendered frame).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const lastMoveAt = useRef(0);
  const lastHoverShotAt = useRef(0);
  // Debounced frame refresh after bursts of forwarded keystrokes.
  const keyShotTimer = useRef<number | null>(null);
  // Manual Chrome-style dimensions: numeric width/height inputs plus a
  // horizontal row of common widths (no device names). draftW/draftH are
  // the raw input strings so typing never fights the applied size.
  const [draftW, setDraftW] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.width));
  const [draftH, setDraftH] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.height));
  // Fit-to-pane: the viewport width follows the pane width, capped at the
  // last manually applied width — like Chrome shrinking the layout viewport
  // when the pane narrows and growing it back up to the set size.
  const [fitToPane, setFitToPane] = useState<boolean>(true);
  const capWRef = useRef<number>(DEFAULT_VIEWPORT_SIZE.width);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fitTimer = useRef<number | null>(null);
  const sizeRef = useRef(viewport);
  // Toolbar mouse toggle: hover only moves the virtual cursor while this is on.
  const [mouseMode, setMouseMode] = useState<boolean>(false);

  function syncDrafts(w: number, h: number): void {
    setDraftW(String(w));
    setDraftH(String(h));
  }

  // POST/GET helper against the sidecar. Throws on transport errors AND on
  // business errors ({ok:false}) so callers can surface a single error line.
  // `strict=false` is for polling endpoints where "not running" is an
  // expected state, not an error to show.
  async function sidecarFetch(path: string, init?: RequestInit, strict = true): Promise<any> {
    const base = await ensureSidecar();
    if (!base) throw new Error("sidecar not ready");
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.detail || `request failed (${res.status})`));
    const bizErr = strict ? backendError(body) : null;
    if (bizErr) throw new Error(bizErr);
    return body;
  }

  async function refreshStatus(): Promise<boolean> {
    try {
      const st = await sidecarFetch("/browser/status");
      const isActive = st.active === true;
      setActive(isActive);
      if (typeof st.url === "string") {
        // Never surface about:blank in the omnibox — it sticks and the
        // user has to delete it before typing (Chrome shows an empty box).
        const clean = st.url === "about:blank" ? "" : st.url;
        setPageUrl(clean);
        if (!address && clean) setAddress(clean);
        if (!clean && address === "about:blank") setAddress("");
      }
      if (st.viewport && typeof st.viewport.width === "number") {
        const w = st.viewport.width;
        const h = st.viewport.height;
        setViewport({ w, h });
        // Follow external resizes (agent/CDP) in the manual inputs too.
        syncDrafts(w, h);
      }
      return isActive;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function refreshShot(): Promise<void> {
    try {
      const shot = await sidecarFetch("/browser/screenshot", undefined, false);
      if (typeof shot.image === "string" && shot.image) {
        setImage(shot.image);
        if (typeof shot.width === "number") {
          setViewport({ w: shot.width, h: shot.height });
          syncDrafts(shot.width, shot.height);
        }
        setError("");
      }
    } catch (err) {
      // Polling failures stay silent while a frame is already showing;
      // only surface them when there is nothing to display yet.
      if (!image) setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Ensure the shared session exists on mount (idempotent: a running
  // session is left untouched), then poll frames roughly once a second.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await sidecarFetch("/browser/launch", {
          method: "POST",
          body: JSON.stringify({ url: "about:blank" }),
        });
      } catch (err) {
        // Show WHY the session won't start — the status call below only
        // reports active:false with no reason attached.
        setError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled) return;
      const isActive = await refreshStatus();
      if (!cancelled && isActive) await refreshShot();
      if (!cancelled) setLoading(false);
    })();
    timer.current = setInterval(() => {
      void refreshStatus().then((isActive) => {
        if (isActive) void refreshShot();
      });
    }, 1200);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      if (keyShotTimer.current) window.clearTimeout(keyShotTimer.current);
      keyShotTimer.current = null;
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function go(): Promise<void> {
    const raw = address.trim();
    if (!raw) return;
    setError("");
    // Omnibox like Chrome: a URL navigates, anything else is a search query —
    // the backend tries Google first, then Bing, then DuckDuckGo.
    try {
      if (isProbablyUrl(raw)) {
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
        await sidecarFetch(active ? "/browser/navigate" : "/browser/launch", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
      } else {
        if (!active) {
          await sidecarFetch("/browser/launch", {
            method: "POST",
            body: JSON.stringify({ url: "about:blank" }),
          });
        }
        const res = await sidecarFetch("/browser/search", {
          method: "POST",
          body: JSON.stringify({ query: raw }),
        });
        // Show the engine's results URL in the omnibox (like Chrome).
        if (typeof res.url === "string" && res.url) setAddress(res.url);
      }
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Session died while the tab still said "active" — drop the flag so the
      // next Enter relaunches instead of erroring forever.
      if (msg.includes("browser is not running")) setActive(false);
      setError(msg);
    }
  }

  // History controls: back / forward / reload through the shared session.
  async function historyAction(action: "back" | "forward" | "reload"): Promise<void> {
    if (!active) return;
    setError("");
    try {
      await sidecarFetch("/browser/history", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Session died while the tab stayed "active" — drop the flag so the
      // next click can relaunch instead of erroring forever.
      if (msg.includes("browser is not running")) setActive(false);
      setError(msg);
    }
  }

  /** Cursor-overlay position as % of the stage wrapper. The letterboxed
   *  image can be smaller than the wrapper, so the overlay must use the
   *  wrapper's coordinate space to stay under the pointer. */
  function hostPct(img: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
    const host = img.parentElement;
    const hr = host ? host.getBoundingClientRect() : null;
    const r = hr && hr.width > 0 ? hr : img.getBoundingClientRect();
    return pctInBox(r, clientX, clientY);
  }

  // Map a click on the scaled image back to viewport pixels.
  async function clickAt(e: React.MouseEvent<HTMLImageElement>): Promise<void> {
    if (!active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * viewport.w);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * viewport.h);
    setCursor(hostPct(e.currentTarget, e.clientX, e.clientY));
    try {
      await sidecarFetch("/browser/click", {
        method: "POST",
        body: JSON.stringify({ x, y }),
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pressKey(key: string): Promise<void> {
    if (!active) return;
    try {
      await sidecarFetch("/browser/key", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Debounced refresh: keystrokes arrive faster than frames should.
  function scheduleKeyShot(): void {
    if (keyShotTimer.current) return;
    keyShotTimer.current = window.setTimeout(() => {
      keyShotTimer.current = null;
      void refreshShot();
    }, 300);
  }

  /** Forward typing to the virtual page while the stage has focus — this is
   *  what replaces the old second (bottom) input box. */
  function stageKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!active) return;
    const k = e.key;
    const named = [
      "Enter", "Tab", "Escape", "Backspace", "Delete",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown",
    ];
    const plain = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain) {
      e.preventDefault();
      void sidecarFetch("/browser/type", {
        method: "POST",
        body: JSON.stringify({ text: k }),
      })
        .then(scheduleKeyShot)
        .catch(() => {
          // Keystroke forwarding is best-effort; transient failures are ignored.
        });
    } else if (named.includes(k)) {
      e.preventDefault();
      void pressKey(k);
    }
  }

  async function wheel(e: React.WheelEvent): Promise<void> {
    if (!active) return;
    try {
      await sidecarFetch("/browser/scroll", {
        method: "POST",
        body: JSON.stringify({ dx: 0, dy: Math.round(e.deltaY) }),
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch {
      // Wheel scroll is best-effort; ignore transient failures.
    }
  }

  // Keep a live ref of the applied size for the fit-to-pane observer.
  useEffect(() => {
    sizeRef.current = viewport;
  }, [viewport]);

  // Resize the shared viewport to an explicit size (manual inputs / chips).
  // The width becomes the new fit-to-pane cap.
  async function applySize(rawW: number, rawH: number): Promise<void> {
    if (!active) return;
    const { width, height } = clampViewportSize(rawW, rawH);
    setError("");
    try {
      await sidecarFetch("/browser/viewport", {
        method: "POST",
        body: JSON.stringify({ width, height }),
      });
      capWRef.current = width;
      setViewport({ w: width, h: height });
      syncDrafts(width, height);
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Slider drag: keep the current height, change only the width.

  // Fit-to-pane: when the pane narrows the viewport width follows it (down
  // only, capped at the last manual width); when the pane widens again the
  // width grows back up to that cap. Height is never touched here.
  useEffect(() => {
    const host = stageRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      if (!fitToPane || !active) return;
      const entry = entries[0];
      if (!entry) return;
      const paneW = Math.round(entry.contentRect.width - 24);
      if (!Number.isFinite(paneW) || paneW <= 0) return;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = null;
        const cur = sizeRef.current;
        const target = Math.max(200, Math.min(capWRef.current, paneW));
        if (target !== cur.w) void applySize(target, cur.h);
      }, 400);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToPane, active]);

  // Forward hover as a virtual cursor move (throttled) and show the cursor
  // overlay: the page reacts like a real pointer, the real mouse is untouched.
  function hoverAt(e: React.MouseEvent<HTMLImageElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Backend coords come from the IMG box (real page pixels); the overlay is
    // positioned in the WRAPPER box — mixing them offsets the virtual cursor
    // whenever the frame is letterboxed inside the stage.
    const p = pctInBox(rect, e.clientX, e.clientY);
    setCursor(hostPct(e.currentTarget, e.clientX, e.clientY));
    if (!active) return;
    const now = Date.now();
    if (now - lastMoveAt.current < 120) return;
    lastMoveAt.current = now;
    void sidecarFetch("/browser/move", {
      method: "POST",
      body: JSON.stringify({
        x: Math.round((p.x / 100) * viewport.w),
        y: Math.round((p.y / 100) * viewport.h),
      }),
    }).catch(() => {
      // Hover is best-effort; transient failures are ignored.
    });
    // Show hover states on the next frame, bounded to ~2 shots/s.
    if (now - lastHoverShotAt.current > 500) {
      lastHoverShotAt.current = now;
      window.setTimeout(() => void refreshShot(), 250);
    }
  }

  async function closeSession(): Promise<void> {
    try {
      await sidecarFetch("/browser/close", { method: "POST" });
      setActive(false);
      setImage("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="browser-panel">
      {/* Chrome-style toolbar: history + ONE omnibox + session controls */}
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-tool-btn"
          title="Back"
          aria-label="Back"
          disabled={!active}
          onClick={() => void historyAction("back")}
        >
          ←
        </button>
        <button
          type="button"
          className="browser-tool-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!active}
          onClick={() => void historyAction("forward")}
        >
          →
        </button>
        <button
          type="button"
          className="browser-tool-btn"
          title="Reload"
          aria-label="Reload"
          disabled={!active}
          onClick={() => void historyAction("reload")}
        >
          ⟳
        </button>
        <input
          className="browser-omnibox"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
          placeholder="Search or type a URL"
          spellCheck={false}
          aria-label="Address"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className={"browser-tool-btn" + (mouseMode ? " browser-tool-btn--on" : "")}
          title={mouseMode ? "Virtual mouse on — hover to move the pointer" : "Enable virtual mouse"}
          aria-label="Virtual mouse"
          aria-pressed={mouseMode}
          onClick={() => {
            const turningOff = mouseMode;
            setMouseMode((on) => !on);
            if (turningOff) setCursor(null);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M5 3l14 8-6.2 1.6L10 19z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="browser-tool-btn"
          title="Stop the virtual browser"
          aria-label="Stop browser"
          disabled={!active}
          onClick={() => void closeSession()}
        >
          ⏹
        </button>
      </div>

      {/* Dimensions bar — one Chrome-style horizontal strip: manual W/H
          inputs, horizontal width slider, fit icon and live size. */}
      <div className="browser-sizebar" role="toolbar" aria-label="Viewport size">
        <span className="browser-subbar-label">Dimensions</span>
        <input
          className="browser-dims-input"
          aria-label="Viewport width"
          title="Viewport width in CSS pixels"
          inputMode="numeric"
          value={draftW}
          onChange={(e) => setDraftW(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void applySize(Number(draftW), Number(draftH));
          }}
          onBlur={() => syncDrafts(viewport.w, viewport.h)}
        />
        <span aria-hidden="true">×</span>
        <input
          className="browser-dims-input"
          aria-label="Viewport height"
          title="Viewport height in CSS pixels"
          inputMode="numeric"
          value={draftH}
          onChange={(e) => setDraftH(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void applySize(Number(draftW), Number(draftH));
          }}
          onBlur={() => syncDrafts(viewport.w, viewport.h)}
        />
        <button
          type="button"
          className="browser-tool-btn browser-apply-btn"
          title="Apply viewport size"
          aria-label="Apply viewport size"
          disabled={!active}
          onClick={() => void applySize(Number(draftW), Number(draftH))}
        >
          ✓
        </button>
        <input
          type="range"
          className="browser-width-slider"
          aria-label="Viewport width slider"
          title={`Viewport width ${viewport.w}px (drag like Chrome)`}
          min={WIDTH_SLIDER_MIN}
          max={WIDTH_SLIDER_MAX}
          step={10}
          value={Math.min(WIDTH_SLIDER_MAX, Math.max(WIDTH_SLIDER_MIN, viewport.w))}
          disabled={!active}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDraftW(String(v));
            if (fitTimer.current) window.clearTimeout(fitTimer.current);
            fitTimer.current = window.setTimeout(() => {
              fitTimer.current = null;
              void applySize(v, sizeRef.current.h);
            }, 250);
          }}
        />
        <button
          type="button"
          className={"browser-tool-btn browser-fit-btn" + (fitToPane ? " browser-tool-btn--on" : "")}
          title={fitToPane ? "Fit to pane on — viewport width follows the pane, up to the applied width" : "Fit viewport width to the pane"}
          aria-label="Fit width to pane"
          aria-pressed={fitToPane}
          onClick={() => setFitToPane((on) => !on)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 9V4h5" />
            <path d="M20 9V4h-5" />
            <path d="M4 15v5h5" />
            <path d="M20 15v5h-5" />
          </svg>
        </button>
        <span className="browser-size">{viewport.w}x{viewport.h}</span>
      </div>

      {/* Stage: focusable, forwards keys + virtual cursor to the page */}
      <div
        ref={stageRef}
        className="browser-stage"
        tabIndex={0}
        title="Click the page, then type — keystrokes go to the virtual browser"
        onKeyDown={stageKeyDown}
        onMouseDown={(e) => e.currentTarget.focus()}
      >
        {loading ? (
          <div className="viewer-empty">Starting virtual browser…</div>
        ) : image ? (
          <div className="browser-stage-inner">
            <img
              src={image}
              alt="Virtual browser"
              className="browser-stage-img"
              onClick={(e) => void clickAt(e)}
              onWheel={(e) => void wheel(e)}
              onMouseMove={(e) => mouseMode && hoverAt(e)}
              onMouseLeave={() => setCursor(null)}
              draggable={false}
            />
            {mouseMode && cursor && (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                style={{
                  position: "absolute",
                  left: `${cursor.x}%`,
                  top: `${cursor.y}%`,
                  transform: "translate(-2px, -2px)",
                  pointerEvents: "none",
                  filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))",
                }}
                aria-hidden="true"
              >
                <path
                  d="M5 3l14 8-6.2 1.6L10 19z"
                  fill="#fff"
                  stroke="#111"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        ) : (
          <div className="viewer-empty">
            {active
              ? "No frame yet — press reload."
              : "Browser is stopped — type a URL above and press Enter."}
          </div>
        )}
      </div>

      <div
        className={"browser-status" + (error ? " browser-status--error" : "")}
        title={error || pageUrl}
      >
        {error || pageUrl || (active ? "running" : "stopped")}
      </div>
    </div>
  );
}

/** Chrome-style query-vs-URL heuristic (exported for tests): only a scheme,
 *  localhost/IP or a dotted host counts as a URL — everything else is sent
 *  to the search engines (Google first, then Bing, then DuckDuckGo). */
export function isProbablyUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s);
}
