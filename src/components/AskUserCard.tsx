import { useEffect, useRef, useState } from "react";
import type { ToolActivity } from "../types";
import { useStore } from "../lib/store";
import { respondAsk } from "../lib/api";
import { detectDir, prepareContent } from "../lib/bidi";
import {
  toggleSelected,
  toggleSectionSelected,
  joinAnswer,
  joinSectionAnswer,
  canSubmit,
  canSubmitSections,
} from "../lib/askUser";

/** Shape of the pending ask request (mirrors Chat["pendingAsk"]). */
export interface AskCardReq {
  id: string;
  question: string;
  options: string[];
  style?: string;
  selected?: number[];
  freeText?: string;
  sections?: { title: string; options: string[] }[];
  secSelected?: number[][];
}

export interface AskUserCardProps {
  req: AskCardReq | null;
  activity?: ToolActivity;
  messageId?: string;
  live?: boolean;
  inline?: boolean;
  initialSelected?: number[];
  initialFreeText?: string;
}

/** Coerce raw backend section objects into clean {title, options} pairs. */
function coerceSections(raw: unknown): { title: string; options: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((sec) => {
      const o = (sec ?? {}) as Record<string, unknown>;
      const opts: unknown[] = Array.isArray(o.options) ? o.options : [];
      return {
        title: typeof o.title === "string" ? o.title.trim() : "",
        options: opts
          .map((x) => (typeof x === "string" ? x : x == null ? "" : String(x)).trim())
          .filter((x) => x.length > 0),
      };
    })
    .filter((s) => s.title.length > 0 && s.options.length > 0);
}

export function AskUserCard({
  req,
  activity,
  messageId,
  live = false,
  inline = false,
  initialSelected,
  initialFreeText,
}: AskUserCardProps) {
  // Resolve the owning chat ONCE per source: a live request matches by its
  // gate id, a historical card by the message that carries its activity. The
  // req?.id guard matters — a null/undefined id would otherwise match every
  // chat with NO pendingAsk and hand back the wrong chat.
  const chatId = useStore((s) => {
    if (req?.id) {
      const byAsk = s.chats.find((c) => c.pendingAsk?.id === req.id);
      if (byAsk) return byAsk.id;
    }
    if (messageId) {
      const byMsg = s.chats.find((c) => c.messages.some((m) => m.id === messageId));
      if (byMsg) return byMsg.id;
    }
    return typeof s.activeChatId === "string" ? s.activeChatId : undefined;
  });
  const isActive = useStore((s) => (req?.id ? s.chats.some((c) => c.pendingAsk?.id === req.id) : false));

  const argSections = coerceSections(activity?.args?.sections);
  const resolvedReq: AskCardReq | null = req ?? (activity
    ? {
        id: "",
        question: String(activity.args?.question ?? ""),
        options: Array.isArray(activity.args?.options)
          ? activity.args!.options.map((o: unknown) => String(o))
          : [],
        sections: argSections.length > 0 ? argSections : undefined,
      }
    : null);

  const sections = resolvedReq?.sections ?? [];
  const multiPart = sections.length > 0;

  const [localSelected, setLocalSelected] = useState<number[]>(() =>
    initialSelected && initialSelected.length
      ? initialSelected
      : (req?.selected && req.selected.length ? req.selected : []),
  );
  const [localSecSel, setLocalSecSel] = useState<number[][]>(() =>
    req?.secSelected && req.secSelected.length === sections.length
      ? req.secSelected
      : sections.map(() => []),
  );
  const [localFree, setLocalFree] = useState<string>(() => (initialFreeText ?? req?.freeText ?? ""));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const question = (resolvedReq?.question ?? "").toString();
  const options = (resolvedReq?.options ?? []) as string[];
  const fa = detectDir(question) === "rtl";
  const pendingId = resolvedReq?.id ?? "";

  useEffect(() => {
    if (req?.selected) setLocalSelected(req.selected);
  }, [JSON.stringify(req?.selected)]);
  useEffect(() => {
    if (req?.secSelected) setLocalSecSel(req.secSelected);
  }, [JSON.stringify(req?.secSelected)]);
  useEffect(() => {
    if (typeof req?.freeText === "string") setLocalFree(req.freeText);
  }, [req?.freeText]);

  const answered = activity?.status === "done" || activity?.status === "error";
  const replyText = answered ? (activity?.resultText ?? activity?.summary ?? "") : "";

  const persist = (patch: Partial<AskCardReq>) => {
    if (live && chatId && req) {
      useStore.getState().setChatPendingAsk(chatId, { ...req, ...patch });
    }
  };

  const toggle = (i: number) => {
    if (!isActive && !live) return;
    const next = toggleSelected(localSelected, i);
    setLocalSelected(next);
    persist({ selected: next });
  };

  const toggleSection = (sec: number, i: number) => {
    if (!isActive && !live) return;
    const next = toggleSectionSelected(localSecSel, sec, i);
    setLocalSecSel(next);
    persist({ secSelected: next });
  };

  const changeFree = (v: string) => {
    setLocalFree(v);
    persist({ freeText: v });
  };

  const submit = async () => {
    if (sendingRef.current) return;
    // Multi-part: one line per section, free text trails as a final line.
    // Flat: labels first, free text last (unchanged behavior).
    const answer = multiPart
      ? [
          joinSectionAnswer(sections, localSecSel),
          localFree.trim(),
        ].filter((part) => part.length > 0).join("\n")
      : joinAnswer(options, localSelected, localFree);
    if (!answer) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const ok = pendingId ? await respondAsk(pendingId, answer) : true;
      if (ok) {
        if (chatId) useStore.getState().setChatPendingAsk(chatId, null);
      } else {
        setError(fa ? "ارسال نشد. دوباره تلاش کنید." : "Failed to send. Try again.");
      }
    } catch {
      setError(fa ? "ارسال نشد. دوباره تلاش کنید." : "Failed to send. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ready = multiPart
      ? canSubmitSections(sections, localSecSel)
      : canSubmit(options, localSelected, localFree);
    if (e.key === "Enter" && !e.shiftKey && ready) {
      e.preventDefault();
      void submit();
    }
  };

  if (!resolvedReq) return null;

  const readyToSubmit = multiPart
    ? canSubmitSections(sections, localSecSel)
    : canSubmit(options, localSelected, localFree);

  return (
    <div
      className={`ask-card${inline ? " ask-card-inline" : ""}`}
      role="region"
      aria-label={fa ? "پرسش عامل" : "Agent question"}
      dir={fa ? "rtl" : "ltr"}
    >
      <div className="ask-header">
        <span className="ask-badge">{fa ? "پرسش عامل" : "Agent Question"}</span>
      </div>
      {question.length > 0 && (
        <div className="ask-card-question" dir={fa ? "rtl" : "ltr"}>
          {prepareContent(question)}
        </div>
      )}
      {multiPart ? (
        // One card, several facets: each section keeps its own multi-select
        // list; Apply unlocks only when EVERY section has a pick, then all
        // answers travel together in ONE request.
        <div className="ask-sections">
          {sections.map((sec, si) => (
            <div key={si} className="ask-section">
              <div className="ask-section-title" dir={detectDir(sec.title)}>
                {prepareContent(sec.title)}
              </div>
              <div
                className="ask-options"
                role="group"
                aria-label={sec.title}
              >
                {sec.options.map((opt, oi) => {
                  const checked = (localSecSel[si] ?? []).includes(oi);
                  return (
                    <button
                      key={oi}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className={`ask-option${checked ? " selected" : ""}`}
                      onClick={() => toggleSection(si, oi)}
                      disabled={!isActive && !live}
                    >
                      <span className="ask-option-mark" aria-hidden>
                        {checked ? "☑" : "☐"}
                      </span>
                      <span className="ask-option-text" dir={detectDir(opt)}>
                        {prepareContent(opt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        options.length > 0 && (
          <div className="ask-options" role="group" aria-label={fa ? "گزینه‌ها" : "Options"}>
            {options.map((opt, i) => {
              const checked = localSelected.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className={`ask-option${checked ? " selected" : ""}`}
                  onClick={() => toggle(i)}
                  disabled={!isActive && !live}
                >
                  <span className="ask-option-mark" aria-hidden>
                    {checked ? "☑" : "☐"}
                  </span>
                  <span className="ask-option-text" dir={detectDir(opt)}>
                    {prepareContent(opt)}
                  </span>
                </button>
              );
            })}
          </div>
        )
      )}
      {answered ? (
        <div className="ask-answer">
          <span className="ask-answer-label">{fa ? "پاسخ:" : "Answer:"}</span>{" "}
          <span className="ask-answer-text" dir={detectDir(replyText)}>
            {prepareContent(replyText || "—")}
          </span>
        </div>
      ) : (
        <>
          <div className="ask-freetext">
            <textarea
              className="ask-input"
              rows={2}
              autoFocus={live}
              dir={detectDir(localFree) === "rtl" || fa ? "rtl" : "ltr"}
              value={localFree}
              placeholder={
                multiPart
                  ? fa
                    ? "توضیح اضافه (اختیاری)…"
                    : "Anything to add? (optional)…"
                  : fa
                    ? "پاسخ خود را بنویسید…"
                    : "Type your answer…"
              }
              onChange={(e) => changeFree(e.target.value)}
              onKeyDown={handleKey}
              disabled={!isActive && !live}
            />
          </div>
          {error && <div className="ask-error">{error}</div>}
          <div className="ask-footer">
            <button
              type="button"
              className="btn ask-send"
              disabled={sending || !readyToSubmit}
              onClick={() => void submit()}
            >
              {sending ? (fa ? "در حال ارسال…" : "Sending…") : (fa ? "اعمال انتخاب" : "Apply")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default AskUserCard;
