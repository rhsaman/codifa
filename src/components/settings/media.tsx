import { fetchAndPersist } from '../../lib/provider-fetch'
import { isAccountScoped, providerDisplayName } from '../../lib/provider-meta'
import { useStore } from '../../lib/store'
import { splitSlotEntry, toolChainRows, toolChainSet, toolFallbackToModel, toolFallbackValue } from '../../lib/toolSlots'
import { moveAt, useDragReorder } from '../../lib/useDragReorder'
import type { ProviderConfig, ToolFallback } from '../../types'
import { ProviderModelSelect } from '../ProviderModelSelect'
import { GripDots } from './rows'

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
export function FallbackRows({
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
  // Drag-to-reorder replaces the up/down arrows: the try order IS the list
  // order, so dropping a rung above/below another one rewrites the chain,
  // and row 1 (the tool's OWN model) is just wherever the drop lands.
  // Tab-bar drag feel: rows slide into their previewed slots while dragging.
  const { dragIndex, shiftStyle, handleProps, rowProps } = useDragReorder(
    `tools-${label}`,
    chain.length,
    (from, insertAt) => commit(moveAt(chain, from, insertAt)),
  )
  const rowClass = (i: number, isOwn: boolean) =>
    `slot-fallback-row${isOwn ? ' slot-fallback-row-own' : ''}${
      dragIndex !== null ? ' dnd-shifting' : ''
    }${dragIndex === i ? ' dnd-dragging' : ''}`
  return (
    <div className="slot-fallbacks">
      {chain.map((fb, i) => {
        const isOwn = i === 0
        return (
          <div
            key={isOwn ? 'own' : i}
            data-drag-row
            {...rowProps(i)}
            style={shiftStyle(i)}
            className={rowClass(i, isOwn)}
          >
            {/* Grip starts the drag; the rest of the row stays interactive
                (the model picker must keep its dropdown). */}
            <span className="dnd-grip" title="Drag to reorder" {...handleProps(i)}>
              <GripDots />
            </span>
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
              {/* Reordering is drag-only now (grip on the row's start), so
                  the arrows are gone; row 1 always exists — dropping the
                  tool's model is done by pointing it at the composer's
                  model, not by deleting a row. */}
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
export function sameRows(a: ToolFallback[], b: ToolFallback[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.providerId === b[i].providerId && r.model === b[i].model)
  )
}

/** The provider dropdown every Media Providers control shares. Lists the
 *  non-local providers with their display name, kind and base URL, so two
 *  same-named rows stay distinguishable. */
export function MediaProviderSelect({
  value,
  onChange,
  emptyLabel,
}: {
  value: string
  onChange: (id: string) => void
  /** When set, a first option with this label is rendered. On a primary slot
   *  the empty value means "feature off"; on a fallback row it only ever shows
   *  for a stored row that names no provider (the backend skips such rows) —
   *  a live row is cleared with Remove, not by re-picking the empty option. */
  emptyLabel?: string
}) {
  const providers = useStore((s) => s.settings.providers)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} dir="ltr">
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {providers
        .filter((p) => p.kind !== 'ollama')
        .map((p) => (
          <option key={p.id} value={p.id}>
            {`${providerDisplayName(p)} (${p.kind}${p.baseUrl ? ` — ${p.baseUrl}` : ''})`}
          </option>
        ))}
    </select>
  )
}

/** The Settings → Media Providers fallback ladder: an ordered list of
 *  provider+model targets tried when the slot's primary fails. One row per
 *  rung; TTS rows add a voice column. Shared by STT/TTS/Image/Video so the
 *  four lists behave and read the same. */
export function MediaFallbackList<R extends { providerId: string; model: string; voice?: string }>({
  label,
  addLabel,
  rows,
  onChange,
  withVoice = false,
  modelPlaceholder,
  voicePlaceholder = 'alloy',
}: {
  label: string
  /** Text after "+ Add" on the trailing button ("STT fallback"), singular. */
  addLabel: string
  rows: R[]
  onChange: (rows: R[]) => void
  withVoice?: boolean
  modelPlaceholder: string
  voicePlaceholder?: string
}) {
  const providers = useStore((s) => s.settings.providers)
  // Same non-local filter the dropdown shows: a new rung starts on a provider
  // it can actually route through.
  const firstRoutable = providers.find((p) => p.kind !== 'ollama')?.id ?? ''
  const patch = (i: number, partial: Partial<{ providerId: string; model: string; voice: string }>) =>
    onChange(rows.map((r, j) => (j === i ? ({ ...r, ...partial } as R) : r)))
  const add = () => {
    const row = { providerId: firstRoutable, model: '', ...(withVoice ? { voice: '' } : {}) }
    onChange([...rows, row as R])
  }
  // Drag-to-reorder: "tried in order" is the row order, so the grip at each
  // card's start rewrites it — no arrows needed. Tab-bar drag feel: rows
  // slide into their previewed slots while dragging.
  const { dragIndex, shiftStyle, handleProps, rowProps } = useDragReorder(
    `media-${label}`,
    rows.length,
    (from, insertAt) => onChange(moveAt(rows, from, insertAt)),
  )
  return (
    <div className="voice-fallbacks">
      <label className="field-label">{label}</label>
      <div className="hint">Tried in order when the primary fails — top first. Drag a row to reorder.</div>
      <div className="voice-fallback-head" aria-hidden="true">
        <span className="voice-col-drag" />
        <span className="voice-col-provider">Provider</span>
        <span className="voice-col-model">Model</span>
        {withVoice && <span className="voice-col-voice">Voice</span>}
        <span className="voice-head-remove" />
      </div>
      {rows.map((fb, i) => (
        <div
          key={i}
          className={`voice-fallback-card${
            dragIndex !== null ? ' dnd-shifting' : ''
          }${dragIndex === i ? ' dnd-dragging' : ''}`}
          data-drag-row
          {...rowProps(i)}
          style={shiftStyle(i)}
        >
          <span className="dnd-grip voice-col-drag" title="Drag to reorder" {...handleProps(i)}>
            <GripDots />
          </span>
          <div className="voice-col-provider">
            <MediaProviderSelect
              value={fb.providerId}
              onChange={(id) => patch(i, { providerId: id })}
              emptyLabel={fb.providerId ? undefined : 'Not selected'}
            />
          </div>
          <div className="voice-col-model">
            <input
              value={fb.model}
              onChange={(e) => patch(i, { model: e.target.value })}
              dir="ltr"
              placeholder={modelPlaceholder}
              aria-label={`${label} row ${i + 1} model`}
            />
          </div>
          {withVoice && (
            <div className="voice-col-voice">
              <input
                value={fb.voice ?? ''}
                onChange={(e) => patch(i, { voice: e.target.value })}
                dir="ltr"
                placeholder={voicePlaceholder}
                aria-label={`${label} row ${i + 1} voice`}
              />
            </div>
          )}
          <button
            type="button"
            className="btn tiny secondary voice-remove-btn"
            title="Remove this fallback"
            aria-label={`Remove ${label} row ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn tiny secondary voice-add-btn" onClick={add}>
        + Add {addLabel}
      </button>
    </div>
  )
}

