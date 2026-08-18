export function LoadingScreen() {
  return (
    <div className="loading-screen" role="status" aria-label="Loading CODEFA">
      <div className="loading-screen__glow" />
      <div className="loading-screen__grid" />
      <div className="loading-screen__content">
        <div className="loading-logo">
          <div className="loading-logo__orbit">
            <span className="loading-logo__orbit-dot" />
          </div>
          <div className="loading-logo__ring" />
          <div className="loading-logo__core">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
        </div>
        <h1 className="loading-wordmark">CODEFA</h1>
        <p className="loading-status">
          <span className="loading-status__label">Loading workspace</span>
          <span className="loading-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </div>
    </div>
  )
}