import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentMode, AgentModeDef } from "../types";
import { ModeIcon } from "./ModeIcon";

export function ModeSelect({
  modes,
  value,
  onChange,
  iconOnly,
}: {
  modes: AgentModeDef[];
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = modes.find((m) => m.id === value) ?? modes[0];
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div ref={wrapRef} className={`mode-select${iconOnly ? " icon-only" : ""}`}>
      <button
        type="button"
        className={iconOnly ? "icon-btn mode-btn" : "mode-select-current"}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${current.label} — applies to this chat only (Tab / ⌘M cycles modes)`}
      >
        {!iconOnly && (
          <span className="mode-select-icon"><ModeIcon icon={current.icon} /></span>
        )}
        {iconOnly ? (
          <>
            <span className="mode-btn-dot" />
            <span className="mode-btn-label">{current.label}</span>
          </>
        ) : (
          <>
            <span className="mode-select-label">{current.label}</span>
            <span className="mode-select-caret">{open ? "▲" : "▼"}</span>
          </>
        )}
      </button>
      {open && (
        <div className="mode-menu" role="listbox" aria-label="Chat mode">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              className={`mode-menu-item ${m.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="mode-select-icon"><ModeIcon icon={m.icon} /></span>
              <span className="mode-menu-text">
                <span className="mode-menu-label">{m.label}</span>
                <span className="mode-menu-desc">{m.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
