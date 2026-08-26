// Dump SSR HTML to inspect why chats don't render
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { _d: {}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} },
  coder: new Proxy({}, { get: (_t, p) => p==='then'?undefined:async()=>({ok:true,data:null}) }),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const { renderToString } = await import("react-dom/server")
const { useStore } = await import("../src/lib/store")

useStore.setState({
  workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
  chats: [
    { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
    { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
  ],
  pinnedWorkspaces: [],
  pinnedChats: [],
} )

const { Sidebar } = await import("../src/components/Sidebar")
const html = renderToString(Sidebar())
console.log("LENGTH:", html.length)
console.log("HAS chat-item:", html.includes("chat-item"))
console.log("HAS sidebar-group:", html.includes("sidebar-group"))
console.log("HAS Workspace options:", html.includes("Workspace options"))
console.log("HAS No conversations:", html.includes("No conversations"))
process.exit(0)
