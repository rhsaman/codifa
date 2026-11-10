import { listMcp } from '../../lib/api'
import { MarketplaceEntry, MarketplaceIndex, deletePlugin, installPlugin, installedForRow, installedFromAddress, isRowInstalling, listMarketplace, listPlugins, marketKey, marketplaceLabel, parseMarketplaceAddress, sameMarketplace, subscribeInstallChanges, togglePlugin } from '../../lib/plugins'
import { forgetPluginCommands, invalidateAvailableSkills, invalidateSkillsList } from '../../lib/skills'
import { DEFAULT_MARKETPLACES, useStore } from '../../lib/store'
import { moveAt, useDragReorder } from '../../lib/useDragReorder'
import { useInfiniteGrid } from '../../lib/useInfiniteGrid'
import type { MarketplaceSource, PluginInfo, SearchPluginConfig, SearchPluginKind } from '../../types'
import { PluginDetail } from '../PluginDetail'
import { CSSProperties, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ALL_MARKETS, MarketplacePicker } from './MarketplacePicker'
import { CARD_BATCH, GripDots, SEARCH_ENGINE_KINDS, providerHue } from './rows'

export function MarketplaceEditor() {
  const marketplaces = useStore((s) => s.marketplaces ?? [])
  const setMarketplaces = useStore((s) => s.setMarketplaces)

  const [repo, setRepo] = useState('')
  const [label, setLabel] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  /** Marketplace the grid is scoped to: `ALL_MARKETS` (default) or a marketKey. */
  const [selected, setSelected] = useState(ALL_MARKETS)
  /** One loaded index per marketplace, keyed by install address: a kind tab
   *  merges EVERY one of them into one grid, so no chip needs picking first. */
  const [indexes, setIndexes] = useState<Record<string, MarketplaceIndex>>({})
  /** Which indexes are mid-fetch (per key) — the merged list stays up while
   *  the others still load. */
  const [loadingKeys, setLoadingKeys] = useState<string[]>([])
  /** Which catalogue tab is open. EVERYTHING scopes to it — the marketplace
   *  chips, the add form and the cards. */
  /** How many cards the infinite scroll has revealed so far. */
  const [visible, setVisible] = useState(CARD_BATCH)
  const [filter, setFilter] = useState('')
  const [installed, setInstalled] = useState<PluginInfo[]>([])
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  /** Rows mid-install RIGHT NOW, read from the module-level registry in
   *  `lib/plugins`. This editor unmounts on every tab switch, so component
   *  state cannot hold an install in flight: the button fell back to a plain
   *  "Install" on return (the reported "my download was cancelled") and a
   *  single busy STRING let a second install blank the first's indicator.
   *  The registry is per-address and survives the unmount; this subscription
   *  only re-renders the grid when it changes. */
  const [, bumpInstalls] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeInstallChanges(bumpInstalls), [bumpInstalls])

  /** Which rows are already here. Matching is by REPO + bundle name/slug:
   *  the address alone cannot tell two rows sharing one source folder apart
   *  (`anthropics/skills` publishes five rows from `./`), while the name alone
   *  would hide a same-named plugin installed from another marketplace. */
  const refreshInstalled = useCallback(async () => {
    const out = await listPlugins()
    if (Array.isArray(out)) setInstalled(out)
  }, [])

  // Returning to this tab must show the truth: the installed list was only
  // ever read AFTER an install, so a revisit showed every row as not-installed
  // and every finished bundle read "Install" again.
  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  // A delete (or an install from the chat) must re-show the row in the
  // catalogue: the installed list is what hides it, so it has to follow the
  // same event every other plugin surface uses.
  useEffect(() => {
    const onChanged = () => void refreshInstalled()
    window.addEventListener('coder:plugins-changed', onChanged)
    return () => window.removeEventListener('coder:plugins-changed', onChanged)
  }, [refreshInstalled])

  /** Load one marketplace's index into the merged map (each read is cached
   *  server-side, so a kind tab fills from every catalogue without waiting
   *  on the slowest repo). */
  const loadIndex = useCallback(async (m: MarketplaceSource, refresh = false) => {
    const key = marketKey(m.repo, m.path, m.git_ref)
    setLoadingKeys((ks) => (ks.includes(key) ? ks : [...ks, key]))
    setError('')
    try {
      const out = await listMarketplace({
        repo: m.repo,
        ...(m.path ? { path: m.path } : {}),
        ...(m.git_ref ? { git_ref: m.git_ref } : {}),
        ...(refresh ? { refresh: true } : {}),
      })
      if ('error' in out) {
        setError(`${m.label ?? m.repo}: ${out.error}`)
        return
      }
      setIndexes((cur) => ({ ...cur, [key]: out }))
    } finally {
      setLoadingKeys((ks) => ks.filter((k) => k !== key))
    }
  }, [])

  // EVERY marketplace of the kind loads for its tab: the grid below merges
  // all of them, so the Skills tab shows the union, not one repo's rows.
  // A failed read leaves its slot empty (the error line says which repo) and
  // picking that marketplace in the dropdown, or Refresh, retries it.
  // Newest-added first: the list is stored oldest → newest (an add appends),
  // so the display order is its reverse. The merged grid follows the same order.
  const kindMarkets = [...marketplaces].reverse()
  const kindKeyList = kindMarkets.map((m) => marketKey(m.repo, m.path, m.git_ref)).join('\n')
  /** Latest map for the load-all effect, without re-subscribing it on each
   *  landed index. */
  const indexesRef = useRef(indexes)
  indexesRef.current = indexes
  useEffect(() => {
    if (!kindKeyList) return
    for (const m of kindMarkets) {
      const key = marketKey(m.repo, m.path, m.git_ref)
      if (!indexesRef.current[key]) void loadIndex(m)
    }
    // kindMarkets is derived from marketplaces + kind; kindKeyList changes
    // exactly when any of them is added, removed or re-addressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKeyList, loadIndex])

  const addFromForm = () => {
    const addr = repo.trim()
    if (!addr) return
    // One string carries everything: `owner/repo@ref/sub-path`. The parser is
    // shared with `/plugin marketplace add`, so the form and the command can
    // never disagree about what an address means.
    const parsed = parseMarketplaceAddress(addr)
    const source: MarketplaceSource = {
      repo: parsed.repo,
      kind: 'plugins',
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(parsed.path ? { path: parsed.path } : {}),
      ...(parsed.git_ref ? { git_ref: parsed.git_ref } : {}),
    }
    // Adding the same catalogue twice used to be a SILENT no-op: the form
    // cleared and nothing said why the list did not grow. Say it instead.
    const existing = marketplaces.find((m) => sameMarketplace(m, source))
    if (existing) {
      setError('')
      setNote(
        `Marketplace "${marketplaceLabel(existing)}" is already added — nothing changed.`,
      )
      setRepo('')
      setLabel('')
      return
    }
    setError('')
    setNote('')
    setMarketplaces([...marketplaces, source])
    setRepo('')
    setLabel('')
    setShowAdd(false)
    void loadIndex(source)
  }

  const remove = (m: MarketplaceSource) => {
    if (!window.confirm(`Remove marketplace "${m.label ?? m.repo}"? Installed plugins stay.`)) return
    const key = marketKey(m.repo, m.path, m.git_ref)
    setSelected((cur) => (cur === key ? ALL_MARKETS : cur))
    setMarketplaces(
      marketplaces.filter((x) => !sameMarketplace(x, m)),
    )
    setIndexes((cur) => {
      if (!(key in cur)) return cur
      const next = { ...cur }
      delete next[key]
      return next
    })
  }

  /** Install (or update) one entry, then make the app see the new bundle.
   *
   *  The caches and the command-usage event are the SAME ones a `/plugin
   *  install` refreshes: without them a freshly installed bundle's skills would
   *  not appear as `/`-commands until a reload. */
  const install = async (entry: MarketplaceEntry) => {
    const key = marketKey(entry.repo, entry.repo_path, entry.repo_ref)
    // The registry (not the button) is the one guard: a double click, a
    // re-click after a tab switch, and the chat path all meet here.
    if (isRowInstalling(key)) return
    setError('')
    // A row that is already installed must never be installed a second time.
    // The grid hides such rows, but a stale installed list (or a click racing
    // the first refresh) could still reach here; ask the backend for the live
    // truth before paying another repo read.
    const live = await listPlugins()
    const pool = Array.isArray(live) ? live : installed
    const already =
      installedForRow(pool, entry) ??
      installedFromAddress(pool, {
        repo: entry.repo,
        repo_path: entry.repo_path,
        repo_ref: entry.repo_ref,
      })
    if (already) {
      if (Array.isArray(live)) setInstalled(live)
      setNote(
        `${already.name || entry.name} is already installed (${already.slug}) — nothing changed. ` +
          'Update it in Plugins if the source changed.',
      )
      return
    }
    const out = await installPlugin({
      repo: entry.repo,
      ...(entry.repo_path ? { repo_path: entry.repo_path } : {}),
      ...(entry.repo_ref ? { repo_ref: entry.repo_ref } : {}),
      // The ROW's name is the bundle's name. Without it a row pointing at a
      // shared source folder (five anthropics/skills rows all use `./`) landed
      // as one repo-named bundle, so the row could never tell it was installed.
      name: entry.name,
      // No `kind` is sent: the row decides. A repo with ONE skill and no
      // manifest becomes a single-skill bundle, a connector-only row a
      // single-connector one, and a real bundle stays a bundle — so every row
      // lands somewhere a user can switch it on and off.
      // Recorded in the manifest, so an update re-installs from the same
      // category the row advertised.
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      // A row may publish only some of the skills in its source folder.
      ...(entry.skills?.length ? { skills: entry.skills } : {}),
    })
    if ('error' in out) {
      setError(`${entry.name}: ${out.error}`)
      return
    }
    setNote(
      `${out.installed === 'updated' ? 'Updated' : 'Installed'} ${out.plugin?.name ?? entry.name} — ` +
        `${(out.skills ?? []).length} skills, ${(out.mcp ?? []).length} connectors.`,
    )
    void refreshInstalled()
    invalidateSkillsList()
    invalidateAvailableSkills()
    // This editor is a SIBLING of the Skills/MCP tabs, so it cannot refresh
    // their state directly: the same event a bundle delete fires is what makes
    // the parent re-read both lists — a freshly installed skill or connector
    // was otherwise invisible until the modal was reopened.
    window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
    // A connector landed in the connector STORE, which the Settings list reads
    // through the module store, so it is re-hydrated here too.
    if ((out.mcp ?? []).length > 0) void listMcp().then((db) => {
      useStore.getState().setMcpServers(db.mcpServers ?? {})
    }).catch(() => { })
  }

  const loading = loadingKeys.length > 0
  // Merge EVERY marketplace of the kind into one list, deduped by install
  // address: the same plugin advertised by two repos shows once.
  const sel = kindMarkets.some((m) => marketKey(m.repo, m.path, m.git_ref) === selected)
    ? selected
    : ALL_MARKETS
  const scopeMarkets =
    sel === ALL_MARKETS
      ? kindMarkets
      : kindMarkets.filter((m) => marketKey(m.repo, m.path, m.git_ref) === sel)
  const scopeName =
    sel !== ALL_MARKETS && scopeMarkets[0] ? scopeMarkets[0].label ?? scopeMarkets[0].repo : ''
  const counts: Record<string, number | undefined> = {}
  for (const m of kindMarkets) {
    const k = marketKey(m.repo, m.path, m.git_ref)
    counts[k] = indexes[k]?.plugins?.length
  }
  const allTotal = new Set(
    kindMarkets.flatMap((m) =>
      (indexes[marketKey(m.repo, m.path, m.git_ref)]?.plugins ?? []).map((e) =>
        marketKey(e.repo, e.repo_path, e.repo_ref),
      ),
    ),
  ).size
  const selectMarket = (key: string) => {
    setSelected(key)
    setVisible(CARD_BATCH)
    // A repo whose first read failed retries the moment it is picked.
    const m = kindMarkets.find((x) => marketKey(x.repo, x.path, x.git_ref) === key)
    if (m && !indexes[key] && !loadingKeys.includes(key)) void loadIndex(m)
  }
  const seen = new Set<string>()
  const allEntries = scopeMarkets.flatMap(
    (m) => indexes[marketKey(m.repo, m.path, m.git_ref)]?.plugins ?? [],
  )
  const q = filter.trim().toLowerCase()
  /** Rows hidden because their bundle is already installed. Kept for the
   *  empty state: "all installed" must not read as "nothing matches". */
  let installedHidden = 0
  const matches = allEntries.filter((e) => {
    const key = marketKey(e.repo, e.repo_path, e.repo_ref)
    if (seen.has(key)) return false
    seen.add(key)
    if (installedForRow(installed, e)) {
      installedHidden++
      return false
    }
    return !q || `${e.name} ${e.description} ${e.author} ${e.category ?? ''}`.toLowerCase().includes(q)
  })
  /** Latest hidden-count for the scroll sentinel's callback, without
   *  re-subscribing the IntersectionObserver on every keystroke. */
  const hiddenRef = useRef(0)
  hiddenRef.current = matches.length - Math.min(visible, matches.length)
  // Infinite scroll: a batch of cards first, more on demand. The count line
  // says what is still behind the fold so the cut never reads as "end of list".
  const shown = matches.slice(0, visible)
  const hidden = matches.length - shown.length
  const loadMore = () => setVisible((v) => v + CARD_BATCH)

  /** Infinite scroll: a sentinel div at the foot of the grid; touching it
   *  reveals the next batch. The "Show more" button stays as the no-scroll
   *  fallback (keyboard/short windows) doing the same reveal. */
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hiddenRef.current > 0) loadMore()
      },
      { rootMargin: '240px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [matches.length])

  return (
    <>
      <div className="field">
        <div className="field-head">
          <label>Marketplaces</label>
          <button className="btn tiny secondary" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? 'Cancel' : '+ Add marketplace'}
          </button>
        </div>

        {/* No kind selector: a marketplace row installs a plugin whatever it
            advertises (a lone skill or a lone connector becomes its own
            single-part bundle), so splitting the catalogues by kind only hid
            half of them behind a tab. */}

        {marketplaces.length === 0 ? (
          <div className="hint">
            No marketplace yet.{' '}
            <button className="btn tiny" onClick={() => setMarketplaces(DEFAULT_MARKETPLACES)}>
              Bring back the defaults
            </button>
          </div>
        ) : (
          <MarketplacePicker
            markets={kindMarkets}
            selected={sel}
            counts={counts}
            total={allTotal}
            loadingKeys={loadingKeys}
            onSelect={selectMarket}
            onRemove={remove}
          />
        )}

        {showAdd && (
          <div className="market-add">
            {/* The whole form is ONE row: address + optional name + Add. Sub-folder
                and branch all parse from one string (`owner/repo@ref/sub`), so no
                second field exists to explain. */}
            <div className="market-add-row">
              <input
                className="market-add-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo, a GitHub URL, or a local folder"
                dir="ltr"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addFromForm()
                }}
              />
              <input
                className="market-add-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Name (optional)"
                dir="auto"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addFromForm()
                }}
              />
              <button className="btn" disabled={!repo.trim()} onClick={addFromForm}>
                Add
              </button>
            </div>
          </div>
        )}
      </div>

      {error ? <div className="hint error-text">{error}</div> : null}
      {note ? <div className="hint">{note}</div> : null}

      {/* The body renders even with NO marketplace: the search box and the
          guidance used to be nested inside the "has a source" branch, so a
          catalogue that failed to load left nowhere to type. */}
      <div className="field">
          <div className="field-head">
            <label>
              {sel === ALL_MARKETS ? 'All plugins from every marketplace' : `Plugins from ${scopeName}`}
              {matches.length > 0 ? <span className="pm-count">{matches.length}</span> : null}
            </label>
            <span className="plugin-spacer" />
            <button
              className="btn tiny secondary"
              disabled={loading}
              onClick={() => scopeMarkets.forEach((m) => void loadIndex(m, true))}
              title="Reread the index from GitHub instead of the saved copy"
            >
              Refresh
            </button>
          </div>
          {kindMarkets.some(
            (m) => indexes[marketKey(m.repo, m.path, m.git_ref)]?.stale,
          ) ? (
            <div className="hint" style={{ color: 'var(--warning, #d19a66)' }}>
              Some marketplaces could not be reached — showing their saved copies.
              Press Refresh to try again.
            </div>
          ) : null}
          <div className="settings-search">
            <input
              type="search"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setVisible(CARD_BATCH)
              }}
              placeholder="Search plugins…"
              dir="ltr"
            />
          </div>

          {matches.length === 0 ? (
            loading ? (
              /* Skeleton grid while the indexes load: the same card shapes the
                 real list will fill, so nothing jumps when data lands. */
              <div className="market-grid market-skeleton" aria-busy="true" aria-live="polite">
                {Array.from({ length: 9 }, (_, i) => (
                  <div key={i} className="market-card market-skel-card" style={{ animationDelay: `${i * 90}ms` }}>
                    <div className="skel-line skel-title" />
                    <div className="skel-line" />
                    <div className="skel-line skel-short" />
                  </div>
                ))}
              </div>
            ) : kindMarkets.length === 0 ? (
              /* No source at all — say so and offer the one-click way out
                 instead of a "nothing matches" that blames the query. */
              <div className="hint">
                No marketplace yet — add one above, or{' '}
                <button className="btn tiny" onClick={() => setMarketplaces(DEFAULT_MARKETPLACES)}>
                  bring back the defaults
                </button>
                .
              </div>
            ) : installedHidden > 0 && !q ? (
              /* Everything here is already installed. Saying "nothing
                 matches" would blame the query for what is really a state. */
              <div className="hint empty-state">
                All {installedHidden} plugin{installedHidden === 1 ? '' : 's'} here{' '}
                {installedHidden === 1 ? 'is' : 'are'} installed. Update them in Plugins,
                or delete one to see it in the marketplace again.
              </div>
            ) : (
              <div className="hint empty-state">Nothing matches.</div>
            )
          ) : (
            <>
              <div className="market-grid">
                {shown.map((entry) => {
                  const key = marketKey(entry.repo, entry.repo_path, entry.repo_ref)
                  const installing = isRowInstalling(key)
                  return (
                    <div key={key} className="market-card">
                      <div className="market-card-head">
                        <span
                          className="pm-avatar"
                          style={{ '--h': providerHue(entry.name) } as CSSProperties}
                          aria-hidden="true"
                        >
                          {(entry.name.trim()[0] ?? '?').toUpperCase()}
                        </span>
                        <div className="market-card-info">
                          <span className="market-card-name" dir="ltr" title={entry.name}>{entry.name}</span>
                          <span className="market-card-sub" dir="ltr">
                            {entry.author ? entry.author : entry.category ?? ''}
                          </span>
                        </div>
                        <button
                          className="btn tiny"
                          disabled={installing}
                          onClick={() => void install(entry)}
                        >
                          {installing ? 'Installing…' : 'Install'}
                        </button>
                      </div>
                      {entry.description ? (
                        <div className="market-card-desc">{entry.description}</div>
                      ) : null}
                      <div className="market-card-foot">
                        {entry.category && entry.author ? (
                          <span className="market-card-cat">{entry.category}</span>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>

              {hidden > 0 && (
                <div className="market-more">
                  <button className="btn secondary" onClick={loadMore}>
                    Show {Math.min(CARD_BATCH, hidden)} more
                  </button>
                  <span className="market-more-count">
                    {shown.length} of {matches.length}
                  </span>
                </div>
              )}
              {hidden === 0 && matches.length > CARD_BATCH && (
                <div className="market-more-count">All {matches.length} shown</div>
              )}
              <div ref={sentinelRef} />
            </>
          )}
      </div>

      <div className="field">
        <div className="hint">
          A bundle installed from here lands in <b>Plugins</b> like any other: edit its
          description there, switch it off, or press <b>Update from source</b> to pull
          it again.
        </div>
      </div>
    </>
  )
}

/** Settings → Plugins: folder bundles of skills + MCP connectors.
 *
 *  The list is read from the data folder on open instead of being mirrored in
 *  settings.json: the folder IS the source of truth (the agent's `/plugin`
 *  command writes to the same place), so a persisted copy would only go stale.
 */
export function PluginBundleEditor() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [pluginFilter, setPluginFilter] = useState('')
  // The one skill knob that is NOT per bundle: how much of the whole catalog
  // rides in every prompt. It sits ABOVE the grid because it scales the whole
  // page's content, not any one bundle.
  const skillCatalogMaxChars = useStore((s) => s.skillCatalogMaxChars ?? 6000)
  const setSkillCatalogMaxChars = useStore((s) => s.setSkillCatalogMaxChars)

  /** Filter before paging: one query covers the name, its skills and its
   *  description, so a word of what a bundle does finds it. */
  const filteredPlugins = (plugins ?? []).filter((p) => {
    const q = pluginFilter.trim().toLowerCase()
    if (!q) return true
    return (
      `${p.name} ${p.slug} ${p.description ?? ''} ${(p.skills ?? []).join(' ')}`
        .toLowerCase()
        .includes(q)
    )
  })
  const grid = useInfiniteGrid(filteredPlugins.length, `plugins:${pluginFilter}`)
  const visiblePlugins = filteredPlugins.slice(0, grid.visible)

  /** The bundle whose detail page is open — `null` keeps the grid on screen. */
  const [detail, setDetail] = useState<PluginInfo | null>(null)

  const refresh = useCallback(async () => {
    const out = await listPlugins()
    if ('error' in out) {
      setError(out.error)
      setPlugins([])
      return
    }
    setError('')
    setPlugins(out)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const flip = async (p: PluginInfo) => {
    setBusy(p.slug)
    const out = await togglePlugin(p.slug)
    setBusy('')
    if ('error' in out) setError(out.error)
    else
      setPlugins((cur) =>
        (cur ?? []).map((x) => (x.slug === out.slug ? out : x)),
      )
  }

  const remove = async (p: PluginInfo) => {
    if (!window.confirm(`Delete plugin "${p.name}"? Its skills and connectors go with it.`)) return
    setBusy(p.slug)
    // Read the bundle's skills BEFORE the delete: they are the names of the
    // `/`-commands that must be forgotten, and afterwards nothing is left to
    // name them by.
    const out = await deletePlugin(p.slug)
    setBusy('')
    if ('error' in out) setError(out.error)
    else {
      setPlugins((cur) => (cur ?? []).filter((x) => x.slug !== p.slug))
      forgetPluginCommands(p.slug)
      // The composer's `/`-menu and the `@mention` catalog are both built from
      // the OTHER skill cache, so dropping only this panel's list left the dead
      // command in the menu until a reload. Settings is one of the two places a
      // bundle can be deleted from, so both caches are dropped here too.
      invalidateSkillsList()
      invalidateAvailableSkills()
      window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
    }
  }

  /** Re-read the bundle from the repo it was installed from.
   *
   *  The address is the one recorded at install time — the same three arguments
   *  an install takes — so an update re-fetches the exact sub-folder and ref the
   *  user originally chose instead of guessing at a repo root. */
  const reinstall = async (p: PluginInfo) => {
    if (!p.source_repo) return
    setBusy(p.slug)
    const out = await installPlugin({
      repo: p.source_repo,
      ...(p.source_path ? { repo_path: p.source_path } : {}),
      ...(p.source_ref ? { repo_ref: p.source_ref } : {}),
      // Keep the SAME bundle: without the name/slug the reinstall would derive
      // a repo-named slug and create a second bundle beside the original.
      name: p.name,
      slug: p.slug,
      // Re-read the same subset the row selected, not every skill in the repo.
      ...(p.source_skills?.length ? { skills: p.source_skills } : {}),
    })
    setBusy('')
    if ('error' in out) {
      setError(out.error)
      return
    }
    setError('')
    await refresh()
    // A refresh can add, rename or drop skills, so the composer's command list
    // and every skill cache have to be rebuilt — same as a fresh install.
    invalidateSkillsList()
    invalidateAvailableSkills()
    window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
  }

  return (
    <div className="field">
      <div className="field-head">
        <label>
          Plugins
          {plugins !== null ? <span className="pm-count">{plugins.length}</span> : null}
        </label>
        <button className="btn tiny" onClick={() => void refresh()} disabled={busy !== ''}>
          Refresh
        </button>
      </div>
      <div className="hint">
        One switch per bundle: off pulls its skills and connectors from the catalog,
        nothing is deleted. Create: <code>/plugin &lt;description&gt;</code>
      </div>
      {/* Catalog budget sits ABOVE the grid: it scales every bundle's footprint,
          and a number alone under a pile of cards read as leftover. */}
      <div className="panel-card">
        <div className="field-head">
          <label>Catalog budget</label>
          <span className="field-value-badge">{skillCatalogMaxChars} chars</span>
        </div>
        <div className="hint">
          Catalog characters that ride in the system prompt every turn
          (~4 chars ≈ 1 token). Default 6000.
        </div>
        <div className="settings-row-control">
          <input
            type="number"
            min={1500}
            max={12000}
            step={500}
            value={skillCatalogMaxChars}
            onChange={(e) => setSkillCatalogMaxChars(Number(e.target.value))}
            dir="ltr"
            aria-label="Skill catalog budget in characters"
          />
          <span className="field-unit">chars</span>
          <span className="field-unit">
            ≈ {Math.round(skillCatalogMaxChars / 4).toLocaleString()} tokens per turn
          </span>
        </div>
      </div>
      {error ? <div className="hint error-text">{error}</div> : null}
      {plugins !== null && plugins.length > 4 ? (
        <div className="settings-search">
          <input
            type="search"
            value={pluginFilter}
            onChange={(e) => setPluginFilter(e.target.value)}
            placeholder="Search plugins…"
            dir="ltr"
          />
        </div>
      ) : null}
      {plugins === null ? (
        <div className="hint empty-state">Loading…</div>
      ) : filteredPlugins.length === 0 ? (
        <div className="hint empty-state">No plugin matches.</div>
      ) : (
        <div className="settings-grid">
          {visiblePlugins.map((p) => (
            <div key={p.slug} className={`pm-card${p.enabled ? '' : ' pm-card--off'}`}>
              <div className="pm-card-head">
                <span
                  className="pm-avatar"
                  style={{ '--h': providerHue(p.name) } as CSSProperties}
                  aria-hidden="true"
                >
                  {(p.name.trim()[0] ?? '?').toUpperCase()}
                </span>
                <div className="pm-card-title">
                  <span className="pm-card-name" title={p.name}>{p.name}</span>
                  <span className="pm-card-state">{p.enabled ? 'Active' : 'Off'}</span>
                </div>
                {/* A real on/off switch, not a checkbox: the state is a power
                    toggle for the whole bundle, so it reads as one. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.enabled}
                  aria-label={`${p.enabled ? 'Turn off' : 'Turn on'} ${p.name}`}
                  disabled={busy === p.slug}
                  className={`pm-switch${p.enabled ? ' on' : ''}`}
                  onClick={() => void flip(p)}
                >
                  <span className="pm-switch-knob" />
                </button>
              </div>
              {p.description ? <div className="pm-card-desc">{p.description}</div> : null}
              {/* The one-glance census of this bundle: how much of EACH part it
                  carries — the same six the detail page tabs break down. A zero
                  is information too: it says this bundle brings no connectors,
                  so the model gets no MCP tools from it. */}
              <div className="pm-meta">
                {(
                  [
                    ['skill', 'skills', p.skills],
                    ['cmd', 'cmd', p.commands],
                    ['agent', 'agents', p.agents],
                    ['MCP', 'MCP', p.mcp],
                    ['script', 'scripts', p.scripts],
                    ['hook', 'hooks', p.hooks],
                  ] as const
                ).map(([one, many, arr]) => {
                  const n = (arr ?? []).length
                  return (
                    <span key={many} className={`pm-meta-item${n === 0 ? ' zero' : ''}`}>
                      <b>{n}</b>
                      {n === 1 ? one : many}
                    </span>
                  )
                })}
              </div>
              {/* One way in, not an expander: what a bundle CONTAINS is a page
                  of its own — an inline `<details>` turned the grid card into a
                  column three screens tall. The census row above already carries
                  the counts, so this row is only the action. */}
              <button
                type="button"
                className="pm-card-open"
                onClick={() => setDetail(p)}
              >
                <span>View details</span>
                <span className="pm-card-open-hint">
                  {(() => {
                    const n =
                      (p.skills ?? []).length +
                      (p.commands ?? []).length +
                      (p.agents ?? []).length +
                      (p.mcp ?? []).length +
                      (p.scripts ?? []).length +
                      (p.hooks ?? []).length
                    return n === 1 ? '1 item' : `${n} items`
                  })()}
                </span>
                <span className="pd-chevron" aria-hidden="true">
                  ▶
                </span>
              </button>
              <div className="pm-card-actions">
                {p.source_repo ? (
                  <button
                    className="btn tiny secondary"
                    disabled={busy === p.slug}
                    title={`Re-read ${p.source ?? p.source_repo}`}
                    onClick={() => void reinstall(p)}
                  >
                    Update
                  </button>
                ) : null}
                <button
                  className="btn tiny secondary pm-danger"
                  disabled={busy === p.slug}
                  onClick={() => void remove(p)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {grid.hasMore ? (
        <div className="settings-grid-more" ref={grid.sentinelRef}>
          <button className="btn secondary" onClick={grid.loadMore}>
            Show more ({grid.remaining} left)
          </button>
        </div>
      ) : null}
      {detail ? (
        <PluginDetail
          plugin={detail}
          onClose={() => setDetail(null)}
          onChanged={refresh}
          onDelete={() => {
            const target = detail
            setDetail(null)
            if (target) void remove(target)
          }}
        />
      ) : null}
    </div>
  )
}


/** Settings → Plugins: web-search engine priority. */
export function PluginEditor() {
  const searchPlugins = useStore((s) => s.searchPlugins)
  const setSearchPlugins = useStore((s) => s.setSearchPlugins)
  // ONE number drives both halves of a search: how many results come back and
  // how many of them get their page fetched. Lives here (not Storage) because
  // it is the cost knob of the web engines listed below.
  const webSearchAutoFetch = useStore((s) => s.webSearchAutoFetch ?? 5)
  const setWebSearchAutoFetch = useStore((s) => s.setWebSearchAutoFetch)

  const plugins: SearchPluginConfig[] = searchPlugins.length > 0
    ? searchPlugins
    : [{ kind: 'duckduckgo', label: 'DuckDuckGo', enabled: true, order: 0 }]

  // Drag-to-reorder replaces the up/down arrows: the top engine is the
  // primary, so a drop above row 1 promotes its target. Renumber `order`
  // after every move so the stored list never carries stale positions.
  const { dragIndex, shiftStyle, handleProps, rowProps } = useDragReorder(
    'web-engines',
    plugins.length,
    (from, insertAt) => {
      const next = moveAt(plugins, from, insertAt).map((p, i) => ({ ...p, order: i }))
      setSearchPlugins(next)
    },
  )

  const toggle = (index: number, enabled: boolean) => {
    setSearchPlugins(plugins.map((p, i) => (i === index ? { ...p, enabled } : p)))
  }

  const patch = (index: number, partial: Partial<SearchPluginConfig>) => {
    setSearchPlugins(plugins.map((p, i) => (i === index ? { ...p, ...partial } : p)))
  }

  const addEngine = (kind: SearchPluginKind) => {
    if (plugins.some((p) => p.kind === kind)) return
    const meta = SEARCH_ENGINE_KINDS.find((k) => k.kind === kind)
    setSearchPlugins([
      ...plugins.map((p) => ({ ...p })),
      { kind, label: meta?.label ?? kind, enabled: true, order: plugins.length } as SearchPluginConfig,
    ])
  }

  const removeEngine = (index: number) => {
    setSearchPlugins(plugins.filter((_, i) => i !== index).map((p, i) => ({ ...p, order: i })))
  }

  return (
    <>
      <div className="panel-card">
        <div className="panel-card-head">
          <span className="panel-card-title">Search engines</span>
          <span className="panel-card-desc">
            The top engine is the <strong>primary</strong>; the ones below are
            tried in order as fallbacks until one returns results. DuckDuckGo
            needs no API key, and a disabled engine is never used.
          </span>
        </div>
        <div className="plugin-list">
          {plugins.map((p, i) => {
            const meta = SEARCH_ENGINE_KINDS.find((k) => k.kind === p.kind)
            return (
              <div
                className={`plugin-row${p.enabled ? '' : ' off'}${
                  dragIndex !== null ? ' dnd-shifting' : ''
                }${dragIndex === i ? ' dnd-dragging' : ''}`}
                key={p.kind}
                data-drag-row
                {...rowProps(i)}
                style={shiftStyle(i)}
              >
                <div className="plugin-row-head">
                  <span className="dnd-grip" title="Drag to reorder" {...handleProps(i)}>
                    <GripDots />
                  </span>
                  <span className="plugin-kind">{p.label}</span>
                  {i === 0 ? (
                    <span className="plugin-badge primary">Primary</span>
                  ) : (
                    <span className="plugin-badge">Fallback #{i}</span>
                  )}
                  <span className="plugin-role-hint">
                    {p.enabled ? (i === 0 ? 'used first' : 'tried next') : 'disabled'}
                  </span>
                  <span className="plugin-spacer" />
                  <button
                    className="btn tiny icon danger plugin-remove"
                    title="Remove"
                    onClick={() => removeEngine(i)}
                  >
                    ×
                  </button>
                  <label className="plugin-switch" title={p.enabled ? 'Disable' : 'Enable'}>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => toggle(i, e.target.checked)}
                    />
                    <span className="plugin-switch-track" />
                  </label>
                </div>
                {meta?.needsKey && p.enabled && (
                  <div className="plugin-fields">
                    <label className="field-label">API key</label>
                    <input
                      value={p.apiKey ?? ''}
                      onChange={(e) => patch(i, { apiKey: e.target.value })}
                      placeholder={`${p.label} API key`}
                      dir="ltr"
                      type="password"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="skill-actions">
          {SEARCH_ENGINE_KINDS.filter((k) => k.kind !== 'duckduckgo' && !plugins.some((p) => p.kind === k.kind)).map((k) => (
            <button key={k.kind} className="btn tiny" onClick={() => addEngine(k.kind)}>
              + Add {k.label}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 12 }}>
          Tavily uses a plain API key. Search Console (site analytics) uses the Google account signed in
          under Settings → Auth automatically, and DuckDuckGo needs no key.
        </div>
      </div>
      <div className="panel-card">
        <div className="panel-card-head">
          <span className="panel-card-title">Results per search</span>
          <span className="panel-card-desc">
            How many results <b>web_search</b> returns, and how many of them get
            their <b>real page content</b> fetched before the distiller reads
            them. <code>0</code> keeps results but skips the fetch. Range{' '}
            <code>0</code>–<code>10</code>. Default: <code>5</code>.
          </span>
        </div>
        <div className="settings-row-control">
          <input
            type="number"
            min={0}
            max={10}
            value={webSearchAutoFetch}
            onChange={(e) => setWebSearchAutoFetch(Number(e.target.value))}
            dir="ltr"
            aria-label="Web search results and auto-fetch count"
          />
          <span className="field-unit">results</span>
        </div>
      </div>
    </>
  )
}

/**
 * فچ دستی لیست مدل‌های پروایدر (دکمه‌ی «Fetch models» در تب Providers) — همان
 * مسیر استارت‌آپ: کاتالوگ زنده‌ی /models معیار قطعی است (مدل حذف/تغییرنام‌شده
 * از لیست می‌رود)، مدل انتخابی stale ترمیم می‌شود و چت‌ها heal می‌شوند؛ بعد از
 * موفقیت، callback تازه‌کردنِ مدل انتخابیِ فرم (cfg.model) اجرا می‌شود. جدا از
 * کامپوننت تا بدون DOM قابل تست باشد — کامپوننت فقط callback های state خود را
 * می‌دهد و پیام نتیجه (تعداد مدل / دلیل skip / خطا) را زیر دکمه نشان می‌دهد.
 */
