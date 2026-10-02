
export function ExpandIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
  );
}

export function CompressIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="21" y2="3" /><line x1="14" y1="10" x2="3" y2="21" /></svg>
  );
}

/** Fullscreen toggle for viewer panels. Docked panels flip the shared viewer
 *  fullscreen state (chat group hides, viewer takes full width); legacy
 *  overlay panels keep their local fullscreen toggle. */
export function ViewerFullscreenButton({
  docked,
  fullscreen,
  onToggleFullscreen,
}: {
  docked: boolean
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  if (docked) return null;
  const active = fullscreen;
  return (
    <button
      className="review-header-btn viewer-fullscreen-btn"
      title={active ? "Exit fullscreen" : "Fullscreen"}
      aria-label={active ? "Exit fullscreen" : "Fullscreen"}
      aria-pressed={active}
      onClick={onToggleFullscreen}
    >
      {active ? <CompressIcon /> : <ExpandIcon />}
    </button>
  );
}
