"use client";
/**
 * Animated, theme-coloured overlay scrollbars for the diff surfaces.
 *
 * A native ::-webkit-scrollbar cannot be animated: Chromium applies the new
 * width/colour at once, so a bar either snaps between two widths or keeps
 * one. This draws the bar as real DOM — a lane along the scroller's edge
 * with a thumb inside it — so both can ease.
 *
 * GEOMETRY (the part earlier attempts kept getting wrong): a child of a
 * scroller is laid out in the SCROLLING CONTENT, so `right: 0`/`bottom: 0`
 * measure from the content's END and scrolling drags the bar off-screen —
 * the horizontal bar looked stuck mid-pane and the thumb never followed.
 * So the lanes are content children too, but `place()` PINS them to the
 * scrollport on every scroll event: their offset is set to the host's
 * current scroll position, which the browser applies before that frame
 * paints. The lane holds still relative to the pane while the content
 * slides under it, exactly like a real overlay scrollbar.
 *
 * Nothing reserves space: no dynamic padding, no custom-property feedback
 * loop (a dynamic inset shrank clientWidth, which made the other axis look
 * scrollable, which re-showed its bar — the flicker loop). The content
 * simply scrolls under the thumb, like a macOS overlay bar.
 *
 * At REST the thumb is a 4px hairline in `color-mix(--text 14%)` — the
 * colour of the app's global `::-webkit-scrollbar-thumb`. Only hovering
 * THE BAR (its 12px lane) eases it wider and brighter; grabbing goes one
 * step further. Moving over the diff window never widens anything.
 */
import { useEffect } from "react";

type Host = { current: HTMLElement | null } | HTMLElement | null;

/** Shorter-than-this thumbs stop telling you where you are. */
const MIN_THUMB = 22;
/** Hit area of a bar (the long way is the whole track). */
const THICK = 12;

type Bar = { lane: HTMLDivElement; thumb: HTMLDivElement; axis: "y" | "x" };

// ---------------------------------------------------------------------------
// GLOBAL INSTALLER — every scroller in the app gets the same animated,
// theme-coloured overlay bars without touching each component: a MutationObserver
// on <body> picks up new surfaces (popups, panels, menus) as they mount.
// ---------------------------------------------------------------------------

/** Surfaces the hook owns (and everything inside them): the global sweep must
 *  never double-host them, even in the window before the hook's effect runs. */
const SP_SKIP =
  ".sp-host, .sp-host *, .diff-unified, .diff-unified *, .diff-columns, .diff-columns *, .diff-preview-body, .diff-preview-body *, .review-files, .review-files *";

/** A scroller qualifies when it really scrolls on at least one axis. */
const qualifies = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  if (cs.position === "fixed") return false;
  const oy = cs.overflowY,
    ox = cs.overflowX;
  const scrollsY = (oy === "auto" || oy === "scroll") && el.scrollHeight - el.clientHeight > 1;
  const scrollsX = (ox === "auto" || ox === "scroll") && el.scrollWidth - el.clientWidth > 1;
  return scrollsY || scrollsX;
};

/** Install the drawn bars on ONE scroller (idempotent). Mirrors the hook:
 *  content-child lanes pinned per frame by place(). */
const attach = (el: HTMLElement) => {
  if (el.closest(SP_SKIP)) return;
  if (el.dataset.sp !== undefined) return;
  el.dataset.sp = "y";

  const makeBar = (axis: "y" | "x"): Bar => {
    const lane = document.createElement("div");
    lane.className = "sp-bar";
    lane.dataset.axis = axis;
    lane.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "sp-thumb";
    thumb.dataset.axis = axis;
    lane.appendChild(thumb);
    el.appendChild(lane);
    return { lane, thumb, axis };
  };
  const v = makeBar("y");
  const h = makeBar("x");
  el.classList.add("sp-host", "sp-scroll");

  const thumbLen = (view: number, content: number) =>
    Math.max(MIN_THUMB, Math.round((view * view) / Math.max(1, content)));

  const place = () => {
    const maxL = el.scrollWidth - el.clientWidth;
    const maxT = el.scrollHeight - el.clientHeight;

    // An ancestor host that really scrolls sideways owns the horizontal bar
    // for this content (the Review list around the diff container).
    let outerX = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.classList.contains("sp-host") && p.scrollWidth - p.clientWidth > 1) {
        outerX = true;
        break;
      }
    }

    if (maxT > 1) {
      const track = el.clientHeight;
      const len = thumbLen(track, el.scrollHeight);
      v.lane.style.display = "";
      v.lane.style.left = `${el.scrollLeft + el.clientWidth - THICK}px`;
      v.lane.style.top = `${el.scrollTop}px`;
      v.lane.style.width = `${THICK}px`;
      v.lane.style.height = `${track}px`;
      v.thumb.style.height = `${len}px`;
      v.thumb.style.transform = `translateY(${Math.round((el.scrollTop / maxT) * (track - len))}px)`;
    } else {
      v.lane.style.display = "none";
    }

    if (maxL > 1 && !outerX) {
      const track = el.clientWidth;
      const len = thumbLen(track, el.scrollWidth);
      h.lane.style.display = "";
      h.lane.style.left = `${el.scrollLeft}px`;
      h.lane.style.top = `${el.scrollTop + el.clientHeight - THICK}px`;
      h.lane.style.width = `${track}px`;
      h.lane.style.height = `${THICK}px`;
      h.thumb.style.width = `${len}px`;
      h.thumb.style.transform = `translateX(${Math.round((el.scrollLeft / maxL) * (track - len))}px)`;
    } else {
      h.lane.style.display = "none";
    }
  };

  // Drag + wheel passthrough: identical to the hook's handlers.
  let drag: { axis: "y" | "x"; start: number; startScroll: number; len: number; max: number } | null =
    null;
  const onDown = (bar: Bar) => (e: PointerEvent) => {
    const axis = bar.axis;
    const max =
      axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (max <= 1) return;
    e.preventDefault();
    const rect = bar.lane.getBoundingClientRect();
    const track = axis === "y" ? el.clientHeight : el.clientWidth;
    const len = axis === "y" ? bar.thumb.offsetHeight : bar.thumb.offsetWidth;
    const p = axis === "y" ? e.clientY - rect.top : e.clientX - rect.left;
    const tr = bar.thumb.getBoundingClientRect();
    const inside =
      axis === "y"
        ? e.clientY >= tr.top && e.clientY <= tr.bottom
        : e.clientX >= tr.left && e.clientX <= tr.right;
    const ratio = inside
      ? (axis === "y" ? el.scrollTop : el.scrollLeft) / max
      : Math.min(1, Math.max(0, (p - len / 2) / Math.max(1, track - len)));
    const startScroll = ratio * max;
    if (axis === "y") el.scrollTop = startScroll;
    else el.scrollLeft = startScroll;
    drag = { axis, start: axis === "y" ? e.clientY : e.clientX, startScroll, len, max };
  };
  v.lane.addEventListener("pointerdown", onDown(v));
  h.lane.addEventListener("pointerdown", onDown(h));
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const track = drag.axis === "y" ? el.clientHeight : el.clientWidth;
    const d = (drag.axis === "y" ? e.clientY : e.clientX) - drag.start;
    const next = drag.startScroll + d * (drag.max / Math.max(1, track - drag.len));
    if (drag.axis === "y") el.scrollTop = next;
    else el.scrollLeft = next;
    e.preventDefault();
  };
  const release = () => {
    drag = null;
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  el.addEventListener("scroll", place, { passive: true });
  place();
  let raf = requestAnimationFrame(() => {
    place();
    raf = requestAnimationFrame(place);
  });
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
  ro?.observe(el);
  // A global installer cannot know when a surface's content lands; watch the
  // subtree so rows arriving after mount re-place too.
  const mo = new MutationObserver(place);
  mo.observe(el, { childList: true, subtree: true });
  const detach = () => {
    ro?.disconnect();
    mo.disconnect();
    el.removeEventListener("scroll", place);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    v.lane.remove();
    h.lane.remove();
    el.classList.remove("sp-host", "sp-scroll");
    delete el.dataset.sp;
  };
  // A scroller that stops qualifying (a menu that emptied, a popup that closed
  // its list) releases its bars — the next sweep re-attaches if it grows back.
  const iv = window.setInterval(() => {
    if (!el.isConnected) {
      detach();
      clearInterval(iv);
    } else if (!qualifies(el)) {
      v.lane.style.display = "none";
      h.lane.style.display = "none";
    }
  }, 1500);
  registries.push(detach);
};

const registries: Array<() => void> = [];

/** Sweep the DOM and attach bars to every scroller not carrying them yet.
 *  The candidate scan is EVERY element — popups, menus, panels and anything
 *  mounted later — so no scrollable surface can be forgotten. The cheap
 *  scroll-size pre-filter keeps the cost down; `qualifies()` decides. */
const sweep = (root: ParentNode) => {
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (el.dataset.sp !== undefined) return;
    if (el.closest(SP_SKIP)) return;
    if (
      el.scrollWidth - el.clientWidth <= 1 &&
      el.scrollHeight - el.clientHeight <= 1
    )
      return;
    if (qualifies(el)) attach(el);
  });
};

/** Coalesced sweeping: mutations during a chat stream fire continuously, so a
 *  burst collapses into ONE scan 150ms after the last change. */
let sweepTimer = 0;
const scheduleSweep = () => {
  if (sweepTimer) return;
  sweepTimer = window.setTimeout(() => {
    sweepTimer = 0;
    sweep(document);
  }, 150);
};

/** Install the app-wide overlay scrollbars. Called ONCE from main.tsx. */
export function installOverlayScrollbars() {
  if (window.matchMedia?.("(pointer: coarse)").matches) return;
  sweep(document);
  new MutationObserver(scheduleSweep).observe(document.body, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("resize", scheduleSweep);
}

/** One hook per scroller: the diff container, the chat's preview body and the
 *  Review list. `signature` re-runs it when the content identity changes. */
export function useOverlayScrollbars(hostRef: Host, signature?: unknown) {
  useEffect(() => {
    const host = hostRef && "current" in hostRef ? hostRef.current : hostRef;
    if (!host) return;
    // Touch devices already draw their own overlay bars on tap-scroll.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    // Re-runs (StrictMode remount, a new `signature`) start clean; the same
    // selector also clears bars left by an older version of this hook.
    host.querySelectorAll(":scope > .sp-bar").forEach((n) => n.remove());

    const makeBar = (axis: "y" | "x"): Bar => {
      const lane = document.createElement("div");
      lane.className = "sp-bar";
      lane.dataset.axis = axis;
      lane.setAttribute("aria-hidden", "true");
      const thumb = document.createElement("div");
      thumb.className = "sp-thumb";
      thumb.dataset.axis = axis;
      lane.appendChild(thumb);
      // A content child, pinned per frame by place() — see the header note.
      host.appendChild(lane);
      return { lane, thumb, axis };
    };
    const v = makeBar("y");
    const h = makeBar("x");
    host.classList.add("sp-host", "sp-scroll");
    // Marks the host for the global sweep, which would otherwise attach a
    // second pair of bars in the window before this effect ran.
    host.dataset.sp = "h";

    /** Thumb length along its own axis, proportional to visible/content. */
    const thumbLen = (view: number, content: number) =>
      Math.max(MIN_THUMB, Math.round((view * view) / Math.max(1, content)));

    /**
     * Pin the lanes to the scrollport and size the thumbs. Runs on every
     * scroll (the pin MUST track the offset) and on every layout change.
     */
    const place = () => {
      const maxL = host.scrollWidth - host.clientWidth;
      const maxT = host.scrollHeight - host.clientHeight;

      // An ancestor host that really scrolls sideways owns the horizontal bar
      // for this content (the Review list around the diff container): two
      // lanes painted on top of each other and fought over the same scroll.
      let outerX = false;
      for (let el = host.parentElement; el; el = el.parentElement) {
        if (el.classList.contains("sp-host") && el.scrollWidth - el.clientWidth > 1) {
          outerX = true;
          break;
        }
      }

      if (maxT > 1) {
        const track = host.clientHeight;
        const len = thumbLen(track, host.scrollHeight);
        v.lane.style.display = "";
        v.lane.style.left = `${host.scrollLeft + host.clientWidth - THICK}px`;
        v.lane.style.top = `${host.scrollTop}px`;
        v.lane.style.width = `${THICK}px`;
        v.lane.style.height = `${track}px`;
        v.thumb.style.height = `${len}px`;
        v.thumb.style.transform = `translateY(${Math.round((host.scrollTop / maxT) * (track - len))}px)`;
      } else {
        v.lane.style.display = "none";
      }

      if (maxL > 1 && !outerX) {
        const track = host.clientWidth;
        const len = thumbLen(track, host.scrollWidth);
        h.lane.style.display = "";
        h.lane.style.left = `${host.scrollLeft}px`;
        h.lane.style.top = `${host.scrollTop + host.clientHeight - THICK}px`;
        h.lane.style.width = `${track}px`;
        h.lane.style.height = `${THICK}px`;
        h.thumb.style.width = `${len}px`;
        h.thumb.style.transform = `translateX(${Math.round((host.scrollLeft / maxL) * (track - len))}px)`;
      } else {
        h.lane.style.display = "none";
      }
    };

    let drag: {
      axis: "y" | "x";
      start: number;
      startScroll: number;
      len: number;
      max: number;
    } | null = null;

    const onDown = (bar: Bar) => (e: PointerEvent) => {
      const axis = bar.axis;
      const max =
        axis === "y"
          ? host.scrollHeight - host.clientHeight
          : host.scrollWidth - host.clientWidth;
      if (max <= 1) return;
      e.preventDefault();
      const rect = bar.lane.getBoundingClientRect();
      const track = axis === "y" ? host.clientHeight : host.clientWidth;
      const len = axis === "y" ? bar.thumb.offsetHeight : bar.thumb.offsetWidth;
      const p = axis === "y" ? e.clientY - rect.top : e.clientX - rect.left;
      // On the thumb: grab it where it is. On the bare track: jump the thumb
      // so it centres under the pointer (what a real scrollbar does).
      const tr = bar.thumb.getBoundingClientRect();
      const inside =
        axis === "y"
          ? e.clientY >= tr.top && e.clientY <= tr.bottom
          : e.clientX >= tr.left && e.clientX <= tr.right;
      const ratio = inside
        ? (axis === "y" ? host.scrollTop : host.scrollLeft) / max
        : Math.min(1, Math.max(0, (p - len / 2) / Math.max(1, track - len)));
      const startScroll = ratio * max;
      if (axis === "y") host.scrollTop = startScroll;
      else host.scrollLeft = startScroll;
      drag = {
        axis,
        start: axis === "y" ? e.clientY : e.clientX,
        startScroll,
        len,
        max,
      };
    };
    v.lane.addEventListener("pointerdown", onDown(v));
    h.lane.addEventListener("pointerdown", onDown(h));

    const move = (e: PointerEvent) => {
      if (!drag) return;
      const track = drag.axis === "y" ? host.clientHeight : host.clientWidth;
      const d = (drag.axis === "y" ? e.clientY : e.clientX) - drag.start;
      const next = drag.startScroll + d * (drag.max / Math.max(1, track - drag.len));
      if (drag.axis === "y") host.scrollTop = next;
      else host.scrollLeft = next;
      e.preventDefault();
    };
    const release = () => {
      drag = null;
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);

    const relayout = () => place();
    host.addEventListener("scroll", relayout, { passive: true });
    place();
    // Two frames: the first settles the host's own layout, the second the
    // content's (fonts, highlight spans) — both before the user sees a bar.
    let raf = requestAnimationFrame(() => {
      place();
      raf = requestAnimationFrame(place);
    });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(relayout);
      ro.observe(host);
    }
    // Rows arriving after mount (an empty Review list that fills on open) are
    // a DOM change, not a host resize: watch the subtree too.
    const mo = new MutationObserver(relayout);
    mo.observe(host, { childList: true, subtree: true });
    // Fonts/highlighting settle late: re-place on a short poll that stops as
    // soon as the content size holds still.
    let ticks = 0;
    let settled = { w: -1, h: -1 };
    const poll = window.setInterval(() => {
      place();
      const w = host.scrollWidth;
      const ht = host.scrollHeight;
      if (++ticks > 2 && w === settled.w && ht === settled.h) window.clearInterval(poll);
      settled = { w, h: ht };
      if (ticks > 20) window.clearInterval(poll);
    }, 50);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      ro?.disconnect();
      mo.disconnect();
      host.removeEventListener("scroll", relayout);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      v.lane.remove();
      h.lane.remove();
      host.classList.remove("sp-host", "sp-scroll");
      delete host.dataset.sp;
    };
  }, [hostRef, signature]);
}

/** Back-compat: the diff surfaces still call this under the old name. */
export function useDiffScrollbars(hostRef: Host, signature?: unknown) {
  return useOverlayScrollbars(hostRef, signature);
}
