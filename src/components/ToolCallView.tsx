import { memo, useEffect, useState } from 'react'
import type { ToolActivity } from '../types'
import { useStore } from '../lib/store'
import { api } from '../lib/fs'

const TOOL_LABEL: Record<string, string> = {
  write_file: 'write_file',
  list_files: 'list_files',
  search_in_files: 'search_in_files',
  fuzzy_find: 'fuzzy_find',
  web_search: 'web_search',
  run_terminal: 'run_terminal',
  search_memory: 'search_memory',
  memory: 'memory',
  ask_user: 'ask_user',
  fetch_url: 'fetch_url',
}

function fmtTime(ms?: number): string {
  if (!ms) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function StatusIcon({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') return <span className="spinner" />
  if (status === 'error') return <span className="status-err">✗</span>
  return <span className="status-ok">✓</span>
}

type DiffRow =
  | { type: 'hunk' | 'info'; text: string }
  | {
      type: 'same' | 'del' | 'add' | 'mod'
      before: string
      after: string
      bLine: number
      aLine: number
    }

/** Turn a unified diff into aligned before/after rows for a side-by-side view. */
function parseSideBySide(diff: string): DiffRow[] {
  const raw = diff.split('\n')
  const rows: DiffRow[] = []
  let bLine = 0
  let aLine = 0
  let pendingDel: string[] = []
  let pendingAdd: string[] = []

  const flush = () => {
    if (!pendingDel.length && !pendingAdd.length) return
    const n = Math.max(pendingDel.length, pendingAdd.length)
    for (let i = 0; i < n; i++) {
      const hasB = i < pendingDel.length
      const hasA = i < pendingAdd.length
      const type: DiffRow['type'] =
        hasB && hasA ? 'mod' : hasB ? 'del' : 'add'
      rows.push({
        type,
        before: hasB ? pendingDel[i] : '',
        after: hasA ? pendingAdd[i] : '',
        bLine: hasB ? bLine : -1,
        aLine: hasA ? aLine : -1,
      })
      if (hasB) bLine++
      if (hasA) aLine++
    }
    pendingDel = []
    pendingAdd = []
  }

  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
  for (const line of raw) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    const hm = hunkRe.exec(line)
    if (hm) {
      flush()
      bLine = parseInt(hm[1], 10)
      aLine = parseInt(hm[2], 10)
      rows.push({ type: 'hunk', text: line })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      rows.push({ type: 'info', text: line })
    } else if (line.startsWith('-')) {
      pendingDel.push(line.slice(1))
    } else if (line.startsWith('+')) {
      pendingAdd.push(line.slice(1))
    } else {
      flush()
      rows.push({
        type: 'same',
        before: line.slice(1),
        after: line.slice(1),
        bLine,
        aLine,
      })
      bLine++
      aLine++
    }
  }
  flush()
  return rows
}

function DiffView({ diff }: { diff: string }) {
  const rows = parseSideBySide(diff)
  if (rows.length === 0) return null
  return (
    <div className="diff-side" dir="ltr">
      <div className="diff-side-head">
        <span>Before</span>
        <span>After</span>
      </div>
      {rows.map((row, i) => {
        if ('text' in row) {
          return (
            <div key={i} className={`diff-side-meta ${row.type}`}>
              {row.text}
            </div>
          )
        }
        const beforeCls =
          row.type === 'same'
            ? 'diff-context'
            : row.type === 'del' || row.type === 'mod'
              ? 'diff-del'
              : ''
        const afterCls =
          row.type === 'same'
            ? 'diff-context'
            : row.type === 'add' || row.type === 'mod'
              ? 'diff-add'
              : ''
        return (
          <div key={i} className={`diff-side-row ${row.type}`}>
            <span className="diff-side-num">{row.bLine >= 0 ? row.bLine : ''}</span>
            <div className={`diff-side-cell ${beforeCls}`}>{row.before}</div>
            <span className="diff-side-num">{row.aLine >= 0 ? row.aLine : ''}</span>
            <div className={`diff-side-cell ${afterCls}`}>{row.after}</div>
          </div>
        )
      })}
    </div>
  )
}

type DiffItem = { kind: 'ctx' | 'del' | 'add' | 'marker'; text: string }
type Hunk = { newStart: number; items: DiffItem[] }

/** Parse a unified diff into hunks (with the new-file start line of each). */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
  let cur: Hunk | null = null
  const lines = diff.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    const m = hunkRe.exec(line)
    if (m) {
      cur = { newStart: parseInt(m[2], 10), items: [] }
      hunks.push(cur)
    } else if (cur) {
      if (line.startsWith('\\')) cur.items.push({ kind: 'marker', text: '' })
      else if (line.startsWith('+')) cur.items.push({ kind: 'add', text: line.slice(1) })
      else if (line.startsWith('-')) cur.items.push({ kind: 'del', text: line.slice(1) })
      else cur.items.push({ kind: 'ctx', text: line.slice(1) })
    }
  }
  return hunks
}

/**
 * Reverse-apply a unified diff onto the current file content to recover the
 * pre-write contents. Unchanged gap lines (not shown in the diff) are taken
 * from the current file using each hunk's new-file start line.
 */
function applyReverseDiff(diff: string, current: string): string {
  const cur = current.split('\n')
  if (current.endsWith('\n')) cur.pop()
  const hunks = parseHunks(diff)
  const out: string[] = []
  let ci = 0
  let oldEofNoNewline = false
  for (const hunk of hunks) {
    const target = hunk.newStart - 1
    while (ci < target && ci < cur.length) {
      out.push(cur[ci])
      ci++
    }
    let prev: DiffItem['kind'] | null = null
    for (const item of hunk.items) {
      if (item.kind === 'marker') {
        if (prev === 'del' || prev === 'ctx') oldEofNoNewline = true
        prev = null
        continue
      }
      if (item.kind === 'ctx') {
        prev = 'ctx'
        out.push(ci < cur.length ? cur[ci] : item.text)
        ci++
      } else if (item.kind === 'add') {
        prev = 'add'
        ci++
      } else {
        prev = 'del'
        out.push(item.text)
      }
    }
  }
  for (; ci < cur.length; ci++) out.push(cur[ci])
  let content = out.join('\n')
  if (!oldEofNoNewline) content += '\n'
  return content
}

/** Compact "N read-only calls" summary for a run of consecutive non-write tool
 *  activities, so a search-heavy turn doesn't stack a full row per call. Kept
 *  collapsed by default; expanding reveals the normal ToolCallView for each
 *  one (so args/summary/diff drill-down still works exactly as before). */
export const ToolGroupView = memo(function ToolGroupView({
  activities,
  onReverted,
}: {
  activities: { activity: ToolActivity; index: number }[]
  onReverted: (index: number) => void
}) {
  const [open, setOpen] = useState(false)
  const running = activities.some((a) => a.activity.status === 'running')
  const errored = activities.some((a) => a.activity.status === 'error')
  const totalMs = activities.reduce((sum, a) => sum + (a.activity.elapsedMs || 0), 0)

  const counts: Record<string, number> = {}
  for (const { activity } of activities) {
    counts[activity.tool] = (counts[activity.tool] || 0) + 1
  }
  const detail = Object.entries(counts)
    .map(([tool, n]) => `${n} ${TOOL_LABEL[tool] ?? tool}`)
    .join(', ')

  return (
    <div className={`tool-group ${errored ? 'error' : running ? 'running' : 'done'}`}>
      <button className={`tool-group-head ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        {running ? (
          <span className="spinner" />
        ) : errored ? (
          <span className="status-err">✗</span>
        ) : (
          <span className="status-ok">✓</span>
        )}
        <span className="tool-group-label">{activities.length} tool calls</span>
        <span className="tool-group-detail">{detail}</span>
        <span className="tool-ms">{fmtTime(totalMs)}</span>
        <span className={`chev ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {activities.map(({ activity, index }) => (
            <ToolCallView
              key={index}
              activity={activity}
              onReverted={() => onReverted(index)}
            />
          ))}
        </div>
      )}
    </div>
  )
})

// Tools whose card should start expanded (the action itself IS the useful
// content — a diff, a saved note, a new skill/connector — so a collapsed
// default would hide the very thing the user needs to see happened).
const OPEN_BY_DEFAULT = new Set(['write_file', 'edit_file', 'memory', 'create_skill', 'create_mcp', 'web_search'])

export const ToolCallView = memo(function ToolCallView({
  activity,
  onReverted,
}: {
  activity: ToolActivity
  onReverted?: () => void
}) {
  const [open, setOpen] = useState(() => OPEN_BY_DEFAULT.has(activity.tool))
  const [reverting, setReverting] = useState(false)
  const root = useStore((s) => s.root)

  // Live elapsed time while the tool is still running.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (activity.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [activity.status])
  const ms =
    activity.status === 'running' && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs

  const hasExpand =
    activity.args || activity.summary || activity.diff
  const isWrite = activity.tool === 'write_file' || activity.tool === 'edit_file'

  const revert = async () => {
    if (!activity.diff || !root) return
    setReverting(true)
    try {
      const path = String(activity.args?.path ?? '')
      const { content: current } = await api.fsRead(root, path)
      const oldContent = applyReverseDiff(activity.diff, current ?? '')
      const ok = await api.fsWrite(root, path, oldContent)
      if (ok) onReverted?.()
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className={`tool-card ${activity.status}`}>
      <button
        className={`tool-card-head ${open ? 'open' : ''}`}
        onClick={() => hasExpand && setOpen((o) => !o)}
        disabled={!hasExpand}
      >
        <StatusIcon status={activity.status} />
        <span className="tool-name">{TOOL_LABEL[activity.tool] ?? activity.tool}</span>
        {activity.tool === 'web_search' && activity.engine && (
          <span className="tool-badge">{activity.engine}</span>
        )}
        {activity.args && activity.args.command !== undefined && (
          <span className="tool-cmd">{String(activity.args.command)}</span>
        )}
        {activity.args && activity.args.path !== undefined && (
          <span className="tool-path">{String(activity.args.path)}</span>
        )}
        {activity.args && activity.args.start !== undefined && (
          <span className="tool-path">
            {String(activity.args.start)}
            {activity.args.end !== undefined && activity.args.end !== -1
              ? `–${String(activity.args.end)}`
              : '+'}
          </span>
        )}
        {activity.args && activity.args.query !== undefined && (
          <span className="tool-cmd">{String(activity.args.query)}</span>
        )}
        {activity.tool === 'memory' && activity.args && (
          <span className="tool-cmd">
            {String(activity.args.text || activity.args.subject || '')}
          </span>
        )}
        <span className="tool-ms">{fmtTime(ms)}</span>
        {hasExpand && (
          <span className={`chev ${open ? 'open' : ''}`}>▾</span>
        )}
      </button>

      {open && (
        <div className="tool-card-body">
          {activity.args && Object.keys(activity.args).length > 0 && (
            <pre className="tool-args" dir="ltr">
              {JSON.stringify(activity.args, null, 2)}
            </pre>
          )}
          {activity.summary && <div className="tool-summary">{activity.summary}</div>}
          {activity.tool === 'web_search' && activity.items && activity.items.length > 0 && (
            <ul className="web-results">
              {activity.items.map((it, i) => (
                <li key={i} className="web-result">
                  <a className="web-result-link" href={it.url} target="_blank" rel="noreferrer">
                    {it.title || it.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {activity.diff && <DiffView diff={activity.diff} />}
          {isWrite && activity.diff && !activity.reverted && (
            <button
              className="btn secondary revert-btn"
              disabled={reverting}
              onClick={revert}
            >
              {reverting ? 'Reverting…' : '↩ Revert'}
            </button>
          )}
          {isWrite && activity.reverted && (
            <span className="reverted-tag">reverted</span>
          )}
        </div>
      )}
    </div>
  )
})
