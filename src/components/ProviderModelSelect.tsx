import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderConfig } from "../types";
import { useStore } from "../lib/store";
import { fetchModels } from "../lib/api";
import { PROVIDER_META } from "../lib/provider-meta";

/** Strip a redundant "providerId/" prefix from a model id (a model can get
 *  persisted with it, e.g. "openrouter/free"), so it is never shown or stored
 *  doubled as "openrouter/openrouter/free". */
function bareModel(p: ProviderConfig, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
}

/** Display label for a model, e.g. "openrouter/gpt-5". Kinds that use
 *  unprefixed ids (opencode) are shown bare. */
function modelLabel(p: ProviderConfig, m: string): string {
  return PROVIDER_META[p.kind]?.unprefixedModelId ? m : `${p.id}/${m}`;
}

function providerSig(p: ProviderConfig): string {
  return [
    p.id, p.kind, p.baseUrl, p.apiKey, p.envVar,
    p.authType, p.oauthClientId, p.oauthClientSecret, p.oauthRefreshToken,
  ].join("|");
}

// Live model lists fetched from each provider's /models endpoint, cached for
// the session so reopening the picker doesn't refetch unchanged providers.
const LIVE_CACHE = new Map<string, string[]>();

/** Compact provider + model picker shown in the composer. Models are fetched
 *  live from each provider's /models endpoint (never hardcoded) and persisted
 *  to the DB per provider; custom models added in Settings are shown from the
 *  DB. The last 5 used models appear in a "Recent" section on top. */
export function ProviderModelSelect() {
  const providers = useStore((s) => s.settings.providers);
  const activeId = useStore((s) => s.settings.activeProviderId);
  const recents = useStore((s) => s.recentModels);
  const setActiveProvider = useStore((s) => s.setActiveProvider);
  const setProviderConfig = useStore((s) => s.setProviderConfig);
  const setProviderModels = useStore((s) => s.setProviderModels);
  const addRecentModel = useStore((s) => s.addRecentModel);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [live, setLive] = useState<Record<string, string[]>>({});
  const [fetching, setFetching] = useState<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const ensureFetched = (p: ProviderConfig) => {
    const sig = providerSig(p);
    if (LIVE_CACHE.has(sig)) {
      const cached = LIVE_CACHE.get(sig)!;
      setLive((l) => (l[p.id] === cached ? l : { ...l, [p.id]: cached }));
      return;
    }
    if (fetching[p.id]) return;
    setFetching((f) => ({ ...f, [p.id]: true }));
    fetchModels(p)
      .then((res) => {
        LIVE_CACHE.set(sig, res.models);
        setLive((l) => ({ ...l, [p.id]: res.models }));
        useStore.getState().setProviderContextMap(p.id, res.context);
        // Live per-model USD-per-million-token pricing from the provider's
        // /models endpoint — without this the sidebar "Model usage" panel and
        // context-meter cost chip have no pricing to look up and always show
        // "—" / $0, even though the backend already resolved real prices.
        useStore.getState().setProviderPricingMap(p.id, res.pricing);
      })
      .catch(() => {
        /* keep the provider's saved list when /models is unavailable */
      })
      .finally(() => {
        setFetching((f) => ({ ...f, [p.id]: false }));
      });
  };

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Fresh state each time the menu opens: empty search, all providers collapsed,
  // and kick off a live /models fetch for every provider.
  useEffect(() => {
    if (open) {
      setQuery("");
      setExpanded(new Set());
      requestAnimationFrame(() => searchRef.current?.focus());
      for (const p of providers) ensureFetched(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = providers.find((p) => p.id === activeId) ?? providers[0];
  if (!active) return null;

  // Fetched models + the provider's saved list (custom-added, from the DB) +
  // current model, minus the models the user explicitly removed.
  const allModels = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? []);
    const out = new Set<string>();
    for (const m of live[p.id] ?? []) {
      const b = bareModel(p, m);
      if (!removed.has(b)) out.add(b);
    }
    for (const m of p.models ?? []) out.add(bareModel(p, m));
    if (p.model) {
      const b = bareModel(p, p.model);
      if (!removed.has(b)) out.add(b);
    }
    return Array.from(out);
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const terms = q.split(/\s+/).filter(Boolean);

  // Last 5 used models, resolved to a provider (legacy bare entries are
  // attributed to the unique provider that owns the model).
  const recentList = useMemo(() => {
    const items: Array<{ p: ProviderConfig; model: string }> = [];
    for (const r of recents) {
      if (!r.model) continue;
      let p = providers.find((x) => x.id === r.providerId);
      if (!p && !r.providerId) {
        const owners = providers.filter((x) => {
          const saved = x.models ?? [];
          const liveM = live[x.id] ?? [];
          return saved.includes(r.model) || liveM.includes(r.model);
        });
        if (owners.length === 1) p = owners[0];
      }
      if (!p) continue;
      if ((p.removedModels ?? []).includes(r.model)) continue;
      items.push({ p, model: bareModel(p, r.model) });
      if (items.length >= 5) break;
    }
    return items;
  }, [recents, providers, live]);

  const recentsShown = recentList.filter(({ p, model }) => {
    if (!searching) return true;
    const hay = `${p.name} ${modelLabel(p, model)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  const filtered = useMemo(() => {
    return providers
      .map((p) => {
        const models = allModels(p);
        const matched = searching
          ? models.filter((m) => {
              const hay = `${p.name} ${modelLabel(p, m)}`.toLowerCase();
              return terms.every((t) => hay.includes(t));
            })
          : models;
        const nameMatch = searching && p.name.toLowerCase().includes(q);
        return { p, models: matched, visible: searching ? matched.length > 0 || nameMatch : true };
      })
      .filter((x) => x.visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, q, terms, searching, live]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pick = (p: ProviderConfig, m: string) => {
    const model = bareModel(p, m);
    setActiveProvider(p.id);
    setProviderConfig({ model });
    addRecentModel(model, p.id);
    if (!(p.models ?? []).includes(model)) {
      setProviderModels(p.id, [...(p.models ?? []), model]);
    }
    setOpen(false);
  };

  const label = active.model ? modelLabel(active, active.model) : active.name;

  return (
    <div className={`pm-select${open ? " open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="pm-select-btn"
        onClick={() => setOpen((o) => !o)}
        title={`${active.name} — ${active.model || "no model"}`}
      >
        <span className="pm-select-label">{label}</span>
        <span className="mode-select-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mode-menu pm-menu">
          <input
            ref={searchRef}
            className="pm-search"
            value={query}
            placeholder="Search models…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="pm-scroll">
            {recentsShown.length > 0 && (
              <div className="pm-recents">
                <div className="pm-recent-label">Recent</div>
                {recentsShown.map(({ p, model }) => {
                  const isCurrent = p.id === activeId && model === active.model;
                  return (
                    <button
                      key={`${p.id}/${model}`}
                      type="button"
                      className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
                      onClick={() => pick(p, model)}
                    >
                      {!PROVIDER_META[p.kind]?.unprefixedModelId && (
                        <span className="pm-model-provider">{p.id}/</span>
                      )}
                      <span className="pm-model-name">{model}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {filtered.length === 0 && recentsShown.length === 0 && (
              <div className="pm-empty">
                <span>No models match “{query}”.</span>
                <span>Try a different search, or add a custom model in Settings → Providers.</span>
              </div>
            )}
            {filtered.map(({ p, models }) => {
              const isOpen = searching || expanded.has(p.id);
              const loading = fetching[p.id] && !live[p.id];
              return (
                <div key={p.id} className={`pm-provider${isOpen ? " open" : ""}`}>
                  <button
                    type="button"
                    className={`pm-provider-name ${p.id === activeId ? "active" : ""}`}
                    onClick={() => toggle(p.id)}
                  >
                    <span className="pm-provider-caret">{isOpen ? "▾" : "▸"}</span>
                    <span className="pm-provider-label">{p.name}</span>
                    <span className="pm-provider-count">
                      {loading ? "…" : allModels(p).length}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pm-models">
                      {loading && <div className="pm-loading">Fetching models…</div>}
                      {models.map((m) => {
                        const isCurrent = p.id === activeId && m === active.model;
                        return (
                          <button
                            key={m}
                            type="button"
                            className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
                            onClick={() => pick(p, m)}
                          >
                            {!PROVIDER_META[p.kind]?.unprefixedModelId && (
                              <span className="pm-model-provider">{p.id}/</span>
                            )}
                            <span className="pm-model-name">{m}</span>
                          </button>
                        );
                      })}
                      {!loading && models.length === 0 && (
                        <div className="pm-hint">
                          No models — check the provider’s base URL &amp; key, or add one in Settings.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
