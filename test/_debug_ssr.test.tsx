// Debug: use useStore exported from Sidebar itself
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const { Sidebar, useStore } = await import("../src/components/Sidebar")
console.log("useStore from Sidebar is fn:", typeof useStore, typeof useStore?.getState)
useStore.setState({
  workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
  chats: [
    { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
    { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
  ],
  pinnedWorkspaces: [],
  pinnedChats: [],
} as any)
console.log("chats after setState:", useStore.getState().chats.length)

const { renderToString } = await import("react-dom/server")
const html = renderToString(<Sidebar />)
console.log("LENGTH:", html.length)
console.log("HAS chat-item:", html.includes("chat-item"))
console.log("HAS No conversations:", html.includes("No conversations"))
process.exit(0)
