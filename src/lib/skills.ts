// Skill @mention extraction for the chat composer.
//
// A skill is referenced in a prompt with an `@` token. We support two token
// shapes:
//   1. The canonical slug, e.g. `@anthropic-frontend-design` — unambiguous, no
//      spaces, matched with a simple `@([\w-]+)` regex. This is what the picker
//      inserts and what users should type/paste.
//   2. A legacy display name with spaces, e.g. `@Anthropic Frontend Design` —
//      kept only for backward compatibility with text that was pasted before
//      the slug-based flow existed. Matching a multi-word name is inherently
//      fuzzy (where does the name end and the rest of the sentence begin?), so
//      it is only a fallback and the slug form is preferred.
//
// The backend resolves mentions by skill *name* (see graph._build_skills_section
// -> by_name keyed on s["name"].lower()), so we return the matched skill's
// display name, not the slug, and strip the @token from the prompt text.

import type { SkillRow } from "./api";

// Module-level skill list cache, shared between the chat composer (mention
// matching) and the settings panel (skill CRUD). Lives here — not in a React
// component — so it survives chat switches and can be invalidated from anywhere
// (e.g. right after a skill is saved in Settings) without prop-drilling.
//
// The actual backend fetch is injected (see setSkillsFetcher) rather than
// imported directly, so this module stays free of the Electron/window-bound
// `api` layer and remains trivially testable under plain Node.
let skillsCache: SkillRow[] | null = null;
let skillsFetcher: () => Promise<SkillRow[]> = async () => [];

/** Inject the function used to load the skill list (call once at startup). */
export function setSkillsFetcher(fn: () => Promise<SkillRow[]>): void {
  skillsFetcher = fn;
}

/** Synchronous read of the cached list (empty array until first load). */
export function getSkillsList(): SkillRow[] {
  return skillsCache ?? [];
}

/** Fetch the list from the backend if not already cached, then return it. */
export async function ensureSkillsList(): Promise<SkillRow[]> {
  if (skillsCache === null) skillsCache = await skillsFetcher();
  return skillsCache;
}

/** Drop the cache so the next read/ensure refetches from the backend. */
export function invalidateSkillsList(): void {
  skillsCache = null;
  void ensureSkillsList();
}

/** Test-only: reset the module cache between cases. */
export function resetSkillsCacheForTest(): void {
  skillsCache = null;
}

export interface SkillMention {
  /** Display name of the skill (what the backend resolves). */
  name: string
  /** Canonical slug of the skill. */
  slug: string
}

export interface ExtractResult {
  /** Display names of the matched skills (backend-facing). */
  skills: string[]
  /** Prompt with every @mention stripped out. */
  cleaned: string
}

const SLUG_RE = /(^|\s)@([\w-]+)/g

/**
 * Build a lookup from slug (and lowercased display name) to the skill, so a
 * mention token can be resolved regardless of which shape the user typed.
 */
function buildIndex(skills: SkillMention[]): Map<string, SkillMention> {
  const idx = new Map<string, SkillMention>()
  for (const s of skills) {
    if (s.slug) idx.set(s.slug.toLowerCase(), s)
    if (s.name) idx.set(s.name.toLowerCase(), s)
  }
  return idx
}

/**
 * Extract @skill mentions from `text` and return the matched skill display
 * names plus the prompt with those @mentions stripped.
 *
 * The stored transcript keeps the original text (with @mentions); only the
 * prompt sent to the model is cleaned.
 */
export function extractMentionSkills(
  text: string,
  skills: SkillMention[],
): ExtractResult {
  if (!skills.length) return { skills: [], cleaned: text }

  const idx = buildIndex(skills)
  const found = new Set<string>()
  let out = ""
  let last = 0
  let matchedAny = false

  // Pass 1: canonical slug tokens — unambiguous, greedy-free.
  SLUG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SLUG_RE.exec(text)) !== null) {
    const token = m[2]
    const skill = idx.get(token.toLowerCase())
    if (!skill) continue
    matchedAny = true
    found.add(skill.name)
    out += text.slice(last, m.index) // keep text before the "@"
    last = m.index + m[0].length // skip the "@token"
  }
  if (last > 0) out += text.slice(last)
  if (!matchedAny) out = text

  // Pass 2 (fallback): display names that contain spaces, e.g.
  // "@Anthropic Frontend Design". We try the longest known name first so a
  // substring name can't shadow a longer one.
  const spaced = skills
    .filter((s) => /\s/.test(s.name))
    .sort((a, b) => b.name.length - a.name.length)
  if (spaced.length) {
    // Re-scan the (already slug-cleaned) text for spaced display names.
    let out2 = ""
    let last2 = 0
    let i = 0
    while (i < out.length) {
      // Find the next "@" that begins a mention candidate.
      const at = out.indexOf("@", i)
      if (at === -1) {
        out2 += out.slice(i)
        break
      }
      out2 += out.slice(i, at)
      const rest = out.slice(at + 1)
      let best: SkillMention | null = null
      for (const s of spaced) {
        if (rest.toLowerCase().startsWith(s.name.toLowerCase())) {
          best = s
          break
        }
      }
      if (best) {
        matchedAny = true
        found.add(best.name)
        i = at + 1 + best.name.length // skip "@name"
      } else {
        out2 += "@"
        i = at + 1
      }
    }
    out = out2
  }

  return { skills: Array.from(found), cleaned: out }
}
