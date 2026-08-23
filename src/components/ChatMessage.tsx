import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage, ToolActivity } from '../types'
import { detectDir, fixZwsp, prepareContent, stripBidiMarks } from '../lib/bidi'
import { copyToClipboard } from '../lib/clipboard'
import { cancelSteer } from '../lib/api'
import { useStore } from '../lib/store'
import { getMode } from '../lib/modes'
import { splitSections } from '../lib/sections'
import { handleLinkClick } from '../lib/link'
import { ToolCallView, ToolGroupView, ToolNarratedRow, isExploreCard } from './ToolCallView'
import { ReadingMode } from './ReadingMode'
import { Mermaid } from './Mermaid'
import 'highlight.js/styles/github-dark.min.css'

// rehype-highlight throws by default on languages it doesn't know (e.g.
// `mermaid`). `ignoreMissing` lets unknown fences pass through untouched so the
// `language-mermaid` class survives and ChatMessage's CodeBlock can render them
// as live diagrams instead of erroring the whole markdown block.
const REHYPE_HIGHLIGHT = [
  rehypeHighlight,
  { ignoreMissing: true },
] as [typeof rehypeHighlight, { ignoreMissing: boolean }]

// Cache prepareContent per message id so re-renders with UNCHANGED content
// (dir toggles, parent re-renders that don't recreate the message, memo
// defeats) don't re-run the bidi-mark strip + ZWSP-fix passes over every
// message on every paint. The cached text is validated on each hit, so a
// STREAMING message (same id, growing content) always recomputes instead of
// showing stale text. FIFO-bounded so long sessions can't leak memory.
const preparedCache = new Map<string, { text: string; out: string }>()
const PREPARED_CACHE_MAX = 400
function computePrepared(id: string, text: string, dir?: 'rtl' | 'ltr'): string {
  const hit = preparedCache.get(id)
  if (hit && hit.text === text) return hit.out
  const out = prepareContent(text, dir)
  if (preparedCache.size >= PREPARED_CACHE_MAX) {
    const oldest = preparedCache.keys().next().value
    if (oldest !== undefined) preparedCache.delete(oldest)
  }
  preparedCache.set(id, { text, out })
  return out
}
function cachedPrepare(id: string, text: string, dir?: 'rtl' | 'ltr'): string {
  if (!text) return text
  return computePrepared(id, text, dir)
}
/** For content with no stable id (the thinking block only receives `text`):
 *  key by the text itself — prepareContent is deterministic, so equal text
 *  always yields equal output. */
function cachedPrepareText(text: string, dir?: 'rtl' | 'ltr'): string {
  if (!text) return text
  return computePrepared(`t:${text}`, text, dir)
}

function textFromChildren(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromChildren).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textFromChildren((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function codeLang(children: ReactNode): string {
  const kids = Array.isArray(children) ? children : [children]
  for (const k of kids) {
    const props = (k as { props?: { className?: string } } | null)?.props
    const m = props?.className ? /language-([\w-]+)/.exec(String(props.className)) : null
    if (m) return m[1]
  }
  return ''
}

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false)
  const code = textFromChildren(props.children)
  const lang = codeLang(props.children)

  // A ```mermaid fenced block is rendered as a live diagram, not as code.
  if (lang === 'mermaid') {
    return <Mermaid chart={code} />
  }

  const copy = async () => {
    try {
      await copyToClipboard(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('copy failed', err)
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang || 'code'}</span>
        <button className="copy-btn" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre {...props}>{props.children}</pre>
    </div>
  )
}

// Shared overrides for every markdown renderer in this component.
// `table` is wrapped in a scroll container: `display: block` on the <table>
// itself makes its anonymous inner table shrink-wrap to content width, so the
// cells never stretch to the border. A bordered full-width wrapper fixes the
// "table doesn't fill the width" gap and carries the horizontal scroll.
//
// Exported so ReadingMode.tsx can reuse the exact same overrides (including the
// ```mermaid -> diagram rendering) without duplicating them.
export const mdComponents = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // Forward http(s) links to the OS browser; internal anchors keep
        // their default behaviour inside the app.
        handleLinkClick(e, props.href, (url) => void window.coder.openExternal(url))
      }}
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => <CodeBlock {...props} />,
  table: ({
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLTableElement> & { node?: unknown }) => (
    <div className="markdown-table-scroll">
      <table {...props} />
    </div>
  ),
}

const fmtTokens = (n?: number): string => {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

const THINKING_MIN_H = 56
const THINKING_MAX_H = 320
const THINKING_DEFAULT_H = 84

export function ThinkingBlock({ text }: { text: string }) {
  const dir = useStore((s) => s.dir)
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(THINKING_DEFAULT_H)
  const textRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const drag = useRef<{ startY: number; startH: number } | null>(null)
  const empty = text.trim().length === 0
  // While collapsed, show the latest streamed line (truncated to one line)
  // instead of a word count, so the user sees live reasoning progress.
  const lastLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  const label = empty
    ? 'Thinking…'
    : open
      ? 'Hide thinking'
      : lastLine
        ? `Thinking — ${lastLine}`
        : 'Thinking…'
  useEffect(() => {
    const el = textRef.current
    if (!el || !open || empty || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [text, open, empty])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    drag.current = { startY: e.clientY, startH: height }
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return
      const next = drag.current.startH + (ev.clientY - drag.current.startY)
      setHeight(Math.max(THINKING_MIN_H, Math.min(THINKING_MAX_H, next)))
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`thinking-block ${open ? 'open' : ''}${empty ? ' busy' : ''}`}
    >
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className={`thinking-dot${empty ? ' busy' : ''}`}>
          {empty ? <span className="spinner" /> : '✦'}
        </span>
        <span className="thinking-label">{label}</span>
        {!empty && <span className={`chev ${open ? 'open' : ''}`}>▾</span>}
      </button>
      {open && !empty && (
        <>
          <div
            className="thinking-text"
            ref={textRef}
            style={{ height }}
            dir="auto"
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {cachedPrepareText(text, dir)}
          </div>
          <div
            className="thinking-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize thinking panel"
            onPointerDown={startResize}
          >
            <span className="thinking-resizer-grip" />
          </div>
        </>
      )}
    </div>
  )
}

export function RetryBanner({
  attempt,
  maxAttempts,
  delay,
  reason,
  gaveUp,
  watchdog,
  model,
  agent,
  fallback,
  stalled,
  onCancel,
  onRetry,
}: {
  attempt: number
  maxAttempts: number
  delay: number
  reason: string
  gaveUp?: boolean
  watchdog?: boolean
  model?: string
  agent?: string
  fallback?: boolean
  stalled?: boolean
  onCancel?: () => void
  onRetry?: () => void
}) {
  const [left, setLeft] = useState(delay)
  useEffect(() => {
    setLeft(delay)
    if (delay <= 0) return
    const t = setInterval(() => {
      setLeft((l) => {
        if (l <= 1) {
          clearInterval(t)
          return 0
        }
        return l - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [delay])
  const unlimited = maxAttempts <= 0
  const isRateLimit = unlimited && (reason?.toLowerCase().includes('rate limit') || reason?.toLowerCase().includes('quota'))
  const countdown =
    delay > 0
      ? left > 0
        ? ` — retry in ${left}s`
        : ' — retrying…'
      : ' — retrying…'
  const who = model
    ? ` — ${model}${agent ? ` (${agent})` : ''}`
    : agent
      ? ` — ${agent}`
      : ''
  // A sub-agent model hard-failed and the tool fell back to the MAIN model.
  // Distinct banner: no spinner, no retry button — the fallback already ran.
  if (fallback) {
    return (
      <div className="retry-banner retry-banner-fallback" title={reason || undefined}>
        <span className="retry-fallback-icon" aria-hidden>
          ⚠
        </span>
        <span>
          Sub-agent failed — using main model
          {who ? <span className="retry-who">{who}</span> : null}
          {reason ? <span className="retry-reason"> — {reason}</span> : null}
        </span>
        {onCancel && (
          <button className="retry-cancel" onClick={onCancel} title="Cancel retry">
            ✕
          </button>
        )}
      </div>
    )
  }
  const label = gaveUp
    ? watchdog
      ? 'Connection lost'
      : 'Retry limit reached'
    : isRateLimit
      ? 'Provider rate limit'
      : unlimited
        ? 'Provider rate limit'
        : 'Provider hiccup'
  const suffix = gaveUp
    ? watchdog
      ? ''
      : ` (${attempt}/${maxAttempts})`
    : unlimited
      ? ` (attempt ${attempt})${countdown}`
      : ` (${attempt}/${maxAttempts})${countdown}`
  return (
    <div className="retry-banner" title={reason || undefined}>
      {!gaveUp && <span className="spinner" />}
      <span>
        {label}
        {suffix}
        {who ? <span className="retry-who">{who}</span> : null}
        {reason ? <span className="retry-reason"> — {reason}</span> : null}
        {stalled && !gaveUp ? (
          <span className="retry-stalled"> — still waiting for the provider</span>
        ) : null}
      </span>
      {onRetry && (
        <button className="retry-btn" onClick={onRetry} title="Retry — resumes where it stopped without redoing completed work">
          Retry
        </button>
      )}
      {onCancel && (
        <button className="retry-cancel" onClick={onCancel} title="Cancel retry">
          ✕
        </button>
      )}
    </div>
  )
}

function localWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

function fmtElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/**
 * Live status line shown while an assistant message is being generated:
 * a running tool gets "Running: <tool> … Ns", otherwise (nothing streamed yet)
 * "Thinking… Ns". Hidden once text starts arriving or while a retry is active.
 */
function LiveWorkingStatus({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!message.streaming) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [message.streaming])

  const running = message.toolActivity?.find((a) => a.status === 'running')
  if (running) {
    return (
      <div className="msg-working" dir="ltr">
        <span className="spinner" />
        <span>
          Running: {running.tool} … {fmtElapsed(now - (message.createdAt || now))}
        </span>
      </div>
    )
  }
  if (message.content) return null
  return (
    <div className="msg-working thinking" dir="ltr">
      <span className="msg-working-dot" />
      <span>Thinking… {fmtElapsed(now - (message.createdAt || now))}</span>
    </div>
  )
}

function UsageBadge({
  input,
  output,
  total,
  live,
}: {
  input: number
  output: number
  total: number
  live?: boolean
}) {
  const body = `↑ ${fmtTokens(input)} in · ↓ ${live ? '…' : fmtTokens(output)} out`
  return (
    <span
      className={`msg-usage${live ? ' live' : ''}`}
      title={`${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`}
      dir="ltr"
    >
      {body}
    </span>
  )
}

// Only tools that write to the workspace filesystem always render as their
// own full, visible card (diff + revert) — every other tool (including
// memory/skill/connector saves) sweeps into the collapsed Claude-app-style
// trace group. Explore sub-agents are also always-visible (isExploreCard
// below) so the explorer never hides inside the collapsed group.
const ALWAYS_VISIBLE_TOOLS = new Set(['write_file', 'edit_file'])

/** Interleave text slices with tool cards (Claude-style), but collapse runs of
 *  2+ consecutive read-only/non-mutating tool calls (grep/glob/read/
 *  web_search/run_terminal/search_memory) into one ToolGroupView so a
 *  search-heavy turn doesn't stack a full-height row per call. Anything in
 *  ALWAYS_VISIBLE_TOOLS always breaks the run and renders as its own full card
 *  (diff/confirmation visible), same as before. */
/** Shared rendering for a user message bubble + its action buttons (retry/copy).
 *  Used both for standalone user messages and for interleaved steer segments so
 *  the icons always match the main user message. `className` is applied to the
 *  bubble wrapper (e.g. "seg-steer" for the interleaved steer look). */
function UserMessageBubble({
  message,
  onRetry,
  className,
}: {
  message: ChatMessage
  onRetry?: (id: string) => void
  className?: string
}) {
  const dir = useStore((s) => s.dir)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('copy failed', err)
    }
  }

  return (
    <>
      <div className={`msg-bubble${className ? ` ${className}` : ''}`}>
        <div className="chat-message user-text" dir={dir}>
          {cachedPrepare(message.id, message.content, dir) || '(empty)'}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments" dir="ltr">
            {message.attachments.map((a) => (
              <span className="attachment-chip" key={a}>@ {a}</span>
            ))}
          </div>
        )}
      </div>
      {message.content && (
        <div className="msg-actions">
          {onRetry && (
            <button
              className="msg-copy msg-retry"
              onClick={() => onRetry(message.id)}
              title="Retry"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          <button className={`msg-copy ${copied ? 'copied' : ''}`} onClick={copy} title="Copy message">
            {copied ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </>
  )
}

function SegSteerBubble({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry?: (id: string) => void
}) {
  // Render the EXACT same structure as a standalone user message (role header
  // + bubble + actions) so an interleaved steer is pixel-identical to the
  // user's own messages — the .msg.user wrapper reuses the same CSS.
  return (
    <div className="msg user seg-steer">
      <div className="msg-role">
        <span className="msg-role-avatar" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
          </svg>
        </span>
        You
      </div>
      <UserMessageBubble message={message} onRetry={onRetry} />
    </div>
  )
}

/** A text segment counts as a "caption" (narration the model wrote right
 *  before a tool call, e.g. "بذار ببینم X رو...") rather than a real prose
 *  answer if it's short, single-paragraph, and has no rich formatting the
 *  final answer would typically use. Longer/formatted text always renders as
 *  its own markdown block. */
function isCaptionCandidate(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 260) return false
  if (t.includes('```')) return false
  if (/^#{1,6}\s/m.test(t)) return false
  if ((t.match(/\n/g) || []).length > 2) return false
  return true
}

function renderSegments(message: ChatMessage, onRetry?: (id: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let pending: { activity: ToolActivity; index: number }[] = []
  // The narration line held back to attach to the tool call(s) that follow it
  // (see isCaptionCandidate). Cleared once used or once it turns out nothing
  // groupable followed it.
  let pendingCaption: string | null = null

  const flush = (key: string) => {
    if (pending.length === 0) return
    if (pending.length === 1) {
      // یک فراخوانی تکی: با caption مدل (اگر بود) در یک بلوکِ واحد رندر می‌شود —
      // به‌جای یک پاراگراف جدا بالای یک ردیف ابزارِ بی‌ربط.
      const { activity } = pending[0]
      nodes.push(<ToolNarratedRow key={key} caption={pendingCaption ?? undefined} activity={activity} />)
    } else {
      // 2+ consecutive read-only calls collapse into one trace group, headed
      // by the same caption instead of only the generic count summary.
      nodes.push(<ToolGroupView key={key} activities={pending} caption={pendingCaption ?? undefined} />)
    }
    pending = []
    pendingCaption = null
  }

  const renderProse = (key: string, text: string) => {
    nodes.push(
      <div key={key} className="chat-message markdown-body" dir="auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[REHYPE_HIGHLIGHT]}
          components={mdComponents}
        >
          {cachedPrepare(`${message.id}:seg:${key}`, text, useStore.getState().dir)}
        </ReactMarkdown>
      </div>,
    )
  }

  const segs = message.segments ?? []
  segs.forEach((seg, i) => {
    if (seg.kind === 'user') {
      flush(`grp-${i}`)
      if (pendingCaption) {
        renderProse(`cap-${i}`, pendingCaption)
        pendingCaption = null
      }
      const steerMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id)
      if (steerMsg) {
        nodes.push(
          <SegSteerBubble key={i} message={steerMsg} onRetry={onRetry} />,
        )
      }
      return
    }
    if (seg.kind === 'text') {
      // A text segment always ends whatever tool run was accumulating.
      flush(`grp-${i}`)

      // Does this text immediately precede a groupable (non-always-visible)
      // tool call? If so, hold it back as that call's caption instead of
      // rendering it as its own paragraph.
      const next = segs[i + 1]
      const nextActivity = next && next.kind === 'tool' ? message.toolActivity?.[next.index] : undefined
      const nextIsGroupable =
        nextActivity && !ALWAYS_VISIBLE_TOOLS.has(nextActivity.tool) && !isExploreCard(nextActivity)

      if (nextIsGroupable && isCaptionCandidate(seg.text)) {
        pendingCaption = seg.text
        return
      }

      renderProse(String(i), seg.text)
      return
    }
    const activity = message.toolActivity?.[seg.index]
    if (!activity) return
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool) || isExploreCard(activity)) {
      flush(`grp-${i}`)
      if (pendingCaption) {
        renderProse(`cap-${i}`, pendingCaption)
        pendingCaption = null
      }
      nodes.push(
        <ToolCallView
          key={i}
          activity={activity}
          onReverted={() => useStore.getState().markToolReverted(message.id, seg.index)}
        />,
      )
    } else {
      pending.push({ activity, index: seg.index })
    }
  })
  flush('grp-end')
  if (pendingCaption) renderProse('cap-end', pendingCaption)
  return nodes
}

export const ChatMessageView = memo(function ChatMessageView({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry?: (id: string) => void
}) {
  const isUser = message.role === 'user'
  const dir = useStore((s) => s.dir)
  const settings = useStore((s) => s.settings)
  const [copied, setCopied] = useState(false)
  // The context summary is COLLAPSED by default — it's a long folded dump of
  // earlier turns, so the chat stays compact. Clicking the header expands it.
  const [summaryCollapsed, setSummaryCollapsed] = useState(true)

  const modeLabel = (id: string) => getMode(settings, id).label

  const copyMessage = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('copy failed', err)
    }
  }

  // No live token estimate while streaming: the char-based estimate overshot
  // and then "fell back down" to the real provider numbers once the usage event
  // landed, which made the badge flicker up/down during long replies. The badge
  // now appears only once real usage exists (same as the titlebar meter), so it
  // stays stable.

  const isSummary = message.role === 'system' && !message.modeSwitch
  const isModeSwitch = message.modeSwitch === true

  // Reading mode: only assistant replies with ≥2 headed sections get the
  // "مطالعه" button — short answers don't need a two-pane viewer.
  const [reading, setReading] = useState(false)
  const sections = useMemo(
    () => (!isUser && !isSummary ? splitSections(message.content) : []),
    [message.content, isUser, isSummary],
  )

  // Mode-switch notices exist so the model knows which mode the next message
  // runs in — the user doesn't want them rendered in the chat. Keep the message
  // in the data (the agent still receives it) but render nothing.
  if (isModeSwitch) return null

  // A steer confirmed by the backend (steer_applied) is rendered inline inside
  // the assistant message it interrupted — hide its own otherwise-bottom bubble.
  if (isUser && message.steerInterleaved) return null

  // While the provider is retrying, the assistant message has no content yet —
  // hide the empty placeholder so the retry banner (rendered once, at the END
  // of the chat in Chat.tsx) is the only thing between the user's message and
  // the incoming reply, instead of a dangling empty bubble.
  if (
    message.retry &&
    !message.content &&
    !(message.segments && message.segments.length > 0)
  ) {
    return null
  }
  const roleLabel = isUser
    ? 'You'
    : isSummary
      ? 'Context summary'
      : message.role === 'tool'
        ? 'Tools'
        : message.mode
          ? modeLabel(message.mode)
          : 'Assistant'

  return (
    <div
      className={`msg ${isUser ? 'user' : ''} ${message.error ? 'error' : ''}`}
      data-msg-id={message.id}
      data-is-summary={isSummary ? 'true' : undefined}
    >
      <div className="msg-role">
        {isUser && (
          <span className="msg-role-avatar" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
            </svg>
          </span>
        )}
        {roleLabel}
      </div>

      {!isUser && message.streaming && !message.retry && (
        <LiveWorkingStatus message={message} />
      )}

      {!isUser && message.plan && message.plan.length > 0 && (
        <div className="plan-block" dir={dir}>
          <div className="plan-head">
            <span className="plan-dot">◎</span>
            <span className="plan-label">Plan</span>
          </div>
          <ul className="plan-list">
            {message.plan.map((item, i) => (
              <li
                key={i}
                className={`plan-item ${item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'running' : ''}`}
              >
                <span className="plan-item-mark">
                  {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}
                </span>
                <span className="plan-item-content" dir="auto">
                  {cachedPrepare(`${message.id}:plan:${i}`, item.content, dir)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span className="attachment-chip" key={a}>@ {a}</span>
          ))}
        </div>
      )}

      {message.images && message.images.length > 0 && (
        <div className="msg-images" dir="ltr">
          {message.images.map((img) => (
            <div className="msg-image" key={img.path} title={img.name}>
              {img.dataUrl ? (
                <img src={img.dataUrl} alt={img.name} />
              ) : (
                <span className="msg-image-ph">{img.name}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {(isSummary || message.content || (message.segments && message.segments.length > 0)) && (
        isModeSwitch ? (
          <div className="mode-switch-note" dir="ltr">{cachedPrepare(message.id, message.content, 'ltr')}</div>
        ) : isSummary ? (
          <div className={`summary-block${summaryCollapsed ? ' collapsed' : ''}`}>
            <div className="summary-head" onClick={() => setSummaryCollapsed((c) => !c)} role="button" tabIndex={0}>
              <span className={`summary-chevron${summaryCollapsed ? '' : ' open'}`}>▶</span>
              <span className="summary-icon">📎</span>
              <span className="summary-label">Context summary</span>
              {summaryCollapsed && message.content && (
                <span className="summary-preview" dir="auto">
                  {cachedPrepare(message.id, message.content, dir)}
                </span>
              )}
              <span className="summary-hint">
                earlier turns folded into this summary — the agent still receives it
              </span>
            </div>
            {!summaryCollapsed && (
              <div className="summary-body chat-message markdown-body" dir="auto">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[REHYPE_HIGHLIGHT]}
                  components={mdComponents}
                >
                  {cachedPrepare(`${message.id}:summary`, message.content || "(empty summary)", dir)}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : message.segments && message.segments.length > 0 ? (
          /* Claude-style interleaved rendering: text slices and tool cards follow
             each other in the exact order the agent produced them, with runs of
             2+ read-only tool calls collapsed into one summary (see renderSegments). */
          <div className="msg-bubble segmented">
            {renderSegments(message, onRetry)}
          </div>
        ) : isUser && message.steerPending ? (
          <div className="queued-bubble steer" dir={dir}>
            <div className="queued-bubble-head">
              <span className="queued-bubble-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 14L4 9l5-5" />
                  <path d="M4 9h10a5 5 0 015 5v6" />
                </svg>
              </span>
              <span className="queued-bubble-label">Steering the running agent…</span>
              <span className="queued-bubble-pulse" />
              <button
                className="chip-x queued-bubble-x"
                onClick={() => {
                  const s = useStore.getState()
                  const chat = s.chats.find((c) =>
                    c.messages.some((m) => m.id === message.id),
                  )
                  if (!chat) return
                  s.removeMessage(chat.id, message.id)
                  void cancelSteer(chat.id, message.id)
                }}
                title="Cancel steer — remove this message"
              >
                ×
              </button>
            </div>
            <div className="queued-bubble-text" dir={detectDir(message.content)}>
              {cachedPrepare(message.id, message.content, dir)}
            </div>
          </div>
        ) : isUser ? (
          /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
             from the first strong char only, so a user message starting with
             a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
             72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
             the rendered bubble identical to what the user typed. */
          <UserMessageBubble message={message} onRetry={onRetry} />
        ) : (
        <div className="msg-bubble">
          <div className="chat-message markdown-body" dir="auto">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[REHYPE_HIGHLIGHT]}
              components={mdComponents}
            >
              {cachedPrepare(message.id, message.content, dir)}
            </ReactMarkdown>
          </div>
        </div>
        )
      )}

      {!isUser && message.interrupted && (
        <div className="msg-interrupted" dir="auto">
          ⚠️ Interrupted — this reply was cut off (e.g. power loss). Send “continue” to resume.
        </div>
      )}

      {!isUser && (message.content || message.usage || message.streaming) && (
        <div className="msg-actions">
          {message.usage && (
            <UsageBadge
              input={message.usage.inputTokens}
              output={message.usage.outputTokens}
              total={message.usage.totalTokens}
            />
          )}
          {message.content && (
            <>
              <button className={`msg-copy ${copied ? 'copied' : ''}`} onClick={copyMessage} title="Copy message">
                {copied ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
              {!isUser && !isSummary && !message.streaming && sections.length >= 2 && (
                <button
                  className="msg-copy msg-read"
                  onClick={() => setReading(true)}
                  title="Reading mode — study each section separately and ask about it"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  Read
                </button>
              )}
            </>
          )}
        </div>
      )}

      {reading && <ReadingMode message={message} onClose={() => setReading(false)} />}
    </div>
  )
})
