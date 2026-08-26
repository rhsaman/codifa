// Mock browser globals
globalThis.window = { addEventListener(){}, dispatchEvent(){}, localStorage:{ _d:{}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} } }
globalThis.localStorage = globalThis.window.localStorage
globalThis.openExternal = async () => {}
const { renderToString } = await import("react-dom/server")
const { Sidebar } = await import("./src/components/Sidebar")
const { useStore } = await import("./src/lib/store")
console.log("getServerState before:", typeof useStore.getServerState)
useStore.getServerState = () => useStore.getState()
console.log("getServerState after:", typeof useStore.getServerState)
useStore.setState({ workspaces:[{key:"/demo",label:"Demo",root:"/demo",color:"#4f8"}], chats:[{id:"c1",root:"/demo",title:"Chat one",messages:[],updatedAt:2,createdAt:1},{id:"c2",root:"/demo",title:"Chat two",messages:[],updatedAt:1,createdAt:1}], pinnedWorkspaces:[], pinnedChats:[] })
console.log("live state chats:", useStore.getState().chats.length)
const html = renderToString(Sidebar())
console.log("HAS chat-item-kebab:", html.includes("chat-item-kebab"))
console.log("HAS sidebar-group-count:", html.includes("sidebar-group-count"))
console.log("HAS No conversations:", html.includes("No conversations"))
