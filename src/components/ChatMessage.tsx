import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage, ToolActivity } from '../types'
import { fixZwsp, prepareContent, stripBidiMarks } from '../lib/bidi'
import { copyToClipboard } from '../lib/clipboard'
import { useStore } from '../lib/store'
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

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(true)
  const textRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const label = open
    ? 'Hide thinking'
    : `Thinking (${localWords(text).toLocaleString()} words)`
  useEffect(() => {
    const el = textRef.current
    if (!el || !open || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [text, open])
  return (
    <div className={`thinking-block ${open ? 'open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className="thinking-dot">✦</span>
        <span className="thinking-label">{label}</span>
        <span className={`chev ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && (
        <div
          className="thinking-text"
          ref={textRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {stripBidiMarks(fixZwsp(text))}
        </div>
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
  model,
  agent,
  onCancel,
  onRetry,
}: {
  attempt: number
  maxAttempts: number
  delay: number
  reason: string
  gaveUp?: boolean
  model?: string
  agent?: string
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
  const label = gaveUp ? 'Retry limit reached' : isRateLimit ? 'Provider rate limit' : unlimited ? 'Provider rate limit' : 'Provider hiccup'
  const suffix = gaveUp
    ? ` (${attempt}/${maxAttempts})`
    : unlimited
      ? ` (attempt ${attempt})${countdown}`
      : ` (${attempt}/${maxAttempts})${countdown}`
  const who = model
    ? ` — ${model}${agent ? ` (${agent})` : ''}`
    : agent
      ? ` — ${agent}`
      : ''
  return (
    <div className="retry-banner" title={reason || undefined}>
      <span className="spinner" />
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

function UsageBadge({ input, output, total }: { input: number; output: number; total: number }) {
  const body = `↑ ${fmtTokens(input)} in · ↓ ${fmtTokens(output)} out`
  return (
    <span className="msg-usage" title={`${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`} dir="ltr">
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
 *  2+ consecutive read-only/non-mutating tool calls (search/list/fuzzy_find/
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
        {message.content || '(empty)'}
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
  const [collapsed, setCollapsed] = useState(message.compacted)

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

  // Folded-into-summary messages: a one-line toggle + a compact excerpt. Keep
  // the raw text greyed out so the scrollback is still inspectable, but the
  // message is NOT re-sent (the summary replaces it).
  if (message.compacted) {
    return (
      <div className="msg compacted" data-msg-id={message.id}>
        <div className="msg-role">
          {roleLabel}
          {message.usage && (
            <UsageBadge
              input={message.usage.inputTokens}
              output={message.usage.outputTokens}
              total={message.usage.totalTokens}
            />
          )}
        </div>
        <button
          className="compacted-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Show old message' : 'Hide old message'}
        >
          <span className={`chev ${collapsed ? '' : 'open'}`}>▸</span>
          <span className="compacted-preview">
            {collapsed
              ? `${message.content.length > 90 ? stripBidiMarks(fixZwsp(message.content.slice(0, 90))) + '…' : stripBidiMarks(fixZwsp(message.content)) || '(no text)'}`
              : stripBidiMarks(fixZwsp(message.content))}
          </span>
        </button>
      </div>
    )
  }

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
          <div className="summary-block">
            <div className="summary-head">
              <span className="summary-icon">📎</span>
              <span className="summary-label">Context summary</span>
              <span className="summary-hint">
                earlier turns collapsed — not re-sent; a fresh reader continues from here
              </span>
            </div>
            <div className="summary-body chat-message markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {prepareContent(message.content || "(empty summary)", dir)}
              </ReactMarkdown>
            </div>
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

      {(message.content || (!isUser && message.usage)) && (
        <div className="msg-actions">
          {!isUser && message.usage && (
            <UsageBadge
              input={message.usage.inputTokens}
              output={message.usage.outputTokens}
              total={message.usage.totalTokens}
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
