import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import {
  formatTokens,
  formatCost,
  priceForModel,
  computeUsageCost,
  computeUsageCostBreakdown,
} from "../lib/context";
import type { ChatUsage, ProviderConfig } from "../types";

/** One model row inside a provider group (session totals for this chat). */
export interface UsageModelRow {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  costFresh: number | null;
  costCached: number | null;
  lastUsed: number;
}

/** One provider group: its models sorted heaviest-first, plus group totals. */
export interface UsageGroupRow {
  providerId: string;
  name: string;
  entries: UsageModelRow[];
  tokens: number;
  cached: number;
  fresh: number;
  cost: number | null;
  costFresh: number | null;
  costCached: number | null;
}

/** Full view-model for the usage popover: groups + grand totals. */
export interface UsageView {
  groups: UsageGroupRow[];
  totalTokens: number;
  totalCached: number;
  totalFresh: number;
  totalCost: number | null;
  totalCostFresh: number | null;
  totalCostCached: number | null;
}

/**
 * Per-model token usage + cost for the active chat (session totals), grouped
 * by provider and sorted heaviest-first — the same semantics the old sidebar
 * "Model usage" panel had, extracted as a pure function so it is testable
 * without mounting any component.
 *
 * - Entries with all-zero token fields are dropped (but cache-only entries
 *   with input=0/output=0 and cacheRead/cacheWrite>0 are KEPT, so the cached
 *   portion is never silently dropped from the totals).
 * - providerId + model are stored explicitly on each entry — no key parsing.
 *   Legacy chats are migrated to this shape on load (normalizeUsageEntry).
 * - Cost bills cache-read/cache-write at their own (cheaper) rate when the
 *   provider advertises one; `null` when no price is known (rendered "—").
 */
export function buildUsageView(
  usage: ChatUsage | undefined,
  allProviders: ProviderConfig[],
): UsageView {
  const byProvider = new Map<string, UsageModelRow[]>();
  if (usage) {
    for (const u of usage.entries) {
      if (
        (u.input || 0) +
        (u.output || 0) +
        (u.cacheRead || 0) +
        (u.cacheWrite || 0) <=
        0
      )
        continue;
      const p = allProviders.find((x) => x.id === u.providerId) ?? null;
      const price = priceForModel(p?.pricingMap, u.model);
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const breakdown = computeUsageCostBreakdown(price, {
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
      });
      const cost =
        breakdown?.total ??
        computeUsageCost(price, {
          input: u.input,
          output: u.output,
          cacheRead,
          cacheWrite,
        });
      const row: UsageModelRow = {
        model: u.model,
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
        cost,
        costFresh: breakdown?.fresh ?? null,
        costCached: breakdown?.cached ?? null,
        lastUsed: u.lastUsed ?? 0,
      };
      const list = byProvider.get(u.providerId);
      if (list) list.push(row);
      else byProvider.set(u.providerId, [row]);
    }
  }
  // Sort each provider group by total usage (heaviest first); ties by most
  // recently used so the freshest model wins when token counts are equal.
  for (const entries of byProvider.values()) {
    entries.sort((a, b) => {
      const d = b.input + b.output - (a.input + a.output);
      if (d !== 0) return d;
      return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
    });
  }
  // Provider groups ordered by total usage (the biggest consumer on top);
  // ties by the group's most recently used model.
  const ordered = [...byProvider.entries()].sort((a, b) => {
    const aTotal = a[1].reduce((s, e) => s + e.input + e.output, 0);
    const bTotal = b[1].reduce((s, e) => s + e.input + e.output, 0);
    if (aTotal !== bTotal) return bTotal - aTotal;
    const aLast = Math.max(...a[1].map((e) => e.lastUsed ?? 0), 0);
    const bLast = Math.max(...b[1].map((e) => e.lastUsed ?? 0), 0);
    return bLast - aLast;
  });
  // Fold each provider into a group row with its own totals.
  const groups: UsageGroupRow[] = ordered.map(([pid, entries]) => {
    const tokens = entries.reduce((s, e) => s + e.input + e.output, 0);
    const cached = entries.reduce((s, e) => s + e.cacheRead + e.cacheWrite, 0);
    const foldCost = (
      pick: (e: UsageModelRow) => number | null,
    ): number | null => {
      let acc: number | null = null;
      for (const e of entries) {
        const v = pick(e);
        if (v !== null) acc = (acc ?? 0) + v;
      }
      return acc;
    };
    return {
      providerId: pid,
      name: allProviders.find((p) => p.id === pid)?.name ?? pid,
      entries,
      tokens,
      cached,
      fresh: Math.max(0, tokens - cached),
      cost: foldCost((e) => e.cost),
      costFresh: foldCost((e) => e.costFresh),
      costCached: foldCost((e) => e.costCached),
    };
  });
  // Grand totals across every provider group.
  let totalTokens = 0;
  let totalCached = 0;
  let totalCost: number | null = null;
  let totalCostFresh: number | null = null;
  let totalCostCached: number | null = null;
  for (const g of groups) {
    totalTokens += g.tokens;
    totalCached += g.cached;
    if (g.cost !== null) totalCost = (totalCost ?? 0) + g.cost;
    if (g.costFresh !== null)
      totalCostFresh = (totalCostFresh ?? 0) + g.costFresh;
    if (g.costCached !== null)
      totalCostCached = (totalCostCached ?? 0) + g.costCached;
  }
  return {
    groups,
    totalTokens,
    totalCached,
    totalFresh: Math.max(0, totalTokens - totalCached),
    totalCost,
    totalCostFresh,
    totalCostCached,
  };
}

/** Tooltip text for a fresh/cached split, e.g. "Fresh: 1.2K · Cached: 300". */
function splitTooltip(
  fresh: number,
  cached: number,
  costFresh: number | null,
  costCached: number | null,
): string {
  return [
    fresh > 0
      ? `Fresh (non-cached): ${formatTokens(fresh)} tokens${costFresh !== null ? ` · ${formatCost(costFresh)}` : ""}`
      : "",
    cached > 0
      ? `Cached: ${formatTokens(cached)} tokens${costCached !== null ? ` · ${formatCost(costCached)}` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface UsagePopoverProps {
  view: UsageView;
}

/**
 * The hover popover: one section per provider with a per-model table (model,
 * tokens with 🔥/⚡ breakdown, cost). Pure presentational so it renders under SSR
 * with a seeded view — no store access. The reset button lives inside the
 * titlebar chip pill (see UsageChip), not here.
 */
function UsagePopoverImpl({ view }: UsagePopoverProps) {
  return (
    <div
      className="usage-popover"
      dir="ltr"
      role="dialog"
      aria-label="Token usage details"
    >
      <div className="usage-groups">
        {view.groups.map((g) => (
          <div
            key={g.providerId}
            className="usage-group"
            data-provider={g.providerId}
          >
            <div
              className="usage-group-head"
              title={splitTooltip(g.fresh, g.cached, g.costFresh, g.costCached)}
            >
              <span className="usage-group-dot" aria-hidden />
              <span className="usage-group-name">{g.name}</span>
              <span className="usage-group-total">
                {formatTokens(g.tokens)}
                {g.cached > 0 && (
                  <span className="usage-cache">
                    {" "}
                    ·
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 26 26"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                    </svg>
                    {formatTokens(g.cached)}
                  </span>
                )}
                {g.cost !== null && (
                  <span className="usage-cost"> · {formatCost(g.cost)}</span>
                )}
              </span>
            </div>
            <ul className="usage-list">
              <li className="usage-row usage-row-head" aria-hidden>
                <span>Model</span>
                <span>Tokens</span>
                <span>Cost</span>
              </li>
              {g.entries.map((e) => {
                const cached = e.cacheRead + e.cacheWrite;
                const total = e.input + e.output;
                const fresh = Math.max(0, total - cached);
                const itemTitle = splitTooltip(
                  fresh,
                  cached,
                  e.costFresh,
                  e.costCached,
                );
                return (
                  <li key={e.model} className="usage-row">
                    <span className="usage-model" title={e.model}>
                      {e.model ? e.model.split("/").pop() : "main"}
                    </span>
                    <span
                      className="usage-tokens"
                      title={itemTitle || undefined}
                    >
                      {formatTokens(total)}
                      {cached > 0 && (
                        <span className="usage-breakdown">
                          <span className="usage-fresh">
                            🔥 {formatTokens(fresh)}
                          </span>
                          <span className="usage-cache">
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 26 26"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                            </svg>
                            {formatTokens(cached)}
                          </span>
                        </span>
                      )}
                    </span>
                    <span
                      className={`usage-cost${e.cost === null ? " no-price" : ""}`}
                      title={itemTitle || undefined}
                    >
                      {e.cost !== null ? formatCost(e.cost) : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export const UsagePopover = memo(UsagePopoverImpl);

/**
 * Titlebar chip: ONE pill holding the chat's grand total, the cached portion
 * and the reset button; hovering (or keyboard focus) opens the details
 * popover. Hidden entirely while the active chat has no usage yet — same rule
 * the old sidebar panel had.
 */
export function UsageChip() {
  const activeChatId = useStore((s) => s.activeChatId);
  // Subscribe to the active chat's `usage` object by reference. `updateMessage`
  // leaves `usage` untouched on per-token content deltas (it only rewrites
  // `content`), so this reference is stable across the whole stream — meaning
  // the expensive usage computation below does NOT re-run on every token. It
  // only changes when `accrueChatUsage` rebuilds the entries array (turn end).
  const activeUsage = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.usage,
  );
  const allProviders = useStore((s) => s.settings.providers);
  const view = useMemo(
    () => buildUsageView(activeUsage, allProviders),
    [activeUsage, allProviders],
  );

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    // Small delay so moving the pointer from the chip to the popover (which
    // sits a few px below it) doesn't close it mid-flight.
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };
  const openNow = () => {
    cancelClose();
    setOpen(true);
  };
  useEffect(() => cancelClose, []);

  if (view.groups.length === 0) return null;

  return (
    <div
      className="usage-chip"
      dir="ltr"
      role="button"
      tabIndex={0}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={`Total chat tokens: ${formatTokens(view.totalTokens)}${view.totalCached > 0 ? ` · cached: ${formatTokens(view.totalCached)}` : ""}`}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={scheduleClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <span className="usage-chip-count">{formatTokens(view.totalTokens)}</span>
      {view.totalCached > 0 && (
        <span className="usage-chip-cached">
          <svg
            width="13"
            height="13"
            viewBox="0 0 26 26"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
          </svg>
          {formatTokens(view.totalCached)}
        </span>
      )}
      <span className="usage-chip-sep" aria-hidden />
      <button
        type="button"
        className="usage-reset"
        title="Reset all model usage to zero"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (
            window.confirm(
              "Reset token usage and cost for all models in this chat?",
            )
          ) {
            useStore.getState().resetChatUsage(activeChatId);
          }
        }}
      >
        ↺
      </button>
      {open && <UsagePopover view={view} />}
    </div>
  );
}
