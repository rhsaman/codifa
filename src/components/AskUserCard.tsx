import { useEffect, useRef, useState } from "react";
import type { ToolActivity } from "../types";
import { useStore } from "../lib/store";
import { respondAsk } from "../lib/api";
import { detectDir, prepareContent } from "../lib/bidi";
import {
  toggleSelected,
  toggleSectionSelected,
  setSectionAt,
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
  /** Per-section "write my own answer" flags (parallel to `sections`): a ticked
   *  flag reveals that section's text field and counts its text as the answer. */
  secOwn?: boolean[];
  /** Per-section typed answers (parallel to `sections`). */
  secFreeText?: string[];
  /** Flat card's "write my own answer" flag: a ticked flag reveals the answer
   *  field so the user's own words can be submitted without picking a preset. */
  own?: boolean;
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
  const [localSecOwn, setLocalSecOwn] = useState<boolean[]>(() =>
    req?.secOwn && req.secOwn.length === sections.length
      ? req.secOwn
      : sections.map(() => false),
  );
  const [localSecFree, setLocalSecFree] = useState<string[]>(() =>
    req?.secFreeText && req.secFreeText.length === sections.length
      ? req.secFreeText
      : sections.map(() => ""),
  );
  const [localOwn, setLocalOwn] = useState<boolean>(() => req?.own ?? false);
  const [localFree, setLocalFree] = useState<string>(() => (initialFreeText ?? req?.freeText ?? ""));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // Answer fields revealed by the "write my own answer" ticks, so the caret
  // can jump into them the moment a tick turns on.
  const freeRef = useRef<HTMLTextAreaElement | null>(null);
  const secFreeRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const question = (resolvedReq?.question ?? "").toString();
  const options = (resolvedReq?.options ?? []) as string[];
  const fa = detectDir(question) === "rtl";
  const pendingId = resolvedReq?.id ?? "";
  // A flat card WITH options offers a "write my own answer" tick too: the
  // answer field stays hidden (and its text ignored) until the tick is on, so
  // the user can answer in their own words without first picking a preset.
  const flatOwn = !multiPart && options.length > 0;
  const flatFreeActive = !multiPart && (!flatOwn || localOwn);
  const showFreeField = multiPart || flatFreeActive;

  useEffect(() => {
    if (req?.selected) setLocalSelected(req.selected);
  }, [JSON.stringify(req?.selected)]);
  useEffect(() => {
    if (req?.secSelected) setLocalSecSel(req.secSelected);
  }, [JSON.stringify(req?.secSelected)]);
  useEffect(() => {
    if (req?.secOwn) setLocalSecOwn(req.secOwn);
  }, [JSON.stringify(req?.secOwn)]);
  useEffect(() => {
    if (req?.secFreeText) setLocalSecFree(req.secFreeText);
  }, [JSON.stringify(req?.secFreeText)]);
  useEffect(() => {
    if (typeof req?.freeText === "string") setLocalFree(req.freeText);
  }, [req?.freeText]);
  useEffect(() => {
    if (typeof req?.own === "boolean") setLocalOwn(req.own);
  }, [req?.own]);

  // Ticking "write my own answer" reveals its field — put the caret there
  // right away. Only on a false→true transition, so a card restored with the
  // tick already on doesn't steal focus on mount.
  const prevOwn = useRef(localOwn);
  useEffect(() => {
    if (flatOwn && localOwn && !prevOwn.current) freeRef.current?.focus();
    prevOwn.current = localOwn;
  }, [localOwn, flatOwn]);

  const prevSecOwn = useRef(localSecOwn);
  useEffect(() => {
    localSecOwn.forEach((on, si) => {
      if (on && !prevSecOwn.current?.[si]) secFreeRefs.current[si]?.focus();
    });
    prevSecOwn.current = localSecOwn;
  }, [JSON.stringify(localSecOwn)]);

  const answered = activity?.status === "done" || activity?.status === "error";
  // The backend wraps the reply as "The user answered: <text>" — an English
  // prefix that scrambles a Persian line (bidi) and says nothing the card does
  // not already say. Show only the reply itself.
  const replyText = answered
    ? (activity?.resultText ?? activity?.summary ?? "")
        .replace(/^\s*the user answered\s*:?\s*/i, "")
        .trim()
    : "";

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

  /** Tick/untick the flat card's "write my own answer" option. */
  const toggleOwn = () => {
    if (!isActive && !live) return;
    const next = !localOwn;
    setLocalOwn(next);
    persist({ own: next });
  };

  const changeFree = (v: string) => {
    setLocalFree(v);
    persist({ freeText: v });
  };

  /** Tick/untick one section's "write my own answer" option. The field below it
   *  appears only while the flag is on, and only then does its text count. */
  const toggleSectionOwn = (sec: number) => {
    if (!isActive && !live) return;
    const next = setSectionAt(localSecOwn, sec, !localSecOwn[sec], false);
    setLocalSecOwn(next);
    persist({ secOwn: next });
  };

  const changeSectionFree = (sec: number, v: string) => {
    const next = setSectionAt(localSecFree, sec, v, "");
    setLocalSecFree(next);
    persist({ secFreeText: next });
  };

  const submit = async () => {
    if (sendingRef.current) return;
    // Multi-part: one line per section, free text trails as a final line.
    // Flat: labels first, free text last (unchanged behavior).
    const answer = multiPart
      ? [
          joinSectionAnswer(sections, localSecSel, localSecOwn, localSecFree),
          localFree.trim(),
        ].filter((part) => part.length > 0).join("\n")
      : joinAnswer(options, localSelected, flatFreeActive ? localFree : "");
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
      ? canSubmitSections(sections, localSecSel, localSecOwn, localSecFree)
      : canSubmit(options, localSelected, flatFreeActive ? localFree : "");
    if (e.key === "Enter" && !e.shiftKey && ready) {
      e.preventDefault();
      void submit();
    }
  };

  if (!resolvedReq) return null;

  const readyToSubmit = multiPart
    ? canSubmitSections(sections, localSecSel, localSecOwn, localSecFree)
    : canSubmit(options, localSelected, flatFreeActive ? localFree : "");

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
              {/* Own-answer option: the user can answer a facet without
                  picking any preset option, so the typed text must count as
                  this section's answer on its own. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={!!localSecOwn[si]}
                className={`ask-option ask-option-own${localSecOwn[si] ? " selected" : ""}`}
                onClick={() => toggleSectionOwn(si)}
                disabled={!isActive && !live}
              >
                <span className="ask-option-mark" aria-hidden>
                  {localSecOwn[si] ? "☑" : "☐"}
                </span>
                <span className="ask-option-text" dir={fa ? "rtl" : "ltr"}>
                  {fa ? "پاسخ خودم را می‌نویسم…" : "Write my own answer…"}
                </span>
              </button>
              {localSecOwn[si] && (
                <textarea
                  className="ask-input ask-section-input"
                  ref={(el) => {
                    secFreeRefs.current[si] = el;
                  }}
                  rows={2}
                  dir={detectDir(localSecFree[si] ?? "") === "rtl" || fa ? "rtl" : "ltr"}
                  value={localSecFree[si] ?? ""}
                  placeholder={fa ? "پاسخ خود را بنویسید…" : "Type your answer…"}
                  onChange={(e) => changeSectionFree(si, e.target.value)}
                  onKeyDown={handleKey}
                  disabled={!isActive && !live}
                  aria-label={fa ? `پاسخ شما برای ${sec.title}` : `Your answer for ${sec.title}`}
                />
              )}
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
            {/* Flat card's own-answer tick, mirroring the per-section one:
                its text counts as the answer on its own. Hidden once the card
                is answered — there is nothing left to choose. */}
            {!answered && (
            <button
              type="button"
              role="checkbox"
              aria-checked={localOwn}
              className={`ask-option ask-option-own${localOwn ? " selected" : ""}`}
              onClick={toggleOwn}
              disabled={!isActive && !live}
            >
              <span className="ask-option-mark" aria-hidden>
                {localOwn ? "☑" : "☐"}
              </span>
              <span className="ask-option-text" dir={fa ? "rtl" : "ltr"}>
                {fa ? "پاسخ خودم را می‌نویسم…" : "Write my own answer…"}
              </span>
            </button>
            )}
          </div>
        )
      )}
      {answered ? (
        // The answer row appears only when a reply was actually recorded. A card
        // that closed without one (the user typed in the chat instead, or the
        // turn moved on) used to show "پاسخ: —" — an answer slot that is
        // empty and cannot be typed into.
        replyText ? (
          <div className="ask-answer" dir={detectDir(replyText)}>
            <svg className="ask-answer-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={fa ? "پاسخ داده شد" : "Answered"}>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span className="ask-answer-text" dir={detectDir(replyText)}>
              {prepareContent(replyText)}
            </span>
          </div>
        ) : null
      ) : (
        <>
          {showFreeField && (
          <div className="ask-freetext">
            <textarea
              className="ask-input"
              ref={freeRef}
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
          )}
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
