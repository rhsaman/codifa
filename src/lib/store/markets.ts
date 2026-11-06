import type { MarketplaceSource, Settings } from '../../types'
// Extracted verbatim from store.ts (pure helpers, no store access).


/** The shipped catalogues every install starts with.
 *
 *  All use the same `marketplace.json` format `repo.rs` reads natively, so a
 *  fresh install can browse and install without knowing any URL. Removing any
 *  of them from Settings is remembered — see the hydrate branch.
 *
 *  The Anthropic plugin directory is deliberately NOT shipped any more: it was
 *  the one default a v1 file always had, so an install no longer opens on
 *  someone else's catalogue. Files that still carry it drop it once, through
 *  `RETIRED_MARKETPLACES` in `marketplaceDefaults`. */

/** The well-known SKILLS index: Anthropic's own example skills repo. */
export const ANTROPIC_SKILLS_MARKETPLACE: MarketplaceSource = {
  repo: 'anthropics/skills',
  label: 'Anthropic skills',
  kind: 'skills',
}

/** The well-known MCP/community index: every entry carries connectors. */
export const COMMUNITY_MARKETPLACE: MarketplaceSource = {
  repo: 'anthropics/claude-plugins-community',
  label: 'Community',
  kind: 'mcp',
}

/** The best-known community plugin marketplace (Jesse Vincent's superpowers
 *  and friends) — a `.claude-plugin/marketplace.json` at the repo root. */
export const SUPERPOWERS_MARKETPLACE: MarketplaceSource = {
  repo: 'obra/superpowers-marketplace',
  label: 'Superpowers',
  kind: 'plugins',
}

/** The most-subscribed agent/skill collection on GitHub (94 plugin rows). */
export const AGENTS_MARKETPLACE: MarketplaceSource = {
  repo: 'wshobson/agents',
  label: 'Claude agents',
  kind: 'skills',
}

/** Every shipped default, in tab order. */
export const DEFAULT_MARKETPLACES: MarketplaceSource[] = [
  ANTROPIC_SKILLS_MARKETPLACE,
  COMMUNITY_MARKETPLACE,
  SUPERPOWERS_MARKETPLACE,
  AGENTS_MARKETPLACE,
]

/** Which generation of the shipped defaults a settings file last saw.
 *
 *  A file on this version keeps the user's list untouched (an intentional
 *  removal stays removed); an OLDER one gets the shipped indexes it does not
 *  name yet, once.
 *
 *  4 retired the Anthropic plugin directory: files that still carry it lose it
 *  (see `mergeShippedMarketplaces`), which is the one edit a current file gets.
 *  5 adds the two well-known community marketplaces (Superpowers and the
 *  claude-code-workflows agent collection) to every file that predates it. */
export const MARKETPLACE_DEFAULTS_VERSION = 5

// Cap on persisted base64 image payloads so one pasted screenshot (often
// 1-5MB as data:image/...;base64) doesn't bloat every chats snapshot +
// heartbeat IPC payload. Only applies to the persisted copy in sanitizeChats;
// in-memory messages keep the full data URL for render + model context.
