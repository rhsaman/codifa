import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ToolActivity } from '../types'
import { useStore } from '../lib/store'
import { api } from '../lib/fs'
import { fixZwsp } from '../lib/bidi'
import { FullscreenModal } from './FullscreenModal'
import { useFullscreen } from '../lib/fullscreen'

const TOOL_LABEL: Record<string, string> = {
  write_file: 'write_file',
  list_files: 'list_files',
  grep: 'grep',
  glob: 'glob',
  web_search: 'web_search',
  run_terminal: 'run_terminal',
  search_memory: 'search_memory',
  memory: 'memory',
  ask_user: 'ask_user',
  fetch_url: 'fetch_url',
  task: 'task',
  vision: 'vision',
}

/** Small glyph per tool category, shown at the head of each collapsed-group
 *  timeline row — lets the eye scan a run of calls without reading every
 *  label (mirrors Claude-app's trace icons). */
const TOOL_ICON: Record<string, string> = {
  run_terminal: '❯',
  list_files: '📁',
  grep: '🔍',
  glob: '🔍',
  web_search: '🌐',
  fetch_url: '🌐',
  search_memory: '🧠',
  memory: '🧠',
  ask_user: '❓',
  task: '🧩',
  vision: '🖼',
  create_skill: '⚙',
  create_mcp: '🔌',
}
function toolIcon(tool: string): string {
  return TOOL_ICON[tool] ?? '•'
}

/** Natural-language piece per tool category for the group header sentence
 *  ("9 commands, 3 searches, 2 notes") — the Claude-app-style summary line
 *  instead of a raw tool-name tally. */
const TOOL_NOUN: Record<string, [string, string]> = {
  run_terminal: ['command', 'commands'],
  list_files: ['file listing', 'file listings'],
  grep: ['search', 'searches'],
  glob: ['search', 'searches'],
  web_search: ['web search', 'web searches'],
  fetch_url: ['page fetch', 'page fetches'],
  search_memory: ['memory search', 'memory searches'],
  memory: ['note', 'notes'],
  ask_user: ['question', 'questions'],
  task: ['sub-agent call', 'sub-agent calls'],
  vision: ['image lookup', 'image lookups'],
  create_skill: ['skill saved', 'skills saved'],
  create_mcp: ['connector added', 'connectors added'],
}
function groupSummary(activities: ToolActivity[]): string {
  const counts: Record<string, number> = {}
  for (const a of activities) counts[a.tool] = (counts[a.tool] || 0) + 1
  return Object.entries(counts)
    .map(([tool, n]) => {
      const noun = TOOL_NOUN[tool] ?? ['tool call', 'tool calls']
      return `${n} ${n === 1 ? noun[0] : noun[1]}`
    })
    .join(', ')
}

/** A task card running the explore agent (opencode-style subagent). */
export const isExploreCard = (a: ToolActivity) =>
  a.tool === 'task' && a.args?.subagent_type === 'explore'

function fmtTime(ms?: number): string {
  if (!ms) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function StatusIcon({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') return <span className="spinner" />
  if (status === 'error') return <span className="status-err">✗</span>
  if (status === 'denied') return <span className="status-denied">⏹</span>
  return <span className="status-ok">✓</span>
}

/** Keys already rendered as dedicated chips in the tool-card head. */
const HEADER_SHOWN_KEYS = new Set([
  'command',
  'path',
  'filePath',
  'offset',
  'limit',
  'start',
  'end',
  'query',
  'pattern',
  'task',
  'description',
  'subagent_type',
  'prompt',
  'task_id',
  'text',
  'subject',
  'paths',
  'engine',
])

/** Huge payloads that are never worth showing inline (the diff shows them). */
const HIDDEN_KEYS = new Set(['content', 'old_string', 'new_string'])

function fmtArgValue(v: unknown): string {
  if (typeof v === 'string') return fixZwsp(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(fmtArgValue).join(', ')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Remaining args rendered as clean `key: value` chips inside the card head —
 *  no raw JSON blob in the body. */
function ToolArgs({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(
    ([k]) => !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k),
  )
  if (entries.length === 0) return null
  return (
    <span className="tool-args" dir="ltr">
      {entries.map(([k, v]) => (
        <span key={k} className="tool-arg">
          <span className="tool-arg-key">{k}</span>
          <span className="tool-arg-val">{fmtArgValue(v)}</span>
        </span>
      ))}
    </span>
  )
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

/** Claude-app style trace group: a single collapsible summary line ("9
 *  commands, 3 searches, 2 notes") for a run of consecutive non-write tool
 *  activities. Collapsed by default — no preview stack. Expanding reveals a
 *  flat vertical timeline (icon + label + status per call), not a stack of
 *  full cards, matching Claude.ai's own tool-trace UI. */
export const ToolGroupView = memo(function ToolGroupView({
  activities,
  caption,
}: {
  activities: { activity: ToolActivity; index: number }[]
  /** The short narration line the model wrote right before this run of calls
   *  (see renderSegments in ChatMessage.tsx). Shown as a caption above the
   *  collapsible head so the group reads as "here's what I'm doing, here's
   *  the calls" instead of a bare count summary. */
  caption?: string
  onReverted?: (index: number) => void
}) {
  const [open, setOpen] = useState(false)
  const running = activities.some((a) => a.activity.status === 'running')
  const errored = activities.every((a) => a.activity.status === 'error')
  const denied = activities.every((a) => a.activity.status === 'denied')
  const totalMs = activities.reduce((sum, a) => sum + (a.activity.elapsedMs || 0), 0)
  const summary = groupSummary(activities.map((a) => a.activity))

  return (
    <div className={`tool-group ${errored ? 'error' : running ? 'running' : denied ? 'denied' : 'done'}`}>
      {caption && (
        <div className="tool-narrated-caption" dir="auto">
          {fixZwsp(caption)}
        </div>
      )}
      <button className={`tool-group-head ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? 'open' : ''}`}>▾</span>
        {running ? (
          <span className="spinner" />
        ) : errored ? (
          <span className="status-err">✗</span>
        ) : denied ? (
          <span className="status-denied">⏹</span>
        ) : (
          <span className="status-ok">✓</span>
        )}
        <span className="tool-group-label">{summary}</span>
        <span className="tool-ms">{fmtTime(totalMs)}</span>
      </button>
      {open && (
        <div className="tool-timeline">
          {activities.map(({ activity, index }) => (
            <ToolTimelineRow key={index} activity={activity} />
          ))}
        </div>
      )}
    </div>
  )
})

/** Compact one-line detail for a collapsed tool row. Mirrors the chips the
 *  full card head shows (command/path/pattern/description/memory text/url…),
 *  so a collapsed preview never shows an empty row for tools whose args the
 *  old path-only summary missed (run_terminal, memory, fetch_url, task…). */
function subArgSummary(activity: ToolActivity): string {
  const args = activity.args
  if (!args) return ''
  const parts: string[] = []

  // run_terminal: the shell command
  if (args.command !== undefined && args.command !== '') {
    parts.push(String(args.command))
  }

  // read/write/edit/list_files: path + real line range (mirrors the card head)
  const path = String(args.filePath ?? args.path ?? '')
  if (path) {
    let p = path
    const startRaw = args.offset ?? args.start
    const limitRaw = args.limit
    const st = Number(startRaw)
    const lm = Number(limitRaw)
    if (startRaw !== undefined && startRaw !== '' && Number.isFinite(st) && st >= 0) {
      // Show the real range (mirrors the main tool card) instead of a fake "…".
      if (limitRaw !== undefined && limitRaw !== '' && Number.isFinite(lm) && lm > 0) {
        p += `:${st}–${st + lm - 1}`
      } else {
        p += `:${st}`
      }
    } else if (limitRaw !== undefined && limitRaw !== '' && Number.isFinite(lm) && lm > 0) {
      p += `:1–${lm}`
    }
    parts.push(p)
  }

  // grep/glob/web_search: pattern or query
  const pattern = String(args.pattern ?? args.query ?? '')
  if (pattern) parts.push(pattern)

  // task: the short description (the full card shows it as the task chip)
  const description = String(args.description ?? '')
  if (description) parts.push(description)

  // memory: the remembered text / subject
  const memText = String(args.text ?? args.subject ?? '')
  if (memText) parts.push(memText)

  // fetch_url: the URL
  const url = String(args.url ?? '')
  if (url) parts.push(url)

  // web_search: engine badge
  const engine = String(args.engine ?? '')
  if (engine) parts.push(engine)

  // Fallback: any remaining args as `key:value` chips (same as ToolArgs in the
  // card head) so no tool ever collapses to an empty row.
  const covered = new Set([
    'command', 'path', 'filePath', 'offset', 'limit', 'start', 'end',
    'query', 'pattern', 'description', 'text', 'subject', 'url', 'engine',
    'content', 'old_string', 'new_string', 'prompt', 'subagent_type', 'task_id',
  ])
  const rest = Object.entries(args)
    .filter(([k]) => !covered.has(k))
    .map(([k, v]) => `${k}:${fmtArgValue(v)}`)
  if (rest.length > 0) parts.push(rest.join(' '))

  return parts.join(' · ')
}

/** Non-collapsable row for ONE sub-agent tool call (explore's internal
 *  read/grep/glob). Distinct from a collapse card: always fully expanded, no
 *  chevron, compact single-line with the same detail (path/pattern/status/ms)
 *  a closed card would show. */
export const ToolSubRow = memo(function ToolSubRow({ activity }: { activity: ToolActivity }) {
  const [now, setNow] = useState(() => Date.now())
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const subSummary = subArgSummary(activity)
  return (
    <div className={`tool-sub-row ${activity.status}${running ? ' running' : ''}`}>
      <StatusIcon status={activity.status} />
      <span className="tool-sub-name">{TOOL_LABEL[activity.tool] ?? activity.tool}</span>
      {activity.model && (
        <span className="tool-badge tool-model-badge" title={`Ran on ${activity.model}`}>
          {activity.model}
        </span>
      )}
      <span className="tool-sub-args" title={subSummary}>
        {subSummary}
      </span>
      {activity.summary && <span className="tool-sub-summary">{activity.summary}</span>}
      <span className="tool-ms">{fmtTime(ms)}</span>
    </div>
  )
})

/** One row in a group's expanded timeline: category icon, tool label, a
 *  one-line arg summary, status glyph and elapsed time — flat text, no card
 *  border/background, connected by the `.tool-timeline` spine. Mirrors
 *  Claude.ai's own trace rows (icon + short description) rather than the
 *  boxed mini-cards the old cascade preview used. */
const ToolTimelineRow = memo(function ToolTimelineRow({ activity }: { activity: ToolActivity }) {
  const [now, setNow] = useState(() => Date.now())
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const detail = subArgSummary(activity)
  return (
    <div className={`tool-timeline-item ${activity.status}`}>
      <span className="tool-timeline-icon" aria-hidden="true">
        {running ? <span className="spinner" /> : toolIcon(activity.tool)}
      </span>
      <span className="tool-timeline-label">{TOOL_LABEL[activity.tool] ?? activity.tool}</span>
      {activity.model && (
        <span className="tool-badge tool-model-badge" title={`Ran on ${activity.model}`}>
          {activity.model}
        </span>
      )}
      {detail && (
        <span className="tool-timeline-detail" title={detail}>
          {detail}
        </span>
      )}
      <StatusIcon status={activity.status} />
      <span className="tool-ms">{fmtTime(ms)}</span>
    </div>
  )
})

/** How many of the newest calls the collapsed preview shows. */
const PREVIEW_COUNT = 3

/** Collapsed preview: the newest PREVIEW_COUNT calls as a cascading stack of
 *  mini-cards (each newer card overlaps the one above it). Always shows the
 *  last 3, so as new calls stream in the preview live-updates to the newest. */
const ToolCascade = memo(function ToolCascade({ activities }: { activities: ToolActivity[] }) {
  // Chronological order: oldest on top, newest at the bottom (reads like a log).
  const last = activities.slice(-PREVIEW_COUNT)
  const listRef = useRef<HTMLDivElement>(null)
  const prevTops = useRef<Map<string, number>>(new Map())
  const firstRun = useRef(true)

  // FLIP: when the list changes, glide every card from its previous spot to its
  // new one (brand-new cards rise in from below) instead of letting the layout
  // jump — that jump is what made the preview feel like it was shaking.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const items = Array.from(el.children) as HTMLElement[]
    const nextTops = new Map<string, number>()
    const glide =
      'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease'
    for (const item of items) {
      const key = item.dataset.key ?? ''
      const next = item.offsetTop
      const prev = prevTops.current.get(key)
      if (firstRun.current) {
        nextTops.set(key, next)
        continue
      }
      if (prev === undefined) {
        // brand-new card: rise in from below
        item.style.transition = 'none'
        item.style.transform = 'translateY(14px)'
        item.style.opacity = '0'
        void item.offsetHeight
        item.style.transition = glide
        item.style.transform = ''
        item.style.opacity = ''
      } else if (prev !== next) {
        // moved card: invert the jump, then glide to the new spot
        item.style.transition = 'none'
        item.style.transform = `translateY(${prev - next}px)`
        void item.offsetHeight
        item.style.transition = glide
        item.style.transform = ''
      }
      nextTops.set(key, next)
    }
    prevTops.current = nextTops
    firstRun.current = false
  }, [last])

  return (
    <div className="tool-cascade" ref={listRef}>
      {last.map((a, i) => (
        <div
          key={a.callId ?? `${a.tool}-${i}`}
          data-key={a.callId ?? `${a.tool}-${i}`}
          className="tool-cascade-item"
          style={{ zIndex: i + 1 }}
        >
          <ToolSubRow activity={a} />
        </div>
      ))}
    </div>
  )
})

/**
 * A SINGLE read-only tool call rendered as ONE cohesive row — not a header
 * bolted onto an empty body (which is what a lone ToolCallView looks like for
 * grep/read/glob/search). Anthropic-frontend principles: one clear unit,
 * restrained chrome, status + name + args + time in a single quiet line. Used
 * for standalone single calls; multi-call runs still collapse into a group.
 */
export const ToolSingleRow = memo(function ToolSingleRow({
  activity,
}: {
  activity: ToolActivity
}) {
  const [now, setNow] = useState(() => Date.now())
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const detail = subArgSummary(activity)
  const hasBody =
    Boolean(activity.summary) ||
    Boolean(activity.items?.length) ||
    Boolean(activity.children?.length)
  return (
    <div className={`tool-single ${activity.status}${running ? ' running' : ''}`}>
      <StatusIcon status={activity.status} />
      <span className="tool-name">{TOOL_LABEL[activity.tool] ?? activity.tool}</span>
      {activity.model && (
        <span className="tool-badge tool-model-badge" title={`Ran on ${activity.model}`}>
          {activity.model}
        </span>
      )}
      {activity.tool === 'web_search' && activity.engine && (
        <span className="tool-badge">{activity.engine}</span>
      )}
      {detail && (
        <span className="tool-single-detail" title={detail}>
          {detail}
        </span>
      )}
      {hasBody && activity.summary && (
        <span className="tool-single-summary">{fixZwsp(activity.summary)}</span>
      )}
      <span className="tool-ms">{fmtTime(ms)}</span>
    </div>
  )
})

/**
 * A read-only tool call paired with the short narration line the model wrote
 * right before calling it (e.g. "بذار ببینم X رو..."). Instead of stacking a
 * full paragraph text block above a separate, unrelated tool row — which is
 * what made multi-step tool runs feel noisy (every call got its own two-part
 * block) — the caption and the call render as ONE quiet unit: caption line on
 * top, compact tool line below, sharing a single card. See renderSegments in
 * ChatMessage.tsx for how captions get attached to the call(s) that follow
 * them. Falls back to the plain ToolSingleRow when there's no caption.
 */
export const ToolNarratedRow = memo(function ToolNarratedRow({
  caption,
  activity,
}: {
  caption?: string
  activity: ToolActivity
}) {
  const [now, setNow] = useState(() => Date.now())
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const detail = subArgSummary(activity)
  const hasBody =
    Boolean(activity.summary) || Boolean(activity.items?.length) || Boolean(activity.children?.length)

  if (!caption) return <ToolSingleRow activity={activity} />

  return (
    <div className={`tool-narrated ${activity.status}${running ? ' running' : ''}`}>
      <div className="tool-narrated-caption" dir="auto">
        {fixZwsp(caption)}
      </div>
      <div className="tool-narrated-row">
        <StatusIcon status={activity.status} />
        <span className="tool-name">{TOOL_LABEL[activity.tool] ?? activity.tool}</span>
        {activity.model && (
          <span className="tool-badge tool-model-badge" title={`Ran on ${activity.model}`}>
            {activity.model}
          </span>
        )}
        {activity.tool === 'web_search' && activity.engine && (
          <span className="tool-badge">{activity.engine}</span>
        )}
        {detail && (
          <span className="tool-single-detail" title={detail}>
            {detail}
          </span>
        )}
        {hasBody && activity.summary && (
          <span className="tool-single-summary">{fixZwsp(activity.summary)}</span>
        )}
        <span className="tool-ms">{fmtTime(ms)}</span>
      </div>
    </div>
  )
})

export const ToolCallView = memo(function ToolCallView({
  activity,
  onReverted,
}: {
  activity: ToolActivity
  onReverted?: () => void
}) {
  const [reverting, setReverting] = useState(false)
  const myKey = useId()
  const activeKey = useFullscreen((s) => s.activeKey)
  const openFs = useFullscreen((s) => s.open)
  const closeFs = useFullscreen((s) => s.close)
  const fsOpen = activeKey === myKey
  const root = useStore((s) => s.root)
  // Task cards (explore/general sub-agents) are collapsible and start
  // collapsed: the nested read/grep/glob sub-list is noisy, so it stays
  // hidden until clicked.
  const [collapsed, setCollapsed] = useState(isExploreCard(activity))
  const collapsible =
    activity.tool === 'task' &&
    ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary))

  // Live elapsed time while the tool is still running.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (activity.status !== 'running' && !activity.children?.some((c) => c.status === 'running')) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [activity.status, activity.children?.some((c) => c.status === 'running')])
  const ms =
    activity.status === 'running' && activity.startedAt
      ? now - activity.startedAt
      : activity.elapsedMs

  const isWrite = activity.tool === 'write_file' || activity.tool === 'edit_file'
  const readPaths = Array.isArray(activity.args?.paths)
    ? (activity.args.paths as string[])
    : []

  const fetchSummary = activity.tool === 'fetch_url' ? activity.summary : ''

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
    <div className={`tool-card ${activity.status}${isExploreCard(activity) ? ' explore' : ''}`}>
      <div
        className={`tool-card-head${collapsible ? ' collapsible' : ''}`}
        onClick={collapsible ? () => setCollapsed((c) => !c) : undefined}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? !collapsed : undefined}
        onKeyDown={
          collapsible
            ? (e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setCollapsed((c) => !c)
                }
              }
            : undefined
        }
      >
        <StatusIcon status={activity.status} />
        <span className="tool-name">
          {isExploreCard(activity)
            ? 'explore'
            : TOOL_LABEL[activity.tool] ?? activity.tool}
        </span>
        {activity.model && (
          <span className="tool-badge tool-model-badge" title={`Ran on ${activity.model}`}>
            {activity.model}
          </span>
        )}
        {activity.tool === 'task' && !!activity.args?.subagent_type && (
          <span className="tool-badge">{String(activity.args.subagent_type)}</span>
        )}
        {activity.tool === 'web_search' && activity.engine && (
          <span className="tool-badge">{activity.engine}</span>
        )}
        {activity.args && activity.args.command !== undefined && (
          <span className="tool-cmd">{String(activity.args.command)}</span>
        )}
        {activity.args && activity.args.path !== undefined && (
          <span className="tool-path">{String(activity.args.path)}</span>
        )}
        {activity.args && activity.args.filePath !== undefined && (
          <span className="tool-path" title={String(activity.args.filePath)}>
            {String(activity.args.filePath)}
          </span>
        )}
        {activity.args &&
          activity.args.filePath !== undefined &&
          (String(activity.args.offset ?? 1) !== '1' ||
            Number(activity.args.limit ?? 2000) < 2000) && (
            <span className="tool-path">
              {`${activity.args.offset ?? 1}–${Number(activity.args.offset ?? 1) + Number(activity.args.limit ?? 2000) - 1}`}
            </span>
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
          <span className="tool-cmd">{fixZwsp(String(activity.args.query))}</span>
        )}
        {activity.args && activity.args.pattern !== undefined && (
          <span className="tool-cmd">{fixZwsp(String(activity.args.pattern))}</span>
        )}
        {activity.args && activity.args.description !== undefined && (
          <span className="tool-cmd tool-task" title={String(activity.args.description)}>
            {fixZwsp(String(activity.args.description))}
          </span>
        )}
        {activity.tool === 'task' && activity.children && activity.children.length > 0 && (
          <span className="tool-badge tool-sub-count">
            {activity.children.length} call{activity.children.length === 1 ? '' : 's'}
          </span>
        )}
        {activity.tool === 'memory' && activity.args && (
          <span className="tool-cmd">
            {fixZwsp(String(activity.args.text || activity.args.subject || ''))}
          </span>
        )}
        {readPaths.length > 0 && (
          <>
            {readPaths.slice(0, 2).map((p, i) => (
              <span key={i} className="tool-path" title={p}>
                {p}
              </span>
            ))}
            {readPaths.length > 2 && (
              <span className="tool-path tool-more">
                +{readPaths.length - 2} more
              </span>
            )}
          </>
        )}
        {fetchSummary && <span className="tool-cmd">{fixZwsp(fetchSummary)}</span>}
        {activity.args && <ToolArgs args={activity.args} />}
        <span className="tool-ms">{fmtTime(ms)}</span>
        {isWrite && (
          <button
            className="tool-fullscreen-btn"
            title="Open full screen"
            aria-label="Open full screen"
            onClick={(e) => {
              e.stopPropagation()
              openFs(myKey)
            }}
          >
            ⤢
          </button>
        )}
        {collapsible && <span className={`chev${collapsed ? '' : ' open'}`}>▾</span>}
      </div>

      {collapsed && activity.tool === 'task' && activity.children && activity.children.length > 0 && (
        <ToolCascade activities={activity.children} />
      )}
      {!collapsed && (
      <div className="tool-card-body">
          {activity.summary && <div className="tool-summary">{fixZwsp(activity.summary)}</div>}
          {activity.tool === 'task' && activity.children && activity.children.length > 0 && (
            <div className="tool-sub-list">
              {activity.children.map((child, i) => (
                <ToolSubRow
                  key={`${child.tool}-${i}-${child.callId ?? i}`}
                  activity={child}
                />
              ))}
            </div>
          )}
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
    {fsOpen && (
      <FullscreenModal
        open={fsOpen}
        onClose={closeFs}
        title={String(activity.args?.path ?? activity.args?.filePath ?? 'File')}
        bodyClass="diff-fullscreen-body"
      >
          {activity.diff ? (
            <DiffView diff={activity.diff} />
          ) : (
            <div className="fullscreen-empty">No diff available for this file yet.</div>
          )}
        </FullscreenModal>
      )}
    </div>
  )
})
