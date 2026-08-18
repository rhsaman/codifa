import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { downloadModel, getModelsStatus } from '../lib/api'

interface Props {
  onReady: () => void
}

const POLL_MS = 2500

export function DownloadModelGate({ onReady }: Props) {
  const embeddingModel = useStore((s) => s.embeddingModel)
  const embeddingBaseUrl = useStore((s) => s.embeddingBaseUrl)
  const dataPath = useStore((s) => s.dataPath)
  const setEmbeddingModel = useStore((s) => s.setEmbeddingModel)
  const setEmbeddingBaseUrl = useStore((s) => s.setEmbeddingBaseUrl)

  const [repo, setRepo] = useState(embeddingModel || 'intfloat/multilingual-e5-base')
  const [mirror, setMirror] = useState(embeddingBaseUrl)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    if (ready) onReady()
  }, [ready, onReady])

  // Poll while a download is running so the page flips to the app the
  // moment the embedding model is ready.
  useEffect(() => {
    if (!downloading) return
    const id = setInterval(() => {
      getModelsStatus()
        .then((st) => {
          const isReady = (st.embedding?.dirs ?? []).some((d) => d.ready)
          if (isReady) {
            setReady(true)
            clearInterval(id)
          } else if (st.embedding?.running?.state === 'error') {
            setError(st.embedding.running.error || 'Download failed.')
            setDownloading(false)
            clearInterval(id)
          }
        })
        .catch(() => {
          /* sidecar hiccup — keep polling */
        })
    }, POLL_MS)
    return () => clearInterval(id)
  }, [downloading])

  const start = () => {
    setError('')
    setDownloading(true)
    // Persist the chosen repo/mirror back to the store so Settings → Models
    // reflects exactly what was downloaded.
    setEmbeddingModel(repo)
    setEmbeddingBaseUrl(mirror)
    downloadModel('embedding', repo.trim() || 'intfloat/multilingual-e5-base', mirror.trim())
      .catch((exc) => {
        setDownloading(false)
        setError(exc instanceof Error ? exc.message : String(exc))
      })
  }

  const target = (dataPath && dataPath.trim() ? dataPath : '~/.codifa') + '/models'

  return (
    <div className="download-gate">
      <div className="download-gate-card">
        <div className="download-gate-icon">⬇</div>
        <div className="download-gate-title">Download the essential model</div>
        <div className="download-gate-sub">
          Coder needs a local embedding model for RAG memory and automatic skill
          selection. Download it once and it stays installed.
        </div>

        <label className="download-gate-label">Model (HF repo id)</label>
        <input
          className="download-gate-input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          dir="ltr"
          placeholder="intfloat/multilingual-e5-base"
          disabled={downloading}
        />

        <label className="download-gate-label">Mirror base URL (optional)</label>
        <input
          className="download-gate-input"
          value={mirror}
          onChange={(e) => setMirror(e.target.value)}
          dir="ltr"
          placeholder="e.g. https://hf-mirror.com"
          disabled={downloading}
        />

        <div className="download-gate-hint" dir="ltr">
          Downloads into: {target}
        </div>

        {downloading && (
          <div className="download-gate-status">
            <span className="spinner" />
            <span>Downloading…</span>
          </div>
        )}

        {error && <div className="download-gate-error">{error}</div>}

        <button className="btn" disabled={downloading} onClick={start}>
          {downloading ? 'Downloading…' : 'Download'}
        </button>
      </div>
    </div>
  )
}