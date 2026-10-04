import { useEffect, useRef, useState } from "react";
import { ensureSidecar } from "../lib/api";
import {
  VIEWPORT_PRESETS,
  PRESET_GROUP_LABELS,
  PRESET_GROUP_ORDER,
  presetForViewport,
  type ViewportPreset,
} from "../lib/browserViewport";

/** Live view of the shared in-app virtual browser (headless Chromium).
 *  Chrome-style shell: ONE omnibox (address) in the toolbar, history controls,
 *  a device row like DevTools, and a keyboard-focusable stage that forwards
 *  typing straight to the page — so the panel never shows a second input box.
 *  The user's real mouse and keyboard are never touched. */
export function BrowserPanel({ onClose }: { onClose?: () => void }) {
  const [image, setImage] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [active, setActive] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Virtual cursor overlay position (percent of the rendered frame).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const lastMoveAt = useRef(0);
  const lastHoverShotAt = useRef(0);
  // Debounced frame refresh after bursts of forwarded keystrokes.
  const keyShotTimer = useRef<number | null>(null);
  // Chrome-style device selection: keep the chosen id even when several
  // devices share one size (iPhone 14/15/16 are all 393x852).
  const [presetId, setPresetId] = useState<string>("desktop");
  const presetIdRef = useRef(presetId);

  function choosePreset(id: string): void {
    presetIdRef.current = id;
    setPresetId(id);
  }

  // POST/GET helper against the sidecar. Throws on transport errors so
  // callers can surface a single error line.
  async function sidecarFetch(path: string, init?: RequestInit): Promise<any> {
    const base = await ensureSidecar();
    if (!base) throw new Error("sidecar not ready");
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.detail || `request failed (${res.status})`));
    return body;
  }

  async function refreshStatus(): Promise<boolean> {
    try {
      const st = await sidecarFetch("/browser/status");
      const isActive = st.active === true;
      setActive(isActive);
      if (typeof st.url === "string") {
        setPageUrl(st.url);
        if (!address && st.url) setAddress(st.url);
      }
      if (st.viewport && typeof st.viewport.width === "number") {
        const w = st.viewport.width;
        const h = st.viewport.height;
        setViewport({ w, h });
        // Follow external resizes (agent/CDP) but keep the chosen device when
        // it still matches the current size.
        const chosen = VIEWPORT_PRESETS.find((p) => p.id === presetIdRef.current);
        if (!chosen || chosen.width !== w || chosen.height !== h) {
          choosePreset(presetForViewport(w, h)?.id ?? "");
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
      const shot = await sidecarFetch("/browser/screenshot");
      if (typeof shot.image === "string" && shot.image) {
        setImage(shot.image);
        if (typeof shot.width === "number") setViewport({ w: shot.width, h: shot.height });
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
      } catch {
        // Launch failures surface through the status call below.
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
    // Chrome-style: a schemeless host (example.com, localhost:3000) gets https://.
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    setError("");
    try {
      if (!active) {
        await sidecarFetch("/browser/launch", {
          method: "POST",
          body: JSON.stringify({ url: target }),
        });
      } else {
        await sidecarFetch("/browser/navigate", {
          method: "POST",
          body: JSON.stringify({ url: target }),
        });
      }
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Map a click on the scaled image back to viewport pixels.
  async function clickAt(e: React.MouseEvent<HTMLImageElement>): Promise<void> {
    if (!active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * viewport.w);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * viewport.h);
    setCursor({ x: (x / viewport.w) * 100, y: (y / viewport.h) * 100 });
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

  // Resize the shared viewport to a responsive device preset (Codex-style).
  async function applyPreset(preset: ViewportPreset): Promise<void> {
    if (!active) return;
    setError("");
    try {
      await sidecarFetch("/browser/viewport", {
        method: "POST",
        body: JSON.stringify({ width: preset.width, height: preset.height }),
      });
      setViewport({ w: preset.width, h: preset.height });
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Forward hover as a virtual cursor move (throttled) and show the cursor
  // overlay: the page reacts like a real pointer, the real mouse is untouched.
  function hoverAt(e: React.MouseEvent<HTMLImageElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const pctX = ((e.clientX - rect.left) / rect.width) * 100;
    const pctY = ((e.clientY - rect.top) / rect.height) * 100;
    setCursor({ x: pctX, y: pctY });
    if (!active) return;
    const now = Date.now();
    if (now - lastMoveAt.current < 120) return;
    lastMoveAt.current = now;
    void sidecarFetch("/browser/move", {
      method: "POST",
      body: JSON.stringify({
        x: Math.round((pctX / 100) * viewport.w),
        y: Math.round((pctY / 100) * viewport.h),
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
        />
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
        {onClose && (
          <button
            type="button"
            className="browser-tool-btn"
            title="Close viewer"
            aria-label="Close viewer"
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>

      {/* Device row — Chrome DevTools device-toolbar pattern */}
      <div className="browser-subbar">
        <span className="browser-subbar-label">Dimensions</span>
        <select
          className="browser-device-select"
          aria-label="Device preset"
          value={presetId}
          onChange={(e) => {
            const id = e.target.value;
            choosePreset(id);
            const p = VIEWPORT_PRESETS.find((x) => x.id === id);
            if (p) void applyPreset(p);
          }}
        >
          {presetId === "" && <option value="">Responsive</option>}
          {PRESET_GROUP_ORDER.map((g) => (
            <optgroup key={g} label={PRESET_GROUP_LABELS[g]}>
              {VIEWPORT_PRESETS.filter((p) => p.group === g).map((p) => (
                <option key={p.id} value={p.id}>
                  {`${p.label} (${p.width}x${p.height})`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="browser-size">{viewport.w}x{viewport.h}</span>
      </div>

      {/* Stage: focusable, forwards keys + virtual cursor to the page */}
      <div
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
