/**
 * MCP tool-name helpers: the agent exposes a unique MCP tool BARE and only
 * qualifies it when two connectors collide, so the UI must treat both forms
 * the same (the Browser panel docks on either).
 */
import { bareToolName, isBrowserTool, mcpServerOf } from "../src/lib/mcpTools";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}`, extra ?? "");
  }
}

check("bare name is unchanged", bareToolName("browser_navigate") === "browser_navigate");
check(
  "qualified name loses its prefix",
  bareToolName("mcp__playwright__browser_navigate") === "browser_navigate",
);
check(
  "a tool name containing __ keeps its tail",
  bareToolName("mcp__docker__list__containers") === "list__containers",
);
check("a malformed qualified name is left alone", bareToolName("mcp__docker") === "mcp__docker");

check("server of a bare name is empty", mcpServerOf("browser_navigate") === "");
check(
  "server of a qualified name is the connector",
  mcpServerOf("mcp__playwright__browser_navigate") === "playwright",
);

check("bare browser tool docks the panel", isBrowserTool("browser_navigate"));
check("qualified browser tool docks the panel", isBrowserTool("mcp__playwright__browser_click"));
check("a non-browser tool does not", !isBrowserTool("read"));
check("a non-browser MCP tool does not", !isBrowserTool("mcp__docker__list_containers"));

process.exit(failed ? 1 : 0);
