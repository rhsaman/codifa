// Live renderer-memory measurement on the REAL data root.
//
// Compares the renderer heap cost of the OLD eager layout (every chat with its
// full message array resident) against the NEW split layout (index rows only,
// plus a bounded number of hydrated bodies) using this machine's actual
// settings.json and chats/** files.
//
// Raw file TEXT is read up-front (cheap, one copy of the bytes); each scenario
// then PARSES freshly inside its own measurement window, so the heap delta is
// the real cost of holding that layout in the renderer.
//
// Reads only; writes nothing. Run: node --expose-gc scripts/measure-renderer-memory.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.env.CODER_DATA_DIR || path.join(os.homedir(), '.codifa')
const HYDRATED_CHAT_CAP = 10 // store.ts HYDRATED_CHAT_CAP

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
const heapNow = () => {
  if (global.gc) global.gc()
  return process.memoryUsage().heapUsed
}

/** Parse fresh, hold the result, and report the peak heap growth. */
function measure(label, fn) {
  const before = heapNow()
  const held = fn()
  const delta = heapNow() - before
  console.log(`  ${label.padEnd(48)} ${mb(delta).padStart(9)}`)
  return { delta, held }
}

const settingsRaw = fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8')

// Raw text of every body file, keyed by chat id (duplicates: keep the largest).
const bodiesRaw = new Map()
let bodyFiles = 0
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.json')) {
      bodyFiles++
      try {
        const txt = fs.readFileSync(p, 'utf8')
        const row = JSON.parse(txt)
        if (row && typeof row.id === 'string') {
          const n = Array.isArray(row.messages) ? row.messages.length : 0
          const prev = bodiesRaw.get(row.id)
          if (!prev || n >= prev.n) bodiesRaw.set(row.id, { n, txt })
        }
      } catch {
        /* skip unparsable */
      }
    }
  }
}
const chatsDir = path.join(ROOT, 'chats')
if (fs.existsSync(chatsDir)) walk(chatsDir)

const indexRows = JSON.parse(settingsRaw).chats || []
const totalMessages = [...bodiesRaw.values()].reduce((s, b) => s + b.n, 0)

console.log(`data root:            ${ROOT}`)
console.log(`settings.json:        ${mb(Buffer.byteLength(settingsRaw))}`)
console.log(`index rows:           ${indexRows.length}`)
console.log(`body files:           ${bodyFiles} (distinct chats: ${bodiesRaw.size})`)
console.log(`total messages:       ${totalMessages}`)
console.log()

// Force GC so the baseline is clean before the scenarios allocate.
heapNow()

console.log('renderer heap delta (lower is better):')
console.log()

const oldLayout = measure('OLD: all chats + all messages', () => {
  const keep = []
  for (const row of indexRows) {
    const raw = bodiesRaw.get(row.id)
    keep.push(raw ? JSON.parse(raw.txt) : { ...row, messages: [] })
  }
  return keep
})

const newIndexOnly = measure('NEW: index rows only (boot)', () =>
  JSON.parse(settingsRaw).chats.map((r) => ({ ...r, hydrated: false })),
)

const openIds = indexRows.slice(0, HYDRATED_CHAT_CAP).map((r) => r.id)
const newWithOpen = measure(
  `NEW: index + ${Math.min(openIds.length, HYDRATED_CHAT_CAP)} hydrated chat(s)`,
  () => {
    const keep = JSON.parse(settingsRaw).chats.map((r) => ({ ...r, hydrated: false }))
    for (let i = 0; i < keep.length && i < HYDRATED_CHAT_CAP; i++) {
      const raw = bodiesRaw.get(openIds[i])
      if (raw) keep[i] = { ...JSON.parse(raw.txt), hydrated: true }
    }
    return keep
  },
)

const bytesAll = [...bodiesRaw.values()].reduce((s, b) => s + Buffer.byteLength(b.txt), 0)
console.log()
console.log(`raw body bytes on disk:  ${mb(bytesAll)}`)
console.log(`eager-load heap:         ${mb(oldLayout.delta)}`)
console.log(`index-only heap:         ${mb(newIndexOnly.delta)}`)
console.log(`index + open heap:       ${mb(newWithOpen.delta)}`)
const saving = oldLayout.delta - newWithOpen.delta
console.log(
  `saving vs eager:         ${mb(saving)} (${((saving / oldLayout.delta) * 100).toFixed(1)}% less renderer heap)`,
)
