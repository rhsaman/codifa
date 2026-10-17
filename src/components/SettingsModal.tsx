import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { McpServerConfig, McpTransport, ProviderConfig, ProviderKind, SearchConsoleConfig, SearchPluginConfig, SearchPluginKind } from '../types'
import { useStore, flushStateNow, providerApiKeys } from '../lib/store'
import { cancelModelDownload, downloadModel, getModelsStatus, getSkillFile, listSkills, pauseModelDownload, removeModel, resumeModelDownload, syncSkill, type ManagedModelKind, type ModelKindStatus, type ModelRunState, type ModelsStatus } from '../lib/api'
import { fetchAndPersist } from '../lib/provider-fetch'
import { invalidateSkillsList } from '../lib/skills'
import { api } from '../lib/fs'
import { allModes } from '../lib/modes'
import { PROVIDER_META, providerMeta, isForeignModelId } from '../lib/provider-meta'
import { ModeIcon } from './ModeIcon'
import { ModelTestButton } from './ModelTestButton'
import { ProviderTestButton } from './ProviderTestButton'
import { THEMES } from '../lib/themes'
import { RangeSlider } from './RangeSlider'

const BUILTIN_KINDS: ProviderKind[] = Object.values(PROVIDER_META)
  .filter((m) => m.builtin)
  .map((m) => m.kind)
const NEW_SKILL_KEY = '__new_skill__'

/** بررسی می‌کنه آیا یک پروایدر تنظیم شده (حداقل یک کلید API دارد). */
function isProviderConfigured(p: ProviderConfig): boolean {
  if (providerMeta(p.kind).local) return true
  return providerApiKeys(p).length > 0
}

function modelLabelForOpts(providerId: string, m: string): string {
  return `${providerId}/${m}`
}
/** Strip a redundant "providerId/" prefix from a model id (a model can get
 *  persisted with it, e.g. "openrouter/free"), so it is never shown or stored
 *  doubled as "openrouter/openrouter/free". */
function bareModelFor(p: ProviderConfig, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m
}

// `current` is stored as "providerId/model" (route through that provider).
// Legacy values may still be a bare model id, a kind-prefixed id ("custom/…")
// or a doubled prefix — resolve a readable label in every case. The label
// shows the provider's DISPLAY NAME (like the composer picker), never the
// raw provider id / kind ("custom-xyz/model" → "My Provider/model").
export function toolModelLabel(current: string, providers: ReadonlyArray<ProviderConfig>): string {
  if (!current) return 'Main model'
  const slash = current.indexOf('/')
  if (slash > 0) {
    const pid = current.slice(0, slash)
    let modelPart = current.slice(slash + 1)
    // Match by provider id first, then by kind (legacy "custom/model" values
    // written before explicit ids existed).
    const p =
      providers.find((x) => x.id === pid) ??
      (pid === 'custom' ? providers.find((x) => x.kind === 'custom') : undefined)
    if (p) {
      // Collapse a doubled prefix from a previously saved value
      // ("providerId/providerId/model") before labelling.
      if (modelPart.startsWith(`${p.id}/`)) modelPart = modelPart.slice(p.id.length + 1)
      return `${p.name}/${modelPart}`
    }
  }
  return current
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
  const slash = current.indexOf('/')
  if (slash > 0) {
    const pid = current.slice(0, slash)
    let modelPart = current.slice(slash + 1)
    const p =
      providers.find((x) => x.id === pid) ??
      (pid === 'custom' ? providers.find((x) => x.kind === 'custom') : undefined)
    if (p) {
      if (modelPart.startsWith(`${p.id}/`)) modelPart = modelPart.slice(p.id.length + 1)
      return { providerId: p.id, model: modelPart }
    }
    return null
  }
  return { providerId: activeProviderId, model: current }
}

function ToolModelSelect({
  agent, label, desc, current, onSelect, noneLabel = 'Main model',
}: {
  agent: string
  label: string
  desc: string
  current: string
  onSelect: (agent: string, model: string) => void
  /** Label for the empty-value option (stores ''). Slots where empty means
   * "disabled" (e.g. step) pass an "Off" label instead of "Main model". */
  noneLabel?: string
}) {
  const providers = useStore((s) => s.settings.providers)
  const activeProviderId = useStore((s) => s.settings.activeProviderId)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const q = search.trim().toLowerCase()

  // Union of the provider's live /models results and its saved list, so the
  // subagent picker can search & pick any model the provider actually offers
  // (matching the main composer picker) — not just the ones already saved.
  // Saved entries are filtered by `removed` too so a model the user removed
  // (e.g. via Settings → Providers) doesn't sneak back into the picker just
  // because it's still in `p.models` from an earlier write.
  //
  // The foreign-id check runs only on the PERSISTED list (`p.models`,
  // `p.model`), not on the live fetch — see ProviderModelSelect.allModels
  // for why: a live fetch is already scoped to this exact provider, and
  // aggregator kinds (OpenRouter, TokenRouter) legitimately return
  // vendor-prefixed ids ("google/...", "nvidia/...") that collide with our
  // own built-in provider kind ids. The check runs on the BARE id `b`
  // (post-strip), not on the raw `m` — otherwise a doubled-prefix entry
  // like "local/opencode/big-pickle" would pass the raw check (head ===
  // p.id) but still render as the wrong model.
  const modelsFor = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? [])
    const out = new Set<string>()
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

  // `current` is stored as "providerId/model" — resolve a readable label via
  // the shared helper (shows the provider's display name, not the raw id/kind).
  const currentLabel = toolModelLabel(current, providers)

  // The single row the stored value really routes through — drives the active
  // highlight below (legacy bare ids land on the active provider, matching
  // the backend resolver).
  const target = toolModelTarget(current, providers, activeProviderId)

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
    // Capture phase: the settings modal root stops mousedown propagation
    // (onMouseDown={e => e.stopPropagation()}), so a bubble-phase document
    // listener never fires for clicks inside the modal but outside this
    // picker — the dropdown would stay open. Capture runs before that stop.
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
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
          const hay = `${p.name} ${modelLabelForOpts(p.id, m)}`.toLowerCase()
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
            placeholder={open ? 'Search models…' : (current ? currentLabel : noneLabel)}
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
          <span
            className="model-select-combo-chevron"
            onMouseDown={(e) => {
              // The chevron sits inside wrapRef, so the document outside-click
              // handler ignores it — toggle explicitly so clicking it closes.
              e.preventDefault()
              if (open) closeMenu()
              else openMenu()
            }}
          >
            {open ? '▴' : '▾'}
          </span>
        </div>
        {open && (
          <div className="model-select-dropdown combo">
            <div className="model-select-list">
              <button
                className={`model-select-item ${!current ? 'current' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onSelect(agent, ''); closeMenu(); inputRef.current?.blur() }}
                type="button"
              >
                {noneLabel}
              </button>
              {visibleProviders.map(({ p, models }) => {
                const isOpen = q ? true : expanded.has(p.id)
                return (
                  <div key={p.id} className={`pm-provider${isOpen ? ' open' : ''}`}>
                    <div className="pm-provider-row">
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
                      <ProviderTestButton cfg={p} models={models} />
                    </div>
                    {isOpen && (
                      <div className="pm-models">
                        {models.map((m) => {
                          // Highlight ONLY the row the stored value really
                          // routes through: provider AND model must both match
                          // (legacy bare ids highlight under the active
                          // provider) — never same-named models sitting under
                          // other providers.
                          const isActive =
                            target !== null && target.providerId === p.id && target.model === m
                          return (
                            <div key={m} className="pm-model-row">
                              <button
                                type="button"
                                className={`mode-menu-item pm-model ${isActive ? 'active' : ''}`}
                                onMouseDown={(e) => { e.preventDefault(); pick(p, m) }}
                              >
                                <span className="pm-model-provider">{p.name}/</span>
                                <span className="pm-model-name">{m}</span>
                              </button>
                              <ModelTestButton cfg={p} model={m} />
                            </div>
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
  const dataPath = useStore((s) => s.dataPath)
  const setDataPath = useStore((s) => s.setDataPath)
  const whisperModel = useStore((s) => s.whisperModel)
  const setWhisperModel = useStore((s) => s.setWhisperModel)
  const sttProviderId = useStore((s) => s.sttProviderId)
  const sttModel = useStore((s) => s.sttModel)
  const setSttProviderId = useStore((s) => s.setSttProviderId)
  const setSttModel = useStore((s) => s.setSttModel)
  const sttFallbacks = useStore((s) => s.sttFallbacks)
  const setSttFallbacks = useStore((s) => s.setSttFallbacks)
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
  const cacheTtlMinutes = useStore((s) => s.cacheTtlMinutes)
  const setMemoryTtlConfig = useStore((s) => s.setMemoryTtlConfig)
  const compactAtPercent = useStore((s) => s.settings.compactAtPercent ?? 80)
  const setCompactAtPercent = useStore((s) => s.setCompactAtPercent)
  const historyLimit = useStore((s) => s.historyLimit ?? 0)
  const setHistoryLimit = useStore((s) => s.setHistoryLimit)
  const webSearchAutoFetch = useStore((s) => s.webSearchAutoFetch ?? 3)
  const setWebSearchAutoFetch = useStore((s) => s.setWebSearchAutoFetch)
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

  const [tab, setTab] = useState<'providers' | 'auth' | 'plugins' | 'modes' | 'appearance' | 'skills' | 'mcp' | 'storage' | 'tools' | 'models' | 'general'>(initialTab as any || 'providers')
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
  // 1s cadence while a download is in flight (speed + percent feel live);
  // 2.5s otherwise to avoid needless traffic.
  useEffect(() => {
    void refreshModels()
    const id = setInterval(
      () => void refreshModels(),
      mStatus?.whisper?.running || mStatus?.piper?.state === 'downloading' ? 1000 : 2500,
    )
    return () => clearInterval(id)
  }, [refreshModels, mStatus?.whisper?.running, mStatus?.piper?.state])

  const piperRunState = (): ModelRunState | undefined => {
    const p = mStatus?.piper
    if (!p) return undefined
    if (p.state === 'downloading')
      return { state: 'downloading', repo: p.model || 'mehdi-hf/pocket-tts-farsi-v2', percent: (p.progress ?? 0) * 100, downloaded_bytes: p.downloaded_bytes ?? 0, total_bytes: p.total_bytes ?? 0, speed_bps: p.speed_bps ?? 0 }
    if (p.state === 'paused')
      return { state: 'paused', repo: p.model || 'mehdi-hf/pocket-tts-farsi-v2', percent: (p.progress ?? 0) * 100, downloaded_bytes: p.downloaded_bytes ?? 0, total_bytes: p.total_bytes ?? 0, speed_bps: p.speed_bps ?? 0 }
    if (p.state === 'error')
      return { state: 'error', repo: p.model || 'mehdi-hf/pocket-tts-farsi-v2', error: p.error }
    return undefined
  }

  const isRunning = (kind: 'whisper' | 'piper') => {
    if (kind === 'piper') return mStatus?.piper?.state === 'downloading'
    return mStatus?.whisper?.running?.state === 'downloading'
  }

  const runState = (kind: ManagedModelKind): ModelRunState | undefined => {
    if (kind === 'piper') return piperRunState()
    return mStatus?.whisper?.running
  }

  const actDownload = async (kind: 'whisper' | 'piper') => {
    const pocketDefault = 'mehdi-hf/pocket-tts-farsi-v2'
    const rawTts = (ttsModel ?? '').trim()
    const pocketRepo = rawTts.includes('/') ? rawTts : pocketDefault
    const repo = kind === 'whisper' ? whisperModel : pocketRepo
    const base = kind === 'piper' ? ((settings as { ttsBaseUrl?: string }).ttsBaseUrl ?? '') : ''
    setModelsMsg('')
    try {
      await downloadModel(kind, repo, base)
      setModelsMsg(`Downloading ${repo}… (status below updates automatically)`)
      void refreshModels()
    } catch (err) {
      setModelsMsg(`Download failed: ${(err as Error).message}`)
    }
  }

  const actPause = async (kind: ManagedModelKind) => {
    setModelsMsg('')
    try {
      await pauseModelDownload(kind)
      void refreshModels()
    } catch (err) {
      setModelsMsg(`Pause failed: ${(err as Error).message}`)
    }
  }

  const actResume = async (kind: ManagedModelKind) => {
    setModelsMsg('')
    try {
      await resumeModelDownload(kind)
      void refreshModels()
    } catch (err) {
      setModelsMsg(`Resume failed: ${(err as Error).message}`)
    }
  }

  const actCancel = async (kind: ManagedModelKind) => {
    setModelsMsg('')
    try {
      await cancelModelDownload(kind)
      setModelsMsg('Download stopped. Partial files are kept for later resume.')
      void refreshModels()
      // Refresh once more after a beat so the cleared state is visible
      // even if the first poll raced the background thread.
      setTimeout(() => void refreshModels(), 800)
    } catch (err) {
      setModelsMsg(`Stop failed: ${(err as Error).message}`)
    }
  }

  const actRemove = async (kind: 'whisper' | 'piper', repo: string) => {
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
  const [skills, setSkills] = useState<Array<{ name: string; path: string; raw: string; files: string[] }>>([])
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({})
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
  const [addingMcp, setAddingMcp] = useState(false)
  const skillListRef = useRef<HTMLDivElement | null>(null)

  const reloadSkills = useCallback(async (preferName?: string) => {
    const rows = await listSkills()
    const found = rows.map((r) => ({ name: r.name, path: r.path, raw: r.content, files: r.files ?? [] }))
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

  const getSkillServerFiles = (key: string): string[] => {
    if (key === NEW_SKILL_KEY) return []
    return skills.find((x) => x.name === key)?.files ?? []
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
    const res = await syncSkill({
      name: newName,
      previousName: name !== NEW_SKILL_KEY && name !== newName ? name : '',
      content: normalized,
      ...(extraNames.length > 0 ? { files: extra } : {}),
      ...(deleted.length > 0 ? { deletedFiles: deleted } : {}),
    })
    setSkillsMsg(res.ok ? 'Saved ✓' : `Save failed: ${res.note ?? 'unknown error'}`)
    if (res.ok) {
      const savedName = res.name || newName
      const renamed = name === NEW_SKILL_KEY || name !== savedName
      setSkillDrafts((prev) => {
        const next = { ...prev }
        if (renamed) delete next[name]
        next[savedName] = normalized
        return next
      })
      setExpandedSkills((prev) => {
        const next = new Set(prev)
        if (renamed) next.delete(name)
        next.add(savedName)
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
          next[savedName] = prev[name]
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
      void reloadSkills(savedName)
      invalidateSkillsList()
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
    void getSkillFile(key, next).then((content) => {
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
    }
  }

  const newSkill = () => {
    setExpandedSkills((prev) => new Set(prev).add(NEW_SKILL_KEY))
    setSkillDrafts((prev) => ({
      ...prev,
      [NEW_SKILL_KEY]:
        '---\nname: new-skill\ndescription: One-line English summary of when to use this skill\nfa_keywords: \n---\n\n# New skill\n\nStep-by-step instructions the agent follows when this skill matches.\n',
    }))
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
                are stored in the app's user data folder and changes apply on the next message in any mode.
                Env/header values support{' '}
                <code>{'${VAR}'}</code> and <code>{'${VAR:-default}'}</code> expansion from your shell
                environment. Add a new connector by typing <code>/create-mcp &lt;description&gt;</code> in the chat,
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
                  <div className="hint">No MCP connectors yet. Add one with <code>/create-mcp &lt;description&gt;</code> in the chat.</div>
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
                Skills are stored in the app's user data folder and matched to your messages semantically:
                when a request matches a skill, the agent follows its instructions. Create or edit skills
                by typing <code>/create-skill &lt;description&gt;</code> in the chat, or add them here.
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
                  <div className="hint">No skills yet. Create one with <code>/create-skill &lt;description&gt;</code> in the chat.</div>
                )}
                {expandedSkills.has(NEW_SKILL_KEY) && (
                  <div className="skill-card open">
                    <div className="skill-card-head">
                      <span className="skill-chevron open">▶</span>
                      <span className="skill-card-name">New skill</span>
                    </div>
                    <div className="skill-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'visible' }}>
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
                      <SkillFilesEditor
                        serverFiles={[]}
                        extraFiles={skillExtraFiles[NEW_SKILL_KEY] ?? {}}
                        deletedFiles={skillDeletedFiles[NEW_SKILL_KEY] ?? []}
                        activeFile={skillActiveFile[NEW_SKILL_KEY] ?? ''}
                        newFileName={skillNewFileName[NEW_SKILL_KEY] ?? ''}
                        onSelect={(f) => selectSkillFile(NEW_SKILL_KEY, f)}
                        onContentChange={(f, v) =>
                          setSkillExtraFiles((prev) => ({
                            ...prev,
                            [NEW_SKILL_KEY]: { ...(prev[NEW_SKILL_KEY] ?? {}), [f]: v },
                          }))
                        }
                        onNewFileNameChange={(v) =>
                          setSkillNewFileName((prev) => ({ ...prev, [NEW_SKILL_KEY]: v }))
                        }
                        onAdd={() => addSkillFile(NEW_SKILL_KEY)}
                        onRemove={(f) => removeSkillFile(NEW_SKILL_KEY, f)}
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
                          <div className="skill-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'visible' }}>
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
                            <SkillFilesEditor
                              serverFiles={s.files ?? []}
                              extraFiles={skillExtraFiles[s.name] ?? {}}
                              deletedFiles={skillDeletedFiles[s.name] ?? []}
                              activeFile={skillActiveFile[s.name] ?? ''}
                              newFileName={skillNewFileName[s.name] ?? ''}
                              onSelect={(f) => selectSkillFile(s.name, f)}
                              onContentChange={(f, v) =>
                                setSkillExtraFiles((prev) => ({
                                  ...prev,
                                  [s.name]: { ...(prev[s.name] ?? {}), [f]: v },
                                }))
                              }
                              onNewFileNameChange={(v) =>
                                setSkillNewFileName((prev) => ({ ...prev, [s.name]: v }))
                              }
                              onAdd={() => addSkillFile(s.name)}
                              onRemove={(f) => removeSkillFile(s.name, f)}
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
          {/* ===== Web & Fetch cache ===== */}
          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-icon">🌐</span>
              <div>
                <div className="settings-group-title">Web &amp; Fetch cache</div>
                <div className="settings-group-desc">
                  How long web search results and fetched pages stay cached before a re-fetch.
                  Uses the same TTL as RAG storage (below) — set once, applies everywhere.
                </div>
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
              compact, subagent, schedule, title). Leave a field empty to use the main model (the one chosen in the
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
              desc="Research sub-agent that does ALL file reading, searching and LSP lookups for the main agent and reports the full findings. Falls back to the main model."
              current={subagentModels.explore || subagentModels.subagent || ''}
              onSelect={setSubagentModel}
            />
            <ToolModelSelect
              agent="schedule"
              label="Schedule model"
              desc="Model that runs scheduled tasks (cron inbox) in the background. Empty = the provider/model saved on each task, or the main model."
              current={subagentModels.schedule || ''}
              onSelect={setSubagentModel}
            />
            <ToolModelSelect
              agent="title"
              label="Title generator"
              desc="Tiny model that names a new chat in the background from the first message. Falls back to the compact model."
              current={subagentModels.title || ''}
              onSelect={setSubagentModel}
            />
          </div>
        </>
        )}

        {tab === 'models' && (
        <>
            <div className="field models-tab">
              <div className="field-head">
                <label>On-device Models</label>
              </div>
              <div className="hint models-intro">
                These models run fully offline on your device. Status and progress refresh
                automatically.
              </div>
              {modelsMsg && <div className="hint models-msg">{modelsMsg}</div>}

              <div className="model-card">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Speech to Text (STT)</span>
                    <span className="model-card-desc">Offline voice input, speech to text</span>
                  </div>
                  <ModelBadge status={mStatus?.whisper} />
                </div>
                <div className="model-card-body">
                  <label className="field-label">Model (HF repo id)</label>
                  <input value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)} dir="ltr" placeholder="Systran/faster-whisper-medium" />
                  <ModelProgress running={runState('whisper')} />
                  <ModelStatusLine status={mStatus?.whisper} running={isRunning('whisper')} onRemove={() => actRemove('whisper', whisperModel)} />
                  <ModelControls
                    running={runState('whisper')}
                    canDownload={(mStatus?.whisper?.dirs ?? []).length === 0}
                    onDownload={() => actDownload('whisper')}
                    onPause={() => actPause('whisper')}
                    onResume={() => actResume('whisper')}
                    onCancel={() => actCancel('whisper')}
                  />
                </div>
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Text to Speech (Pocket Farsi v2)</span>
                    <span className="model-card-desc">Offline Persian voice for reading answers aloud</span>
                  </div>
                  <ModelBadge status={{ dirs: mStatus?.piper?.state === 'done' ? [{ repo: mStatus.piper.model || 'mehdi-hf/pocket-tts-farsi-v2', dir: '', size: mStatus?.piper?.size ?? 0, ready: true }] : [], running: runState('piper') }} />
                </div>
                <div className="model-card-body">
                  <label className="field-label">Voice id (Pocket Farsi v2)</label>
                  <input value={(() => { const v = (ttsModel ?? '').trim(); if (!v || v.includes('/') || v.includes('\\') || v.toLowerCase() === 'local' || v === 'tts-1' || v === 'tts-1-hd' || v.startsWith('fa_IR') || v.endsWith('.onnx') || v.endsWith('.onnx.json')) return 'default'; return v })()} onChange={(e) => setTtsModel(e.target.value)} dir="ltr" placeholder="default" />
                  <ModelProgress running={runState('piper')} />
                  <ModelStatusLine status={{ dirs: mStatus?.piper?.state === 'done' ? [{ repo: mStatus.piper.model || 'mehdi-hf/pocket-tts-farsi-v2', dir: '', size: mStatus?.piper?.size ?? 0, ready: true }] : [], running: runState('piper') }} running={isRunning('piper')} onRemove={() => actRemove('piper', ((ttsModel ?? '').trim() && (ttsModel ?? '').includes('/') ? (ttsModel ?? '').trim() : 'mehdi-hf/pocket-tts-farsi-v2'))} />
                  <ModelControls
                    running={runState('piper')}
                    canDownload={mStatus?.piper?.state !== 'done' && mStatus?.piper?.state !== 'downloading'}
                    onDownload={() => actDownload('piper')}
                    onPause={() => actPause('piper')}
                    onResume={() => actResume('piper')}
                    onCancel={() => actCancel('piper')}
                  />

                </div>
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Speech to Text (STT)</span>
                    <span className="model-card-desc">Voice input transcription</span>
                  </div>
                  <div className="voice-switch-wrap">
                    <span className={`voice-status ${sttProviderId === 'local' ? 'on' : 'off'}`}>{sttProviderId === 'local' ? 'Local ON' : 'Local OFF'}</span>
                  <label className="plugin-switch voice-switch" title={sttProviderId === 'local' ? 'Disable local STT' : 'Enable local STT'}>
                    <input
                      type="checkbox"
                      checked={sttProviderId === 'local'}
                      onChange={(e) => {
                        if (e.target.checked) {
                          try { if (sttProviderId && sttProviderId !== 'local') localStorage.setItem('codifa.lastRemoteStt', sttProviderId) } catch { /* storage is best-effort */ }
                          setSttProviderId('local')
                        } else {
                          let saved = ''
                          try { saved = localStorage.getItem('codifa.lastRemoteStt') ?? '' } catch { saved = '' }
                          const next = saved && providers.some((p) => p.id === saved) ? saved : (providers[0]?.id ?? '')
                          setSttProviderId(next)
                        }
                      }}
                    />
                    <span className="plugin-switch-track" />
                  </label>
                  </div>
                </div>
                <div className="model-card-body">
                  <div className="hint">
                    {sttProviderId === 'local'
                      ? 'Local STT is ON — on-device Whisper is used. Turn the switch off to use the remote provider below.'
                      : 'Local STT is OFF — the remote provider below is used. Turn the switch on for fully offline Whisper.'}
                  </div>
                  <div className="voice-section">
                    <div className="voice-field">
                      <label className="field-label">STT provider</label>
                    <select value={sttProviderId === 'local' ? (() => { try { const s = localStorage.getItem('codifa.lastRemoteStt') ?? ''; return s && providers.some((p) => p.id === s) ? s : (providers[0]?.id ?? '') } catch { return providers[0]?.id ?? '' } })() : sttProviderId} onChange={(e) => {
                      // While local is ON the dropdown edits the remembered remote
                      // provider so the external config is never wiped.
                      if (sttProviderId === 'local') {
                        try { localStorage.setItem('codifa.lastRemoteStt', e.target.value) } catch { /* best-effort */ }
                        return
                      }
                      setSttProviderId(e.target.value)
                    }} dir="ltr" disabled={sttProviderId === 'local'}>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                        </option>
                      ))}
                    </select>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">STT model</label>
                    <input value={sttModel} onChange={(e) => setSttModel(e.target.value)} dir="ltr" placeholder="whisper-1" disabled={sttProviderId === 'local'} />
                    </div>
                  </div>
                  {sttProviderId !== 'local' && (
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
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                          </option>
                        ))}
                      </select>
                      {fb.providerId !== 'local' && (
                        <input value={fb.model} onChange={(e) => {
                          const next = [...sttFallbacks]
                          next[i] = { ...next[i], model: e.target.value }
                          setSttFallbacks(next)
                        }} dir="ltr" placeholder="whisper-1" />
                      )}
                      <button type="button" className="btn tiny secondary voice-remove-btn" onClick={() => setSttFallbacks(sttFallbacks.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="btn tiny secondary voice-add-btn" onClick={() => setSttFallbacks([...sttFallbacks, { providerId: providers[0]?.id ?? '', model: '' }])}>+ Add STT fallback</button>
                  </div>)}
                </div>
              </div>

              <div className="model-card model-card-voice">
                <div className="model-card-head">
                  <div className="model-card-titles">
                    <span className="model-card-title">Text to Speech (TTS)</span>
                    <span className="model-card-desc">Voice output synthesis</span>
                  </div>
                  <div className="voice-switch-wrap">
                    <span className={`voice-status ${ttsProviderId === 'local' ? 'on' : 'off'}`}>{ttsProviderId === 'local' ? 'Local ON' : 'Local OFF'}</span>
                  <label className="plugin-switch voice-switch" title={ttsProviderId === 'local' ? 'Disable local TTS' : 'Enable local TTS'}>
                    <input
                      type="checkbox"
                      checked={ttsProviderId === 'local'}
                      onChange={(e) => {
                        if (e.target.checked) {
                          try { if (ttsProviderId && ttsProviderId !== 'local') localStorage.setItem('codifa.lastRemoteTts', ttsProviderId) } catch { /* storage is best-effort */ }
                          setTtsProviderId('local')
                        } else {
                          let saved = ''
                          try { saved = localStorage.getItem('codifa.lastRemoteTts') ?? '' } catch { saved = '' }
                          const next = saved && providers.some((p) => p.id === saved) ? saved : ''
                          setTtsProviderId(next)
                        }
                      }}
                    />
                    <span className="plugin-switch-track" />
                  </label>
                  </div>
                </div>
                <div className="model-card-body">
                  <div className="hint">
                    {ttsProviderId === 'local'
                      ? 'Local TTS is ON — on-device Persian voice is used. Turn the switch off to use the remote provider below.'
                      : 'Local TTS is OFF — the remote provider below is used. Turn the switch on for fully offline voice.'}
                  </div>
                  <div className="voice-section">
                    <div className="voice-field">
                      <label className="field-label">TTS provider</label>
                    <select value={ttsProviderId === 'local' ? (() => { try { const s = localStorage.getItem('codifa.lastRemoteTts') ?? ''; return s && providers.some((p) => p.id === s) ? s : '' } catch { return '' } })() : ttsProviderId} onChange={(e) => {
                      // While local is ON the dropdown edits the remembered remote
                      // provider so the external config is never wiped.
                      if (ttsProviderId === 'local') {
                        try { localStorage.setItem('codifa.lastRemoteTts', e.target.value) } catch { /* best-effort */ }
                        return
                      }
                      setTtsProviderId(e.target.value)
                    }} dir="ltr" disabled={ttsProviderId === 'local'}>
                      <option value="">Not selected</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})` : `${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''}`}
                        </option>
                      ))}
                    </select>
                    </div>
                    <div className="voice-field">
                      <label className="field-label">TTS model</label>
                    <input value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} dir="ltr" placeholder="tts-1" disabled={ttsProviderId === 'local'} />
                    </div>
                    <div className="voice-field">
                      <label className="field-label">TTS voice</label>
                    <input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} dir="ltr" placeholder="alloy" disabled={ttsProviderId === 'local'} />
                    </div>
                  </div>

                  {ttsProviderId !== 'local' && (
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
                        {providers.map((p) => (
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
                  </div>)}
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

/** Readable speed: B/s → KB/s → MB/s. */
function fmtSpeed(bps?: number): string {
  const v = bps ?? 0
  if (!v || v <= 0) return '—'
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB/s`
  if (v >= 1024) return `${Math.round(v / 1024)} KB/s`
  return `${Math.round(v)} B/s`
}

/** Card status badge: Not downloaded · Downloading · Paused · Error · Ready. */
function ModelBadge({ status }: { status?: ModelKindStatus }) {
  const run = status?.running
  const ready = (status?.dirs ?? []).some((d) => d.ready)
  if (run?.state === 'downloading')
    return <span className="model-badge downloading">Downloading</span>
  if (run?.state === 'paused')
    return <span className="model-badge paused">Paused</span>
  if (run?.state === 'error')
    return <span className="model-badge error">Error</span>
  if (ready) return <span className="model-badge ready">Ready</span>
  return <span className="model-badge idle">Not downloaded</span>
}

/** Live progress bar: percent, downloaded/total and speed. */
function ModelProgress({ running }: { running?: ModelRunState }) {
  if (!running || (running.state !== 'downloading' && running.state !== 'paused')) return null
  const pct = Math.max(0, Math.min(100, running.percent ?? 0))
  const total = running.total_bytes ?? 0
  const done = running.downloaded_bytes ?? 0
  const speed = running.speed_bps ?? 0
  // Stalled = actively downloading but no bytes for a while (e.g. retry
  // backoff on a filtered network). Nudge toward a mirror instead of
  // looking frozen.
  const stalled = running.state === 'downloading' && total > 0 && speed <= 0 && done < total
  return (
    <div className={`model-progress${running.state === 'paused' ? ' paused' : ''}`}>
      <div className="model-progress-top">
        <span className="model-progress-pct">{total > 0 ? `${pct.toFixed(1)}%` : '…'}</span>
        <span className="model-progress-meta">
          {total > 0 ? `${fmtBytes(done)} of ${fmtBytes(total)}` : fmtBytes(done)} · {fmtSpeed(speed)}
        </span>
      </div>
      <div
        className="model-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="model-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="hint model-progress-repo" dir="ltr">{running.repo}</div>
      {stalled && (
        <div className="hint">Connection is slow or stalled — try a mirror base URL (e.g. https://hf-mirror.com), then Resume.</div>
      )}
    </div>
  )
}

/** Download controls: Download / Pause / Resume / Stop. */
function ModelControls({
  running,
  canDownload,
  onDownload,
  onPause,
  onResume,
  onCancel,
}: {
  running?: ModelRunState
  canDownload: boolean
  onDownload: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const state = running?.state
  if (state === 'downloading') {
    return (
      <div className="skill-actions model-controls">
        <button className="btn tiny secondary" onClick={onPause}>Pause</button>
        <button className="btn tiny danger" onClick={onCancel}>Stop</button>
      </div>
    )
  }
  if (state === 'paused') {
    return (
      <div className="skill-actions model-controls">
        <button className="btn tiny" onClick={onResume}>Resume</button>
        <button className="btn tiny danger" onClick={onCancel}>Stop</button>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className="skill-actions model-controls">
        {canDownload && <button className="btn tiny" onClick={onDownload}>Retry</button>}
        <button className="btn tiny danger" onClick={onCancel}>Clear error</button>
      </div>
    )
  }
  if (!canDownload) return null
  return (
    <div className="skill-actions model-controls">
      <button className="btn tiny" onClick={onDownload}>Download</button>
    </div>
  )
}

/** Whisper card status line: paused → error → downloaded (single dir) → empty. */
function ModelStatusLine({
  status,
  running,
  onRemove,
}: {
  status?: import('../lib/api').ModelKindStatus
  running: boolean
  onRemove: () => void
}) {
  if (status?.running?.state === 'paused')
    return <div className="hint">Paused — Resume continues from where it stopped.</div>
  if (running) return null
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
