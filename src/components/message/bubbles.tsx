import { detectDir, fixZwsp, stripBidiMarks } from '../../lib/bidi'
import { splitQuoteFromContent } from '../../lib/chatQuote'
import { copyToClipboard } from '../../lib/clipboard'
import { useViewerTabs } from '../../lib/viewerTabs'
import type { ChatMessage } from '../../types'
import { FileChip, FileIcon, openWorkspaceFile } from '../FileIcon'
import { MessageImages } from '../MessageImages'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { EditIcon, USER_COLLAPSE_CHARS, isCollapsibleText, textTabTitle } from './thinking'

import { attachmentBasename, cachedPrepare, perLineDir } from './shared'
export function UserMessageBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
  className,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // Inline edit mode: the bubble text swaps for a textarea with Save/Cancel.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the textarea to fit the draft (up to max-height) so long
  // messages keep the full bubble size instead of a small scroll box.
  useEffect(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const content = message.content || "";
  // A sent reply bakes its quote into the content as leading markdown "> "
  // lines (combineQuoteAndInput). Split it out so the bubble renders the
  // styled quote block above the typed body — same look as the assistant's
  // markdown blockquote, and retroactive for every already-sent reply.
  const { quote, body: replyBody } = useMemo(() => splitQuoteFromContent(content), [content]);
  // Folded preview only: a long text is clamped to USER_COLLAPSE_CHARS in the
  // chat and its FULL body (not the preview) opens in the side panel — a long
  // paste reads like a diff/plan tab there, and the bubble never grows into a
  // wall of text.
  const isLong = isCollapsibleText(content);
  const body = isLong ? replyBody.slice(0, USER_COLLAPSE_CHARS) : replyBody;
  const clamped = isLong;

  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // Enter edit mode with a fresh draft; Enter sends via onEdit only when the
  // trimmed text is non-empty and actually changed.
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(content);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === content) {
      setIsEditing(false);
      return;
    }
    onEdit?.(message.id, next);
    setIsEditing(false);
  };

  return (
    <>
      <div className={`msg-bubble${className ? ` ${className}` : ""}${isEditing ? " editing" : ""}`}>
        {isEditing ? (
          <div className="msg-edit-wrap">
            <textarea
              ref={editInputRef}
              className="msg-edit-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
              dir="auto"
              rows={4}
              autoFocus
            />
            <div className="msg-edit-actions">
              <span
                className="msg-edit-hint"
                title="Escape cancels, Enter sends"
                aria-hidden="true"
              >
                i
              </span>
              <button className="msg-edit-cancel" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
        <div
          className={`chat-message user-text${clamped ? " clamped" : ""}`}
          dir={detectDir(replyBody)}
        >
          {/* Reply-quote block: dimmed text behind a start-side bar, then the
              typed body. Per-LINE direction (ChatGPT style) inside both, like
              the rest of the bubble. */}
          {quote && (
            <div className="user-quote-block" dir={detectDir(quote)}>
              {perLineDir(cachedPrepare(`${message.id}:quote`, quote))}
            </div>
          )}
          {/* Per-LINE direction (ChatGPT style): the bubble always parks on
              the user's side, but each line inside follows its own language —
              English lines render LTR flush-left, Persian lines RTL
              flush-right, inside one mixed message. A quote-only send shows
              just the quote block (no empty body line). */}
          {body || !quote
            ? perLineDir(cachedPrepare(message.id, body) || "(empty)")
            : null}
        </div>
        )}
        {!isEditing && isLong && (
          <button
            className="msg-expand"
            onClick={() =>
              useViewerTabs
                .getState()
                .openText(textTabTitle(content, "Message"), content)
            }
            title="Open the full text in the side panel"
          >
            Show more
          </button>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments" dir="ltr">
            {message.attachments.map((a) => (
              <span
                className="attachment-chip attachment-chip-open"
                key={a}
                role="button"
                tabIndex={0}
                title={`${a} — open in the side panel`}
                // pointerdown, not click: focusing this chat window re-renders
                // the list and replaces this node before `click` fires, which
                // swallowed the open (see FileChip). Click stays as a backup.
                onPointerDown={() => openWorkspaceFile(a)}
                onClick={() => openWorkspaceFile(a)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openWorkspaceFile(a);
                  }
                }}
              >
                <FileIcon path={a} size={20} />{attachmentBasename(a)}
              </span>
            ))}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <MessageImages images={message.images} />
        )}
      </div>
      {message.content && !isEditing && (
        /* Order (LTR visual): Copy — Edit — Regenerate. No fork under the
           user bubble (user request). The row is direction:ltr (fixed footer
           geometry), so DOM order == visual order. */
        <div className="msg-actions">
          <button
            className={`msg-copy ${copied ? "copied" : ""}`}
            onClick={copy}
            title="Copy message"
            aria-label="Copy message"
          >
            {copied ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {onEdit && !isEditing && (
            <button
              className="msg-copy msg-edit"
              onClick={startEdit}
              disabled={editingDisabled}
              title="Edit message"
              aria-label="Edit message"
            >
              <EditIcon />
            </button>
          )}
          {onRetry && (
            <button
              className="msg-copy msg-retry"
              onClick={() => onRetry(message.id)}
              title="Regenerate"
              aria-label="Regenerate — delete this turn and generate it again from scratch"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Order-preserving in-place text swap for a not-yet-sent queue item.
 *  Returns the updated list, or null when the edit is rejected (empty text
 *  or unknown id). Pure helper so the queue edit path is unit-testable
 *  without rendering. */
export function editQueuedText<T extends { id: string; text: string }>(
  items: T[],
  id: string,
  newText: string,
): T[] | null {
  const text = newText.trim();
  if (!text) return null;
  let found = false;
  const next = items.map((q) => {
    if (q.id !== id) return q;
    found = true;
    return { ...q, text };
  });
  return found ? next : null;
}

/** Foldable body text for queued / steer bubbles: long text clamps like a
 *  folded user message; the button opens the full text in the side panel.
 *  When onEdit is set, a pencil button swaps the text for the same inline
 *  textarea + Save/Cancel used by user bubbles (same CSS classes). Queue
 *  items edit in place (no resubmit); steer bubbles resubmit through the
 *  shared onEdit path in Chat.tsx. */
export function QueuedCollapsibleText({
  id,
  text,
  onEdit,
  editingDisabled,
}: {
  id: string;
  text: string;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
}) {
  // Same rule as the user bubble: a long text is clamped in the chat and its
  // full body opens in the side panel. A queued reply carries the same baked
  // "> " quote block — split it so the pending bubble matches the sent one.
  const isLong = isCollapsibleText(text);
  const { quote, body: replyBody } = useMemo(() => splitQuoteFromContent(text), [text]);
  // Inline edit mode: same UX as UserMessageBubble — the text swaps for a
  // textarea with Save/Cancel.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the textarea to fit the draft (up to max-height).
  useEffect(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);

  // Enter edit mode with a fresh draft; Enter sends via onEdit only when the
  // trimmed text is non-empty and actually changed.
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(text);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === text) {
      setIsEditing(false);
      return;
    }
    onEdit?.(id, next);
    setIsEditing(false);
  };

  return (
    <>
      {isEditing ? (
        <div className="msg-edit-wrap">
          <textarea
            ref={editInputRef}
            className="msg-edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
              dir="auto"
              rows={4}
              autoFocus
            />
            <div className="msg-edit-actions">
              <span
                className="msg-edit-hint"
                title="Escape cancels, Enter sends"
                aria-hidden="true"
              >
                i
              </span>
              <button className="msg-edit-cancel" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
        </div>
      ) : (
        <>
          <div
            className={`queued-bubble-text${isLong ? " clamped" : ""}`}
            dir={detectDir(replyBody)}
          >
            {quote && (
              <div className="user-quote-block" dir={detectDir(quote)}>
                {cachedPrepare(`${id}:quote`, quote)}
              </div>
            )}
            {replyBody || quote
              ? cachedPrepare(id, replyBody)
              : cachedPrepare(id, replyBody) || "(empty)"}
          </div>
          {isLong && (
            <button
              className="msg-expand queued-expand"
              onClick={() =>
                useViewerTabs
                  .getState()
                  .openText(textTabTitle(text, "Queued text"), text)
              }
              title="Open the full text in the side panel"
            >
              Show more
            </button>
          )}
        </>
      )}
      {onEdit && !isEditing && (
        <div className="msg-actions">
          <button
            className="msg-copy msg-edit"
            onClick={startEdit}
            disabled={editingDisabled}
            title="Edit message"
            aria-label="Edit message"
          >
            <EditIcon />
          </button>
        </div>
      )}
    </>
  );
}

export function SegSteerBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
}) {
  // Render the EXACT same structure as a standalone user message (role header
  // + bubble + actions) so an interleaved steer is pixel-identical to the
  // user's own messages — the .msg.user wrapper reuses the same CSS.
  return (
    <div className="msg user seg-steer">
      <div className="msg-role">
        <span className="msg-role-avatar" aria-hidden="true">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
          </svg>
        </span>
        You
      </div>
      <UserMessageBubble message={message} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />
    </div>
  );
}

/** One readable line for the folded summary card. The raw text starts with an
 *  XML-ish `<summary>` wrapper and numbered markdown headings ("1. Task and
 *  scope:"), which made the preview look like a dump. Tags, list/heading
 *  markers and bare heading lines are dropped; the first few real sentences are
 *  joined and capped, so preparing the text stays cheap on huge summaries. */
export function summaryPreviewText(content: string): string {
  const lines = content
    .slice(0, 6000)
    .replace(/<\/?[a-zA-Z_][\w-]*>/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "")
        .replace(/[*_`]+/g, "")
        .trim(),
    )
    .filter(Boolean);
  const body = lines.filter((l) => !(l.endsWith(":") && l.length <= 60));
  return (body.length > 0 ? body : lines).join(" · ").slice(0, 320);
}

/** Renders a folded context-summary message: the preview stays folded in the
 *  chat and the header opens the full summary in the side panel (like
 *  diff/plan), never inline. Shared by the standalone system-message bubble
 *  and the inline `compact` segment. */
export const SummaryBlock = memo(function SummaryBlock({ message }: { message: ChatMessage }) {
  const content = message.content || "";
  const preview = useMemo(() => summaryPreviewText(content), [content]);
  const words = useMemo(() => (content.trim() ? content.trim().split(/\s+/).length : 0), [content]);
  // A fork seed is a DIGEST of the source chat, not a compaction of this one:
  // saying "earlier turns folded into this summary" made the fork look like it
  // had lost its transcript. It never had one — only this seed was copied.
  const isFork = content.startsWith("[Forked from");
  const open = () =>
    useViewerTabs.getState().openText(isFork ? "Forked context" : "Context summary", content);
  const hint = isFork
    ? "Original messages were not copied — this is the compacted seed the fork runs on. Click to open it in the side panel."
    : "Earlier turns were folded into this summary. Click to open it in the side panel.";
  return (
    <div className="summary-block collapsed">
      <div
        className="summary-head"
        onClick={open}
        role="button"
        tabIndex={0}
        title={hint}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className="summary-icon" aria-hidden="true">
          {isFork ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="5" r="2.2" />
              <circle cx="6" cy="19" r="2.2" />
              <circle cx="18" cy="8" r="2.2" />
              <path d="M6 7.2v9.6M18 10.2c0 4-6 3.2-12 7" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3 3 7.5 12 12l9-4.5L12 3z" />
              <path d="m3 12 9 4.5 9-4.5" />
              <path d="m3 16.5 9 4.5 9-4.5" />
            </svg>
          )}
        </span>
        <span className="summary-main">
          <span className="summary-title-row">
            <span className="summary-label">{isFork ? "Forked context" : "Context summary"}</span>
            {words > 0 && <span className="summary-meta">{words.toLocaleString()} words</span>}
          </span>
          {preview && (
            <span className="summary-preview" dir="auto">
              {cachedPrepare(`${message.id}:sum`, preview)}
            </span>
          )}
        </span>
        <span className="summary-open">
          Open
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </div>
    </div>
  );
});

/** A text segment counts as a "caption" (narration the model wrote right
 *  before a tool call, e.g. "بذار ببینم X رو...") rather than real answer
 *  prose. Only SHORT narration qualifies: a long or multi-line text is real
 *  answer prose (e.g. the plan body or a summary) and must render as a
 *  paragraph OUTSIDE the tool group — otherwise the reply stays trapped
 *  inside the group card. Fenced code blocks are also real content, never a
 *  "let me check X" line, and rendering them as a raw narration row would
 *  lose all formatting. */
export const CAPTION_MAX_CHARS = 260;
export const CAPTION_MAX_LINES = 2;

export function isCaptionCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("```")) return false;
  if (t.length > CAPTION_MAX_CHARS) return false;
  if (t.split("\n").length > CAPTION_MAX_LINES) return false;
  return true;
}

/** Unit-tested helper (trace card identity pattern): direct key inspection —
 *  keeps trace card identity stable during streaming — without
 *  needing a render. */
