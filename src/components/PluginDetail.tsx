import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { McpServerConfig, McpTransport, PluginInfo } from '../types'
import { syncSkill } from '../lib/api'
import type { SkillSyncResult } from '../lib/api'
import {
  deletePluginConnector,
  deletePluginScript,
  listPluginAgents,
  listPluginCommands,
  listPluginConnectors,
  listPluginScripts,
  listPluginSkills,
  savePluginConnector,
} from '../lib/plugins'
import type {
  PluginAgentRow,
  PluginCommandRow,
  PluginConnectorRow,
  PluginScriptRow,
  PluginSkillRow,
} from '../lib/plugins'

/** Which part of the bundle the page is showing. */
type Tab = 'skills' | 'commands' | 'agents' | 'mcp' | 'scripts' | 'hooks'

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

/** A connector's own config form: transport plus the address it runs at. */
function ConnectorForm({
  name,
  cfg,
  busy,
  onSave,
  onDelete,
}: {
  name: string
  cfg: McpServerConfig
  busy: boolean
  onSave: (cfg: McpServerConfig) => void
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
            if (next) onSave(next)
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
 * page answers "what exactly is inside it" — each skill's body, every
 * connector's address, and one Delete for the whole bundle. The agent picks
 * skills from the catalog by itself, so nothing here tunes routing: the
 * description shown per row is the one the catalog matches requests against.
 * It is a full-screen overlay (not an inline expander) because editing three
 * lists with their own forms does not fit inside a grid card without turning it
 * into a page anyway.
 */
export function PluginDetail({
  plugin,
  onClose,
  onChanged,
  onDelete,
}: {
  plugin: PluginInfo
  onClose: () => void
  onChanged: () => void
  /** Delete the WHOLE bundle — its skills and connectors go with it. */
  onDelete: () => void
}) {
  const [tab, setTab] = useState<Tab>('skills')
  const [skills, setSkills] = useState<PluginSkillRow[]>([])
  const [conns, setConns] = useState<PluginConnectorRow[]>([])
  const [scripts, setScripts] = useState<PluginScriptRow[]>([])
  const [cmds, setCmds] = useState<PluginCommandRow[]>([])
  const [agents, setAgents] = useState<PluginAgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState('')
  // One draft body per skill, keyed by the skill's name, so switching between
  // rows never loses what was typed and never writes a half-finished edit. The
  // description and keywords are NOT editable here: the save carries the body
  // only, and the backend keeps what is already on disk.
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const [sk, cn, sc, cq, ag] = await Promise.all([
      listPluginSkills(),
      listPluginConnectors(),
      listPluginScripts(),
      listPluginCommands(),
      listPluginAgents(),
    ])
    setSkills(Array.isArray(sk) ? sk.filter((r) => r.plugin_slug === plugin.slug) : [])
    setConns(Array.isArray(cn) ? cn.filter((r) => r.plugin_slug === plugin.slug) : [])
    setScripts(Array.isArray(sc) ? sc.filter((r) => r.plugin_slug === plugin.slug) : [])
    setCmds(Array.isArray(cq) ? cq.filter((r) => r.plugin_slug === plugin.slug) : [])
    setAgents(Array.isArray(ag) ? ag.filter((r) => r.plugin_slug === plugin.slug) : [])
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

  const counts: Record<Tab, number> = {
    skills: skills.length,
    commands: cmds.length,
    agents: agents.length,
    mcp: conns.length,
    scripts: scripts.length,
    hooks: plugin.hooks?.length ?? 0,
  }
  const tabLabels: Record<Tab, string> = {
    skills: 'Skills',
    commands: 'Commands',
    agents: 'Sub-agents',
    mcp: 'Connectors',
    scripts: 'Scripts',
    hooks: 'Hooks',
  }
  const tabs: Tab[] = ['skills', 'commands', 'agents', 'mcp', 'scripts', 'hooks']

  const body = (
    <div className="pd-overlay">
      <div
        className="pd-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${plugin.name} details`}
      >
        <header className="pd-head">
          <div className="pd-head-title">
            <h2>{plugin.name}</h2>
            <span className="pd-slug">{plugin.slug}</span>
            {plugin.enabled ? null : <span className="pd-badge pd-badge--off">off</span>}
          </div>
          {/* The census lives in the tab badges below (Skills 24 · Connectors 0
              · Scripts 0); repeating it here was noise. */}
          <div className="pd-head-actions">
            <button className="btn tiny secondary pm-danger" onClick={onDelete}>
              Delete plugin
            </button>
            <button className="pd-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
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
              <span className="pd-count">{counts[t]}</span>
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
                No skills in this bundle — add one with{' '}
                <code>/plugin update {plugin.slug} add a skill …</code>.
              </div>
            ) : (
              skills.map((row) => {
                const content = skillBodies[row.name] ?? row.content ?? ''
                return (
                  <Part
                    key={row.name}
                    name={row.name}
                    sub={row.description}
                    open={open === `skill:${row.name}`}
                    onToggle={() => setOpen(open === `skill:${row.name}` ? '' : `skill:${row.name}`)}
                  >
                    <label className="pd-field">
                      Skill body
                      <textarea
                        className="system-prompt skill-raw"
                        value={content}
                        onChange={(e) =>
                          setSkillBodies((prev) => ({ ...prev, [row.name]: e.target.value }))
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
                            // `plugin` names the bundle this skill belongs to. The
                            // body arrives without frontmatter and the call names
                            // NO description or keywords, so the save keeps the
                            // ones already on disk.
                            () =>
                              syncSkill({
                                name: row.name,
                                content,
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
              })
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
                const cfg = row.cfg ?? {}
                const where = cfg.command
                  ? [cfg.command, ...(cfg.args ?? [])].join(' ')
                  : (cfg.url ?? '')
                return (
                  <Part
                    key={row.name}
                    name={row.name}
                    badge={cfg.command ? 'stdio' : cfg.headers ? 'HTTP' : 'SSE'}
                    sub={row.description || where}
                    open={open === `mcp:${row.name}`}
                    onToggle={() => setOpen(open === `mcp:${row.name}` ? '' : `mcp:${row.name}`)}
                  >
                    <ConnectorForm
                      name={row.name}
                      cfg={cfg}
                      busy={busy}
                      onSave={(next) =>
                        void run(
                          // No metadata is sent: the bundle manifest keeps the
                          // description it already has.
                          () => savePluginConnector(plugin.slug, row.name, next),
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

          {tab === 'commands' ? (
            cmds.length === 0 ? (
              <div className="hint">
                No commands in this bundle. A command is a markdown file under{' '}
                <code>commands/</code> whose name is what you type after <code>/</code>; its body is
                sent to the model, with <code>$ARGUMENTS</code> (everything after the command) and{' '}
                <code>$1</code>..<code>$9</code> (single words) replaced.
              </div>
            ) : (
              cmds.map((row) =>
                row.description.trim() ? (
                  <Part
                    key={row.name}
                    name={`/${row.name}`}
                    open={open === `cmd:${row.name}`}
                    onToggle={() => setOpen(open === `cmd:${row.name}` ? '' : `cmd:${row.name}`)}
                  >
                    <span className="hint">
                      {row.description}
                    </span>
                    <span className="hint">
                      Edit the body in <code>commands/{row.name}.md</code>.{' '}
                      <code>$ARGUMENTS</code> is the whole argument string, <code>$1</code>..
                      <code>$9</code> the single words.
                    </span>
                  </Part>
                ) : (
                  <div key={row.name} className="pd-part">
                    <div className="pd-part-head pd-part-head--static">
                      <span className="pd-part-line">
                        <span className="pd-part-name">/{row.name}</span>
                      </span>
                    </div>
                  </div>
                ),
              )
            )
          ) : null}

          {tab === 'agents' ? (
            agents.length === 0 ? (
              <div className="hint">
                No sub-agents in this bundle. A sub-agent is a markdown profile under{' '}
                <code>agents/</code>: its frontmatter names the tools it may use and its body is its
                system prompt. Every one of them runs on the <strong>Explore</strong> row of
                Settings → Tools — same model, same fallback list.
              </div>
            ) : (
              agents.map((row) => (
                <Part
                  key={row.name}
                  name={row.name}
                  badge={row.tools?.length ? `${row.tools.length} tool(s)` : 'all tools'}
                  sub={row.description}
                  open={open === `agent:${row.name}`}
                  onToggle={() => setOpen(open === `agent:${row.name}` ? '' : `agent:${row.name}`)}
                >
                  {row.tools?.length ? (
                    <span className="hint">
                      Tools: <code>{row.tools.join(', ')}</code>
                    </span>
                  ) : null}
                  <span className="hint">
                    Runs on the Explore model row of Settings → Tools. Edit it in{' '}
                    <code>agents/{row.name}.md</code>.
                  </span>
                </Part>
              ))
            )
          ) : null}

          {tab === 'hooks' ? (
            !plugin.hooks?.length ? (
              <div className="hint">
                No hooks in this bundle. A hook is a shell command under{' '}
                <code>hooks/hooks.json</code> that runs at a point of a turn (SessionStart,
                UserPromptSubmit, PreToolUse, PostToolUse, Stop) and may refuse a tool call.
              </div>
            ) : (
              <>
                <div className="pd-hook-state on">
                  These handlers run during a turn while this bundle is enabled — the bundle's own
                  switch on the Plugins page is what turns them on or off.
                </div>
                {plugin.hooks.map((h) => (
                  <div key={`${h.event}:${h.command}`} className="pd-part">
                    <div className="pd-part-head pd-part-head--static">
                      <span className="pd-part-line">
                        <span className="pd-part-name">{h.event}</span>
                        {h.matcher ? <span className="pd-badge">{h.matcher}</span> : null}
                        {h.dispatched === false ? (
                          <span className="pd-badge pd-badge--off">not dispatched</span>
                        ) : null}
                      </span>
                      <span className="pd-part-sub">
                        <code>{h.command}</code>
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )
          ) : null}

          {tab === 'scripts' ? (
            scripts.length === 0 ? (
              <div className="hint">
                No scripts in this bundle. A script is a runnable entry point the assistant runs
                during a turn when the bundle's skill calls for it.
              </div>
            ) : (
              scripts.map((row) => (
                <Part
                  key={row.name}
                  name={row.name}
                  badge={row.language}
                  sub={row.description}
                  open={open === `script:${row.name}`}
                  onToggle={() => setOpen(open === `script:${row.name}` ? '' : `script:${row.name}`)}
                >
                  <div className="pd-form-actions">
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
              ))
            )
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
