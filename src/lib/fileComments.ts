// Lightweight file comments: highlighted text + path + owning chat.
// Sending pushes the comment into the SAME chat's message queue (no timers,
// no polling) — Chat.tsx already drains queued messages into the agent turn.
import { sendQueuedNext } from "./chatSends";
import { steerChat } from "./api";
import { ensureChatHydrated, useStore } from "./store";

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
  const uuid =
    typeof crypto !== "undefined" ? crypto.randomUUID?.() : undefined;
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Render a comment as the chat message the agent receives. Path may carry
a locator suffix (added by the viewers) so the agent can jump straight to
the spot without searching. The locator kind matches the file nature:
- code/text (`path:42`, `path:42-45`) -> line(s)
- spreadsheet cell range (`path:B3`, `path:B3:D5`, `path:Sheet1!B3:D5`) ->
  sheet + range (row + column, Excel A1 style)
- spreadsheet rows without a clear column (`path:rows 3-5`) -> rows
The header states the path and position once; the quote follows. No trailing
"Direct edit" directive — the header already carries everything the agent
needs, and repeating it only bloated every message. */
export function formatFileComment(path: string, quote: string): string {
  // Split off the locator as a SUFFIX: splitting at the last colon broke a
  // spreadsheet range, turning "data.xlsx:Sheet1!B3:D5" into file
  // "data.xlsx:Sheet1!B3" + locator "D5".
  const { file, loc } = splitLocator(path);
  // The diff viewer embeds the location inside the quote itself
  // ("[path line 12] code"); the header below already states the path and
  // position, so the marker is dropped instead of printing it twice.
  const body = stripQuoteLocator(quote, file);
  const short =
    body.length > MAX_QUOTE_CHARS
      ? `${body.slice(0, MAX_QUOTE_CHARS)}…`
      : body;
  const quoted = `> ${short.split("\n").join("\n> ")}`;
  // Spreadsheet A1 range, optional sheet: B3, B3:D5, Sheet1!B3:D5.
  const a1Match = loc.match(/^(?:(.+)!)?([A-Z]+\d+(?::[A-Z]+\d+)?)$/);
  // Spreadsheet rows without columns: rows 3-5 / row 3.
  const rowsMatch = loc.match(/^rows?\s+(\d+(?:-\d+)?)$/i);
  // Code/text lines: 42 / 42-45.
  const linesMatch = loc.match(/^(\d+(?:-\d+)?)$/);
  if (a1Match) {
    const rawSheet = (a1Match[1] ?? "")
      .trim()
      .replace(/^'(.*)'$/, "$1")
      .replace(/''/g, "'");
    const range = a1Match[2];
    const where = rawSheet ? `sheet ${rawSheet}, range ${range}` : `range ${range}`;
    return `Comment on \`${file}\` (${where}):\n${quoted}`;
  }
  if (rowsMatch) {
    const rows = rowsMatch[1];
    const where = rows.includes("-") ? `rows ${rows}` : `row ${rows}`;
    return `Comment on \`${file}\` (${where}):\n${quoted}`;
  }
  if (linesMatch) {
    const lines = linesMatch[1];
    const where = lines.includes("-") ? `lines ${lines}` : `line ${lines}`;
    return `Comment on \`${file}\` (${where}):\n${quoted}`;
  }
  return `Comment on \`${path}\`:\n${quoted}`;
}

/** Split a viewer path into (file, locator). The locator is matched as a
 *  SUFFIX so a spreadsheet range keeps its own colon: splitting at the last
 *  colon turned "data.xlsx:Sheet1!B3:D5" into file "data.xlsx:Sheet1!B3" and
 *  locator "D5". Order matters — lines, then rows, then A1 cells. */
function splitLocator(path: string): { file: string; loc: string } {
  const patterns = [
    /^(.*?):(\d+(?:-\d+)?)$/, // code/text lines: 42, 42-45
    /^(.*?):(rows?\s+\d+(?:-\d+)?)$/i, // spreadsheet rows: rows 3-5
    /^(.*?):((?:[^:!]+!)?[A-Z]+\d+(?::[A-Z]+\d+)?)$/, // A1 cell/range, optional sheet
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m) return { file: m[1], loc: m[2] };
  }
  return { file: path, loc: "" };
}

/** Invisible bidi/zero-width marks ride inside paths and quotes copied from
 *  model output and tool results. They are invisible, so a comparison that
 *  ignores them looks correct in the source yet fails at runtime — which left
 *  the `[path line N]` marker in place and printed the path + line twice.
 *  Comparison-only: emitted paths keep their original bytes so the viewer can
 *  still resolve them. */
function stripInvisible(s: string): string {
  return s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}

/** Drop the leading `[path line N]` / `[path lines A-B]` marker the diff
 *  viewer embeds in its quote, but only when it names THIS file — a quote that
 *  legitimately starts with a bracket stays untouched. Strips EVERY leading
 *  marker: a quote spanning several diff rows can carry one per row, and
 *  leaving the rest printed the path and line again below the header. */
function stripQuoteLocator(quote: string, file: string): string {
  const cleanFile = stripInvisible(file);
  const base = cleanFile.split("/").pop() ?? cleanFile;
  let body = quote;
  for (;;) {
    // A leading invisible mark (RTL model output) hides the "[" from the
    // match, so the marker survived and the header repeated the path and line.
    const lead = body.match(/^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]*/);
    const rest = lead ? body.slice(lead[0].length) : body;
    const m = rest.match(/^\[([^\]]*)\]\s*/);
    if (!m) return body;
    const inner = stripInvisible(m[1]).trim();
    const loc = inner.match(/^(.*?)\s+lines?\s+\d+(?:-\d+)?$/);
    const innerPath = (loc ? loc[1] : inner).trim();
    const sameFile =
      innerPath === cleanFile ||
      innerPath === base ||
      innerPath.endsWith(`/${base}`);
    if (!sameFile) return body;
    body = rest.slice(m[0].length);
  }
}

/** Store a highlight without sending it. Quote is truncated for low RAM. */
export function addFileComment(
  chatId: string,
  path: string,
  quote: string,
): FileComment {
  const trimmed =
    quote.length > MAX_QUOTE_CHARS
      ? `${quote.slice(0, MAX_QUOTE_CHARS)}…`
      : quote;
  const comment: FileComment = {
    id: makeId(),
    chatId,
    path,
    quote: trimmed,
    createdAt: Date.now(),
  };
  const list = [...(commentsByChat.get(chatId) ?? []), comment].slice(
    -MAX_COMMENTS_PER_CHAT,
  );
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
export function commentFileSelection(
  chatId: string,
  path: string,
  quote: string,
  opts?: { queue?: boolean },
): FileComment {
  const comment = addFileComment(chatId, path, quote);
  const text = formatFileComment(path, comment.quote);
  const store = useStore.getState();
  const chat = store.chats.find((c) => c.id === chatId);
  // The transcript may still be on disk (index-only row): `messages` is empty
  // then, so the idle/streaming decision below cannot be trusted — an empty
  // array reads as "idle" and would start a context-free turn. Queue the
  // comment, hydrate, and only then re-route. Queuing first keeps the comment
  // safe AND in order (it drains after the current turn if the agent was busy).
  if (chat && chat.hydrated === false) {
    store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    void ensureChatHydrated(chatId).then(() => {
      const fresh = useStore.getState().chats.find((c) => c.id === chatId);
      if (!fresh || fresh.hydrated === false) return;
      const busy = fresh.messages.some(
        (m) => m.streaming || m.retry?.reconnecting === true,
      );
      // Streaming: leave it queued — the composer's queue semantics are exactly
      // what a mid-run comment should get (delivered after the current turn).
      if (busy) return;
      // Idle: drain now as a normal turn. The send path re-checks hydration
      // before building the request, so the model still gets the full context.
      try {
        sendQueuedNext(chatId);
      } catch {
        /* stays queued until the next turn */
      }
    });
    return comment;
  }
  const compacting = chat?.compacting ?? false;
  const streaming = chat?.messages.some((m) => m.streaming) ?? false;
  const reconnecting =
    chat?.messages.some((m) => m.retry?.reconnecting) ?? false;
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
      const userMsg = store.addMessage(chatId, {
        role: "user",
        content: text,
        steerPending: true,
      });
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
