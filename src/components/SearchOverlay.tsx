import { useEffect, useMemo, useRef, useState } from 'react'
import { workspaceFiles, api, type WorkspaceFile, type SearchMatch } from '../lib/fs'
import { useStore } from '../lib/store'
import { physicalKey } from '../lib/shortcuts'

function fuzzyScore(pattern: string, text: string): number {
  pattern = pattern.toLowerCase()
  text = text.toLowerCase()
  if (!pattern) return 0
  let score = 0
  let prev = -1
  for (const ch of pattern) {
    const idx = text.indexOf(ch, prev + 1)
    if (idx === -1) return 0
    if (prev !== -1) score += idx === prev + 1 ? 8 : 2
    else score += 3
    prev = idx
  }
  return score
}

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const root = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'file' | 'grep'>('file')
  const [idx, setIdx] = useState(0)
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [grep, setGrep] = useState<SearchMatch[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const grepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void workspaceFiles(root).then((f) => {
      if (!cancelled) setFiles(f)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  const query = useMemo(() => {
    const m = /^(?:g:|grep:)(.*)$/.exec(q)
    if (m) return { mode: 'grep' as const, q: m[1] }
    return { mode: mode as 'file' | 'grep', q }
  }, [q, mode])

  const fileResults = useMemo(() => {
    const t = query.q.trim().toLowerCase()
    if (!t) return files.slice(0, 20)
    return files
      .map((f) => ({ f, s: fuzzyScore(t, `${f.rel} ${f.name}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .map((x) => x.f)
  }, [files, query])

  useEffect(() => {
    if (query.mode !== 'grep' || !root || !query.q.trim()) {
      setGrep([])
      return
    }
    setBusy(true)
    if (grepTimer.current) clearTimeout(grepTimer.current)
    grepTimer.current = setTimeout(() => {
      void api
        .searchContent(root, query.q.trim())
        .then((m) => setGrep(m))
        .catch(() => setGrep([]))
        .finally(() => setBusy(false))
    }, 150)
    return () => {
      if (grepTimer.current) clearTimeout(grepTimer.current)
    }
  }, [query, root])

  const results = query.mode === 'grep' ? grep : fileResults

  useEffect(() => setIdx(0), [query.q, query.mode])

  const select = (rel: string) => {
    window.dispatchEvent(new CustomEvent('coder:attach-file', { detail: { rel } }))
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    const move = (d: number) => {
      const max = Math.max(results.length - 1, 0)
      if (d > 0) setIdx((i) => (max === 0 ? 0 : (i + 1) % (max + 1)))
      else setIdx((i) => (max === 0 ? 0 : (i - 1 + max + 1) % (max + 1)))
    }
    if (e.key === 'ArrowDown' || ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'n')) {
      e.preventDefault()
      if ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'n') e.stopPropagation()
      move(1)
      return
    }
    if (e.key === 'ArrowUp' || ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'p')) {
      e.preventDefault()
      if ((e.ctrlKey || e.metaKey) && physicalKey(e) === 'p') e.stopPropagation()
      move(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[idx]
      if (r) select('rel' in r ? (r as WorkspaceFile).rel : (r as SearchMatch).file)
      return
    }
    if (physicalKey(e) === 'f' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setMode((m) => (m === 'grep' ? 'file' : 'grep'))
      return
    }
  }

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <span className="search-glyph">
            {query.mode === 'grep' ? '⌕' : '⌘'}
          </span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder={
              query.mode === 'grep'
                ? 'Search file contents…'
                : 'Search files…  (⇧⌘F for content search)'
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="search-mode-badge">{query.mode === 'grep' ? 'content' : 'files'}</span>
        </div>
        <div className="search-results">
          {!root && <div className="search-empty">No workspace open (⌘O)</div>}
          {root && results.length === 0 && (
            <div className="search-empty">
              {busy ? 'Searching…' : 'No matches'}
            </div>
          )}
          {results.map((r, i) => {
            const isFile = 'rel' in r
            const rel = isFile ? (r as WorkspaceFile).rel : (r as SearchMatch).file
            const line = isFile ? '' : (r as SearchMatch).line
            const text = isFile ? '' : (r as SearchMatch).text
            const name = rel.split('/').pop() ?? rel
            return (
              <div
                key={`${rel}:${line}`}
                className={`search-item ${i === idx ? 'active' : ''}`}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  select(rel)
                }}
              >
                <span className="search-item-name">{name}</span>
                {line ? <span className="search-item-line">{line}</span> : null}
                <span className="search-item-rel">{rel}</span>
                {text && <span className="search-item-text">{text.trim()}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
