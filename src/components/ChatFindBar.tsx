import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_FIND_MATCHES,
  claimFindPaint,
  clearFindPaint,
  collectRuns,
  currentFindOwner,
  findMatches,
  highlightSupported,
  onFindPaintOwner,
  paintFind,
  rangeForMatch,
  releaseFindPaint,
  scrollToMatch,
  stepMatch,
} from "../lib/chatFind";
import { isEditableTarget, paneOwner } from "../lib/panePointer";
import { physicalKey } from "../lib/shortcuts";

/**
 * The Cmd/Ctrl+F find widget for one chat window — a floating bar over the
 * transcript, VSCode-style: query field, "n of m" counter, previous/next
 * match buttons and a close button. Enter/Shift+Enter and F3/Shift+F3 walk
 * the matches; Escape closes.
 *
 * Matches are painted by src/lib/chatFind.ts through the CSS Custom Highlight
 * API over the live transcript DOM (never mutated — React owns it). The bar
 * rescans on every transcript mutation (streaming, "load older", chat switch)
 * so counts and paint stay current; the document-global paint registry means
 * only one bar paints at a time, and a bar that loses the claim closes.
 *
 * `query`/`matchCase` live in the owning ChatPanel so they survive close and
 * reopen; the active index is local (reopening lands on the first match).
 */
export function ChatFindBar({
  panelRef,
  scrollerRef,
  query,
  matchCase,
  onQueryChange,
  onCaseChange,
  onJump,
  onClose,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  matchCase: boolean;
  onQueryChange: (q: string) => void;
  onCaseChange: (on: boolean) => void;
  /** Called before the programmatic jump to a match, so the transcript can
   *  release its stick-to-bottom pin the same way a user scroll would. */
  onJump: () => void;
  onClose: () => void;
}) {
  const [token] = useState(() => Symbol("chat-find"));
  const inputRef = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0);
  const [supported] = useState(highlightSupported);
  const rangesRef = useRef<Range[]>([]);
  const activeRef = useRef(0);

  // Latest-callback mirrors: the effects below subscribe once and must not
  // resubscribe (and lose their timing) when the parent re-renders.
  const jumpRef = useRef(onJump);
  jumpRef.current = onJump;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const rescanRef = useRef<(scroll: boolean) => void>(() => {});

  /** Full rescan of the mounted transcript. `scroll` also lands the viewport
   *  on the active match (bar opened / query changed); a pure mutation rescan
   *  (streaming, load-older) never moves the view. */
  rescanRef.current = (scroll: boolean) => {
    const root = scrollerRef.current;
    const mine = currentFindOwner() === token;
    if (!root || !query) {
      rangesRef.current = [];
      activeRef.current = 0;
      setCount(0);
      setActive(0);
      if (mine) clearFindPaint();
      return;
    }
    const ranges: Range[] = [];
    for (const m of findMatches(collectRuns(root), query, matchCase)) {
      const r = rangeForMatch(m);
      if (r) ranges.push(r);
    }
    rangesRef.current = ranges;
    const clamped = ranges.length ? Math.min(activeRef.current, ranges.length - 1) : 0;
    activeRef.current = clamped;
    setCount(ranges.length);
    setActive(clamped);
    if (mine) {
      if (ranges.length) paintFind(ranges, clamped);
      else clearFindPaint();
    }
    if (scroll && ranges[clamped]) {
      jumpRef.current();
      scrollToMatch(ranges[clamped]);
    }
  };

  const step = useCallback(
    (delta: 1 | -1) => {
      const ranges = rangesRef.current;
      if (!ranges.length) return;
      const next = stepMatch(activeRef.current, delta, ranges.length);
      activeRef.current = next;
      setActive(next);
      if (currentFindOwner() === token) paintFind(ranges, next);
      jumpRef.current();
      scrollToMatch(ranges[next]);
    },
    [token],
  );

  // Claim the document-global paint and land on the first match. Releasing on
  // unmount also wipes the two highlight names — the bar that owned them is
  // going away.
  useEffect(() => {
    claimFindPaint(token);
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
    rescanRef.current(true);
    return () => {
      // Only wipe the paint we still own: the claim is exclusive, so this is
      // just belt-and-braces against an owner swap landing mid-teardown.
      if (currentFindOwner() === token) {
        clearFindPaint();
        releaseFindPaint(token);
      }
    };
  }, [token]);

  // Another bar claimed the paint (find opened in another chat window): close.
  useEffect(() => onFindPaintOwner((t) => t !== token && closeRef.current()), [token]);

  // Rescan when the query or case sensitivity changes; a genuinely new query
  // starts from the first match and scrolls to it (a case toggle keeps the
  // position and just re-counts).
  const prevQueryRef = useRef(query);
  useEffect(() => {
    const changed = prevQueryRef.current !== query;
    prevQueryRef.current = query;
    if (changed) activeRef.current = 0;
    rescanRef.current(changed);
  }, [query, matchCase]);

  // Keep counts and paint current while the transcript mutates underneath:
  // streaming tokens, "load older", the chat switch in this panel, message
  // edits. Coalesced to one rescan per frame — with a timer fallback, because
  // rAF never fires in occluded/hidden webviews (an occluded Tauri window
  // would otherwise starve the rescan until focus returns).
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    let scheduled = false;
    let rafId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      scheduled = false;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timerId != null) {
        clearTimeout(timerId);
        timerId = null;
      }
      rescanRef.current(false);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      rafId = requestAnimationFrame(() => {
        if (scheduled) flush();
      });
      timerId = setTimeout(() => {
        if (scheduled) flush();
      }, 150);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      scheduled = false;
      if (rafId != null) cancelAnimationFrame(rafId);
      if (timerId != null) clearTimeout(timerId);
    };
  }, [scrollerRef]);

  // Chords while the bar is open, for the chat window that owns the keyboard:
  // Cmd/Ctrl+F again lands back in the field, F3 / Cmd/Ctrl+G walk matches.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      const panel = panelRef.current;
      if (!panel) return;
      const target = e.target as Node | null;
      const inPanel = !!target && panel.contains(target);
      if (!inPanel && (isEditableTarget(target) || paneOwner() !== panel)) return;
      const mod = e.ctrlKey || e.metaKey;
      const phys = physicalKey(e);
      if (mod && !e.shiftKey && phys === "f") {
        e.preventDefault();
        e.stopPropagation();
        const input = inputRef.current;
        input?.focus({ preventScroll: true });
        input?.select();
        return;
      }
      if (e.key === "F3" || (mod && phys === "g")) {
        e.preventDefault();
        e.stopPropagation();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panelRef, step]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const onBarKeyDown = (e: React.KeyboardEvent) => {
    // Escape closes from anywhere inside the bar (field or buttons).
    if (!e.nativeEvent.isComposing && e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
    }
  };

  const capped = count >= MAX_FIND_MATCHES;
  const countText = !query
    ? ""
    : count === 0
      ? "No results"
      : `${active + 1} of ${count}${capped ? "+" : ""}`;
  const countTitle =
    count > 0 && !supported ? "This webview cannot paint find highlights" : undefined;

  return (
    <div className="chat-find-bar" dir="ltr" role="search" aria-label="Find in chat" onKeyDown={onBarKeyDown}>
      <svg
        className="chat-find-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.8-3.8" />
      </svg>
      <input
        ref={inputRef}
        className="chat-find-input"
        dir="auto"
        type="text"
        placeholder="Find"
        aria-label="Find in chat"
        title="Find in chat (Enter = next, Shift+Enter = previous, Esc = close)"
        value={query}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onInputKeyDown}
      />
      <span
        className={"chat-find-count" + (query && count === 0 ? " none" : "")}
        title={countTitle}
      >
        {countText}
      </span>
      <button
        type="button"
        className="chat-find-btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 14 6-6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="chat-find-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 10 6 6 6-6" />
        </svg>
      </button>
      <span className="chat-find-sep" aria-hidden="true" />
      <button
        type="button"
        className={"chat-find-opt" + (matchCase ? " on" : "")}
        title="Match case"
        aria-label="Match case"
        aria-pressed={matchCase}
        onClick={() => onCaseChange(!matchCase)}
      >
        Aa
      </button>
      <button
        type="button"
        className="chat-find-btn"
        title="Close (Escape)"
        aria-label="Close find bar"
        onClick={() => closeRef.current()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
