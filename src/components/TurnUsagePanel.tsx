import { useEffect, useState } from "react";
import type { ChatMessage, PluginInfo } from "../types";
import type { SkillRow } from "../lib/api";
import { ensureSidecar } from "../lib/api";
import { ensureChatTail, useStore } from "../lib/store";
import { listPlugins } from "../lib/plugins";
import { PanelChevron, ToolsIcon } from "./PanelIcons";
import { ensureSkillsList, getSkillsList } from "../lib/skills";
import {
  pluginDisplayName,
  skillOwner,
  turnStart,
  turnUsage,
  usagePlugins,
  type TurnUsage,
} from "../lib/turnUsage";

/** Connector → server name without its `mcp__<server>__` prefix. */
function bareTool(tool: string): string {
  if (!tool.startsWith("mcp__")) return tool;
  const rest = tool.slice(5);
  const i = rest.indexOf("__");
  return i > 0 ? rest.slice(i + 2) : tool;
}

/** Kind glyph of a row in the card (skill spark / connector plug / plugin box). */
function TuKindIcon({ kind }: { kind: "skill" | "connector" | "plugin" }) {
  const p = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "skill") {
    return (
      <svg {...p}>
        <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z" />
        <path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
      </svg>
    );
  }
  if (kind === "connector") {
    return (
      <svg {...p}>
        <path d="M9 3v5M15 3v5" />
        <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
        <path d="M12 17v4" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  );
}

/** Skills/MCP/plugins of the CURRENT turn — the same per-chat window the Todos
 *  card uses (newest user message → end of the transcript). Attached skills and
 *  enabled connectors come from that message; a `load_skill` call anywhere
 *  after it marks the skill as actually used.
 *
 *  Always LTR: skill/connector names are English identifiers, so the card must
 *  not mirror inside an RTL locale (the plan card below keeps the app dir). */
export function TurnUsageSection({
  messages,
}: {
  messages: ChatMessage[];
}) {
  const [catalog, setCatalog] = useState<SkillRow[]>(getSkillsList);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  // The catalog fetches over the sidecar, which may not be up yet on first
  // paint — read the cache straight away and refresh once it resolves. A bridge
  // without a backend (web preview, tests) must not reject into the effect.
  useEffect(() => {
    let alive = true;
    void ensureSkillsList()
      .then((rows) => {
        if (alive) setCatalog(rows);
      })
      .catch(() => {});
    void ensureSidecar()
      .then((url) => {
        if (!alive || !url) return;
        void listPlugins().then((out) => {
          if (alive && !("error" in out)) setPlugins(out);
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const usage: TurnUsage = turnUsage(messages);
  const owners = usagePlugins(usage, catalog, plugins);
  // A plugin the agent LOADED this turn (load_plugin / plugin run) is a used
  // row, not mere context like an owning plugin. Without this a toolbox with no
  // skill or connector of its own never appeared on the card at all.
  const loadedPlugins = new Set(
    (usage.plugins ?? []).map((p) => pluginDisplayName(p.name, plugins)),
  );
  // "Used" here means the model LOADED the connector this turn (`use_mcp`) or
  // called one of its tools — a connector can be enabled and never touched, and
  // that distinction is the whole point: an untouched one cost the turn an index
  // line, not its schemas (the trace already shows the calls).
  const connectorTools = new Map<string, string[]>();
  if (usage.mcp.length > 0) {
    const enabled = new Set(usage.mcp.map((c) => c.name));
    const start = turnStart(messages);
    for (const m of messages.slice(start + 1)) {
      for (const a of m.toolActivity ?? []) {
        if (!a.tool.startsWith("mcp__")) continue;
        const server = a.tool.slice(5, a.tool.indexOf("__", 5));
        if (!enabled.has(server)) continue;
        const list = connectorTools.get(server) ?? [];
        const name = bareTool(a.tool);
        if (!list.includes(name)) list.push(name);
        connectorTools.set(server, list);
      }
    }
  }

  // Used first: the card answers "what did this turn actually RUN with", so a
  // skill the agent loaded must never sit below one that was only attached.
  const skills = [...usage.skills].sort(
    (a, b) => Number(b.used) - Number(a.used),
  );
  const connectors = usage.mcp.map((c) => ({
    name: c.name,
    used: c.used,
    tools: connectorTools.get(c.name) ?? [],
  }));
  const total = usage.skills.length + usage.mcp.length + owners.length;

  // Nothing attached and nothing used → NO card. The old "runs without
  // skills…" paragraph was a whole empty card for a fact nobody asked for; the
  // page-level hint speaks only when every card on the page is empty.
  if (total === 0) return null;

  // The card's rows: used first, then attached/enabled-but-untouched, then the
  // owning plugins (no state — they are context, not something that ran).
  type TuRow = {
    key: string;
    kind: "skill" | "connector" | "plugin";
    name: string;
    sub: string;
    state: "used" | "idle" | "plain";
    title: string;
  };
  const rows: TuRow[] = [];
  for (const s of skills) {
    rows.push({
      key: `skill-${s.name}`,
      kind: "skill",
      name: s.name,
      sub: skillOwner(s.name, catalog) || "Skill",
      state: s.used ? "used" : "idle",
      title: s.used ? "Loaded by the agent this turn" : "Attached to this turn, not loaded",
    });
  }
  for (const c of connectors) {
    const used = c.used || c.tools.length > 0;
    rows.push({
      key: `mcp-${c.name}`,
      kind: "connector",
      name: c.name,
      sub: c.tools.length > 0 ? `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}` : "Connector",
      state: used ? "used" : "idle",
      title: c.tools.length > 0 ? c.tools.join(", ") : used ? "Loaded by the agent this turn" : "Enabled for this turn, never called",
    });
  }
  rows.sort((a, b) => Number(b.state === "used") - Number(a.state === "used"));
  for (const name of owners) {
    const used = loadedPlugins.has(name);
    rows.push({
      key: `plugin-${name}`,
      kind: "plugin",
      name,
      sub: used ? "Loaded this turn" : "Plugin",
      state: used ? "used" : "plain",
      title: used
        ? "Loaded by the agent this turn"
        : "Plugin that provides this turn's tools",
    });
  }
  const usedCount = rows.filter((r) => r.state === "used").length;
  const idleCount = rows.filter((r) => r.state === "idle").length;

  return (
    <div
      className={`sidebar-panel usage-docked${collapsed ? " collapsed" : ""}`}
      dir="ltr"
    >
      <div
        className="sidebar-panel-head"
        role="button"
        tabIndex={0}
        title="Click to collapse"
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
      >
        <span className="sidebar-panel-chevron">
          <PanelChevron collapsed={collapsed} />
        </span>
        <span className="sidebar-panel-icon">
          <ToolsIcon />
        </span>
        <span className="sidebar-panel-title">This turn's tools</span>
        <span className="sidebar-panel-count">{total}</span>
      </div>
      {!collapsed && (
        <div className="tu-body">
          {/* One calm list instead of boxed groups: every entry is a row with a
              kind icon, its name, where it comes from and a state pill. What the
              turn RAN comes first; attached-but-untouched entries follow dimmed. */}
          <div className="tu-summary">
            <span className="tu-sum used">{`${usedCount} used`}</span>
            {idleCount > 0 && (
              <span className="tu-sum idle">{`${idleCount} not used`}</span>
            )}
            {owners.length > 0 && (
              <span className="tu-sum idle">{`${owners.length} plugin${owners.length === 1 ? "" : "s"}`}</span>
            )}
          </div>
          <ul className="tu-list">
            {rows.map((r) => (
              <li
                key={r.key}
                className={`tu-row ${r.state}`}
                title={r.title}
              >
                <span className={`tu-icon ${r.kind}`} aria-hidden="true">
                  <TuKindIcon kind={r.kind} />
                </span>
                <span className="tu-main">
                  <span className="tu-name">{r.name}</span>
                  <span className="tu-sub">{r.sub}</span>
                </span>
                {r.state !== "plain" && (
                  <span className={`tu-state ${r.state}`}>
                    {r.state === "used" ? "Used" : "Not used"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Docked "This turn's tools" card — the right panel's variant. It reads the
 *  ACTIVE chat and dir from the store exactly like TodosSection does, so the
 *  panel never pipes messages through and switching chats switches both cards
 *  at once. */
export function TurnUsagePanel() {
  const chat = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId) ?? null,
  );
  // The index row carries no `messages` — the transcript panel hydrates the
  // active chat, but this card can mount first (panel reopened, chat just
  // switched) and would then report an empty turn. Ask for the NEWEST page
  // only: this card describes the current turn, which is always in the tail,
  // and a full hydration here would load the entire history on every switch.
  const needsBody = chat?.hydrated === false;
  const chatId = chat?.id ?? "";
  useEffect(() => {
    if (chatId && needsBody) void ensureChatTail(chatId);
  }, [chatId, needsBody]);
  return <TurnUsageSection messages={needsBody ? [] : (chat?.messages ?? [])} />;
}
