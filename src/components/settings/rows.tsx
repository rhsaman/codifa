import { modelReasoning } from '../../lib/context'
import { installPlugin, marketKey } from '../../lib/plugins'
import { providerMeta } from '../../lib/provider-meta'
import { providerApiKeys, useStore } from '../../lib/store'
import { supportsReasoning } from '../../lib/thinking'
import { THINKING_LABELS, THINKING_OPTIONS, canonThinkingLevel } from '../../lib/thinking-options'
import { resolveSlotEntry } from '../../lib/toolSlots'
import type { ProviderConfig, SearchPluginKind, ThinkingLevel, ToolFallback } from '../../types'
import { RangeSlider } from '../RangeSlider'
import { useEffect, useRef, useState } from 'react'
import { FallbackRows } from './media'

export function GripDots() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.8" cy="2" r="1.4" />
      <circle cx="7.2" cy="2" r="1.4" />
      <circle cx="2.8" cy="7" r="1.4" />
      <circle cx="7.2" cy="7" r="1.4" />
      <circle cx="2.8" cy="12" r="1.4" />
      <circle cx="7.2" cy="12" r="1.4" />
    </svg>
  )
}

/** Human-scaled stops for the context-window picker — powers of two plus the
 *  two market outliers everyone actually hits (Claude's 200K, GPT-5's 400K).
 *  Custom providers whose /models reports no window need this typed by hand
 *  today; the slider snaps to these, the exact field takes anything else. */
export const CTX_STEPS = [
  4096, 8192, 16384, 32768, 65536, 131072, 200000, 262144, 400000, 524288, 1048576, 2097152,
]

export function formatCtxTokens(n: number): string {
  if (n >= 1048576) {
    const m = n / 1048576
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, '')}M`
  }
  return `${Math.round(n / 1024)}K`
}

/** Nearest picker stop for an arbitrary fetched/typed window. */
export function nearestCtxStep(n: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < CTX_STEPS.length; i++) {
    const d = Math.abs(CTX_STEPS[i] - n)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

/** The context-window picker for custom providers: a snapping slider over
 *  CTX_STEPS with tick labels, a live formatted readout, and an exact-value
 *  field for windows off the scale (the thumb parks on the nearest stop). */
export function ContextSizeSlider({
  value,
  onChange,
}: {
  value: number | null
  onChange: (n: number | null) => void
}) {
  const idx = value ? nearestCtxStep(value) : 0
  return (
    <div className="ctx-picker">
      <div className="ctx-picker-head">
        <span className="field-label">Context window</span>
        <span className={`ctx-picker-value${value ? '' : ' unset'}`}>
          {value ? `${formatCtxTokens(value)} tokens` : 'not set'}
        </span>
      </div>
      <div className="ctx-picker-row">
        <div className="ctx-picker-slider">
          <RangeSlider
            min={0}
            max={CTX_STEPS.length - 1}
            step={1}
            value={idx}
            onChange={(i) => onChange(CTX_STEPS[i])}
            ariaLabel="Context window size"
          />
          <div className="ctx-picker-ticks" aria-hidden="true">
            {CTX_STEPS.map((s, i) => (
              <span
                key={s}
                className={`ctx-tick${i === idx ? ' on' : ''}`}
                style={{ left: `${(i / (CTX_STEPS.length - 1)) * 100}%` }}
              >
                {formatCtxTokens(s)}
              </span>
            ))}
          </div>
        </div>
        <input
          className="ctx-picker-exact"
          type="number"
          min={1024}
          step={1024}
          value={value ?? ''}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10)
            onChange(Number.isFinite(n) && n > 0 ? n : null)
          }}
          placeholder="exact"
          title="Exact context window in tokens — overrides the slider"
          dir="ltr"
          aria-label="Exact context window in tokens"
        />
      </div>
    </div>
  )
}

/** Row key for a skill: a plugin's skills are scoped by their bundle, because
 *  two bundles (or a bundle and the user's own store) may ship the same name. */
export function skillKey(pluginSlug: string, name: string): string {
  return pluginSlug ? `${pluginSlug}::${name}` : name
}

/** Stable hue (0–359) per provider name — tints the avatar of each card. */
export function providerHue(name: string): number {
  let h = 7
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** بررسی می‌کنه آیا یک پروایدر تنظیم شده (حداقل یک کلید API دارد). */
export function isProviderConfigured(p: ProviderConfig): boolean {
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
export function useMainModel(): { providerId: string; model: string } {
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
export function ToolSlotRow({
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
export function ThinkingBar({
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

export const SEARCH_ENGINE_KINDS: Array<{ kind: SearchPluginKind; label: string; needsKey: boolean }> = [
  { kind: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
  { kind: 'tavily', label: 'Tavily', needsKey: true },
]

/** The catalogue kinds a marketplace may declare. Every ROW installs a plugin
 *  regardless of its kind, so the kind is only stored provenance. */
/** How many cards the infinite scroll reveals per batch. A few pages of a
 *  1.5MB index stay cheap; the rest arrives as the user scrolls. */
export const CARD_BATCH = 24

/** Settings → Marketplaces: the plugin catalogues the user subscribes to.
 *
 *  An index is a plain JSON file in a git repo (Claude's `marketplace.json`),
 *  so "adding a marketplace" is just naming a repo. Browsing one writes nothing
 *  — a row installs through the SAME `installPlugin` the `/plugin install`
 *  command uses, which is why a listed plugin and a typed repo cannot diverge.
 *  The install ADDRESS a row carries is the id everywhere here (`marketKey`,
 *  from `lib/plugins`): the same key the install registry and the installed
 *  list match on.
 */
