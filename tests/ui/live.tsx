// Live-test boot: the FULL App against the stubbed bridge, with a couple of
// seeded chats and both side surfaces open. Exposes the stores on window.__live
// so a browser driver can toggle the sidebar/pane exactly like the chords do.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { useStore } from "../../src/lib/store";
import { useViewerTabs } from "../../src/lib/viewerTabs";
import { injectThemeStyles } from "../../src/lib/themes";
import "../../src/styles/global.css";

injectThemeStyles();
if (/Macintosh/.test(navigator.userAgent)) {
  document.documentElement.classList.add("mac");
}

const store = useStore.getState();
const c1 = store.newChat("ask");
const c2 = store.newChat("build");
useStore.setState({ sidebarOpen: true });
useViewerTabs.getState().openTodos(c1);

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

(window as unknown as { __live: unknown }).__live = {
  useStore,
  useViewerTabs,
  chats: [c1, c2],
};
