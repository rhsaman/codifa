import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { McpServerConfig, McpTransport, PluginInfo } from '../types'
import { syncSkill } from '../lib/api'
import type { SkillSyncResult } from '../lib/api'
import { useStore } from '../lib/store'
import { modelReasoning } from '../lib/context'
import { supportsReasoning } from '../lib/thinking'
import { toolFallbackEntries } from '../lib/toolSlots'
import {
  deletePluginConnector,
  deletePluginScript,
  listPluginConnectors,
  listPluginScripts,
  listPluginSkills,
  savePluginConnector,
  savePluginScript,
  translateKeywords,
  fillMissingKeywords,
  updatePlugin,
} from '../lib/plugins'
import type { PluginConnectorRow, PluginScriptRow, PluginSkillRow } from '../lib/plugins'

/** Which part of the bundle the page is showing. */
type Tab = 'skills' | 'mcp' | 'scripts' | 'bundle'

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

/** Fold a skill write into the shape `run` reports.
 *
 *  `syncSkill` is the shared SKILLS route: it answers `ok`/`note`, not the
 *  `{ok}|{error}` envelope the plugin routes use. A failed write must surface
 *  its `note` as the error, or the page would claim "Saved." over a failure. */
function skillOutcome(out: SkillSyncResult): { ok: true } | { error: string } {
  return out.ok ? { ok: true } : { error: out.note ?? 'the skill write failed' }
}

/** What a part of a bundle is FOR, and — when it has any — the Persian phrases
 *  that reach it.
 *
 *  Skills are matched by these phrases, so they carry the field. A connector or a
 *  script is invoked by name (`plugin` tool action `run`, the MCP tool list) and its
 *  metadata is never read by the keyword matcher, so `keywords` is passed as
 *  `null` for those: a field that changes nothing is worse than no field. */
function MetaFields({
  description,
  keywords,
  onDescription,
  onKeywords,
  onTranslate,
  translating = false,
}: {
  description: string
  keywords: string | null
  onDescription: (value: string) => void
  onKeywords: (value: string) => void
  /** Present on the parts the keyword matcher actually reads. */
  onTranslate?: () => void
  translating?: boolean
}) {
  return (
    <>
      <label className="pd-field">
        Description
        <input
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          placeholder="What this part is for"
          dir="auto"
          spellCheck={false}
        />
      </label>
      {keywords === null ? null : (
        <label className="pd-field">
          Persian keywords (fa_keywords)
          <input
            value={keywords}
            onChange={(e) => onKeywords(e.target.value)}
            placeholder="ترجمه کن, ترجمه"
            dir="auto"
            spellCheck={false}
          />
        </label>
      )}
      {onTranslate ? (
        <div className="pd-field-actions">
          <button
            type="button"
            className="btn tiny secondary"
            disabled={translating}
            onClick={onTranslate}
          >
            {translating ? 'Translating…' : 'Translate description'}
          </button>
          <span className="hint">
            Fills the keywords from the description above. Review, then Save.
          </span>
        </div>
      ) : null}
    </>
  )
}

/** A connector's own config form: transport plus the address it runs at. */
function ConnectorForm({
  name,
  cfg,
  description,
  keywords,
  busy,
  onSave,
  onDelete,
}: {
  name: string
  cfg: McpServerConfig
  description: string
  keywords: string
  busy: boolean
  onSave: (cfg: McpServerConfig, meta: { description: string; faKeywords: string }) => void
  onDelete?: () => void
}) {
  const [type, setType] = useState<McpTransport>(
    cfg.command ? 'stdio' : cfg.url ? (cfg.headers ? 'http' : 'sse') : 'stdio',
  )
  const [command, setCommand] = useState(cfg.command ?? '')
  const [args, setArgs] = useState((cfg.args ?? []).join(' '))
  const [url, setUrl] = useState(cfg.url ?? '')
  const [env, setEnv] = useState(kvToText(cfg.env ?? {}))
  const [headers, setHeaders] = useState(kvToText(cfg.headers ?? {}))
  const [error, setError] = useState('')

  const build = (): McpServerConfig | null => {
    if (type === 'stdio') {
      if (!command.trim()) {
        setError('A stdio connector needs a command to run.')
        return null
      }
      setError('')
      return { command: command.trim(), args: splitArgs(args), env: parseKV(env) }
    }
    if (!url.trim()) {
      setError('A remote connector needs a URL.')
      return null
    }
    setError('')
    return { url: url.trim(), headers: parseKV(headers) }
  }

  return (
    <div className="pd-form">
      <label className="pd-field">
        Transport
        <select value={type} onChange={(e) => setType(e.target.value as McpTransport)}>
          <option value="stdio">stdio (local command)</option>
          <option value="http">HTTP / Streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      {type === 'stdio' ? (
        <>
          <label className="pd-field">
            Command
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx or /path/to/server"
              dir="ltr"
            />
          </label>
          <label className="pd-field">
            Args
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
              dir="ltr"
            />
          </label>
          <label className="pd-field">
            Environment (KEY=VALUE per line)
            <textarea
              className="system-prompt kv-input"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="API_KEY=${MY_KEY}"
            />
          </label>
        </>
      ) : (
        <>
          <label className="pd-field">
            URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://server.example.com/mcp"
              dir="ltr"
            />
          </label>
          <label className="pd-field">
            Headers (KEY=VALUE per line)
            <textarea
              className="system-prompt kv-input"
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="Authorization=Bearer ${TOKEN}"
            />
          </label>
        </>
      )}
      {error ? <div className="hint pd-error">{error}</div> : null}
      <div className="pd-form-actions">
        <button
          className="btn tiny"
          disabled={busy}
          onClick={() => {
            const next = build()
            if (next) onSave(next, { description, faKeywords: keywords })
          }}
        >
          Save
        </button>
        {onDelete ? (
          <button className="btn tiny secondary pm-danger" disabled={busy} onClick={onDelete}>
            Delete
          </button>
        ) : null}
        <span className="hint">
          Values support <code>{'${VAR}'}</code> from your shell environment.
        </span>
      </div>
      <span className="hint">
        Connector <code>{name}</code>
      </span>
    </div>
  )
}

/** One collapsible row of the page: the name, a badge, and the editor behind it. */
function Part({
  name,
  badge,
  sub,
  open,
  onToggle,
  children,
}: {
  name: string
  badge?: string
  sub?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className={`pd-part${open ? ' open' : ''}`}>
      <button type="button" className="pd-part-head" onClick={onToggle} aria-expanded={open}>
        <span className={`pd-chevron${open ? ' open' : ''}`} aria-hidden="true">
          ▶
        </span>
        <span className="pd-part-line">
          <span className="pd-part-name">{name}</span>
          {badge ? <span className="pd-badge">{badge}</span> : null}
          <span className="pd-part-action">{open ? 'Close' : 'Edit'}</span>
        </span>
        {sub ? <span className="pd-part-sub">{sub}</span> : null}
      </button>
      {open ? <div className="pd-part-body">{children}</div> : null}
    </div>
  )
}

/**
 * Everything one plugin holds, on a page of its own.
 *
 * The bundle card in Settings answers "is this on, and what does it carry"; this
 * page answers "what exactly is inside it, and what are those things FOR" — the
 * description and the Persian keywords of every skill, connector and script.
 * It is a full-screen overlay (not an inline expander) because editing three
 * lists with their own forms does not fit inside a grid card without turning it
 * into a page anyway.
 */
export function PluginDetail({
  plugin,
  onClose,
  onChanged,
}: {
  plugin: PluginInfo
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<Tab>('skills')
  const [skills, setSkills] = useState<PluginSkillRow[]>([])
  const [conns, setConns] = useState<PluginConnectorRow[]>([])
  const [scripts, setScripts] = useState<PluginScriptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState('')
  // One draft object per part, keyed by the part's name, so switching between
  // rows never loses what was typed and never writes a half-finished edit.
  const [skillDrafts, setSkillDrafts] = useState<
    Record<string, { content: string; description: string; keywords: string }>
  >({})
  const [scriptDrafts, setScriptDrafts] = useState<
    Record<string, { description: string; keywords: string }>
  >({})
  const [connDrafts, setConnDrafts] = useState<
    Record<string, { description: string; keywords: string }>
  >({})
  const [meta, setMeta] = useState({
    description: plugin.description ?? '',
    keywords: (plugin.fa_keywords ?? []).join(', '),
  })
  // Which part is mid-translation (its own name), and whether the bulk pass is
  // running. Two flags so one slow row cannot make the whole page look stuck.
  const [translating, setTranslating] = useState('')
  const [bulk, setBulk] = useState(false)
  // Same provider the chat turn runs on: the translation is a model call, so it
  // must use the ACTIVE provider, not whichever happens to sit first.
  const provider = useStore(
    (s) =>
      s.settings.providers.find((x) => x.id === s.settings.activeProviderId) ??
      s.settings.providers[0],
  )
  const subagentModels = useStore((s) => s.subagentModels)
  const subagentThinking = useStore((s) => s.subagentThinking)
  const toolFallbacks = useStore((s) => s.toolFallbacks)
  const providers = useStore((s) => s.settings.providers)

  const load = useCallback(async () => {
    const [sk, cn, sc] = await Promise.all([
      listPluginSkills(),
      listPluginConnectors(),
      listPluginScripts(),
    ])
    setSkills(Array.isArray(sk) ? sk.filter((r) => r.plugin_slug === plugin.slug) : [])
    setConns(Array.isArray(cn) ? cn.filter((r) => r.plugin_slug === plugin.slug) : [])
    setScripts(Array.isArray(sc) ? sc.filter((r) => r.plugin_slug === plugin.slug) : [])
    setLoading(false)
  }, [plugin.slug])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Write one part, then re-read so the page always shows what is on disk. */
  const run = async (work: () => Promise<{ ok: true } | { error: string }>, done: string) => {
    setBusy(true)
    const out = await work()
    setBusy(false)
    setMsg('error' in out ? out.error : done)
    if (!('error' in out)) {
      await load()
      onChanged()
    }
  }

  const skillState = (row: PluginSkillRow) =>
    skillDrafts[row.name] ?? {
      content: row.content ?? '',
      description: row.description ?? '',
      keywords: (row.fa_keywords ?? []).join(', '),
    }
  const scriptState = (row: PluginScriptRow) =>
    scriptDrafts[row.name] ?? {
      description: row.description ?? '',
      keywords: (row.fa_keywords ?? []).join(', '),
    }
  const connState = (row: PluginConnectorRow) =>
    connDrafts[row.name] ?? {
      description: row.description ?? '',
      keywords: (row.fa_keywords ?? []).join(', '),
    }

  /** Ask the model to turn descriptions into Persian trigger phrases.
   *
   *  Batched on purpose: the whole list is one cheap call, so translating 26
   *  skills costs one round trip instead of 26. The reply only fills the DRAFTS
   *  — nothing is written until the row (or the bulk button) saves, so a bad
   *  translation is reviewable before it reaches the catalog. */
  const requestKeywords = useCallback(
    async (items: Array<{ name: string; description: string }>) => {
      const usable = items.filter((i) => i.name.trim() && i.description.trim())
      if (usable.length === 0 || !provider) return {}
      const res = await translateKeywords({
        provider,
        subagentModels,
        subagentThinking,
        toolFallbacks: toolFallbackEntries(toolFallbacks),
        providers: Object.fromEntries(providers.map((p) => [p.id, p])),
        modelReasoning:
          modelReasoning(provider, provider.model) ?? supportsReasoning(provider.model, provider.kind),
        items: usable,
      })
      if (res.error) setMsg(`Translation: ${res.error}`)
      return res.keywords
    },
    [provider, subagentModels, subagentThinking, toolFallbacks, providers],
  )

  /** Fill one part's keyword field from its own description. */
  const translateOne = async (name: string, description: string, apply: (phrases: string) => void) => {
    setTranslating(name)
    setMsg('')
    const map = await requestKeywords([{ name, description }])
    setTranslating('')
    const phrases = map[name]
    if (!phrases || phrases.length === 0) {
      // `requestKeywords` already reported WHY (a rate-limited or unreachable
      // model); overwriting that with a generic line hid the real cause.
      setMsg((cur) => cur || 'The model returned no phrases for this part.')
      return
    }
    apply(phrases.join(', '))
  }

  /** Every skill of this bundle that still has no keywords of its own.
   *
   *  This is the reported gap: a bundle installed from a marketplace carries
   *  English descriptions, so its skills reached the catalog keyword-free and no
   *  Persian request could find them. One click fills them all. */
  const untranslatedSkills = () =>
    skills.filter((row) => (row.fa_keywords ?? []).length === 0 && (row.description ?? '').trim())

  const translateAllSkills = async () => {
    const pending = untranslatedSkills()
    if (pending.length === 0) {
      setMsg('Every skill in this bundle already has keywords.')
      return
    }
    setBulk(true)
    setMsg('')
    // The SAME pass the install paths run, so a bundle filled here and one
    // filled by an install can never end up with different keywords.
    const fill = await fillMissingKeywords(plugin.slug, {
      provider,
      subagentModels,
      subagentThinking,
      toolFallbacks,
      providers,
      modelReasoning:
        provider != null
          ? modelReasoning(provider, provider.model) ??
            supportsReasoning(provider.model, provider.kind)
          : false,
    })
    setBulk(false)
    setMsg(
      fill.error && fill.filled === 0
        ? `Translation: ${fill.error}`
        : `Filled keywords for ${fill.filled} of ${pending.length} skill(s).`,
    )
    if (fill.filled > 0) {
      await load()
      onChanged()
    }
  }

  const counts: Record<Tab, number> = {
    skills: skills.length,
    mcp: conns.length,
    scripts: scripts.length,
    bundle: 0,
  }
  const tabLabels: Record<Tab, string> = {
    skills: 'Skills',
    mcp: 'Connectors',
    scripts: 'Scripts',
    bundle: 'Bundle',
  }
  const tabs: Tab[] = ['skills', 'mcp', 'scripts', 'bundle']

  const body = (
    <div className="pd-overlay" onMouseDown={onClose}>
      <div
        className="pd-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${plugin.name} details`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="pd-head">
          <div className="pd-head-title">
            <h2>{plugin.name}</h2>
            <span className="pd-slug">{plugin.slug}</span>
            {plugin.enabled ? null : <span className="pd-badge pd-badge--off">off</span>}
          </div>
          <div className="pd-head-meta">
            <span className="pm-meta-item">
              <b>{skills.length}</b> skills
            </span>
            <span className="pm-meta-item">
              <b>{conns.length}</b> connectors
            </span>
            <span className="pm-meta-item">
              <b>{scripts.length}</b> scripts
            </span>
          </div>
          <button className="pd-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <nav className="pd-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`pd-tab${tab === t ? ' active' : ''}`}
              onClick={() => {
                setTab(t)
                setOpen('')
              }}
            >
              {tabLabels[t]}
              {t === 'bundle' ? null : <span className="pd-count">{counts[t]}</span>}
            </button>
          ))}
        </nav>

        <div className="pd-content">
          {plugin.source ? (
            <div className="pd-source">
              Installed from <code>{plugin.source}</code>
              {plugin.source_ref ? ` @ ${plugin.source_ref}` : ''}
            </div>
          ) : null}
          {loading ? <div className="hint">Reading the bundle…</div> : null}

          {tab === 'skills' ? (
            skills.length === 0 ? (
              <div className="hint">
                No skills in this bundle — add one with <code>/skill &lt;description&gt;</code>.
              </div>
            ) : (
              <>
                {untranslatedSkills().length > 0 ? (
                  <div className="pd-bulk">
                    <span className="hint">
                      {untranslatedSkills().length} skill(s) here have no Persian keywords, so a
                      Persian request cannot find them.
                    </span>
                    <button
                      type="button"
                      className="btn tiny"
                      disabled={bulk || !provider}
                      onClick={() => void translateAllSkills()}
                    >
                      {bulk ? 'Translating…' : `Translate ${untranslatedSkills().length} description(s)`}
                    </button>
                  </div>
                ) : null}
                {skills.map((row) => {
                const d = skillState(row)
                return (
                  <Part
                    key={row.name}
                    name={row.name}
                    sub={d.description}
                    open={open === `skill:${row.name}`}
                    onToggle={() => setOpen(open === `skill:${row.name}` ? '' : `skill:${row.name}`)}
                  >
                    <MetaFields
                      description={d.description}
                      keywords={d.keywords}
                      onDescription={(v) =>
                        setSkillDrafts((prev) => ({ ...prev, [row.name]: { ...d, description: v } }))
                      }
                      onKeywords={(v) =>
                        setSkillDrafts((prev) => ({ ...prev, [row.name]: { ...d, keywords: v } }))
                      }
                      onTranslate={() =>
                        void translateOne(row.name, d.description, (phrases) =>
                          setSkillDrafts((prev) => ({
                            ...prev,
                            [row.name]: { ...d, keywords: phrases },
                          })),
                        )
                      }
                      translating={translating === row.name}
                    />
                    <label className="pd-field">
                      Skill body
                      <textarea
                        className="system-prompt skill-raw"
                        value={d.content}
                        onChange={(e) =>
                          setSkillDrafts((prev) => ({
                            ...prev,
                            [row.name]: { ...d, content: e.target.value },
                          }))
                        }
                        rows={10}
                        dir="auto"
                        spellCheck={false}
                      />
                    </label>
                    <div className="pd-form-actions">
                      <button
                        className="btn tiny"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            // `plugin` names the bundle this skill belongs to; the
                            // body arrives without frontmatter, so description and
                            // keywords must travel separately or the save would
                            // rewrite them as empty.
                            () =>
                              syncSkill({
                                name: row.name,
                                content: d.content,
                                description: d.description,
                                faKeywords: d.keywords,
                                plugin: plugin.slug,
                              }).then(skillOutcome),
                            'Saved.',
                          )
                        }
                      >
                        Save
                      </button>
                      <button
                        className="btn tiny secondary pm-danger"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete skill "${row.name}" from this plugin?`)) return
                          void run(
                            () =>
                              syncSkill({ name: row.name, delete: true, plugin: plugin.slug }).then(
                                skillOutcome,
                              ),
                            'Deleted.',
                          )
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </Part>
                )
              })}
              </>
            )
          ) : null}

          {tab === 'mcp' ? (
            conns.length === 0 ? (
              <div className="hint">
                No connectors in this bundle. A connector gives the agent extra tools
                (filesystem, databases, APIs…).
              </div>
            ) : (
              conns.map((row) => {
                const d = connState(row)
                const cfg = row.cfg ?? {}
                const where = cfg.command
                  ? [cfg.command, ...(cfg.args ?? [])].join(' ')
                  : (cfg.url ?? '')
                return (
                  <Part
                    key={row.name}
                    name={row.name}
                    badge={cfg.command ? 'stdio' : cfg.headers ? 'HTTP' : 'SSE'}
                    sub={d.description || where}
                    open={open === `mcp:${row.name}`}
                    onToggle={() => setOpen(open === `mcp:${row.name}` ? '' : `mcp:${row.name}`)}
                  >
                    <MetaFields
                      description={d.description}
                      keywords={null}
                      onDescription={(v) =>
                        setConnDrafts((prev) => ({ ...prev, [row.name]: { ...d, description: v } }))
                      }
                      onKeywords={() => {}}
                    />
                    <ConnectorForm
                      name={row.name}
                      cfg={cfg}
                      description={d.description}
                      keywords={d.keywords}
                      busy={busy}
                      onSave={(next, nextMeta) =>
                        void run(
                          () =>
                            savePluginConnector(plugin.slug, row.name, next, undefined, {
                              description: nextMeta.description,
                              faKeywords: nextMeta.faKeywords,
                            }),
                          'Saved.',
                        )
                      }
                      onDelete={() => {
                        if (!window.confirm(`Delete connector "${row.name}" from this plugin?`)) return
                        void run(
                          () => deletePluginConnector(plugin.slug, row.name),
                          'Deleted.',
                        )
                      }}
                    />
                  </Part>
                )
              })
            )
          ) : null}

          {tab === 'scripts' ? (
            scripts.length === 0 ? (
              <div className="hint">
                No scripts in this bundle. A script is a runnable entry point the assistant runs
                during a turn when the bundle's skill calls for it.
              </div>
            ) : (
              scripts.map((row) => {
                const d = scriptState(row)
                return (
                  <Part
                    key={row.name}
                    name={row.name}
                    badge={row.language}
                    sub={d.description}
                    open={open === `script:${row.name}`}
                    onToggle={() => setOpen(open === `script:${row.name}` ? '' : `script:${row.name}`)}
                  >
                    <MetaFields
                      description={d.description}
                      keywords={null}
                      onDescription={(v) =>
                        setScriptDrafts((prev) => ({ ...prev, [row.name]: { ...d, description: v } }))
                      }
                      onKeywords={() => {}}
                    />
                    <div className="pd-form-actions">
                      <button
                        className="btn tiny"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            // Patching the script's manifest only: the body and
                            // the language are left exactly as they are on disk.
                            () =>
                              savePluginScript(plugin.slug, row.name, {
                                description: d.description,
                                faKeywords: d.keywords,
                              }),
                            'Saved.',
                          )
                        }
                      >
                        Save
                      </button>
                      <button
                        className="btn tiny secondary pm-danger"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete script "${row.name}" from this plugin?`)) return
                          void run(() => deletePluginScript(plugin.slug, row.name), 'Deleted.')
                        }}
                      >
                        Delete
                      </button>
                      <span className="hint">
                        Code lives in <code>{row.file ?? 'main.rs'}</code> — the assistant runs it
                        during a turn when the bundle's skill calls for it.
                      </span>
                    </div>
                  </Part>
                )
              })
            )
          ) : null}

          {tab === 'bundle' ? (
            <div className="pd-bundle">
              <MetaFields
                description={meta.description}
                keywords={meta.keywords}
                onDescription={(v) => setMeta((m) => ({ ...m, description: v }))}
                onKeywords={(v) => setMeta((m) => ({ ...m, keywords: v }))}
              />
              <span className="hint">
                These belong to the WHOLE bundle: the description is what the agent reads when it
                lists your plugins, and the keywords are the Persian phrases that route an ask to
                this bundle. A skill that carries none of its own falls back to them, so a library
                of bare skills is still found.
              </span>
              <div className="pd-form-actions">
                <button
                  className="btn tiny"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        updatePlugin({
                          slug: plugin.slug,
                          description: meta.description,
                          fa_keywords: meta.keywords,
                        }).then((out) => ('error' in out ? { error: out.error } : { ok: true as const })),
                      'Saved.',
                    )
                  }
                >
                  Save
                </button>
              </div>
            </div>
          ) : null}

          {msg ? <div className="pd-msg">{msg}</div> : null}
        </div>
      </div>
    </div>
  )

  // Portaled to <body>: the trigger lives inside the settings modal, whose own
  // overlay/overflow would otherwise clip a fixed-position page.
  return typeof document === 'undefined' ? body : createPortal(body, document.body)
}
