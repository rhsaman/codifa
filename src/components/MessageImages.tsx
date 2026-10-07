import { useId, useState } from "react";
import { FullscreenModal } from "./FullscreenModal";
import { useFullscreen } from "../lib/fullscreen";

export interface MessageImage {
  path: string;
  name: string;
  dataUrl?: string;
}

/** Shared grid for message images (user bubbles, steer bubbles, queued bubbles).
 *  Thumbnails open a Codex-style fullscreen viewer on click (Esc/scrim closes,
 *  marquee-drag or Ctrl/⌘+wheel zooms via FullscreenModal). Images without a
 *  dataUrl render as a name placeholder and are not clickable. */
export function MessageImages({
  images,
  modalTitle,
}: {
  images?: MessageImage[];
  modalTitle?: string;
}) {
  const fsKey = useId();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const [selected, setSelected] = useState<number | null>(null);

  if (!images || images.length === 0) return null;
  const usable = (u?: string) => !!u && !u.includes('\u2026');
  const expanded = activeKey === fsKey && selected !== null;
  const current = selected !== null ? images[selected] : null;

  const open = (idx: number) => {
    const du = images[idx]?.dataUrl;
    if (!du || du.includes('\u2026')) return;
    setSelected(idx);
    openFs(fsKey);
  };
  const close = () => {
    closeFs();
    setSelected(null);
  };

  return (
    <>
      <div className="msg-images" dir="ltr">
        {images.map((img, idx) => (
          <div
            className={`msg-image${usable(img.dataUrl) ? " zoomable" : ""}`}
            key={img.path}
            title={usable(img.dataUrl) ? `${img.name} — click to expand` : img.name}
            role={usable(img.dataUrl) ? "button" : undefined}
            tabIndex={usable(img.dataUrl) ? 0 : undefined}
            aria-label={usable(img.dataUrl) ? `Expand image ${img.name}` : undefined}
            style={usable(img.dataUrl) ? { cursor: "zoom-in" } : undefined}
            onClick={usable(img.dataUrl) ? () => open(idx) : undefined}
            onKeyDown={
              img.dataUrl
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open(idx);
                    }
                  }
                : undefined
            }
          >
            {usable(img.dataUrl) ? (
              <img
                src={img.dataUrl}
                alt={img.name}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <span className="msg-image-ph">{img.name}</span>
            )}
          </div>
        ))}
      </div>
      {current && usable(current.dataUrl) && (
        <FullscreenModal
          open={expanded}
          onClose={close}
          title={modalTitle ?? current.name}
        >
          <div className="image-fullscreen">
            <img src={current.dataUrl} alt={current.name} decoding="async" />
          </div>
        </FullscreenModal>
      )}
    </>
  );
}
