import { useMemo, useEffect, useState, type ReactNode } from 'react'
import type { ChatMessage, ToolActivity } from '../../types'
import { prepareContent } from '../../lib/bidi'
import { dedupDocPaths, extractInlinePathParts, filePathFromHref, isDocPath, looksLikeFilePath, splitPathLine } from '../../lib/fileTypes'
import { RENDER_CAP } from '../../lib/renderCap'
import { FileChip } from '../FileIcon'
import { isolateLtrRuns, dirByText } from '../../lib/ltrIslands'
import { editTargetOf } from '../../lib/toolActivity'

export function attachmentBasename(a: string): string {
  const idx = Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\"));
  return idx >= 0 ? a.slice(idx + 1) : a;
}

/** Collect distinct non-code document paths (pdf/word/excel/csv) from tool
 *  activities for created or edited files. Covers write_document
 *  (create/edit/style) plus edit_file/write_file when they touch a doc
 *  extension. Only path strings are collected, no file bodies, so rendering
 *  stays cheap. */
export function docPathsFromActivities(list?: ToolActivity[]): string[] {
  if (!list || list.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const tool = a.tool ?? "";
    const isDocTool =
      tool === "write_document" || tool === "edit_file" || tool === "write_file";
    if (isDocTool) {
      const raw = editTargetOf(a.args) || undefined;
      const candidates = [
        typeof raw === "string" ? raw : "",
        typeof a.summary === "string" ? a.summary : "",
      ];
      for (const c of candidates) {
        if (!c) continue;
        const token =
          c.trim().split(/\s+/).find((t) => isDocPath(t)) ?? "";
        const target = token || (isDocPath(c) ? c.trim() : "");
        if (!target) continue;
        const { path } = splitPathLine(target);
        const clean = path.trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
      }
    }
    if (a.children && a.children.length > 0) {
      for (const p of docPathsFromActivities(a.children)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}

/** Clickable row of non-code document files produced in this turn. Each chip
 *  opens the file in the viewer panel via openWorkspaceFile (path/line/root
 *  only, no body preload). */
export function DocFileChips({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="msg-attachments" dir="ltr">
      {paths.map((p) => (
        <FileChip key={p} path={p} display={attachmentBasename(p)} />
      ))}
    </div>
  );
}

// Cache prepareContent per message id so re-renders with UNCHANGED content
// (dir toggles, parent re-renders that don't recreate the message, memo
// defeats) don't re-run the bidi-mark strip + ZWSP-fix passes over every
// message on every paint. The cached text is validated on each hit, so a
// STREAMING message (same id, growing content) always recomputes instead of
// showing stale text. FIFO-bounded so long sessions can't leak memory.
export const preparedCache = new Map<string, { text: string; out: string }>();
export const PREPARED_CACHE_MAX = 400;
/** Byte ceiling for the cache, on top of the entry count.
 *
 *  A COUNT cap alone is not a memory bound when entries are huge: a thinking
 *  block streams token by token and `cachedPrepareText` keys by the TEXT, so
 *  every delta inserted a brand-new entry holding two copies (input + output) of
 *  a growing multi-hundred-KB string. 400 such entries is tens of MB of pure
 *  garbage that the FIFO only evicts long after it was allocated — and it never
 *  even helped, because the NEXT token has a different key. */
export const PREPARED_CACHE_MAX_CHARS = 2_000_000;
/** Content above this is not worth caching at all: it is (a) unlikely to be
 *  re-rendered with identical text and (b) most of the cache's weight. */
export const PREPARED_CACHE_SKIP_CHARS = 40_000;
export let preparedCacheChars = 0;

/** Fork a chat, after a confirmation.
 *
 *  The fork button is a small icon sitting next to Edit/Copy/Retry, and forking
 *  SWITCHES the active chat: a stray click pulls the user out of the
 *  conversation they were reading. The source chat survives, but the user still
 *  has to find their way back, so one click is not enough. `window.confirm` is
 *  the app's existing pattern for this (SettingsModal, PluginDetail, Chat).
 *
 *  The message names what is being forked and from where, because "Are you
 *  sure?" alone trains the user to dismiss it reflexively — the confirm is only
 *  useful when it says what the click is about to do. */

export function perLineDir(text: string): ReactNode {
  return text.split("\n").map((ln, i) => (
    // dir = LANGUAGE MAJORITY of the line (dirByText): first-strong flips a
    // mostly-English line that merely contains a Persian word. Numbers/ranges
    // get the LTR-island wrapper so ۳٫۷۵–۴٫۰۰٪ never reverses (plain user
    // text never goes through the markdown pipeline where islands run).
    <div key={i} className="user-text-line" dir={dirByText(ln)}>
      {ln ? isolateLtrRuns(ln) : "\u00a0"}
    </div>
  ));
}

export function dropPrepared(id: string): void {
  const hit = preparedCache.get(id);
  if (hit) {
    preparedCacheChars -= hit.text.length + hit.out.length;
    preparedCache.delete(id);
  }
}

export function computePrepared(
  id: string,
  text: string,
  dir?: "rtl" | "ltr",
): string {
  const hit = preparedCache.get(id);
  if (hit && hit.text === text) return hit.out;
  const out = prepareContent(text, dir);
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return out;
  // Replace (not just insert) so a streaming message's previous, smaller entry
  // is released as it grows instead of leaving a trail of stale copies.
  dropPrepared(id);
  while (
    preparedCache.size > 0 &&
    (preparedCache.size >= PREPARED_CACHE_MAX ||
      preparedCacheChars + text.length + out.length > PREPARED_CACHE_MAX_CHARS)
  ) {
    const oldest = preparedCache.keys().next().value;
    if (oldest === undefined) break;
    dropPrepared(oldest);
  }
  preparedCache.set(id, { text, out });
  preparedCacheChars += text.length + out.length;
  return out;
}
export function cachedPrepare(id: string, text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  return computePrepared(id, text, dir);
}
/** For content with no stable id (the thinking block only receives `text`):
 *  key by the text itself — prepareContent is deterministic, so equal text
 *  always yields equal output.
 *
 *  Short-circuits before building the key for long content: the key is a full
 *  COPY of the text (`t:${text}`), and while a reasoning block streams that is a
 *  fresh multi-hundred-KB allocation per token that can never hit (the next token
 *  has different text). Streaming was paying for a duplicate of the whole block
 *  on every delta. */
export function cachedPrepareText(text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return prepareContent(text, dir);
  return computePrepared(`t:${text}`, text, dir);
}

// Never render more than RENDER_CAP chars of ONE message without an explicit
// click: pasted log/trace dumps reach megabytes, and parsing + laying out
// that text on EVERY chat switch (plus re-sending it to the model every turn)
// is the main cost on giant histories. History on disk, copy-to-clipboard
// and the model context always keep the FULL text — only the paint is capped.
// Live (streaming) messages are never capped: truncating a reply mid-stream
// would flicker and hide the newest tokens.
export function useCapped(id: string, text: string, live: boolean) {
  const over = !live && text.length > RENDER_CAP;
  const [showAll, setShowAll] = useState(false);
  // Reset the expansion when the hook is reused for a different message
  // (virtualized bubbles recycle the component). Without this, switching chats
  // while one bubble was expanded left the NEXT message fully expanded too.
  useEffect(() => {
    setShowAll(false);
  }, [id]);
  const shown = over && !showAll ? text.slice(0, RENDER_CAP) : text;
  return { shown, over, cut: text.length - shown.length, showAll, setShowAll };
}

/** Collapsed implementation-plan card on a Plan-mode reply (kind:"plan_card").
 *  Shows the plan's title, a faded plain-text preview and a "View full plan"
 *  pill that opens the docked Plan viewer tab with the whole document. */

