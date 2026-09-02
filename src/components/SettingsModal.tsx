import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { McpServerConfig, McpTransport, ProviderConfig, ProviderKind, SearchPluginConfig, SearchPluginKind } from '../types'
import { useStore, flushStateNow } from '../lib/store'
import { downloadModel, fetchModels, getModelsStatus, listSkills, removeModel, syncSkill, type ModelsStatus } from '../lib/api'
import { invalidateSkillsList } from '../lib/skills'
import { api } from '../lib/fs'
import { allModes } from '../lib/modes'
import { PROVIDER_META, providerMeta, isForeignModelId } from '../lib/provider-meta'
import { ModeIcon } from './ModeIcon'
import { THEMES } from '../lib/themes'
import { RangeSlider } from './RangeSlider'

const KIND_LABELS: Record<ProviderKind, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.label]),
) as Record<ProviderKind, string>

const BUILTIN_KINDS: ProviderKind[] = Object.values(PROVIDER_META)
  .filter((m) => m.builtin)
  .map((m) => m.kind)
const NEW_SKILL_KEY = '__new_skill__'

/** بررسی می‌کنه آیا یک پروایدر تنظیم شده (کلید API یا OAuth یا env var داره).
 *  envVarVerified: برای پروایدر فعال، مقدار async-شده envVarValue رو بفرست. */
function isProviderConfigured(p: ProviderConfig, envVarVerified?: boolean | null): boolean {
  if (providerMeta(p.kind).local) return true
  if (p.apiKey) return true
  if (p.authType === 'oauth' && p.oauthRefreshToken) return true
  if (p.envVar) {
    // فقط وقتی سبز باش که env var واقعاً وجود داشته باشه
    if (envVarVerified !== undefined) return envVarVerified === true
    // برای پروایدرهای غیرفعال نمی‌تونیم env var رو async چک کنیم → خاکستری
    return false
  }
  return false
}

/** توضیح کوتاه بر اساس kind */
function providerDescription(p: ProviderConfig): string {
  if (p.envVar) return `Env: ${p.envVar}`
  if (p.baseUrl) return p.baseUrl.replace(/^https?:\/\//, '').slice(0, 40)
  return KIND_LABELS[p.kind] || p.kind
}

function modelLabelForOpts(kind: ProviderKind, providerId: string, m: string): string {
  return PROVIDER_META[kind]?.unprefixedModelId ? m : `${providerId}/${m}`
}

/** Strip a redundant "providerId/" prefix from a model id (a model can get
 *  persisted with it, e.g. "openrouter/free"), so it is never shown or stored
 *  doubled as "openrouter/openrouter/free". */
function bareModelFor(p: ProviderConfig, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
}

// Live model lists fetched from each provider's /models endpoint, cached for
// the session so reopening the picker doesn't refetch unchanged providers.
const SUBAGENT_LIVE_CACHE = new Map<string, string[]>()

function providerSig(p: ProviderConfig): string {
  return [
    p.id, p.kind, p.baseUrl, p.apiKey, p.envVar,
    p.authType, p.oauthClientId, p.oauthClientSecret, p.oauthRefreshToken,
  ].join('|')
}

function ToolModelSelect({
  agent, label, desc, current, onSelect,
}: {
  agent: string
  label: string
  desc: string
  current: string
  onSelect: (agent: string, model: string) => void
}) {
  const providers = useStore((s) => s.settings.providers)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [live, setLive] = useState<Record<string, string[]>>({})
  const [fetching, setFetching] = useState<Record<string, boolean>>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const q = search.trim().toLowerCase()

  // Union of the provider's live /models results and its saved list, so the
  // subagent picker can search & pick any model the provider actually offers
  // (matching the main composer picker) — not just the ones already saved.
  // Saved entries are filtered by `removed` too so a model the user removed
  // (e.g. via Settings → Providers) doesn't sneak back into the picker just
  // because it's still in `p.models` from an earlier write. Foreign-provider
  // ids (e.g. a stale "openrouter/sonnet" that landed here via recentModels
  // migration or a hand-edited saved list) are also skipped so they don't
  // render under the wrong provider. The foreign-id check runs on the BARE
  // id `b` (post-strip), not on the raw `m` — otherwise a doubled-prefix
  // entry like "local/opencode/big-pickle" would pass the raw check (head
  // === p.id) but still render as the wrong model.
  const modelsFor = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? [])
    const out = new Set<string>()
    for (const m of live[p.id] ?? []) {
      const b = bareModelFor(p, m)
      if (isForeignModelId(p, b)) continue
      if (!removed.has(b)) out.add(b)
    }
    for (const m of p.models ?? []) {
      const b = bareModelFor(p, m)
      if (isForeignModelId(p, b)) continue
      if (!removed.has(b)) out.add(b)
    }
    if (p.model) {
      const b = bareModelFor(p, p.model)
      if (!isForeignModelId(p, b) && !removed.has(b)) out.add(b)
    }
    return Array.from(out)
  }

  const ensureFetched = (p: ProviderConfig) => {
    const sig = providerSig(p)
    if (SUBAGENT_LIVE_CACHE.has(sig)) {
      const cached = SUBAGENT_LIVE_CACHE.get(sig)!
      setLive((l) => (l[p.id] === cached ? l : { ...l, [p.id]: cached }))
      return
    }
    if (fetching[p.id]) return
    setFetching((f) => ({ ...f, [p.id]: true }))
    fetchModels(p)
      .then((res) => {
        SUBAGENT_LIVE_CACHE.set(sig, res.models)
        setLive((l) => ({ ...l, [p.id]: res.models }))
      })
      .catch(() => {
        /* keep the provider's saved list when /models is unavailable */
      })
      .finally(() => {
        setFetching((f) => ({ ...f, [p.id]: false }))
      })
  }

  // Kick off a live /models fetch for every provider when the menu opens.
  useEffect(() => {
    if (!open) return
    for (const p of providers) ensureFetched(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // `current` is stored as "providerId/model" (route through that provider).
  // Legacy values may still be a bare model id or carry an old prefix — resolve
  // a readable label in every case.
  const currentLabel = (() => {
    if (!current) return 'Main model'
    const slash = current.indexOf('/')
    if (slash > 0) {
      const pid = current.slice(0, slash)
      const p = providers.find((x) => x.id === pid)
      // "providerId/model": show it only when the provider is NOT the active
      // one (the subagent runs on a different provider), else show the bare
      // model id. Legacy bare ids are shown as-is. A doubled prefix from a
      // previously saved value ("providerId/providerId/model") is collapsed.
      if (p && p.id !== 'opencode') return current.startsWith(`${p.id}/${p.id}/`) ? current.slice(p.id.length + 1) : current
      if (p) return current.slice(slash + 1)
    }
    return current
  })()

  // Opening the combo box always starts from a clean search box — past
  // selection stays visible via the "active" checkmark in the list below,
  // not by pre-filling the input (which would just filter results down to
  // the current pick instead of showing everything to browse/search).
  const openMenu = () => {
    if (open) return
    setOpen(true)
    setSearch('')
  }

  const closeMenu = () => {
    setOpen(false)
    setSearch('')
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closeMenu()
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pick = (p: ProviderConfig, m: string) => {
    // Store "providerId/model" so the subagent can route through a DIFFERENT
    // provider than the active one (e.g. a local llama.cpp instance while the
    // main model is a cloud gateway). The backend resolves the prefix from the
    // saved provider config; a bare id (no prefix) still means "use the active
    // provider". This also preserves which provider a model came from in the
    // picker UI.
    onSelect(agent, `${p.id}/${bareModelFor(p, m)}`)
    closeMenu()
    inputRef.current?.blur()
  }

  // Filter providers by name AND narrow the models shown to those matching the
  // query (exactly like the composer picker), auto-expanding matches while
  // searching so the result is visible immediately.
  const visibleProviders = providers.map((p) => {
    const all = modelsFor(p)
    // Fuzzy (term-AND) search identical to the main composer picker: split the
    // query into space-separated terms and require EVERY term to appear in the
    // provider name OR model label — so any word of a model id (e.g. "deep"
    // "v4" "flash") finds it, not just the full exact string.
    const terms = q.split(/\s+/).filter(Boolean)
    const models = terms.length
      ? all.filter((m) => {
          const hay = `${p.name} ${modelLabelForOpts(p.kind, p.id, m)}`.toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
      : all
    const nameMatch = terms.length > 0 && p.name.toLowerCase().includes(q)
    const visible = !terms.length || models.length > 0 || nameMatch
    return { p, models, visible }
  }).filter((x) => x.visible)

  return (
    <div className="field">
      <div className="field-head">
        <label>{label}</label>
      </div>
      <div className="hint">{desc}</div>
      {/* Combo box: the trigger IS the search input — no separate search field
          appears only after opening. Closed, it shows the current pick as a
          placeholder (button-like); focusing/clicking it opens the dropdown
          and immediately accepts typing to filter. */}
      <div className={`model-select combo${open ? ' open' : ''}`} ref={wrapRef}>
        <div className="model-select-combo-box">
          <input
            ref={inputRef}
            className="model-select-combo-input"
            value={search}
            placeholder={open ? 'Search models…' : currentLabel}
            dir="ltr"
            onFocus={openMenu}
            onClick={openMenu}
            onChange={(e) => {
              if (!open) setOpen(true)
              setSearch(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { closeMenu(); inputRef.current?.blur() }
            }}
          />
          <span className="model-select-combo-chevron">{open ? '▴' : '▾'}</span>
        </div>
        {open && (
          <div className="model-select-dropdown combo">
            <div className="model-select-list">
              <button
                className={`model-select-item ${!current ? 'current' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onSelect(agent, ''); closeMenu(); inputRef.current?.blur() }}
                type="button"
              >
                Main model
              </button>
              {visibleProviders.map(({ p, models }) => {
                const isOpen = q ? true : expanded.has(p.id)
                return (
                  <div key={p.id} className={`pm-provider${isOpen ? ' open' : ''}`}>
                    <button
                      type="button"
                      className="pm-provider-name"
                      onClick={() => toggle(p.id)}
                    >
                      <span className="pm-provider-caret">{isOpen ? '▾' : '▸'}</span>
                      <span className="pm-provider-dot" aria-hidden />
                      <span className="pm-provider-label">{p.name}</span>
                      <span className="pm-provider-count">{modelsFor(p).length}</span>
                    </button>
                    {isOpen && (
                      <div className="pm-models">
                        {models.map((m) => {
                          // Highlight the active subagent model: current is
                          // stored as "providerId/model" now (bare model ids
                          // from legacy configs still match via the stripped
                          // comparison).
                          const isActive =
                            current === `${p.id}/${m}` ||
                            current === m ||
                            current.slice(current.indexOf('/') + 1) === m ||
                            current.slice(current.indexOf('/') + 1) === `${p.id}/${m}`
                          return (
                            <button
                              key={m}
                              type="button"
                              className={`mode-menu-item pm-model ${isActive ? 'active' : ''}`}
                              onMouseDown={(e) => { e.preventDefault(); pick(p, m) }}
                            >
                              {!PROVIDER_META[p.kind]?.unprefixedModelId && (
                                <span className="pm-model-provider">{p.id}/</span>
                              )}
                              <span className="pm-model-name">{m}</span>
                            </button>
                          )
                        })}
                        {models.length === 0 && (
                          <div className="pm-hint">No models match “{search.trim()}”.</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {visibleProviders.length === 0 && (
                <div className="pm-empty">
                  <span>No models match “{search.trim()}”.</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const SEARCH_ENGINE_KINDS: Array<{ kind: SearchPluginKind; label: string; needsKey: boolean }> = [
  { kind: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
  { kind: 'tavily', label: 'Tavily', needsKey: true },
]

/** Settings → Plugins: web-search engine priority. */
function PluginEditor() {
  const searchPlugins = useStore((s) => s.searchPlugins)
  const setSearchPlugins = useStore((s) => s.setSearchPlugins)

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
      <div className="field">
        <div className="field-head">
          <label>Web Search engines</label>
        </div>
        <div className="hint">
          The top engine is the <strong>primary</strong>; the ones below are tried in order as
          fallbacks until one returns results. DuckDuckGo needs no API key; a disabled engine is
          never used.
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
    </>
  )
}

export function SettingsModal({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const settings = useStore((s) => s.settings)
  const updateProvider = useStore((s) => s.updateProvider)
  const addProvider = useStore((s) => s.addProvider)
  const removeProvider = useStore((s) => s.removeProvider)
  const setProviderModels = useStore((s) => s.setProviderModels)
  const removeProviderModel = useStore((s) => s.removeProviderModel)
  const addRecentModel = useStore((s) => s.addRecentModel)
  const setSystemPrompt = useStore((s) => s.setSystemPrompt)
  const removeMode = useStore((s) => s.removeMode)
  const fontSize = useStore((s) => s.fontSize)
  const setFontSize = useStore((s) => s.setFontSize)
  const dataPath = useStore((s) => s.dataPath)
  const setDataPath = useStore((s) => s.setDataPath)
  const whisperModel = useStore((s) => s.whisperModel)
  const whisperBaseUrl = useStore((s) => s.whisperBaseUrl)
  const setWhisperModel = useStore((s) => s.setWhisperModel)
  const setWhisperBaseUrl = useStore((s) => s.setWhisperBaseUrl)
  const subagentModels = useStore((s) => s.subagentModels)
  const setSubagentModel = useStore((s) => s.setSubagentModel)
  const cacheTtlMinutes = useStore((s) => s.cacheTtlMinutes)
  const setMemoryTtlConfig = useStore((s) => s.setMemoryTtlConfig)
  const compactAtPercent = useStore((s) => s.settings.compactAtPercent ?? 80)
  const setCompactAtPercent = useStore((s) => s.setCompactAtPercent)
  const historyLimit = useStore((s) => s.historyLimit ?? 0)
  const setHistoryLimit = useStore((s) => s.setHistoryLimit)
  const webSearchTtlDays = useStore((s) => s.webSearchTtlDays ?? 7)
  const setWebSearchTtlDays = useStore((s) => s.setWebSearchTtlDays)
  const fetchUrlTtlDays = useStore((s) => s.fetchUrlTtlDays ?? 7)
  const setFetchUrlTtlDays = useStore((s) => s.setFetchUrlTtlDays)
  const webSearchAutoFetch = useStore((s) => s.webSearchAutoFetch ?? 3)
  const setWebSearchAutoFetch = useStore((s) => s.setWebSearchAutoFetch)
  const ragWebTtlDays = useStore((s) => s.ragWebTtlDays ?? 90)
  const setRagWebTtlDays = useStore((s) => s.setRagWebTtlDays)
  const root = useStore((s) => s.root)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  const providers = settings.providers
  // Which provider's config is being EDITED in this dialog. Deliberately NOT
  // derived from settings.activeProviderId — visiting Settings must never
  // switch the app's active provider / main model.
  const [editId, setEditId] = useState(settings.activeProviderId)
  const active = providers.find((p) => p.id === editId) ?? providers[0]

  const [cfg, setCfg] = useState<ProviderConfig>({ ...active })
  const [customModel, setCustomModel] = useState('')
  const [saved, setSaved] = useState(false)
  // Google OAuth sign-in progress: "" idle, "busy" while the consent window is
  // open, "ok"/"error" + message when the flow settles.
  const [oauthState, setOauthState] = useState<{ status: string; msg: string }>({ status: '', msg: '' })
  const [envVarValue, setEnvVarValue] = useState<boolean | null>(null)
  // وضعیت env var همه پروایدرها — برای dot تب‌ها استفاده می‌شه
  const [providerEnvMap, setProviderEnvMap] = useState<Map<string, boolean>>(new Map())
  // Which credential source the provider being edited will use: 'env' (an
  // environment variable that must already exist) or 'key' (an API key stored
  // encrypted at rest). Exactly ONE is active — the user picks, never both.
  const [credMode, setCredMode] = useState<'env' | 'key'>(() => ((cfg.apiKey ?? '').trim() ? 'key' : 'env'))
  // True once Save was blocked for a provider that has no usable credential.
  const [credWarn, setCredWarn] = useState(false)
  // Readiness checks for the provider being edited (drives the banner at the
  // top of the form so the problem is visible BEFORE a message is sent).
  const hasSavedKey = !!(cfg.apiKey ?? '').trim()
  const credentialReady = envVarValue === true || hasSavedKey
  const oauthReady = providerMeta(cfg.kind).oauth && cfg.authType === 'oauth' && !!(cfg.oauthRefreshToken ?? '')
  const requiresKey = providerMeta(cfg.kind).requiresKey
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {}
    for (const m of allModes(settings)) d[m.id] = settings.systemPrompts?.[m.id] ?? ''
    return d
  })

  // Filter the active provider's model list: strip foreign-provider IDs that
  // may have leaked in through stale state or cross-provider merge, matching
  // the filter applied in ToolModelSelect.modelsFor / ProviderModelSelect.allModels.
  const settingsModelsFor = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? [])
    return (p.models ?? []).filter((m) => {
      const b = bareModelFor(p, m)
      return !removed.has(b) && !isForeignModelId(p, b)
    })
  }

  const [tab, setTab] = useState<'providers' | 'auth' | 'plugins' | 'modes' | 'appearance' | 'skills' | 'mcp' | 'storage' | 'tools' | 'models' | 'general'>(initialTab as any || 'providers')
  const googleProvider = providers.find((p) => p.kind === 'google')
  const [googleAuthDraft, setGoogleAuthDraft] = useState<{ clientId: string; clientSecret: string }>({
    clientId: googleProvider?.oauthClientId ?? '',
    clientSecret: googleProvider?.oauthClientSecret ?? '',
  })
  useEffect(() => {
    setGoogleAuthDraft({
      clientId: googleProvider?.oauthClientId ?? '',
      clientSecret: googleProvider?.oauthClientSecret ?? '',
    })
  }, [googleProvider?.oauthClientId, googleProvider?.oauthClientSecret])

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

  // ---- Managed on-device models (Settings → Models) ----
  const [mStatus, setMStatus] = useState<ModelsStatus | null>(null)
  const [modelsMsg, setModelsMsg] = useState('')
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

  const refreshModels = useCallback(async () => {
    setMStatus(await getModelsStatus())
  }, [])

  // Poll while the modal is open so download progress / completion shows live.
  useEffect(() => {
    void refreshModels()
    const id = setInterval(() => void refreshModels(), 2500)
    return () => clearInterval(id)
  }, [refreshModels])

  const isRunning = (kind: 'whisper' | 'embedding') =>
    (kind === 'whisper' ? mStatus?.whisper : mStatus?.embedding)?.running?.state ===
    'downloading'

  const actDownload = async (kind: 'whisper' | 'embedding') => {
    const repo = kind === 'whisper' ? whisperModel : 'intfloat/multilingual-e5-base'
    const base = kind === 'whisper' ? whisperBaseUrl : ''
    setModelsMsg('')
    try {
      await downloadModel(kind, repo, base)
      setModelsMsg(`Downloading ${repo}… (status below updates automatically)`)
      void refreshModels()
    } catch (err) {
      setModelsMsg(`Download failed: ${(err as Error).message}`)
    }
  }

  const actRemove = async (kind: 'whisper' | 'embedding', repo: string) => {
    setModelsMsg('')
    try {
      await removeModel(kind, repo)
      void refreshModels()
    } catch (err) {
      setModelsMsg(`Remove failed: ${(err as Error).message}`)
    }
  }

  const modes = allModes(settings)

  // ---- Skills & MCP tab state ----
  const mcpServers = settings.mcpServers ?? {}
  const builtinMcp = useStore((s) => s.builtinMcp)
  const addMcpServer = useStore((s) => s.addMcpServer)
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const [skills, setSkills] = useState<Array<{ name: string; path: string; raw: string }>>([])
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({})
  const [skillsMsg, setSkillsMsg] = useState('')
  const [skillFilter, setSkillFilter] = useState('')
  const [mcpFilter, setMcpFilter] = useState('')
  const [addingMcp, setAddingMcp] = useState(false)
  const skillListRef = useRef<HTMLDivElement | null>(null)

  const reloadSkills = useCallback(async (preferName?: string) => {
    const rows = await listSkills()
    const found = rows.map((r) => ({ name: r.name, path: r.path, raw: r.content }))
    setSkills(found)
    setSkillDrafts((prev) => {
      const names = new Set(found.map((f) => f.name))
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) if (names.has(k)) next[k] = v
      return next
    })
    if (preferName) {
      setExpandedSkills((prev) => new Set(prev).add(preferName))
      setSkillDrafts((prev) =>
        prev[preferName] !== undefined
          ? prev
          : { ...prev, [preferName]: found.find((f) => f.name === preferName)?.raw ?? '' },
      )
    }
  }, [])

  useEffect(() => {
    void reloadSkills()
  }, [reloadSkills])

  const toggleSkill = (name: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setSkillDrafts((prev) => {
      if (prev[name] !== undefined) return prev
      return { ...prev, [name]: skills.find((x) => x.name === name)?.raw ?? '' }
    })
    setSkillsMsg('')
  }

  const saveSkill = async (name: string) => {
    const content = skillDrafts[name] ?? ''
    const meta = skillMeta(content)
    const newName = (meta.name || (name !== NEW_SKILL_KEY ? name : '') || 'new-skill').trim()
    if (!content.trim()) {
      setSkillsMsg('Nothing to save.')
      return
    }
    const res = await syncSkill({
      name: newName,
      previousName: name !== NEW_SKILL_KEY && name !== newName ? name : '',
      content,
    })
    setSkillsMsg(res.ok ? 'Saved ✓' : `Save failed: ${res.note ?? 'unknown error'}`)
    if (res.ok) {
      const savedName = res.name || newName
      setSkillDrafts((prev) => {
        const next = { ...prev }
        if (name !== NEW_SKILL_KEY && name !== savedName) delete next[name]
        next[savedName] = content
        return next
      })
      setExpandedSkills((prev) => {
        const next = new Set(prev)
        if (name === NEW_SKILL_KEY || name !== savedName) next.delete(name)
        next.add(savedName)
        return next
      })
      void reloadSkills(savedName)
      invalidateSkillsList()
    }
  }

  const deleteSkill = async (name: string) => {
    if (!window.confirm(`Delete skill "${name}"?`)) return
    const res = await syncSkill({ name, delete: true })
    setSkillsMsg(res.ok ? 'Deleted.' : `Delete failed: ${res.note ?? 'unknown error'}`)
    if (res.ok) {
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
      void reloadSkills()
      invalidateSkillsList()
    }
  }

  const newSkill = () => {
    setExpandedSkills((prev) => new Set(prev).add(NEW_SKILL_KEY))
    setSkillDrafts((prev) => ({
      ...prev,
      [NEW_SKILL_KEY]:
        '---\nname: new-skill\n---\n\n# New skill\n\nStep-by-step instructions the agent follows when this skill matches.\n',
    }))
    setSkillsMsg('Editing a new skill — fill in the details, then press Save skill.')
    // The "New skill" editor renders at the TOP of the list; if the user had
    // scrolled down, scroll the list back to the top so it's immediately visible.
    requestAnimationFrame(() => skillListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
  }

  // Keep the local editor in sync when the edited provider changes.
  useEffect(() => {
    setCfg({ ...active })
    setCustomModel('')
  }, [editId, active.id])

  // Derive the credential method when switching providers: a saved API key wins,
  // otherwise show the env-var option (so the default env var names never look
  // like configured keys).
  useEffect(() => {
    setCredMode((cfg.apiKey ?? '').trim() ? 'key' : 'env')
    setCredWarn(false)
  }, [editId, active.id])

  // Check whether the provider's env var currently has a value in the environment.
  useEffect(() => {
    let cancelled = false
    const ev = (cfg.envVar || '').trim()
    if (!ev) {
      setEnvVarValue(null)
      return
    }
    void (async () => {
      const val = await api.getEnv(ev)
      if (!cancelled) setEnvVarValue(!!val)
    })()
    return () => {
      cancelled = true
    }
  }, [cfg.envVar, active.id])

  // چک کردن env var همه پروایدرها هنگام باز شدن modal — نتیجه برای dot تب‌ها
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const results = new Map<string, boolean>()
      await Promise.all(
        providers.map(async (p) => {
          const ev = (p.envVar || '').trim()
          if (!ev) return
          try {
            const val = await api.getEnv(ev)
            results.set(p.id, !!val)
          } catch { /* ignore */ }
        }),
      )
      if (!cancelled) setProviderEnvMap(results)
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch & persist the model list for the active provider (merged with any
  // manually added models so they are never overwritten). Models the user
  // explicitly removed stay removed — they are excluded from the merge.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchModels(cfg)
        if (cancelled) return
        useStore.getState().setProviderContextMap(active.id, res.context)
        useStore.getState().setProviderReasoningMap(active.id, res.reasoning)
        if (res.models.length > 0) {
          const current = useStore.getState().settings.providers.find((p) => p.id === active.id)
          const existing = current?.models ?? []
          const removed = new Set(current?.removedModels ?? [])
          const fetchedBare = new Set(res.models.map((m) => bareModelFor(active, m)))
          setProviderModels(
            active.id,
            Array.from(new Set([
              ...res.models.filter((m) => !removed.has(m) && !isForeignModelId(active, bareModelFor(active, m))),
              ...existing.filter((m) => fetchedBare.has(bareModelFor(active, m)) && !isForeignModelId(active, bareModelFor(active, m))),
            ])),
          )
        }
        setCfg((c) => {
          const first = res.models[0]
          return { ...c, model: c.model || first }
        })
      } catch {
        /* /models may be unreachable; keep the saved list */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, cfg.baseUrl, cfg.apiKey, cfg.kind])

  const addCustomModel = () => {
    const m = customModel.trim()
    if (!m) return
    setProviderModels(active.id, [...(active.models ?? []), m])
    setCustomModel('')
  }

  const setPrompt = (mode: string, value: string) =>
    setPromptDrafts((d) => ({ ...d, [mode]: value }))

  const persistGoogleAuth = (patch: Partial<ProviderConfig>) => {
    if (googleProvider) updateProvider(googleProvider.id, patch)
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
        authType: 'oauth',
        oauthClientId: cid,
        oauthClientSecret: googleAuthDraft.clientSecret,
        oauthRefreshToken: res.refreshToken,
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
    persistGoogleAuth({ authType: '', oauthRefreshToken: '' })
    setOauthState({ status: 'ok', msg: 'Google account disconnected.' })
  }

  // Switching to the env-var method drops any stored API key so only ONE
  // credential ever applies (the backend prefers a stored key over an env var).
  const switchCredMode = (m: 'env' | 'key') => {
    setCredWarn(false)
    if (m === 'env') setCfg({ ...cfg, apiKey: '' })
    setCredMode(m)
  }

  const save = async () => {
    // Providers that REQUIRE a credential must not be saved in a broken state
    // (empty env var + no saved key + no OAuth) — that is exactly how a user
    // ends up with the "Set the GOOGLE_API_KEY environment variable" error.
    if (
      requiresKey &&
      !oauthReady &&
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
    const { models: _models, removedModels: _removed, ...cfgPersist } = cfgPersistFull
    updateProvider(active.id, {
      ...cfgPersist,
      model: liveProvider?.model ?? active.model,
      models: liveProvider?.models ?? [],
      removedModels: liveProvider?.removedModels ?? [],
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
      group: 'Connection',
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
      group: 'Connection',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15" r="1.2" />
        </svg>
      ),
    },
    {
      id: 'plugins',
      label: 'Plugins',
      group: 'Agent',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2v6h6M9 7a2 2 0 0 1 2-2h3l5 5v3a2 2 0 0 1-2 2h-1v9l-2 1V15h-3a2 2 0 0 1-2-2v-1H9a2 2 0 0 1-2-2v-1H7a2 2 0 0 1-2-2V7h4z" />
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
      id: 'tools',
      label: 'Tools',
      group: 'Agent',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
          <circle cx="18" cy="7" r="2.2" /><path d="M15.2 13a5 5 0 0 1 5.8 4.9" />
        </svg>
      ),
    },
    {
      id: 'skills',
      label: 'Skills',
      group: 'Knowledge',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
        </svg>
      ),
    },
    {
      id: 'mcp',
      label: 'MCP',
      group: 'Knowledge',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
          <rect x="6" y="6" width="12" height="12" rx="2.5" />
        </svg>
      ),
    },
    {
      id: 'storage',
      label: 'Storage',
      group: 'Knowledge',
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
      id: 'models',
      label: 'Models',
      group: 'App',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5 6.5 6.5M17.5 17.5l2 2M4.5 19.5l2-2M17.5 6.5l2-2" />
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
      if (cid || csec) persistGoogleAuth({ oauthClientId: cid, oauthClientSecret: csec })
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
                  className={`provider-tab-dot ${isProviderConfigured(p, providerEnvMap.get(p.id)) ? 'ok' : 'off'}`}
                  title={isProviderConfigured(p, providerEnvMap.get(p.id)) ? 'Configured' : 'Not configured'}
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
            ) : oauthReady ? (
              <div className="env-key-hint ok">
                <span className="status-dot ok" />
                Ready — connected via your Google account (Settings → Auth).
              </div>
            ) : credentialReady ? (
              <div className="env-key-hint ok">
                <span className="status-dot ok" />
                Ready — authenticated via{' '}
                {hasSavedKey ? 'saved API key' : cfg.envVar ? `env var ${cfg.envVar}` : 'the default env var'}
                .
              </div>
            ) : requiresKey ? (
              <div className="env-key-hint fail">
                <span className="status-dot fail" />
                No credential configured. Choose either an environment variable or a saved API key below —
                otherwise this provider can't connect.
                {credWarn && ' Save was blocked until you configure one.'}
              </div>
            ) : (
              <div className="env-key-hint fail">
                <span className="status-dot fail" />
                No API key set — the provider will use an environment variable if one is available, or may
                work without a key.
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

            {providerMeta(cfg.kind).editableBaseUrl && (
              <div className="field">
                <label>Base URL</label>
                <input
                  value={cfg.baseUrl}
                  onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                  placeholder={providerMeta(cfg.kind).local ? 'http://localhost:11434' : 'http://localhost:8080/v1'}
                  dir="ltr"
                />
                <div className="hint">
                  {providerMeta(cfg.kind).local
                    ? 'Local endpoint (llama.cpp-compatible). Also works with Ollama and vLLM.'
                    : 'Any OpenAI-compatible API (llama.cpp, vLLM, LocalAI, LM Studio, …).'}
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
                <label>Credential — pick one method</label>
                <div className="cred-mode-toggle">
                  <button
                    type="button"
                    className={credMode === 'env' ? 'active' : ''}
                    onClick={() => switchCredMode('env')}
                  >
                    Environment variable
                  </button>
                  <button
                    type="button"
                    className={credMode === 'key' ? 'active' : ''}
                    onClick={() => switchCredMode('key')}
                  >
                    Saved API key (encrypted)
                  </button>
                </div>
                <div className="hint">
                  Codifa uses the method you choose — never both. Picking a name in "Env var name" alone is
                  not a key: the variable must actually exist in your environment.
                </div>

                {credMode === 'env' ? (
                  <div className="cred-block">
                    <label className="field-label">Env var name</label>
                    <input
                      value={cfg.envVar ?? ''}
                      onChange={(e) => setCfg({ ...cfg, envVar: e.target.value.trim(), apiKey: '' })}
                      placeholder="e.g. OPENROUTER_API_KEY — must be set in your environment"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {envVarValue === false && (
                      <div className="hint fail" style={{ marginTop: 4 }}>
                        Env var not found in your environment. Switch to "Saved API key" mode to paste a key directly.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="cred-block">
                    <label className="field-label">API key — skip environment variables entirely</label>
                    <input
                      type="password"
                      value={cfg.apiKey ?? ''}
                      onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                      placeholder="Paste your real Gemini key here"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <div className="hint" style={{ marginTop: 4 }}>
                      Nothing is stored yet — paste the actual key value here and it will be encrypted
                      (AES-256-GCM) when you press Save. This is an alternative to the environment
                      variable method, not the place to type a variable name.
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label>Models for this provider</label>
              <div className="hint">
                Models are fetched live from this provider’s <code>/models</code> endpoint. Models you
                pick in the composer and custom ones added below are saved to the database for this
                provider.
              </div>
              {settingsModelsFor(active).length === 0 ? (
                <div className="hint">No models saved yet — they appear here after fetching or adding one.</div>
              ) : (
                <div className="model-tags">
                  {settingsModelsFor(active).map((m) => (
                    <span key={m} className={`model-tag ${m === cfg.model ? 'current' : ''}`}>
                      {m}
                      <button
                        className="model-tag-remove"
                        title="Remove model"
                        onClick={() => removeProviderModel(active.id, m)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="model-add-row">
                <input
                  className="model-add-input"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustomModel()
                  }}
                  placeholder="Add a custom model id"
                  dir="ltr"
                />
                <button className="btn tiny" onClick={addCustomModel} disabled={!customModel.trim()}>
                  Add
                </button>
              </div>
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
              One sign-in connects Gemini models (Settings → Providers) and the Search
              Console tool (Settings → Plugins). Create an OAuth 2.0 Desktop client in the
              Google Cloud Console (APIs &amp; Services → Credentials), paste its id and
              secret below, then sign in.
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
                <li>If prompted, enable the APIs: <strong>Generative Language API</strong> and <strong>Google Search Console API</strong> (APIs &amp; Services → Library → search each → Enable).</li>
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
                One client is enough for both Gemini and Search Console — the sign-in below asks
                for all the needed permissions in a single Google consent.
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
              {googleProvider?.authType === 'oauth' && googleProvider?.oauthRefreshToken ? (
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
              Connected: {googleProvider?.authType === 'oauth' && googleProvider?.oauthRefreshToken ? 'yes' : 'no'}. The
              same sign-in also powers the Search Console tool automatically — you don't need a
              separate connection.
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
        </>
        )}

        {tab === 'mcp' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>MCP Tool Connectors</label>
                <button
                  className="btn tiny"
                  onClick={() => {
                    setAddingMcp((v) => !v)
                    setMcpFilter('')
                  }}
                >
                  {addingMcp ? 'Cancel' : '+ Add MCP'}
                </button>
              </div>
              <div className="hint">
                MCP servers expose extra tools to the agent (filesystem, databases, APIs…). Connectors
                are stored in the app database and changes apply on the next message in any mode.
                Env/header values support{' '}
                <code>{'${VAR}'}</code> and <code>{'${VAR:-default}'}</code> expansion from your shell
                environment. Add a new connector by typing <code>/mcp &lt;description&gt;</code> in the chat,
                or press <b>+ Add MCP</b> above.
              </div>
              <div className="settings-search">
                <input
                  type="search"
                  value={mcpFilter}
                  onChange={(e) => setMcpFilter(e.target.value)}
                  placeholder="Search connectors…"
                  dir="ltr"
                />
              </div>
              <div className="mcp-list">
                {addingMcp && (
                  <McpEditor
                    key="__new__"
                    initialName=""
                    initialCfg={{}}
                    defaultOpen
                    onSave={(_oldName, newName, next) => {
                      addMcpServer(newName, next)
                      setAddingMcp(false)
                    }}
                    onDelete={() => setAddingMcp(false)}
                  />
                )}
                {Object.entries(mcpServers).length === 0 && !addingMcp && (
                  <div className="hint">No MCP connectors yet. Add one with <code>/mcp &lt;description&gt;</code> in the chat.</div>
                )}
                {Object.entries(mcpServers)
                  .filter(([name, cfg]) => {
                    const q = mcpFilter.trim().toLowerCase()
                    if (!q) return true
                    const summary = `${name} ${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')} ${cfg.url ?? ''}`
                    return summary.toLowerCase().includes(q)
                  })
                  .map(([name, cfg]) => (
                  <McpEditor
                    key={name}
                    initialName={name}
                    initialCfg={cfg}
                    builtin={builtinMcp.includes(name)}
                    onSave={(oldName, newName, next) => {
                      if (oldName && oldName !== newName) removeMcpServer(oldName)
                      addMcpServer(newName, next)
                    }}
                    onDelete={(n) => {
                      if (window.confirm(`Delete MCP connector "${n}"?`)) removeMcpServer(n)
                    }}
                  />
                ))}
              </div>
            </div>
        </>
        )}

        {tab === 'skills' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>Skills</label>
                <button className="btn tiny" onClick={newSkill}>+ New skill</button>
              </div>
              <div className="hint">
                Skills are stored in the app database and matched to your messages semantically:
                when a request matches a skill, the agent follows its instructions. Create new skills
                by typing <code>/skill &lt;description&gt;</code> in the chat, or add them here.
              </div>
              <div className="settings-search">
                <input
                  type="search"
                  value={skillFilter}
                  onChange={(e) => setSkillFilter(e.target.value)}
                  placeholder="Search skills…"
                  dir="ltr"
                />
              </div>
              <div className="skill-list" ref={skillListRef}>
                {skills.length === 0 && (
                  <div className="hint">No skills yet. Create one with <code>/skill &lt;description&gt;</code> in the chat.</div>
                )}
                {expandedSkills.has(NEW_SKILL_KEY) && (
                  <div className="skill-card open">
                    <div className="skill-card-head">
                      <span className="skill-chevron open">▶</span>
                      <span className="skill-card-name">New skill</span>
                    </div>
                    <div className="skill-card-body">
                      <textarea
                        className="system-prompt skill-raw"
                        value={skillDrafts[NEW_SKILL_KEY] ?? ''}
                        onChange={(e) =>
                          setSkillDrafts((prev) => ({ ...prev, [NEW_SKILL_KEY]: e.target.value }))
                        }
                        rows={12}
                        dir="ltr"
                        spellCheck={false}
                      />
                      <div className="prompt-actions">
                        <span className="hint">{skillsMsg}</span>
                        <div className="skill-actions">
                          <button className="btn tiny" onClick={() => saveSkill(NEW_SKILL_KEY)}>
                            Save skill
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {skills
                  .filter((s) => {
                    const q = skillFilter.trim().toLowerCase()
                    if (!q) return true
                    const meta = skillMeta(s.raw)
                    return `${s.name} ${meta.name} ${meta.description}`.toLowerCase().includes(q)
                  })
                  .map((s) => {
                    const meta = skillMeta(s.raw)
                    const desc = meta.description
                    const isOpen = expandedSkills.has(s.name)
                    return (
                      <div
                        key={s.name}
                        className={`skill-card ${isOpen ? 'open' : ''}`}
                      >
                        <div className="skill-card-head" onClick={() => toggleSkill(s.name)}>
                          <span className={`skill-chevron ${isOpen ? 'open' : ''}`}>▶</span>
                          <span className="skill-card-name">{meta.name || s.name}</span>
                          {desc && <span className="skill-card-desc">{desc}</span>}
                        </div>
                        {isOpen && (
                          <div className="skill-card-body">
                            <textarea
                              className="system-prompt skill-raw"
                              value={skillDrafts[s.name] ?? s.raw}
                              onChange={(e) =>
                                setSkillDrafts((prev) => ({ ...prev, [s.name]: e.target.value }))
                              }
                              rows={12}
                              dir="ltr"
                              spellCheck={false}
                            />
                            <div className="prompt-actions">
                              <span className="hint">{skillsMsg}</span>
                              <div className="skill-actions">
                                <button className="btn tiny danger" onClick={() => deleteSkill(s.name)}>
                                  Delete
                                </button>
                                <button className="btn tiny" onClick={() => saveSkill(s.name)}>
                                  Save skill
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
        </>
        )}

        {tab === 'storage' && (
        <>
          {/* ===== Web & Fetch cache TTL (separate) ===== */}
          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-icon">🌐</span>
              <div>
                <div className="settings-group-title">Web &amp; Fetch cache</div>
                <div className="settings-group-desc">
                  How long web search results and fetched pages stay cached before a re-fetch.
                  Set each separately — web results change faster than fetched docs.
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Web search cache TTL</div>
                <div className="settings-row-desc">
                  How long <b>web search results</b> stay cached. Default: <code>7</code> days.
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={webSearchTtlDays}
                  onChange={(e) => setWebSearchTtlDays(Number(e.target.value))}
                  dir="ltr"
                  aria-label="Web search cache TTL in days"
                />
                <span className="field-unit">days</span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Fetch URL cache TTL</div>
                <div className="settings-row-desc">
                  How long <b>fetched pages</b> stay cached. Default: <code>7</code> days.
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={fetchUrlTtlDays}
                  onChange={(e) => setFetchUrlTtlDays(Number(e.target.value))}
                  dir="ltr"
                  aria-label="Fetch URL cache TTL in days"
                />
                <span className="field-unit">days</span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">Auto-fetch top results</div>
                <div className="settings-row-desc">
                  How many of <b>web_search</b>'s top results get their real page content fetched
                  (not just a snippet) before answering. <code>0</code> disables this and falls
                  back to snippet-only results. Default: <code>3</code>.
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={webSearchAutoFetch}
                  onChange={(e) => setWebSearchAutoFetch(Number(e.target.value))}
                  dir="ltr"
                  aria-label="Web search auto-fetch top N results"
                />
                <span className="field-unit">results</span>
              </div>
            </div>
          </div>

          {/* ===== RAG web/fetch storage TTL ===== */}
          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-icon">🗄️</span>
              <div>
                <div className="settings-group-title">RAG storage (web/fetch)</div>
                <div className="settings-group-desc">
                  When an embedding model is available, web/fetch results are also stored in the
                  local vector store for semantic recall. This is <b>optional</b> — without an
                  embedding model, web search and fetch still work (just no RAG recall).
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-title">RAG web/fetch storage TTL</div>
                <div className="settings-row-desc">
                  How long stored web/fetch chunks remain in the vector store before expiring.
                  Default: <code>90</code> days.
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={ragWebTtlDays}
                  onChange={(e) => setRagWebTtlDays(Number(e.target.value))}
                  dir="ltr"
                  aria-label="RAG web/fetch storage TTL in days"
                />
                <span className="field-unit">days</span>
              </div>
            </div>
          </div>

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
            <div className="field-head">
              <label>Tool Models</label>
            </div>
            <div className="hint">
              Pick separate models for the built-in tools (web, vision,
              compact, explore). Leave a field empty to use the main model (the one chosen in the
              composer), or type "main model" to pin a tool to the main model explicitly.
              Tools only consume main-model tokens when you set them to the main model or
              their own model is unavailable.
            </div>

            <ToolModelSelect
              agent="web"
              label="Web tool"
              desc="Model that distills web_search results and summarizes fetched pages. Falls back to the explore model."
              current={subagentModels.web || ''}
              onSelect={setSubagentModel}
            />
            <ToolModelSelect
              agent="vision"
              label="Vision model"
              desc="Image analysis model (handles screenshots, diagrams and photos)."
              current={subagentModels.vision || ''}
              onSelect={setSubagentModel}
            />
            <ToolModelSelect
              agent="compact"
              label="Compact model"
              desc="Conversation summariser — compacts chat history to stay under the context window."
              current={subagentModels.compact || ''}
              onSelect={setSubagentModel}
            />
            <ToolModelSelect
              agent="explore"
              label="Explore model"
              desc="Read-only research sub-agent (grep/glob/read over the codebase). Falls back to the main model."
              current={subagentModels.explore || ''}
              onSelect={setSubagentModel}
            />
          </div>
        </>
        )}

        {tab === 'models' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>On-device Models</label>
              </div>
              <div className="hint">
                These run fully offline on your machine. Downloads use an optional
                HuggingFace mirror (leave empty for <code>huggingface.co</code>). Status
                refreshes automatically while a download runs.
              </div>
              {modelsMsg && <div className="hint" style={{ color: 'var(--accent)' }}>{modelsMsg}</div>}

              <div className="mcp-card open">
                <div className="mcp-card-head">
                  <span className="mcp-chevron open">▶</span>
                  <span className="mcp-card-title">Whisper — Voice input</span>
                  <span className={`status-dot ${(mStatus?.whisper?.dirs ?? []).length > 0 ? 'ok' : ''}`} />
                </div>
                <div className="mcp-fields">
                  <label className="field-label">Model (HF repo id)</label>
                  <input value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)} dir="ltr" placeholder="Systran/faster-whisper-medium" />
                  <label className="field-label">Mirror base URL (optional)</label>
                  <input value={whisperBaseUrl} onChange={(e) => setWhisperBaseUrl(e.target.value)} dir="ltr" placeholder="e.g. https://hf-mirror.com" />
                  <ModelStatusLine status={mStatus?.whisper} running={isRunning('whisper')} onRemove={() => actRemove('whisper', whisperModel)} />
                  <div className="skill-actions">
                    {(mStatus?.whisper?.dirs ?? []).length === 0 && (
                      <button className="btn tiny" disabled={isRunning('whisper')} onClick={() => actDownload('whisper')}>
                        {isRunning('whisper') ? 'Downloading…' : 'Download'}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="mcp-card open">
                <div className="mcp-card-head">
                  <span className="mcp-chevron open">▶</span>
                  <span className="mcp-card-title">Embedding — RAG memory</span>
                  <span className={`status-dot ${(mStatus?.embedding?.dirs ?? []).some((d) => d.ready) ? 'ok' : ''}`} />
                </div>
                <div className="mcp-fields">
                  <div className="hint">
                    The embedding model downloads automatically in the background (default:
                    <code> intfloat/multilingual-e5-base</code>). RAG for web/fetch is optional —
                    if the model isn't downloaded yet, web search and fetch still work without it.
                  </div>
                  <ModelStatusCard status={mStatus?.embedding} running={isRunning('embedding')} onRemove={(repo) => actRemove('embedding', repo)} />
                  <div className="skill-actions">
                    {(!(mStatus?.embedding?.dirs ?? []).some((d) => d.ready) || isRunning('embedding')) && (
                      <button className="btn tiny" disabled={isRunning('embedding')} onClick={() => actDownload('embedding')}>
                        {isRunning('embedding') ? 'Downloading…' : 'Download'}
                      </button>
                    )}
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
                = only the last N turns verbatim, plus a compact summary of the earlier
                turns. The summary is merged by auto-compaction (not re-expanded), so it
                stays compatible with the context window. Lower = less token usage; higher
                = more prior context kept. Applies on the next message.
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

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 MB'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Whisper card status line: running → error → downloaded (single dir) → empty. */
function ModelStatusLine({
  status,
  running,
  onRemove,
}: {
  status?: import('../lib/api').ModelKindStatus
  running: boolean
  onRemove: () => void
}) {
  if (running) return <div className="hint">Downloading…</div>
  if (status?.running?.state === 'error')
    return (
      <div className="hint" style={{ color: 'var(--danger)' }}>
        Download failed: {status.running.error}
      </div>
    )
  const dirs = status?.dirs ?? []
  if (dirs.length === 0) return <div className="hint">Not downloaded.</div>
  return (
    <div className="skill-actions">
      <span className="hint">Downloaded · {fmtBytes(dirs[0].size)}</span>
      <button className="btn tiny danger" onClick={onRemove}>
        Remove
      </button>
    </div>
  )
}

/** Embedding card: lists every downloaded repo build with its own Remove. */
function ModelStatusCard({
  status,
  running,
  onRemove,
}: {
  status?: import('../lib/api').ModelKindStatus
  running: boolean
  onRemove: (repo: string) => void
}) {
  if (running) return <div className="hint">Downloading…</div>
  if (status?.running?.state === 'error')
    return (
      <div className="hint" style={{ color: 'var(--danger)' }}>
        Download failed: {status.running.error}
      </div>
    )
  const dirs = status?.dirs ?? []
  if (dirs.length === 0)
    return (
      <div className="hint">
        Not downloaded — RAG memory &amp; web recall stay off until you download one.
      </div>
    )
  return (
    <div className="mcp-list">
      {dirs.map((d) => (
        <div key={d.dir} className="skill-actions">
          <span className="hint">
            <code>{d.repo}</code> · {fmtBytes(d.size)}
            {d.ready ? ' · ready' : ' · incomplete'}
          </span>
          <button className="btn tiny danger" onClick={() => onRemove(d.repo)}>
            Remove
          </button>
        </div>
      ))}
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

function kvToText(kv: Record<string, string>): string {
  return Object.entries(kv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function splitArgs(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function McpEditor({
  initialName,
  initialCfg,
  builtin = false,
  defaultOpen = false,
  onSave,
  onDelete,
}: {
  initialName: string
  initialCfg: McpServerConfig
  builtin?: boolean
  defaultOpen?: boolean
  onSave: (oldName: string, newName: string, cfg: McpServerConfig) => void
  onDelete: (name: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [type, setType] = useState<McpTransport>(
    initialCfg.command
      ? 'stdio'
      : initialCfg.url
        ? initialCfg.headers
          ? 'http'
          : 'sse'
        : 'stdio',
  )
  const [command, setCommand] = useState(initialCfg.command ?? '')
  const [args, setArgs] = useState((initialCfg.args ?? []).join(' '))
  const [url, setUrl] = useState(initialCfg.url ?? '')
  const [env, setEnv] = useState(kvToText(initialCfg.env ?? {}))
  const [headers, setHeaders] = useState(kvToText(initialCfg.headers ?? {}))
  const [error, setError] = useState('')
  const [open, setOpen] = useState(defaultOpen)

  const transportLabel: Record<McpTransport, string> = {
    stdio: 'stdio',
    http: 'HTTP',
    sse: 'SSE',
  }

  const summary = () =>
    type === 'stdio'
      ? (command || '…') + (args ? ' ' + args.trim() : '')
      : url || '…'

  const build = (): McpServerConfig | null => {
    if (!name.trim()) {
      setError('Name is required.')
      return null
    }
    if (type === 'stdio') {
      if (!command.trim()) {
        setError('A command is required for stdio servers.')
        return null
      }
      return { command: command.trim(), args: splitArgs(args), env: parseKV(env) }
    }
    if (!url.trim()) {
      setError('A URL is required for HTTP/SSE servers.')
      return null
    }
    return { url: url.trim(), headers: parseKV(headers) }
  }

  const save = () => {
    const cfg = build()
    if (!cfg) return
    setError('')
    onSave(initialName, builtin ? initialName : name.trim(), cfg)
  }

  return (
    <div className={`mcp-card ${open ? 'open' : ''}`}>
      <div className="mcp-card-head" onClick={() => setOpen((o) => !o)}>
        <span className={`mcp-chevron ${open ? 'open' : ''}`}>▶</span>
        <span className="mcp-card-title">{name || initialName || 'new connector'}</span>
        {builtin && <span className="badge mcp-builtin">built-in</span>}
        <span className="mcp-type">{transportLabel[type]}</span>
        <span className="mcp-summary">{summary()}</span>
        <span className={`status-dot ${type === 'stdio' ? 'ok' : ''}`} />
        <div className="mcp-card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn tiny" onClick={save}>
            Save
          </button>
          {initialName && !builtin && (
            <button className="btn tiny danger" onClick={() => onDelete(initialName)}>
              Delete
            </button>
          )}
        </div>
      </div>
      {open && (
      <div className="mcp-fields">
        <label className="field-label">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. filesystem"
          dir="ltr"
          readOnly={builtin}
          title={builtin ? 'Built-in connectors keep their name' : undefined}
        />
        <label className="field-label">Transport</label>
        <select value={type} onChange={(e) => setType(e.target.value as McpTransport)}>
          <option value="stdio">stdio (local command)</option>
          <option value="http">HTTP / Streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
        {type === 'stdio' ? (
          <>
            <label className="field-label">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx or /path/to/server"
              dir="ltr"
            />
            <label className="field-label">Args</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder='e.g. -y @modelcontextprotocol/server-filesystem /path'
              dir="ltr"
            />
            <label className="field-label">Environment (KEY=VALUE per line)</label>
            <textarea
              className="system-prompt kv-input"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="API_KEY=${MY_KEY}"
            />
          </>
        ) : (
          <>
            <label className="field-label">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://server.example.com/mcp"
              dir="ltr"
            />
            <label className="field-label">Headers (KEY=VALUE per line)</label>
            <textarea
              className="system-prompt kv-input"
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="Authorization=Bearer ${TOKEN}"
            />
          </>
        )}
        {error && (
          <div className="hint" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
