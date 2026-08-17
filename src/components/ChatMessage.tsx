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
import { fixZwsp, prepareContent, stripBidiMarks } from '../lib/bidi'
import { copyToClipboard } from '../lib/clipboard'
import { defaultMaxHistoryFor, useStore } from '../lib/store'
import { estimateContextTokens, modelContextWindow } from '../lib/context'
import { getMode } from '../lib/modes'
import { ToolCallView, ToolGroupView } from './ToolCallView'
import 'highlight.js/styles/github-dark.min.css'

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
const mdComponents = {
  a: (props: React.HTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noreferrer" />
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
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {prepareContent(text, dir)}
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

// Any tool that MUTATES persistent state (workspace files, the memory vector
// store, saved skills/MCP connectors) always renders as its own full, visible
// card — never swept into the collapsed read-only group. Grouping a write
// silently is worse than grouping a search: the user has no way to tell it
// happened, which is exactly the "did this actually save?" confusion this set
// exists to prevent.
const ALWAYS_VISIBLE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'memory',
  'create_skill',
  'create_mcp',
  'explore',
])

/** Interleave text slices with tool cards (Claude-style), but collapse runs of
 *  2+ consecutive read-only/non-mutating tool calls (grep/glob/read/
 *  web_search/run_terminal/search_memory) into one ToolGroupView so a
 *  search-heavy turn doesn't stack a full-height row per call. Anything in
 *  ALWAYS_VISIBLE_TOOLS always breaks the run and renders as its own full card
 *  (diff/confirmation visible), same as before. */
function SegSteerBubble({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry?: (id: string) => void
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
    <div className="seg-steer">
      <div className="seg-steer-label">You</div>
      <div className="seg-steer-text" dir={dir}>
        {prepareContent(message.content, dir) || '(empty)'}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span className="attachment-chip" key={a}>@ {a}</span>
          ))}
        </div>
      )}
      {(onRetry || message.content) && (
        <div className="seg-steer-actions">
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
    </div>
  )
}

function renderSegments(message: ChatMessage, onRetry?: (id: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let pending: { activity: ToolActivity; index: number }[] = []

  const flush = (key: string) => {
    if (pending.length === 0) return
    if (pending.length === 1) {
      const { activity, index } = pending[0]
      nodes.push(
        <ToolCallView
          key={key}
          activity={activity}
          onReverted={() => useStore.getState().markToolReverted(message.id, index)}
        />,
      )
    } else {
      nodes.push(
        <ToolGroupView
          key={key}
          activities={pending}
          onReverted={(idx) => useStore.getState().markToolReverted(message.id, idx)}
        />,
      )
    }
    pending = []
  }

  message.segments?.forEach((seg, i) => {
    if (seg.kind === 'user') {
      flush(`grp-${i}`)
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
      flush(`grp-${i}`)
      nodes.push(
        <div key={i} className="chat-message markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {prepareContent(seg.text, useStore.getState().dir)}
          </ReactMarkdown>
        </div>,
      )
      return
    }
    const activity = message.toolActivity?.[seg.index]
    if (!activity) return
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool)) {
      flush(`grp-${i}`)
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
  // The context summary collapses by default — it is a compact checkpoint the
  // user can expand on demand instead of a wall of text dominating the bubble.
  const [summaryCollapsed, setSummaryCollapsed] = useState(
    message.role === 'system' && !message.modeSwitch,
  )

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

  // While a reply is still streaming, the provider hasn't reported real usage
  // yet (the usage event only fires after each model request completes). Show a
  // live estimate of the input side so the badge is visible during long
  // responses; it swaps to the real numbers once the first usage event lands.
  const liveInput = useMemo(() => {
    if (!message.streaming || message.usage) return 0
    const st = useStore.getState()
    const chat = st.chats.find((c) => c.messages.some((m) => m.id === message.id))
    if (!chat) return 0
    const provider =
      st.settings.providers.find((p) => p.id === st.settings.activeProviderId) ??
      st.settings.providers[0]
    const maxHistory = provider?.maxHistory ?? defaultMaxHistoryFor(provider?.kind)
    const ctxWindow = modelContextWindow(provider, provider?.model ?? '')
    return estimateContextTokens(
      chat,
      st.settings.systemPrompts?.[chat.mode] ?? '',
      maxHistory,
      ctxWindow ?? undefined,
      chat.mode,
    )
  }, [message.id, message.streaming, message.usage])

  const isSummary = message.role === 'system' && !message.modeSwitch
  const isModeSwitch = message.modeSwitch === true

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
    : message.role === 'tool'
      ? 'Tools'
      : message.mode
        ? modeLabel(message.mode)
        : isSummary
          ? 'Context summary'
          : 'Assistant'

  return (
    <div
      className={`msg ${isUser ? 'user' : ''} ${message.error ? 'error' : ''}`}
      data-msg-id={message.id}
      data-is-summary={isSummary ? 'true' : undefined}
    >
      {!isSummary && !isModeSwitch && (
        <div className="msg-role">
          {roleLabel}
        </div>
      )}

      {isUser && message.steerPending && (
        <div className="steer-note">
          <span className="steer-dot">●</span>
          <span>steering the running agent…</span>
        </div>
      )}

      {!isUser && message.streaming && !message.retry && (
        <LiveWorkingStatus message={message} />
      )}

      {!isUser && !message.streaming && message.thinking && <ThinkingBlock text={message.thinking} />}

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
                <span className="plan-item-content">
                  {prepareContent(item.content, dir)}
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
          <div className="mode-switch-note" dir="ltr">{stripBidiMarks(fixZwsp(message.content))}</div>
        ) : isSummary ? (
          <div className={`summary-block${summaryCollapsed ? ' collapsed' : ''}`}>
            <div className="summary-head" onClick={() => setSummaryCollapsed((c) => !c)} role="button" tabIndex={0}>
              <span className={`summary-chevron${summaryCollapsed ? '' : ' open'}`}>▶</span>
              <span className="summary-icon">📎</span>
              <span className="summary-label">Context summary</span>
              {summaryCollapsed && message.content && (
                <span className="summary-preview">
                  {stripBidiMarks(fixZwsp(message.content))}
                </span>
              )}
              <span className="summary-hint">
                earlier turns collapsed — not re-sent; a fresh reader continues from here
              </span>
            </div>
            {!summaryCollapsed && (
              <div className="summary-body chat-message markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {prepareContent(message.content || "(empty summary)", dir)}
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
        ) : (
        <div className="msg-bubble">
          {isUser ? (
            <div className="chat-message user-text" dir={dir}>
              {prepareContent(message.content, dir)}
            </div>
          ) : (
            <div className="chat-message markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {prepareContent(message.content, dir)}
              </ReactMarkdown>
            </div>
          )}
        </div>
        )
      )}

      {(message.content || (!isUser && (message.usage || message.streaming))) && (
        <div className="msg-actions">
          {!isUser && (message.usage || message.streaming) && (
            <UsageBadge
              input={message.usage?.inputTokens ?? liveInput}
              output={message.usage?.outputTokens ?? 0}
              total={message.usage?.totalTokens ?? liveInput}
              live={!message.usage}
            />
          )}
          {message.content && (
            <>
              {isUser && onRetry && (
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
            </>
          )}
        </div>
      )}
    </div>
  )
})
