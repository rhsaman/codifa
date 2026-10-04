import type { Chat, ChatMessage, MessageSegment } from "../types";

export interface PlanDisplay {
  content: string;
  segments?: MessageSegment[];
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
 */
export function planDisplay(message: ChatMessage): PlanDisplay {
  const planDoc = message.planDoc;
  if (!planDoc) return { content: message.content, segments: message.segments };
  let segments = message.segments;
  if (segments && segments.length > 0) {
    // Find where the plan body starts inside a text segment. It is NOT
    // necessarily trailing: plan mode calls update_plan AFTER writing the
    // plan, so the plan text sits BETWEEN tool segments (read group → plan
    // text → update_plan row) and must still be cut out — otherwise it
    // renders inside the tool group's card instead of as the Plan card.
    const planStart = (text: string): number => {
      const idx = planDoc.body ? text.lastIndexOf(planDoc.body) : -1;
      if (idx >= 0) return idx;
      const m = text.match(/^#{1,3}\s*plan\b/im);
      return m && m.index != null ? m.index : -1;
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
      if (planStarted) continue; // text after the plan start belongs to the card
      const start = planStart(seg.text);
      if (start >= 0) {
        planStarted = true;
        const before = seg.text.slice(0, start).trimEnd();
        if (before) kept.push({ kind: "text" as const, text: before });
      } else {
        kept.push(seg);
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
    if (bodyIdx >= 0) {
      content = content.slice(0, bodyIdx).trimEnd();
    } else {
      const m = content.match(/^#{1,3}\s*plan\b[^\n]*$/im);
      if (m && m.index != null) {
        content = content.slice(0, m.index).trimEnd();
      }
    }
  }
  return { content, segments };
}

/**
 * The active chat's latest plan document (scanned newest-first), for the
 * docked Plan viewer tab. Returns null when the chat has no plan yet.
 */
export function latestPlanDoc(
  chats: Chat[],
  activeChatId: string,
): { title: string; body: string; preamble?: string } | null {
  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const doc = chat.messages[i]?.planDoc;
    if (doc?.body) return doc;
  }
  return null;
}
