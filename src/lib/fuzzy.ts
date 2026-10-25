// Fuzzy matching shared by the list filters and the "did you mean?" hints.
//
// Pure: no React and no store, so the composer palette, the file picker and the
// typo suggestion all score a query the same way. The scoring itself used to
// live privately inside SearchOverlay, where nothing else could reach it, while
// every other filter did a plain `includes` — so a half-typed or slightly
// misspelled word matched nothing at all.

/** Fold a Persian/Arabic phrase for COMPARISON only.
 *
 *  Raw byte matching fails on the spelling differences that are invisible to
 *  the user: the Arabic yeh/kaf (`ي`, `ك`) look identical to the Persian ones,
 *  a zero-width non-joiner splits `نیم‌فاصله` in two, and a harakat changes the
 *  byte sequence without changing the word. Folding them means a query typed on
 *  an Arabic layout still finds a keyword written in Persian. */
export function foldFa(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    switch (ch) {
      case 'ي':
        out += 'ی'
        break
      case 'ك':
        out += 'ک'
        break
      case 'ة':
      case 'ۀ':
        out += 'ه'
        break
      case 'أ':
      case 'إ':
      case 'آ':
      case 'ٱ':
        out += 'ا'
        break
      case 'ؤ':
        out += 'و'
        break
      case 'ئ':
        out += 'ی'
        break
      default:
        // ZWNJ and the Arabic diacritics carry no identity for matching.
        if (ch === '\u200c' || ch === '\u200d') continue
        if (ch >= '\u064b' && ch <= '\u0652') continue
        if (ch === '\u0670' || ch === '\u0640') continue
        out += ch
    }
  }
  return out
}

/** Subsequence score of `pattern` inside `text`; 0 means "no match".
 *
 *  Consecutive characters and a match near the start score higher, so typing
 *  the beginning of a name ranks it above a scattered coincidence. */
export function fuzzyScore(pattern: string, text: string): number {
  const p = foldFa(pattern).trim()
  if (!p) return 0
  const t = foldFa(text)
  if (!t) return 0
  let score = 0
  let prev = -1
  for (const ch of p) {
    const idx = t.indexOf(ch, prev + 1)
    if (idx === -1) return 0
    if (prev === -1) score += idx === 0 ? 6 : 3
    else score += idx === prev + 1 ? 8 : 2
    prev = idx
  }
  // A prefix hit is a much stronger signal than the same letters scattered.
  return t.startsWith(p) ? score + 12 : score
}

/** Items whose key matches `query`, best first. An empty query keeps the order. */
export function rankMatches<T>(items: T[], query: string, key: (item: T) => string): T[] {
  const q = query.trim()
  if (!q) return items
  return items
    .map((item, order) => {
      const sub = fuzzyScore(q, key(item))
      // The subsequence scorer is blind to a SWAPPED pair (`updtae` has every
      // letter of `update`, in the wrong place), so a typo emptied the menu.
      // The edit-distance score is the second signal, held to a high bar so it
      // cannot drag in an unrelated row.
      const sim = nearMiss(q, key(item))
      return { item, order, score: Math.max(sub, sim * 10), matches: sub > 0 || sim >= NEAR_MISS }
    })
    .filter((row) => row.matches)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((row) => row.item)
}

/** Closeness a candidate needs before a near-miss signal counts as a match.
 *
 *  Shared by `rankMatches` and `didYouMean` so the menu and the "did you mean?"
 *  banner can never disagree about what counts as a typo. */
export const NEAR_MISS = 0.6

/** Similarity of two words in [0,1], tolerant of typos and TRANSPOSITIONS.
 *
 *  The subsequence scorer above cannot see `plugni` in `plugin` (the two
 *  letters are present but out of order), and a swapped pair is the most common
 *  typo there is. A bigram Dice coefficient was tried first but scored `updtae`
 *  at 0.4 — under any threshold that keeps noise out — so the metric is the
 *  normalized Damerau-Levenshtein distance, which prices a swap as ONE edit:
 *  `plugni`/`plugin` and `updtae`/`update` both land near 0.83. */
export function similarity(a: string, b: string): number {
  const x = foldFa(a).replace(/\s+/g, '')
  const y = foldFa(b).replace(/\s+/g, '')
  if (!x || !y) return 0
  if (x === y) return 1
  // Three rows of the DP table are enough: the transposition case looks back
  // two characters, so only `i-2` is still needed.
  let prev2: number[] = new Array(y.length + 1)
  let prev: number[] = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur: number[] = new Array(y.length + 1)
    cur[0] = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
        best = Math.min(best, prev2[j - 2] + 1)
      cur[j] = best
    }
    prev2 = prev
    prev = cur
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length)
}

/** How close `query` is to a candidate NAME, in [0,1].
 *
 *  A name is usually several words joined by a separator (`note-taker`,
 *  `owner/notes`, `summarize-logs`), and a typo inside ONE of those words is a
 *  near miss for the whole name only if the words are compared on their own:
 *  `ntoe` scores 0.30 against `note-taker` but 0.75 against its `note` part.
 *  Every separator the app uses (dash, dot, slash, underscore, space) splits the
 *  candidate, and the best part decides. */
export function nearMiss(query: string, candidate: string): number {
  const best = similarity(query, candidate)
  const parts = candidate.split(/[-_./\s]+/).filter(Boolean)
  let out = best
  for (const part of parts) {
    const s = similarity(query, part)
    if (s > out) out = s
  }
  return out
}

/** The closest candidates to a word the user got wrong, best first.
 *
 *  Used by the composer's "Unknown command" banner: without it a typo only
 *  produced an error and the user had to open `/help` to find the spelling. */
export function didYouMean(word: string, candidates: string[], max = 3): string[] {
  const q = foldFa(word).trim()
  if (!q) return []
  return candidates
    .map((c, order) => {
      const sub = fuzzyScore(q, c)
      // Either signal is enough on its own; the edit-distance score is what
      // catches a swapped pair, the subsequence score what catches a
      // distant-but-ordered abbreviation (`plgn` -> `plugin`).
      const sim = nearMiss(q, c)
      return { c, order, score: Math.max(sub, sim * 10), matches: sub > 0 || sim >= NEAR_MISS }
    })
    .filter((row) => row.matches)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((row) => row.c)
}
