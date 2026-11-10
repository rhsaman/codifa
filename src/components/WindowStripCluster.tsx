import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import { isPaneAnimating, onPaneAnimationEnd } from "../lib/paneAnimation";
import { UpdateButton } from "./UpdateButton";
import { RunModeSwitch } from "./RunModeSwitch";

/** Window-level controls that ride the sidebar's drag strip beside the traffic
 *  lights. Left to right: the update pill (only when a newer version exists),
 *  the sidebar toggle, then the Chat/Code persona switch.
 *
 *  Settings does NOT live here — it sits on the app bar's right end, directly
 *  right of the wallet chip (see `#titlebar-right` in App.tsx).
 *
 *  The strip sets `data-compact` by MEASURING its host, because the sidebar is
 *  drag-resizable and a viewport media query cannot see that. No step ever hides
 *  a control: a toggle missing a side stops reading as a toggle. */
export function WindowStripCluster() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const clusterRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = clusterRef.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const fit = () => {
      // Mid-slide the host's width is frozen (lib/paneAnimation.ts), so this
      // measurement would be stale anyway; the end hook below re-runs it.
      if (isPaneAnimating()) return;
      delete el.dataset.compact;
      if (host.scrollWidth <= host.clientWidth + 1) return;
      el.dataset.compact = "sm";
      if (host.scrollWidth <= host.clientWidth + 1) return;
      el.dataset.compact = "xs";
    };
    fit();
    // Older WebViews and the test harness may not expose ResizeObserver; the
    // synchronous fit above still covers mount, and the sidebar toggle re-runs
    // this effect.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    // While the sidebar slides, its frozen inner keeps the host at a constant
    // width — ResizeObserver is silent exactly while the fit goes stale, so
    // re-fit when the freeze lifts.
    const offAnimationEnd = onPaneAnimationEnd(fit);
    return () => {
      ro.disconnect();
      offAnimationEnd();
    };
  }, [sidebarOpen]);
  const iconProps = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  return (
    <span className="window-strip-cluster" ref={clusterRef}>
      {/* Appears only when a newer version exists — nothing renders otherwise. */}
      <UpdateButton />
      <button
        className="icon-btn titlebar-icon-btn"
        aria-label={sidebarOpen ? "Hide sidebar (\u2318B)" : "Show sidebar (\u2318B)"}
        title={sidebarOpen ? "Hide sidebar (\u2318B)" : "Show sidebar (\u2318B)"}
        aria-pressed={sidebarOpen}
        onClick={() => useStore.getState().toggleSidebar()}
      >
        {/* A framed panel with its sidebar column marked: the icon states what
            the button toggles, where the old hamburger only stated "some menu".
            The outer box is the app bar pane-toggle's EXACT geometry (rect 3,4
            18x16 r2.5) so the two panel icons read as one size across the
            titlebar — the sidebar rect used to sit a full unit lower and
            shorter (4.5/18x15), and the pair read as mismatched. */}
        <svg {...iconProps}>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M8 9.5v5" />
        </svg>
      </button>
      <RunModeSwitch />
    </span>
  );
}
