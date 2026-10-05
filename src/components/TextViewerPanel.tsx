import { useMemo, useState } from "react";
import { copyToClipboard } from "../lib/clipboard";
import { fmtSize } from "../lib/renderCap";

/** Never paint more than this many characters of ONE text: a multi-megabyte
 *  paste would freeze the tab. Copy keeps the FULL text. */
const TEXT_RENDER_CAP = 400_000;

/** Docked viewer tab for the full body of a collapsed chat text (long user
 *  message, context summary, tool output). The preview in the chat stays
 *  collapsed; the full text opens here, like diff/plan tabs. */
export function TextViewerPanel({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  const [copied, setCopied] = useState(false);

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
      <div className="file-viewer-body">
        <pre className="text-viewer-pre">{shown}</pre>
      </div>
    </div>
  );
}
