// Lightweight file comments: highlighted text + path + owning chat.
// Sending pushes the comment into the SAME chat's message queue (no timers,
// no polling) — Chat.tsx already drains queued messages into the agent turn.
import { sendQueuedNext } from "./chatSends";
import { steerChat } from "./api";
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

/** Render a comment as the chat message the agent receives. Path may carry
a locator suffix (added by the viewers) so the agent can jump straight to
the spot without searching. The locator kind matches the file nature:
- code/text (`path:42`, `path:42-45`) -> Lines
- spreadsheet cell range (`path:B3`, `path:B3:D5`, `path:Sheet1!B3:D5`) ->
  Sheet + Range (row + column, Excel A1 style)
- spreadsheet rows without a clear column (`path:rows 3-5`) -> Rows
The file and position are stated explicitly (header + File/Sheet/Lines or
Range lines) for fast direct edits. */
export function formatFileComment(path: string, quote: string): string {
  const short = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  const quoted = `> ${short.split("\n").join("\n> ")}`;
  // Split off the locator after the LAST colon (workspace paths are relative,
  // so no drive-letter colon to worry about).
  const colon = path.lastIndexOf(":");
  const file = colon > 0 ? path.slice(0, colon) : path;
  const loc = colon > 0 ? path.slice(colon + 1) : "";
  // Spreadsheet A1 range, optional sheet: B3, B3:D5, Sheet1!B3:D5.
  const a1Match = loc.match(/^(?:(.+)!)?([A-Z]+\d+(?::[A-Z]+\d+)?)$/);
  // Spreadsheet rows without columns: rows 3-5 / row 3.
  const rowsMatch = loc.match(/^rows?\s+(\d+(?:-\d+)?)$/i);
  // Code/text lines: 42 / 42-45.
  const linesMatch = loc.match(/^(\d+(?:-\d+)?)$/);
  if (a1Match) {
    const rawSheet = (a1Match[1] ?? "").trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
    const range = a1Match[2];
    const header = rawSheet ? `Comment on \`${file}\` (sheet ${rawSheet}, range ${range}):` : `Comment on \`${file}\` (range ${range}):`;
    const sheetLine = rawSheet ? `\nSheet: ${rawSheet}` : "";
    return `${header}\n${quoted}\n\nFile: ${file}${sheetLine}\nRange: ${range}\n\nDirect edit: open file \`${file}\`${rawSheet ? ` at sheet \`${rawSheet}\`` : ""} at range ${range} without searching the workspace, and apply the request. Do NOT run Search Files.`;
  }
  if (rowsMatch) {
    const rows = rowsMatch[1];
    const single = !rows.includes("-");
    const header = `Comment on \`${file}\` (${single ? `row ${rows}` : `rows ${rows}`}):`;
    return `${header}\n${quoted}\n\nFile: ${file}\nRows: ${rows}\n\nDirect edit: open file \`${file}\` at ${single ? `row ${rows}` : `rows ${rows}`} without searching the workspace, and apply the request. Do NOT run Search Files.`;
  }
  if (linesMatch) {
    const lines = linesMatch[1];
    const single = !lines.includes("-");
    const header = `Comment on \`${file}\` (${single ? `line ${lines}` : `lines ${lines}`}):`;
    return `${header}\n${quoted}\n\nFile: ${file}\nLines: ${lines}\n\nDirect edit: open file \`${file}\` at ${single ? `line ${lines}` : `lines ${lines}`} without searching the workspace, and apply the request. Do NOT run Search Files.`;
  }
  const body = `Comment on \`${path}\`:`;
  return `${body}\n${quoted}\n\nFile: ${path}\n\nDirect edit: open this exact file path without searching the workspace, go to the quoted text, and apply the request. Do NOT run Search Files.`;
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

/** Store the highlight AND deliver it like the chat composer: idle sends as
a normal message, streaming sends as a non-interrupting steer, and explicit
queue (Ctrl/Cmd+Enter) or compacting/waiting states only queue it. */
export function commentFileSelection(chatId: string, path: string, quote: string, opts?: { queue?: boolean }): FileComment {
  const comment = addFileComment(chatId, path, quote);
  const text = formatFileComment(path, comment.quote);
  const store = useStore.getState();
  const chat = store.chats.find((c) => c.id === chatId);
  const compacting = chat?.compacting ?? false;
  const streaming = chat?.messages.some((m) => m.streaming) ?? false;
  const reconnecting = chat?.messages.some((m) => m.retry?.reconnecting) ?? false;
  const waiting = chat?.pendingAsk != null || chat?.pendingPermission != null;
  // Explicit queue (composer Cmd/Ctrl+Enter), compacting, or waiting for
  // ask/permission: only queue, never start or steer a turn.
  if (opts?.queue || compacting || waiting) {
    store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    return comment;
  }
  // Streaming: mirror composer Enter (steer) — visible user message at once,
  // injected at the next tool call without interrupting the stream.
  if (streaming || reconnecting) {
    try {
      const userMsg = store.addMessage(chatId, { role: "user", content: text, steerPending: true });
      void steerChat(chatId, userMsg.id, text);
    } catch {
      store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    }
    return comment;
  }
  // Idle: queue then drain immediately so it sends as a normal turn (no
  // timers, no polling). Drain uses the registered chat send like the
  // composer submit path.
  store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
  try {
    sendQueuedNext(chatId);
  } catch {
    /* stays queued until the next turn */
  }
  return comment;
}
