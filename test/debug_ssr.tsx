// Mock browser globals (mirror the real test setup)
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

const { renderToString } = await import("react-dom/server")
const { useStore } = await import("../src/lib/store")

const seed = {
  workspaces: [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }],
  chats: [
    { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
    { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 },
  ],
  pinnedWorkspaces: [],
  pinnedChats: [],
}
useStore.setState(seed)

// Direct test of useSyncExternalStore server snapshot behavior
import { useSyncExternalStore } from "react"
function Probe() {
  const chats = useSyncExternalStore(
    useStore.subscribe,
    useStore.getState,
    useStore.getInitialState,
  )
  return <div data-count={chats.chats.length} />
}
const html = renderToString(<Probe />)
console.log("Probe HTML:", html)
