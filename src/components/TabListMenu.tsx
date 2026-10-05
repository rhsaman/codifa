import { useEffect, useRef, useState } from "react";
import { fmtAgo } from "../lib/time";

export interface TabListEntry {
  key: string;
  title: string;
  icon?: React.ReactNode;
  /** Timestamp the relative age is shown for (created / last activity /
   *  closed at). Omit to hide the age column. */
  age?: number;
  active?: boolean;
  onOpen: () => void;
  onClose?: () => void;
}

export interface TabListSection {
  label: string;
  entries: TabListEntry[];
}

/** Chevron button at the start of a tab bar: opens the searchable full tab
 *  list (open tabs with ages + close buttons, then recently closed tabs).
 *  The bars themselves stop scrolling — tabs squeeze instead — so this list
 *  is the way to reach/see every tab when there are many. */
export function TabListButton({
  sections,
  label,
}: {
  sections: TabListSection[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".tab-list-wrap") && !t.closest(".tab-list-menu")) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      // Clamp inside the viewport: the chevron can sit near the window's
      // right edge (RTL), and the fixed menu must never poke out.
      const left = Math.max(12, Math.min(r.left, window.innerWidth - 412));
      setPos({ top: r.bottom + 6, left });
    }
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const q = query.trim().toLowerCase();
  const visible = sections
    .map((s) => ({
      ...s,
      entries: q
        ? s.entries.filter((e) => e.title.toLowerCase().includes(q))
        : s.entries,
    }))
    .filter((s) => s.entries.length > 0);

  return (
    <span className="tab-list-wrap" ref={wrapRef}>
      <button
        type="button"
        className="tab-list-btn"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9.5l6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div
          className="tab-list-menu"
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <label className="tab-list-search">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search tabs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {visible.length === 0 && (
            <div className="tab-list-empty">No tabs match.</div>
          )}
          {visible.map((s) => (
            <div key={s.label} className="tab-list-section">
              <div className="tab-list-section-label">{s.label}</div>
              {s.entries.map((e) => (
                <div
                  key={e.key}
                  className={`tab-list-item${e.active ? " active" : ""}`}
                >
                  <button
                    type="button"
                    className="tab-list-open"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      e.onOpen();
                    }}
                  >
                    {e.icon && <span className="tab-list-icon">{e.icon}</span>}
                    <span className="tab-list-title">{e.title}</span>
                  </button>
                  {e.age !== undefined && (
                    <span className="tab-list-age">{fmtAgo(e.age)}</span>
                  )}
                  {e.onClose && (
                    <button
                      type="button"
                      className="tab-list-close"
                      title="Close tab"
                      aria-label={`Close ${e.title}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        e.onClose?.();
                      }}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
