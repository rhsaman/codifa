import type { ChatUsage, ChatUsageEntry, ProviderConfig } from "../types";

/**
 * Migrate a chat's usage from the OLD keyed shape ("providerId/model" string
 * keys) to the NEW explicit-entry shape ({ providerId, model } fields).
 *
 * This is the ONLY place that ever parses a usage key — it runs once, on load,
 * for legacy data. New usage is written directly as explicit entries (see
 * store.ts `accrueChatUsage`), so the live path never guesses or parses.
 *
 * - A key with a real "providerId/" prefix → that provider + the rest as model.
 * - A bare key ("free") or a model-namespace key ("anthropic/claude-...") → the
 *   chat's own providerId (authoritative) + the whole key as the model. This
 *   guarantees legacy data shows under the provider that actually ran the chat,
 *   never under a misread model-namespace prefix.
 */
export function normalizeUsageEntry(
  raw: unknown,
  chatProviderId: string,
  providerIds: ReadonlyArray<string> = [],
): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  // Already in the new shape.
  if (Array.isArray((raw as ChatUsage).entries)) {
    return raw as ChatUsage;
  }
  const legacy = raw as Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; lastUsed?: number }>;
  const entries: ChatUsageEntry[] = [];
  for (const [key, v] of Object.entries(legacy)) {
    if (!v || typeof v !== "object") continue;
    const slash = key.indexOf("/");
    let providerId = chatProviderId;
    let model = key;
    if (slash > 0) {
      const prefix = key.slice(0, slash);
      // Only strip the prefix when it IS the chat's own provider id.  A
      // different prefix (e.g. "anthropic" in "anthropic/claude-…") is a model
      // namespace, not a provider routing hint — keep the full key as the model
      // name and the chat's own provider as providerId.
      if (prefix === chatProviderId) {
        model = key.slice(slash + 1);
      }
    }
    entries.push({
      providerId,
      model: normalizeUsageModel(providerId, model),
      input: v.input ?? 0,
      output: v.output ?? 0,
      cacheRead: v.cacheRead ?? 0,
      cacheWrite: v.cacheWrite ?? 0,
      lastUsed: v.lastUsed,
    });
  }
  return { entries };
}

/** Resolve the provider config for an explicit usage entry's providerId. */
export function providerForUsageEntry(
  entry: ChatUsageEntry,
  allProviders: ProviderConfig[],
): ProviderConfig | undefined {
  return allProviders.find((p) => p.id === entry.providerId);
}

/**
 * Normalize a model id so the SAME model (with/without a provider prefix) always
 * maps to ONE usage entry. The provider is already stored explicitly in
 * `providerId`, so strip any "providerId/" prefix from the model — but keep a
 * model namespace (e.g. "anthropic/claude-...") intact, since that is part of the
 * model name, not a provider routing prefix.
 */
export function normalizeUsageModel(providerId: string, model: string): string {
  const m = (model || "").trim() || "main";
  if (m.includes("/")) {
    const prefix = m.slice(0, m.indexOf("/"));
    if (prefix === providerId) return m.slice(m.indexOf("/") + 1);
  }
  return m;
}
