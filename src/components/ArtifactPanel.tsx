import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getHighlightedLines } from "../lib/highlight";
import { getArtifact, getArtifactAssets } from "../lib/artifacts";
import { callMcpTool } from "../lib/api";
import { useStore } from "../lib/store";
import type { McpServerConfig } from "../types";

/** One request the sandboxed page may send to the host. Narrow on purpose: the
 *  page asks for a TOOL by name and gets text back — it never names a server,
 *  never sees credentials and never reaches IPC directly. */
type McpRequest = { source: "codifa-artifact"; id: number; tool: string; args: unknown };

function isMcpRequest(data: unknown): data is McpRequest {
  if (!data || typeof data !== "object") return false;
  const msg = data as Partial<McpRequest>;
  return (
    msg.source === "codifa-artifact" &&
    typeof msg.id === "number" &&
    typeof msg.tool === "string" &&
    msg.tool.trim().length > 0
  );
}

/** Artifact preview: the document the agent built, rendered APART from the chat.
 *
 *  HTML runs in a sandboxed iframe with `allow-scripts` only — no
 *  `allow-same-origin`, so a generated page can script itself but can never
 *  reach the app's DOM, storage or IPC. Everything must be self-contained: the
 *  sandbox has no network access by design. */
export function ArtifactPanel({
  title,
  kind,
  body,
  chatId,
  id,
}: {
  title: string;
  kind: string;
  body: string;
  /** Owner chat + artifact id, used to re-read the body when the tab was
   *  restored from localStorage (which strips it). */
  chatId?: string;
  id?: string;
}) {
  // The body is memory-only (viewerTabs strips it before persisting), so a tab
  // restored from a previous session has the title but no document. Fetch the
  // latest saved version from the backend instead of rendering an empty frame
  // the user would read as "broken".
  const missing = !body.trim();
  const [fetched, setFetched] = useState<string>("");
  const [error, setError] = useState<string>("");
  // Supporting files (backend source, data, config) are stored beside the
  // document, so they are fetched rather than carried in the transcript.
  const [assets, setAssets] = useState<{ path: string; content: string }[]>([]);
  // The frame is sandboxed and opaque: only a channel THIS ref points at may
  // be answered, so another origin's frame cannot ask on the page's behalf.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Connectors the user enabled, read the same way the composer reads them: a
  // page in the sandbox may ask for a TOOL, and only the tools these servers
  // expose are ever reachable.
  const mcpServers = useStore((st) => st.settings.mcpServers ?? {});
  const mcpEnabled = useStore((st) => st.settings.mcpEnabled ?? []);
  const enabledServers = useMemo(() => {
    const sel: Record<string, McpServerConfig> = {};
    for (const n of mcpEnabled) if (mcpServers[n]) sel[n] = mcpServers[n];
    return sel;
  }, [mcpServers, mcpEnabled]);
  useEffect(() => {
    if (!missing) {
      setFetched("");
      setError("");
      return;
    }
    if (!chatId || !id) return;
    let cancelled = false;
    void getArtifact(chatId, id).then((out) => {
      if (cancelled) return;
      if ("error" in out) setError(out.error);
      else setFetched(out.content);
    });
    return () => {
      cancelled = true;
    };
  }, [missing, chatId, id]);

  useEffect(() => {
    if (!chatId || !id) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    void getArtifactAssets(chatId, id).then((out) => {
      if (cancelled) return;
      setAssets("error" in out ? [] : out.files);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, id, body]);

  // The page's only outward channel. A generated UI that needs live data asks
  // for an MCP tool here; the host runs it through the app's own client and
  // posts the text (or the error) back into the same frame.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (!isMcpRequest(data)) return;
      const reply = (payload: Record<string, unknown>) =>
        frame.contentWindow?.postMessage(
          { source: "codifa-artifact-reply", id: data.id, ...payload },
          "*",
        );
      void callMcpTool(data.tool, data.args, enabledServers).then((out) => {
        if ("error" in out) reply({ ok: false, error: out.error });
        else reply({ ok: true, result: out.result });
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabledServers]);

  const doc = body.trim() ? body : fetched;

  if (!doc.trim()) {
    return (
      <div className="artifact-panel">
        <div className="artifact-panel-head">
          <span className="artifact-panel-title">{title}</span>
        </div>
        <div className="viewer-empty">
          {error
            ? `Could not load this artifact's content: ${error}`
            : missing && chatId && id
              ? "Loading artifact…"
              : "This artifact's content is no longer in memory — reopen it from its card in the chat."}
        </div>
      </div>
    );
  }
  if (kind === "md") {
    return (
      <div className="artifact-panel">
        <div className="artifact-panel-head">
          <span className="artifact-panel-title">{title}</span>
        </div>
        <div className="artifact-panel-md markdown-body" dir="auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc}</ReactMarkdown>
        </div>
      </div>
    );
  }
  return (
    <div className="artifact-panel">
      <div className="artifact-panel-head">
        <span className="artifact-panel-title">{title}</span>
        {assets.length > 0 && (
          <span className="artifact-panel-assets" title={assets.map((a) => a.path).join("\n")}>
            {assets.length} file{assets.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <iframe
        ref={frameRef}
        className="artifact-panel-frame"
        title={title}
        sandbox="allow-scripts"
        srcDoc={doc}
      />
    </div>
  );
}

/** Highlighted source of the same artifact, for the panel's "view source"
 *  affordance (generated markup is worth reading before trusting it). */
export function artifactSourceLines(body: string, lang: string): string[] {
  return getHighlightedLines(body, lang);
}
