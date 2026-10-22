import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ProviderConfig } from "../types";
import { MAX_PINNED_RECENT_MODELS, sortRecentModels, useStore } from "../lib/store";
import { isForeignModelId } from "../lib/provider-meta";
import { ModelTestButton, PinIcon, RemoveIcon } from "./ModelTestButton";
import { ProviderTestButton } from "./ProviderTestButton";
import { RecentTestButton } from "./RecentTestButton";

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
export function ProviderModelSelect(props?: {
  chatId?: string;
  /** Controlled mode: when provided, the picker does NOT touch the active
   *  chat — it renders this value and reports picks through `onSelect`.
   *  Used by Settings → Tools rows to reuse the composer picker without
   *  mutating the currently selected chat. */
  value?: string;
  onSelect?: (value: string) => void;
  /** Controlled mode only: text shown BOTH on the button and on the dropdown
   *  entry that clears the selection (e.g. "Main model") — the button shows it
   *  whenever the controlled value is empty, because an empty slot inherits the
   *  main model. When omitted, the button falls back to the provider name. */
  noneLabel?: string;
  /** Composer-footer mode: render the provider name dimmed in front of the
   *  model id and let CSS clip the model, so a long "provider/model" (e.g.
   *  "9router/oc/deepseek-v4.1-flash-free") stays compact while still telling
   *  which provider AND which model are in use. The full string stays in the
   *  button tooltip. Unused by the Settings → Tools rows. */
  compact?: boolean;
}) {
  const controlled = props?.onSelect != null;
  const providers = useStore((s) => s.settings.providers);
  const activeId = useStore((s) => s.settings.activeProviderId);
  const recents = useStore((s) => s.recentModels);
  const setActiveProvider = useStore((s) => s.setActiveProvider);
  const setProviderConfig = useStore((s) => s.setProviderConfig);
  const setProviderModels = useStore((s) => s.setProviderModels);
  const addRecentModel = useStore((s) => s.addRecentModel);
  const removeRecentModel = useStore((s) => s.removeRecentModel);
  const togglePinRecentModel = useStore((s) => s.togglePinRecentModel);
  const pinnedCount = useStore((s) => s.recentModels.filter((r) => r.pinned).length);
  // Per-window: when mounted inside a multi-window ChatPanel, show THAT
  // window's chat model, not the globally focused chat. Single-window
  // callers omit chatId and follow the focused chat as before.
  const chat = useStore((s) => {
    const id = props?.chatId ?? s.activeChatId;
    for (const c of s.chats) if (c.id === id) return c;
    return null;
  });
  const setChatProvider = useStore((s) => s.setChatProvider);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** When true the menu opens DOWNWARD (`.pm-below`) instead of upward. */
  const [below, setBelow] = useState(false);
  /** Max height (px) the popup may occupy in the chosen direction, fed to CSS
   *  as `--pm-max-h` so a short window scrolls the menu INTERNALLY instead of
   *  letting it spill past a clipped ancestor. */
  const [maxH, setMaxH] = useState<number | null>(null);
  /** Viewport-fixed anchor of the menu. The menu is PORTALLED to <body> so the
   *  Settings modal's scrollers (`overflow:auto/hidden` on .settings-content/
   *  .settings-body/.settings-modal) can no longer clip it — with the portal,
   *  `left/right` are resolved against the viewport, so the coordinates are
   *  measured from the button instead of inheriting `.pm-select`'s box. */
  const [anchor, setAnchor] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    minWidth: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      // The menu lives in a PORTAL (outside this wrapper), so an outside-click
      // check must look at the menu node too — otherwise clicking any model
      // row would count as "outside" and close the popup before the pick runs.
      if (wrapRef.current && !wrapRef.current.contains(t)) {
        if (menuRef.current && menuRef.current.contains(t)) return;
        setOpen(false);
      }
    }
    // CAPTURE phase on purpose: the Settings modal stops mousedown propagation
    // at `.settings-modal` (its overlay uses onMouseDown to close), so a
    // bubble-phase document listener never fires for clicks inside the modal
    // and the popup could not be dismissed. Capture runs top-down before any
    // stopPropagation, so it works in both the composer and the modal.
    document.addEventListener("mousedown", onDocClick, true);
    return () => document.removeEventListener("mousedown", onDocClick, true);
  }, []);

  /** Clip window of an element = its viewport rect ∩ every scrollable /
   *  overflow-hidden ancestor rect. This — not `window.innerHeight` — is what
   *  actually clips the popup: inside the Settings modal `.settings-content`
   *  (overflow-y: auto) cuts anything above its visible top edge, and any
   *  overflow:hidden wrapper enforces its own box too. */
  const clipWindow = (start: HTMLElement, up: boolean) => {
    const MENU_EST = 360; // height estimate before the real height is known
    const PAD = 12; // breathing room under/over the button
    let top = 0;
    let bottom = window.innerHeight;
    const rects: DOMRect[] = [];
    for (
      let el: HTMLElement | null = start;
      el;
      el = el.parentElement
    ) {
      const cs = window.getComputedStyle(el);
      const oy = cs.overflowY;
      if (oy === "visible" || oy === "clip") continue;
      if (el !== start) rects.push(el.getBoundingClientRect());
      if (oy === "auto" || oy === "scroll") {
        // A scroll container clips only its VISIBLE box; contents above the
        // current scroll position still count as reachable (the menu can be
        // scrolled to).
        top = Math.max(top, Math.max(el.getBoundingClientRect().top, 0));
        bottom = Math.min(bottom, Math.min(el.getBoundingClientRect().bottom, window.innerHeight));
      } else {
        const r = el.getBoundingClientRect();
        top = Math.max(top, Math.max(r.top, 0));
        bottom = Math.min(bottom, Math.min(r.bottom, window.innerHeight));
      }
    }
    const r = start.getBoundingClientRect();
    const spaceUp = r.top - top - PAD;
    const spaceDown = bottom - r.bottom - PAD;
    const room = up ? spaceUp : spaceDown;
    return {
      below: spaceDown >= Math.min(MENU_EST, spaceUp),
      maxH: Math.max(0, Math.min(MENU_EST, room)),
    };
  };

  /** Re-measure AFTER the menu mounts (its real height replaces the 360px
   *  estimate): clamp to the chosen side's clip window so a short window
   *  scrolls the menu internally instead of spilling past the clip edge. */
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const { maxH } = clipWindow(wrapRef.current, !below);
    setBelow((b) => {
      const { below: wantBelow } = clipWindow(wrapRef.current!, !b);
      return wantBelow;
    });
    setMaxH(Math.max(180, maxH));
    // Keep the portalled menu glued to the button while the modal scrolls or
    // the window resizes (the button moves, the portal must follow).
    const el = wrapRef.current;
    const follow = () => measureAnchor(el);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, below, query, expanded]);

  /** Open/close the menu, measuring the REAL clip window (up AND down) at
   *  open time and opening on the side with room; the layout effect then
   *  clamps the menu's height with `--pm-max-h`. */
  /** Viewport-fixed anchor box for the portalled menu: the button's rect, with
   *  `left/right` pinned so the menu never runs under the Settings tabs column
   *  — it is clamped to the viewport when the button sits close to an edge. */
  const measureAnchor = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const MENU_MIN = 280; // .pm-menu min-width
    const MARGIN = 10; // keep off the window edges
    const maxRight = window.innerWidth - MARGIN;
    // Right-align with the button, but never let the menu overflow the window.
    const right = Math.max(MARGIN, maxRight - r.right);
    const left = Math.max(MARGIN, r.left);
    const width = Math.min(
      Math.max(MENU_MIN, r.width),
      Math.max(MENU_MIN, window.innerWidth - MARGIN * 2),
    );
    setAnchor({
      top: r.top,
      bottom: r.bottom,
      // Distance from the relevant window edge to the menu's right-aligned box.
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)),
      right,
      minWidth: width,
    });
  };

  const toggleMenu = () => {
    setOpen((o) => {
      if (!o && wrapRef.current) {
        const m = clipWindow(wrapRef.current, true);
        setBelow(m.below);
        setMaxH(m.maxH > 0 ? m.maxH : null);
        measureAnchor(wrapRef.current);
      }
      return !o;
    });
  };

  // Fresh state each time the menu opens: empty search; providers stay closed
  // in the composer. A controlled picker (Settings → Tools) auto-EXPANDS the
  // group the slot points at — or the active provider while the slot inherits
  // the main model — so the model list is instantly visible instead of a wall
  // of collapsed provider names. No model fetch happens here — the list comes
  // from the persisted store (populated at startup / on provider add-edit).
  useEffect(() => {
    if (open) {
      setQuery("");
      const expandPid = controlled ? ctrl?.providerId ?? activeProviderId : "";
      setExpanded(expandPid ? new Set([expandPid]) : new Set());
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

  // In controlled mode the displayed value comes from the parent instead of
  // the chat: `value` is a "providerId/model" string (bare id = active
  // provider), exactly what Settings stores for each tool slot.
  const ctrl = (() => {
    if (!controlled) return null as null | { providerId: string; model: string };
    const raw = (props?.value ?? "").trim();
    if (!raw) return null;
    const slash = raw.indexOf("/");
    if (slash > 0) {
      const pid = raw.slice(0, slash);
      const model = raw.slice(slash + 1);
      const p = providers.find((x) => x.id === pid);
      if (p) return { providerId: p.id, model };
    }
    return { providerId: activeProviderId, model: raw };
  })();
  // In controlled mode an EMPTY value is meaningful: the slot inherits the
  // main model. Falling back to the active provider's model there would make an
  // inherited row look like an explicit pick, so keep the shown model empty and
  // let the button say "Main model" instead.
  const inherited = controlled && ctrl == null;
  const noneText = props?.noneLabel ?? "Main model";
  const shownProviderId = ctrl?.providerId ?? (controlled ? "" : activeProviderId);
  const shownModel = ctrl?.model ?? (controlled ? "" : activeModel);
  const shownProvider =
    providers.find((p) => p.id === shownProviderId) ?? active;

  // Fetched models + the provider's saved list + current model, minus the
  // models the user explicitly removed. Saved entries are filtered by
  // `removed` too so a model the user removed (e.g. via
  // Settings → Providers) doesn't sneak back into the dropdown just because
  // it's still in `p.models` from an earlier write.
  //
  // The provider's OWN catalog is authoritative here: `p.models` is what its
  // /models payload (plus the hand-added list) says it serves, and
  // `removedModels` is the user's explicit veto. The `isForeignModelId`
  // heuristic deliberately does NOT run on it any more — it is a GUESS that a
  // vendor-prefixed id belongs to some other provider, and it hid real models
  // from every list built on `allModels` (e.g. a custom gateway whose catalog
  // carries "openrouter/x-ai/grok-4": head "openrouter" is a built-in kind id,
  // so the row counted 5 models while the picker offered 4). A picker that
  // silently withholds selectable models is worse than one that shows an
  // unexpected id the provider itself reported. The guard still applies where
  // it is actually needed: `mergeFetchedModels` uses it to keep ANOTHER
  // provider's stale entries out of a freshly fetched list.
  const allModels = (p: ProviderConfig): string[] => {
    const removed = new Set(p.removedModels ?? []);
    const out = new Set<string>();
    for (const m of p.models ?? []) {
      const b = bareModel(p, m);
      if (!removed.has(b)) out.add(b);
    }
    // Models the user added BY HAND are never filtered either. `addedModels`
    // exists exactly for catalogs a provider hides from its /models payload, so
    // an explicit pick always wins.
    for (const m of p.addedModels ?? []) {
      const b = bareModel(p, m).trim();
      if (!b) continue;
      if (!removed.has(b)) out.add(b);
    }
    if (p.model) {
      const b = bareModel(p, p.model);
      if (!removed.has(b)) out.add(b);
    }
    return Array.from(out);
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const terms = q.split(/\s+/).filter(Boolean);

  // Starting a search auto-expands every provider so matches are visible.
  // After that first keystroke, `expanded` alone drives open/collapse —
  // the user can collapse any provider mid-search (was forced open by
  // `searching || expanded.has(...)` before, which made toggle a no-op).
  const onSearchChange = (value: string) => {
    const wasSearching = query.trim().length > 0;
    const nowSearching = value.trim().length > 0;
    setQuery(value);
    if (nowSearching && !wasSearching) {
      setExpanded(new Set(providers.map((p) => p.id)));
    } else if (!nowSearching && wasSearching) {
      setExpanded(new Set());
    }
  };

  // Last 10 used models, resolved to a provider (legacy bare entries are
  // attributed to the unique provider that owns the model). Pinned models
  // always stay on top (most-recent-pinned first), then the rest by recency.
  const recentList = useMemo(() => {
    const items: Array<{ p: ProviderConfig; model: string; pinned: boolean }> = [];
    const seen = new Set<string>();
    // پین‌شده‌ها اول، بعد بقیه — هر دو گروه تازه‌ترین اول.
    const ordered = sortRecentModels(recents);
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
      const key = `${p.id}/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ p, model, pinned: r.pinned === true });
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
    if (controlled) {
      // Settings → Tools: report "providerId/model" and leave the active chat
      // (and global default) completely untouched — but DO record the pick in
      // the shared Recent list, so the popup's Recent section behaves exactly
      // like the composer's.
      props?.onSelect?.(`${p.id}/${model}`);
      addRecentModel(model, p.id);
      setOpen(false);
      return;
    }
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

  const label = inherited
    ? noneText
    : shownModel
      ? modelLabel(shownProvider, shownModel)
      : shownProvider.name;
  const buttonTitle = inherited
    ? `${noneText} — follows whatever the composer is using`
    : `${shownProvider.name} — ${shownModel || "no model"}`;

  return (
    <div className={`pm-select${open ? " open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="pm-select-btn"
        onClick={toggleMenu}
        title={buttonTitle}
      >
        <span className="pm-select-label">
          {props?.compact && !inherited && shownModel ? (
            <>
              <span className="pm-select-provider">{shownProvider.name}/</span>
              <span className="pm-select-model">{shownModel}</span>
            </>
          ) : (
            label
          )}
        </span>
        <span className="mode-select-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open &&
        anchor &&
        // The menu is PORTALLED to <body> and fixed to the button's viewport
        // rect: inside the Settings modal its ancestors scroll/clip
        // (`.settings-content` is `overflow:auto`), which used to cut the menu
        // off under the tabs column.
        createPortal(
          <div
            ref={menuRef}
            className={`mode-menu pm-menu pm-fixed${below ? " pm-below" : ""}`}
            style={
              {
                ...(maxH != null ? { "--pm-max-h": `${maxH}px` } : {}),
                position: "fixed",
                top: below ? anchor.bottom + 6 : "auto",
                bottom: below ? "auto" : window.innerHeight - anchor.top + 6,
                left: "auto",
                right: anchor.right,
                minWidth: anchor.minWidth,
              } as CSSProperties
            }
          >
            <input
              ref={searchRef}
              className="pm-search"
              value={query}
              placeholder="Search models…"
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <div className="pm-scroll">
            {controlled && props?.noneLabel != null && (
              <button
                type="button"
                className={`mode-menu-item pm-model pm-clear${inherited ? " active" : ""}`}
                onClick={() => {
                  props?.onSelect?.("");
                  setOpen(false);
                }}
              >
                <span className="pm-model-name">{props.noneLabel}</span>
              </button>
            )}
            {recentsShown.length > 0 && (
              <div className="pm-recents">
                <div className="pm-recent-header">
                  <div className="pm-recent-label">Recent</div>
                  <RecentTestButton
                    entries={recentsShown.map(({ p, model }) => ({ cfg: p, model }))}
                  />
                </div>
                {recentsShown.map(({ p, model, pinned }) => {
                  const isCurrent = p.id === shownProviderId && model === shownModel;
                  const pinFull = !pinned && pinnedCount >= MAX_PINNED_RECENT_MODELS;
                  return (
                    <div key={`${p.id}/${model}`} className={`pm-model-row${pinned ? " pinned" : ""}`}>
                      <button
                        type="button"
                        className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
                        onClick={() => pick(p, model)}
                      >
                        <span className="pm-model-provider">{p.name}/</span>
                        <span className="pm-model-name">{model}</span>
                      </button>
                      <button
                        type="button"
                        className={`pm-recent-pin${pinned ? " on" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          togglePinRecentModel(model, p.id);
                        }}
                        title={
                          pinned
                            ? `Unpin ${model} (از بالای لیست بردار)`
                            : pinFull
                              ? `سقف پین ${MAX_PINNED_RECENT_MODELS} مدل است — اول یکی را آنپین کن`
                              : `Pin ${model} (همیشه بالای لیست اخیر)`
                        }
                        aria-label={pinned ? `Unpin ${model}` : `Pin ${model}`}
                        aria-pressed={pinned}
                        disabled={pinFull}
                      >
                        <PinIcon filled={pinned} />
                      </button>
                      {!pinned && (
                        <button
                          type="button"
                          className="pm-recent-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            removeRecentModel(model, p.id);
                          }}
                          title={`Remove ${model} from recent`}
                          aria-label={`Remove ${model} from recent`}
                        >
                          <RemoveIcon />
                        </button>
                      )}
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
              const isOpen = expanded.has(p.id);
              return (
                <div key={p.id} className={`pm-provider${isOpen ? " open" : ""}`}>
                  <div className="pm-provider-row">
                    <button
                      type="button"
                      className={`pm-provider-name ${p.id === shownProviderId ? "active" : ""}`}
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
                        const isCurrent = p.id === shownProviderId && m === shownModel;
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
          </div>,
          document.body,
        )}
    </div>
  );
}
