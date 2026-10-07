// Lightweight file comments: highlighted text + path + owning chat.
// Sending pushes the comment into the SAME chat's message queue (no timers,
// no polling) — Chat.tsx already drains queued messages into the agent turn.
import { sendQueuedNext } from "./chatSends";
import { useStore } from "./store";

export interface FileComment {
  id: string;
  chatId: string;
  path: string;
  quote: string;
  createdAt: number;
}

const commentsByChat = new Map<string, FileComment[]>();

/** Cap stored comments per chat so highlights never fill RAM. */
const MAX_COMMENTS_PER_CHAT = 100;

/** Cap quoted text sent to the chat so a huge highlight stays cheap. */
const MAX_QUOTE_CHARS = 500;

function makeId(): string {
  const uuid = typeof crypto !== "undefined" ? crypto.randomUUID?.() : undefined;
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Render a comment as the chat message the agent receives. */
export function formatFileComment(path: string, quote: string): string {
  const short = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  const body = `Comment on \`${path}\`:\n> ${short.split("\n").join("\n> ")}`;
  return `${body}\n\nDirect edit: open this exact file path without searching the workspace, go to the quoted lines/rows, and apply the request. Do NOT run Search Files.`;
}

/** Store a highlight without sending it. Quote is truncated for low RAM. */
export function addFileComment(chatId: string, path: string, quote: string): FileComment {
  const trimmed = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  const comment: FileComment = { id: makeId(), chatId, path, quote: trimmed, createdAt: Date.now() };
  const list = [...(commentsByChat.get(chatId) ?? []), comment].slice(-MAX_COMMENTS_PER_CHAT);
  commentsByChat.set(chatId, list);
  return comment;
}

/** Highlights of one chat (optionally filtered to one file). */
export function listFileComments(chatId: string, path?: string): FileComment[] {
  const list = commentsByChat.get(chatId) ?? [];
  return path ? list.filter((c) => c.path === path) : [...list];
}

/** Store the highlight AND queue it as that chat's next agent message. */
export function commentFileSelection(chatId: string, path: string, quote: string): FileComment {
  const comment = addFileComment(chatId, path, quote);
  useStore.getState().queueMessage(chatId, {
    id: comment.id,
    text: formatFileComment(path, comment.quote),
    kind: "queue",
  });
  // Drain immediately when the chat is idle (no timers, no polling):
  // queueMessage alone only auto-sends after a running turn, so an idle
  // chat would sit silent. When busy, skip the drain and the running
  // turn's auto-drain picks it up.
  try {
    const chat = useStore.getState().chats.find((c) => c.id === chatId);
    const busy =
      (chat?.messages.some((m) => m.streaming || m.retry?.reconnecting) ?? false) ||
      chat?.pendingAsk != null ||
      chat?.pendingPermission != null ||
      (chat?.compacting ?? false);
    if (!busy) sendQueuedNext(chatId);
  } catch {
    /* stays queued until the next turn */
  }
  return comment;
}
