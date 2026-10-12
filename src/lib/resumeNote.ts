/** The SYSTEM note appended to a follow-up prompt when the same mode has an
 *  unfinished checklist from an earlier turn, so the model continues ticking
 *  the existing items instead of re-planning from scratch. Returns "" when no
 *  note applies.
 *
 *  Merged across ALL same-mode messages (union by normalized content, latest
 *  status wins, completed never reverts): the model sometimes re-ticks a
 *  narrowed single-item list, and taking only the most recent message's plan
 *  silently dropped the other open steps — the todo-forget/redo bug.
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

function normKey(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(" ").slice(0, 200);
}

function normStatus(s: unknown): string {
  const v = String(s ?? "pending").trim().toLowerCase();
  return v === "pending" || v === "in_progress" || v === "completed"
    ? v
    : "pending";
}

export function buildResumeNote(
  messages: readonly ResumeMessageLike[],
  mode: string,
): string {
  if (mode === "plan") return "";
  const merged: Array<{ content: string; status: string }> = [];
  const byKey = new Map<string, number>();
  for (const m of messages) {
    const plan = m.plan;
    if (!plan || plan.length === 0) continue;
    if (m.mode && m.mode !== mode) continue;
    for (const t of plan) {
      const content = String(t?.content ?? "").trim();
      if (!content) continue;
      const status = normStatus(t?.status);
      const key = normKey(content);
      const idx = byKey.get(key);
      if (idx === undefined) {
        byKey.set(key, merged.length);
        merged.push({ content: content.slice(0, 200), status });
      } else {
        const prev = merged[idx];
        if (prev.status === "completed") continue;
        prev.content = content.slice(0, 200);
        prev.status = status;
      }
    }
  }
  if (merged.length === 0) return "";
  if (merged.every((t) => t.status === "completed")) return "";
  const lines = merged
    .map(
      (t) =>
        `- [${t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : " "}] ${t.content}`,
    )
    .join("\n");
  return `[SYSTEM: a task was interrupted mid-way in this chat. Its checklist currently is:\n${lines}\nIf this message continues that task, PRESERVE this exact checklist and mark progress via update_plan (same items, update statuses) — do not create a new one. If this message is a new, unrelated task, ignore this note.]`;
}
