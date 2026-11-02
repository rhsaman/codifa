// Throwaway probe (deleted after verification): reproduce the user's TWO
// scrollbars in the SETTINGS modal. Mounts the real SettingsModal with the
// marketplaces tab preselected, then audits every scroller inside it —
// native ::-webkit-scrollbar bars AND drawn .sp-bar lanes together — so the
// two visible bars can be identified by host.
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { SettingsModal } from "../../src/components/SettingsModal";

const el = document.createElement("div");
el.id = "sm-probe";
el.style.cssText = "position:fixed;inset:0;z-index:9999";
document.body.appendChild(el);

// SettingsModal's own root uses the .modal-overlay > .settings-modal tree.
const props = { onClose: () => {} } as never;
try {
  // The marketplaces tab may not be the initial tab; open it if the store
  // exposes the picker. The modal reads its own state — just render it.
  createRoot(el).render(createElement(SettingsModal, props));
} catch (e) {
  console.error("probe mount failed", e);
}
(window as unknown as Record<string, unknown>).__smProbeDone = true;
// The app's real entry (main.tsx) installs the app-wide overlay bars — mirror
// that here so the probe reproduces the production DOM.
import("../../src/lib/useDiffScrollbars").then((m) => m.installOverlayScrollbars());
