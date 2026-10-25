import type { Chat, ChatMessage, MessageSegment } from "../types";

export interface PlanDisplay {
  content: string;
  segments?: MessageSegment[];
  /** The plan document whose prose was cut out of `content`/`segments`, if any. */
  planDoc?: PlanDoc;
}

export interface PlanDoc {
  title: string;
  body: string;
  preamble?: string;
}

/**
 * Whether a stored planDoc is a plan DOCUMENT worth showing.
 *
 * A plan-mode turn ends with a closing note ("the plan is saved, switch to
 * Build"), and the save used to keep only that last round — so a chat can
 * carry a `planDoc` that is not a plan at all: the docked panel then showed
 * that note instead of the plan. A plan document is the shape the plan prompt
 * asks for (a markdown heading, then one line per step, or a step list/table),
 * so anything else is treated as "no plan" and recovered from the message.
 */
export function isPlanDoc(doc?: Partial<PlanDoc> | null): doc is PlanDoc {
  const body = (doc?.body ?? "").trim();
  if (!body) return false;
  if (hasHeading(body)) return true;
  const stepLines = body
    .split("\n")
    .filter((l) => /^\s*(?:[-*|]|\d+[.)])\s/.test(l));
  return stepLines.length >= 2;
}

/**
 * Why a heading is the strong signal, not the step list.
 *
 * `isPlanDoc` accepts a bare step list so a plan written without a heading is
 * still shown, but a bulleted chat ANSWER ("the marketplace belongs in Settings
 * because…") looks the same. A heading is what the plan prompt guarantees for a
 * plan, so when one is missing the caller prefers a document recovered from the
 * message stream and only falls back to the step-list shape.
 */
function hasHeading(body: string): boolean {
  return /^#{1,6}\s/m.test(body);
}

/**
 * Visible text/segments for a message that carries a planDoc (the collapsed
 * implementation-plan card from Plan mode's `plan_card` event).
 *
 * The message keeps its FULL streamed content — later turns send it to the
 * model as history and "Copy message" copies all of it — but the bubble must
 * show only the prose the planner wrote AROUND the plan, because the plan
 * itself renders as the card below the bubble:
 *
 * - Segmented messages: everything after the last tool segment is the plan
 *   (the plan is always the final part of the reply), so trailing text
 *   segments are dropped. If the planner wrote a preamble but every kept
 *   segment is a tool card, the preamble is re-inserted as one text segment
 *   so it stays visible.
 * - Plain messages: cut the content at the plan body (lastIndexOf) with a
 *   fallback `## Plan` header split for truncated/edited streams.
 *
 * `planDoc` is returned alongside, so the caller renders the card for the
 * document it recovered from a legacy message (not just the stored one).
 */
export function planDisplay(message: ChatMessage): PlanDisplay {
  // `message.planDoc` can be the closing note instead of the plan (see
  // `isPlanDoc`); the reply's own stream then carries the real document, so
  // recover it and collapse the plan prose into the card exactly the same way.
  const stored = isPlanDoc(message.planDoc) ? message.planDoc : null;
  // A stored doc without a heading may be a plan-mode ANSWER that the old save
  // wrote over the plan (see `hasHeading`). Recover the real document from this
  // message's own stream in that case; when the message carries none, it is not
  // a plan message at all and it keeps its prose.
  const planDoc =
    stored && hasHeading(stored.body) ? stored : planFromMessage(message);
  if (!planDoc) return { content: message.content, segments: message.segments };
  const exact = planDoc === message.planDoc;
  let segments = message.segments;
  if (segments && segments.length > 0) {
    // Find where the plan body starts inside a text segment. It is NOT
    // necessarily trailing: plan mode calls update_plan AFTER writing the
    // plan, so the plan text sits BETWEEN tool segments (read group → plan
    // text → update_plan row) and must still be cut out — otherwise it
    // renders inside the tool group's card instead of as the Plan card.
    const planStart = (text: string): { start: number; end: number } | null => {
      const bodyIdx = planDoc.body ? text.lastIndexOf(planDoc.body) : -1;
      if (bodyIdx >= 0) return { start: bodyIdx, end: bodyIdx + planDoc.body.length };
      const m = text.match(/^#{1,3}\s*(plan|پلن)\b/im);
      return m && m.index != null ? { start: m.index, end: text.length } : null;
    };
    const kept: MessageSegment[] = [];
    let planStarted = false;
    for (const seg of segments) {
      if (seg.kind !== "text") {
        // Tool rows (read/edit/update_plan…) stay visible — only prose is
        // filtered, the card below carries the plan itself.
        kept.push(seg);
        continue;
      }
      if (planStarted && exact) continue; // text after the plan start belongs to the card
      const span = planStart(seg.text);
      if (!span) {
        kept.push(seg);
        continue;
      }
      planStarted = true;
      const before = seg.text.slice(0, span.start).trimEnd();
      if (before) kept.push({ kind: "text" as const, text: before });
      // A RECOVERED document is cut out of the stream instead of swallowing
      // everything after it: the planner's closing note stays in the bubble.
      if (!exact) {
        const after = seg.text.slice(span.end).trim();
        if (after) kept.push({ kind: "text" as const, text: after });
      }
    }
    if (!planStarted) {
      // Plan body not found in any segment (truncated/edited stream): fall
      // back to dropping prose after the last tool card.
      let lastTool = -1;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].kind !== "text") lastTool = i;
      }
      segments = lastTool >= 0 ? kept.slice(0, lastTool + 1) : [];
    } else {
      segments = kept;
    }
    segments =
      planDoc.preamble && !segments.some((s) => s.kind === "text")
        ? [{ kind: "text" as const, text: planDoc.preamble }, ...segments]
        : segments;
  }
  let content = message.content;
  if (content) {
    const bodyIdx = planDoc.body ? content.lastIndexOf(planDoc.body) : -1;
    if (bodyIdx >= 0 && exact) {
      content = content.slice(0, bodyIdx).trimEnd();
    } else if (bodyIdx >= 0) {
      content = (
        content.slice(0, bodyIdx) + content.slice(bodyIdx + planDoc.body.length)
      ).trim();
    } else {
      const m = content.match(/^#{1,3}\s*(plan|پلن)\b[^\n]*$/im);
      if (m && m.index != null) {
        content = content.slice(0, m.index).trimEnd();
      }
    }
  }
  return { content, segments, planDoc };
}

/**
 * The plan prose still sitting in a plan-mode message's own stream, used when
 * the stored planDoc is not a document (see `isPlanDoc`).
 *
 * A plan-mode reply writes the plan BETWEEN its tool rows (read → plan text →
 * update_plan), so the heading and the steps are in one of its text segments.
 * Only messages whose mode is `plan` qualify — a normal answer that happens to
 * quote a `## Plan` heading is not a plan document.
 */
export function planFromMessage(message: ChatMessage): PlanDoc | null {
  if (message.mode !== "plan") return null;
  const texts = (message.segments ?? [])
    .filter((s) => s.kind === "text")
    .map((s) => (s as { text: string }).text)
    .concat(message.content ? [message.content] : []);
  for (const text of texts) {
    const start = text.search(/^#{1,3}\s*(plan|پلن)\b/im);
    if (start < 0) continue;
    const body = text.slice(start).trim();
    if (isPlanDoc({ body })) return { title: "", body };
  }
  return null;
}

/**
 * The active chat's latest plan document (scanned newest-first), for the
 * docked Plan viewer tab. Returns null when the chat has no plan yet.
 */
export function latestPlanDoc(
  chats: Chat[],
  activeChatId: string,
): PlanDoc | null {
  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat) return null;
  // Newest-first, two passes: a document WITH a heading always wins over a
  // headingless step list, which may be a chat answer the old save stored as
  // the plan (see `hasHeading`).
  let weak: PlanDoc | null = null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i];
    if (!message) continue;
    const stored = isPlanDoc(message.planDoc) ? message.planDoc : null;
    if (stored && hasHeading(stored.body)) return stored;
    // Legacy chats: the save once kept only the turn's closing note, so the
    // planDoc is a one-liner while the plan prose still sits in the streamed
    // reply. Recover it from there instead of showing the note.
    const recovered = planFromMessage(message);
    if (recovered) return recovered;
    if (!weak && stored) weak = stored;
  }
  return weak;
}
