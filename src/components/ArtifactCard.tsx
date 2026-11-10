import { ArtifactGlyph } from "./ArtifactsPanel";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import type { MessageSegment } from "../types";

type ArtifactSegment = Extract<MessageSegment, { kind: "artifact" }>;

/** One artifact inside an assistant message: a compact card that opens the
 *  sandboxed preview tab. The body lives on the segment, so the card still
 *  works after the chat is reloaded and before the panel fetches anything.
 *  The tab belongs to the message's OWN chat: a card in a background window
 *  used to open the ACTIVE chat's artifact (the window's focus handler runs
 *  after this click). */
export function ArtifactCard({
  segment,
  messageId,
}: {
  segment: ArtifactSegment;
  messageId?: string;
}) {
  const open = () => {
    const st = useStore.getState();
    const owner = messageId
      ? st.chats.find((c) => c.messages.some((m) => m.id === messageId))
      : undefined;
    if (owner && st.activeChatId !== owner.id) st.focusWindow(owner.id);
    useViewerTabs.getState().openArtifact(owner?.id ?? st.activeChatId ?? "", {
      id: segment.id,
      title: segment.title,
      kind: segment.artifactKind,
      body: segment.content,
    });
  };
  return (
    <div className="artifact-card">
      <div className="artifact-card-head">
        <span className="artifact-card-icon" aria-hidden="true">
          <ArtifactGlyph size={15} />
        </span>
        <span className="artifact-card-title" title={segment.title || segment.id}>
          {segment.title || segment.id}
        </span>
        <span className="artifact-card-meta">
          {segment.artifactKind} · v{segment.version}
        </span>
        <button className="btn secondary artifact-card-open" onClick={open}>
          Open
        </button>
      </div>
    </div>
  );
}
