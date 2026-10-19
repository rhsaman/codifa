// Measures the Rust-side document cost: the parsed settings.json document that
// `DocCache` holds resident, before vs after the split-storage migration.
//
// This stands in for the Rust process: the same serde_json::Value tree shape
// (objects/arrays/strings as V8-ish tree nodes) is what the store keeps in
// memory for the whole session.
//
// Run: node --expose-gc scripts/measure-store-document.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.env.CODER_DATA_DIR || path.join(os.homedir(), '.codifa')
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
const heapNow = () => {
  if (global.gc) global.gc()
  return process.memoryUsage().heapUsed
}

function measureFile(label, file) {
  if (!fs.existsSync(file)) {
    console.log(`  ${label.padEnd(44)} (missing)`)
    return null
  }
  const size = fs.statSync(file).size
  const raw = fs.readFileSync(file, 'utf8')
  const before = heapNow()
  const doc = JSON.parse(raw)
  const delta = heapNow() - before
  const rows = Array.isArray(doc.chats) ? doc.chats.length : 0
  const withBody = Array.isArray(doc.chats)
    ? doc.chats.filter((r) => r && Array.isArray(r.messages)).length
    : 0
  console.log(
    `  ${label.padEnd(44)} ${mb(delta).padStart(9)}  (file ${mb(size)}, ${rows} rows, ${withBody} with body)`,
  )
  return { delta, doc }
}

console.log(`data root: ${ROOT}`)
console.log()
console.log('parsed document held resident by the Rust store:')
console.log()

measureFile('BEFORE: settings.json.pre-index-migration', path.join(ROOT, 'settings.json.pre-index-migration'))
measureFile('AFTER:  settings.json (index only)', path.join(ROOT, 'settings.json'))

console.log()
console.log('the Rust process also no longer re-parses every chats/**/*.json')
console.log('file on a cache miss (merge_chats_from_disk was removed from the hot path).')
