/** Small SVG icons for the fullscreen modal head (download / reset-zoom /
 *  close / save feedback). Same currentColor stroke convention as
 *  PanelIcons.tsx — CSS decides the colour in every theme, and stroke glyphs
 *  render with even weight (text glyphs like ✕ ⟳ don't, and on macOS can come
 *  out as coloured emoji). */

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** Arrow into a tray — the download affordance. */
export function DownloadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4.5 21h15" />
    </svg>
  );
}

/** Counter-clockwise arrow — reset zoom back to 100%. */
export function ResetZoomIcon({ size = 15 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/** Plain ✕ — closes the modal. */
export function CloseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Single check — "saved" feedback on the download button. */
export function CheckIcon({ size = 15 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Warning triangle — download failure feedback. */
export function AlertIcon({ size = 15 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
