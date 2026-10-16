import { useEffect, useRef, useState } from "react";
import { ensureSidecar } from "../lib/api";
import {
  DEFAULT_VIEWPORT_SIZE,
  WIDTH_RULER_STEP,
  WIDTH_SLIDER_MAX,
  WIDTH_SLIDER_MIN,
  capAfterPoll,
  clampViewportSize,
  fitWidthTarget,
  frameZoom,
  rulerLabelForWidth,
  rulerPctForWidth,
  rulerWidthForPct,
  shouldSyncViewportDrafts,
  widthRulerTicks,
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
 *  a DevTools-like Dimensions bar (Responsive dropdown, numeric W/H inputs
 *  plus a horizontal width slider), and a keyboard-focusable stage that
 *  forwards typing straight to the page — so the panel never shows a second
 *  input box. The virtual cursor is always live on hover, like a real
 *  Chrome window; the user's real mouse and keyboard are never touched. */
export function BrowserPanel({ chatId = "" }: { chatId?: string }) {
  const [image, setImage] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [active, setActive] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  // True while a navigation (URL / search / history action) is in flight —
  // drives the toolbar progress line and the spinning reload icon.
  const [busy, setBusy] = useState<boolean>(false);
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
  // graduated width ruler (no device names). draftW/draftH are the raw
  // input strings so typing never fights the applied size.
  const [draftW, setDraftW] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.width));
  const [draftH, setDraftH] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.height));
  // Fit-to-pane: the viewport width follows the pane width, capped at the
  // last manually applied width — like Chrome shrinking the layout viewport
  // when the pane narrows and growing it back up to the set size.
  const [fitToPane, setFitToPane] = useState<boolean>(true);
  // Pane (stage) box in CSS px. Drives BOTH the fit-to-pane width and the
  // on-screen zoom of the frame, so a splitter drag or a window resize
  // rescales the frame immediately.
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // "..." overflow menu (CDP endpoint for DevTools comes from the backend
  // on demand — see openDevTools).
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const capWRef = useRef<number>(DEFAULT_VIEWPORT_SIZE.width);
  // Last size WE applied (manual or fit). A status poll that echoes this back
  // is our own resize, not an external one, so it must not touch the cap.
  const appliedRef = useRef<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fitTimer = useRef<number | null>(null);
  const sizeRef = useRef(viewport);
  // Live mirrors for the polling interval: the interval closure is created
  // once on mount, so reading state directly would see stale values and
  // overwrite the omnibox while typing (or resurface errors over a frame).
  const addressRef = useRef(address);
  addressRef.current = address;
  const imageRef = useRef(image);
  imageRef.current = image;
  // Virtual cursor is always live: hover moves the page pointer directly,
  // no toggle needed (like a real Chrome window).
  // Ruler hover tooltip (width under the pointer) + drag state.
  const [rulerHover, setRulerHover] = useState<number | null>(null);
  const rulerDragRef = useRef<boolean>(false);
  const rulerPendingRef = useRef<number | null>(null);
  const rulerTimerRef = useRef<number | null>(null);

  function syncDrafts(w: number, h: number): void {
    setDraftW(String(w));
    setDraftH(String(h));
  }

  // True while the user is typing in a W/H input — incoming polls must not
  // overwrite the drafts mid-typing.
  function isEditingDims(): boolean {
    if (typeof document === "undefined") return false;
    const el = document.activeElement;
    return el instanceof HTMLInputElement && el.classList.contains("browser-dims-input");
  }

  // POST/GET helper against the sidecar. Throws on transport errors AND on
  // business errors ({ok:false}) so callers can surface a single error line.
  // `strict=false` is for polling endpoints where "not running" is an
  // expected state, not an error to show. Every /browser/* call carries
  // this tab's chat id so each chat drives its own isolated Chromium
  // (backend _sessions key); the component remounts per chat (key=tab id)
  // so the closure value is stable for the session lifetime.
  async function sidecarFetch(path: string, init?: RequestInit, strict = true): Promise<any> {
    const base = await ensureSidecar();
    if (!base) throw new Error("sidecar not ready");
    let url = `${base}${path}`;
    let bodyInit: RequestInit | undefined = init;
    if (path.startsWith("/browser/")) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (chatId) url += (path.includes("?") ? "&" : "?") + `chat_id=${encodeURIComponent(chatId)}`;
      } else {
        try {
          const raw = typeof init?.body === "string" ? init.body : "{}";
          const parsed = raw ? JSON.parse(raw) : {};
          if (typeof parsed === "object" && parsed !== null && chatId && !parsed.chat_id) {
            parsed.chat_id = chatId;
            bodyInit = { ...init, body: JSON.stringify(parsed) };
          }
        } catch {
          // Non-JSON body — send as-is.
        }
      }
    }
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...bodyInit,
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
        if (!addressRef.current && clean) setAddress(clean);
        if (!clean && addressRef.current === "about:blank") setAddress("");
      }
      if (st.viewport && typeof st.viewport.width === "number") {
        const w = st.viewport.width;
        const h = st.viewport.height;
        const prev = sizeRef.current;
        if (w !== prev.w || h !== prev.h) {
          // Only a GENUINE external resize (agent/CDP) becomes the new cap.
          // A poll echoing our own apply must not touch it: a fit-shrunk
          // width would otherwise collapse the cap, and once cap === current
          // width the fit target never differs again — the panel freezes at
          // one size and the ruler appears to do nothing.
          capWRef.current = capAfterPoll(appliedRef.current, w, h, capWRef.current);
          setViewport({ w, h });
          // Follow external resizes (agent/CDP) in the manual inputs too —
          // but never clobber the drafts while the user is typing.
          if (shouldSyncViewportDrafts(prev.w, prev.h, w, h, isEditingDims())) syncDrafts(w, h);
        }
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
          const prev = sizeRef.current;
          if (shot.width !== prev.w || shot.height !== prev.h) {
            // Do NOT touch capWRef here: the cap is the user's MANUAL width.
            // Overwriting it with the polled (possibly fit-shrunk) size made
            // the pane unable to grow back — after one narrow fit the cap stuck
            // at the small width, so widening the panel never re-fitted.
            setViewport({ w: shot.width, h: shot.height });
            if (shouldSyncViewportDrafts(prev.w, prev.h, shot.width, shot.height, isEditingDims())) {
              syncDrafts(shot.width, shot.height);
            }
          }
        }
        setError("");
      }
    } catch (err) {
      // Polling failures stay silent while a frame is already showing;
      // only surface them when there is nothing to display yet.
      if (!imageRef.current) setError(err instanceof Error ? err.message : String(err));
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
      if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
      rulerTimerRef.current = null;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function go(): Promise<void> {
    const raw = address.trim();
    if (!raw) return;
    setError("");
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  // History controls: back / forward / reload through the shared session.
  async function historyAction(action: "back" | "forward" | "reload"): Promise<void> {
    if (!active) return;
    setError("");
    setBusy(true);
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
    } finally {
      setBusy(false);
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

  // Resize the shared viewport to an explicit size (manual inputs / ruler).
  // Manual resizes become the new fit-to-pane cap; fit-to-pane follow calls
  // pass updateCap=false so shrinking never destroys the cap.
  async function applySize(rawW: number, rawH: number, updateCap = true): Promise<void> {
    if (!active) return;
    const { width, height } = clampViewportSize(rawW, rawH);
    setError("");
    try {
      await sidecarFetch("/browser/viewport", {
        method: "POST",
        body: JSON.stringify({ width, height }),
      });
      if (updateCap) {
        // A manual size (ruler / numeric inputs) becomes the new CAP, but the
        // pane keeps driving the width below it. Follow mode is deliberately
        // NOT switched off here: the panel must stay responsive when the user
        // drags the splitter or resizes the window, which is exactly what the
        // old setFitToPane(false) broke — after one ruler touch the width was
        // frozen forever. The toolbar's Responsive button still toggles it.
        capWRef.current = width;
        // A pending debounced pane fit must not undo the choice the user just
        // made (a ruler drag fires applySize while a fit may still be queued).
        if (fitTimer.current) window.clearTimeout(fitTimer.current);
        fitTimer.current = null;
      }
      // Sync the refs immediately: the viewport effect runs after render, and
      // a poll in between would misread our own resize as an external one.
      appliedRef.current = { w: width, h: height };
      sizeRef.current = { w: width, h: height };
      setViewport({ w: width, h: height });
      syncDrafts(width, height);
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Fit-to-pane: when the pane narrows the viewport width follows it (down
  // only, capped at the last manual width); when the pane widens again the
  // width grows back up to that cap. Height is never touched here. The cap
  // itself is preserved (updateCap=false) so shrinking never destroys it.
  useEffect(() => {
    const host = stageRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    // The pane box is recorded on EVERY resize, not only in follow mode: the
    // frame's on-screen zoom is derived from it, so dragging the splitter or
    // resizing the window rescales the frame even while the emulated viewport
    // is pinned by the ruler.
    const measure = (w: number, h: number): void => {
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
      setPane((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const readPane = (): { w: number; h: number } => ({
      w: Math.round(host.clientWidth),
      h: Math.round(host.clientHeight),
    });
    // One handler for both triggers: the observer (splitter drag) and the
    // window resize. Reading clientWidth keeps it consistent with the initial
    // measurement, and the window listener covers embeddings where the
    // observer does not fire.
    const onResize = (): void => {
      const { w, h } = readPane();
      measure(w, h);
      if (!fitToPane || !active) return;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = null;
        const cur = sizeRef.current;
        const target = fitWidthTarget(w, capWRef.current);
        if (target !== cur.w) void applySize(target, cur.h, false);
      }, 400);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    window.addEventListener("resize", onResize);
    // Apply once on mount / when follow mode is switched back on, so the
    // toggle takes effect without waiting for a pane resize.
    onResize();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToPane, active]);

  // End a ruler drag even when the pointer is released outside the ruler.
  useEffect(() => {
    const up = () => {
      if (!rulerDragRef.current) return;
      rulerDragRef.current = false;
      const pending = rulerPendingRef.current;
      rulerPendingRef.current = null;
      if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
      rulerTimerRef.current = null;
      if (pending !== null) void applySize(pending, sizeRef.current.h);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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
      setMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Close the "..." menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".browser-menu-wrap")) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Open the current page in the OS default browser (outside the app).
  async function openInDefaultBrowser(): Promise<void> {
    setMenuOpen(false);
    const url = pageUrl || address.trim();
    if (!url) return;
    setError("");
    try {
      const opener = (window as unknown as { coder?: { openExternal?: (u: string) => Promise<void> } }).coder?.openExternal;
      if (typeof opener === "function") await opener.call(window.coder, url);
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Open DevTools for the live session in the OS browser. The backend
  // resolves AND verifies the frontend URL — the old renderer-side
  // /json/list fetch was blocked (cross-origin) and silently fell back to
  // the bare CDP root, which opens as a white page.
  async function openDevTools(): Promise<void> {
    setMenuOpen(false);
    if (!active) return;
    setError("");
    try {
      const res = await sidecarFetch("/browser/devtools-url");
      const url = typeof res.url === "string" ? res.url : "";
      if (!url) throw new Error(String(res.error || "DevTools URL unavailable"));
      // The frontend dials a loopback ws:// socket other default browsers
      // (e.g. Safari) block — open it in Chrome directly when available.
      const bridge = (window as unknown as {
        coder?: {
          openExternalChrome?: (u: string) => Promise<void>;
          openExternal?: (u: string) => Promise<void>;
        };
      }).coder;
      if (typeof bridge?.openExternalChrome === "function") await bridge.openExternalChrome(url);
      else if (typeof bridge?.openExternal === "function") await bridge.openExternal(url);
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // On-screen size of the emulated frame. The frame is never upscaled past
  // 1:1 and always shrinks to fit the pane, so the ruler visibly changes the
  // frame size AND a splitter drag / window resize refits it. The CSS used to
  // stretch the image to the pane, which made every viewport change invisible.
  const zoom = frameZoom(pane.w, pane.h, viewport.w, viewport.h);
  const frameW = Math.max(1, Math.round(viewport.w * zoom));
  const frameH = Math.max(1, Math.round(viewport.h * zoom));

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
          <BackIcon />
        </button>
        <button
          type="button"
          className="browser-tool-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!active}
          onClick={() => void historyAction("forward")}
        >
          <ForwardIcon />
        </button>
        <button
          type="button"
          className={"browser-tool-btn" + (busy ? " browser-tool-btn--spin" : "")}
          title="Reload"
          aria-label="Reload"
          disabled={!active}
          onClick={() => void historyAction("reload")}
        >
          <ReloadIcon />
        </button>
        <button
          type="button"
          className={"browser-tool-btn" + (fitToPane ? " browser-tool-btn--on" : "")}
          title={
            fitToPane
              ? "Following the panel width — click to keep a fixed size"
              : "Fixed size — click to fit the panel width"
          }
          aria-label="Fit to panel"
          aria-pressed={fitToPane}
          disabled={!active}
          onClick={() => setFitToPane((v) => !v)}
        >
          <FitIcon />
        </button>
        <div className="browser-omnibox-wrap">
          <span className="browser-omnibox-icon" aria-hidden="true">
            {!address.trim() ? <GlobeIcon /> : isProbablyUrl(address) ? <LockIcon /> : <SearchIcon />}
          </span>
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
        </div>
        <button
          type="button"
          className="browser-tool-btn"
          title="Stop the virtual browser"
          aria-label="Stop browser"
          disabled={!active}
          onClick={() => void closeSession()}
        >
          <StopIcon />
        </button>
        <div className="browser-menu-wrap">
          <button
            type="button"
            className="browser-tool-btn"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <KebabIcon />
          </button>
          <div className="browser-menu" role="menu" hidden={!menuOpen}>
            <button
              type="button"
              className="browser-menu-item"
              role="menuitem"
              aria-label="Open in default browser"
              disabled={!active}
              onClick={() => void openInDefaultBrowser()}
            >
              <span className="browser-menu-item-icon" aria-hidden="true">↗</span>
              Open in default browser
            </button>
            <button
              type="button"
              className="browser-menu-item"
              role="menuitem"
              aria-label="Open DevTools"
              disabled={!active}
              onClick={() => void openDevTools()}
            >
              <span className="browser-menu-item-icon" aria-hidden="true">🐞</span>
              Open DevTools
            </button>
          </div>
        </div>
      </div>

      {/* Chrome-style loading line: fades in under the toolbar while a
          navigation runs, keeps its 2px slot otherwise (no layout shift). */}
      <div
        className={"browser-progress" + (busy ? " browser-progress--on" : "")}
        aria-hidden="true"
      />

      {/* Width ruler — full-width Chrome DevTools-style graduated bar below
          the toolbar. Hover shows "Laptop - 1024px", drag/keyboard resizes. */}
      <div
        className="browser-width-ruler browser-width-ruler--full"
        role="slider"
        aria-label="Viewport width ruler"
        aria-valuemin={WIDTH_SLIDER_MIN}
        aria-valuemax={WIDTH_SLIDER_MAX}
        aria-valuenow={viewport.w}
        aria-valuetext={`${rulerLabelForWidth(viewport.w)} - ${viewport.w}px`}
        tabIndex={active ? 0 : -1}
        data-disabled={!active}
        title={`${rulerLabelForWidth(viewport.w)} - ${viewport.w}px`}
        onMouseDown={(e) => {
          if (!active) return;
          // Ticks handle their own click — don't start a drag for them.
          const t = e.target as HTMLElement | null;
          if (t?.closest?.(".browser-ruler-tick")) return;
          rulerDragRef.current = true;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 0;
          const v = rulerWidthForPct(pct);
          rulerPendingRef.current = v;
          setDraftW(String(v));
          setRulerHover(v);
        }}
        onMouseMove={(e) => {
          if (!active) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 0;
          const v = rulerWidthForPct(pct);
          const target = e.target as HTMLElement | null;
          const onTick = !!target?.closest?.(".browser-ruler-tick");
          // A tick sets its own exact hover value on enter — don't let the
          // bubbled mousemove overwrite it with the pointer position, so the
          // tooltip reads "Laptop - 1024px" instead of a nearby width.
          // While dragging the tooltip follows the pointer even over ticks.
          if (!onTick || rulerDragRef.current) setRulerHover(v);
          if (!rulerDragRef.current) return;
          rulerPendingRef.current = v;
          setDraftW(String(v));
          if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
          rulerTimerRef.current = window.setTimeout(() => {
            rulerTimerRef.current = null;
            const pending = rulerPendingRef.current;
            rulerPendingRef.current = null;
            if (pending !== null) void applySize(pending, sizeRef.current.h);
          }, 250);
        }}
        onMouseUp={() => {
          if (!rulerDragRef.current) return;
          rulerDragRef.current = false;
          // Click without a move still resizes (a plain click did nothing
          // before because apply only ran on debounced mousemove).
          const pending = rulerPendingRef.current;
          rulerPendingRef.current = null;
          if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
          rulerTimerRef.current = null;
          if (pending !== null) void applySize(pending, sizeRef.current.h);
        }}
        onMouseLeave={() => {
          // Keep the drag alive when the pointer leaves mid-drag — a
          // window-level mouseup ends it (see effect below).
          if (!rulerDragRef.current) setRulerHover(null);
        }}
        onKeyDown={(e) => {
          if (!active) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const delta = e.key === "ArrowLeft" ? -WIDTH_RULER_STEP : WIDTH_RULER_STEP;
            void applySize(viewport.w + delta, sizeRef.current.h);
          }
        }}
      >
        {widthRulerTicks().map((w) => (
          <span
            key={w}
            className="browser-ruler-tick"
            style={{ left: `${rulerPctForWidth(w)}%` }}
            title={`${rulerLabelForWidth(w)} - ${w}px`}
            onMouseEnter={() => setRulerHover(w)}
            onFocus={() => setRulerHover(w)}
            onClick={() => {
              if (active) void applySize(w, sizeRef.current.h);
            }}
          >
            <span className="browser-ruler-tick-label" aria-hidden="true">{w}</span>
          </span>
        ))}
        <div
          className="browser-ruler-thumb"
          style={{ left: `${rulerPctForWidth(viewport.w)}%` }}
          aria-hidden="true"
        />
        {rulerHover !== null && (
          <span
            className="browser-ruler-tip"
            style={{ left: `${rulerPctForWidth(rulerHover)}%` }}
            aria-hidden="true"
          >
            {`${rulerLabelForWidth(rulerHover)} - ${rulerHover}px`}
          </span>
        )}
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
          <div className="browser-stage-inner" style={{ width: frameW, height: frameH }}>
            <img
              src={image}
              alt="Virtual browser"
              className="browser-stage-img"
              onClick={(e) => void clickAt(e)}
              onWheel={(e) => void wheel(e)}
              onMouseMove={(e) => hoverAt(e)}
              onMouseLeave={() => setCursor(null)}
              draggable={false}
            />
            {cursor && (
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

/* ── Toolbar SVG icons: stroke follows currentColor, crisp at any DPI —
   replacing the old text glyphs (← ⟳ ⏹ …) which rendered thin and uneven. */

function SvgIcon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function FitIcon() {
  return (
    <SvgIcon>
      <path d="M4 9V4h5" />
      <path d="M20 15v5h-5" />
      <path d="M15 4h5v5" />
      <path d="M9 20H4v-5" />
    </SvgIcon>
  );
}

function BackIcon() {
  return (
    <SvgIcon>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </SvgIcon>
  );
}

function ForwardIcon() {
  return (
    <SvgIcon>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </SvgIcon>
  );
}

function ReloadIcon() {
  return (
    <SvgIcon>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </SvgIcon>
  );
}

function StopIcon() {
  return (
    <SvgIcon>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

function KebabIcon() {
  return (
    <SvgIcon>
      <circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Omnibox leading icon: lock for URLs, magnifier for search queries,
 *  globe while the box is empty (matches what Enter will actually do). */
function LockIcon() {
  return (
    <SvgIcon size={13}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </SvgIcon>
  );
}

function SearchIcon() {
  return (
    <SvgIcon size={13}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </SvgIcon>
  );
}

function GlobeIcon() {
  return (
    <SvgIcon size={13}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z" />
    </SvgIcon>
  );
}
