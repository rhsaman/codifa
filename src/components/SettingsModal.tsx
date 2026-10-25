import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MarketplaceKind, McpServerConfig, McpTransport, ProviderConfig, ProviderKind, SearchConsoleConfig, SearchPluginConfig, SearchPluginKind, ThinkingLevel, ToolFallback } from '../types'
import type { MarketplaceSource, PluginInfo } from '../types'
import { useStore, flushStateNow, providerApiKeys, DEFAULT_MARKETPLACES } from '../lib/store'
import { getSkillFile, listMcp, listSkills, syncSkill } from '../lib/api'
import {
  deletePlugin,
  installPlugin,
  listMarketplace,
  listPluginConnectors,
  listPlugins,
  listPluginSkills,
  togglePlugin,
  updatePlugin,
} from '../lib/plugins'
import { fillKeywordsAfterInstall } from '../lib/keywordFill'
import { paginate, PAGE_SIZE } from '../lib/paging'
import { useInfiniteGrid } from '../lib/useInfiniteGrid'
import type { MarketplaceEntry, MarketplaceIndex, PluginConnectorRow } from '../lib/plugins'
import { PluginDetail } from './PluginDetail'
import { fetchAndPersist } from '../lib/provider-fetch'
import { invalidateAvailableSkills, invalidateSkillsList, forgetPluginCommands } from '../lib/skills'
import { api } from '../lib/fs'
import { allModes } from '../lib/modes'
import { PROVIDER_META, accountScopedBaseUrl, isAccountScoped, providerMeta } from '../lib/provider-meta'
import { ModeIcon } from './ModeIcon'
import { THEMES } from '../lib/themes'
import {
  DEFAULT_TERMINAL_SHELL,
  SHELL_CHOICES,
  shellLabel,
} from '../lib/nvimTerminals'
import { RangeSlider } from './RangeSlider'
import { ProviderModelSelect } from './ProviderModelSelect'
import { supportsReasoning } from '../lib/thinking'
import { STT_LANGUAGES } from '../lib/stt'
import { OTHER_SLOTS, moveFallback, otherSlotFallbacks, otherSlotLevel, otherSlotModel, resolveSlotEntry, splitSlotEntry, toolChainRows, toolChainSet, toolFallbackToModel, toolFallbackValue } from '../lib/toolSlots'
import { modelReasoning } from '../lib/context'
import {
  THINKING_OPTIONS,
  THINKING_LABELS,
  canonThinkingLevel,
} from '../lib/thinking-options'

const BUILTIN_KINDS: ProviderKind[] = Object.values(PROVIDER_META)
  .filter((m) => m.builtin)
  .map((m) => m.kind)
const NEW_SKILL_KEY = '__new_skill__'

/** Row key for a skill: a plugin's skills are scoped by their bundle, because
 *  two bundles (or a bundle and the user's own store) may ship the same name. */
function skillKey(pluginSlug: string, name: string): string {
  return pluginSlug ? `${pluginSlug}::${name}` : name
}

/** بررسی می‌کنه آیا یک پروایدر تنظیم شده (حداقل یک کلید API دارد). */
function isProviderConfigured(p: ProviderConfig): boolean {
  if (providerMeta(p.kind).local) return true
  return providerApiKeys(p).length > 0
}

// `current` is stored as "providerId/model" (route through that provider).
// Legacy values may still be a bare model id, a kind-prefixed id ("custom/…")
// or a doubled prefix — resolve a readable label in every case. The label
// shows the provider's DISPLAY NAME (like the composer picker), never the
// raw provider id / kind ("custom-xyz/model" → "My Provider/model").
export function toolModelLabel(current: string, providers: ReadonlyArray<ProviderConfig>): string {
  if (!current) return 'Main model'
  const { providerId, model } = resolveSlotEntry(current, providers)
  const p = providerId ? providers.find((x) => x.id === providerId) : undefined
  if (!p) return current
  // Collapse a doubled prefix from a previously saved value
  // ("providerId/providerId/model") before labelling.
  const modelPart = model.startsWith(`${p.id}/`) ? model.slice(p.id.length + 1) : model
  return `${p.name}/${modelPart}`
}

/** Resolve a stored subagent value to the ONE picker row the backend really
 *  routes it through — the targeting counterpart of `toolModelLabel`.
 *  Returns null when no row corresponds (empty value, "main model" sentinel,
 *  unknown provider prefix). Legacy shapes resolve exactly like the backend
 *  resolver: "providerId/model" → that provider (id first, then the legacy
 *  "custom" kind), a bare model id → the ACTIVE provider. Comparing this
 *  resolved target — instead of a stripped model name — is what keeps
 *  same-named models under OTHER providers from lighting up as active. */
export function toolModelTarget(
  current: string,
  providers: ReadonlyArray<ProviderConfig>,
  activeProviderId: string,
): { providerId: string; model: string } | null {
  if (!current) return null
  if (current === 'main model' || current === 'main_model' || current === 'main') return null
  const { providerId, model, unowned } = resolveSlotEntry(current, providers)
  // A slash-bearing entry no row can claim belongs to a provider we do not
  // have: no row may light up, which is what `null` means here.
  if (unowned) return null
  const p = providerId ? providers.find((x) => x.id === providerId) : undefined
  const model2 = p && model.startsWith(`${p.id}/`) ? model.slice(p.id.length + 1) : model
  // A bare model id belongs to the provider whose catalog lists it; only when
  // no catalog answers does the ACTIVE provider stand in. Attributing it to the
  // active provider unconditionally is what made a multi-vendor model
  // (`oc/deepseek-…`) look like it lived on the chat's provider.
  return { providerId: providerId || activeProviderId, model: model2 }
}

/** The "main model" a Tool slot inherits when it has no explicit override:
 *  the ACTIVE chat's effective provider/model — exactly what the composer is
 *  showing. Read reactively so the Settings rows follow a per-chat switch. */
function useMainModel(): { providerId: string; model: string } {
  const activeChatId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const providers = useStore((s) => s.settings.providers)
  const activeProviderId = useStore((s) => s.settings.activeProviderId)
  const ch = chats.find((c) => c.id === activeChatId)
  const p =
    providers.find((x) => x.id === (ch?.providerId ?? activeProviderId)) ?? providers[0]
  return { providerId: p?.id ?? '', model: ch?.model ?? p?.model ?? '' }
}

/** Per-tool Settings card: a group head naming the tool and its purpose, then a
 *  row per setting — the composer's own model picker (controlled, so it never
 *  touches the active chat), the slot's own reasoning-effort bar, and the
 *  ordered list of fallback models that only this tool may fall back on. */
function ToolSlotRow({
  agent,
  label,
  desc,
  model,
  level,
  onSelectModel,
  onSelectLevel,
  fallbacks,
  onFallbacks,
}: {
  agent: string
  label: string
  desc: string
  model: string
  level: ThinkingLevel
  onSelectModel: (agent: string, model: string) => void
  onSelectLevel: (agent: string, level: ThinkingLevel) => void
  /** Ordered fallback models for THIS tool (empty = the tool only runs its own
   *  model). A fallback inherits the row's reasoning level, so it has no effort
   *  control of its own. */
  fallbacks?: ToolFallback[]
  onFallbacks?: (rows: ToolFallback[]) => void
}) {
  const providers = useStore((s) => s.settings.providers)
  const activeProviderId = useStore((s) => s.settings.activeProviderId)
  const main = useMainModel()
  const target = toolModelTarget(model, providers, activeProviderId)
  const targetProvider = target
    ? providers.find((p) => p.id === target.providerId) ?? null
    : null
  // With no explicit model the slot runs the main model; the picker is given
  // the RAW stored value so an inherited row reads "Main model" on its button
  // (instead of pretending the main model was picked explicitly). `main` is
  // still used for the reasoning check below.
  const effProvider =
    targetProvider ??
    providers.find((p) => p.id === (target?.providerId ?? main.providerId)) ??
    providers.find((p) => p.id === activeProviderId) ??
    null
  const effModel = target?.model ?? main.model ?? ''
  // Only used to annotate the slider — the slider itself is ALWAYS rendered so
  // a slot's reasoning level is never unreachable behind a detection result.
  const reasoning = effProvider
    ? modelReasoning(effProvider, effModel) ?? supportsReasoning(effModel, effProvider.kind)
    : false
  return (
    <div
      className="slot-card"
      data-agent={agent}
      data-reasoning={reasoning ? 'on' : 'off'}
    >
      <div className="slot-card-head">
        <span className="slot-card-title">{label}</span>
        <span className="slot-card-desc">{desc}</span>
      </div>

      {/* ONE list of two FIXED columns: the picker starts at the same x on every
          row of every card, which is what makes four cards read as one table
          instead of four unrelated forms. */}
      {onFallbacks && (
        <>
          {/* The effort bar governs the WHOLE list (a fallback inherits it), so
              it sits above the rows instead of inside one of them. */}
          <div className="slot-card-effort slot-chain-effort">
            {/* Codex-style progress bar: it fills up to the chosen level and is
                click/drag steppable — no popup menu. */}
            <ThinkingBar
              label={label}
              level={level}
              onSelect={(lv) => onSelectLevel(agent, lv)}
            />
          </div>
          <div className="slot-card-sub">
            <span className="slot-card-sub-title">Models</span>
            <span className="slot-card-sub-hint">
              tried top to bottom — row 1 is this tool's own model
            </span>
          </div>
          <FallbackRows
            label={label}
            own={model}
            onOwn={(v) => onSelectModel(agent, v)}
            rows={fallbacks ?? []}
            onChange={onFallbacks}
          />
        </>
      )}
    </div>
  )
}

/** Horizontal, slider-like reasoning-effort control. Levels are DISCRETE
 *  (Default / None / Low / Medium / High / XHigh / Max) so the bar shows one
 *  pip per level; the fill and the draggable thumb snap to the nearest pip.
 *  Clicking a pip picks that level, dragging scrubs through them — the
 *  Codex-style affordance the user asked for instead of a popup menu. */
function ThinkingBar({
  label,
  level,
  onSelect,
}: {
  label: string
  level: ThinkingLevel
  onSelect: (level: ThinkingLevel) => void
}) {
  // Legacy stored values (e.g. 'max') fold onto the canonical list, and the
  // bar itself has NO default step: unset exactly equals None.
  const steps = THINKING_OPTIONS
  const canonLevel = canonThinkingLevel(level)
  const idx = Math.max(
    0,
    steps.findIndex(([v]) => v === canonLevel),
  )
  const max = steps.length - 1
  const pct = max > 0 ? (idx / max) * 100 : 0
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  // Map a client X to the nearest discrete level and report it. Used for both
  // click and drag so the whole track is a hit target (no tiny pip to hit).
  const pickAt = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const nextIdx = Math.round(ratio * max)
    const next = steps[nextIdx][0]
    if (next !== level) onSelect(next)
  }

  useEffect(() => {
    if (!dragging) return
    function onMove(e: MouseEvent) {
      pickAt(e.clientX)
    }
    function onUp() {
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, level])

  const stepIdx = (delta: number) => {
    const next = Math.max(0, Math.min(max, idx + delta))
    if (next !== idx) onSelect(steps[next][0])
  }

  return (
    <div className="thinking-bar" data-level={level || 'default'}>
      <div
        className="thinking-bar-track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={`Reasoning effort for ${label}`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={idx}
        aria-valuetext={THINKING_LABELS[canonLevel] ?? 'None'}
        onMouseDown={(e) => {
          setDragging(true)
          pickAt(e.clientX)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault()
            stepIdx(1)
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault()
            stepIdx(-1)
          } else if (e.key === 'Home') {
            e.preventDefault()
            onSelect(steps[0][0])
          } else if (e.key === 'End') {
            e.preventDefault()
            onSelect(steps[max][0])
          }
        }}
      >
        <div className="thinking-bar-fill" style={{ width: `${pct}%` }} />
        <div className="thinking-bar-thumb" style={{ left: `${pct}%` }} />
        <div className="thinking-bar-pips" aria-hidden="true">
          {steps.map(([v], i) => (
            <span
              key={v || 'default'}
              className={`thinking-bar-pip${i <= idx ? ' filled' : ''}`}
              style={{ left: `${max > 0 ? (i / max) * 100 : 0}%` }}
            />
          ))}
        </div>
      </div>
      <span className="thinking-bar-label">
        {THINKING_LABELS[canonLevel] ?? 'None'}
      </span>
    </div>
  )
}

const SEARCH_ENGINE_KINDS: Array<{ kind: SearchPluginKind; label: string; needsKey: boolean }> = [
  { kind: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
  { kind: 'tavily', label: 'Tavily', needsKey: true },
]

/** The catalogue kinds a marketplace may declare. Every ROW installs a plugin
 *  regardless of its kind, so the kind is only stored provenance. */
/** How many cards the infinite scroll reveals per batch. A few pages of a
 *  1.5MB index stay cheap; the rest arrives as the user scrolls. */
const CARD_BATCH = 24

/** A marketplace's stable id — its install address, not its display label. */
function marketKey(repo: string, path?: string, gitRef?: string): string {
  return `${repo}|${path ?? ''}|${gitRef ?? ''}`
}

/** Settings → Marketplaces: the plugin catalogues the user subscribes to.
 *
 *  An index is a plain JSON file in a git repo (Claude's `marketplace.json`),
 *  so "adding a marketplace" is just naming a repo. Browsing one writes nothing
 *  — a row installs through the SAME `installPlugin` the `/plugin install`
 *  command uses, which is why a listed plugin and a typed repo cannot diverge.
 */
function MarketplaceEditor() {
  const marketplaces = useStore((s) => s.marketplaces ?? [])
  const setMarketplaces = useStore((s) => s.setMarketplaces)

  const [repo, setRepo] = useState('')
  const [label, setLabel] = useState('')
  const [showAdd, setShowAdd] = useState(false)
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
  const [busy, setBusy] = useState('')

  /** Which rows are already here, so a browsed plugin can say so and the button
   *  reads "Update". Matched by the ADDRESS it was installed from, not by name:
   *  two marketplaces may list the same plugin under different names. */
  const refreshInstalled = useCallback(async () => {
    const out = await listPlugins()
    if (Array.isArray(out)) setInstalled(out)
  }, [])

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
  // the chip's click, or Refresh, retries it.
  const kindMarkets = marketplaces
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
    let addr = repo.trim()
    if (!addr) return
    // One string carries everything: `owner/repo@ref/sub-path`. The ref ends at
    // the first `/` AFTER the `@` (tags may hold slashes); the rest is the sub.
    let refPart = ''
    let subPart = ''
    const at = addr.indexOf('@')
    if (at > 0 && !addr.startsWith('/')) {
      const tail = addr.slice(at + 1)
      const slash = tail.indexOf('/')
      refPart = slash === -1 ? tail : tail.slice(0, slash)
      if (slash !== -1) subPart = tail.slice(slash + 1)
      addr = addr.slice(0, at)
    }
    const source: MarketplaceSource = {
      repo: addr,
      kind: 'plugins',
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(subPart.trim() ? { path: subPart.trim() } : {}),
      ...(refPart.trim() ? { git_ref: refPart.trim() } : {}),
    }
    const key = marketKey(source.repo, source.path, source.git_ref)
    if (!marketplaces.some((m) => marketKey(m.repo, m.path, m.git_ref) === key)) {
      setMarketplaces([...marketplaces, source])
    }
    setRepo('')
    setLabel('')
    setLabel('')
    setShowAdd(false)
    void loadIndex(source)
  }

  const remove = (m: MarketplaceSource) => {
    if (!window.confirm(`Remove marketplace "${m.label ?? m.repo}"? Installed plugins stay.`)) return
    const key = marketKey(m.repo, m.path, m.git_ref)
    setMarketplaces(
      marketplaces.filter((x) => marketKey(x.repo, x.path, x.git_ref) !== key),
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
    setBusy(key)
    setError('')
    const out = await installPlugin({
      repo: entry.repo,
      ...(entry.repo_path ? { repo_path: entry.repo_path } : {}),
      ...(entry.repo_ref ? { repo_ref: entry.repo_ref } : {}),
      // No `kind` is sent: the row decides. A repo with ONE skill and no
      // manifest becomes a single-skill bundle, a connector-only row a
      // single-connector one, and a real bundle stays a bundle — so every row
      // lands somewhere a user can switch it on and off.
      // Passed through so an English-only bundle still lands with Persian
      // trigger phrases: the backend seeds fa_keywords from the category when
      // neither the repo nor a previous install carries any.
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    })
    setBusy('')
    if ('error' in out) {
      setError(`${entry.name}: ${out.error}`)
      return
    }
    const keywords = (out.plugin?.fa_keywords ?? []).length
    setNote(
      `${out.installed === 'updated' ? 'Updated' : 'Installed'} ${out.plugin?.name ?? entry.name} — ` +
        `${(out.skills ?? []).length} skills, ${(out.mcp ?? []).length} connectors` +
        (keywords === 0
          ? '. The Persian phrases for its skills are being written from their descriptions.'
          : `, ${keywords} Persian keywords.`),
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
    // A bundle whose skills shipped keyword-free is unreachable from a Persian
    // request, so the phrases are written now instead of waiting for its owner
    // to find the detail page. Fire-and-forget: the install already succeeded,
    // and a failed translation only amends the note.
    void fillKeywordsAfterInstall(out.slug).then((fill) => {
      if (fill.total === 0) return
      if (fill.error) {
        setNote((prev) => `${prev} Keywords were not filled: ${fill.error}`)
        return
      }
      if (fill.filled > 0) {
        invalidateSkillsList()
        invalidateAvailableSkills()
        window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
        setNote((prev) => `${prev} Filled Persian keywords for ${fill.filled} skill(s).`)
      }
    })
  }

  const installedKeys = new Set(
    installed.map((p) => marketKey(p.source_repo ?? '', p.source_path, p.source_ref)),
  )
  const loading = loadingKeys.length > 0
  // Merge EVERY marketplace of the kind into one list, deduped by install
  // address: the same plugin advertised by two repos shows once.
  const seen = new Set<string>()
  const allEntries = kindMarkets.flatMap(
    (m) => indexes[marketKey(m.repo, m.path, m.git_ref)]?.plugins ?? [],
  )
  const q = filter.trim().toLowerCase()
  const matches = allEntries.filter((e) => {
    const key = marketKey(e.repo, e.repo_path, e.repo_ref)
    if (seen.has(key)) return false
    seen.add(key)
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
        <div className="hint">
          A marketplace is a repo holding an index
          (<code>.claude-plugin/marketplace.json</code>). Browsing is read-only:
          nothing installs until you press Install on a card.
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
          <div className="market-tabs" role="tablist">
            {marketplaces
              .map((m) => {
              const key = marketKey(m.repo, m.path, m.git_ref)
              const name = m.label ?? m.repo
              return (
                <span key={key} className="market-tab">
                  <button
                    className="market-tab-name"
                    onClick={() => void loadIndex(m, true)}
                    title={`Reload ${m.repo}${m.path ? ` · ${m.path}` : ''}${m.git_ref ? ` @ ${m.git_ref}` : ''}`}
                  >
                    {name}
                  </button>
                  <button
                    className="market-tab-x"
                    aria-label={`Remove ${name}`}
                    title="Remove this marketplace — plugins already installed stay"
                    onClick={() => remove(m)}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
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

      {error ? <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div> : null}
      {note ? <div className="hint">{note}</div> : null}

      {/* The body renders even with NO marketplace: the search box and the
          guidance used to be nested inside the "has a source" branch, so a
          catalogue that failed to load left nowhere to type. */}
      <div className="field">
          <div className="field-head">
            <label>All plugins from every marketplace</label>
            <span className="plugin-spacer" />
            <button
              className="btn tiny secondary"
              disabled={loading}
              onClick={() => kindMarkets.forEach((m) => void loadIndex(m, true))}
              title="Reread every index from GitHub instead of the saved copies"
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
            ) : (
              <div className="hint">Nothing matches.</div>
            )
          ) : (
            <>
              <div className="market-grid">
                {shown.map((entry) => {
                  const key = marketKey(entry.repo, entry.repo_path, entry.repo_ref)
                  const have = installedKeys.has(key)
                  return (
                    <div key={key} className="market-card">
                      <div className="market-card-head">
                        <span className="market-card-name" dir="ltr">{entry.name}</span>
                        <button
                          className={`btn tiny ${have ? 'secondary' : ''}`}
                          disabled={busy === key}
                          onClick={() => void install(entry)}
                        >
                          {busy === key ? 'Installing…' : have ? 'Update' : 'Install'}
                        </button>
                      </div>
                      {entry.description ? (
                        <div className="market-card-desc">{entry.description}</div>
                      ) : null}
                      {have ? <div className="market-card-installed">Installed</div> : null}
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
          description and Persian keywords there, switch it off, or press{' '}
          <b>Update from source</b> to pull it again.
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
function PluginBundleEditor() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [pluginFilter, setPluginFilter] = useState('')
  /** Outcome of the last update's keyword fill — the update itself already
   *  stands, so this is a note and never an error. */
  const [note, setNote] = useState('')

  /** Filter before paging: one query covers the name, its skills and its
   *  Persian keywords, so `/ترجمه` finds a bundle whose skills translate. */
  const filteredPlugins = (plugins ?? []).filter((p) => {
    const q = pluginFilter.trim().toLowerCase()
    if (!q) return true
    return (
      `${p.name} ${p.slug} ${p.description ?? ''} ${(p.skills ?? []).join(' ')} ${(p.fa_keywords ?? []).join(' ')}`
        .toLowerCase()
        .includes(q)
    )
  })
  const grid = useInfiniteGrid(filteredPlugins.length, `plugins:${pluginFilter}`)
  const visiblePlugins = filteredPlugins.slice(0, grid.visible)

  const [draftDesc, setDraftDesc] = useState<Record<string, string>>({})
  const [draftKeywords, setDraftKeywords] = useState<Record<string, string>>({})
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

  /** Save the two editable manifest fields of one plugin. An empty keyword field
   *  clears them (the backend drops an empty list), which is how a user removes
   *  an inherited trigger they do not want. */
  const saveMeta = async (p: PluginInfo, name: string, description: string) => {
    setBusy(p.slug)
    const out = await updatePlugin({
      slug: p.slug,
      name: name.trim() || p.name,
      description,
      fa_keywords: draftKeywords[p.slug] ?? p.fa_keywords ?? [],
    })
    setBusy('')
    if ('error' in out) setError(out.error)
    else {
      setError('')
      setPlugins((cur) => (cur ?? []).map((x) => (x.slug === out.slug ? out : x)))
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
    })
    setBusy('')
    if ('error' in out) {
      setError(out.error)
      return
    }
    setError('')
    setNote('')
    await refresh()
    // A refresh can add, rename or drop skills, so the composer's command list
    // and every skill cache have to be rebuilt — same as a fresh install.
    invalidateSkillsList()
    invalidateAvailableSkills()
    window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
    // Skills an update added (or that the source still ships keyword-free) get
    // their Persian phrases here, exactly like a fresh install.
    void fillKeywordsAfterInstall(out.slug).then((fill) => {
      if (fill.filled > 0) {
        invalidateSkillsList()
        invalidateAvailableSkills()
        window.dispatchEvent(new CustomEvent('coder:plugins-changed'))
      }
      // Never swallowed: the update itself stands, but a silent failure would
      // leave the bundle unreachable from a Persian request with no clue why.
      setNote(
        fill.filled > 0
          ? `Persian keywords filled for ${fill.filled} skill(s).`
          : fill.error
            ? `Persian keywords not filled: ${fill.error}`
            : '',
      )
    })
  }

  return (
    <div className="field">
      <div className="field-head">
        <label>Plugins</label>
        <button className="btn tiny" onClick={() => void refresh()} disabled={busy !== ''}>
          Refresh
        </button>
      </div>
      <div className="hint">
        A plugin bundles skills and MCP connectors behind one switch: turning it off removes
        its skills from the catalog and its connectors from the tools, without deleting anything.
        Create or edit one by typing <code>/plugin &lt;description&gt;</code> in the chat.
      </div>
      {error ? <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div> : null}
      {note ? <div className="hint">{note}</div> : null}
      {plugins !== null && plugins.length > 12 ? (
        <div className="settings-search">
          <input
            type="search"
            value={pluginFilter}
            onChange={(e) => setPluginFilter(e.target.value)}
            placeholder="Search plugins, skills, keywords…"
            dir="ltr"
          />
        </div>
      ) : null}
      {plugins === null ? (
        <div className="hint">Loading…</div>
      ) : filteredPlugins.length === 0 ? (
        <div className="hint">No plugin matches.</div>
      ) : (
        <div className="settings-grid">
          {visiblePlugins.map((p) => (
            <div key={p.slug} className={`pm-card${p.enabled ? '' : ' pm-card--off'}`}>
              {/* The edge rail IS the state: rose = live, gray = off. A status you
                  read without reading any chip or label. */}
              <span className="pm-rail" aria-hidden="true" />
              <div className="pm-card-head">
                <div className="pm-card-title">
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
                  <span className="pm-card-name">{p.name}</span>
                </div>
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
              {p.description ? <div className="pm-card-desc">{p.description}</div> : null}
              {/* The one-glance census of this bundle: how much of each part it
                  carries. A zero is information too — it says this bundle has
                  no connectors, so the model gets no MCP tools from it. */}
              <div className="pm-meta">
                <span className="pm-meta-item">
                  <b>{(p.skills ?? []).length}</b>
                  {(p.skills ?? []).length === 1 ? 'skill' : 'skills'}
                </span>
                <span className="pm-meta-item">
                  <b>{(p.mcp ?? []).length}</b>
                  MCP
                </span>
                <span className="pm-meta-item">
                  <b>{(p.scripts ?? []).length}</b>
                  {(p.scripts ?? []).length === 1 ? 'script' : 'scripts'}
                </span>
              </div>
              {(p.skills ?? []).length > 0 ? (
                <div className="pm-card-tags">
                  {(p.skills ?? []).slice(0, 4).map((name) => (
                    <code key={name} className="pm-tag">/{name}</code>
                  ))}
                  {(p.skills ?? []).length > 4 ? (
                    <span className="pm-tag pm-tag--more">+{(p.skills ?? []).length - 4}</span>
                  ) : null}
                </div>
              ) : null}
              {/* One way in, not an expander: what a bundle CONTAINS — its
                  skills, connectors and scripts with their descriptions and
                  Persian keywords — is a page of its own. An inline `<details>`
                  turned the grid card into a column three screens tall. */}
              <button
                type="button"
                className="pm-card-open"
                onClick={() => setDetail(p)}
              >
                <span>View details</span>
                <span className="pm-card-open-hint">
                  {(p.skills ?? []).length} skills · {(p.mcp ?? []).length} connectors ·{' '}
                  {(p.scripts ?? []).length} scripts
                </span>
                <span className="pd-chevron" aria-hidden="true">
                  ▶
                </span>
              </button>
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
        />
      ) : null}
    </div>
  )
}


/** Settings → Plugins: web-search engine priority. */
function PluginEditor() {
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

  const move = (index: number, dir: -1 | 1) => {
    const next = [...plugins]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    const [a, b] = [next[index], next[target]]
    next[index] = { ...b, order: index }
    next[target] = { ...a, order: target }
    setSearchPlugins(next)
  }

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
              <div className={`plugin-row${p.enabled ? '' : ' off'}`} key={p.kind}>
                <div className="plugin-row-head">
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
                  <span className="plugin-arrows">
                    <button
                      className="btn tiny icon"
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="btn tiny icon"
                      title="Move down"
                      disabled={i === plugins.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="btn tiny icon danger"
                      title="Remove"
                      onClick={() => removeEngine(i)}
                    >
                      ×
                    </button>
                  </span>
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
export async function fetchProviderModels(
  cfg: ProviderConfig,
  ctl: {
    setFetching: (busy: boolean) => void
    setMsg: (msg: string) => void
    /** تازه‌کردن مدل انتخابی فرم بعد از موفقیت فچ. */
    refreshFormModel: () => void
    /** نتیجه‌ی در پرواز بعد از تعویض پروایدر باید دور ریخته شود. */
    stale?: () => boolean
  },
): Promise<void> {
  ctl.setFetching(true)
  ctl.setMsg('')
  try {
    const r = await fetchAndPersist(cfg)
    if (ctl.stale?.()) return
    if (!r.ok) {
      ctl.setMsg(
        'skipped' in r
          ? r.reason === 'disabled'
            ? 'Fetch skipped — the provider is disabled.'
            : isAccountScoped(cfg.kind)
              ? 'Fetch skipped — enter the account id first.'
              : 'Fetch skipped — set a base URL first.'
          : `Fetch failed: ${r.error}`,
      )
      return
    }
    ctl.refreshFormModel()
    ctl.setMsg(
      r.count === 0 ? 'No models returned by the provider.' : `Fetched ${r.count} model${r.count === 1 ? '' : 's'} ✓`,
    )
  } finally {
    if (!ctl.stale?.()) ctl.setFetching(false)
  }
}

/** Ordered per-tool fallback list (Settings → Tools): the models a tool falls
 *  back on, top to bottom. Row 1 is the tool's OWN model and every row below
 *  it is tried after that one; the list order IS the try order, which is why
 *  row 1 carries the same reorder buttons as the rest — moving a model into
 *  row 1 is exactly how it becomes the tool's model. Each row is the
 *  composer's own model picker, so a rung may live on another provider, and a
 *  row naming nothing means "the composer's model". Only the CURRENT call walks
 *  the list; the next call starts at row 1 again. */
function FallbackRows({
  label,
  own,
  onOwn,
  rows,
  onChange,
}: {
  label: string
  /** The tool's OWN model (rung 1). `''` = whatever the composer is running. */
  own: string
  onOwn: (model: string) => void
  rows: ToolFallback[]
  onChange: (rows: ToolFallback[]) => void
}) {
  const providers = useStore((s) => s.settings.providers)
  const activeProviderId = useStore((s) => s.settings.activeProviderId)
  // A new row starts on a REAL provider. The store drops rows that name only
  // half a target, so "+ Add" inserting a fully blank row committed nothing and
  // looked like a dead button. The model stays empty until the picker fills it
  // in, and a half-filled row never reaches the wire.
  const defaultProviderId =
    providers.find((p) => p.id === activeProviderId)?.id ?? providers[0]?.id ?? ''
  // ONE list drives both the tool's own model and its fallbacks, so row 1 can
  // be moved like any other rung. Writing back is the inverse: whatever ends up
  // in row 1 is the tool's model, the rest is its fallback list.
  const chain = toolChainRows(
    own,
    rows,
    new Set(providers.map((p) => p.id)),
  )
  const commit = (next: ToolFallback[]) => {
    const split = toolChainSet(next)
    if (split.own !== own) onOwn(split.own)
    if (!sameRows(split.fallbacks, rows)) onChange(split.fallbacks)
  }
  return (
    <div className="slot-fallbacks">
      {chain.map((fb, i) => {
        const isOwn = i === 0
        return (
          <div
            key={isOwn ? 'own' : i}
            className={`slot-fallback-row${isOwn ? ' slot-fallback-row-own' : ''}`}
          >
            {/* The position in the try order, so a long list stays readable at
                a glance. aria-hidden: the buttons already announce it. */}
            <span className="slot-fallback-order" aria-hidden="true">
              {i + 1}
            </span>
            <div className="slot-fallback-picker">
              <ProviderModelSelect
                value={isOwn ? own : toolFallbackValue(fb)}
                onSelect={(v) => {
                  // The picker reports "providerId/model". `''` is the
                  // composer's own model; any other value is split on a KNOWN
                  // provider id, so a lock-breaking model id (`oc/deepseek-…`)
                  // is kept whole instead of being cut in half.
                  const split = splitSlotEntry(v, new Set(providers.map((p) => p.id)))
                  const target: ToolFallback = !v
                    ? { providerId: '', model: '' }
                    : split.providerId
                      ? split
                      : { ...fb, model: split.model }
                  if (isOwn) {
                    onOwn(toolFallbackToModel(target))
                    return
                  }
                  commit(chain.map((r, j) => (j === i ? target : r)))
                }}
                noneLabel="Main model"
              />
            </div>
            <div className="slot-fallback-actions">
              <button
                type="button"
                className="icon-btn"
                title="Move up — tried earlier"
                aria-label={`Move ${label} model ${i + 1} up`}
                disabled={i === 0}
                onClick={() => commit(moveFallback(chain, i, -1))}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Move down — tried later"
                aria-label={`Move ${label} model ${i + 1} down`}
                disabled={i === chain.length - 1}
                onClick={() => commit(moveFallback(chain, i, 1))}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {/* Row 1 always exists: dropping the tool's model is done by
                  pointing it at the composer's model, not by deleting a row. */}
              {!isOwn && (
                <button
                  type="button"
                  className="icon-btn slot-fallback-remove"
                  title="Remove this model from the list"
                  aria-label={`Remove ${label} model ${i + 1}`}
                  onClick={() => commit(chain.filter((_, j) => j !== i))}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          </div>
        )
      })}
      <button
        type="button"
        className="slot-fallback-add"
        disabled={!defaultProviderId}
        title={
          defaultProviderId
            ? undefined
            : 'Add a provider first — a fallback must name one'
        }
        onClick={() => onChange([...rows, { providerId: defaultProviderId, model: '' }])}
      >
        + Add fallback
      </button>
    </div>
  )
}

/** Row-by-row equality, so a reorder that leaves one side untouched does not
 *  rewrite (and re-persist) it. */
function sameRows(a: ToolFallback[], b: ToolFallback[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.providerId === b[i].providerId && r.model === b[i].model)
  )
}
export function SettingsModal({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const settings = useStore((s) => s.settings)
  const updateProvider = useStore((s) => s.updateProvider)
  const addProvider = useStore((s) => s.addProvider)
  const removeProvider = useStore((s) => s.removeProvider)
  const addManualModel = useStore((s) => s.addManualModel)
  const setManualModelContext = useStore((s) => s.setManualModelContext)
  const setManualModelReasoning = useStore((s) => s.setManualModelReasoning)
  const removeManualModel = useStore((s) => s.removeManualModel)
  const setSystemPrompt = useStore((s) => s.setSystemPrompt)
  const removeMode = useStore((s) => s.removeMode)
  const fontSize = useStore((s) => s.fontSize)
  const setFontSize = useStore((s) => s.setFontSize)
  const viewerFontSize = useStore((s) => s.viewerFontSize)
  const setViewerFontSize = useStore((s) => s.setViewerFontSize)
  const terminalFontSize = useStore((s) => s.terminalFontSize)
  const setTerminalFontSize = useStore((s) => s.setTerminalFontSize)
  const dataPath = useStore((s) => s.dataPath)
  const setDataPath = useStore((s) => s.setDataPath)
  const sttProviderId = useStore((s) => s.sttProviderId)
  const sttModel = useStore((s) => s.sttModel)
  const setSttProviderId = useStore((s) => s.setSttProviderId)
  const setSttModel = useStore((s) => s.setSttModel)
  const sttFallbacks = useStore((s) => s.sttFallbacks)
  const setSttFallbacks = useStore((s) => s.setSttFallbacks)
  const sttLanguage = useStore((s) => s.sttLanguage)
  const setSttLanguage = useStore((s) => s.setSttLanguage)
  const sttPrompt = useStore((s) => s.sttPrompt)
  const setSttPrompt = useStore((s) => s.setSttPrompt)
  const liveProviderId = useStore((s) => s.liveProviderId)
  const setLiveProviderId = useStore((s) => s.setLiveProviderId)
  const liveModel = useStore((s) => s.liveModel)
  const setLiveModel = useStore((s) => s.setLiveModel)
  const liveVoice = useStore((s) => s.liveVoice)
  const setLiveVoice = useStore((s) => s.setLiveVoice)
  const ttsProviderId = useStore((s) => s.ttsProviderId)
  const ttsModel = useStore((s) => s.ttsModel)
  const ttsVoice = useStore((s) => s.ttsVoice)
  const setTtsProviderId = useStore((s) => s.setTtsProviderId)
  const setTtsModel = useStore((s) => s.setTtsModel)
  const setTtsVoice = useStore((s) => s.setTtsVoice)
  const ttsFallbacks = useStore((s) => s.ttsFallbacks)
  const setTtsFallbacks = useStore((s) => s.setTtsFallbacks)
  const subagentModels = useStore((s) => s.subagentModels)
  const setSubagentModel = useStore((s) => s.setSubagentModel)
  const subagentThinking = useStore((s) => s.subagentThinking)
  const setSubagentThinking = useStore((s) => s.setSubagentThinking)
  const toolFallbacks = useStore((s) => s.toolFallbacks)
  const setToolFallbacks = useStore((s) => s.setToolFallbacks)
  // The "Other" Tools row drives the small side-task slots together (context
  // compaction summariser, web-search distiller, chat-title generator): they
  // are all short, cheap calls where one model choice is what the user wants,
  // so one row writes/reads all three at once. `web` is consumed in Rust by
  // `run_web_distill` — it distils the fetched web_search results so the main
  // agent's context stays lean (with no model set, the raw results are used).
  // The slot list lives in `lib/toolSlots.ts` so every consumer (commit
  // message, title generator, compactor) reads the SAME group instead of one
  // hardcoded key.
  const otherModel = otherSlotModel(subagentModels)
  const otherLevel = otherSlotLevel(subagentThinking)
  const setOtherModel = (_agent: string, model: string) => {
    for (const k of OTHER_SLOTS) setSubagentModel(k, model)
  }
  const setOtherLevel = (_agent: string, level: ThinkingLevel) => {
    for (const k of OTHER_SLOTS) setSubagentThinking(k, level)
  }
  // The "Other" group's fallback list, read/written through the SAME three keys
  // as its model row — one row, one list.
  const otherFallbacks = otherSlotFallbacks(toolFallbacks)
  const setOtherFallbacks = (rows: ToolFallback[]) => {
    for (const k of OTHER_SLOTS) setToolFallbacks(k, rows)
  }
  const cacheTtlMinutes = useStore((s) => s.cacheTtlMinutes)
  const setMemoryTtlConfig = useStore((s) => s.setMemoryTtlConfig)
  const compactAtPercent = useStore((s) => s.settings.compactAtPercent ?? 80)
  const setCompactAtPercent = useStore((s) => s.setCompactAtPercent)
  const historyLimit = useStore((s) => s.historyLimit ?? 0)
  const setHistoryLimit = useStore((s) => s.setHistoryLimit)
  const skillCatalogMaxChars = useStore((s) => s.skillCatalogMaxChars ?? 6000)
  const setSkillCatalogMaxChars = useStore((s) => s.setSkillCatalogMaxChars)
  const disableTextSuggestions = useStore((s) => s.settings.disableTextSuggestions ?? true)
  const setDisableTextSuggestions = useStore((s) => s.setDisableTextSuggestions)
  const terminalShell = useStore((s) => s.settings.terminalShell ?? DEFAULT_TERMINAL_SHELL)
  const setTerminalShell = useStore((s) => s.setTerminalShell)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  const providers = settings.providers
  // Which provider's config is being EDITED in this dialog. Deliberately NOT
  // derived from settings.activeProviderId — visiting Settings must never
  // switch the app's active provider / main model.
  const [editId, setEditId] = useState(settings.activeProviderId)
  const active = providers.find((p) => p.id === editId) ?? providers[0]

  const [cfg, setCfg] = useState<ProviderConfig>({ ...active })
  const [saved, setSaved] = useState(false)
  // Google OAuth sign-in progress: "" idle, "busy" while the consent window is
  // open, "ok"/"error" + message when the flow settles.
  const [oauthState, setOauthState] = useState<{ status: string; msg: string }>({ status: '', msg: '' })
  // True once Save was blocked for a provider that has no usable credential.
  const [credWarn, setCredWarn] = useState(false)
  // New-key draft + per-row visibility for the multi-key list.
  const [newKey, setNewKey] = useState('')
  const [showKeys, setShowKeys] = useState<Record<number, boolean>>({})
  // ورودی «افزودن مدل دستی»: وقتی گیت‌وی فهرست مدل‌هایش را از /models نشان
  // نمی‌دهد (یا فچ شکست می‌خورد)، کاربر می‌تواند id مدل را مستقیم تایپ کند.
  const [manualModel, setManualModel] = useState('')
  // طول کانتکست (توکن) مدل دستی — فقط برای پروایدرهای custom نمایش داده می‌شود؛
  // با Add همراه مدل ذخیره و در متر کانتکست به‌جای مقدار زنده اولویت می‌گیرد.
  const [manualContext, setManualContext] = useState('')
  // وضعیت دکمه‌ی «Fetch models» (تب Providers): حین فچ دکمه غیرفعال می‌شود و
  // پیام نتیجه (تعداد مدل / دلیل skip / خطا) زیر دکمه نمایش داده می‌شود.
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState('')
  // توکن لغو فچ دستی: با تعویض پروایدر افزایش می‌یابد تا نتیجه‌ی در پرواز،
  // فرمِ پروایدر جدید را با مدلِ پروایدر قدیمی بازنویسی نکند.
  const fetchSeqRef = useRef(0)
  // Readiness checks for the provider being edited (drives the banner at the
  // top of the form so the problem is visible BEFORE a message is sent).
  const keyCount = providerApiKeys(cfg).length
  const credentialReady = keyCount > 0
  const requiresKey = providerMeta(cfg.kind).requiresKey
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {}
    for (const m of allModes(settings)) d[m.id] = settings.systemPrompts?.[m.id] ?? ''
    return d
  })

  const [tab, setTab] = useState<'providers' | 'auth' | 'plugins' | 'modes' | 'appearance' | 'extensions' | 'marketplaces' | 'storage' | 'tools' | 'models' | 'general'>(initialTab as any || 'providers')
  // Search Console OAuth (Settings → Auth) — the ONLY Google sign-in. Gemini
  // models authenticate with an API key like every other provider.
  const searchConsole = useStore((s) => s.searchConsole)
  const setSearchConsole = useStore((s) => s.setSearchConsole)
  const [googleAuthDraft, setGoogleAuthDraft] = useState<{ clientId: string; clientSecret: string }>({
    clientId: searchConsole.clientId,
    clientSecret: searchConsole.clientSecret,
  })
  useEffect(() => {
    setGoogleAuthDraft({
      clientId: searchConsole.clientId,
      clientSecret: searchConsole.clientSecret,
    })
  }, [searchConsole.clientId, searchConsole.clientSecret])

  // Close the whole settings window with Escape (unless focus is in a text
  // field, where Escape is used by the inner dropdowns/search boxes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        e.key === 'Escape' &&
        t &&
        t.tagName !== 'INPUT' &&
        t.tagName !== 'TEXTAREA' &&
        t.tagName !== 'SELECT'
      ) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ---- Data path (Settings → Memory) ----
  const [dataMsg, setDataMsg] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [migrateLabel, setMigrateLabel] = useState('')
  const [migratePct, setMigratePct] = useState(0)

  const applyDataPath = async () => {
    setDataMsg('')
    const target = (dataPath ?? '').trim()
    if (!target) return
    setMigrating(true)
    setMigrateLabel('Preparing…')
    setMigratePct(0)
    const unsub = api.onMigrateProgress((evt) => {
      setMigrateLabel(evt.label)
      setMigratePct(evt.pct)
    })
    try {
      const resolved = await api.moveDataPath(target)
      setDataPath(resolved)
      setDataMsg(`All data moved to ${resolved}. The old location is now empty.`)
    } catch (err) {
      setDataMsg(`Could not move data: ${(err as Error).message}`)
    } finally {
      unsub()
      setMigrating(false)
      setMigrateLabel('')
      setMigratePct(0)
    }
  }

  // ---- Storage settings (Settings → Storage) ----
  // Keep a local string buffer so the user can type freely (e.g. an empty field
  // or a transient "0" while editing); sync the input from the store on mount /
  // external change so a load (or a backfill) shows the persisted value.
  const [cacheTtlInput, setCacheTtlInput] = useState(String(cacheTtlMinutes))
  const [memMsg, setMemMsg] = useState('')
  useEffect(() => {
    setCacheTtlInput(String(cacheTtlMinutes))
  }, [cacheTtlMinutes])

  const modes = allModes(settings)

  // ---- Skills & MCP tab state ----
  const mcpServers = settings.mcpServers ?? {}
  const builtinMcp = useStore((s) => s.builtinMcp)
  const addMcpServer = useStore((s) => s.addMcpServer)
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const [skills, setSkills] = useState<Array<{ name: string; key: string; plugin: string; pluginName: string; pluginEnabled: boolean; path: string; raw: string; files: string[]; description: string; faKeywords: string[] }>>([])
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({})
  // Frontmatter fields of the skill being edited, keyed like skillDrafts.
  //
  // These are kept SEPARATE from the draft body on purpose. The draft is the
  // body WITHOUT frontmatter (`listSkills` strips it), so a save that only sent
  // the body used to wipe `description` and `fa_keywords` on every edit from
  // settings — the agent's catalog then showed a skill with no description and
  // no Persian keywords, i.e. it silently became unreachable for Persian asks.
  const [skillDescriptions, setSkillDescriptions] = useState<Record<string, string>>({})
  const [skillKeywords, setSkillKeywords] = useState<Record<string, string>>({})
  // Extra (Codex-style) files per skill key: filename -> content to upsert.
  const [skillExtraFiles, setSkillExtraFiles] = useState<Record<string, Record<string, string>>>({})
  // Extra files marked for deletion per skill key.
  const [skillDeletedFiles, setSkillDeletedFiles] = useState<Record<string, string[]>>({})
  // Currently viewed/edited extra file per skill key ('' = main skill.md).
  const [skillActiveFile, setSkillActiveFile] = useState<Record<string, string>>({})
  // New-file name input per skill key.
  const [skillNewFileName, setSkillNewFileName] = useState<Record<string, string>>({})
  const [skillsMsg, setSkillsMsg] = useState('')
  const [skillFilter, setSkillFilter] = useState('')
  const [mcpFilter, setMcpFilter] = useState('')

  /** Connectors, filtered then paged: one query covers the name, the command
   *  and its args and the URL, matching what the row shows. */
  const matchedMcp = Object.entries(mcpServers).filter(([name, cfg]) => {
    const q = mcpFilter.trim().toLowerCase()
    if (!q) return true
    const summary = `${name} ${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')} ${cfg.url ?? ''}`
    return summary.toLowerCase().includes(q)
  })
  const mcpGrid = useInfiniteGrid(matchedMcp.length, `mcp:${mcpFilter}`)

  /** Skills, filtered then paged: one query covers the name, the English
   *  description, the Persian keywords and the owning plugin. */
  const matchedSkills = skills.filter((s) => {
    const q = skillFilter.trim().toLowerCase()
    if (!q) return true
    const meta = skillMeta(s.raw)
    return `${s.name} ${meta.name} ${meta.description} ${s.pluginName} ${(s.faKeywords ?? []).join(' ')}`
      .toLowerCase()
      .includes(q)
  })
  const skillGrid = useInfiniteGrid(matchedSkills.length, `skills:${skillFilter}`)
  const pagedSkills = matchedSkills.slice(0, skillGrid.visible)
  const [addingMcp, setAddingMcp] = useState(false)
  // Connectors owned by a plugin: listed here too, because a bundle is only a
  // container — its connectors are needs the user wants to SEE and edit next to
  // their own, not hidden inside the bundle card.
  const [pluginConns, setPluginConns] = useState<PluginConnectorRow[]>([])
  const reloadPluginConns = useCallback(async () => {
    const rows = await listPluginConnectors()
    setPluginConns(Array.isArray(rows) ? rows : [])
  }, [])
  const skillListRef = useRef<HTMLDivElement | null>(null)

  const reloadSkills = useCallback(async (preferName?: string) => {
    // The user's own store PLUS the skills of every plugin, enabled or not:
    // a bundle that is switched off still has to be inspectable, and editing it
    // while off is exactly what someone goes to Settings for.
    const [own, bundled] = await Promise.all([listSkills(), listPluginSkills()])
    const fromPlugin = 'error' in bundled ? [] : bundled
    const found = [
      ...own.map((r) => ({
        name: r.name,
        // Two bundles may ship a skill with the same NAME, and a plugin's may
        // collide with the user's own. The row is keyed by plugin+name, so a
        // collision can never open, save or delete the wrong skill.
        key: r.name,
        plugin: '',
        pluginName: '',
        pluginEnabled: true,
        path: r.path,
        raw: r.content,
        files: r.files ?? [],
        // Carried through so a save can send them back: `content` is the
        // frontmatter-stripped body, so without these the backend would rewrite
        // `description:`/`fa_keywords:` as empty (see sync_skill).
        description: r.description ?? '',
        faKeywords: (r.fa_keywords ?? []).filter((k) => k.trim().length > 0),
      })),
      ...fromPlugin.map((r) => {
        const slug = r.plugin_slug ?? ''
        return {
          name: r.name,
          key: skillKey(slug, r.name),
          plugin: slug,
          pluginName: r.plugin ?? slug,
          pluginEnabled: r.plugin_enabled !== false,
          path: r.path,
          raw: r.content,
          files: r.files ?? [],
          description: r.description ?? '',
          faKeywords: (r.fa_keywords ?? []).filter((k) => k.trim().length > 0),
        }
      }),
    ]
    setSkills(found)
    setSkillDrafts((prev) => {
      // Keep drafts ONLY for rows that still exist, so a rename or a deleted
      // bundle cannot leave an orphaned edit that later overwrites a real skill.
      const keys = new Set(found.map((f) => f.key))
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) if (keys.has(k)) next[k] = v
      return next
    })
    if (preferName) {
      // Callers pass the row key (already plugin-scoped) so opening a renamed
      // or freshly saved plugin skill lands on the right card.
      const hit = found.find((f) => f.key === preferName || f.name === preferName)
      const key = hit?.key ?? preferName
      setExpandedSkills((prev) => new Set(prev).add(key))
      if (hit) {
        setSkillDrafts((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: hit.raw },
        )
        setSkillDescriptions((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: hit.description },
        )
        setSkillKeywords((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: hit.faKeywords.join(', ') },
        )
      }
    }
  }, [])

  useEffect(() => {
    void reloadSkills()
  }, [reloadSkills])

  useEffect(() => {
    void reloadPluginConns()
  }, [reloadPluginConns])

  // The Marketplaces tab is a SIBLING of these two, so an install there lands in
  // the stores without this panel knowing. Both lists are re-read on the same
  // event a bundle delete fires.
  useEffect(() => {
    const onChanged = () => {
      void reloadSkills()
      void reloadPluginConns()
      void listMcp().then((db) => {
        useStore.getState().setMcpServers(db.mcpServers ?? {})
      }).catch(() => { })
    }
    window.addEventListener('coder:plugins-changed', onChanged)
    return () => window.removeEventListener('coder:plugins-changed', onChanged)
  }, [reloadSkills, reloadPluginConns])

  const toggleSkill = (key: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setSkillDrafts((prev) => {
      if (prev[key] !== undefined) return prev
      return { ...prev, [key]: skills.find((x) => x.key === key)?.raw ?? '' }
    })
    // Seed the frontmatter inputs from the list row, once per open. The draft
    // body has no frontmatter, so these values are the ONLY copy of the skill's
    // description/fa_keywords the editor holds.
    const row = skills.find((x) => x.key === key)
    setSkillDescriptions((prev) =>
      prev[key] !== undefined ? prev : { ...prev, [key]: row?.description ?? '' },
    )
    setSkillKeywords((prev) =>
      prev[key] !== undefined ? prev : { ...prev, [key]: (row?.faKeywords ?? []).join(', ') },
    )
    setSkillsMsg('')
  }

  const getSkillServerFiles = (key: string): string[] => {
    if (key === NEW_SKILL_KEY) return []
    // Looked up by ROW KEY: a plugin's skill and the user's own may share a
    // name, and showing the wrong set of files would let a save delete one.
    return skills.find((x) => x.key === key)?.files ?? []
  }

  const getSkillVisibleFiles = (key: string): string[] => {
    const server = getSkillServerFiles(key)
    const deleted = new Set(skillDeletedFiles[key] ?? [])
    const local = Object.keys(skillExtraFiles[key] ?? {})
    const merged = [...server.filter((f) => !deleted.has(f))]
    for (const f of local) if (!merged.includes(f)) merged.push(f)
    return merged.sort()
  }

  const sanitizeSkillFileName = (raw: string): string => {
    const v = raw.trim()
    if (!v || v === 'SKILL.md' || v === 'skill.md') return ''
    if (v.includes('/') || v.includes('\\') || v.includes('..') || v.startsWith('.')) return ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) return ''
    return v
  }

  const saveSkill = async (name: string) => {
    const content = skillDrafts[name] ?? ''
    if (!content.trim()) {
      setSkillsMsg('Nothing to save.')
      return
    }
    const newName = resolveSkillName(content, name)
    const normalized = withSkillName(content, newName)
    const extra = skillExtraFiles[name] ?? {}
    const extraNames = Object.keys(extra)
    const deleted = (skillDeletedFiles[name] ?? []).filter((f) => !extraNames.includes(f))
    // Description and Persian keywords live in the frontmatter, which the draft
    // body does NOT carry — send them explicitly, or the backend rewrites the
    // file with an empty `description:` and no `fa_keywords:` at all.
    const row = skills.find((s) => s.key === name)
    const description = (skillDescriptions[name] ?? row?.description ?? '').trim()
    const keywords = (skillKeywords[name] ?? (row?.faKeywords ?? []).join(', ')).trim()
    // A plugin's skill belongs to its bundle: without `plugin` the backend wrote
    // the edit into the user's own store, so the bundle kept advertising the old
    // body and the catalog and the file disagreed.
    const owner = row?.plugin || undefined
    const res = await syncSkill({
      name: newName,
      previousName: name !== NEW_SKILL_KEY && name !== newName ? name : '',
      content: normalized,
      description,
      faKeywords: keywords,
      ...(owner ? { plugin: owner } : {}),
      ...(extraNames.length > 0 ? { files: extra } : {}),
      ...(deleted.length > 0 ? { deletedFiles: deleted } : {}),
    })
    setSkillsMsg(res.ok ? 'Saved ✓' : `Save failed: ${res.note ?? 'unknown error'}`)
    if (res.ok && (res.fa_keyword_count ?? 0) === 0) {
      // Without keywords the catalog line is English-only, so a Persian request
      // carries no trigger to find this skill by.
      setSkillsMsg(
        'Saved ✓ but no Persian keywords: a Persian request has nothing to find this skill by. Add keywords above.',
      )
    }
    if (res.ok) {
      const savedName = res.name || newName
      // The row key follows the plugin scope, not the bare name: a plugin skill
      // saved in place must land back on ITS card, not on a same-named local one.
      const savedKey = owner ? skillKey(owner, savedName) : savedName
      const renamed = name === NEW_SKILL_KEY || name !== savedKey
      setSkillDrafts((prev) => {
        const next = { ...prev }
        if (renamed) delete next[name]
        next[savedKey] = normalized
        return next
      })
      // Carry the frontmatter inputs over to the saved (possibly renamed) key.
      setSkillDescriptions((prev) => {
        const next = { ...prev }
        if (renamed) delete next[name]
        next[savedKey] = description
        return next
      })
      setSkillKeywords((prev) => {
        const next = { ...prev }
        if (renamed) delete next[name]
        next[savedKey] = keywords
        return next
      })
      setExpandedSkills((prev) => {
        const next = new Set(prev)
        if (renamed) next.delete(name)
        next.add(savedKey)
        return next
      })
      // Move extra-file state to the saved name so renames keep edits.
      if (renamed) {
        setSkillExtraFiles((prev) => {
          if (prev[name] === undefined) return prev
          const next = { ...prev }
          delete next[name]
          next[savedName] = prev[name]
          return next
        })
        setSkillDeletedFiles((prev) => {
          if (prev[name] === undefined) return prev
          const next = { ...prev }
          delete next[name]
          next[savedName] = prev[name]
          return next
        })
        setSkillActiveFile((prev) => {
          if (prev[name] === undefined) return prev
          const next = { ...prev }
          delete next[name]
          next[savedKey] = prev[name]
          return next
        })
        setSkillNewFileName((prev) => {
          if (prev[name] === undefined) return prev
          const next = { ...prev }
          delete next[name]
          return next
        })
      } else {
        // Saved in place: clear deletion markers that were applied.
        setSkillDeletedFiles((prev) => {
          if (prev[name] === undefined) return prev
          const next = { ...prev }
          delete next[name]
          return next
        })
      }
      void reloadSkills(savedKey)
      // The composer's `/`-menu is built from the OTHER catalog (store + enabled
      // plugins), so it has to be dropped too — otherwise a skill saved here
      // stays "Unknown command" until the next restart.
      invalidateSkillsList()
      invalidateAvailableSkills()
    }
  }

  const selectSkillFile = (key: string, fileName: string) => {
    const cur = skillActiveFile[key] ?? ''
    const next = cur === fileName ? '' : fileName
    setSkillActiveFile((prev) => ({ ...prev, [key]: next }))
    if (!next) return
    // Server files have no local content yet — fetch once so the editor shows real text.
    const local = skillExtraFiles[key]?.[next]
    if (local !== undefined) return
    if (key === NEW_SKILL_KEY) return
    if (!getSkillServerFiles(key).includes(next)) return
    // The plugin must be named: a switched-off bundle is not searched by the
    // backend's owner lookup, so its extra file would 404 while the row lists it.
    const owner = skills.find((s) => s.key === key)
    void getSkillFile(owner?.name ?? key, next, owner?.plugin || undefined).then((content) => {
      if (content === null) {
        setSkillsMsg(`Could not load ${next}.`)
        setSkillActiveFile((prev) => (prev[key] === next ? { ...prev, [key]: '' } : prev))
        return
      }
      setSkillExtraFiles((prev) => {
        if (prev[key]?.[next] !== undefined) return prev
        return { ...prev, [key]: { ...(prev[key] ?? {}), [next]: content } }
      })
    })
  }

  const addSkillFile = (key: string) => {
    const fileName = sanitizeSkillFileName(skillNewFileName[key] ?? '')
    if (!fileName) {
      setSkillsMsg('Invalid file name. Use letters, numbers, dot, dash or underscore (e.g. notes.md).')
      return
    }
    if (getSkillVisibleFiles(key).includes(fileName)) {
      setSkillActiveFile((prev) => ({ ...prev, [key]: fileName }))
      setSkillsMsg('')
      return
    }
    setSkillExtraFiles((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [fileName]: '' } }))
    setSkillDeletedFiles((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((f) => f !== fileName) }))
    setSkillActiveFile((prev) => ({ ...prev, [key]: fileName }))
    setSkillNewFileName((prev) => ({ ...prev, [key]: '' }))
    setSkillsMsg('')
  }

  const removeSkillFile = (key: string, fileName: string) => {
    setSkillExtraFiles((prev) => {
      const cur = prev[key] ?? {}
      if (cur[fileName] === undefined) return prev
      const nextFiles = { ...cur }
      delete nextFiles[fileName]
      return { ...prev, [key]: nextFiles }
    })
    if (getSkillServerFiles(key).includes(fileName)) {
      setSkillDeletedFiles((prev) => {
        const cur = prev[key] ?? []
        if (cur.includes(fileName)) return prev
        return { ...prev, [key]: [...cur, fileName] }
      })
    }
    setSkillActiveFile((prev) => (prev[key] === fileName ? { ...prev, [key]: '' } : prev))
  }

  const deleteSkill = async (key: string) => {
    const row = skills.find((s) => s.key === key)
    const label = row?.name ?? key
    // A plugin's skill is deleted from ITS bundle — the owner decision lives
    // here for the same reason it does on save.
    const owner = row?.plugin || undefined
    if (!window.confirm(`Delete skill "${label}"${owner ? ` from plugin "${row?.pluginName}"` : ''}?`)) return
    const res = await syncSkill({ name: label, delete: true, ...(owner ? { plugin: owner } : {}) })
    setSkillsMsg(res.ok ? 'Deleted.' : `Delete failed: ${res.note ?? 'unknown error'}`)
    if (res.ok) {
      // Every draft/expanded/extra-file map is keyed by the ROW KEY, so all of
      // them are cleared with it (a bare name left the state behind on rename).
      const name = key
      setExpandedSkills((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      setSkillDrafts((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      // Drop cached extra-file state for the deleted skill.
      setSkillExtraFiles((prev) => {
        if (prev[name] === undefined) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
      setSkillDeletedFiles((prev) => {
        if (prev[name] === undefined) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
      setSkillActiveFile((prev) => {
        if (prev[name] === undefined) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
      setSkillNewFileName((prev) => {
        if (prev[name] === undefined) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
      void reloadSkills()
      invalidateSkillsList()
      invalidateAvailableSkills()
    }
  }

  const newSkill = () => {
    setExpandedSkills((prev) => new Set(prev).add(NEW_SKILL_KEY))
    setSkillDrafts((prev) => ({
      ...prev,
      [NEW_SKILL_KEY]:
        '---\nname: new-skill\ndescription: One-line English summary of when to use this skill\nfa_keywords: \n---\n\n# New skill\n\nStep-by-step instructions the agent follows when this skill matches.\n',
    }))
    // Seed the two frontmatter inputs (the draft body above has no frontmatter,
    // so these are the values that actually get saved).
    setSkillDescriptions((prev) => ({ ...prev, [NEW_SKILL_KEY]: '' }))
    setSkillKeywords((prev) => ({ ...prev, [NEW_SKILL_KEY]: '' }))
    setSkillsMsg('Editing a new skill — fill in the details, then press Save skill. Add a one-line English `description:` and fill `fa_keywords:` (comma-separated phrases you would say, e.g. ترجمه کن, translate this) so it is matched automatically.')
    // The "New skill" editor renders at the TOP of the list; if the user had
    // scrolled down, scroll the list back to the top so it's immediately visible.
    requestAnimationFrame(() => skillListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
  }

  // Keep the local editor in sync when the edited provider changes.
  useEffect(() => {
    setCfg({ ...active })
    setManualModel('')
    setManualContext('')
    // پیام/وضعیت فچ مدل‌ها مال پروایدر قبلی است — با تعویض پروایدر پاک می‌شود
    // و هر فچ در پرواز باطل می‌شود تا نتیجه‌اش به فرم جدید نرسد.
    setFetchMsg('')
    setFetching(false)
    fetchSeqRef.current++
  }, [editId, active.id])

  // Reset the key draft + visibility when switching providers.
  useEffect(() => {
    setNewKey('')
    setShowKeys({})
    setCredWarn(false)
  }, [editId, active.id])

  // فچ دستی با دکمه‌ی «Fetch models» — فچ خودکار هنگام افزودن/ویرایش/تعویض
  // پروایدر حذف شد و فقط با کلیک صریح اجرا می‌شود. نتیجه‌ی در پرواز هنگام
  // تعویض پروایدر با توکن fetchSeqRef باطل می‌شود.
  const fetchModelsNow = async () => {
    if (fetching) return
    const seq = ++fetchSeqRef.current
    await fetchProviderModels(cfg, {
      setFetching,
      setMsg: setFetchMsg,
      refreshFormModel: () =>
        setCfg((c) => {
          const fresh = useStore.getState().settings.providers.find((p) => p.id === active.id)
          return { ...c, model: fresh?.model || c.model }
        }),
      stale: () => seq !== fetchSeqRef.current,
    })
  }

  const setPrompt = (mode: string, value: string) =>
    setPromptDrafts((d) => ({ ...d, [mode]: value }))

  const persistGoogleAuth = (patch: Partial<SearchConsoleConfig>) => {
    setSearchConsole(patch)
  }

  const signInGoogle = async () => {
    const cid = googleAuthDraft.clientId.trim()
    if (!cid) {
      setOauthState({ status: 'error', msg: 'Paste your Google OAuth client id first.' })
      return
    }
    setOauthState({ status: 'busy', msg: 'Opening Google sign-in…' })
    try {
      const res = await api.googleSignIn(cid, googleAuthDraft.clientSecret)
      persistGoogleAuth({
        clientId: cid,
        clientSecret: googleAuthDraft.clientSecret,
        refreshToken: res.refreshToken,
      })
      setOauthState({ status: 'ok', msg: 'Signed in — Google account connected.' })
    } catch (err) {
      setOauthState({
        status: 'error',
        msg: err instanceof Error ? err.message : 'Google sign-in failed.',
      })
    }
  }

  const disconnectGoogle = () => {
    persistGoogleAuth({ refreshToken: '' })
    setOauthState({ status: 'ok', msg: 'Google account disconnected.' })
  }

  // Multi-key list helpers: keys are tried top-to-bottom (9router-style fallback).
  const cfgKeys = providerApiKeys(cfg)
  const addKey = () => {
    const v = newKey.trim()
    if (!v) return
    setCfg({ ...cfg, apiKeys: [...cfgKeys, v] })
    setNewKey('')
    setCredWarn(false)
  }
  const removeKey = (idx: number) => {
    setCfg({ ...cfg, apiKeys: cfgKeys.filter((_, i) => i !== idx) })
  }
  const moveKey = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= cfgKeys.length) return
    const next = [...cfgKeys]
    const [k] = next.splice(idx, 1)
    next.splice(j, 0, k)
    setCfg({ ...cfg, apiKeys: next })
  }

  // ورودی عددی طول کانتکست فقط برای kind‌هایی معنا دارد که /models‌شان پنجره‌ی
  // قابل‌اعتماد گزارش نمی‌کند (`manualContextInput` در PROVIDER_META)؛ برای بقیه‌ی
  // kind‌ها فرم دقیقاً مثل قبل تک‌فیلدی می‌ماند.
  const isCustomKind = !!PROVIDER_META[cfg.kind]?.manualContextInput

  // افزودن مدل دستی به‌همراه مقدار دستی کانتکست (اگر خالی/نامعتبر بود، مدل
  // بدون مقدار دستی اضافه می‌شود و مقدارش از /models زنده گرفته می‌شود).
  const commitManualModel = () => {
    if (!manualModel.trim()) return
    const parsed = isCustomKind ? parseInt(manualContext, 10) : NaN
    addManualModel(active.id, manualModel, Number.isFinite(parsed) && parsed > 0 ? parsed : undefined)
    setManualModel('')
    setManualContext('')
  }

  const save = async () => {
    // Providers that REQUIRE a credential must not be saved in a broken state
    // (empty env var + no saved key) — that is exactly how a user
    // ends up with the "Set the GOOGLE_API_KEY environment variable" error.
    if (
      requiresKey &&
      !credentialReady
    ) {
      setCredWarn(true)
      return
    }
    for (const id of allModes(settings).map((m) => m.id)) {
      setSystemPrompt(id, (promptDrafts[id] ?? '').trim())
    }
    // Custom modes were removed — purge any legacy saved modes on next save.
    if (settings.modes && settings.modes.length > 0) {
      for (const orig of settings.modes) removeMode(orig.id)
    }
    // The active model is chosen ONLY from the composer model picker — changing
    // the "Active model" dropdown here must NOT switch the chat's model. Strip
    // `model` so this provider save keeps the currently-selected model intact.
    const { model: _model, ...cfgPersistFull } = cfg
    // Get live models/removedModels from store to avoid normalizing them to empty arrays
    const liveProvider = useStore.getState().settings.providers.find((p) => p.id === active.id)
    const { models: _models, removedModels: _removed, addedModels: _added, contextMap: _ctxMap, manualContextMap: _manualCtxMap, manualReasoningMap: _manualReasoningMap, ...cfgPersist } = cfgPersistFull
    updateProvider(active.id, {
      ...cfgPersist,
      model: liveProvider?.model ?? active.model,
      models: liveProvider?.models ?? [],
      removedModels: liveProvider?.removedModels ?? [],
      addedModels: liveProvider?.addedModels ?? [],
      // map های مدل‌محور از استور (نه اسنپ‌شات کهنه‌ی cfg) خوانده می‌شوند تا فچ زنده
      // و مقادیر دستیِ کاربر هنگام Save پاک نشوند.
      contextMap: liveProvider?.contextMap,
      manualContextMap: liveProvider?.manualContextMap,
      manualReasoningMap: liveProvider?.manualReasoningMap,
    })
    setSaved(true)
    setTimeout(onClose, 300)
  }

  const handleAdd = () => {
    const id = addProvider()
    setEditId(id)
  }

  const handleRemove = (id: string) => {
    const p = providers.find((x) => x.id === id)
    if (!p) return
    if (providers.length <= 1) return
    if (window.confirm(`Remove provider “${p.name}”? Its models will be deleted too.`)) {
      removeProvider(id)
      if (editId === id) {
        const rest = providers.filter((x) => x.id !== id)
        setEditId(rest[0]?.id ?? '')
      }
    }
  }

  const TABS: { id: typeof tab; label: string; group: string; icon: ReactNode }[] = [
    {
      id: 'providers',
      label: 'Providers',
      group: 'Models',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" />
          <path d="M6 7.5h.01M6 17.5h.01" />
        </svg>
      ),
    },
    {
      id: 'auth',
      label: 'Auth',
      group: 'Models',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15" r="1.2" />
        </svg>
      ),
    },
    {
      id: 'plugins',
      label: 'Web Providers',
      group: 'Models',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2v6h6M9 7a2 2 0 0 1 2-2h3l5 5v3a2 2 0 0 1-2 2h-1v9l-2 1V15h-3a2 2 0 0 1-2-2v-1H9a2 2 0 0 1-2-2v-1H7a2 2 0 0 1-2-2V7h4z" />
        </svg>
      ),
    },
    {
      id: 'models',
      label: 'Media Providers',
      group: 'Models',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5 6.5 6.5M17.5 17.5l2 2M4.5 19.5l2-2M17.5 6.5l2-2" />
        </svg>
      ),
    },
    {
      id: 'tools',
      label: 'Tools',
      group: 'Models',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
          <circle cx="18" cy="7" r="2.2" /><path d="M15.2 13a5 5 0 0 1 5.8 4.9" />
        </svg>
      ),
    },
    {
      id: 'modes',
      label: 'Modes',
      group: 'Agent',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2.4" fill="currentColor" stroke="none" />
          <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2.4" fill="currentColor" stroke="none" />
          <line x1="4" y1="18" x2="20" y2="18" /><circle cx="11" cy="18" r="2.4" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      id: 'extensions',
      label: 'Plugins',
      group: 'Knowledge',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h4V3a2 2 0 1 1 4 0v4h4V5a2 2 0 1 1 4 0v2h2a1 1 0 0 1 1 1v4h-4a2 2 0 1 0 0 4h4v4a1 1 0 0 1-1 1h-4v-4a2 2 0 1 0-4 0v4H8a1 1 0 0 1-1-1v-4H3a2 2 0 1 0 0-4h4V8a1 1 0 0 1 1-1z" />
        </svg>
      ),
    },
    {
      /* Its own tab, not a block inside Plugins: subscribing to a catalogue and
         managing the bundles you already have are two different errands. */
      id: 'marketplaces',
      label: 'Marketplaces',
      group: 'Knowledge',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9.5 5 4h14l2 5.5" />
          <path d="M4 9.5h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
          <path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
        </svg>
      ),
    },
    {
      id: 'storage',
      label: 'Storage',
      group: 'App',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
        </svg>
      ),
    },
    {
      id: 'appearance',
      label: 'Appearance',
      group: 'App',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2a3 3 0 0 0-3 3v1c0 1.5-1 2-2 2Z" />
        </svg>
      ),
    },
    {
      id: 'general',
      label: 'General',
      group: 'App',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
  ]

  // Tabs 'providers' / 'modes' / / 'auth' edit LOCAL buffered state
  // (`cfg`, `promptDrafts`, `googleAuthDraft`) that is only committed to the
  // store when Save is pressed — every other tab (plugins, mcp, skills,
  // memory, tools, models) writes straight to the store as the user
  // types, so there is nothing to "save" or "cancel" there. The footer used
  // to render three different button combinations across tabs (Cancel+Save /
  // Save+Close / Close-only) with no visual explanation for the difference,
  // which is exactly what made it unclear which button to press when
  // switching tabs. Collapsing it to this one boolean keeps the rule simple
  // and visible: buffered tabs always show Cancel+Save, every other tab
  // always shows a single Done button.
  const hasBufferedEdits = tab === 'providers' || tab === 'modes' || tab === 'auth'
  // Auto-save tabs: Done force-flushes any pending state to disk before
  // closing (a change made while a reply is streaming could otherwise be
  // lost) — previously this required an extra, easy-to-miss "Save" click on
  // just the tools/memory/auth tabs; now it always happens automatically.
  const handleDone = () => {
    flushStateNow()
    onClose()
  }
  // Buffered tabs route through the tab-appropriate persist function, then
  // flush + show the same "Saved ✓" feedback either way.
  const handleSave = () => {
    if (tab === 'auth') {
      const cid = googleAuthDraft.clientId.trim()
      const csec = googleAuthDraft.clientSecret.trim()
      if (cid || csec) persistGoogleAuth({ clientId: cid, clientSecret: csec })
      flushStateNow()
      setSaved(true)
      setTimeout(onClose, 300)
      return
    }
    save()
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-wide settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-header-title">
            <h2>Settings</h2>
            <span className="settings-header-tab">{TABS.find((t) => t.id === tab)?.label}</span>
          </div>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-tabs">
            {TABS.map((t, i) => (
              <Fragment key={t.id}>
                {(i === 0 || t.group !== TABS[i - 1].group) && (
                  <div className="settings-tab-group">{t.group}</div>
                )}
                <button
                  className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  <span className="settings-tab-icon">{t.icon}</span>
                  {t.label}
                </button>
              </Fragment>
            ))}
          </div>

          <div className="settings-content">

        {tab === 'providers' && (
        <>
        <div className="field">
          <label>Providers</label>
          <div className="provider-tabs">
            {providers.map((p) => (
              <div
                key={p.id}
                className={`provider-tab ${p.id === active.id ? 'active' : ''}`}
                onClick={() => setEditId(p.id)}
              >
                <span
                  className={`provider-tab-dot ${isProviderConfigured(p) ? 'ok' : 'off'}`}
                  title={isProviderConfigured(p) ? 'Configured' : 'Not configured'}
                />
                <span className="provider-tab-name">{p.name}</span>
                {!BUILTIN_KINDS.includes(p.kind) && providers.length > 1 && (
                  <button
                    className="provider-tab-remove"
                    title="Remove provider"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(p.id)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button className="provider-tab add" onClick={handleAdd}>
              + Add
            </button>
          </div>
          <div className="hint">
            Switching providers keeps each one’s name, base URL and saved models. The active model is
            chosen in the composer; each provider shows its own models.
          </div>
        </div>

        {active && (
          <>
            {providerMeta(cfg.kind).local ? (
              <div className="env-key-hint ok">
                <span className="status-dot ok" />
                Local provider — no API key needed.
              </div>
            ) : credentialReady ? (
              <div className="env-key-hint ok">
                <span className="status-dot ok" />
                Ready — {keyCount} API key{keyCount === 1 ? '' : 's'} configured. The top key is tried first; on key errors the next one is used automatically.
              </div>
            ) : requiresKey ? (
              <div className="env-key-hint fail">
                <span className="status-dot fail" />
                No API key configured. Add at least one key below —
                otherwise this provider can't connect.
                {credWarn && ' Save was blocked until you configure one.'}
              </div>
            ) : (
              <div className="env-key-hint fail">
                <span className="status-dot fail" />
                No API key set — the provider may work without a key.
              </div>
            )}
            {!BUILTIN_KINDS.includes(cfg.kind) && (
              <div className="field">
                <label>Name</label>
                <input
                  value={cfg.name}
                  onChange={(e) => setCfg({ ...cfg, name: e.target.value })}
                  placeholder="e.g. My server"
                />
              </div>
            )}

            {isAccountScoped(cfg.kind) && (
              <>
                <div className="field">
                  <label>Account ID</label>
                  <input
                    value={cfg.accountId ?? ''}
                    onChange={(e) => {
                      const accountId = e.target.value.trim()
                      // The row's base URL IS this id applied to the gateway
                      // template, so the form keeps the two in step: a Fetch
                      // clicked right after typing already has a full endpoint
                      // (the store rebuilds the same value on Save).
                      setCfg({
                        ...cfg,
                        accountId,
                        baseUrl: accountScopedBaseUrl(cfg.kind, accountId) ?? '',
                      })
                    }}
                    placeholder="e.g. 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
                    dir="ltr"
                  />
                  {providerMeta(cfg.kind).accountIdHint && (
                    <div className="hint">{providerMeta(cfg.kind).accountIdHint}</div>
                  )}
                </div>
                <div className="field">
                  <label>Base URL</label>
                  <div className="hint">
                    {cfg.baseUrl ||
                      'Built from the account id — enter one above to get the endpoint.'}
                  </div>
                  {providerMeta(cfg.kind).baseUrlDesc && (
                    <div className="hint">{providerMeta(cfg.kind).baseUrlDesc}</div>
                  )}
                  {providerMeta(cfg.kind).extraHint && (
                    <div className="hint">{providerMeta(cfg.kind).extraHint}</div>
                  )}
                </div>
              </>
            )}

            {providerMeta(cfg.kind).editableBaseUrl && (
              <div className="field">
                <label>Base URL</label>
                <input
                  value={cfg.baseUrl}
                  onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                  placeholder={
                    providerMeta(cfg.kind).local ? 'http://localhost:11434' : 'http://localhost:8080/v1'
                  }
                  dir="ltr"
                />
                <div className="hint">
                  {providerMeta(cfg.kind).baseUrlDesc ??
                    (providerMeta(cfg.kind).local
                      ? 'Local endpoint (llama.cpp-compatible). Also works with Ollama and vLLM.'
                      : 'Any OpenAI-compatible API (llama.cpp, vLLM, LocalAI, LM Studio, …).')}
                </div>
              </div>
            )}

            {providerMeta(cfg.kind).baseUrlHint && !providerMeta(cfg.kind).editableBaseUrl && (
              <div className="field">
                <label>Base URL</label>
                <div className="hint">{providerMeta(cfg.kind).baseUrlHint}</div>
                {providerMeta(cfg.kind).baseUrlDesc && (
                  <div className="hint">{providerMeta(cfg.kind).baseUrlDesc}</div>
                )}
                {providerMeta(cfg.kind).extraHint && (
                  <div className="hint">{providerMeta(cfg.kind).extraHint}</div>
                )}
              </div>
            )}

            {!providerMeta(cfg.kind).local && (
              <div className="field">
                <div className="field-head">
                  <label>API keys</label>
                  {cfgKeys.length > 0 && (
                    <span className="field-value-badge" title="Keys are tried top to bottom; on a key error the next one is used">
                      {cfgKeys.length} key{cfgKeys.length === 1 ? '' : 's'} · top first
                    </span>
                  )}
                </div>
                <div className="hint">
                  The first key is used first; if it fails with a key error (invalid, expired,
                  rate-limited), the next key is tried automatically. Keys are encrypted (AES-256-GCM)
                  when you press Save.
                </div>
                <div className="api-key-list">
                  {cfgKeys.map((k, i) => (
                    <div key={i} className="api-key-row">
                      <span className="api-key-order" title={i === 0 ? 'Tried first' : `Fallback #${i + 1} — tried after key ${i}`}>{i + 1}</span>
                      <input
                        className="api-key-input"
                        type={showKeys[i] ? 'text' : 'password'}
                        value={k}
                        onChange={(e) => {
                          const next = [...cfgKeys]
                          next[i] = e.target.value
                          setCfg({ ...cfg, apiKeys: next })
                        }}
                        placeholder={`API key ${i + 1}`}
                        dir="ltr"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <div className="api-key-actions">
                        <button type="button" className={`icon-btn${showKeys[i] ? ' on' : ''}`} title={showKeys[i] ? 'Hide key' : 'Show key'} aria-label={showKeys[i] ? 'Hide key' : 'Show key'} onClick={() => setShowKeys((s) => ({ ...s, [i]: !s[i] }))}>
                          {showKeys[i] ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                          )}
                        </button>
                        <span className="api-key-sep" aria-hidden="true" />
                        <button type="button" className="icon-btn" title="Move up" aria-label="Move key up" disabled={i === 0} onClick={() => moveKey(i, -1)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
                        </button>
                        <button type="button" className="icon-btn" title="Move down" aria-label="Move key down" disabled={i === cfgKeys.length - 1} onClick={() => moveKey(i, 1)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                        </button>
                        <span className="api-key-sep" aria-hidden="true" />
                        <button type="button" className="icon-btn danger" title="Remove key" aria-label="Remove key" onClick={() => removeKey(i)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="api-key-row add">
                    <span className="api-key-order new" title="New key">+</span>
                    <input
                      className="api-key-input"
                      type={showKeys[-1] ? 'text' : 'password'}
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addKey()
                        }
                      }}
                      placeholder="Paste a new API key — press Enter to add"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <div className="api-key-actions">
                      <button type="button" className={`icon-btn${showKeys[-1] ? ' on' : ''}`} title={showKeys[-1] ? 'Hide' : 'Show'} aria-label={showKeys[-1] ? 'Hide' : 'Show'} onClick={() => setShowKeys((s) => ({ ...s, [-1]: !s[-1] }))}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                      </button>
                      <button type="button" className="btn tiny primary" disabled={!newKey.trim()} onClick={addKey}>
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="field">
              <label>Models catalog</label>
              <div className="models-catalog-card">
                <div className="models-catalog-row">
                  <button type="button" className={`fetch-models-btn${fetching ? ' busy' : ''}`} disabled={fetching} onClick={() => void fetchModelsNow()}>
                    <svg className={`fetch-models-icon${fetching ? ' spin' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                    {fetching ? 'Fetching…' : 'Fetch models'}
                  </button>
                  {fetchMsg ? (
                    <span className={`fetch-models-status${/fail|error|not|no /i.test(fetchMsg) ? ' fail' : ' ok'}`}>{fetchMsg}</span>
                  ) : (
                    <span className="fetch-models-count">{(active.models?.length ?? 0) > 0 ? `${active.models!.length} models` : 'No models yet'}</span>
                  )}
                </div>
                <div className="hint">
                  Pulls the live /models list for this provider (ids, context windows, pricing), repairs a
                  stale selected model and heals chats. Nothing is fetched automatically while you edit —
                  run it after changing the base URL or credential.
                </div>
              </div>
            </div>

            <div className="field">
              <label>Add model manually</label>
              <div className="manual-model-row">
                <input
                  value={manualModel}
                  onChange={(e) => setManualModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitManualModel()
                    }
                  }}
                  placeholder="e.g. claude-opus-4-6 — press Enter"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                />
                {isCustomKind && (
                  <input
                    className="manual-model-ctx"
                    type="number"
                    min={1024}
                    step={1024}
                    value={manualContext}
                    onChange={(e) => setManualContext(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitManualModel()
                      }
                    }}
                    placeholder="context (tokens)"
                    title="Context window in tokens for this custom model"
                    dir="ltr"
                  />
                )}
                <button
                  type="button"
                  className="btn tiny"
                  disabled={!manualModel.trim()}
                  onClick={commitManualModel}
                >
                  Add
                </button>
              </div>
              <div className="hint">
                For gateways that don’t list their models (or the fetch fails). The model is kept even
                when the live catalog is unreachable, and can be picked in the composer.
                {isCustomKind && ' Enter the context window (tokens) next to the id — it overrides the value fetched from /models.'}
              </div>
              {(() => {
                const live = useStore.getState().settings.providers.find((p) => p.id === active.id)
                const manual = live?.addedModels ?? []
                if (manual.length === 0) return null
                return (
                  <div className="manual-model-list">
                    {manual.map((m) => {
                      const bare = m.startsWith(`${active.id}/`) ? m.slice(active.id.length + 1) : m
                      const manualCtx = live?.manualContextMap?.[bare]
                      const manualReasoning = live?.manualReasoningMap?.[bare]
                      return (
                        <span key={m} className="manual-model-chip" title={m}>
                          <span className="manual-model-name">{m}</span>
                          <button
                            type="button"
                            className="manual-model-remove"
                            title="Remove model"
                            onClick={() => removeManualModel(active.id, m)}
                          >
                            ×
                          </button>
                          {isCustomKind && (
                            <input
                              className="manual-model-ctx-input"
                              type="number"
                              min={1024}
                              step={1024}
                              value={manualCtx ?? ''}
                              placeholder="ctx"
                              title="Context window in tokens (overrides /models)"
                              dir="ltr"
                              onChange={(e) => {
                                const n = parseInt(e.target.value, 10)
                                setManualModelContext(active.id, m, Number.isFinite(n) ? n : null)
                              }}
                            />
                          )}
                          <button
                            type="button"
                            className={`manual-model-reasoning${manualReasoning ? ' on' : ''}`}
                            title={manualReasoning ? 'Reasoning: on — click to turn off' : 'Reasoning: off — click to enable the thinking-level picker for this model'}
                            aria-pressed={manualReasoning === true}
                            onClick={() => setManualModelReasoning(active.id, m, manualReasoning ? null : true)}
                          >
                            <span aria-hidden="true" className="manual-model-reasoning-icon">✦</span>
                            <span className="manual-model-reasoning-label">{manualReasoning ? 'Thinking' : 'No think'}</span>
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )
              })()}
            </div>

          </>
        )}
        </>
        )}

        {tab === 'auth' && (
        <>
          <div className="field">
            <div className="field-head">
              <label>Google account</label>
            </div>
            <div className="hint">
              This sign-in connects ONLY the Search Console tool (site analytics).
              Gemini models authenticate with an API key under Settings → Providers →
              Google, like every other provider. Create an OAuth 2.0 Desktop client in
              the Google Cloud Console (APIs &amp; Services → Credentials), paste its id
              and secret below, then sign in.
            </div>
            <details className="guided-steps">
              <summary>How to create your Google OAuth client id &amp; secret</summary>
              <ol>
                <li>
                  Go to{' '}
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                    console.cloud.google.com/apis/credentials
                  </a>{' '}
                  (signed in to the same Google account you want to use).
                </li>
                <li>If you don't have a project yet, click <strong>Select a project → New Project</strong> and create one.</li>
                <li>If prompted, enable the API: <strong>Google Search Console API</strong> (APIs &amp; Services → Library → search → Enable).</li>
                <li>
                  Click <strong>Create Credentials → OAuth client ID</strong>.
                </li>
                <li>
                  If asked to configure the consent screen first, click <strong>Configure consent screen</strong>,
                  choose <strong>External</strong> (or Internal if it's your own Google Workspace), fill in the app
                  name, add yourself under <strong>Test users</strong>, and save.
                </li>
                <li>Set <strong>Application type: Desktop app</strong>, give it any name, and click <strong>Create</strong>.</li>
                <li>
                  Copy the <strong>Client ID</strong> and <strong>Client secret</strong> Google shows, and paste
                  them into the two fields above.
                </li>
              </ol>
              <p className="hint">
                The sign-in asks only for the Search Console (webmasters.readonly)
                permission in a single Google consent.
              </p>
            </details>
            <label className="field-label">Google OAuth client id</label>
            <input
              value={googleAuthDraft.clientId}
              onChange={(e) => setGoogleAuthDraft((d) => ({ ...d, clientId: e.target.value }))}
              placeholder="Google OAuth client id"
              dir="ltr"
            />
            <label className="field-label">Google OAuth client secret</label>
            <input
              value={googleAuthDraft.clientSecret}
              onChange={(e) => setGoogleAuthDraft((d) => ({ ...d, clientSecret: e.target.value }))}
              placeholder="Google OAuth client secret"
              dir="ltr"
              type="password"
            />
            <div className="oauth-actions">
              {searchConsole.refreshToken ? (
                <button className="btn tiny danger" onClick={disconnectGoogle}>
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="oauth-signin-btn"
                  disabled={oauthState.status === 'busy'}
                  onClick={() => void signInGoogle()}
                >
                  {oauthState.status === 'busy' ? (
                    <>
                      <span className="oauth-btn-spinner" aria-hidden />
                      Waiting for Google…
                    </>
                  ) : (
                    <>
                      <svg className="oauth-glogo" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.12-.19-1.64H9v3.1h4.88c-.1.63-.38 1.58-.9 2.12l-.01.08 1.31 1.01.09.01c1.43-1.32 2.27-3.26 2.27-5.68z" />
                        <path fill="#34A853" d="M9 18c1.62 0 2.98-.53 3.97-1.45l-1.4-1.08c-.38.26-.9.6-1.57.6-1.44 0-2.66-.96-3.09-2.3l-.06.01-1.33 1.03-.05.06C4.96 16.04 6.84 18 9 18z" />
                        <path fill="#FBBC05" d="M5.91 11.87c-.2-.55-.32-1.15-.32-1.87s.12-1.32.32-1.87v-.08l-1.32-1.03-.06.05a6.68 6.68 0 0 0 0 5.7l1.32-1.03z" />
                        <path fill="#EA4335" d="M9 3.78c.92 0 1.58.28 2.07.83l1.55-1.5C11.98 1.95 10.62 1.2 9 1.2 6.84 1.2 4.96 3.16 4.1 5.16l1.32 1.03C6.34 4.74 7.56 3.78 9 3.78z" />
                      </svg>
                      Sign in with Google
                    </>
                  )}
                </button>
              )}
            </div>
            {oauthState.msg && (
              <div className={`env-key-hint ${oauthState.status === 'ok' ? 'ok' : ''}`}>
                <span className={`status-dot ${oauthState.status === 'ok' ? 'ok' : oauthState.status === 'error' ? 'fail' : ''}`} />
                {oauthState.msg}
              </div>
            )}
            <div className="hint">
              Connected: {searchConsole.refreshToken ? 'yes' : 'no'}. This sign-in powers the
              Search Console tool (Settings → Plugins). Gemini models use an API key
              (Settings → Providers → Google), like every other provider.
            </div>
          </div>
        </>
        )}

        {tab === 'plugins' && (
        <>
          <PluginEditor />
        </>
        )}

        {tab === 'modes' && (
        <>
            <div className="field">
              <label>Modes</label>
              {modes.map((m) => (
                  <div className="mode-card" key={m.id}>
                    <div className="mode-card-head">
                      <span className="mode-card-icon"><ModeIcon icon={m.icon} /></span>
                      <span className="mode-card-title">{m.label}</span>
                      <span className="badge">built-in</span>
                    </div>
                    <p className="hint">{m.description}</p>
                    <label className="field-label">Custom prompt <span className="hint">(appended to the built-in prompt)</span></label>
                    <textarea
                      className="system-prompt"
                      value={promptDrafts[m.id] ?? ''}
                      onChange={(e) => setPrompt(m.id, e.target.value)}
                      rows={7}
                      dir="auto"
                      spellCheck={false}
                    />
                    <div className="prompt-actions">
                      <span className="hint">Changes apply on the next message.</span>
                      <button className="btn tiny" onClick={() => setPrompt(m.id, '')}>
                        Clear
                      </button>
                    </div>
                  </div>
                ))}
            </div>
        </>
        )}

        {tab === 'appearance' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>Theme</label>
              </div>
              <div className="hint">
                Color scheme for the whole app - pick one of the top Neovim
                themes, plus the Claude app look. New themes are added in the
                themes.ts file.
              </div>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`theme-card${theme === t.id ? ' active' : ''}`}
                    onClick={() => setTheme(t.id)}
                    title={t.blurb ?? t.name}
                  >
                    <span className="theme-swatch" aria-hidden>
                      <i style={{ background: t.vars['--bg'] ?? 'var(--bg)' }}></i>
                      <i style={{ background: t.vars['--bg-panel'] ?? 'var(--bg-panel)' }}></i>
                      <i style={{ background: t.vars['--accent'] ?? 'var(--accent)' }}></i>
                      <i style={{ background: t.vars['--link'] ?? 'var(--link)' }}></i>
                      <i style={{ background: t.vars['--danger'] ?? 'var(--danger)' }}></i>
                    </span>
                    <span className="theme-name">{t.name}</span>
                    <span className="theme-check">{theme === t.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Font Size</label>
              <div className="font-size-row">
                <span className="font-size-label">A−</span>
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                />
                <span className="font-size-label">A+</span>
                <span className="font-size-value">{fontSize}px</span>
              </div>
              <div className="hint">Applies instantly to the whole app.</div>
              <div className="font-preview">
                نمونه‌ای از متن فارسی و English preview.
              </div>
            </div>
            <div className="field">
              <label>File viewer font size</label>
              <div className="font-size-row">
                <span className="font-size-label">A−</span>
                <input
                  type="range"
                  min={9}
                  max={24}
                  step={1}
                  value={viewerFontSize}
                  onChange={(e) => setViewerFontSize(Number(e.target.value))}
                />
                <span className="font-size-label">A+</span>
                <span className="font-size-value">{viewerFontSize}px</span>
              </div>
              <div className="hint">
                Size of code opened in the side-pane file viewer. Independent of
                the chat font size.
              </div>
            </div>
            <div className="field">
              <label>Terminal font size</label>
              <div className="font-size-row">
                <span className="font-size-label">A−</span>
                <input
                  type="range"
                  min={9}
                  max={24}
                  step={1}
                  value={terminalFontSize}
                  onChange={(e) => setTerminalFontSize(Number(e.target.value))}
                />
                <span className="font-size-label">A+</span>
                <span className="font-size-value">{terminalFontSize}px</span>
              </div>
              <div className="hint">
                Size of every terminal in the app (bottom panel and side-pane
                tabs). Independent of the chat font size.
              </div>
            </div>
        </>
        )}

        {/* Catalogue browsing has its OWN tab under Knowledge. A marketplace row
            installs a plugin wherever it was listed, so nothing else changed. */}
        {tab === 'marketplaces' && (
        <>
          <MarketplaceEditor />
        </>
        )}

        {tab === 'extensions' && (
        <>
          {/* ONE tab for everything a plugin is: the bundles themselves, then
              the connectors and skills living inside them. The old `skills` and
              `mcp` tabs are gone because a skill or a connector has no life of
              its own any more — it belongs to a bundle, and the bundle's switch
              is what turns it on or off. */}
          <PluginBundleEditor />
            {/* The one skill knob that is NOT per bundle: how much of the whole
                catalog rides in every prompt. Everything else a bundle holds —
                its skills and its connectors — is edited inside its own card. */}
            <div className="field">
              <div className="field-head">
                <label>Catalog budget</label>
                <span className="field-value-badge">{skillCatalogMaxChars} chars</span>
              </div>
              <div className="hint">
                How many characters of the skill catalog (every name, plus as much
                description and as many Persian keywords as fit) ride in the system
                prompt on <b>every</b> turn. Past this the list drops DETAIL first and
                always keeps each skill's name — so an absent entry never means a
                missing skill, only that it was not listed. Raise it for a large store
                (roughly <code>4</code> characters per token, so <code>6000</code> ≈{' '}
                <code>1500</code> tokens per turn); lower it to save context. Range{' '}
                <code>1500</code>–<code>12000</code> on the backend as well, so a value
                typed here is never silently ignored. Default: <code>6000</code>.
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
        </>
        )}

        {tab === 'storage' && (
        <>
          {/* The web/fetch TTL lives on the Web Providers tab next to the
              engines it throttles — a cache knob alone is dead weight here. */}
          {/* ===== Result cache ===== */}
          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-icon">⚡</span>
              <div>
                <div className="settings-group-title">Tool result cache</div>
                <div className="settings-group-desc">
                  Speeds up repeated work by caching tool outputs (searches, reads, runs) in memory.
                  Cached results are reused within the TTL window.
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Cache TTL</div>
                <div className="settings-row-desc">
                  How long <b>tool outputs</b> stay cached before re-running. Default: <code>60min</code>.
                  Persists automatically on every change (no Save button needed).
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  type="number"
                  min={1}
                  value={cacheTtlInput}
                  onChange={(e) => {
                    const v = e.target.value
                    setCacheTtlInput(v)
                    // Commit on every change so the value lands on disk without a
                    // separate Save click. Reject non-positive / non-numeric
                    // input (the store's setter also clamps to >0); an empty
                    // string just clears the visible buffer without persisting.
                    const n = parseInt(v, 10)
                    if (Number.isFinite(n) && n > 0) {
                      setMemoryTtlConfig({ cache: n })
                      setMemMsg('Cache TTL saved.')
                    }
                  }}
                  dir="ltr"
                  aria-label="Cache TTL in minutes"
                />
                <span className="field-unit">minutes</span>
              </div>
            </div>
          </div>

          {/* ===== Data & maintenance ===== */}
          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-icon">🗂️</span>
              <div>
                <div className="settings-group-title">Data & maintenance</div>
                <div className="settings-group-desc">
                  Where your data lives and how to reset it.
                </div>
              </div>
            </div>

            <div className="settings-row settings-row-stack">
              <div className="settings-row-label">
                <div className="settings-row-title">Data path</div>
                <div className="settings-row-desc">
                  All app data lives under this path: settings (<code>settings.json</code>), chats,
                  vector stores, models, skills, MCP connectors, and plans. Moving the path
                  copies every file to the new location and empties the old one. The default{' '}
                  <code>~/.codifa</code> works the same on macOS, Linux, and Windows
                  (<code>~/</code> = your home directory).
                </div>
              </div>
              <div className="data-path-row">
                <input
                  value={dataPath}
                  onChange={(e) => setDataPath(e.target.value)}
                  placeholder="~/.codifa"
                  dir="ltr"
                  disabled={migrating}
                />
                <button className="btn tiny" onClick={applyDataPath} disabled={!dataPath.trim() || migrating}>
                  {migrating ? 'Moving…' : 'Apply & move data'}
                </button>
              </div>
              {migrating && (
                <div className="migrate-progress">
                  <div className="migrate-bar-track">
                    <div className="migrate-bar-fill" style={{ width: `${migratePct}%` }} />
                  </div>
                  <div className="hint">{migrateLabel} — {migratePct}%</div>
                </div>
              )}
              {dataMsg && <div className="hint" style={{ color: 'var(--accent)' }}>{dataMsg}</div>}
            </div>
          </div>

          {memMsg && <div className="settings-saved">{memMsg}</div>}
        </>
        )}

        {tab === 'tools' && (
        <>
          <div className="field">
            <div className="slot-intro">
              Each tool can run on a model of its own — leave a card on the main
              model to follow the composer. A tool whose own model fails tries
              its own fallback list, top to bottom, for that call only; a
              fallback keeps the tool's reasoning level, and the next call starts
              at the tool's own model again. The {`"Other"`} card drives the
              small side tasks (context compaction summariser, web-search result
              distiller and chat-title generator) together.
            </div>

            <ToolSlotRow
              agent="explore"
              label="Explore"
              desc="Research sub-agent that does ALL file reading, searching and LSP lookups for the main agent and reports the full findings. Falls back to the main model."
              model={subagentModels.explore || ''}
              level={subagentThinking.explore || 'low'}
              onSelectModel={setSubagentModel}
              onSelectLevel={setSubagentThinking}
              fallbacks={toolFallbacks.explore ?? []}
              onFallbacks={(rows) => setToolFallbacks('explore', rows)}
            />
            <ToolSlotRow
              agent="vision"
              label="Vision"
              desc="Image analysis model (handles screenshots, diagrams and photos)."
              model={subagentModels.vision || ''}
              level={subagentThinking.vision || 'none'}
              onSelectModel={setSubagentModel}
              onSelectLevel={setSubagentThinking}
              fallbacks={toolFallbacks.vision ?? []}
              onFallbacks={(rows) => setToolFallbacks('vision', rows)}
            />
            <ToolSlotRow
              agent="schedule"
              label="Schedule"
              desc="Model that runs scheduled tasks (cron inbox) in the background. Empty = the provider/model saved on each task, or the main model."
              model={subagentModels.schedule || ''}
              level={subagentThinking.schedule || 'none'}
              onSelectModel={setSubagentModel}
              onSelectLevel={setSubagentThinking}
              fallbacks={toolFallbacks.schedule ?? []}
              onFallbacks={(rows) => setToolFallbacks('schedule', rows)}
            />
            <ToolSlotRow
              agent="other"
              label="Other"
              desc="Small side tasks: the context-compaction summariser, the web-search result distiller and the chat-title generator. One model for all three."
              model={otherModel}
              level={otherLevel as ThinkingLevel}
              onSelectModel={setOtherModel}
              onSelectLevel={setOtherLevel}
              fallbacks={otherFallbacks}
              onFallbacks={setOtherFallbacks}
            />
          </div>
        </>
        )}

        {tab === 'models' && (
        <>
            <div className="field models-tab">
              <div className="slot-intro">
                <b>Media Providers</b> — speech runs on your own providers,
                nothing on-device. STT posts audio to{' '}
                {'<base_url>/audio/transcriptions'} and TTS to{' '}
                {'<base_url>/audio/speech'}.
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Speech to Text (STT)</span>
                    <span className="model-card-desc">Voice input transcription</span>
                  </div>
                </div>
                <div className="model-card-body">
                  <div className="voice-section">
                    <div className="voice-field">
                      <label className="field-label">STT provider</label>
                    <select value={sttProviderId} onChange={(e) => setSttProviderId(e.target.value)} dir="ltr">
                      <option value="">Not selected</option>
                      {providers.filter((p) => p.kind !== 'ollama').map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                        </option>
                      ))}
                    </select>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">STT model</label>
                    <input value={sttModel} onChange={(e) => setSttModel(e.target.value)} dir="ltr" placeholder="whisper-1" />
                    </div>
                    <div className="voice-field">
                      <label className="field-label">STT language</label>
                    <select value={sttLanguage ?? ''} onChange={(e) => setSttLanguage(e.target.value)} dir="ltr">
                      {STT_LANGUAGES.map((l) => (
                        <option key={l.code || 'auto'} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <div className="hint">
                      بدون زبان صریح، Whisper روی کلیپ‌های کوتاه زبان را اشتباه تشخیص می‌دهد و کلمات فارسی خراب می‌شوند.
                    </div>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">STT prompt (optional)</label>
                    <textarea
                      value={sttPrompt ?? ''}
                      onChange={(e) => setSttPrompt(e.target.value)}
                      rows={2}
                      placeholder="مثال: کوئرا، رفیوژ، نیم‌فاصله، اسم‌های خاص"
                    />
                    <div className="hint">
                      فقط <b>فهرست واژه‌ها</b> بنویس، نه جملهٔ دستوری. Whisper متن prompt را «حرف قبلی» فرض می‌کند و آن را ادامه می‌دهد؛ پس یک جملهٔ کامل مثل «متن را با املای درست بنویس» به‌جای صدای شما تایپ می‌شود.
                    </div>
                    </div>
                  </div>
                  <div className="voice-fallbacks">
                  <label className="field-label">STT fallbacks</label>
                  <div className="hint">به ترتیب از بالا تلاش می‌شوند.</div>
                  {sttFallbacks.map((fb, i) => (
                    <div key={i} className="voice-fallback-card">
                      <select value={fb.providerId} onChange={(e) => {
                        const next = [...sttFallbacks]
                        next[i] = { ...next[i], providerId: e.target.value }
                        setSttFallbacks(next)
                      }} dir="ltr">
                        {providers.filter((p) => p.kind !== 'ollama').map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                          </option>
                        ))}
                      </select>
                      <input value={fb.model} onChange={(e) => {
                        const next = [...sttFallbacks]
                        next[i] = { ...next[i], model: e.target.value }
                        setSttFallbacks(next)
                      }} dir="ltr" placeholder="whisper-1" />
                      <button type="button" className="btn tiny secondary voice-remove-btn" onClick={() => setSttFallbacks(sttFallbacks.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="btn tiny secondary voice-add-btn" onClick={() => setSttFallbacks([...sttFallbacks, { providerId: providers[0]?.id ?? '', model: '' }])}>+ Add STT fallback</button>
                  </div>
                </div>
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Text to Speech (TTS)</span>
                    <span className="model-card-desc">Voice output synthesis</span>
                  </div>
                </div>
                <div className="model-card-body">
                  <div className="voice-section">
                    <div className="voice-field">
                      <label className="field-label">TTS provider</label>
                    <select value={ttsProviderId} onChange={(e) => setTtsProviderId(e.target.value)} dir="ltr">
                      <option value="">Not selected</option>
                      {providers.filter((p) => p.kind !== 'ollama').map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                        </option>
                      ))}
                    </select>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">TTS model</label>
                    <input value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} dir="ltr" placeholder="tts-1" />
                    </div>
                    <div className="voice-field">
                      <label className="field-label">TTS voice</label>
                    <input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} dir="ltr" placeholder="alloy" />
                    </div>
                  </div>

                  <div className="voice-fallbacks">
                  <label className="field-label">TTS fallbacks</label>
                  <div className="hint">به ترتیب از بالا تلاش می‌شوند.</div>
                  {ttsFallbacks.map((fb, i) => (
                    <div key={i} className="voice-fallback-card">
                      <select value={fb.providerId} onChange={(e) => {
                        const next = [...ttsFallbacks]
                        next[i] = { ...next[i], providerId: e.target.value }
                        setTtsFallbacks(next)
                      }} dir="ltr">
                        <option value="">Not selected</option>
                        {providers.filter((p) => p.kind !== 'ollama').map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                          </option>
                        ))}
                      </select>
                      <input value={fb.model} onChange={(e) => {
                        const next = [...ttsFallbacks]
                        next[i] = { ...next[i], model: e.target.value }
                        setTtsFallbacks(next)
                      }} dir="ltr" placeholder="tts-1" />
                      <input value={fb.voice} onChange={(e) => {
                        const next = [...ttsFallbacks]
                        next[i] = { ...next[i], voice: e.target.value }
                        setTtsFallbacks(next)
                      }} dir="ltr" placeholder="alloy" />
                      <button type="button" className="btn tiny secondary voice-remove-btn" onClick={() => setTtsFallbacks(ttsFallbacks.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="btn tiny secondary voice-add-btn" onClick={() => setTtsFallbacks([...ttsFallbacks, { providerId: providers[0]?.id ?? '', model: '', voice: '' }])}>+ Add TTS fallback</button>
                  </div>
                </div>
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Live voice</span>
                    <span className="model-card-desc">Speech-to-speech conversation</span>
                  </div>
                </div>
                <div className="model-card-body">
                  <div className="voice-section">
                    <div className="voice-field">
                      <label className="field-label">Realtime provider (optional)</label>
                    <select value={liveProviderId} onChange={(e) => setLiveProviderId(e.target.value)} dir="ltr">
                      <option value="">Not selected — chunked STT + TTS</option>
                      {providers.filter((p) => p.kind !== 'ollama').map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                        </option>
                      ))}
                    </select>
                    <div className="hint">
                      با انتخاب پروایدر، حالت live voice تمام‌دوطرفه (realtime) روی همان پروایدر اجرا می‌شود — هر endpoint سازگار با OpenAI realtime، نه فقط OpenAI. خالی بماند، حالت چانکی با هر پروایدر STT/TTS کار می‌کند.
                    </div>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">Realtime model</label>
                    <input value={liveModel} onChange={(e) => setLiveModel(e.target.value)} dir="ltr" placeholder="gpt-realtime" />
                    </div>
                    <div className="voice-field">
                      <label className="field-label">Realtime voice</label>
                    <input value={liveVoice} onChange={(e) => setLiveVoice(e.target.value)} dir="ltr" placeholder="alloy" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
        </>
        )}

        {tab === 'general' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>Shell for the in-app terminal</label>
              </div>
              <div className="hint">
                The shell every terminal TAB of this app runs (the bottom panel and
                the right-pane tabs). Applies to the next terminal you open;
                existing sessions keep theirs.
              </div>
              <select
                value={terminalShell}
                onChange={(e) => setTerminalShell(e.target.value)}
                dir="ltr"
              >
                {SHELL_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {shellLabel(s)}
                    {s === DEFAULT_TERMINAL_SHELL ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <div className="field-head">
                <label>Auto-compaction threshold</label>
                <span className="field-value-badge">{compactAtPercent}%</span>
              </div>
              <div className="hint">
                Auto-compaction fires once the conversation reaches this percentage of the
                model's raw context window (measured by <code>total_tokens</code>, the same
                number the context meter shows). The remaining <code>{100 - compactAtPercent}%</code> is
                left as headroom. 80 = compact at 80% of the window. Lower = compact sooner
                (safer for huge contexts); higher = compact later (more recent turns kept in
                full). Range 1–99. Applies on the next message. Default: 80.
              </div>
              <div className="font-size-row">
                <span className="font-size-label">1%</span>
                <RangeSlider
                  min={1}
                  max={99}
                  step={1}
                  value={compactAtPercent}
                  onChange={setCompactAtPercent}
                  ariaLabel="Auto-compaction threshold (%)"
                />
                <span className="font-size-label">99%</span>
              </div>
            </div>

            <div className="field">
              <div className="field-head">
                <label>History turn limit</label>
                <span className="field-value-badge">{historyLimit === 0 ? 'Off' : historyLimit}</span>
              </div>
              <div className="hint">
                How many recent conversation turns are sent to the model in full each
                turn. 0 = the entire chat history (default, unchanged behaviour). N &gt; 0
                = only the last N turns verbatim, plus the compacted summary of the
                earlier turns (the one auto-compaction produced) — that summary is
                always kept, never dropped. Applies on the next message.
              </div>
              <div className="font-size-row">
                <span className="font-size-label">0</span>
                <RangeSlider
                  min={0}
                  max={200}
                  step={1}
                  value={historyLimit}
                  onChange={setHistoryLimit}
                  ariaLabel="History turn limit"
                />
                <span className="font-size-label">200</span>
              </div>
              <div className="hint">Default: 0 (full history).</div>
            </div>

            <div className="field">
              <div className="field-head">
                <label>Keyboard suggestions</label>
                <label
                  className="plugin-switch"
                  title={disableTextSuggestions ? 'Suggestions are off' : 'Suggestions are on'}
                >
                  <input
                    type="checkbox"
                    checked={disableTextSuggestions}
                    onChange={(e) => setDisableTextSuggestions(e.target.checked)}
                    aria-label="Suppress keyboard suggestions"
                  />
                  <span className="plugin-switch-track" />
                </label>
              </div>
              <div className="hint">
                Turns off the system's <b>autocomplete</b>, <b>autocorrect</b>,{' '}
                <b>inline predictions</b> and <b>spell-check</b> marks in every text field —
                the chat composer, search boxes, comment boxes and the terminal. The platform
                defaults are wrong for a coding tool: they rewrite identifiers, file paths and
                commands while you type. Applies immediately, no Save needed. Default: on
                (suggestions off).
              </div>
            </div>
        </>
        )}

          </div>
        </div>

        <div className="modal-actions">
          {hasBufferedEdits ? (
            <>
              <button className="btn secondary" onClick={onClose}>Cancel</button>
              <button className="btn" onClick={handleSave}>{saved ? 'Saved ✓' : 'Save'}</button>
            </>
          ) : (
            <button className="btn" onClick={handleDone}>Done</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Skill extra files (Codex-style) --------------------------------------- //

/** Editor for a skill's supporting files (everything besides SKILL.md). */
function SkillFilesEditor({
  serverFiles,
  extraFiles,
  deletedFiles,
  activeFile,
  newFileName,
  onSelect,
  onContentChange,
  onNewFileNameChange,
  onAdd,
  onRemove,
}: {
  serverFiles: string[]
  extraFiles: Record<string, string>
  deletedFiles: string[]
  activeFile: string
  newFileName: string
  onSelect: (file: string) => void
  onContentChange: (file: string, content: string) => void
  onNewFileNameChange: (value: string) => void
  onAdd: () => void
  onRemove: (file: string) => void
}) {
  const deleted = new Set(deletedFiles)
  const visible = [...serverFiles.filter((f) => !deleted.has(f))]
  for (const f of Object.keys(extraFiles)) if (!visible.includes(f)) visible.push(f)
  visible.sort()
  const activeContent = activeFile ? extraFiles[activeFile] : null
  const loading = activeFile !== '' && activeContent === undefined && !deleted.has(activeFile)
  return (
    <div className="skill-files" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', clear: 'both' }}>
      <div className="field-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <label>Extra files</label>
      </div>
      {visible.length === 0 ? (
        <div className="hint">Single-file skill (only skill.md). Add a supporting file below, e.g. notes.md.</div>
      ) : (
        <div className="skill-file-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {visible.map((f) => (
            <div key={f} className={`skill-file-row ${f === activeFile ? 'active' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn tiny"
                onClick={() => onSelect(f)}
                title="View/edit file content"
                style={f === activeFile ? { borderColor: 'var(--accent)' } : undefined}
              >
                {f}
              </button>
              <button className="btn tiny danger" onClick={() => onRemove(f)} title="Remove file">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {activeFile && activeContent !== null && !deleted.has(activeFile) && (
        <div className="skill-file-editor" style={{ marginTop: 8 }}>
          <label className="field-label">{activeFile}</label>
          {loading ? (
            <div className="hint">Loading {activeFile}…</div>
          ) : (
            <textarea
              className="system-prompt skill-raw"
              value={activeContent ?? ''}
              onChange={(e) => onContentChange(activeFile, e.target.value)}
              rows={8}
              dir="ltr"
              spellCheck={false}
              placeholder="File content..."
              style={{ width: '100%' }}
            />
          )}
        </div>
      )}
      <div className="skill-file-add" style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <input
          value={newFileName}
          onChange={(e) => onNewFileNameChange(e.target.value)}
          placeholder="e.g. notes.md"
          dir="ltr"
          spellCheck={false}
          style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd() }}
        />
        <button className="btn tiny" onClick={onAdd} disabled={!newFileName.trim()}>
          + Add file
        </button>
      </div>
    </div>
  )
}

// ---- Skills & MCP helpers ------------------------------------------------ //

/** Parse `name` / `description` out of a SKILL.md frontmatter block. */
function skillMeta(raw: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!m) return { name: '', description: '' }
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  return { name, description }
}

const PLACEHOLDER_SKILL_NAMES = new Set(['new-skill', 'new_skill', 'skill', 'new skill', 'untitled'])

function isPlaceholderSkillName(name: string): boolean {
  return PLACEHOLDER_SKILL_NAMES.has(name.trim().toLowerCase())
}

/** First `# Heading` after stripping frontmatter — e.g. `# Market-Analysis`. */
function skillTitleFallback(raw: string): string {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const m = /^#\s+(.+)$/m.exec(body)
  return (m?.[1] ?? '').trim()
}

/** Prefer a real frontmatter name, else the `# Title`, else the existing key. */
function resolveSkillName(content: string, key: string): string {
  const meta = skillMeta(content)
  const title = skillTitleFallback(content)
  const existing = key !== NEW_SKILL_KEY ? key : ''
  for (const candidate of [meta.name, title, existing]) {
    const v = (candidate ?? '').trim()
    if (v && !isPlaceholderSkillName(v)) return v
  }
  return 'new-skill'
}

/** Rewrite/insert frontmatter `name:` so stored file matches the resolved name. */
function withSkillName(raw: string, newName: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!m) {
    return `---\nname: ${newName}\n---\n\n${raw.replace(/^\s+/, '')}`
  }
  const block = m[1]
  const rest = raw.slice(m[0].length)
  const nextBlock = /^name:\s*.+$/m.test(block)
    ? block.replace(/^name:\s*.+$/m, `name: ${newName}`)
    : `name: ${newName}\n${block}`
  return `---\n${nextBlock}\n---\n${rest}`
}

