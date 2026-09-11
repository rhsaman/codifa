/** tmux-style prefix shortcuts (Ctrl+X then a key).
 *  Shared by the global key handler (App.tsx), the /help text and the prefix
 *  toast (Chat.tsx) so the bindings always stay in sync. */
export const PREFIX_LABEL = "Ctrl+X";

/** The `e.code`-normalized value of the prefix chord, before another modifier
 *  (layout-independent: `x` on ANY physical keyboard layout, incl. Persian). */
export const PREFIX_KEY = "x";

/** Map a keydown to its layout-independent physical key so shortcuts keep
 *  working with non-Latin layouts (Persian, Arabic, …), where `e.key` returns
 *  the localized character instead of the Latin letter (e.g. Physical X → "خ").
 *  Falls back to the lowercased `e.key` for codes without a Key/Comma/Slash
 *  form (Enter, Tab, arrows, digits… are already layout-independent). */
export function physicalKey(e: { code: string; key: string }): string {
  const c = e.code || "";
  if (c.startsWith("Key")) return c.slice(3).toLowerCase();
  if (c === "Comma") return ",";
  if (c === "Slash") return "/";
  return (e.key || "").toLowerCase();
}

/** کورد ناوبری لیست: +1 یعنی حرکت به پایین، -1 یعنی بالا و 0 یعنی کلید
 *  ناوبری نیست. ArrowDown/ArrowUp و کوردهای Ctrl/⌘ (J/N پایین، K/P بالا)
 *  را می‌سنجد — با physicalKey تا چیدمان‌های غیرلاتین (فارسی و…) هم کار
 *  کند. مشترک بین همه پیکرها (پالت فرمان، @mention اسکیل، ابزارهای MCP)
 *  تا همه دقیقاً همان کوردها را ببلعند — ببینید onKeyDown در Chat.tsx. */
export function navChord(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): number {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  if (e.ctrlKey || e.metaKey) {
    const k = physicalKey(e);
    if (k === "j" || k === "n") return 1;
    if (k === "k" || k === "p") return -1;
  }
  return 0;
}

/** آیا این Cmd/Ctrl+K که به سطح window رسیده باید هنوز سرچ چت سایدبار را
 *  فوکوس کند؟ پیکرها کورد ناوبری‌شان را با preventDefault + stopPropagation
 *  (navChord در Chat.tsx) می‌بلعند؛ پس رویدادی که defaultPrevented شده مالِ
 *  یک پیکرِ در فوکوس است و سایدبار نباید فوکوس را از او بدزدد
 *  (رگرسیون: Ctrl+K داخل پیکر @mention فوکوس را به سرچ سایدبار می‌برد). */
export function shouldFocusSearch(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !e.defaultPrevented &&
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "k"
  );
}

export interface PrefixShortcut {
  /** Slash command this key triggers, e.g. "/compact". */
  cmd: string;
  /** Short human description, e.g. "Compact the chat context". */
  label: string;
  /** Non-command actions that App.tsx dispatches directly (e.g. voice). */
  action?: "voice";
}

/** Second key (after Ctrl+X) -> the command it runs. Order is display order.
 *  The space entry is a direct action (toggle voice recording), not a slash
 *  command — App.tsx routes it before falling back to `cmd`. */
export const PREFIX_SHORTCUTS: Record<string, PrefixShortcut> = {
  u: { cmd: "/undo", label: "Undo the last exchange" },
  r: { cmd: "/redo", label: "Redo the last undone exchange" },
  c: { cmd: "/compact", label: "Summarize & compact the chat context" },
  " ": { cmd: "/voice", label: "Hold Space to record voice", action: "voice" },
};

/** Render one line of help/README for a shortcut, e.g. "Ctrl+X u — Undo…". */
export function formatShortcut(key: string, sc: PrefixShortcut): string {
  const k = key === " " ? "Space" : key;
  return `\`${PREFIX_LABEL} ${k}\` — ${sc.label}`;
}

/** Standalone (non-prefix) shortcuts shown in /help and the empty-chat guide.
 *  Order is display order. */
export interface GlobalShortcut {
  keys: string;
  label: string;
}

export const GLOBAL_SHORTCUTS: GlobalShortcut[] = [
  { keys: "Enter", label: "Send message (Shift+Enter = newline)" },
  {
    keys: "Cmd/Ctrl+Enter",
    label: "Queue the message (sends after the current turn, won't interrupt)",
  },
  { keys: "Tab", label: "Cycle agent mode (Ask / Plan / Coder)" },
  { keys: "/", label: "Open command palette" },
  { keys: "Cmd/Ctrl+M", label: "Cycle agent mode (Ask / Plan / Coder)" },
  { keys: "Cmd/Ctrl+T", label: "Start a new chat" },
  { keys: "Cmd/Ctrl+P", label: "Quick-open / search overlay (⌘⇧F = content search)" },
  { keys: "Cmd/Ctrl+B", label: "Toggle sidebar" },
  { keys: "Cmd/Ctrl+,", label: "Open settings" },
  { keys: "Cmd/Ctrl+O", label: "Open a workspace folder" },
];

export function formatGlobalShortcut(sc: GlobalShortcut): string {
  return `\`${sc.keys}\` — ${sc.label}`;
}
