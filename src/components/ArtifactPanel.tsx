import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getHighlightedLines } from "../lib/highlight";
import { getArtifact } from "../lib/artifacts";

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
      </div>
      <iframe
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
