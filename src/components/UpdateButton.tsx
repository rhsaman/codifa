import { useEffect, useRef, useState } from 'react'
import type { UpdateInfo, UpdateProgress } from '../../electron/preload'

type Phase = 'hidden' | 'available' | 'downloading' | 'installing' | 'done' | 'error'

/** Titlebar update button: appears only when a newer GitHub release exists,
 *  shows download progress while updating, and launches the installer. */
export function UpdateButton() {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [latest, setLatest] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const keep = (p: Phase): Phase =>
      p === 'downloading' || p === 'installing' || p === 'done' ? p : 'hidden'
    const check = (): void => {
      window.coder
        .checkForUpdates()
        .then((u: UpdateInfo) => {
          if (cancelled) return
          if (u.available) {
            setLatest(u.latestVersion)
            setPhase((p) => (p === 'hidden' ? 'available' : keep(p)))
          } else {
            setPhase(keep)
          }
        })
        .catch(() => {
          if (!cancelled) setPhase(keep)
        })
    }
    check()
    const timer = setInterval(check, 30 * 60_000)
    const off = window.coder.onUpdateProgress((p: UpdateProgress) => {
      setPercent(p.percent)
      if (p.phase === 'installing') setPhase('installing')
    })
    return () => {
      cancelled = true
      clearInterval(timer)
      off()
    }
  }, [])

  const start = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setError('')
    setPercent(0)
    setPhase('downloading')
    try {
      const res = await window.coder.startUpdate()
      if (!res.ok) {
        const msg = res.error ?? 'Update failed'
        console.error('[update] failed:', msg)
        setError(msg)
        setPhase('error')
      } else {
        setPhase('done')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[update] failed:', msg)
      setError(msg)
      setPhase('error')
    } finally {
      busyRef.current = false
    }
  }

  if (phase === 'hidden') return null

  const busy = phase === 'downloading' || phase === 'installing'

  return (
    <div className="update-wrap">
      <button
        className={`update-btn ${phase}`}
        onClick={() => void start()}
        disabled={busy}
        title={
          phase === 'error'
            ? `Update failed: ${error}`
            : phase === 'done'
              ? 'Installer opened — finish the update and restart Codifa'
              : `Codifa v${latest} is available — click to update`
        }
      >
        {busy ? (
          <>
            <svg className="update-ring" width="16" height="16" viewBox="0 0 36 36" aria-hidden="true">
              <circle className="update-ring-track" cx="18" cy="18" r="15.9155" />
              <circle
                className="update-ring-bar"
                cx="18"
                cy="18"
                r="15.9155"
                style={{ strokeDashoffset: 100 - percent }}
              />
            </svg>
            <span className="update-label">
              {phase === 'installing' ? 'Installing…' : `${percent}%`}
            </span>
          </>
        ) : phase === 'done' ? (
          <>
            <svg className="update-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m4 12.5 5 5L20 6.5" />
            </svg>
            <span className="update-label">Update ready</span>
          </>
        ) : phase === 'error' ? (
          <>
            <svg className="update-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <span className="update-label">Retry</span>
          </>
        ) : (
          <>
            <svg className="update-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
            </svg>
            <span className="update-label">Update v{latest}</span>
          </>
        )}
      </button>
      {phase === 'error' && error && (
        <div className="update-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}