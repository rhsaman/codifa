import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UpdateInfo, UpdateProgress } from '../types/coderApi'

type Phase = 'hidden' | 'available' | 'downloading' | 'ready' | 'applying' | 'error'

/** Titlebar update control — sits NEXT TO the settings gear in the window
 *  strip and only APPEARS when a newer version exists (silent checks run at
 *  startup and every 30 minutes; the site feed, when set, is checked first).
 *  Clicking downloads the update (the backend verifies its sha256), then a
 *  popup asks whether to restart Codifa now: on confirm the app closes,
 *  installs the update in place and relaunches itself. "Later" keeps the
 *  button in the titlebar so the restart can be confirmed whenever it suits. */
export function UpdateButton() {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [latest, setLatest] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const keep = (p: Phase): Phase =>
      p === 'downloading' || p === 'ready' || p === 'applying' || p === 'error' ? p : 'hidden'
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
        setPhase('ready')
        setConfirmOpen(true)
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

  /** The user confirmed the popup: the backend hands the swap to a helper,
   *  closes the window (flushing state) and the app relaunches as the new
   *  version. It only answers with an error when nothing was started. */
  const applyAndRestart = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setError('')
    setPhase('applying')
    try {
      const res = await window.coder.installUpdate()
      if (!res.ok) {
        const msg = res.error ?? 'Update failed'
        console.error('[update] install failed:', msg)
        setError(msg)
        setConfirmOpen(false)
        setPhase('error')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[update] install failed:', msg)
      setError(msg)
      setConfirmOpen(false)
      setPhase('error')
    } finally {
      busyRef.current = false
    }
  }

  useEffect(() => {
    if (!confirmOpen || phase !== 'ready') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirmOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmOpen, phase])

  if (phase === 'hidden') return null

  const busy = phase === 'downloading' || phase === 'applying'
  // The control is icon-only: the version/status lives in the tooltip and the
  // accessible name instead of a text pill that eats app-bar width.
  const label =
    phase === 'error'
      ? `Update failed: ${error}`
      : phase === 'ready'
        ? `Codifa v${latest} is ready — click to restart and update`
        : phase === 'applying'
          ? 'Installing update — Codifa will restart…'
          : phase === 'downloading'
            ? `Downloading update… ${percent}%`
            : `Codifa v${latest} is available — click to update`

  const onClick = (): void => {
    if (phase === 'ready') setConfirmOpen(true)
    else void start()
  }

  return (
    <div className="update-wrap">
      <button
        className={`update-btn ${phase}`}
        onClick={onClick}
        disabled={busy}
        title={label}
        aria-label={label}
      >
        {phase === 'downloading' ? (
          <svg className="update-ring" width="17" height="17" viewBox="0 0 36 36" aria-hidden="true">
            <circle className="update-ring-track" cx="18" cy="18" r="15.9155" />
            <circle
              className="update-ring-bar"
              cx="18"
              cy="18"
              r="15.9155"
              style={{ strokeDashoffset: 100 - percent }}
            />
          </svg>
        ) : phase === 'applying' ? (
          <svg className="update-ring update-spin" width="17" height="17" viewBox="0 0 36 36" aria-hidden="true">
            <circle className="update-ring-track" cx="18" cy="18" r="15.9155" />
            <circle className="update-ring-bar" cx="18" cy="18" r="15.9155" style={{ strokeDashoffset: 70 }} />
          </svg>
        ) : phase === 'ready' ? (
          <svg className="update-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        ) : phase === 'error' ? (
          <svg className="update-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        ) : (
          <svg className="update-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
          </svg>
        )}
      </button>
      {confirmOpen && (phase === 'ready' || phase === 'applying')
        ? createPortal(
            <div className="update-modal-backdrop" onMouseDown={() => phase === 'ready' && setConfirmOpen(false)}>
              <div
                className="update-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="update-modal-title"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <h2 id="update-modal-title" className="update-modal-title">
                  {phase === 'applying' ? 'Installing update…' : 'Update ready'}
                </h2>
                <p className="update-modal-body">
                  {phase === 'applying'
                    ? 'Codifa is closing to install the update and will reopen by itself in a moment.'
                    : `Codifa v${latest} has been downloaded. Restart now to install it? Codifa will close, update and reopen automatically.`}
                </p>
                <div className="update-modal-actions">
                  <button
                    className="update-modal-btn"
                    onClick={() => setConfirmOpen(false)}
                    disabled={phase === 'applying'}
                  >
                    Later
                  </button>
                  <button
                    className="update-modal-btn primary"
                    onClick={() => void applyAndRestart()}
                    disabled={phase === 'applying'}
                    autoFocus
                  >
                    {phase === 'applying' ? 'Restarting…' : 'Restart & update'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
