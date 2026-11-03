import { useEffect, useRef, useState } from "react";
import { ensureSidecar, noteSidecarFailure } from "../lib/api";
import { browserFitKey, clearBrowserFit, loadBrowserFit, saveBrowserFit } from "../lib/browserPanelMemory";
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
 *  input box. Input is paced, not flooded: keystrokes go out as short text
 *  runs, hover/wheel collapse to their latest value, and everything keyboard
 *  or click shaped runs on one ordered chain. The virtual cursor is always
 *  live on hover, like a real Chrome window; the user's real mouse and
 *  keyboard are never touched. */
export function BrowserPanel({
  chatId = "",
  initialUrl = "",
  tabId = "",
}: {
  chatId?: string;
  /** Page the agent's browser tool asked for (the tool's `url` arg). The panel
   *  launches on it instead of about:blank so the agent's work is visible. */
  initialUrl?: string;
  /** Viewer-tab id: the memory key for this panel's sizing intent, so the
   *  fit toggle and width cap survive the per-tab remount of a chat switch. */
  tabId?: string;
}) {
  // One key per panel instance: restored below, written on every change.
  const fitKey = browserFitKey(tabId, chatId);
  const fitMemory = loadBrowserFit(fitKey);
  const [image, setImage] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  // Mirror of `pageUrl` for the mount effect: it must know what the live tab is
  // ALREADY showing without depending on state that the same effect just set.
  const pageUrlRef = useRef<string>("");
  const [address, setAddress] = useState<string>("");
  // Seeded so the follow-tab effect below skips its FIRST run: the mount effect
  // already attached to the session with this url, and re-issuing it would race
  // that attach.
  const initialUrlRef = useRef(initialUrl);
  const [active, setActive] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  // True while a navigation (URL / search / history action) is in flight —
  // drives the toolbar progress line and the spinning reload icon.
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  // False when NO automation browser is installed — the panel then offers the
  // one-click install instead of a dead "Connecting…" stage. Starts true so the
  // first (uninformed) frame does not flash the install notice; the status poll
  // corrects it before any session could exist.
  const [available, setAvailable] = useState<boolean>(true);
  // Install progress polled from /browser/install/status while it runs.
  const [installing, setInstalling] = useState<boolean>(false);
  const [installPct, setInstallPct] = useState<number>(0);
  const [installPhase, setInstallPhase] = useState<string>("");
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: DEFAULT_VIEWPORT_SIZE.width, h: DEFAULT_VIEWPORT_SIZE.height });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Virtual cursor overlay position (percent of the rendered frame).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const lastMoveAt = useRef(0);
  // Interval that follows a running automation-browser install (startInstall).
  const installTimer = useRef<number | null>(null);
  // ── Input pacing ──────────────────────────────────────────────────────────
  // The panel used to fire one request per keystroke / hover move / wheel
  // tick, each blocking its own backend round trip. Under load those queued
  // up faster than they drained and EVERY interaction (typing, the virtual
  // cursor, even the fit button) lagged seconds to minutes behind. Three
  // cheap mechanisms keep the request rate bounded:
  //   • one serialized chain for keyboard/click input (order is preserved,
  //     at most one request in flight);
  //   • keystroke runs coalesce: characters arriving while one type request
  //     is in flight ride the next one instead of piling up;
  //   • hover/wheel coalesce to the LATEST value while one is in flight.
  // Frame feedback needs no pacing of its own: frames are PUSHED by the
  // backend's screencast and rendered by the long-poll loop below.
  const inputChain = useRef<Promise<void>>(Promise.resolve());
  const typeBuf = useRef<string>("");
  const typePumping = useRef(false);
  const moveBusy = useRef(false);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const wheelBusy = useRef(false);
  const wheelPending = useRef(0);
  // Manual Chrome-style dimensions: numeric width/height inputs plus a
  // graduated width ruler (no device names). draftW/draftH are the raw
  // input strings so typing never fights the applied size.
  const [draftW, setDraftW] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.width));
  const [draftH, setDraftH] = useState<string>(String(DEFAULT_VIEWPORT_SIZE.height));
  // Fit-to-pane: the viewport width follows the pane width, capped at the
  // last manually applied width — like Chrome shrinking the layout viewport
  // when the pane narrows and growing it back up to the set size. OFF by
  // default, so a size the user picked STICKS: the panel then shows exactly
  // the width the ruler/backend holds instead of silently re-fitting to the
  // pane. Seeded from the per-tab memory (this component is remounted per
  // viewer tab, key=tab id), so a chat switch restores the user's own choice.
  const [fitToPane, setFitToPane] = useState<boolean>(fitMemory ? fitMemory.fitToPane : false);
  // Pane (stage) box in CSS px. Drives BOTH the fit-to-pane width and the
  // on-screen zoom of the frame, so a splitter drag or a window resize
  // rescales the frame immediately.
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // "..." overflow menu (CDP endpoint for DevTools comes from the backend
  // on demand — see openDevTools).
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  // Session-cookie import dialog: the path for sites whose server-side bot
  // defense rejects every login form the virtual browser submits (Instagram).
  // The user logs in ONCE in their own browser and pastes the session cookie
  // here — no password ever touches the virtual browser.
  const [cookieOpen, setCookieOpen] = useState<boolean>(false);
  const [cookieDomain, setCookieDomain] = useState<string>("instagram.com");
  const [cookieText, setCookieText] = useState<string>("");
  const [cookieBusy, setCookieBusy] = useState<boolean>(false);
  const [cookieMsg, setCookieMsg] = useState<string>("");
  const capWRef = useRef<number>(fitMemory && fitMemory.capW > 0 ? fitMemory.capW : DEFAULT_VIEWPORT_SIZE.width);
  // Last size WE applied (manual or fit). A status poll that echoes this back
  // is our own resize, not an external one, so it must not touch the cap.
  const appliedRef = useRef<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fitTimer = useRef<number | null>(null);
  // True once this instance ran the mount half of the fit effect; later runs
  // (follow mode toggled, session became active) take the reactive path.
  const mountFitApplied = useRef<boolean>(false);
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
    if (!base) throw new Error("the app's local backend is not ready yet");
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
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...bodyInit,
      });
    } catch (err) {
      // A NETWORK failure may mean the cached sidecar died: force the next
      // ensureSidecar to re-probe /health instead of trusting its 2s TTL.
      noteSidecarFailure();
      throw err;
    }
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
      // The backend reports whether an automation browser exists at all. It was
      // always in the payload and never read, so a missing browser surfaced as
      // an eternal "Connecting…" instead of an actionable install button.
      if (typeof st.available === "boolean") setAvailable(st.available);
      if (typeof st.url === "string") {
        // Never surface about:blank in the omnibox — it sticks and the
        // user has to delete it before typing (Chrome shows an empty box).
        const clean = st.url === "about:blank" ? "" : st.url;
        pageUrlRef.current = clean;
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

  /** One FORCED capture, used only when the backend reports that screencast
   *  push is unavailable for this tab (an older build): the panel then degrades
   *  to ~1 capture/s instead of the pushed-frame loop. */
  async function refreshShot(): Promise<void> {
    try {
      const shot = await sidecarFetch("/browser/screenshot", undefined, false);
      applyFrame(shot);
    } catch (err) {
      // Polling failures stay silent while a frame is already showing;
      // only surface them when there is nothing to display yet.
      if (!imageRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Apply one frame payload (pushed or captured): the image plus its size,
   *  synced into the viewport state and the W/H drafts the same way a poll
   *  used to. A repeat image is dropped before it can force a re-render and a
   *  full re-decode of a large JPEG. */
  function applyFrame(shot: Record<string, unknown>): void {
    if (typeof shot.image === "string" && shot.image) {
      if (shot.image !== imageRef.current) setImage(shot.image);
      if (typeof shot.width === "number" && typeof shot.height === "number") {
        const prev = sizeRef.current;
        if (shot.width !== prev.w || shot.height !== prev.h) {
          setViewport({ w: shot.width, h: shot.height });
          if (shouldSyncViewportDrafts(prev.w, prev.h, shot.width, shot.height, isEditingDims())) {
            syncDrafts(shot.width, shot.height);
          }
        }
      }
      setError("");
    }
  }

  // Pushed-frame loop. The backend runs Page.startScreencast on the tab and
  // caches the latest frame; /browser/frame long-polls and answers the moment
  // the page repaints — so a keystroke, a click or a hover state shows up in
  // roughly one compositor tick, with NO capture round trip in the path.
  // Idle pages push nothing and the request just parks, so the cost is zero.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let seq = 0;
    const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    (async () => {
      while (!cancelled) {
        if (typeof document !== "undefined" && document.hidden) {
          await sleep(600);
          continue;
        }
        try {
          const res = await sidecarFetch(`/browser/frame?after=${seq}`, undefined, false);
          if (res.ok === false) {
            // Session down (or no tab yet): pause; the status poll flips
            // `active` and restarts this loop when it is back.
            await sleep(700);
            continue;
          }
          if (res.pushed === false) {
            // This tab never pushed a frame (older backend): degrade to the
            // capture poll instead of waiting on a push that never comes.
            await refreshShot();
            await sleep(1000);
            continue;
          }
          if (typeof res.seq === "number" && res.seq > seq) {
            seq = res.seq;
            applyFrame(res);
          }
        } catch {
          await sleep(800);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Ensure the shared session exists on mount (idempotent: a running
  // session is left untouched), then poll frames roughly once a second.
  // ATTACH to the shared session on mount — never START one. This effect used
  // to POST /browser/launch unconditionally, which meant a browser tab restored
  // from the last session spawned a full Chromium the moment the app opened:
  // no gesture, no agent tool call, just a window nobody asked for (and on this
  // machine, a frozen desktop). Chromium is now started by exactly two things —
  // the agent's browser tool, or the user typing a URL in the omnibox below
  // (see `go()`, which launches when the session is down).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const isActive = await refreshStatus();
      if (cancelled) return;
      if (isActive) {
        // ATTACH, do not navigate. A chat switch remounts this panel, and
        // re-issuing the remembered URL used to send the live tab back to it —
        // a full reload on every chat switch, wiping whatever the agent had
        // been doing while the user was away. `refreshStatus` above already
        // adopted the live page into `pageUrl`, so navigate ONLY when the tab
        // really is empty (a freshly created target with no page to show).
        const showing = pageUrlRef.current.trim();
        const wanted = initialUrl.trim();
        if (!showing && wanted && wanted !== "about:blank") {
          await sidecarFetch("/browser/navigate", {
            method: "POST",
            body: JSON.stringify({ url: wanted }),
          }).catch(() => {
            // A dead session reports as inactive below on the next poll.
          });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    // Status poll only: the URL, viewport and session state. FRAMES arrive
    // through the pushed-frame loop below — this interval never captures.
    timer.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshStatus();
    }, 1200);
    // Coming back to the window must not wait for the next tick to sync the
    // omnibox/session state; frames resume via their own loop.
    const onVisible = (): void => {
      if (document.hidden) return;
      void refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      if (installTimer.current) window.clearInterval(installTimer.current);
      installTimer.current = null;
      if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
      rulerTimerRef.current = null;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The agent kept driving this chat's shared session after the tab was docked
  // (a later browser_navigate). Follow the new page instead of leaving the
  // panel on the first URL. This is `navigate`, not `launch`: docking the panel
  // happens because a browser tool just ran, so the session already exists —
  // and a tab restored from disk must never start one by itself.
  useEffect(() => {
    if (initialUrlRef.current === initialUrl) return;
    initialUrlRef.current = initialUrl;
    const target = initialUrl.trim();
    if (!target || target === "about:blank") return;
    void sidecarFetch("/browser/navigate", {
      method: "POST",
      body: JSON.stringify({ url: target }),
    }).catch(() => {
      /* non-critical: the status poll still reflects the live page */
    });
  }, [initialUrl]);

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
  function clickAt(e: React.MouseEvent<HTMLImageElement>): void {
    if (!active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * viewport.w);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * viewport.h);
    setCursor(hostPct(e.currentTarget, e.clientX, e.clientY));
    // Serialized behind earlier input: a click can never overtake (or be
    // overtaken by) a pending keystroke run. Any characters still sitting in
    // the type buffer flush FIRST — text typed just before the click belongs
    // in the focused field, not in whatever the click focuses next.
    enqueueInput(async () => {
      try {
        await drainType();
        await sidecarFetch("/browser/click", {
          method: "POST",
          body: JSON.stringify({ x, y }),
        });
        // The click's effect shows up as a pushed frame the moment the page
        // repaints — nothing to fetch here.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function pressKey(key: string): Promise<void> {
    if (!active) return;
    await sidecarFetch("/browser/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }

  /** Queue one input step so keyboard + click actions run strictly in order,
   *  one request in flight at a time — a flood of events can no longer pile
   *  up as parallel requests behind each other. */
  function enqueueInput(step: () => Promise<void>): void {
    inputChain.current = inputChain.current.then(step).catch(() => {
      // One failed step must not poison the chain for the next keystroke.
    });
  }

  /** Send whatever characters are buffered NOW, inside the current chain step
   *  — named keys and clicks flush pending text ahead of themselves. */
  function drainType(): Promise<void> {
    const text = typeBuf.current;
    typeBuf.current = "";
    if (!text) return Promise.resolve();
    return sidecarFetch("/browser/type", {
      method: "POST",
      body: JSON.stringify({ text }),
    }).catch(() => {
      // Keystroke forwarding is best-effort; transient failures are ignored.
    });
  }

  /** Queue a printable character. The run goes out as ONE type request; while
   *  that request is queued or in flight, further characters accumulate and
   *  are carried by the next drain — so a fast typist batches automatically
   *  and a slow one sees each character leave immediately. */
  function queueChar(ch: string): void {
    typeBuf.current += ch;
    pumpType();
  }

  function pumpType(): void {
    if (typePumping.current) return;
    const text = typeBuf.current;
    if (!text) return;
    typeBuf.current = "";
    typePumping.current = true;
    enqueueInput(async () => {
      try {
        await sidecarFetch("/browser/type", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        // A failed type request used to vanish: the characters were lost and a
        // typed password silently came out shorter. Say so in the status bar.
        setError(
          "Some typed characters were not delivered: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      typePumping.current = false;
      if (typeBuf.current) pumpType();
    });
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
    // Option (macOS) / AltGr (Windows = Ctrl+Alt) COMPOSE printable symbols such
    // as @ # { } on many layouts: `e.key` already holds the composed character, so
    // excluding `altKey` silently dropped it from typed passwords. Only real
    // shortcuts (Cmd, or Ctrl without Alt) stay out.
    const plain = k.length === 1 && !e.metaKey && (!e.ctrlKey || e.altKey);
    if (plain) {
      e.preventDefault();
      queueChar(k);
    } else if (named.includes(k)) {
      e.preventDefault();
      // Any pending characters go first, then the named key — order matters
      // (Enter must see everything typed before it).
      enqueueInput(async () => {
        await drainType();
        try {
          await pressKey(k);
        } catch {
          // best-effort; transient failures are ignored
        }
      });
    }
  }

  /** Cmd/Ctrl+V on the stage: send the clipboard text to the page. Shortcuts are
   *  not forwarded as keys, so a pasted password used to do nothing at all. */
  function stagePaste(e: React.ClipboardEvent<HTMLDivElement>): void {
    if (!active) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    queueChar(text);
  }

  /** Forward one wheel tick, COALESCED: trackpads fire dozens of events per
   *  second, and only the accumulated delta matters — at most one scroll
   *  request is ever in flight, carrying everything that arrived meanwhile. */
  function wheel(e: React.WheelEvent): void {
    if (!active) return;
    wheelPending.current += Math.round(e.deltaY);
    if (wheelBusy.current) return;
    wheelBusy.current = true;
    void (async () => {
      for (;;) {
        const dy = wheelPending.current;
        if (dy === 0) {
          wheelBusy.current = false;
          // An event may have landed between the last read and the flag
          // flip — re-check so a tick is never dropped.
          if (wheelPending.current === 0) return;
          wheelBusy.current = true;
          continue;
        }
        wheelPending.current = 0;
        try {
          await sidecarFetch("/browser/scroll", {
            method: "POST",
            body: JSON.stringify({ dx: 0, dy }),
          });
        } catch {
          // Wheel scroll is best-effort; ignore transient failures.
        }
      }
    })();
  }

  // Keep a live ref of the applied size for the fit-to-pane observer.
  useEffect(() => {
    sizeRef.current = viewport;
  }, [viewport]);

  /** Send one virtual-cursor move, coalesced to the LATEST position: hover
   *  fires far faster than the page (or the user's eye) needs, and only the
   *  most recent point matters — at most one move request is in flight. */
  function sendMove(p: { x: number; y: number }): void {
    if (moveBusy.current) {
      pendingMove.current = p;
      return;
    }
    moveBusy.current = true;
    void sidecarFetch("/browser/move", {
      method: "POST",
      body: JSON.stringify({ x: p.x, y: p.y }),
    })
      .catch(() => {
        // Hover is best-effort; transient failures are ignored.
      })
      .finally(() => {
        moveBusy.current = false;
        const next = pendingMove.current;
        pendingMove.current = null;
        if (next) sendMove(next);
      });
  }

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
      // The frame is what the user is waiting on after a resize: fetch it
      // immediately and let the status sync ride along in parallel instead of
      // adding a full round trip in front of the shot (the fit toggle and the
      // ruler both felt a beat late because of it).
      await Promise.all([refreshShot(), refreshStatus()]);
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
    // toggle takes effect without waiting for a pane resize. A MOUNT still
    // does not: this panel is remounted on every chat switch, and applying
    // here re-fitted a size the user had set before the pane had even been
    // laid out (pane w=0), snapping the emulated viewport back to the default
    // width on every return. Follow the pane on layout changes during the
    // session; restoring a remount is the memory effect's job.
    if (!mountFitApplied.current) {
      mountFitApplied.current = true;
      measure(readPane().w, readPane().h);
    } else {
      onResize();
    }
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToPane, active]);

  // Persist the sizing intent, and RESTORE an already-fitted viewport after a
  // remount: the panel is remounted per viewer tab (a chat switch), so without
  // this the fit state above was reset and the remount re-fitted — the very
  // "it auto-fits again" the user sees. Runs once the session reports active
  // (the pane has a real size by then).
  useEffect(() => {
    saveBrowserFit(fitKey, { fitToPane, capW: capWRef.current });
    if (!fitToPane || !active) return;
    const host = stageRef.current;
    if (!host) return;
    const paneW = Math.round(host.clientWidth);
    if (paneW <= 0) return;
    const cur = sizeRef.current;
    const target = fitWidthTarget(paneW, capWRef.current);
    if (target !== cur.w) void applySize(target, cur.h, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fitToPane, fitKey]);

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

  // Forward hover as a virtual cursor move (coalesced, ~60ms cadence) and
  // show the cursor overlay: the page reacts like a real pointer, the real
  // mouse is untouched. Hover STYLES land as pushed frames — no fetching.
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
    if (now - lastMoveAt.current < 60) return;
    lastMoveAt.current = now;
    sendMove({
      x: Math.round((p.x / 100) * viewport.w),
      y: Math.round((p.y / 100) * viewport.h),
    });
  }

  async function closeSession(): Promise<void> {
    try {
      await sidecarFetch("/browser/close", { method: "POST" });
      // The session is gone, so its sizing intent is stale: drop the memory
      // so a fresh launch starts from the backend's own default viewport.
      clearBrowserFit(fitKey);
      capWRef.current = DEFAULT_VIEWPORT_SIZE.width;
      setActive(false);
      setImage("");
      setError("");
      setMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // One-click install of the app's OWN automation browser.
  //
  // The download and unpack run on a plain Rust thread (no Python, no npx), so
  // progress is observed by polling /browser/install/status — the same shape as
  // the app's other long downloads.
  async function startInstall(): Promise<void> {
    setError("");
    setInstalling(true);
    setInstallPct(0);
    setInstallPhase("downloading");
    try {
      await sidecarFetch("/browser/install", { method: "POST" });
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (installTimer.current) window.clearInterval(installTimer.current);
    installTimer.current = window.setInterval(async () => {
      try {
        const st = await sidecarFetch("/browser/install/status");
        if (typeof st.percent === "number") setInstallPct(st.percent);
        if (typeof st.phase === "string") setInstallPhase(st.phase);
        if (st.available === true) setAvailable(true);
        if (st.installing) return;
        // Finished (or failed): stop polling and report either way.
        if (installTimer.current) window.clearInterval(installTimer.current);
        installTimer.current = null;
        setInstalling(false);
        if (st.phase === "failed" && st.error) {
          setError(String(st.error));
        } else {
          await refreshStatus();
        }
      } catch (err) {
        if (installTimer.current) window.clearInterval(installTimer.current);
        installTimer.current = null;
        setInstalling(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 700);
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

  // Apply the pasted session cookies, then land on the site so the imported
  // session is immediately visible. The backend needs a live tab to carry the
  // cookie call, so a down session launches first (landing there anyway).
  async function applyCookies(): Promise<void> {
    const domain = cookieDomain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    const text = cookieText.trim();
    if (!domain || !text) return;
    setCookieBusy(true);
    setCookieMsg("");
    try {
      if (!active) {
        await sidecarFetch("/browser/launch", {
          method: "POST",
          body: JSON.stringify({ url: `https://${domain}/` }),
        });
      }
      const res = await sidecarFetch("/browser/cookies/import", {
        method: "POST",
        body: JSON.stringify({ domain, text }),
      });
      if (res.ok === false) throw new Error(String(res.error || "import failed"));
      setCookieText("");
      setCookieOpen(false);
      setBusy(true);
      // The import changed SERVER-side state for a URL that may already be
      // open — the idempotent navigate skips a same-page navigation, so a
      // plain navigate alone never let the site see the fresh session (the
      // panel sat on the old login wall "loading"). Land on the domain, then
      // force a real reload.
      await sidecarFetch("/browser/navigate", {
        method: "POST",
        body: JSON.stringify({ url: `https://${domain}/` }),
      });
      await sidecarFetch("/browser/history", {
        method: "POST",
        body: JSON.stringify({ action: "reload" }),
      });
      await refreshStatus();
    } catch (err) {
      setCookieMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCookieBusy(false);
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
            <button
              type="button"
              className="browser-menu-item"
              role="menuitem"
              aria-label="Import session cookies"
              onClick={() => {
                setMenuOpen(false);
                setCookieMsg("");
                setCookieOpen(true);
              }}
            >
              <span className="browser-menu-item-icon" aria-hidden="true">🍪</span>
              Import session cookies
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
        // No native `title`: its tooltip popped up over the viewer rail while
        // typing in the page looked intentional. Screen readers keep the hint.
        aria-description="Click the page, then type — keystrokes go to the virtual browser"
        onKeyDown={stageKeyDown}
        onPaste={stagePaste}
        onMouseDown={(e) => e.currentTarget.focus()}
      >
        {!available ? (
          // No automation browser installed. This used to be invisible: the
          // stage sat on "Connecting…" forever, and the only way out was the
          // user's own Chrome being used as the driver.
          <div className="browser-install">
            <div className="browser-install-title">
              Automation browser not installed
            </div>
            <p className="browser-install-body">
              Codifa drives its own headless browser, so your everyday browser is
              never touched. Download it once (~90 MB) and the agent can browse.
            </p>
            <button
              type="button"
              className="browser-install-btn"
              onClick={() => void startInstall()}
              disabled={installing}
            >
              {installing
                ? installPhase === "extracting"
                  ? `Unpacking… ${installPct}%`
                  : `Downloading… ${installPct}%`
                : "Install browser"}
            </button>
            {installing && (
              <div className="browser-install-bar" aria-hidden="true">
                <div
                  className="browser-install-fill"
                  style={{ width: `${Math.max(2, installPct)}%` }}
                />
              </div>
            )}
            {error && <div className="browser-install-error">{error}</div>}
          </div>
        ) : loading ? (
          <div className="viewer-empty">Connecting to the virtual browser…</div>
        ) : image ? (
          <div className="browser-stage-inner" style={{ width: frameW, height: frameH }}>
            <img
              src={image}
              alt="Virtual browser"
              className="browser-stage-img"
              onClick={(e) => clickAt(e)}
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

      {/* Session-cookie import dialog: the "log in outside, keep the session
          inside" path for sites whose bot defense rejects every login form
          the virtual browser submits (Instagram). */}
      {cookieOpen && (
        <div
          className="browser-cookie-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Import session cookies"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCookieOpen(false);
          }}
        >
          <div className="browser-cookie-modal">
            <div className="browser-cookie-title">Import session cookies</div>
            <p className="browser-cookie-hint">
              Log into the site ONCE in your own browser, then hand the session
              here — your password is never typed into the virtual browser.
              For Instagram: Chrome → instagram.com → F12 → Application →
              Cookies → copy the value of <code>sessionid</code> and paste it
              below.
            </p>
            <input
              className="browser-cookie-domain"
              value={cookieDomain}
              onChange={(e) => setCookieDomain(e.target.value)}
              placeholder="instagram.com"
              aria-label="Cookie domain"
              spellCheck={false}
            />
            <textarea
              className="browser-cookie-text"
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              placeholder={"sessionid value — or name=value; name2=value2 pairs"}
              rows={5}
              aria-label="Cookie data"
              spellCheck={false}
              autoFocus
            />
            {cookieMsg && <div className="browser-cookie-msg">{cookieMsg}</div>}
            <div className="browser-cookie-actions">
              <button
                type="button"
                className="browser-cookie-btn"
                onClick={() => setCookieOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="browser-cookie-btn browser-cookie-btn--primary"
                disabled={cookieBusy || !cookieText.trim() || !cookieDomain.trim()}
                onClick={() => void applyCookies()}
              >
                {cookieBusy ? "Importing…" : "Import & open"}
              </button>
            </div>
          </div>
        </div>
      )}
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

/** Fit-to-panel: a page frame with a double-headed width arrow — reads as
 *  "the page's width follows the pane", unlike the old fullscreen-style
 *  corners which looked like a maximize button. */
function FitIcon() {
  return (
    <SvgIcon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7.5 12h9" />
      <path d="M10 9.5 7.5 12l2.5 2.5" />
      <path d="M14 9.5 16.5 12 14 14.5" />
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
