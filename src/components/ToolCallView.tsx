import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ToolActivity, SearchResultItem } from '../types'
import { useStore } from '../lib/store'
import { api } from '../lib/fs'
import { fixZwsp } from '../lib/bidi'
import { handleLinkClick } from '../lib/link'
import { FullscreenModal } from './FullscreenModal'
import { useFullscreen } from '../lib/fullscreen'
import { useDragScroll } from '../lib/useDragScroll'

const TOOL_LABEL: Record<string, string> = {
  write_file: 'Write File',
  list_files: 'List Directory',
  grep: 'Search Files',
  glob: 'Search Files',
  web_search: 'Web Search',
  run_terminal: 'Run Command',
  search_memory: 'Search Memory',
  memory: 'Memory',
  ask_user: 'Ask User',
  fetch_url: 'Fetch URL',
  task: 'Task',
  vision: 'Vision',
  create_skill: 'Create Skill',
  create_mcp: 'Create MCP',
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
      const name = TOOL_LABEL[tool] ?? tool
      return n > 1 ? `${name} ×${n}` : name
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

/* ——— High-quality SVG icons ——— */
function IconSparkle({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1L14.5 9.5L23 12L14.5 14.5L12 23L9.5 14.5L1 12L9.5 9.5Z" />
    </svg>
  )
}

function IconChevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={`${className ?? ''} ${open ? 'open' : ''}`}
      width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      style={{ transition: 'transform 0.18s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function IconX({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function StatusIcon({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') return <span className="spinner" />
  if (status === 'error') return <IconX className="status-err" />
  if (status === 'denied') return <span className="status-denied">⏹</span>
  return <IconCheck className="status-ok" />
}

/** Parse unified diff into before/after line arrays for side-by-side display */
function parseUnifiedDiff(diff: string): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
      // hunk headers go in both
      before.push(line)
      after.push(line)
    } else if (line.startsWith('-')) {
      before.push(line.slice(1))
      after.push('')
    } else if (line.startsWith('+')) {
      before.push('')
      after.push(line.slice(1))
    } else {
      // context line (starts with space or no prefix)
      const clean = line.startsWith(' ') ? line.slice(1) : line
      before.push(clean)
      after.push(clean)
    }
  }
  return { before, after }
}

/** Extract a clean host label (e.g. "github.com") from a URL for the
 *  favicon + source chip. Falls back to the raw URL when it can't parse. */
function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Shared, beautifully-styled list of web_search result links. Rendered in
 *  EVERY tool view (full card, single row, narrated row, timeline row) so the
 *  links the model found are always visible — not just in the expanded card.
 *  Pure presentational component (no store/fullscreen hooks) so it can be
 *  unit-tested in isolation. */
export const WebResultLinks = memo(function WebResultLinks({
  items,
}: {
  items: SearchResultItem[]
}) {
  if (!items || items.length === 0) return null
  return (
    <ul className="web-results" dir="auto">
      {items.map((it, i) => {
        const host = hostOf(it.url)
        return (
          <li key={i} className="web-result">
            <a
              className="web-result-link"
              href={it.url}
              target="_blank"
              rel="noreferrer"
              title={it.url}
              onClick={(e) => {
                // Open external links in the OS browser, not inside the app's
                // own BrowserWindow. window.coder.openExternal → shell.openExternal.
                handleLinkClick(e, it.url, (url) => void window.coder.openExternal(url))
              }}
            >
              <span className="web-result-favicon" aria-hidden="true">
                {host ? (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
                    alt=""
                    loading="lazy"
                    width={16}
                    height={16}
                  />
                ) : (
                  <span className="web-result-glyph">🔗</span>
                )}
              </span>
              <span className="web-result-text">
                <span className="web-result-title">{it.title || it.url}</span>
                {it.snippet && <span className="web-result-snippet">{it.snippet}</span>}
              </span>
              <span className="web-result-host">{host}</span>
              <span className="web-result-arrow" aria-hidden="true">↗</span>
            </a>
          </li>
        )
      })}
    </ul>
  )
})

/** نمایش نتایج grep/glob به‌صورت لیست مسیر فایل (با شمارهٔ خط) — نه لینک وب.
 *  آیتم‌های این ابزارها فیلد `url` ندارند، پس نباید از WebResultLinks (مخصوص
 *  web_search/fetch_url) استفاده شوند؛ وگرنه به‌جای مسیر فایل فقط آیکون 🔗
 *  نمایش داده می‌شد. */
export const FileResultLinks = memo(function FileResultLinks({
  tool,
  items,
}: {
  tool: string
  items: Array<Record<string, unknown>>
}) {
  if (!items || items.length === 0) return null
  const VISIBLE = 3
  const visible = items.slice(0, VISIBLE)
  const extra = items.length - visible.length
  return (
    <ul className="file-results" dir="ltr">
      {visible.map((it, i) => {
        const file = String(it.file ?? it.path ?? '')
        if (!file) return null
        const line = it.line !== undefined && it.line !== null ? String(it.line) : ''
        const text = String(it.text ?? '')
        return (
          <li key={i} className="file-result">
            <span className="file-result-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
            </span>
            <span className="file-result-path">{file}{line ? `:${line}` : ''}</span>
            {text && <span className="file-result-text">{text}</span>}
          </li>
        )
      })}
      {extra > 0 && (
        <li className="file-result-more" key="more">
          +{extra} more
        </li>
      )}
    </ul>
  )
})

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
  const drag = useDragScroll<HTMLDivElement>()
  return (
    <div className="diff-side" dir="ltr" {...drag}>
      {/* Two INDEPENDENT columns (before | after). Each column is its own grid
          context, so selecting text in "after" can never drag "before" along
          (and vice-versa). Row heights stay identical (fixed line-height, one
          line per row) so the two columns remain line-aligned. */}
      <div className="diff-col diff-col-before">
        <div className="diff-side-head">Before</div>
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
          return (
            <div key={i} className={`diff-side-row ${row.type}`}>
              <span className="diff-side-num">{row.bLine >= 0 ? row.bLine : ''}</span>
              <div className={`diff-side-cell ${beforeCls}`}>{row.before}</div>
            </div>
          )
        })}
      </div>
      <div className="diff-col diff-col-after">
        <div className="diff-side-head">After</div>
        {rows.map((row, i) => {
          if ('text' in row) {
            return (
              <div key={i} className={`diff-side-meta ${row.type}`}>
                {row.text}
              </div>
            )
          }
          const afterCls =
            row.type === 'same'
              ? 'diff-context'
              : row.type === 'add' || row.type === 'mod'
                ? 'diff-add'
                : ''
          return (
            <div key={i} className={`diff-side-row ${row.type}`}>
              <span className="diff-side-num">{row.aLine >= 0 ? row.aLine : ''}</span>
              <div className={`diff-side-cell ${afterCls}`}>{row.after}</div>
            </div>
          )
        })}
      </div>
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
   *  (see renderSegments in ChatMessage.tsx). Used as the trace-head status
   *  text (Claude.ai-style: ✱ + "Tracing X" + elapsed time), instead of a
   *  separate caption above the head. */
  caption?: string
  onReverted?: (index: number) => void
}) {
  const [open, setOpen] = useState(false)
  const running = activities.some((a) => a.activity.status === 'running')
  const totalMs = activities.reduce((sum, a) => sum + (a.activity.elapsedMs || 0), 0)
  // Always show tool names + counts as the main status text.
  // Caption (model narration) is shown as a secondary line if present.
  // Build per-tool pills: [{tool: "read", count: 3}, ...]
  const toolCounts = activities.reduce<Record<string, number>>((acc, a) => {
    acc[a.activity.tool] = (acc[a.activity.tool] || 0) + 1
    return acc
  }, {})

  return (
    <div className={`tool-group ${open ? 'open' : ''} ${running ? 'running' : 'done'}`}>
      <button
        className={`trace-head ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconSparkle className="trace-sparkle" />
        <span className="trace-head-pills">
          {Object.entries(toolCounts).map(([tool, n]) => (
            <span key={tool} className="trace-pill">
              {TOOL_LABEL[tool] ?? tool}
              {n > 1 && <span className="trace-pill-count">×{n}</span>}
            </span>
          ))}
        </span>
        <span className="trace-head-right">
          {totalMs > 0 && <span className="trace-time">{fmtTime(totalMs)}</span>}
          <IconChevron open={open} className="trace-chev" />
        </span>
      </button>
      {open && (
        <div className="trace-list">
          {activities.map(({ activity, index }) => (
            <TraceRow key={index} activity={activity} />
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
      <span className="tool-sub-args" title={subSummary}>
        {subSummary}
      </span>
      {activity.summary && <span className="tool-sub-summary">{activity.summary}</span>}
      <span className="tool-ms">{fmtTime(ms)}</span>
    </div>
  )
})

/** One row in a Claude-style trace group: a single quiet line per call with
 *  a tool icon, a short description (the model's arg summary or activity
 *  summary), and a right-side chevron `›` so the row reads as a list item you
 *  can scan, not a mini-card. Mirrors Claude.ai's own trace row layout (icon
 *  + short text + chevron), not the spine-and-circle timeline the old version
 *  used. */
const TraceRow = memo(function TraceRow({ activity }: { activity: ToolActivity }) {
  const [now, setNow] = useState(() => Date.now())
  // edit_file / write_file همیشه باز باشن (diff نشون بدن)
  const [expanded, setExpanded] = useState(() =>
    activity.tool === 'edit_file' || activity.tool === 'write_file',
  )
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const label = TOOL_LABEL[activity.tool] ?? activity.tool
  const detail = activity.summary
    ? fixZwsp(activity.summary)
    : subArgSummary(activity)

  const argsText = activity.args
    ? Object.entries(activity.args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : ''

  const isEdit = activity.tool === 'edit_file' || activity.tool === 'write_file'

  return (
    <div className={`trace-row ${activity.status}${running ? ' running' : ''}${expanded ? ' expanded' : ''}${isEdit ? ' edit-file' : ''}`}>
      <button className="trace-row-head" onClick={() => !isEdit && setExpanded((e) => !e)}>
        <span className="trace-row-bullet" aria-hidden="true">
          {running ? <span className="spinner" /> : '•'}
        </span>
        <span className="trace-pill">{label}</span>
        <span className="trace-row-detail" dir="auto" title={detail ?? ''}>
          {detail}
        </span>
        <span className="trace-row-end">
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <StatusIcon status={activity.status} />
          <IconChevron open={expanded} className="trace-row-chev" />
        </span>
      </button>
      {expanded && (
        <div className="trace-row-expand">
          {activity.summary && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Summary</span>
              <span className="trace-expand-val" dir="auto">{fixZwsp(activity.summary)}</span>
            </div>
          )}
          {argsText && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Args</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">{argsText}</pre>
            </div>
          )}
          {activity.diff && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Diff</span>
              <pre className="trace-expand-val trace-expand-pre trace-expand-diff" dir="auto">{activity.diff}</pre>
            </div>
          )}
          {activity.items && activity.items.length > 0 && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              <div className="trace-expand-results">
                {activity.items.map((it, i) => (
                  it.url ? (
                    <a key={i} className="trace-expand-link" href={it.url} target="_blank" rel="noreferrer">
                      {it.title || it.url}
                    </a>
                  ) : (
                    <span key={i} className="trace-expand-result-item">{it.title || it.snippet || ''}</span>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/** Legacy timeline row, kept exported in case any caller still imports it
 *  directly. New code should use TraceRow instead — Claude.ai's trace UI is a
 *  flat list of quiet rows, not a spine-and-circle timeline. */
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
      {detail && (
        <span className="tool-timeline-detail" title={detail}>
          {detail}
        </span>
      )}
      <StatusIcon status={activity.status} />
      <span className="tool-ms">{fmtTime(ms)}</span>
      {activity.items && activity.items.length > 0 && (activity.tool === 'web_search' || activity.tool === 'fetch_url' ? <WebResultLinks items={activity.items} /> : <FileResultLinks tool={activity.tool} items={activity.items as unknown as Array<Record<string, unknown>>} />)}
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
 * restrained chrome, icon + short description + chevron in a single quiet line.
 * Used for standalone single calls; multi-call runs still collapse into a
 * group. Mirrors Claude.ai's own trace row layout.
 */
export const ToolSingleRow = memo(function ToolSingleRow({
  activity,
}: {
  activity: ToolActivity
}) {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(() =>
    activity.tool === 'edit_file' || activity.tool === 'write_file',
  )
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  const label = TOOL_LABEL[activity.tool] ?? activity.tool
  const detail = activity.summary
    ? fixZwsp(activity.summary)
    : subArgSummary(activity)

  const argsText = activity.args
    ? Object.entries(activity.args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : ''

  const isEdit = activity.tool === 'edit_file' || activity.tool === 'write_file'

  /** Compute +/- stats from diff */
  const diffStats = (() => {
    if (!activity.diff) return null
    let adds = 0, dels = 0
    for (const line of activity.diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) adds++
      else if (line.startsWith('-') && !line.startsWith('---')) dels++
    }
    return adds || dels ? `+${adds}/-${dels}` : null
  })()

  return (
    <div className={`trace-row single ${activity.status}${running ? ' running' : ''}${expanded ? ' expanded' : ''}${isEdit ? ' edit-file' : ''}`}>
      <button className="trace-row-head" onClick={() => !isEdit && setExpanded((e) => !e)}>
        <StatusIcon status={activity.status} />
        <span className="trace-pill">{label}</span>
        {isEdit ? (
          <span className="trace-row-detail" dir="auto" title={String(activity.args?.path ?? '')}>
            {String(activity.args?.path ?? '').split('/').pop()}
          </span>
        ) : (
          <span className="trace-row-detail" dir="auto" title={detail ?? ''}>
            {detail}
          </span>
        )}
        {activity.tool === 'web_search' && activity.engine && (
          <span className="trace-row-engine">{activity.engine}</span>
        )}
        <span className="trace-row-end">
          {isEdit && diffStats && <span className="trace-row-diff-stats">{diffStats}</span>}
          {isEdit && (
            <span className="trace-row-revert" role="button" tabIndex={0} title="Revert this change" onClick={(e) => { e.stopPropagation(); }}>
              Revert
            </span>
          )}
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <IconChevron open={expanded} className="trace-row-chev" />
        </span>
      </button>
      {expanded && isEdit && activity.diff ? (
        <div className="trace-row-expand edit-file-expand">
          {(() => {
            const { before, after } = parseUnifiedDiff(activity.diff)
            return (
              <div className="diff-columns">
                <div className="diff-col">
                  <div className="diff-col-header diff-col-before">Before</div>
                  <pre className="diff-col-code">{before.map((l, i) =>
                    <span key={i} className="diff-line">{l || '\u00A0'}</span>
                  )}</pre>
                </div>
                <div className="diff-col">
                  <div className="diff-col-header diff-col-after">After</div>
                  <pre className="diff-col-code">{after.map((l, i) =>
                    <span key={i} className="diff-line">{l || '\u00A0'}</span>
                  )}</pre>
                </div>
              </div>
            )
          })()}
        </div>
      ) : expanded ? (
        <div className="trace-row-expand">
          {activity.summary && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Summary</span>
              <span className="trace-expand-val" dir="auto">{fixZwsp(activity.summary)}</span>
            </div>
          )}
          {argsText && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Args</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">{argsText}</pre>
            </div>
          )}
          {activity.diff && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Diff</span>
              <pre className="trace-expand-val trace-expand-pre trace-expand-diff" dir="auto">{activity.diff}</pre>
            </div>
          )}
          {activity.items && activity.items.length > 0 && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              <div className="trace-expand-results">
                {activity.items.map((it, i) => (
                  it.url ? (
                    <a key={i} className="trace-expand-link" href={it.url} target="_blank" rel="noreferrer">
                      {it.title || it.url}
                    </a>
                  ) : (
                    <span key={i} className="trace-expand-result-item">{it.title || it.snippet || ''}</span>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
})

/**
 * A read-only tool call paired with the short narration line the model wrote
 * right before calling it (e.g. "بذار ببینم X رو..."). Instead of stacking a
 * full paragraph text block above a separate, unrelated tool row — which is
 * what made multi-step tool runs feel noisy (every call got its own two-part
 * block) — the caption and the call render as a single quiet row: caption
 * text + status icon + chevron, matching Claude.ai's trace rows. See
 * renderSegments in ChatMessage.tsx for how captions get attached to the
 * call(s) that follow them. Falls back to the plain ToolSingleRow when
 * there's no caption.
 */
export const ToolNarratedRow = memo(function ToolNarratedRow({
  caption,
  activity,
}: {
  caption?: string
  activity: ToolActivity
}) {
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(() =>
    activity.tool === 'edit_file' || activity.tool === 'write_file',
  )
  const running = activity.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [running])
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs
  if (!caption) return <ToolSingleRow activity={activity} />

  const label = TOOL_LABEL[activity.tool] ?? activity.tool
  const detail = activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity)

  const argsText = activity.args
    ? Object.entries(activity.args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : ''

  const isEdit = activity.tool === 'edit_file' || activity.tool === 'write_file'

  return (
    <div className={`trace-row narrated ${activity.status}${running ? ' running' : ''}${expanded ? ' expanded' : ''}${isEdit ? ' edit-file' : ''}`}>
      <button className="trace-row-head" onClick={() => !isEdit && setExpanded((e) => !e)}>
        <span className="trace-row-caption" dir="auto">
          {fixZwsp(caption)}
        </span>
        <span className="trace-pill">{label}</span>
        {isEdit && activity.summary ? (
          <span className="trace-row-detail trace-row-summary" dir="auto">
            {activity.summary}
          </span>
        ) : null}
        <span className="trace-row-end">
          {ms ? <span className="trace-row-ms">{fmtTime(ms)}</span> : null}
          <StatusIcon status={activity.status} />
          {!isEdit && <IconChevron open={expanded} className="trace-row-chev" />}
        </span>
      </button>
      {expanded && (
        <div className="trace-row-expand">
          {activity.summary && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Summary</span>
              <span className="trace-expand-val" dir="auto">{fixZwsp(activity.summary)}</span>
            </div>
          )}
          {argsText && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Args</span>
              <pre className="trace-expand-val trace-expand-pre" dir="auto">{argsText}</pre>
            </div>
          )}
          {activity.diff && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Diff</span>
              <pre className="trace-expand-val trace-expand-pre trace-expand-diff" dir="auto">{activity.diff}</pre>
            </div>
          )}
          {activity.items && activity.items.length > 0 && (
            <div className="trace-expand-section">
              <span className="trace-expand-key">Results</span>
              <div className="trace-expand-results">
                {activity.items.map((it, i) => (
                  it.url ? (
                    <a key={i} className="trace-expand-link" href={it.url} target="_blank" rel="noreferrer">
                      {it.title || it.url}
                    </a>
                  ) : (
                    <span key={i} className="trace-expand-result-item">{it.title || it.snippet || ''}</span>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}
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
      const path = String(activity.args?.path ?? activity.args?.filePath ?? '')
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
        {activity.tool === 'task' && !!activity.args?.subagent_type && (
          <span className="tool-badge">{String(activity.args.subagent_type)}</span>
        )}
        {activity.tool === 'web_search' && activity.engine && (
          <span className="tool-badge tool-engine-badge">{activity.engine}</span>
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
        {isWrite && activity.diff && (() => {
          const adds = (activity.diff.match(/^\+[^+]/gm) || []).length
          const dels = (activity.diff.match(/^-[^-]/gm) || []).length
          return adds + dels > 0 ? (
            <span className="tool-diff-stats">+{adds}/-{dels}</span>
          ) : null
        })()}
        {isWrite && activity.diff && !activity.reverted && (
          <button
            className="tool-revert-inline"
            disabled={reverting}
            onClick={(e) => {
              e.stopPropagation()
              revert()
            }}
          >
            {reverting ? 'Reverting…' : '↩ Revert'}
          </button>
        )}
        {isWrite && activity.reverted && (
          <span className="reverted-tag">reverted</span>
        )}
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
          {activity.summary && !isWrite && <div className="tool-summary">{fixZwsp(activity.summary)}</div>}
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
            <WebResultLinks items={activity.items} />
          )}
          {activity.diff && <DiffView diff={activity.diff} />}
      </div>
      )}
    {fsOpen && (
      <FullscreenModal
        open={fsOpen}
        onClose={closeFs}
        title={String(activity.args?.path ?? activity.args?.filePath ?? 'File')}
        bodyClass="diff-fullscreen-body"
        scrollable
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
