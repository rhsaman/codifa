import { useEffect, useState } from "react";
import type { ChatMessage, PluginInfo } from "../types";
import type { SkillRow } from "../lib/api";
import { ensureSidecar } from "../lib/api";
import { ensureChatHydrated, useStore } from "../lib/store";
import { listPlugins } from "../lib/plugins";
import { ensureSkillsList, getSkillsList } from "../lib/skills";
import {
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
  // Split ONCE: the Used row states what ran, so the groups below carry only
  // what was attached/enabled and left untouched. Listing a used skill in both
  // places was the panel's real noise (the same chip appeared twice).
  const unusedSkills = skills.filter((s) => !s.used);
  const unusedConnectors = connectors.filter((c) => !c.used && c.tools.length === 0);

  const total = usage.skills.length + usage.mcp.length + owners.length;

  // The Used row: exactly what the turn ran, listed here ONCE and never again
  // in the groups below (those keep the untouched inventory). A skill's owning
  // plugin rides along as its meta suffix ("Ponytail · Dev Kit").
  const usedChips: Array<{
    key: string;
    name: string;
    meta?: string;
    title: string;
  }> = [];
  for (const s of skills) {
    if (!s.used) continue;
    usedChips.push({
      key: `used-skill-${s.name}`,
      name: s.name,
      meta: skillOwner(s.name, catalog) || undefined,
      title: "Loaded by the agent this turn",
    });
  }
  for (const c of connectors) {
    if (!c.used && c.tools.length === 0) continue;
    usedChips.push({
      key: `used-mcp-${c.name}`,
      name: c.name,
      meta: c.tools.length > 0 ? `· ${c.tools.length}` : undefined,
      title:
        c.tools.length > 0
          ? c.tools.join(", ")
          : "Loaded by the agent this turn",
    });
  }

  // Nothing attached and nothing used → NO card. The old "runs without
  // skills…" paragraph was a whole empty card for a fact nobody asked for; the
  // page-level hint speaks only when every card on the page is empty.
  if (total === 0) return null;

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
        <span className="sidebar-panel-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="sidebar-panel-title">This turn's tools</span>
        <span className="sidebar-panel-count">{total}</span>
      </div>
      {!collapsed && (
        <div className="turn-usage-body">
          {/* What the turn ACTUALLY ran with, first and as one row of chips:
              the card's job is answering that before listing the inventory
              below. An entry repeats its own group on purpose — the same skill
              is both "attached" and "used", and only this row says so at a
              glance. */}
          {usedChips.length > 0 && (
            <section className="turn-usage-group turn-usage-group-used">
              <h4 className="turn-usage-label">
                Used
                <span className="turn-usage-count">{usedChips.length}</span>
              </h4>
              <ul className="turn-usage-list">
                {usedChips.map((c) => (
                  <li
                    className="turn-usage-chip used"
                    key={c.key}
                    title={c.title}
                  >
                    <span className="turn-usage-dot" aria-hidden="true" />
                    <span className="turn-usage-name">{c.name}</span>
                    {c.meta && <span className="turn-usage-meta">{c.meta}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {unusedSkills.length > 0 && (
            <section className="turn-usage-group">
              <h4
                className="turn-usage-label"
                title="Attached to this turn but never loaded"
              >
                Skills
                <span className="turn-usage-count">{unusedSkills.length}</span>
              </h4>
              <ul className="turn-usage-list">
                {unusedSkills.map((s) => {
                  // The owning plugin tells a store skill from a bundled one
                  // without opening Settings ("Ponytail · Dev Kit").
                  const owner = skillOwner(s.name, catalog);
                  return (
                    <li
                      className="turn-usage-chip"
                      key={`skill-${s.name}`}
                      title="Attached to this turn, not loaded"
                    >
                      <span className="turn-usage-dot" aria-hidden="true" />
                      <span className="turn-usage-name">{s.name}</span>
                      {owner && <span className="turn-usage-meta">{owner}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {unusedConnectors.length > 0 && (
            <section className="turn-usage-group">
              <h4
                className="turn-usage-label"
                title="Enabled for this turn but never called"
              >
                Connectors
                <span className="turn-usage-count">
                  {unusedConnectors.length}
                </span>
              </h4>
              <ul className="turn-usage-list">
                {unusedConnectors.map(({ name }) => (
                  <li
                    className="turn-usage-chip"
                    key={`mcp-${name}`}
                    title="Enabled for this turn, never called"
                  >
                    <span className="turn-usage-dot" aria-hidden="true" />
                    <span className="turn-usage-name">{name}</span>
                  </li>
                ))}
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
  // The index row carries no `messages` — TodosSection hydrates the active
  // chat, but this card can mount first (panel reopened, chat just switched)
  // and would then report an empty turn while the transcript is full. Ask for
  // the body too; the call resolves immediately when it is already loaded.
  const needsBody = chat?.hydrated === false;
  const chatId = chat?.id ?? "";
  useEffect(() => {
    if (chatId && needsBody) void ensureChatHydrated(chatId);
  }, [chatId, needsBody]);
  return <TurnUsageSection messages={needsBody ? [] : (chat?.messages ?? [])} />;
}
