import { useMemo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store";
import { copyToClipboard } from "../lib/clipboard";
import { latestPlanDoc } from "../lib/planDoc";
import { fetchPlan } from "../lib/api";
import { prepareContent } from "../lib/bidi";
import { mdComponents } from "./ChatMessage";

/** Docked Plan viewer tab (opened by the chat Plan card's "View full plan").
 *  Shows the owner chat's latest implementation plan document as markdown.
 *  The owner chat comes from the viewer tab (falls back to the active chat).
 *  No header row and no close button: the viewer tab strip already labels and
 *  closes this panel, so a second "Plan" title + X would be redundant. Copy
 *  floats at the top-right corner — its previous spot at the header's end. */
export function PlanPanel({ chatId }: { chatId?: string } = {}) {
  const storeActiveChatId = useStore((s) => s.activeChatId);
  const activeChatId = chatId ?? storeActiveChatId;
  const chats = useStore((s) => s.chats);
  // The panel CHROME stays LTR (same docked layout as Git/Trace); only the
  // plan TEXT follows the app's direction + bidi handling.
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState(false);

  const planDoc = useMemo(
    () => latestPlanDoc(chats, activeChatId),
    [chats, activeChatId],
  );
  const chat = chats.find((c) => c.id === activeChatId);
  // Disk fallback: the plan persists at <data>/plan/<ws>/<chat>/plan.md, so a
  // restart (or a chat whose plan message was deleted) still shows the plan.
  const [diskPlan, setDiskPlan] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setDiskPlan(null);
    if (planDoc || !chat?.root) return;
    fetchPlan(chat.root, chat.id)
      .then((p) => {
        if (alive && p?.content) setDiskPlan({ title: p.title || "", body: p.content });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [planDoc, chat?.root, chat?.id]);
  const shown = planDoc ?? diskPlan;

  return (
    <aside
      className="review-panel review-docked-panel plan-panel"
      dir="ltr"
      aria-label="Implementation plan"
    >
      {shown && (
        <button
          type="button"
          className={`review-header-btn plan-panel-float-copy${copied ? " copied" : ""}`}
          title="Copy plan"
          aria-label="Copy plan"
          onClick={() => {
            void copyToClipboard(shown.body);
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
      {shown ? (
        // The markdown body carries its own headings (## Plan …) — no extra
        // title node, or every plan would render its heading twice. Bidi +
        // block direction follow the app setting (dir="auto" would resolve
        // LTR for every plan: the document always opens with "## Plan").
        <div className="plan-panel-body" dir="ltr">
          <div className="plan-panel-content" dir={dir}>
            <div className="chat-message markdown-body">
              {/* Shared mdComponents: inline file paths become clickable
                  file chips, fences get the same code-block chrome as chat. */}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {prepareContent(shown.body, dir)}
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
