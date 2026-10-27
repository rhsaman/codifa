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
  if (c === "BracketLeft") return "[";
  if (c === "BracketRight") return "]";
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
  /** Non-command actions that App.tsx dispatches directly. `live` toggles
   *  the realtime voice session; `voice` is hold-Space dictation; `terminal`
   *  toggles the bottom terminal panel; `pane-left`/`pane-right` move focus
   *  across the app's three sections (sidebar ↔ chats ↔ right pane); and
   *  `terminal-focus` lands the caret in the bottom terminal, opening it.
   *  `terminal-next`/`terminal-prev` cycle the TERMINAL TABS ([ = previous,
   *  ] = next): right-pane terminal tabs first, the bottom panel's shells
   *  as the fallback. */
  action?:
    | "voice"
    | "live"
    | "terminal"
    | "pane-left"
    | "pane-right"
    | "terminal-focus"
    | "terminal-next"
    | "terminal-prev";
}

/** Second key (after Ctrl+X) -> the command it runs. Order is display order.
 *  The space entry is a direct action (toggle voice recording), not a slash
 *  command — App.tsx routes it before falling back to `cmd`. */
export const PREFIX_SHORTCUTS: Record<string, PrefixShortcut> = {
  u: { cmd: "/undo", label: "Undo the last exchange" },
  r: { cmd: "/redo", label: "Redo the last undone exchange" },
  c: { cmd: "/compact", label: "Summarize & compact the chat context" },
  v: { cmd: "/voice", label: "Toggle the live voice session", action: "live" },
  " ": { cmd: "/voice", label: "Hold Space to record voice", action: "voice" },
  j: { cmd: "", label: "Toggle the terminal panel", action: "terminal" },
  l: { cmd: "", label: "Move focus right: sidebar → chats → right pane", action: "pane-right" },
  h: { cmd: "", label: "Move focus left: right pane → chats → sidebar", action: "pane-left" },
  t: { cmd: "", label: "Focus the terminal (opens it if closed)", action: "terminal-focus" },
  "[": { cmd: "", label: "Previous terminal tab", action: "terminal-prev" },
  "]": { cmd: "", label: "Next terminal tab", action: "terminal-next" },
};

/** Move direction for the direct chord (Cmd/Ctrl + H/J/K/L, no Ctrl+X prefix).
 *  Vim-style: h=left, j=down, k=up, l=right. Pure, for test. */
export type PrefixMoveDir = "left" | "down" | "up" | "right";

export function prefixMoveDir(key: string | null | undefined): PrefixMoveDir | null {
  const k = (key ?? "").toLowerCase();
  if (k === "h") return "left";
  if (k === "j") return "down";
  if (k === "k") return "up";
  if (k === "l") return "right";
  return null;
}

/** Which chat-window move (or none) a direct Cmd/Ctrl+H/J/K/L chord requests.
 *  True when the event is a bare Cmd/Ctrl chord (no Shift/Alt/other modifier)
 *  of exactly one of the four movement keys. Pure, for test. */
export function isWindowMoveChord(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): PrefixMoveDir | null {
  if (e.shiftKey || e.altKey) return null;
  if (!(e.ctrlKey || e.metaKey)) return null;
  return prefixMoveDir(physicalKey(e));
}

/** True on macOS/iOS — decides which half of the Cmd/Ctrl convention a chord
 *  uses (Cmd on Apple platforms, Ctrl elsewhere). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(p);
}

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
  {
    keys: "Cmd/Ctrl+F",
    label: "Find in the focused chat transcript — highlight all matches, Enter/Shift+Enter or the arrows to step, Esc to close",
  },
  { keys: "Tab", label: "Cycle agent mode (Ask / Plan / Build)" },
  { keys: "/", label: "Open command palette" },
  { keys: "Cmd/Ctrl+M", label: "Fullscreen what has focus — the bottom terminal, else the right pane, else the focused chat window (press again to restore)" },
  { keys: "Cmd/Ctrl+T", label: "Start a new chat" },
  { keys: "Cmd/Ctrl+P", label: "Quick-open / search overlay (⌘⇧F = content search)" },
  { keys: "Cmd/Ctrl+B", label: "Toggle sidebar" },
  { keys: "Cmd/Ctrl+Shift+B", label: "Toggle right panel" },
  { keys: "Ctrl+X then J", label: "Toggle the terminal panel (the only terminal toggle — works while the caret is inside the terminal too)" },
  { keys: "Ctrl+X then [ / ]", label: "Previous / next TERMINAL tab — cycles the right-pane terminal tabs (reveals the pane if closed); with no terminal tabs there, cycles the bottom panel's shells" },
  { keys: "Ctrl+H/J/K/L", label: "Move focus between the split CHAT windows vim-style (k=up, j=down, h=left, l=right) — to the window that really lies in that direction, nothing beyond them. The three sections (sidebar / chats / right pane / terminal) are reached only with Ctrl+X then L/H/T" },
  { keys: "Shift+Alt(Option)+H/J/K/L", label: "Swap (move) chat window positions in the same vim directions" },
  {
    keys: "Cmd+W",
    label: "Close the active tab (terminal while it has focus, else viewer, else chat); Ctrl+W on Linux/Windows. Bare Ctrl+W stays the shell's delete-word (^W)",
  },
  { keys: "Cmd/Ctrl+,", label: "Open settings" },
  { keys: "Cmd/Ctrl+O", label: "Open a workspace folder" },
];

/** Which panel a Cmd/Ctrl+B chord should toggle: plain chord toggles the
 *  sidebar, Shift-modified chord toggles the right panel. Returns null when
 *  the event is not a panel-toggle chord. Layout-independent via physicalKey
 *  so it works on Persian/Arabic layouts too. */
export function panelToggleTarget(e: {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): 'sidebar' | 'right' | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (physicalKey(e) !== 'b') return null;
  return e.shiftKey ? 'right' : 'sidebar';
}

export function formatGlobalShortcut(sc: GlobalShortcut): string {
  return `\`${sc.keys}\` — ${sc.label}`;
}
