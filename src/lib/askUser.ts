/**
 * Pure helpers for the multi-select `ask_user` choice cards.
 *
 * The backend only accepts one string answer per request
 * (`POST /ask/respond` with `{ id, answer }`), so when the user picks several
 * options we combine them into a single readable answer string. Both the
 * floating composer card and the inline transcript card share these helpers so
 * the reported answer stays consistent.
 */

/** Return a new selection set with `index` toggled in or out. */
export function toggleSelected(prev: number[], index: number, max = Infinity): number[] {
  const set = new Set(prev);
  if (set.has(index)) {
    set.delete(index);
  } else {
    if (! (prev.length < max)) return prev;
    set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

/** Combine the selected option labels and any free text into one sendable
 * answer. Option labels come first (one per line); free text sits last. */
export function joinAnswer(options: string[], selected: number[], freeText: string): string {
  const parts: string[] = [];
  for (const index of selected) {
    const label = options[index];
    if (typeof label === "string" && label.trim().length > 0) parts.push(label.trim());
  }
  const trimmedFree = freeText.trim();
  if (trimmedFree.length > 0) parts.push(trimmedFree);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.join("\n");
}

/** A card can be submitted when there is either free text or at least one
 * selected option with a non-empty label. */
export function canSubmit(options: string[], selected: number[], freeText: string): boolean {
  if (freeText.trim().length > 0) return true;
  return selected.some((index) => {
    const label = options[index];
    return typeof label === "string" && label.trim().length > 0;
  });
}

/** Coerce backend-provided option values into trimmed, non-empty strings. */
export function coerceOptions(rawOpts: unknown): string[] {
  const source: unknown[] = Array.isArray(rawOpts) ? rawOpts : [];
  return source
    .map((o: unknown) =>
      typeof o === "string"
        ? o
        : o == null
          ? ""
          : typeof o === "object"
            ? JSON.stringify(o)
            : String(o),
    )
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
}

/** Whether two option arrays agree (order-insensitive enough for matching). */
export function sameOptions(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((v, i) => v === y[i]);
}

/** Extract the reported answer from a completed `ask_user` result string such as
 *  "The user answered: choice A". Returns null when no answer is recorded. */
export function parseAnsweredText(resultText: string | undefined): string | null {
  if (typeof resultText !== "string") return null;
  const prefix = "The user answered:";
  if (!resultText.startsWith(prefix)) return null;
  const rest = resultText.slice(prefix.length).trim();
  return rest.length > 0 ? rest : null;
}

/** One facet of a multi-part ask card (mirrors types.AskSection without
 *  dragging the React types into the pure-helper module). */
export interface AskSectionLike {
  title: string;
  options: string[];
}

/** The labels picked inside one section, trimmed and blank-free. */
function sectionLabels(sec: AskSectionLike, selected: number[]): string[] {
  return selected
    .map((idx) => sec.options[idx])
    .filter((l: unknown): l is string => typeof l === "string" && l.trim().length > 0)
    .map((l) => l.trim());
}

/** The user's own answer for one section — only counted while its "write my
 *  own answer" box is ticked, mirroring the visibility of the text field. */
function sectionOwnAnswer(
  index: number,
  secOwn: boolean[] | undefined,
  secFreeText: string[] | undefined,
): string {
  if (!secOwn?.[index]) return "";
  return (secFreeText?.[index] ?? "").trim();
}

/** Combine every section's answer into the ONE sendable answer: one line per
 *  section, `Title: label` (labels joined with ", "). A section whose own
 *  answer box is ticked contributes its typed text too, so a section can be
 *  answered by picking options, by writing, or by both. Sections with nothing
 *  to say are skipped — canSubmitSections gates them before submit, this stays
 *  forgiving for partial state. */
export function joinSectionAnswer(
  sections: AskSectionLike[],
  secSelected: number[][],
  secOwn?: boolean[],
  secFreeText?: string[],
): string {
  const lines: string[] = [];
  sections.forEach((sec, i) => {
    const parts = sectionLabels(sec, secSelected[i] ?? []);
    const own = sectionOwnAnswer(i, secOwn, secFreeText);
    if (own.length > 0) parts.push(own);
    if (parts.length === 0) return;
    const title = sec.title.trim();
    lines.push(title.length > 0 ? `${title}: ${parts.join(", ")}` : parts.join(", "));
  });
  return lines.join("\n");
}

/** A multi-part card can submit only when EVERY section has an answer of its
 *  own — at least one picked option, or a non-empty typed answer ("answer all,
 *  send together"). */
export function canSubmitSections(
  sections: AskSectionLike[],
  secSelected: number[][],
  secOwn?: boolean[],
  secFreeText?: string[],
): boolean {
  if (sections.length === 0) return false;
  return sections.every((sec, i) => {
    if (sectionOwnAnswer(i, secOwn, secFreeText).length > 0) return true;
    return sectionLabels(sec, secSelected[i] ?? []).length > 0;
  });
}

/** Write `value` at `section` of a parallel per-section array, padding gaps
 *  with `pad` so a partially initialized request still toggles safely. */
export function setSectionAt<T>(prev: T[], section: number, value: T, pad: T): T[] {
  const next = [...prev];
  while (next.length <= section) next.push(pad);
  next[section] = value;
  return next;
}

/** Toggle one option inside one section's selection, returning the new
 *  per-section arrays (same semantics as toggleSelected, nested). */
export function toggleSectionSelected(
  prev: number[][],
  section: number,
  index: number,
): number[][] {
  const next = prev.map((arr) => [...arr]);
  while (next.length <= section) next.push([]);
  next[section] = toggleSelected(next[section] ?? [], index);
  return next;
}
