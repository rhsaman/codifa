// SSR test stub for the Zustand store. The real store.ts snapshots its initial
// state at module-load time, so we can't seed it via setState() after import in
// a bundled SSR test. Instead this stub provides a useStore whose initial state
// already contains the seeded workspaces/chats the Sidebar SSR test needs.
import { workspaceKey } from "../src/lib/store"

const seededState = {
  workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
  chats: [
    { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
    { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
  ],
  pinnedWorkspaces: [],
  pinnedChats: [],
  sidebarOpen: true,
  dir: "rtl",
  theme: "dark",
  workspaceColors: {},
  activeChatId: "",
  // Minimal no-op setters so components that call them don't crash under SSR.
  setChatAbort: () => {},
}

export function useStore<T>(selector: (s: typeof seededState) => T): T {
  return selector(seededState as any)
}

export const workspaceKeyExport = workspaceKey
