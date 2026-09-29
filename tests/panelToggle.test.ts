// Panel toggle fast path: toggling sidebar / right panel / code-map must flip
// the boolean synchronously and only schedule a lightweight settings-only
// persist — never the heavy full snapshot (sanitizeChats + AES + chats IPC).
// Run: npx esbuild tests/panelToggle.test.ts --bundle --platform=node --format=esm --packages=external --outfile=tests/.tmp-pt.mjs && node tests/.tmp-pt.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
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
;(globalThis as any).document = {
  documentElement: { style: { setProperty: () => {} }, dataset: {} },
}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const storeMod = await import("../src/lib/store")
const { useStore } = storeMod
// In the real app load() sets this true; without it panel writes are
// intentionally skipped to avoid clobbering settings.json with defaults.
useStore.setState({ settingsHydrated: true })

// Track which store keys each persist path writes.
const writes: string[] = []
const apiMod = await import("../src/lib/fs")
const api = (apiMod as any).api
const origStoreSet = api.storeSet
api.storeSet = async (key: string, value: unknown) => {
  writes.push(key)
  return origStoreSet(key, value)
}
// encryptSettings is async — wait past the debounce + microtasks.
const flush = async (ms = 250) => {
  await new Promise((r) => setTimeout(r, ms))
  await new Promise((r) => setTimeout(r, ms))
}

console.log("۱) تاگل سایدبار — فقط settings نوشته می‌شود، نه chats:")
{
  writes.length = 0
  const before = useStore.getState().sidebarOpen
  useStore.getState().setSidebarOpen(!before)
  check("بلافاصله (sync) فلیپ می‌شود", useStore.getState().sidebarOpen === !before)
  check("همگام هیچ write رخ نمی‌دهد", writes.length === 0)
  await flush()
  check("پس‌زمینه فقط settings می‌نویسد", writes.includes("settings"), writes)
  check("پس‌زمینه chats نمی‌نویسد", !writes.includes("chats"), writes)
  useStore.getState().setSidebarOpen(before)
  await flush()
}

console.log("۲) تاگل پنل راست — فقط settings نوشته می‌شود، نه chats:")
{
  writes.length = 0
  const before = useStore.getState().rightPanelOpen
  useStore.getState().setRightPanelOpen(!before)
  check("بلافاصله (sync) فلیپ می‌شود", useStore.getState().rightPanelOpen === !before)
  check("همگام هیچ write رخ نمی‌دهد", writes.length === 0)
  await flush()
  check("پس‌زمینه فقط settings می‌نویسد", writes.includes("settings"), writes)
  check("پس‌زمینه chats نمی‌نویسد", !writes.includes("chats"), writes)
  useStore.getState().setRightPanelOpen(before)
  await flush()
}

console.log("۳) تاگل code-map — فقط settings نوشته می‌شود، نه chats:")
{
  writes.length = 0
  const before = useStore.getState().codeMapPanelOpen
  useStore.getState().setCodeMapPanelOpen(!before)
  check("بلافاصله (sync) فلیپ می‌شود", useStore.getState().codeMapPanelOpen === !before)
  await flush()
  check("پس‌زمینه chats نمی‌نویسد", !writes.includes("chats"), writes)
  useStore.getState().setCodeMapPanelOpen(before)
  await flush()
}

console.log("۴) panelToggleTarget — تفکیک سایدبار و پنل راست:")
{
  const { panelToggleTarget } = await import("../src/lib/shortcuts")
  const chord = (shift: boolean, code = "KeyB", key = "b") => ({
    code,
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: shift,
  })
  check("Ctrl+B → sidebar", panelToggleTarget(chord(false)) === "sidebar")
  check("Ctrl+Shift+B → right", panelToggleTarget(chord(true)) === "right")
  check("⌘+Shift+B (مک) → right", panelToggleTarget({ code: "KeyB", key: "b", ctrlKey: false, metaKey: true, shiftKey: true }) === "right")
  check("Ctrl+Shift+«ذ» (code=KeyB) → right", panelToggleTarget(chord(true, "KeyB", "ذ")) === "right")
  check("بدون Ctrl → null", panelToggleTarget({ code: "KeyB", key: "b", ctrlKey: false, metaKey: false, shiftKey: true }) === null)
  check("کلید دیگر → null", panelToggleTarget({ code: "KeyC", key: "c", ctrlKey: true, metaKey: false, shiftKey: true }) === null)
}

if (failed > 0) {
  console.error(`\n❌ ${failed} مورد ناموفق`)
  process.exit(1)
} else {
  console.log("\n✅ همه تست‌های تاگل پنل پاس شدند")
}
