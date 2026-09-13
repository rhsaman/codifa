import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderConfig } from "../types";
import { useStore } from "../lib/store";
import { isForeignModelId } from "../lib/provider-meta";
import { ModelTestButton } from "./ModelTestButton";
import { ProviderTestButton } from "./ProviderTestButton";

/** Strip a redundant "providerId/" prefix from a model id (a model can get
 *  persisted with it, e.g. "openrouter/free"), so it is never shown or stored
 *  doubled as "openrouter/openrouter/free". */
function bareModel(p: ProviderConfig, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
}

/** Display label for a model, e.g. "openrouter/gpt-5". Uses the provider's
 *  NAME (not its id) so custom rows show a human label like "justwoker/"
 *  instead of a random "custom-mtwl9t08/" slug. */
function modelLabel(p: ProviderConfig, m: string): string {
  return `${p.name}/${m}`;
}

/** Compact provider + model picker shown in the composer. The model list is
 *  NOT fetched here — it is populated by the startup refresh (App.tsx) and
 *  whenever a provider is added/edited (SettingsModal), both via
 *  fetchAndPersist. Opening this popup only reads the persisted list, so it
 *  never fires a network request. The last 10 used models appear in a
 *  "Recent" section on top. */
export function ProviderModelSelect() {
  const providers = useStore((s) => s.settings.providers);
  const activeId = useStore((s) => s.settings.activeProviderId);
  const recents = useStore((s) => s.recentModels);
  const setActiveProvider = useStore((s) => s.setActiveProvider);
  const setProviderConfig = useStore((s) => s.setProviderConfig);
  const setProviderModels = useStore((s) => s.setProviderModels);
  const addRecentModel = useStore((s) => s.addRecentModel);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null);
  const setChatProvider = useStore((s) => s.setChatProvider);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Fresh state each time the menu opens: empty search, all providers collapsed.
  // No model fetch happens here — the list comes from the persisted store
  // (populated at startup / on provider add-edit via fetchAndPersist).
  useEffect(() => {
    if (open) {
      setQuery("");
      setExpanded(new Set());
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Per-chat model override: each chat remembers its own provider/model choice
  // (set via this picker), falling back to the global active provider when the
  // chat has never overridden it.
  const activeProviderId = chat?.providerId ?? activeId;
  const active = providers.find((p) => p.id === activeProviderId) ?? providers[0];
  if (!active) return null;
  const activeModel = chat?.model ?? active.model;

  // Fetched models + the provider's saved list + current model, minus the
  // models the user explicitly removed. Saved entries are filtered by
  // `removed` too so a model the user removed (e.g. via
  // Settings → Providers) doesn't sneak back into the dropdown just because
  // it's still in `p.models` from an earlier write.
  //
  // The foreign-id check (isForeignModelId) is applied to the PERSISTED
  // sources below (`p.models`, `p.model`) — e.g. a stale "openrouter/sonnet"
  // that landed in nvidia's `p.models` via recentModels migration or a
  // custom-row copy. Aggregator kinds like OpenRouter/TokenRouter
  // legitimately carry vendor-prefixed ids ("google/gemini-2.5-flash",
  // "nvidia/llama-3.1-nemotron-70b-instruct") whose vendor name coincides
  // with one of Coder's own built-in provider kind ids, so the check runs on
  // the BARE id `b` (post-strip), not on the raw `m` — otherwise a
  // doubled-prefix entry like "local/opencode/big-pickle" would pass the raw
  // check (head === p.id) but still render as the wrong model.
  const allModels = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? []);
    const out = new Set<string>();
    for (const m of p.models ?? []) {
      const b = bareModel(p, m);
      if (isForeignModelId(p, b)) continue;
      if (!removed.has(b)) out.add(b);
    }
    if (p.model) {
      const b = bareModel(p, p.model);
      if (!isForeignModelId(p, b) && !removed.has(b)) out.add(b);
    }
    return Array.from(out);
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const terms = q.split(/\s+/).filter(Boolean);

  // Last 10 used models, resolved to a provider (legacy bare entries are
  // attributed to the unique provider that owns the model).
  const recentList = useMemo(() => {
    const items: Array<{ p: ProviderConfig; model: string }> = [];
    const seen = new Set<string>();
    // Sort by lastUsed descending so the most recently used model is first.
    const ordered = [...recents].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
    for (const r of ordered) {
      if (!r.model) continue;
      let p = providers.find((x) => x.id === r.providerId);
      if (!p && !r.providerId) {
        const owners = providers.filter((x) => (x.models ?? []).includes(r.model));
        if (owners.length === 1) p = owners[0];
      }
      if (!p) continue;
      if ((p.removedModels ?? []).includes(r.model)) continue;
      const model = bareModel(p, r.model);
      if (isForeignModelId(p, model)) continue;
      const key = `${p.id}/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ p, model });
      if (items.length >= 10) break;
    }
    return items;
  }, [recents, providers]);

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
  }, [providers, q, terms, searching]);

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
    if (chat) {
      // Per-chat: remember THIS chat's provider/model choice only — other
      // chats and the global default stay untouched.
      useStore.getState().setChatProvider(chat.id, p.id, model);
    } else {
      setActiveProvider(p.id);
      setProviderConfig({ model });
    }
    addRecentModel(model, p.id);
    if (!(p.models ?? []).includes(model)) {
      setProviderModels(p.id, [...(p.models ?? []), model]);
    }
    setOpen(false);
  };

  const label = activeModel ? modelLabel(active, activeModel) : active.name;

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
                  const isCurrent = p.id === activeProviderId && model === activeModel;
                  return (
                    <div key={`${p.id}/${model}`} className="pm-model-row">
                      <button
                        type="button"
                        className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
                        onClick={() => pick(p, model)}
                      >
                        <span className="pm-model-provider">{p.name}/</span>
                        <span className="pm-model-name">{model}</span>
                      </button>
                      <ModelTestButton cfg={p} model={model} />
                    </div>
                  );
                })}
              </div>
            )}
            {filtered.length === 0 && recentsShown.length === 0 && (
              <div className="pm-empty">
                <span>No models match “{query}”.</span>
                <span>Try a different search.</span>
              </div>
            )}
            {filtered.map(({ p, models }) => {
              const isOpen = searching || expanded.has(p.id);
              return (
                <div key={p.id} className={`pm-provider${isOpen ? " open" : ""}`}>
                  <div className="pm-provider-row">
                    <button
                      type="button"
                      className={`pm-provider-name ${p.id === activeProviderId ? "active" : ""}`}
                      onClick={() => toggle(p.id)}
                    >
                      <span className="pm-provider-caret">{isOpen ? "▾" : "▸"}</span>
                      <span className="pm-provider-label">{p.name}</span>
                      <span className="pm-provider-count">{allModels(p).length}</span>
                    </button>
                    <ProviderTestButton cfg={p} models={models} />
                  </div>
                  {isOpen && (
                    <div className="pm-models">
                      {models.map((m) => {
                        const isCurrent = p.id === activeProviderId && m === activeModel;
                        return (
                          <div key={m} className="pm-model-row">
                            <button
                              type="button"
                              className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
                              onClick={() => pick(p, m)}
                            >
                              <span className="pm-model-provider">{p.name}/</span>
                              <span className="pm-model-name">{m}</span>
                            </button>
                            <ModelTestButton cfg={p} model={m} />
                          </div>
                        );
                      })}
                      {models.length === 0 && (
                        <div className="pm-hint">
                          No models — check the provider’s base URL &amp; key.
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
