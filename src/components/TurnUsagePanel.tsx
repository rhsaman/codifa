import { useEffect, useState } from "react";
import type { ChatMessage, PluginInfo } from "../types";
import type { SkillRow } from "../lib/api";
import { ensureSidecar } from "../lib/api";
import { listPlugins } from "../lib/plugins";
import { ensureSkillsList, getSkillsList } from "../lib/skills";
import {
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

/** Skills/MCP/plugins of the CURRENT turn — the same per-chat window the Todos
 *  card uses (newest user message → end of the transcript). Attached skills and
 *  enabled connectors come from that message; a `load_skill` call anywhere
 *  after it marks the skill as actually used. */
export function TurnUsageSection({
  messages,
  dir,
}: {
  messages: ChatMessage[];
  dir: "rtl" | "ltr";
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
  // "Used" here means the connector was offered at least one tool to this turn
  // — a connector can be enabled and still never be called, so the card says
  // what the turn RAN WITH, not a call count (the trace already shows calls).
  const connectorTools = new Map<string, string[]>();
  if (usage.mcp.length > 0) {
    const start = turnStart(messages);
    for (const m of messages.slice(start + 1)) {
      for (const a of m.toolActivity ?? []) {
        if (!a.tool.startsWith("mcp__")) continue;
        const server = a.tool.slice(5, a.tool.indexOf("__", 5));
        if (!usage.mcp.includes(server)) continue;
        const list = connectorTools.get(server) ?? [];
        const name = bareTool(a.tool);
        if (!list.includes(name)) list.push(name);
        connectorTools.set(server, list);
      }
    }
  }

  const total = usage.skills.length + usage.mcp.length + owners.length;

  return (
    <div
      className={`sidebar-panel usage-docked${collapsed ? " collapsed" : ""}`}
      dir={dir}
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
        <span className="sidebar-panel-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="sidebar-panel-title">This turn</span>
        <span className="sidebar-panel-count">{total}</span>
      </div>
      {!collapsed && (
        <div className="turn-usage-body">
          {usage.skills.length > 0 && (
            <section className="turn-usage-group">
              <h4 className="turn-usage-label">Skills</h4>
              <ul className="turn-usage-list">
                {usage.skills.map((s) => (
                  <li
                    className={`turn-usage-chip${s.used ? " used" : ""}`}
                    key={`skill-${s.name}`}
                    title={s.used ? "Loaded by the agent this turn" : "Attached to this turn"}
                  >
                    <span className="turn-usage-dot" aria-hidden="true" />
                    <span className="turn-usage-name">{s.name}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {usage.mcp.length > 0 && (
            <section className="turn-usage-group">
              <h4 className="turn-usage-label">MCP</h4>
              <ul className="turn-usage-list">
                {usage.mcp.map((name) => {
                  const tools = connectorTools.get(name) ?? [];
                  return (
                    <li
                      className="turn-usage-chip"
                      key={`mcp-${name}`}
                      title={tools.length > 0 ? tools.join(", ") : "Enabled for this turn"}
                    >
                      <span className="turn-usage-dot" aria-hidden="true" />
                      <span className="turn-usage-name">{name}</span>
                      {tools.length > 0 && (
                        <span className="turn-usage-meta">· {tools.length}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {owners.length > 0 && (
            <section className="turn-usage-group">
              <h4 className="turn-usage-label">Plugins</h4>
              <ul className="turn-usage-list">
                {owners.map((name) => (
                  <li className="turn-usage-chip" key={`plugin-${name}`}>
                    <span className="turn-usage-dot" aria-hidden="true" />
                    <span className="turn-usage-name">{name}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {total === 0 && (
            <p className="turn-usage-empty">
              This turn runs without skills, MCP connectors or plugins.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
