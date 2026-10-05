/**
 * macOS-style app badges for the workspace menu in the titlebar:
 * FinderIcon for "reveal workspace in file manager" and TerminalIcon for
 * "open terminal in workspace".
 *
 * FinderIcon bundles the real macOS Finder icon (Wikimedia Commons, resized)
 * as a PNG so it stays pixel-faithful to the original. TerminalIcon is a
 * hand-drawn SVG twin of the macOS Terminal icon — fixed fills on purpose.
 *
 * The badge fills nearly the whole rendered 20px box so it sits like a real
 * app icon inside the 30px titlebar button.
 *
 * WorkspaceMenuButton only draws the Finder badge on macOS; other platforms
 * keep the neutral folder glyph (Explorer / Nautilus equivalents differ).
 */

import finderIconUrl from "../assets/finder-icon.png";

export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|MacIntel|Mac OS X/i.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);
}

export function FinderIcon() {
  return (
    <img
      className="mac-app-badge"
      src={finderIconUrl}
      width={20}
      height={20}
      alt=""
      draggable={false}
    />
  );
}

export function FolderIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 13h18" opacity="0.6" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg className="mac-app-badge" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="codifa-terminal-bg" x1="12" y1="1.2" x2="12" y2="22.8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3d3d42" />
          <stop offset="1" stopColor="#1a1a1e" />
        </linearGradient>
      </defs>
      <rect x="1.2" y="1.2" width="21.6" height="21.6" rx="5.2" fill="url(#codifa-terminal-bg)" />
      <g stroke="#f2f2f7" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 8.2l3.6 3.8L7 15.8" />
        <path d="M12.6 15.8h4.4" />
      </g>
    </svg>
  );
}
