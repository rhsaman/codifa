// Stub for ../lib/store used by the Sidebar SSR test. Returns a fixed snapshot
// so the component renders deterministically without a real store/Electron
// backend. Covers every field/method Sidebar reads from the store.
export function useStore<T>(selector: (s: any) => T): T {
  const state = {
    chats: [],
    workspaces: [],
    activeChatId: "",
    workspaceColors: {},
    theme: "",
    pinnedWorkspaces: [],
    pinnedChats: [],
    unreadChats: {},
    sidebarOpen: false,
    dir: "ltr",
    recentModels: [],
    settings: { providers: [], activeProviderId: "" },
  }
  return selector(state)
}

export const store = {
  getState: () => ({
    chats: [],
    workspaces: [],
    activeChatId: "",
    workspaceColors: {},
    theme: "",
    pinnedWorkspaces: [],
    pinnedChats: [],
    unreadChats: {},
    sidebarOpen: false,
    dir: "ltr",
    recentModels: [],
    settings: { providers: [], activeProviderId: "" },
    createWorkspace: () => {},
    setWorkspaceOrder: () => {},
    newChat: () => {},
    togglePinWorkspace: () => {},
    newChatInRoot: () => {},
    deleteWorkspace: () => {},
    setWorkspaceColor: () => {},
    setActiveChat: () => {},
    togglePinChat: () => {},
    deleteChat: () => {},
    resetChatUsage: () => {},
    setSettingsOpen: () => {},
  }),
  setState: () => {},
  subscribe: () => () => {},
}
