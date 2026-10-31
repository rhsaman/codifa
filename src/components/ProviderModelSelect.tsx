import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderConfig } from "../types";
import { providerDisplayName } from "../lib/provider-meta";
import { MAX_PINNED_RECENT_MODELS, sortRecentModels, useStore } from "../lib/store";
import { resolveSlotEntry } from "../lib/toolSlots";
import { ModelTestButton, PinIcon, RemoveIcon, TestBoltIcon } from "./ModelTestButton";
import { ProviderTestButton } from "./ProviderTestButton";
import { RecentTestButton } from "./RecentTestButton";
import { useModelTests } from "../lib/useModelTests";

/** Strip a redundant "providerId/" prefix from a model id (a model can get
 *  persisted with it, e.g. "openrouter/free"), so it is never shown or stored
 *  doubled as "openrouter/openrouter/free". */
function bareModel(p: ProviderConfig, m: string): string {
  return m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
}

/** Display label for a model, e.g. "openrouter/gpt-5". Uses the provider's
 *  display NAME (not its id) so custom rows show a human label like
 *  "justwoker/" instead of a random "custom-mtwl9t08/" slug. Unnamed rows
 *  (freshly added, Name input still empty) fall back to the kind label. */
function modelLabel(p: ProviderConfig, m: string): string {
  return `${providerDisplayName(p)}/${m}`;
}

/** The provider's OWN catalog is authoritative: `p.models` is what its
 *  /models payload (plus the hand-added list) says it serves, and
 *  `removedModels` is the user's explicit veto. Saved entries are filtered by
 *  `removed` too so a model the user removed (e.g. via Settings → Providers)
 *  doesn't sneak back into the picker just because it's still in `p.models`
 *  from an earlier write. The `isForeignModelId` heuristic deliberately does
 *  NOT run here — it is a GUESS that a vendor-prefixed id belongs to some
 *  other provider, and it hid real models (e.g. a custom gateway whose catalog
 *  carries "openrouter/x-ai/grok-4"). A picker that silently withholds
 *  selectable models is worse than one that shows an unexpected id the
 *  provider itself reported. */
function allModels(p: ProviderConfig): string[] {
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
}

/** آیکون ساعت برای تب Recent — SVG با currentColor (مثل بقیه آیکون‌های
 *  پیکر) تا رنگ CSS همیشه درست رندر شود. */
function ClockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** آیکون تیک داخل دایره برای تب «Checked» — فقط مدل‌های تست‌شدهٔ موفق (✓). */
function CheckCircleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8.2 12.3l2.5 2.5 5.1-5.6" />
    </svg>
  );
}

/** ذره‌بین فیلد جستجو در سربرگ مودال (با CSS روی .pm-modal-searchbox svg
 *  موقعیت می‌گیرد؛ در empty-state هم بدون کلاس استفاده می‌شود). */
function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20.2 20.2l-3.9-3.9" />
    </svg>
  );
}

/** مدل + پروایدرش — برای تب Checked و نتایج جستجو (لیست مختلط چند-پروایدر). */
interface GroupedEntry {
  p: ProviderConfig;
  models: string[];
}

/** Centered model-picker MODAL shown in the composer AND in Settings → Tools
 *  (the same component, controlled or not). Clicking the trigger opens a
 *  dialog in the middle of the screen: a left-hand tab rail lists "Recent",
 *  "Checked" (only models that PASSED their test — the green ✓, persisted in
 *  settings so the tab survives a restart) and every provider; the right pane
 *  lists the selected tab's models. The model list is
 *  NOT fetched here — it is populated by the startup refresh (App.tsx) and
 *  whenever a provider is added/edited (SettingsModal), both via
 *  fetchAndPersist. Opening this popup only reads the persisted list, so it
 *  never fires a network request. */
export function ProviderModelSelect(props?: {
  chatId?: string;
  /** Controlled mode: when provided, the picker does NOT touch the active
   *  chat — it renders this value and reports picks through `onSelect`.
   *  Used by Settings → Tools rows to reuse the composer picker without
   *  mutating the currently selected chat. */
  value?: string;
  onSelect?: (value: string) => void;
  /** Controlled mode only: text shown BOTH on the button and on the dialog
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
  // لیست ماندگار مدل‌های تیک‌دار — در settings ذخیره می‌شود تا تب Checked
  // بعد از ری‌استارت هم همان‌ها را نشان دهد.
  const checkedModels = useStore((s) => s.checkedModels);
  const setCheckedModels = useStore((s) => s.setCheckedModels);
  // Per-window: when mounted inside a multi-window ChatPanel, show THAT
  // window's chat model, not the globally focused chat. Single-window
  // callers omit chatId and follow the focused chat as before.
  const chat = useStore((s) => {
    const id = props?.chatId ?? s.activeChatId;
    for (const c of s.chats) if (c.id === id) return c;
    return null;
  });
  const setChatProvider = useStore((s) => s.setChatProvider);
  // نتایج تست مدل‌ها — تب «Checked» از همین استور مشترک می‌خواند، همان منبعی
  // که دکمه‌های ⚡ تکی و گروهی می‌نویسند، پس تب زنده به‌روز می‌ماند. dismiss
  // نتیجهٔ ✓ یک مدل را برمی‌گرداند و clearChecked همهٔ ✓ها را پاک می‌کند.
  const { getStatus, dismiss, clearChecked } = useModelTests();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** تب فعال ریل: "__recent" | "__checked" | شناسهٔ پروایدر. */
  const [tab, setTab] = useState<string>("__recent");
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      // سقف ۲۰ = همان سقف استور (addRecentModel روی ۲۰ می‌بُرد).
      if (items.length >= 20) break;
    }
    return items;
  }, [recents, providers]);

  // تب «Checked»: مدل‌های تیک‌دار = نتیجهٔ ✓ زندهٔ این نشست + لیست ماندگار
  // checkedModels (بعد از ری‌استارت وضعیت زنده idle است و همین لیست تب را
  // پر می‌کند). نتیجهٔ fail زنده همیشه بیرون می‌ماند حتی اگر در لیست ذخیره
  // باشد تا در همان تیک، افکت سینک آن را از لیست هم حذف کند.
  const checkedKeys = useMemo(
    () => new Set(checkedModels.map((c) => `${c.providerId}/${c.model}`)),
    [checkedModels],
  );
  const checkedGroups = useMemo<GroupedEntry[]>(() => {
    const out: GroupedEntry[] = [];
    for (const p of providers) {
      const models = allModels(p).filter((m) => {
        const st = getStatus(p, m).status;
        if (st === "fail") return false;
        return st === "ok" || checkedKeys.has(`${p.id}/${m}`);
      });
      if (models.length > 0) out.push({ p, models });
    }
    return out;
  }, [providers, getStatus, checkedKeys]);

  // نتایج ✓ زنده را در استور ماندگار می‌کند و failها (و ورودی‌های خارج از
  // کاتالوگ پروایدرها) را از لیست ذخیره حذف می‌کند — تب Checked بعد از
  // ری‌استارت هم سر جایش می‌ماند. ادغام یک‌طرفه است: فقط ok جدید اضافه،
  // fail حذف، بقیهٔ لیست دست‌نخورده. نوشتن با تأخیر کوتاه trailing است تا
  // یک تست گروهی بزرگ، چند صد encrypt پشت‌سرهم نسازد.
  useEffect(() => {
    const next = new Map(checkedModels.map((c) => [`${c.providerId}/${c.model}`, c]));
    const catalog = new Set<string>();
    let changed = false;
    for (const p of providers) {
      for (const m of allModels(p)) {
        const k = `${p.id}/${m}`;
        catalog.add(k);
        const st = getStatus(p, m).status;
        if (st === "ok") {
          if (!next.has(k)) {
            next.set(k, { providerId: p.id, model: m, lastOkAt: Date.now() });
            changed = true;
          }
        } else if (st === "fail") {
          if (next.delete(k)) changed = true;
        }
      }
    }
    for (const k of [...next.keys()]) {
      if (!catalog.has(k)) {
        next.delete(k);
        changed = true;
      }
    }
    if (!changed) return;
    const merged = [...next.values()];
    const t = setTimeout(() => setCheckedModels(merged), 600);
    return () => clearTimeout(t);
  }, [providers, getStatus, checkedModels, setCheckedModels]);

  // جستجو روی «همهٔ» پروایدرها — نتیجه در پنل راست گروه‌بندی نمایش داده می‌شود
  // بدون اینکه تب ریل عوض شود.
  const searchGroups = useMemo<GroupedEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    return providers
      .map((p) => {
        const models = allModels(p).filter((m) => {
          const hay = `${providerDisplayName(p)} ${p.id} ${m}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
        return { p, models };
      })
      .filter((g) => g.models.length > 0);
  }, [providers, query]);

  // مجموع تخت نتایج سرچ — ورودی دکمهٔ «تست همهٔ نتایج سرچ» در سربرگ.
  const searchEntries = useMemo(
    () => searchGroups.flatMap((g) => g.models.map((m) => ({ cfg: g.p, model: m }))),
    [searchGroups],
  );

  // Per-chat model override: each chat remembers its own provider/model choice
  // (set via this picker), falling back to the global active provider when the
  // chat has never overridden it.
  const activeProviderId = chat?.providerId ?? activeId;
  const active = providers.find((p) => p.id === activeProviderId) ?? providers[0];

  // In controlled mode the displayed value comes from the parent instead of
  // the chat: `value` is a "providerId/model" string (bare id = active
  // provider), exactly what Settings stores for each tool slot.
  const ctrl = (() => {
    if (!controlled) return null as null | { providerId: string; model: string };
    const raw = (props?.value ?? "").trim();
    if (!raw) return null;
    // The same resolution the rest of Settings uses: an id prefix, a legacy
    // KIND prefix, or a bare model id. A slash-bearing entry no row can claim
    // (`oc/deepseek-…`) must show nothing rather than the wrong provider.
    const r = resolveSlotEntry(raw, providers);
    if (r.unowned) return null;
    return { providerId: r.providerId || activeProviderId, model: r.model };
  })();
  // In controlled mode an EMPTY value is meaningful: the slot inherits the
  // main model. Falling back to the active provider's model there would make an
  // inherited row look like an explicit pick, so keep the shown model empty and
  // let the button say "Main model" instead.
  const inherited = controlled && ctrl == null;
  const noneText = props?.noneLabel ?? "Main model";
  const shownProviderId = ctrl?.providerId ?? (controlled ? "" : activeProviderId);
  const shownModel = ctrl?.model ?? (controlled ? "" : chat?.model ?? active?.model ?? "");

  /** Escape فقط مودال پیکر را می‌بندد — نه مودال تنظیمات را. فاز capture تا
   *  قبل از stopPropagationهای مودال تنظیمات اجرا شود. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // هر بار باز شدن: جستجو خالی و تب پیش‌فرض همیشه «Recent» — پروایدرها و
  // مدل‌هایشان یک کلیک در ریل سمت چپ فاصله دارند.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTab("__recent");
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // با عوض شدن تب/باز شدن/تایپ، پنل راست به بالای لیست برمی‌گردد.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, open, query]);

  // اگر تبِ ذخیره‌شده به پروایدر حذف‌شده اشاره کند، به تب پیش‌فرض برمی‌گردیم.
  const tabValid =
    tab === "__recent" || tab === "__checked" || providers.some((p) => p.id === tab);
  const effectiveTab = tabValid
    ? tab
    : recentList.length > 0
      ? "__recent"
      : providers[0]?.id ?? "__recent";

  const hasQuery = query.trim().length > 0;
  const totalMatches = searchGroups.reduce((n, g) => n + g.models.length, 0);
  const checkedEntries = useMemo(
    () =>
      checkedGroups.flatMap((g) => g.models.map((m) => ({ cfg: g.p, model: m }))),
    [checkedGroups],
  );

  if (!active) return null;
  const shownProvider = providers.find((p) => p.id === shownProviderId) ?? active;

  const pick = (p: ProviderConfig, m: string) => {
    const model = bareModel(p, m);
    if (controlled) {
      // Settings → Tools: report "providerId/model" and leave the active chat
      // (and global default) completely untouched — but DO record the pick in
      // the shared Recent list, so the Recent tab behaves exactly like the
      // composer's.
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

  /** حذف یک مدل از تب Checked: نتیجهٔ ✓ زنده به idle برمی‌گردد و از لیست
   *  ماندگار هم حذف می‌شود. */
  const dismissChecked = (p: ProviderConfig, m: string) => {
    dismiss(p, m);
    setCheckedModels(checkedModels.filter((c) => !(c.providerId === p.id && c.model === m)));
  };

  /** حذف کلی تب Checked: همهٔ ✓های زنده idle و لیست ماندگار خالی می‌شود. */
  const clearAllChecked = () => {
    clearChecked();
    setCheckedModels([]);
  };

  /** ردیف مدل در پنل راست — `prefixed` یعنی پیشوند نام پروایدر هم نمایش داده
   *  شود (تب‌های چند-پروایدر: Recent/Checked/جستجو)؛ `dismissible` دکمهٔ ✕
   *  حذف نتیجهٔ ✓ را اضافه می‌کند (تب Checked)؛ `persistentOk` یعنی مدل در
   *  لیست ذخیره‌شدهٔ checked است (بعد از ری‌استارت ✓ سبز نشان بدهد). */
  const modelRow = (
    p: ProviderConfig,
    m: string,
    prefixed: boolean,
    dismissible = false,
    persistentOk = false,
  ) => {
    const isCurrent = p.id === shownProviderId && m === shownModel;
    return (
      <div key={`${p.id}/${m}`} className="pm-model-row">
        <button
          type="button"
          className={`mode-menu-item pm-model ${isCurrent ? "active" : ""}`}
          onClick={() => pick(p, m)}
        >
          {prefixed && <span className="pm-model-provider">{providerDisplayName(p)}/</span>}
          <span className="pm-model-name">{m}</span>
        </button>
        {dismissible && (
          <button
            type="button"
            className="pm-recent-remove"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              dismissChecked(p, m);
            }}
            title={`Dismiss ${m} — removes its ✓ test result`}
            aria-label={`Dismiss ${m}`}
          >
            <RemoveIcon />
          </button>
        )}
        <ModelTestButton cfg={p} model={m} persistentOk={persistentOk} />
      </div>
    );
  };

  /** سربرگ گروه (نام پروایدر) در تب‌های Checked و نتایج جستجو. */
  const groupHeader = (p: ProviderConfig, count: number) => (
    <div className="pm-mpane-group">
      <span className="pm-mpane-group-name">{providerDisplayName(p)}</span>
      <span className="pm-mpane-group-count">{count}</span>
    </div>
  );

  /** ردیف «Main model» — فقط در حالت controlled: پاک‌کردن انتخاب اسلات تا
   *  مدل اصلی کامپوزر ارث برسد. بالای همهٔ تب‌ها می‌نشیند. */
  const clearRow =
    controlled && props?.noneLabel != null ? (
      <button
        type="button"
        className={`pm-clear-row${inherited ? " active" : ""}`}
        onClick={() => {
          props?.onSelect?.("");
          setOpen(false);
        }}
      >
        <span className="pm-clear-label">{props.noneLabel}</span>
        <span className="pm-clear-hint">follows the composer</span>
      </button>
    ) : null;

  const label = inherited
    ? noneText
    : shownModel
      ? modelLabel(shownProvider, shownModel)
      : providerDisplayName(shownProvider);
  const buttonTitle = inherited
    ? `${noneText} — follows whatever the composer is using`
    : `${providerDisplayName(shownProvider)} — ${shownModel || "no model"}`;

  const paneProvider =
    effectiveTab === "__recent" || effectiveTab === "__checked"
      ? null
      : providers.find((p) => p.id === effectiveTab) ?? null;
  const paneModels = paneProvider ? allModels(paneProvider) : [];

  return (
    <div className={`pm-select${open ? " open" : ""}`}>
      <button
        type="button"
        className="pm-select-btn"
        onClick={() => setOpen(true)}
        title={buttonTitle}
      >
        <span className="pm-select-label">
          {props?.compact && !inherited && shownModel ? (
            <>
              <span className="pm-select-provider">{providerDisplayName(shownProvider)}/</span>
              <span className="pm-select-model">{shownModel}</span>
            </>
          ) : (
            label
          )}
        </span>
        <span className="mode-select-caret">▼</span>
      </button>
      {open &&
        // مودال وسط صفحه PORTAL می‌شود به <body> — نه داخل مودال تنظیمات و
        // نه داخل کامپوزر — پس هیچ اسکرول/کلیپی نمی‌تواند برشش دهد. کلیک روی
        // پس‌زمینه می‌بندد؛ کلیک داخل دیالوگ stop می‌شود.
        createPortal(
          <div className="pm-modal-overlay" dir="ltr" onClick={() => setOpen(false)}>
            <div
              className="pm-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Pick a model"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pm-modal-head">
                <div className="pm-modal-searchbox">
                  <SearchIcon />
                  <input
                    ref={searchRef}
                    className="pm-modal-search"
                    value={query}
                    placeholder="Search models…"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="pm-modal-close"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close model picker"
                >
                  <RemoveIcon size={13} />
                </button>
              </div>
              <div className="pm-modal-body">
                <nav className="pm-mrail" aria-label="Providers">
                  <button
                    type="button"
                    className={`pm-mrail-item${effectiveTab === "__recent" ? " active" : ""}`}
                    onClick={() => {
                      setQuery("");
                      setTab("__recent");
                    }}
                  >
                    <span className="pm-mrail-icon">
                      <ClockIcon />
                    </span>
                    <span className="pm-mrail-label">Recent</span>
                    <span className="pm-mrail-count">{recentList.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`pm-mrail-item${effectiveTab === "__checked" ? " active" : ""}`}
                    onClick={() => {
                      setQuery("");
                      setTab("__checked");
                    }}
                    title="Only models that passed their test (✓)"
                  >
                    <span className="pm-mrail-icon">
                      <CheckCircleIcon />
                    </span>
                    <span className="pm-mrail-label">Checked</span>
                    <span className="pm-mrail-count">{checkedEntries.length}</span>
                  </button>
                  <div className="pm-mrail-sep" />
                  <div className="pm-mrail-title">Providers</div>
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={providerDisplayName(p)}
                      className={`pm-mrail-item${effectiveTab === p.id ? " active" : ""}`}
                      onClick={() => {
                        setQuery("");
                        setTab(p.id);
                      }}
                    >
                      <span className="pm-mrail-avatar">
                        {providerDisplayName(p).trim().charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="pm-mrail-label">{providerDisplayName(p)}</span>
                      <span className="pm-mrail-count">{allModels(p).length}</span>
                    </button>
                  ))}
                </nav>
                <section className="pm-mpane">
                  {hasQuery ? (
                    <>
                      <div className="pm-mpane-head">
                        <span className="pm-mpane-title">Search results</span>
                        <span className="pm-mpane-sub">
                          {totalMatches} {totalMatches === 1 ? "match" : "matches"}
                        </span>
                        {searchGroups.length > 0 && (
                          <RecentTestButton
                            entries={searchEntries}
                            label="matched"
                            runKey="search"
                          />
                        )}
                      </div>
                      <div className="pm-mpane-scroll" ref={scrollRef}>
                        {clearRow}
                        {searchGroups.map(({ p, models }) => (
                          <div key={p.id}>
                            {groupHeader(p, models.length)}
                            {models.map((m) => modelRow(p, m, true))}
                          </div>
                        ))}
                        {searchGroups.length === 0 && (
                          <div className="pm-modal-empty">
                            <span className="pm-empty-icon">
                              <SearchIcon size={15} />
                            </span>
                            <strong>No models match “{query.trim()}”</strong>
                            <span>Try a different search term.</span>
                          </div>
                        )}
                      </div>
                    </>
                  ) : effectiveTab === "__recent" ? (
                    <>
                      <div className="pm-mpane-head">
                        <span className="pm-mpane-title">Recent</span>
                        <span className="pm-mpane-sub">
                          {recentList.length} {recentList.length === 1 ? "model" : "models"}
                        </span>
                        {recentList.length > 0 && (
                          <RecentTestButton
                            entries={recentList.map(({ p, model }) => ({ cfg: p, model }))}
                          />
                        )}
                      </div>
                      <div className="pm-mpane-scroll" ref={scrollRef}>
                        {clearRow}
                        {recentList.map(({ p, model, pinned }) => {
                          const isCurrent = p.id === shownProviderId && model === shownModel;
                          const pinFull = !pinned && pinnedCount >= MAX_PINNED_RECENT_MODELS;
                          return (
                            <div
                              key={`${p.id}/${model}`}
                              className={`pm-model-row${pinned ? " pinned" : ""}`}
                            >
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
                        {recentList.length === 0 && (
                          <div className="pm-modal-empty">
                            <span className="pm-empty-icon">
                              <ClockIcon size={15} />
                            </span>
                            <strong>No recent models yet</strong>
                            <span>Models you pick in the composer collect here.</span>
                          </div>
                        )}
                      </div>
                    </>
                  ) : effectiveTab === "__checked" ? (
                    <>
                      <div className="pm-mpane-head">
                        <span className="pm-mpane-title">Checked</span>
                        <span className="pm-mpane-sub">
                          {checkedEntries.length}{" "}
                          {checkedEntries.length === 1 ? "model" : "models"}
                        </span>
                        {checkedEntries.length > 0 && (
                          <>
                            <RecentTestButton
                              entries={checkedEntries}
                              label="checked"
                              runKey="checked"
                            />
                            <button
                              type="button"
                              className="pm-recent-remove"
                              onClick={() => clearAllChecked()}
                              title="Dismiss all checked models"
                              aria-label="Dismiss all checked models"
                            >
                              <RemoveIcon size={12} />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="pm-mpane-scroll" ref={scrollRef}>
                        {clearRow}
                        {checkedGroups.map(({ p, models }) => (
                          <div key={p.id}>
                            {groupHeader(p, models.length)}
                            {models.map((m) =>
                              modelRow(p, m, false, true, checkedKeys.has(`${p.id}/${m}`)),
                            )}
                          </div>
                        ))}
                        {checkedGroups.length === 0 && (
                          <div className="pm-modal-empty">
                            <span className="pm-empty-icon">
                              <CheckCircleIcon size={15} />
                            </span>
                            <strong>No checked models yet</strong>
                            <span>Run a test on any model — the ones that pass collect here.</span>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    paneProvider && (
                      <>
                        <div className="pm-mpane-head">
                          <span className="pm-mpane-title">{providerDisplayName(paneProvider)}</span>
                          <span className="pm-mpane-sub">
                            {paneModels.length}{" "}
                            {paneModels.length === 1 ? "model" : "models"}
                          </span>
                          <ProviderTestButton cfg={paneProvider} models={paneModels} />
                        </div>
                        <div className="pm-mpane-scroll" ref={scrollRef}>
                          {clearRow}
                          {paneModels.map((m) => modelRow(paneProvider, m, false))}
                          {paneModels.length === 0 && (
                            <div className="pm-modal-empty">
                              <span className="pm-empty-icon">
                                <TestBoltIcon size={15} />
                              </span>
                              <strong>No models</strong>
                              <span>Check the provider’s base URL &amp; key.</span>
                            </div>
                          )}
                        </div>
                      </>
                    )
                  )}
                </section>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
