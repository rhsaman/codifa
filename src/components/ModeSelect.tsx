import { useState } from "react";
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

  return (
    <div className={`mode-select${iconOnly ? " icon-only" : ""}`}>
      <button
        type="button"
        className={iconOnly ? "icon-btn mode-btn" : "mode-select-current"}
        onClick={() => setOpen((o) => !o)}
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
        <div className="mode-menu">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
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