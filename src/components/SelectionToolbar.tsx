import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isQuotableSelection } from "../lib/chatQuote";
import { useSpeakText } from "../lib/tts";
import { useStore } from "../lib/store";

// Floating selection toolbar shared by the chat transcript, reading mode, the
// schedule inbox and the schedule panel. Two actions over the selected text —
// Reply (pin a quote into the chat composer) and Read aloud (sidecar TTS via
// useSpeakText, the same single-player stack the message actions row uses).

export type FloatingSelection = { text: string; x: number; y: number };

/**
 * Tracks the document selection while it lives inside the owner's surface.
 * Same lifecycle the chat's inline reply chip had (selectionchange + capture
 * scroll + Escape), generalized: every surface passes its own containment
 * test, so exactly one toolbar shows for a given selection.
 */
export function useFloatingSelection(isInside: (el: Element | null) => boolean) {
  const [sel, setSel] = useState<FloatingSelection | null>(null);
  const selRef = useRef<FloatingSelection | null>(null);
  selRef.current = sel;
  const insideRef = useRef(isInside);
  insideRef.current = isInside;
  // Sticky last position: the toolbar lingers here while TTS plays after the
  // selection collapsed (scroll / click elsewhere must not kill playback).
  const lastRef = useRef<FloatingSelection | null>(null);
  const refresh = useCallback(() => {
    const s = typeof window !== "undefined" ? window.getSelection() : null;
    if (!s || s.isCollapsed || s.rangeCount === 0) {
      if (selRef.current) setSel(null);
      return;
    }
    const text = s.toString();
    if (!isQuotableSelection(text)) {
      if (selRef.current) setSel(null);
      return;
    }
    const anchor = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement ?? null;
    const focusEl = s.focusNode instanceof Element ? s.focusNode : s.focusNode?.parentElement ?? null;
    // Outside this surface → the toolbar hides (another surface may pick it up).
    if (!insideRef.current(anchor) && !insideRef.current(focusEl)) {
      if (selRef.current) setSel(null);
      return;
    }
    try {
      const rect = s.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
      const y = Math.max(rect.top - 8, 8);
      lastRef.current = { text, x, y };
      setSel(lastRef.current);
    } catch {
      // ignore invalid ranges
    }
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", refresh);
    const onScroll = () => {
      if (selRef.current) setSel(null);
    };
    document.addEventListener("scroll", onScroll, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selRef.current) setSel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [refresh]);
  const clear = useCallback(() => {
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
    setSel(null);
  }, []);
  return { sel, lastSel: lastRef, clear };
}

/**
 * The Reply + Read aloud bar. Stays mounted (at its last position) while the
 * voice plays even when the selection collapses — useTtsPlayback stops on
 * unmount, so the parent must keep rendering it while `busy` is true.
 */
export function SelectionToolbar({
  sel,
  onReply,
  onBusyChange,
}: {
  sel: FloatingSelection | null;
  onReply?: (text: string) => void;
  /** Parent keeps the toolbar mounted while true (TTS active). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const { status, speak, stop } = useSpeakText(useStore.getState);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<number | null>(null);
  const speakingTextRef = useRef<string | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  // Last non-empty selection text: after the selection collapsed the toolbar
  // lingers while the voice plays, and the speak button must still toggle
  // (pause / resume) THAT text instead of erroring on an empty selection.
  const lastTextRef = useRef("");
  if (sel && isQuotableSelection(sel.text)) lastTextRef.current = sel.text;

  useEffect(() => {
    onBusyChange?.(status !== "idle");
  }, [status, onBusyChange]);
  useEffect(
    () => () => {
      if (errorTimer.current) window.clearTimeout(errorTimer.current);
    },
    [],
  );

  // Same text → useTtsPlayback's toggle (pause / resume / cancel). A different
  // selection restarts: the single global player would otherwise just pause.
  const readAloud = useCallback(async () => {
    const text = selRef.current?.text || lastTextRef.current;
    if (!text.trim()) {
      stop();
      return;
    }
    if (status !== "idle" && speakingTextRef.current !== text) stop();
    speakingTextRef.current = text;
    const err = await speak(text);
    if (err) {
      speakingTextRef.current = null;
      setError(err);
      if (errorTimer.current) window.clearTimeout(errorTimer.current);
      errorTimer.current = window.setTimeout(() => setError(null), 4500);
    }
  }, [status, speak, stop]);

  const active = status === "speaking" || status === "loading" || status === "paused";
  // The bar centers on the selection midpoint, but a fixed element shrink-to-
  // fits against the viewport edge — near the screen border the available
  // width squeezed the buttons and wrapped "Read aloud". Measure the real
  // width and clamp the CENTER so the whole pill stays on screen.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: sel?.x ?? 48, y: sel?.y ?? 48 });
  useLayoutEffect(() => {
    // Lingering (selection collapsed): keep the last position.
    if (!sel) return;
    const w = barRef.current?.offsetWidth ?? 0;
    const half = w / 2 + 8;
    setPos({
      x: Math.min(Math.max(sel.x, half), window.innerWidth - half),
      y: sel.y,
    });
  }, [sel?.x, sel?.y]);
  return (
    // Positioning only inline — visuals live in .selection-toolbar so themes
    // restyle the bar. dir=ltr keeps the Reply|Read aloud order stable in both
    // app directions (same convention as .msg-actions).
    <div
      ref={barRef}
      className={`selection-toolbar${active ? " tts-active" : ""}`}
      dir="ltr"
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        transform: "translate(-50%, -100%)",
        zIndex: 130,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {onReply && sel && (
        <button
          type="button"
          className="selection-toolbar-btn"
          title="Reply to selection"
          aria-label="Reply to selected text"
          onClick={() => onReply(sel.text)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 6 4 12l6 6" />
            <path d="M4 12h9a6 6 0 0 1 6 6v2" />
          </svg>
          <span>Reply</span>
        </button>
      )}
      <button
        type="button"
        className={`selection-toolbar-btn selection-toolbar-speak ${status === "speaking" ? "speaking" : ""} ${status === "loading" ? "loading" : ""} ${status === "paused" ? "paused" : ""}`}
        title={
          status === "speaking"
            ? "توقف موقت"
            : status === "paused"
              ? "ادامه پخش"
              : status === "loading"
                ? "لغو"
                : "خواندن متن انتخاب‌شده"
        }
        aria-label="Read the selected text aloud"
        onClick={readAloud}
      >
        {status === "loading" ? (
          <svg
            className="tts-spinner"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.56" />
          </svg>
        ) : status === "speaking" ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 5v14M15 5v14" />
          </svg>
        ) : status === "paused" ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        )}
        <span>Read aloud</span>
      </button>
      {error && <div className="selection-toolbar-error">{error}</div>}
    </div>
  );
}
