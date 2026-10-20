// Reply shaping for live voice: the ONE place that decides how an answer is
// phrased when it is going to be SPOKEN instead of read.
//
// Why this exists
// ---------------
// The agent normally writes for the eye: markdown, bullets, tables, code
// fences, paths, acronyms, numbers like "12" or "3.5s". A TTS engine reads
// that material literally — it announces asterisks, spells out paths
// character by character, reads "۱۲" as "one two" in the wrong language and
// switches language mid-sentence on a stray English term. The answer is
// technically correct and still unusable when heard.
//
// Two things make a spoken answer work:
//   1. ONE language, in its own script. Mixed scripts are the biggest source
//      of a Persian answer that suddenly reads like English.
//   2. Spoken syntax: short sentences, no lists, numbers written as words.
//
// This instruction is sent as a per-turn SUFFIX to the system prompt
// (AgentRequest::system_suffix) and only while live voice owns the turn, so
// typed chats are untouched and a chat's own custom prompt keeps working.

/** Marker the backend prompt carries; also what tests assert on. */
export const LIVE_VOICE_MARKER = 'VOICE REPLY MODE'

/** Everything the suffix says about one spoken language. */
export interface LiveSpeakLanguage {
  code: string
  /** Language name as written in the instruction (English, for the model). */
  name: string
  /** The script/single-language rule for this language. */
  rule: string
}

/**
 * Rules for the languages live voice is realistically used with.
 *
 * The Persian rule is deliberately strict: a Persian answer sprinkled with
 * English technical terms is exactly what sounds broken through TTS, and
 * "Pinglish" (Persian typed in Latin letters) is unreadable to a Persian
 * voice, not just ugly.
 */
const LANGUAGE_RULES: LiveSpeakLanguage[] = [
  {
    code: 'fa',
    name: 'Persian (Farsi)',
    rule:
      'Every word must be Persian and written in the Persian alphabet: no English, no Arabic, no transliteration (no "Pinglish") and no Latin letters at all — not for technical terms, file names, commands or product names. Say the Persian word for a concept instead of borrowing the English one, and write numbers as Persian words.',
  },
  {
    code: 'en',
    name: 'English',
    rule:
      'Every word must be English and written in the Latin alphabet: do not switch into another language for a term, and write numbers as words.',
  },
  {
    code: 'ar',
    name: 'Arabic',
    rule:
      'Every word must be Arabic in the Arabic script: no English words, no transliteration, no Latin letters, and write numbers as Arabic words.',
  },
  {
    code: 'de',
    name: 'German',
    rule:
      'Every word must be German: no English words or anglicisms where a German word exists, and write numbers as words.',
  },
  {
    code: 'fr',
    name: 'French',
    rule:
      'Every word must be French: no English words where a French word exists, and write numbers as words.',
  },
  {
    code: 'es',
    name: 'Spanish',
    rule:
      'Every word must be Spanish: no English words where a Spanish word exists, and write numbers as words.',
  },
  {
    code: 'it',
    name: 'Italian',
    rule:
      'Every word must be Italian: no English words where an Italian word exists, and write numbers as words.',
  },
  {
    code: 'pt',
    name: 'Portuguese',
    rule:
      'Every word must be Portuguese: no English words where a Portuguese word exists, and write numbers as words.',
  },
  {
    code: 'ru',
    name: 'Russian',
    rule:
      'Every word must be Russian in the Cyrillic alphabet: no Latin letters, no English words, and write numbers as words.',
  },
  {
    code: 'tr',
    name: 'Turkish',
    rule:
      'Every word must be Turkish: no English words where a Turkish word exists, and write numbers as words.',
  },
  {
    code: 'ur',
    name: 'Urdu',
    rule:
      'Every word must be Urdu in the Urdu script: no English words, no transliteration, no Latin letters, and write numbers as Urdu words.',
  },
  {
    code: 'hi',
    name: 'Hindi',
    rule:
      'Every word must be Hindi in the Devanagari script: no English words and no Latin letters, and write numbers as Hindi words.',
  },
]

const BY_CODE = new Map(LANGUAGE_RULES.map((l) => [l.code, l]))

/** True when the suffix text is the live-voice block (used by callers/tests). */
export function isLiveVoiceSuffix(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.includes(LIVE_VOICE_MARKER)
}

/**
 * Build the extra system instruction for one live-voice turn.
 *
 * `lang` is the STT language code (`resolveSttLanguage`), because the user
 * SPOKE in that language and must be answered in it. An unknown/empty code
 * still gets the voice rules — just without a per-language script rule, which
 * falls back to "stay in the language the user is speaking".
 */
export function buildLiveSpeakSuffix(lang: string): string {
  const code = (lang ?? '').trim().toLowerCase()
  const known = BY_CODE.get(code)
  const languageRule = known
    ? `- Language: reply in ${known.name} only. ${known.rule}`
    : '- Language: reply in the language the user is speaking, and stay in that one language and its script to the end of the answer.'
  return [
    `${LIVE_VOICE_MARKER}: this turn is SPOKEN aloud by a text-to-speech engine and the user will HEAR it, not read it. Write the answer for the ear:`,
    languageRule,
    '- Plain prose only: no markdown, no headings, no bullet or numbered lists, no tables, no code blocks, no emoji, no links, no file paths.',
    '- Short sentences, one idea each. No parentheses and no nested clauses. Two to four sentences unless the user asks for detail.',
    '- Write numbers, dates, times, units, percentages and symbols as words.',
    '- Never read code, commands, diffs or file contents aloud. Name them and offer to write them in the editor instead.',
    '- Start with the answer itself. No preamble such as "Sure" or "Here is what I found", and no closing question unless the user needs to decide something.',
  ].join('\n')
}
