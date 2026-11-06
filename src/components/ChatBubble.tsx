import type { ReactNode } from "react";
import { detectDir } from "../lib/bidi";
import { useSpeakText } from "../lib/tts";
import { useStore } from "../lib/store";
import { MarkdownProse, cachedPrepare, forkChatWithConfirm } from "./ChatMessage";
import { MessageActionsBar, MsgClocks, type UsageInfo } from "./MessageActionsBar";

// One assistant chat bubble, usable OUTSIDE the transcript: the schedule inbox
// run outputs and reading-mode sections render through this exact component —
// same markdown pipeline (MarkdownProse: islands, tables, charts, mermaid,
// arrows), same direction rule (detectDir of the content), same actions row
// (copy / speak / usage / clocks) as the chat. Fork/read are opt-in because
// they need a chat context (forkChatWithConfirm no-ops when the id is not in
// any chat).

export function ChatBubble({
  id,
  content,
  usage,
  createdAt,
  turnElapsedMs,
  className,
  fork,
  onFork,
  read,
  onRead,
  children,
}: {
  id: string;
  content: string;
  usage?: UsageInfo | null;
  createdAt?: number;
  turnElapsedMs?: number | null;
  /** Extra classes on the .msg wrapper (e.g. "schedule-inbox-markdown"). */
  className?: string;
  fork?: boolean;
  onFork?: () => void;
  read?: boolean;
  onRead?: () => void;
  children?: ReactNode;
}) {
  const { status: ttsStatus, speak } = useSpeakText(useStore.getState);
  const dir = detectDir(content);
  const onSpeak = async () => {
    // No chat banner exists here — surface the friendly error in the console
    // (the common failures — no provider, empty text — are guarded silently).
    const err = await speak(content);
    if (err) console.warn("speak failed:", err);
  };
  return (
    <div className={`msg chat-bubble${className ? ` ${className}` : ""}`} dir={dir}>
      <div className="msg-bubble">
        <MarkdownProse text={cachedPrepare(`bubble:${id}`, content)} />
        <MessageActionsBar
          text={content}
          usage={usage ?? null}
          ttsStatus={content.trim() ? ttsStatus : undefined}
          onSpeak={content.trim() ? onSpeak : undefined}
          fork={fork}
          onFork={onFork ?? (fork ? () => forkChatWithConfirm(id) : undefined)}
          read={read}
          onRead={onRead}
        >
          <MsgClocks createdAt={createdAt} turnElapsedMs={turnElapsedMs} />
          {children}
        </MessageActionsBar>
      </div>
    </div>
  );
}
