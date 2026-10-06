// Unit tests for multi-window header meta + per-chat event isolation.
// Run: npx esbuild src/lib/chatWindowMeta.test.ts --bundle --platform=node
//        --format=esm --outfile=/tmp/chatWindowMeta.test.mjs && node /tmp/chatWindowMeta.test.mjs
import {
  resolveChatModel,
  shouldHandleForChat,
  workspaceBaseName,
  workspaceDisplayFor,
  workspaceKeyFor,
} from "./chatWindowMeta";

export {};

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("1) workspaceBaseName — last segment, trailing slashes trimmed:");
{
  check("unix path", workspaceBaseName("/a/b/codifa") === "codifa");
  check("trailing slash", workspaceBaseName("/a/b/codifa/") === "codifa");
  check("windows path", workspaceBaseName("C:\\proj\\my-app") === "my-app");
  check("empty -> No project", workspaceBaseName("") === "No project");
  check("null -> No project", workspaceBaseName(null) === "No project");
}

console.log("2) workspaceKeyFor — empty root buckets to __none__:");
{
  check("empty", workspaceKeyFor("") === "__none__");
  check("null", workspaceKeyFor(null) === "__none__");
  check("root passthrough", workspaceKeyFor("/a/b") === "/a/b");
}

console.log("3) workspaceDisplayFor — label/color/root resolution:");
{
  const d = workspaceDisplayFor("/a/b/codifa", [], {});
  check("fallback label is basename", d.label === "codifa", d);
  check("fallback color is accent", d.color === "var(--accent)", d);
  check("fallback root passthrough", d.root === "/a/b/codifa", d);
  const ws = [{ key: "/a/b/codifa", root: "/a/b/codifa", label: "My Project" }];
  const d2 = workspaceDisplayFor("/a/b/codifa", ws, { "/a/b/codifa": "#ff0000" });
  check("persisted label wins", d2.label === "My Project", d2);
  check("custom color wins", d2.color === "#ff0000", d2);
  const d3 = workspaceDisplayFor("", [], {});
  check("no project label", d3.label === "No project", d3);
  check("no project key", d3.key === "__none__", d3);
}

console.log("4) shouldHandleForChat — only the focused chat handles global events:");
{
  check("focused handles", shouldHandleForChat("a", "a") === true);
  check("unfocused ignores", shouldHandleForChat("a", "b") === false);
  check("empty own ignores", shouldHandleForChat("a", "") === false);
  check("null active ignores", shouldHandleForChat(null, "a") === false);
  // Regression: attach-file / toggle-voice fan-out — one dispatch must hit
  // exactly one panel (the focused one), never all mounted panels.
  const active = "chat-1";
  const panels = ["chat-1", "chat-2", "chat-3"];
  const handled = panels.filter((id) => shouldHandleForChat(active, id));
  check("exactly one panel handles", JSON.stringify(handled) === JSON.stringify(["chat-1"]), handled);
}

console.log("5) resolveChatModel — each window shows its own chat model:");
{
  const providers = [
    { id: "openrouter", model: "global-model" },
    { id: "nvidia", model: "nvidia-default" },
  ];
  const a = resolveChatModel({ providerId: "nvidia", model: "chat-a-model" }, providers, "openrouter");
  check("override keeps its model", a.providerId === "nvidia" && a.model === "chat-a-model", a);
  const b = resolveChatModel({}, providers, "openrouter");
  check("no override follows global", b.providerId === "openrouter" && b.model === "global-model", b);
  const c = resolveChatModel({ providerId: "deleted", model: "x" }, providers, "openrouter");
  check("deleted provider falls back", c.providerId === "openrouter" && c.model === "global-model", c);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat window meta checks passed");
