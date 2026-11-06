// Ranking for `/plugin search`: match a free-form request against the rows of
// every marketplace the user subscribes to.
//
// Pure (no React, no store, no fetch), so the command's ranking can be tested
// in plain node and the model prompt is built from a deterministic shortlist
// instead of whatever order the indexes happened to arrive in.

import { foldFa, nearMiss } from './fuzzy'
import { marketKey, type MarketplaceEntry } from './plugins'

/** One marketplace row plus the catalogue it came from. */
export interface MarketplaceHit {
  entry: MarketplaceEntry
  /** The marketplace's display name, so a recommendation can say where it
   *  came from when two catalogues list the same repo. */
  marketplace: string
  score: number
}

/** Persian request words mapped to the English vocabulary marketplace indexes
 *  actually use. Without this a Persian `/plugin search استقرار` scored every
 *  row zero and the model was handed an arbitrary list. */
const TERM_EXPANSIONS: Record<string, string[]> = {
  امنیت: ['security', 'audit', 'vulnerability'],
  تست: ['test', 'testing', 'qa'],
  دیتابیس: ['database', 'sql', 'postgres', 'sqlite'],
  پایگاه: ['database'],
  داده: ['data', 'database'],
  داکر: ['docker', 'container'],
  کانتینر: ['container', 'docker', 'kubernetes'],
  کوبرنتیز: ['kubernetes', 'k8s', 'helm'],
  استقرار: ['deploy', 'deployment', 'release'],
  داپلوی: ['deploy', 'deployment'],
  طراحی: ['design', 'ui', 'ux', 'frontend'],
  دیزاین: ['design', 'ui', 'ux'],
  رابط: ['ui', 'interface', 'frontend'],
  فرانت: ['frontend', 'react', 'css'],
  بکاند: ['backend', 'api', 'server'],
  مستندات: ['documentation', 'docs', 'readme'],
  مستند: ['document', 'docs', 'documentation'],
  گزارش: ['report', 'reporting', 'analytics'],
  تحلیل: ['analysis', 'analytics', 'data'],
  تصویر: ['image', 'picture', 'vision'],
  ویدیو: ['video', 'media'],
  صدا: ['audio', 'voice', 'speech'],
  گفتار: ['speech', 'voice', 'tts'],
  ترجمه: ['translation', 'translate'],
  ایمیل: ['email', 'mail', 'smtp'],
  پیام: ['message', 'messaging', 'chat'],
  پیامرسان: ['messaging', 'chat', 'slack', 'telegram'],
  فروشگاه: ['shop', 'store', 'ecommerce'],
  پرداخت: ['payment', 'billing', 'stripe'],
  مالی: ['finance', 'trading', 'money'],
  ترید: ['trading', 'trade', 'market'],
  هوش: ['ai', 'llm', 'agent'],
  عامل: ['agent', 'ai'],
  خودکار: ['automation', 'automate', 'workflow'],
  اتوماسیون: ['automation', 'workflow'],
  مرورگر: ['browser', 'playwright', 'web'],
  وب: ['web', 'browser', 'http'],
  فایل: ['file', 'filesystem', 'storage'],
  ذخیره: ['storage', 'save', 'persist'],
  جستجو: ['search', 'query'],
  نقشه: ['map', 'location', 'geo'],
  تقویم: ['calendar', 'schedule', 'date'],
  زمانبندی: ['schedule', 'cron', 'task'],
  یادگیری: ['learning', 'learn', 'tutorial'],
  آموزش: ['education', 'learning', 'tutorial'],
}

/** Folded request words, with a Persian term's English equivalents added. */
function queryTerms(prompt: string): string[] {
  const raw = foldFa(prompt)
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
  const out: string[] = []
  for (const word of raw) {
    if (!out.includes(word)) out.push(word)
    for (const expanded of TERM_EXPANSIONS[word] ?? []) {
      if (!out.includes(expanded)) out.push(expanded)
    }
  }
  return out
}

/** How strongly one row answers the request. 0 means no signal at all. */
function scoreEntry(entry: MarketplaceEntry, terms: string[], phrase: string): number {
  const name = foldFa(entry.name)
  const description = foldFa(entry.description ?? '')
  const category = foldFa(entry.category ?? '')
  const author = foldFa(entry.author ?? '')
  let score = 0
  if (phrase && name.includes(phrase)) score += 20
  if (phrase && description.includes(phrase)) score += 8
  for (const term of terms) {
    if (name.includes(term)) score += 12
    if (category.includes(term)) score += 7
    if (description.includes(term)) score += 4
    if (author.includes(term)) score += 1
    // A typo in a name is still a real hit (`kubenetes`); descriptions are
    // prose, so the fuzzy bar there stays high enough not to match noise.
    if (nearMiss(term, entry.name) >= 0.6) score += 6
    if (nearMiss(term, entry.description ?? '') >= 0.75) score += 2
  }
  return score
}

/** Rank rows from every marketplace, best first, deduped by install address.
 *
 *  When nothing scores, the first `max` rows are returned rather than an empty
 *  list: `/plugin search` hands this shortlist to the model, which can still
 *  recognise a fit from the descriptions even when the local keyword match was
 *  blind (a Persian request against English prose, most often). Callers that
 *  want to report "no match" check `score === 0` on the returned rows.
 */
export function rankMarketplaceHits(
  hits: MarketplaceHit[],
  prompt: string,
  max = 12,
): MarketplaceHit[] {
  const phrase = foldFa(prompt).trim()
  const terms = queryTerms(prompt)
  const seen = new Set<string>()
  const scored: MarketplaceHit[] = []
  for (const hit of hits) {
    const key = marketKey(hit.entry.repo, hit.entry.repo_path, hit.entry.repo_ref)
    if (seen.has(key)) continue
    seen.add(key)
    scored.push({ ...hit, score: scoreEntry(hit.entry, terms, phrase) })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.name.localeCompare(b.entry.name) ||
      a.marketplace.localeCompare(b.marketplace),
  )
  const matched = scored.filter((h) => h.score > 0)
  return (matched.length > 0 ? matched : scored).slice(0, Math.max(1, max))
}

/** The compact text the model reads for one candidate. */
export function describeMarketplaceHit(hit: MarketplaceHit): string {
  const address = [hit.entry.repo, hit.entry.repo_path, hit.entry.repo_ref]
    .filter(Boolean)
    .join(' ')
  const category = hit.entry.category ? ` · category: ${hit.entry.category}` : ''
  return (
    `- ${hit.entry.name} (${hit.marketplace}) — ${hit.entry.description || 'no description'}${category}\n` +
    `  install: /plugin install ${address}`
  )
}
