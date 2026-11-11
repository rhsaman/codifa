import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CustomSubagent } from '../../types'
import { listPluginAgents, type PluginAgentRow } from '../../lib/plugins'
import {
  defaultCustomSubagents,
  isBuiltinSubagent,
  useStore,
} from '../../lib/store'
import { providerHue } from './rows'

/** How a saved row is labelled. The capability is DERIVED from the tools, not
 *  picked in a separate "Kind" field: adding browser_* makes a browser agent,
 *  adding `computer` makes a desktop agent, anything else is research. */
const KIND_LABEL: Record<string, string> = {
  research: 'Research',
  browser: 'Browser',
  computer: 'Desktop',
}

/** Common native tool names, offered as one-click chips. The Tools field stays
 *  free text, so any exact name — a browser_* action, `computer`, an `lsp_*`
 *  lookup — can still be typed. */
const TOOL_SUGGESTIONS: { name: string; label: string }[] = [
  { name: 'read', label: 'Read' },
  { name: 'write_file', label: 'Write' },
  { name: 'edit_file', label: 'Edit' },
  { name: 'run_terminal', label: 'Terminal' },
  { name: 'grep', label: 'Grep' },
  { name: 'glob', label: 'Glob' },
  { name: 'find_symbol', label: 'Find symbol' },
  { name: 'lsp_symbols', label: 'LSP outline' },
  { name: 'lsp_definition', label: 'LSP definition' },
  { name: 'lsp_references', label: 'LSP references' },
  { name: 'lsp_diagnostics', label: 'LSP diagnostics' },
  { name: 'batch_search', label: 'Batch search' },
  { name: 'web_search', label: 'Web search' },
  { name: 'fetch_url', label: 'Fetch URL' },
  { name: 'browser_navigate', label: 'Browser navigate' },
  { name: 'browser_snapshot', label: 'Browser snapshot' },
  { name: 'browser_click', label: 'Browser click' },
  { name: 'browser_type', label: 'Browser type' },
  { name: 'computer', label: 'Desktop control' },
  { name: 'search_memory', label: 'Memory search' },
  { name: 'save_memory', label: 'Memory save' },
]

/** A bundle writes Claude Code tool names (`Bash`, `Grep`, …). The row should
 *  show what the agent will actually call, so the pack's names are mapped to
 *  Codifa's (`canonical_subagent_tool` is the backend twin of this table). */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'run_terminal',
  edit: 'edit_file',
  write: 'write_file',
  ls: 'glob',
  task: 'explore',
  todowrite: 'update_plan',
  websearch: 'web_search',
  webfetch: 'fetch_url',
  notebookedit: 'edit_file',
}

function displayTool(tool: string): string {
  return TOOL_ALIASES[tool.trim().toLowerCase()] ?? tool
}

/** A sub-agent's capability comes from its tools. `computer` owns native
 *  apps; any `browser_*` tool owns live pages; everything else is the
 *  read-only research set. This keeps Settings free of a separate Kind picker
 *  while still giving the backend the kind it gates on. */
function kindForTools(tools: string[]): NonNullable<CustomSubagent['kind']> {
  const names = tools.map((tool) => tool.trim().toLowerCase().replace(/[\s-]+/g, '_'))
  if (names.includes('computer')) return 'computer'
  if (names.some((name) => name.startsWith('browser_'))) return 'browser'
  return 'research'
}

/** What an empty tools list means in practice. The backend applies these
 *  defaults, so the card can show them instead of a blank row. */
function effectiveTools(tools: string[], kind: string): string[] {
  if (tools.length > 0) return tools
  if (kind === 'browser') return ['browser_*']
  if (kind === 'computer') return ['computer']
  return ['default research set']
}

/** The built-in sub-agent: always installed, always delegable, not a settings
 *  row. It is shown here so the tab lists every sub-agent the main agent can
 *  call — before this card, `explore` looked missing even though the main agent
 *  used it on every research task. */
const BUILTIN_SUBAGENTS: { id: string; name: string; description: string; tools: string[] }[] = [
  {
    id: 'explore',
    name: 'Explore',
    description:
      'Built-in research agent. Reads files, searches the workspace, runs LSP lookups, and uses web_search / fetch_url for docs, packages and current facts. The main agent delegates broad research to it and gets a full report back.',
    tools: [
      'read',
      'grep',
      'glob',
      'find_symbol',
      'lsp_definition',
      'lsp_references',
      'lsp_hover',
      'lsp_symbols',
      'lsp_diagnostics',
      'web_search',
      'fetch_url',
      'batch_search',
      'load_plugin',
      'search_memory',
      'save_memory',
      'delete_memory',
    ],
  },
]

function blank(id: string): CustomSubagent {
  return { id, name: '', description: '', prompt: '', tools: [], plugins: [], kind: 'research' }
}

/** A stable, tool-name-safe id. The backend exposes `agent__<slug>`, so the id
 *  must survive the same slugging `delegation_tool_name` does. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
}

/** One agent as a card in the same visual language as Settings → Plugins:
 *  avatar, name + origin line, a count pill, a clamped description, a capped
 *  tool strip and one footer row. */
function AgentCard({
  name,
  description,
  tools,
  kind,
  origin,
  footer,
}: {
  name: string
  description: string
  tools: string[]
  kind?: string
  origin: string
  footer: ReactNode
}) {
  const resolvedKind = kind ?? 'research'
  const kindLabel = KIND_LABEL[resolvedKind] ?? 'Research'
  const names = effectiveTools(tools, resolvedKind)
  const shown = names.slice(0, 6)
  const extra = names.length - shown.length
  return (
    <div className="pm-card subagent-card">
      <div className="pm-card-head">
        <span
          className="pm-avatar"
          style={{ '--h': providerHue(name) } as CSSProperties}
          aria-hidden="true"
        >
          {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="pm-card-title">
          <span className="pm-card-name" title={name}>
            {name}
          </span>
          <span className="pm-card-state">
            {kindLabel} · {origin}
          </span>
        </div>
        <span
          className="pm-count"
          title={tools.length ? 'Tools declared by this agent' : 'Default tool set'}
        >
          {tools.length ? `${tools.length} tools` : 'default set'}
        </span>
      </div>
      <div className="pm-card-desc" title={description}>
        {description || 'No description'}
      </div>
      <div className="subagent-tool-line" title={names.join(', ')}>
        {shown.map((tool) => (
          <code key={tool}>{displayTool(tool)}</code>
        ))}
        {extra > 0 ? <span className="subagent-tool-more">+{extra}</span> : null}
      </div>
      <div className="subagent-card-footer">{footer}</div>
    </div>
  )
}

/** Settings → Sub-agents.
 *
 *  Three lists in one place, because the user thinks of them as one feature:
 *   0. BUILT-IN — Explore, Browser Navigator and Desktop Operator. Fixed rows:
 *      shown here, never editable or deletable from Settings.
 *   1. CUSTOM sub-agents — created here, stored in settings.json, fully editable.
 *   2. PLUGIN sub-agents — read-only; they come from a bundle's `agents/*.md`.
 *
 *  A custom row has NO separate "kind" field: its tools decide. `browser_*`
 *  makes a browser agent, `computer` a desktop agent, anything else research.
 *
 *  NONE of them carries a model. Every one runs on the Tools → "Sub-agent"
 *  row, which is the single model (and fallback list) for all delegation.
 *
 *  NONE of them gets a plugin assignment either: every sub-agent has
 *  `load_plugin` and the full plugin catalog, so it loads whatever toolbox a
 *  task needs on its own — exactly like the main agent.
 *
 *  A bundle can ship dozens of agents (the trading pack has ~30), so plugin
 *  agents stay grouped per bundle and collapsed; a page of raw rows buried the
 *  custom list and made the tab useless. */
export function SubagentsTab() {
  const rows = useStore((s) => s.customSubagents)
  const setRows = useStore((s) => s.setCustomSubagents)

  const [pluginAgents, setPluginAgents] = useState<PluginAgentRow[]>([])
  const [pluginError, setPluginError] = useState('')
  /** Narrows the plugin list; a bundle library is long enough that scrolling
   *  alone is not a way to find one agent. */
  const [agentQuery, setAgentQuery] = useState('')
  /** The row open in the editor; `null` = the list view. */
  const [draft, setDraft] = useState<CustomSubagent | null>(null)
  /** True when `draft` is a NEW row (so Cancel just closes, Save appends). */
  const [isNew, setIsNew] = useState(false)

  useEffect(() => {
    let live = true
    void listPluginAgents().then((res) => {
      if (!live) return
      if (Array.isArray(res)) {
        // A disabled bundle's agents are not delegable (`find_plugin_agent`
        // skips disabled bundles), so listing them here would advertise a
        // sub-agent the main agent can never call.
        setPluginAgents(res.filter((a) => a.plugin_enabled !== false))
        setPluginError('')
      } else {
        setPluginAgents([])
        setPluginError(res.error)
      }
    })
    return () => {
      live = false
    }
  }, [])

  const startNew = () => {
    setDraft(blank(`agent_${Date.now().toString(36)}`))
    setIsNew(true)
  }

  const startEdit = (row: CustomSubagent) => {
    // Shipped rows are built-in: no Edit, no Delete.
    if (isBuiltinSubagent(row.id)) return
    setDraft({
      ...row,
      tools: [...(row.tools ?? [])],
      plugins: [...(row.plugins ?? [])],
      kind: row.kind ?? 'research',
    })
    setIsNew(false)
  }

  const save = () => {
    if (!draft) return
    const name = draft.name.trim()
    const prompt = draft.prompt.trim()
    if (!name || !prompt) return
    // The id is derived from the NAME so `agent__<id>` reads well to the model;
    // an edit keeps the original id so an in-flight chat still resolves it.
    let id = isNew ? slugify(name) || draft.id : draft.id
    if (isNew && isBuiltinSubagent(id)) {
      // A user agent may not shadow a shipped one.
      const base = `${id}_custom`
      let n = 2
      id = base
      while (rows.some((r) => r.id === id)) id = `${base}_${n++}`
    }
    const tools = (draft.tools ?? []).map((t) => t.trim()).filter(Boolean)
    const clean: CustomSubagent = {
      id,
      name,
      description: (draft.description ?? '').trim(),
      prompt,
      tools,
      // Legacy rows may still carry plugin slugs; an edit preserves them so an
      // old row keeps working. New rows start with none — every sub-agent has
      // `load_plugin` and the catalog, so there is nothing to assign.
      plugins: isNew ? [] : (draft.plugins ?? []).map((p) => p.trim()).filter(Boolean),
      // No separate Kind field: the tools decide. An untouched legacy row with
      // no tools keeps the kind it was saved with.
      kind: tools.length === 0 ? (draft.kind ?? 'research') : kindForTools(tools),
    }
    const next = isNew
      ? [...rows.filter((r) => r.id !== id), clean]
      : rows.map((r) => (r.id === clean.id ? clean : r))
    setRows(next)
    setDraft(null)
  }

  const remove = (id: string) => {
    if (isBuiltinSubagent(id)) return
    setRows(rows.filter((r) => r.id !== id))
  }

  if (draft) {
    const canSave = draft.name.trim().length > 0 && draft.prompt.trim().length > 0
    return (
      <div className="subagent-editor">
        <button type="button" className="subagent-back" onClick={() => setDraft(null)}>
          <span aria-hidden="true">←</span> Sub-agents
        </button>

        <div className="panel-card subagent-editor-card">
          <div className="subagent-editor-head">
            <span
              className="pm-avatar"
              style={{ '--h': providerHue(draft.name || 'subagent') } as CSSProperties}
              aria-hidden="true"
            >
              {(draft.name.trim()[0] ?? '?').toUpperCase()}
            </span>
            <div className="subagent-editor-title">
              <div className="panel-card-title">
                {isNew ? 'New sub-agent' : draft.name || 'Untitled sub-agent'}
              </div>
              <p className="panel-card-desc subagent-editor-desc">
                Runs on <b>Tools → Sub-agent</b>. The tools below decide what it can do. Every
                sub-agent can also load any installed plugin with <code>load_plugin</code>.
              </p>
            </div>
          </div>

          <div className="subagent-form">
            <div className="subagent-field">
              <label className="subagent-label" htmlFor="subagent-name">
                Name
              </label>
              <input
                id="subagent-name"
                className="subagent-input"
                value={draft.name}
                placeholder="e.g. Browser Navigator"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>

            <div className="subagent-field">
              <label className="subagent-label" htmlFor="subagent-description">
                Description
              </label>
              <input
                id="subagent-description"
                className="subagent-input"
                value={draft.description ?? ''}
                placeholder="When the main agent should delegate to it"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <span className="subagent-hint">
                The main agent reads this to decide when to call the sub-agent. One clear sentence
                about what it owns works best.
              </span>
            </div>

            <div className="subagent-field">
              <label className="subagent-label" htmlFor="subagent-prompt">
                System prompt
              </label>
              <textarea
                id="subagent-prompt"
                className="subagent-textarea"
                rows={9}
                value={draft.prompt}
                placeholder="The sub-agent's full system prompt — its role, what it must do, what it returns."
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
              <span className="subagent-hint">
                The agent&apos;s full instructions: its role, how it should work, and what it must
                report back.
              </span>
            </div>

            <div className="subagent-field">
              <label className="subagent-label" htmlFor="subagent-tools">
                Tools
              </label>
              <input
                id="subagent-tools"
                className="subagent-input subagent-mono"
                value={(draft.tools ?? []).join(', ')}
                placeholder="comma-separated; empty = read-only research set"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tools: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
              />
              <span className="subagent-hint">
                The tools decide the capability: <code>browser_*</code> owns live pages,{' '}
                <code>computer</code> owns native apps, anything else is research. A non-empty list
                is the exact work set; <code>load_plugin</code> is always kept.
              </span>
            </div>

            <div className="subagent-field">
              <span className="subagent-label">Quick add</span>
              <div className="subagent-tools">
                {TOOL_SUGGESTIONS.map((tool) => {
                  const on = (draft.tools ?? []).includes(tool.name)
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      className="btn tiny"
                      aria-pressed={on}
                      title={tool.name}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          tools: on
                            ? (draft.tools ?? []).filter((t) => t !== tool.name)
                            : [...(draft.tools ?? []), tool.name],
                        })
                      }
                    >
                      {on ? '✓ ' : ''}
                      {tool.label}
                    </button>
                  )
                })}
              </div>
              <span className="subagent-hint">
                Claude Code names also work (<code>Bash</code>, <code>Edit</code>, <code>Write</code>
                , <code>WebSearch</code>, <code>WebFetch</code>). The parent turn&apos;s Ask/Plan
                policy still applies: a read-only turn stays read-only.
              </span>
            </div>

            <div className="subagent-form-actions">
              <button className="btn" onClick={save} disabled={!canSave}>
                Save
              </button>
              <button className="btn secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Bundle agents are grouped so a 30-agent pack is one collapsed row, not a
  // page of its own. A search query expands the groups that still match.
  const query = agentQuery.trim().toLowerCase()
  const matching = query
    ? pluginAgents.filter((a) =>
        `${a.name} ${a.description} ${(a.tools ?? []).join(' ')} ${a.plugin ?? ''}`
          .toLowerCase()
          .includes(query),
      )
    : pluginAgents
  const groups: { key: string; label: string; rows: PluginAgentRow[] }[] = []
  for (const row of matching) {
    const key = row.plugin_slug || row.plugin || 'unknown'
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, label: row.plugin || row.plugin_slug || 'Unknown plugin', rows: [] }
      groups.push(group)
    }
    group.rows.push(row)
  }
  const showAll = Boolean(query) || pluginAgents.length <= 6
  // The shipped browser/desktop rows are BUILT-IN: always present and
  // canonical (the store re-seeds them on load), never editable or deletable.
  // They stay in `customSubagents` because that is the list the backend
  // resolves profiles from, but they render in the built-in section.
  const builtinSeeds = defaultCustomSubagents().map(
    (seed) => rows.find((row) => row.id === seed.id) ?? seed,
  )
  const customRows = rows.filter((row) => !isBuiltinSubagent(row.id))
  const total = BUILTIN_SUBAGENTS.length + builtinSeeds.length + customRows.length + pluginAgents.length

  return (
    <div className="subagents-page">
      <div className="field subagents-intro-field">
        <div className="field-head">
          <label>
            Sub-agents <span className="pm-count">{total}</span>
          </label>
          <button className="btn" onClick={startNew}>
            + New sub-agent
          </button>
        </div>
        <div className="hint">
          Everything here runs on <b>Tools → Sub-agent</b> and can load any installed plugin with{' '}
          <code>load_plugin</code>.
        </div>
      </div>

      <section className="subagents-section">
        <div className="field-head subagents-section-head">
          <label>
            Built-in <span className="pm-count">{BUILTIN_SUBAGENTS.length + builtinSeeds.length}</span>
          </label>
        </div>
        <p className="hint subagents-section-desc">
          Always installed. Explore handles broad research; Browser Navigator owns live pages;
          Desktop Operator owns native apps.
        </p>
        <div className="settings-grid">
          {BUILTIN_SUBAGENTS.map((agent) => (
            <AgentCard
              key={agent.id}
              name={agent.name}
              description={agent.description}
              tools={agent.tools}
              kind="research"
              origin="Built-in"
              footer={<span className="subagent-foot-note">Read-only · always installed</span>}
            />
          ))}
          {builtinSeeds.map((agent) => (
            <AgentCard
              key={agent.id}
              name={agent.name}
              description={agent.description ?? ''}
              tools={agent.tools ?? []}
              kind={agent.kind}
              origin="Built-in"
              footer={<span className="subagent-foot-note">Read-only · always installed</span>}
            />
          ))}
        </div>
      </section>

      <section className="subagents-section">
        <div className="field-head subagents-section-head">
          <label>
            Custom sub-agents <span className="pm-count">{customRows.length}</span>
          </label>
        </div>
        <p className="hint subagents-section-desc">
          Created here and stored in <code>settings.json</code>. The built-in agents above stay
          read-only; these rows are yours to edit or delete.
        </p>

        {customRows.length === 0 ? (
          <div className="hint empty-state">
            No custom sub-agents yet. Use <b>New sub-agent</b> above to create one.
          </div>
        ) : (
          <div className="settings-grid">
            {customRows.map((row) => (
              <AgentCard
                key={row.id}
                name={row.name}
                description={row.description ?? ''}
                tools={row.tools ?? []}
                kind={row.kind}
                origin="Custom"
                footer={
                  <>
                    <button
                      type="button"
                      className="subagent-edit"
                      onClick={() => startEdit(row)}
                    >
                      <span>Edit</span>
                      <span className="subagent-edit-hint">Prompt &amp; tools</span>
                      <span className="pd-chevron" aria-hidden="true">
                        ▶
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn tiny secondary pm-danger"
                      onClick={() => remove(row.id)}
                    >
                      Delete
                    </button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="subagents-section">
        <div className="field-head subagents-section-head">
          <label>
            Plugin sub-agents <span className="pm-count">{pluginAgents.length}</span>
          </label>
        </div>
        <p className="hint subagents-section-desc">
          Shipped by installed bundles (<code>agents/*.md</code>). Edit the bundle file to change
          one. Each carries its own plugin; load any other with <code>load_plugin</code>.
        </p>

        {pluginAgents.length > 6 && (
          <div className="settings-search subagents-search">
            <input
              type="search"
              value={agentQuery}
              placeholder={`Search ${pluginAgents.length} plugin sub-agents…`}
              onChange={(e) => setAgentQuery(e.target.value)}
            />
          </div>
        )}
        {pluginError && <div className="hint error-text">{pluginError}</div>}
        {!pluginError && pluginAgents.length === 0 && (
          <div className="hint empty-state">No enabled plugin ships a sub-agent.</div>
        )}
        {!pluginError && pluginAgents.length > 0 && matching.length === 0 && (
          <div className="hint empty-state">No plugin sub-agent matches “{agentQuery.trim()}”.</div>
        )}
        {groups.map((group) => (
          <details className="subagent-group" key={group.key} open={showAll}>
            <summary className="subagent-group-head">
              <span
                className="pm-avatar subagent-group-avatar"
                style={{ '--h': providerHue(group.label) } as CSSProperties}
                aria-hidden="true"
              >
                {(group.label.trim()[0] ?? '?').toUpperCase()}
              </span>
              <span className="subagent-group-name">{group.label}</span>
              <span className="pm-count">
                {group.rows.length} sub-agent{group.rows.length === 1 ? '' : 's'}
              </span>
              <span className="subagent-group-chevron" aria-hidden="true">
                ▶
              </span>
            </summary>
            <div className="subagent-group-body">
              <div className="settings-grid">
                {group.rows.map((row, i) => (
                  <AgentCard
                    key={`${row.name}-${i}`}
                    name={row.name}
                    description={row.description}
                    tools={row.tools ?? []}
                    kind="research"
                    origin="Plugin"
                    footer={
                      <span className="subagent-foot-note">Read-only · edit the bundle file</span>
                    }
                  />
                ))}
              </div>
            </div>
          </details>
        ))}
      </section>
    </div>
  )
}
