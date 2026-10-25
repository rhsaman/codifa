// The rules that keep the shipped marketplaces in sync with a settings file.
//
// Its own module, importing nothing but a type, so both the store's hydrate and
// the Settings tab can be tested in plain node — this is the difference between
// an existing install seeing the Skills and MCP tabs and staring at two empty
// ones with nowhere to click.
import type { MarketplaceSource } from '../types.ts'

/** Identity of a marketplace: the address an install would repeat. */
export function marketSourceKey(m: MarketplaceSource): string {
  return `${m.repo}\u0000${m.path ?? ''}\u0000${m.git_ref ?? ''}`
}

/** Catalogues that used to ship and must never come back.
 *
 *  The Anthropic plugin directory was the default every install opened on, so
 *  a settings file written back then still names it. It is not shipped any
 *  more, and such a file loses it once. Keyed by ADDRESS, never by label — the
 *  label is the user's to rename.
 */
const RETIRED_MARKETPLACES: readonly string[] = ['anthropics/claude-plugins-official']

/** Strip the retired catalogues.
 *
 *  Unconditional, so a file ALREADY on the current defaults version still loses
 *  a default that no longer ships: the version gate below only guards what gets
 *  ADDED, not what is withdrawn.
 */
function dropRetired(rows: MarketplaceSource[]): MarketplaceSource[] {
  const gone = new Set(RETIRED_MARKETPLACES)
  return rows.filter((m) => {
    // The ADDRESS must match exactly: the same repo browsed at a sub-folder or a
    // pinned ref is a different install address, so it is not the default that
    // was retired.
    if (m.path || m.git_ref) return true
    return !gone.has(m.repo.trim().toLowerCase())
  })
}

/** Merge the shipped catalogues into a file's marketplace list.
 *
 *  A file already on the CURRENT defaults version keeps the user's list
 *  untouched — an intentional removal stays removed (the retirement above is
 *  the only thing that still edits it). An OLDER file additionally gets every
 *  shipped index it does not name yet, once: that is what makes a newly added
 *  skills or MCP index appear for an install that predates it.
 */
export function mergeShippedMarketplaces(
  rows: MarketplaceSource[],
  shipped: MarketplaceSource[],
  fileVersion: number,
  currentVersion: number,
): MarketplaceSource[] {
  const kept = dropRetired(rows)
  if (fileVersion >= currentVersion) return kept
  // `shipped` is filtered too: a caller that still passes the retired entry in
  // its default list must not have it re-added here.
  const fresh = dropRetired(shipped)
  const have = new Set(kept.map(marketSourceKey))
  const missing = fresh.filter((m) => !have.has(marketSourceKey(m)))
  return missing.length === 0 ? kept : [...kept, ...missing]
}
