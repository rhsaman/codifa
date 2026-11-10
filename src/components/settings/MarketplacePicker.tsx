import { useEffect, useMemo, useRef, useState } from 'react'
import { marketKey } from '../../lib/plugins'
import type { MarketplaceSource } from '../../types'

/** The "every marketplace" scope — the picker's default selection. */
export const ALL_MARKETS = 'all'

interface Props {
  /** Already ordered newest-added first. */
  markets: MarketplaceSource[]
  /** `ALL_MARKETS` or a `marketKey`. */
  selected: string
  /** Rows each loaded index carries, by key (absent while unloaded). */
  counts: Record<string, number | undefined>
  /** Rows across every marketplace, deduped. */
  total: number
  loadingKeys: string[]
  onSelect: (key: string) => void
  onRemove: (m: MarketplaceSource) => void
}

/** Marketplace switcher: ONE dropdown instead of a chip per subscription, so a
 *  hundred repos still take the room of a single control. The panel has its own
 *  search box, the newest-added repo sits on top, and `All` is the default. */
export function MarketplacePicker({
  markets,
  selected,
  counts,
  total,
  loadingKeys,
  onSelect,
  onRemove,
}: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const query = q.trim().toLowerCase()
  const rows = useMemo(() => {
    const list = markets.map((m) => ({ key: marketKey(m.repo, m.path, m.git_ref), m }))
    if (!query) return list
    return list.filter(({ m }) =>
      `${m.label ?? ''} ${m.repo} ${m.path ?? ''}`.toLowerCase().includes(query),
    )
  }, [markets, query])
  const showAll = !query
  const options = showAll ? [ALL_MARKETS, ...rows.map((r) => r.key)] : rows.map((r) => r.key)

  const close = () => {
    setOpen(false)
    setQ('')
  }

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  const pick = (key: string) => {
    onSelect(key)
    close()
  }

  const current = markets.find((m) => marketKey(m.repo, m.path, m.git_ref) === selected)
  const currentName = selected === ALL_MARKETS || !current ? 'All marketplaces' : current.label ?? current.repo
  const currentCount = selected === ALL_MARKETS ? total : counts[selected]

  return (
    <div className="mp-picker" ref={rootRef}>
      <button
        type="button"
        className={`mp-trigger${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="mp-dot" aria-hidden="true" />
        <span className="mp-trigger-name" dir="auto">{currentName}</span>
        {currentCount != null ? <span className="pm-count">{currentCount}</span> : null}
        <span className="mp-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="mp-pop" role="listbox" aria-label="Marketplaces">
          <input
            ref={searchRef}
            type="search"
            className="mp-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${markets.length} marketplaces…`}
            dir="ltr"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, options.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (options[active] != null) pick(options[active])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
          />
          <div className="mp-list">
            {showAll && (
              <div
                role="option"
                aria-selected={selected === ALL_MARKETS}
                className={`mp-row${selected === ALL_MARKETS ? ' selected' : ''}${active === 0 ? ' active' : ''}`}
                onMouseEnter={() => setActive(0)}
                onClick={() => pick(ALL_MARKETS)}
              >
                <span className="mp-row-name">All marketplaces</span>
                <span className="pm-count">{total}</span>
              </div>
            )}
            {rows.map(({ key, m }, i) => {
              const idx = showAll ? i + 1 : i
              const n = counts[key]
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={selected === key}
                  className={`mp-row${selected === key ? ' selected' : ''}${active === idx ? ' active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(key)}
                  title={`${m.repo}${m.path ? ` · ${m.path}` : ''}${m.git_ref ? ` @ ${m.git_ref}` : ''}`}
                >
                  <span className="mp-row-name" dir="auto">{m.label ?? m.repo}</span>
                  {m.label ? <span className="mp-row-sub" dir="ltr">{m.repo}</span> : null}
                  <span className="mp-spacer" />
                  {n != null ? (
                    <span className="pm-count">{n}</span>
                  ) : loadingKeys.includes(key) ? (
                    <span className="mp-loading">…</span>
                  ) : null}
                  <button
                    type="button"
                    className="mp-row-x"
                    aria-label={`Remove ${m.label ?? m.repo}`}
                    title="Remove this marketplace — plugins already installed stay"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(m)
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {rows.length === 0 && <div className="hint empty-state">No marketplace matches.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
