// Persian keywords for a freshly installed bundle, without being asked.
//
// Why it exists at all: a marketplace bundle ships English descriptions and the
// skill catalog is matched by KEYWORD, so a bundle landed unreachable from a
// Persian request until its owner opened the detail page and clicked Translate.
// The install paths call in here so a bundle is usable the moment it arrives.
//
// It reads the store directly (not a hook) because one of those paths is a chat
// command handler, which has no component to read selectors from.

import { useStore } from './store'
import { modelReasoning } from './context'
import { supportsReasoning } from './thinking'
import { fillMissingKeywords } from './plugins'
import type { KeywordFillResult } from './plugins'

/** Fill the missing keywords of `slug` with the provider settings in effect now.
 *
 *  The provider is the one a chat turn would use (the active one), NOT whichever
 *  happens to sit first: the translation is a real model call, so it must run on
 *  the model the user configured, and the backend walks that provider's fallback
 *  chain when it fails.
 *
 *  Fire-and-forget by design: the install has already succeeded, so a translation
 *  failure must not turn it into an error — the caller only adds the outcome to
 *  whatever it was going to report. */
export async function fillKeywordsAfterInstall(slug: string): Promise<KeywordFillResult> {
  const s = useStore.getState()
  const provider =
    s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
    s.settings.providers[0]
  if (!provider) return { filled: 0, total: 0, error: 'no model provider is configured' }
  return fillMissingKeywords(slug, {
    provider,
    subagentModels: s.subagentModels,
    subagentThinking: s.subagentThinking,
    toolFallbacks: s.toolFallbacks,
    providers: s.settings.providers,
    modelReasoning:
      modelReasoning(provider, provider.model) ?? supportsReasoning(provider.model, provider.kind),
  })
}

/** The `plugin` actions that WRITE a bundle and can therefore leave skills bare. */
const WRITE_ACTIONS = new Set(['create', 'update', 'install'])

/** The slug of the bundle a `plugin` tool reply describes.
 *
 *  The reply is the written record as JSON, optionally followed by a WARNING
 *  line (see `plugin_keyword_warning`), so only the first line is parsed. A reply
 *  that is not that JSON — `list`, or an error — has no slug to return. */
export function pluginSlugFromReply(text: string): string | null {
  const nl = text.indexOf('\n')
  const line = nl === -1 ? text : text.slice(0, nl)
  try {
    const parsed = JSON.parse(line) as { slug?: unknown }
    return typeof parsed.slug === 'string' && parsed.slug ? parsed.slug : null
  } catch {
    return null
  }
}

/** Fill the bundle the AGENT just wrote, from the tool call that wrote it.
 *
 *  `/plugin install` and the marketplace fill on their own paths, but a bundle
 *  the model builds itself — `/plugin create` hands exactly that job to the agent
 *  — lands through NO handler: it is only a tool result in the stream. Reading
 *  the slug off that reply is what makes a bundle made in chat as triggerable as
 *  one installed from a browser.
 *
 *  Returns null when the call wrote nothing, so the caller stays silent. */
export async function fillKeywordsFromToolResult(
  action: string,
  resultText: string | undefined,
): Promise<KeywordFillResult | null> {
  if (!WRITE_ACTIONS.has(action) || !resultText) return null
  const slug = pluginSlugFromReply(resultText)
  if (!slug) return null
  // One bundle is filled ONCE per turn: a create followed by an update of the
  // same slug would otherwise translate the same descriptions twice — two model
  // calls for one result. The slug leaves the set when its fill settles, so a
  // later turn can still top it up.
  if (inFlight.has(slug)) return null
  inFlight.add(slug)
  try {
    return await fillKeywordsAfterInstall(slug)
  } finally {
    inFlight.delete(slug)
  }
}

/** Bundles whose keywords are being filled right now (see above). */
const inFlight = new Set<string>()
