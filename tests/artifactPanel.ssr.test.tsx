// SSR test for the artifact preview panel.
//
// Scope note: the body refetch is an effect, so SSR only covers the three
// render paths that depend on props: sandboxed html frame, markdown document,
// and the empty-body notice (a tab restored from localStorage has no body).
import "./_globals.ts";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { ArtifactPanel } from "../src/components/ArtifactPanel";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) passed++;
  else failures.push(extra ? `${name} - ${extra}` : name);
}

// 1. html: sandboxed iframe, document as srcdoc, never a live URL.
const html = renderToString(
  <ArtifactPanel
    title="Q3 dashboard"
    kind="html"
    body='<h1 id="x">Q3</h1>'
    chatId="c1"
    id="q3"
  />,
);
check("renders the artifact panel shell", html.includes("artifact-panel"));
check(
  "shows the artifact title",
  html.includes("artifact-panel-title") && html.includes("Q3 dashboard"),
);
// React serialises the prop as `srcDoc`, with the markup HTML-escaped.
check(
  "renders the html body in the frame",
  html.includes("artifact-panel-frame") &&
    /srcdoc=/i.test(html) &&
    html.includes('id=&quot;x&quot;'),
);
check(
  "sandbox allows scripts only",
  html.includes('sandbox="allow-scripts"') && !html.includes("allow-same-origin"),
);
check("never renders markdown chrome for html", !html.includes("artifact-panel-md"));

// 2. markdown: rendered in the panel, not inside the sandbox.
const md = renderToString(
  <ArtifactPanel
    title="Q3 summary"
    kind="md"
    body={"## Revenue\n\n- up 12%"}
    chatId="c1"
    id="q3-md"
  />,
);
check(
  "markdown artifact uses the md container",
  md.includes("artifact-panel-md") && md.includes("markdown-body"),
);
check("markdown artifact renders headings", md.includes("<h2") && md.includes("Revenue"));
check("markdown artifact renders list items", md.includes("<li") && md.includes("up 12%"));
check("markdown artifact has no frame", !md.includes("artifact-panel-frame"));

// 3. empty body: the tab outlived its content, so say that instead of an empty
//    sandbox the user would read as a broken panel.
const empty = renderToString(<ArtifactPanel title="Ghost" kind="html" body="" />);
check(
  "empty artifact explains itself",
  empty.includes("viewer-empty") && empty.includes("no longer in memory"),
);
check("empty artifact renders no frame", !empty.includes("artifact-panel-frame"));

// 4. An empty body with an owner chat is a pending refetch, not a dead end —
//    effects do not run under SSR, so it must not claim the content is gone.
const pending = renderToString(
  <ArtifactPanel title="Q3" kind="html" body="  " chatId="c1" id="q3" />,
);
check(
  "owned empty artifact does not claim loss while loading",
  !pending.includes("no longer in memory"),
);

// 5. No supporting files: the header says nothing rather than "0 files", which
//    would read as a broken counter to anyone without a backend artifact.
check("no asset hint when there are none", !html.includes("artifact-panel-assets"));
check("no asset hint on markdown either", !md.includes("artifact-panel-assets"));

// 6. The page's outward channel is narrow by contract: the frame may name a
//    TOOL, never a server, and only a message stamped with the panel's own source
//    is accepted. Locked here because loosening it would let any embedded page
//    reach a connector the user has switched off.
const src = readFileSync("src/components/ArtifactPanel.tsx", "utf8");
check(
  "the page channel asks for a tool, not a server",
  src.includes("isMcpRequest") && src.includes('source: "codifa-artifact"'),
);
check(
  "an unverified frame cannot drive the channel",
  src.includes("event.source !== frame.contentWindow"),
);
check(
  "assets are fetched, not assumed present",
  src.includes("getArtifactAssets"),
);
// 7. An artifact is a standalone document: its live data must load the same way
//    whichever chat it is reopened in. The panel therefore falls back to the
//    installed connectors when the global on/off list resolves nothing —
//    pinning it to a single chat's enabled servers is the bug this guards.
check(
  "the channel falls back to installed connectors, not one chat's list",
  src.includes("installedServers") &&
    src.includes("Object.keys(enabledServers).length") &&
    !src.includes("callMcpTool(data.tool, data.args, enabledServers)"),
);

// 8. The sandbox grants no popups, so an external link must go through the
//    host: an http(s)-only open-url request rides the same verified-frame
//    channel and is handed to the OS browser via the app-wide bridge.
check(
  "links ask the host for the OS browser over the same channel",
  src.includes("isOpenUrlRequest") &&
    src.includes("coder.openExternal") &&
    src.includes('msg.url.startsWith("http'),
);
check(
  "open-url keeps the sandbox strict (no popup grant)",
  src.includes('sandbox="allow-scripts"') && !src.includes("allow-popups"),
);

console.log(`${passed} artifact-panel checks passed`);
if (failures.length) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
