import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyToClipboard } from "../lib/clipboard";
import { fmtSize } from "../lib/renderCap";
import { mdComponents } from "./ChatMessage";

/** Never paint more than this many characters of ONE text: a multi-megabyte
 *  paste would freeze the tab. Copy keeps the FULL text. */
const TEXT_RENDER_CAP = 400_000;

/** Docked viewer tab for the full body of a collapsed chat text (long user
 *  message, context summary, tool output, glob/grep result list). The body
 *  renders as MARKDOWN by default — inline file paths become clickable chips
 *  that open the file, fences get the chat code-block chrome — and the header
 *  toggle switches to the verbatim raw view (logs read better raw). The
 *  preview in the chat stays collapsed; the full text opens here. */
export function TextViewerPanel({
  title,
  body,
  format,
}: {
  title: string;
  body: string;
  /** Default render mode from the tab ("md" when unset). */
  format?: "md" | "text";
}) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"md" | "text">(format ?? "md");
  // Reopening the tab with a different hint resets the view (the tab object
  // updates in place, so a prop change — not a remount — carries it).
  useEffect(() => setView(format ?? "md"), [format]);

  const capped = body.length > TEXT_RENDER_CAP;
  const shown = useMemo(
    () => (capped ? body.slice(0, TEXT_RENDER_CAP) : body),
    [body, capped],
  );

  const copy = async () => {
    try {
      await copyToClipboard(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  return (
    <div className="file-viewer text-viewer" dir="ltr">
      <div className="file-viewer-head">
        <span className="text-viewer-icon" aria-hidden="true">
          📝
        </span>
        <span className="file-viewer-name" title={title}>
          {title}
        </span>
        <span className="file-viewer-spacer" />
        <div className="tv-view-toggle" role="group" aria-label="Render mode">
          <button
            type="button"
            className={view === "md" ? "active" : ""}
            title="Render as markdown (file paths become clickable)"
            aria-pressed={view === "md"}
            onClick={() => setView("md")}
          >
            MD
          </button>
          <button
            type="button"
            className={view === "text" ? "active" : ""}
            title="Raw text"
            aria-pressed={view === "text"}
            onClick={() => setView("text")}
          >
            Raw
          </button>
        </div>
        <button
          type="button"
          className={`fv-copy${copied ? " copied" : ""}`}
          onClick={copy}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {capped && (
        <div className="file-viewer-note">
          Showing the first {fmtSize(TEXT_RENDER_CAP)} — the full text is{" "}
          {fmtSize(body.length)}. Copy carries the full text.
        </div>
      )}
      {view === "md" ? (
        <div className="file-viewer-body text-viewer-md">
          <div className="chat-message markdown-body" dir="ltr">
            {/* Rendered verbatim — no prepareContent: bodies embed code and
                diffs that may legally contain ``` runs, which prepareContent's
                3-backtick fence splitting would corrupt. react-markdown never
                executes raw HTML, so untrusted payloads stay inert. */}
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {shown}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="file-viewer-body">
          <pre className="text-viewer-pre">{shown}</pre>
        </div>
      )}
    </div>
  );
}
