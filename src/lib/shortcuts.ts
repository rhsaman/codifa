/** tmux-style prefix shortcuts (Ctrl+A then a key).
 *  Shared by the global key handler (App.tsx), the /help text and the prefix
 *  toast (Chat.tsx) so the bindings always stay in sync. */
export const PREFIX_LABEL = "Ctrl+A";

/** The `e.key` value (lowercased) of the prefix chord, before another modifier. */
export const PREFIX_KEY = "a";

export interface PrefixShortcut {
  /** Slash command this key triggers, e.g. "/compact". */
  cmd: string;
  /** Short human description, e.g. "Compact the chat context". */
  label: string;
}

/** Second key (after Ctrl+A) -> the command it runs. Order is display order. */
export const PREFIX_SHORTCUTS: Record<string, PrefixShortcut> = {
  u: { cmd: "/undo", label: "Undo the last exchange" },
  r: { cmd: "/redo", label: "Redo the last undone exchange" },
  c: { cmd: "/compact", label: "Summarize & compact the chat context" },
  x: { cmd: "/clear", label: "Clear all messages in this chat" },
};

/** Render one line of help/README for a shortcut, e.g. "Ctrl+A u — Undo…". */
export function formatShortcut(key: string, sc: PrefixShortcut): string {
  return `\`${PREFIX_LABEL} ${key}\` — ${sc.label}`;
}

/** Standalone (non-prefix) shortcuts shown in /help and the empty-chat guide.
 *  Order is display order. */
export interface GlobalShortcut {
  keys: string;
  label: string;
}

export const GLOBAL_SHORTCUTS: GlobalShortcut[] = [
  { keys: "Enter", label: "Send message (Shift+Enter = newline)" },
  { keys: "Tab", label: "Cycle agent mode (Ask / Plan / Coder)" },
  { keys: "/", label: "Open command palette" },
  { keys: "Cmd/Ctrl+M", label: "Cycle agent mode (Ask / Plan / Coder)" },
  { keys: "Cmd/Ctrl+T", label: "Start a new chat" },
  { keys: "Cmd/Ctrl+P", label: "Quick-open / search overlay (⌘⇧F = content search)" },
  { keys: "Cmd/Ctrl+B", label: "Toggle sidebar" },
  { keys: "Cmd/Ctrl+,", label: "Open settings" },
  { keys: "Cmd/Ctrl+O", label: "Open a workspace folder" },
  { keys: "Cmd/Ctrl+Shift+M", label: "Hold to record voice" },
];

export function formatGlobalShortcut(sc: GlobalShortcut): string {
  return `\`${sc.keys}\` — ${sc.label}`;
}
