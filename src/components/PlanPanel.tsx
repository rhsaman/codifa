import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import { copyToClipboard } from "../lib/clipboard";
import { latestPlanDoc } from "../lib/planDoc";
import { prepareContent } from "../lib/bidi";

/** Docked Plan viewer tab (opened by the chat Plan card's "View full plan").
 *  Shows the active chat's latest implementation plan document as markdown.
 *  Like the trace tab it follows the active chat — no chatId prop. */
export function PlanPanel({ onClose }: { onClose?: () => void }) {
  const activeChatId = useStore((s) => s.activeChatId);
  const chats = useStore((s) => s.chats);
  // The panel CHROME stays LTR (same docked layout as Git/Trace); only the
  // plan TEXT follows the app's direction + bidi handling.
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState(false);

  const planDoc = useMemo(
    () => latestPlanDoc(chats, activeChatId),
    [chats, activeChatId],
  );

  return (
    <aside
      className="review-panel review-docked-panel"
      dir="ltr"
      aria-label="Implementation plan"
    >
      <div className="review-header">
        <span className="review-source plan-panel-source">
          <span className="plan-panel-title">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
            Plan
          </span>
        </span>
        <span className="review-header-actions">
          {planDoc && (
            <button
              type="button"
              className={`review-header-btn${copied ? " copied" : ""}`}
              title="Copy plan"
              aria-label="Copy plan"
              onClick={() => {
                void copyToClipboard(planDoc.body);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            className="review-header-btn"
            title="Close"
            aria-label="Close"
            onClick={() => {
              useViewerTabs.getState().closeViewer("plan");
              onClose?.();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      </div>
      {planDoc ? (
        // The markdown body carries its own headings (## Plan …) — no extra
        // title node, or every plan would render its heading twice. Bidi +
        // block direction follow the app setting (dir="auto" would resolve
        // LTR for every plan: the document always opens with "## Plan").
        <div className="plan-panel-body" dir="ltr">
          <div className="plan-panel-content" dir={dir}>
            <div className="chat-message markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {prepareContent(planDoc.body, dir)}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      ) : (
        <div className="plan-panel-empty">
          No plan yet — switch to Plan mode and describe what you want built.
        </div>
      )}
    </aside>
  );
}
