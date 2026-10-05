/** The SYSTEM note appended to a follow-up prompt when the same mode has an
 *  unfinished checklist from an earlier turn, so the model continues ticking
 *  the existing items instead of re-planning from scratch. Returns "" when no
 *  note applies.
 *
 *  Plan mode is deliberately excluded: its checklist IS the draft plan and the
 *  mode's output contract says a new message must REVISE that plan. Sending
 *  "PRESERVE this checklist, do not create a new one" contradicted that
 *  contract, so the planner never emitted a revised `plan_card` and the todos
 *  never updated.
 */

interface ResumeMessageLike {
  plan?: Array<{ content: string; status: string }>;
  mode?: string;
}

export function buildResumeNote(
  messages: readonly ResumeMessageLike[],
  mode: string,
): string {
  if (mode === "plan") return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const plan = m.plan;
    if (plan && plan.length > 0 && (!m.mode || m.mode === mode)) {
      if (plan.every((t) => t.status === "completed")) return "";
      const lines = plan
        .map(
          (t) =>
            `- [${t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : " "}] ${t.content}`,
        )
        .join("\n");
      return `[SYSTEM: a task was interrupted mid-way in this chat. Its checklist currently is:\n${lines}\nIf this message continues that task, PRESERVE this exact checklist and mark progress via update_plan (same items, update statuses) — do not create a new one. If this message is a new, unrelated task, ignore this note.]`;
    }
  }
  return "";
}
