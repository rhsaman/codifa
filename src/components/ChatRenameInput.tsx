import { useEffect, useRef, useState } from "react";

/** Normalize a rename input value (sidebar-style): trimmed text or
 *  the "New chat" fallback when empty. Shared by the window header
 *  and the tab bar so empty commits behave the same everywhere. */
export function normalizeRenameValue(value: string): string {
  const trimmed = value.trim();
  return trimmed || "New chat";
}

/** Shared rename input for chat titles (sidebar-style editing).
 *  Used by the window header and the chat tab bar so the commit/cancel
 *  logic (Enter/Blur saves, Escape cancels, autofocus + select) stays
 *  in one place. Pure commit/cancel callbacks so it stays SSR-testable. */
export function ChatRenameInput({
  initialValue,
  dir,
  className,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  dir?: string;
  className?: string;
  ariaLabel?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = (v: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(v);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      className={className ?? "chat-rename-input"}
      dir={dir}
      value={value}
      aria-label={ariaLabel ?? "Rename chat"}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(value);
        else if (e.key === "Escape") cancel();
      }}
      onClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
    />
  );
}
