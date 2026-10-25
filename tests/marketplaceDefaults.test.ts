// Unit tests for the shipped-marketplace merge (src/lib/marketplaceDefaults.ts).
//
// Why it matters: a settings file written before the Skills and MCP indexes were
// shipped has a REAL `marketplaces` array, so the store's "does the field exist"
// hook passed it through untouched and both tabs stayed EMPTY — reported as
// "the skills and mcp tabs load nothing" and "search only exists on Plugins".
//
// Run: npx esbuild tests/marketplaceDefaults.test.ts --bundle --platform=node \
//        --format=esm --packages=external --outfile=.tmp-md.mjs && node .tmp-md.mjs

import {
  marketSourceKey,
  mergeShippedMarketplaces,
} from '../src/lib/marketplaceDefaults.ts'
import type { MarketplaceSource } from '../src/types.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}`, extra ?? '')
  }
}

const PLUGINS: MarketplaceSource = { repo: 'anthropics/claude-plugins-official', kind: 'plugins' }
const SKILLS: MarketplaceSource = { repo: 'anthropics/skills', kind: 'skills' }
const MCP: MarketplaceSource = { repo: 'anthropics/claude-plugins-community', kind: 'mcp' }
const SHIPPED = [PLUGINS, SKILLS, MCP]

console.log('۱) فایل قدیمی (نسخهٔ ۲) که فقط یک مارکت‌پلیس دارد، ایندکس‌های نیامده را می‌گیرد:')
{
  const custom: MarketplaceSource = { repo: 'me/mine', kind: 'plugins' }
  const out = mergeShippedMarketplaces([custom], SHIPPED, 2, 4)
  check('مارکت‌پلیس مهارت اضافه شد', out.some((m) => m.kind === 'skills'))
  check('مارکت‌پلیس MCP اضافه شد', out.some((m) => m.kind === 'mcp'))
  check('ردیف خود کاربر حفظ شد', out[0]?.repo === custom.repo)
  check('فقط دو ایندکس اضافه شد', out.length === 3, out)
  check('بازنشسته اضافه نشد', !out.some((m) => m.repo === PLUGINS.repo), out)
}

console.log('۲) حذف عمدی یک مارکت‌پلیس برنمی‌گردد (یک نسخه بالاتر):')
{
  const custom: MarketplaceSource = { repo: 'me/mine', kind: 'plugins' }
  const out = mergeShippedMarketplaces([custom, SKILLS, MCP], SHIPPED, 4, 4)
  check('نسخهٔ جاری دست‌نخورده می‌ماند', out.length === 3, out)
  check('همان ردیف‌ها باقی ماندند', out.map((m) => m.repo).join(',') === [custom, SKILLS, MCP].map((m) => m.repo).join(','), out)
}

console.log('۳) هیچ‌وقت تکراری نمی‌سازد (حتی با آدرس یکسان و path متفاوت):')
{
  const out = mergeShippedMarketplaces([SKILLS, MCP], SHIPPED, 0, 4)
  check('طول همان ۲ می‌ماند', out.length === 2, out)
  const reordered = mergeShippedMarketplaces([MCP], SHIPPED, 1, 4)
  check('فقط ایندکس نیامده اضافه شد', reordered.length === 2 && reordered.some((m) => m.kind === 'skills'), reordered)
  const withPath: MarketplaceSource = { ...SKILLS, path: 'sub' }
  const keyed = mergeShippedMarketplaces([withPath], SHIPPED, 0, 4)
  check('همان repo با path متفاوت جفت نمی‌شود', keyed.length === 3, keyed)
}

console.log('۴) فهرست کاملاً خالی: ایندکس‌های پیش‌فرض می‌آیند، بازنشسته نه:')
{
  // A file that EXISTS and carries an empty list means the user removed
  // everything by hand, but the shipped indexes still fill it — and the retired
  // plugin directory is never one of them. A file with NO `marketplaces` key at
  // all is a different case, answered by the store's own branch.
  const out = mergeShippedMarketplaces([], SHIPPED, 0, 4)
  check('بازنشسته برنمی‌گردد', !out.some((m) => m.repo === PLUGINS.repo), out)
  check('skills و mcp اضافه می‌شوند', out.length === 2, out)
}

console.log('۵) ابزار جفت‌کردن و بازنشستگی پیش‌فرض‌ها:')
{
  check('کلید با path/ref تفکیک می‌شود', marketSourceKey({ repo: 'a/b' }) !== marketSourceKey({ repo: 'a/b', path: 'x' }))
  check('کلید برای ردیف بدون path/ref پایدار است', marketSourceKey({ repo: 'a/b' }) === marketSourceKey({ repo: 'a/b', path: undefined }))
  // The requirement this encodes: the Anthropic plugin directory is no longer a
  // shipped default, so a file that still names it loses it — including one
  // already stamped with the CURRENT defaults version.
  const current = mergeShippedMarketplaces([PLUGINS, SKILLS], SHIPPED, 4, 4)
  check('مارکت‌پلیس بازنشسته از فایل جاری حذف شد', !current.some((m) => m.repo === PLUGINS.repo), current)
  check('بقیهٔ ردیف‌های کاربر دست‌نخورده ماند', current.length === 1 && current[0]?.repo === SKILLS.repo, current)
  const legacy = mergeShippedMarketplaces([PLUGINS], SHIPPED, 3, 4)
  check('فایل قدیمی هم بازنشسته را از دست داد', !legacy.some((m) => m.repo === PLUGINS.repo), legacy)
  check('فقط با path/ref دقیق حذف می‌شود', dropRetiredCheck())
}

function dropRetiredCheck(): boolean {
  // Keyed by ADDRESS only: a same-named repo under a sub-folder is a different
  // marketplace and must survive the retirement.
  const sub = { ...PLUGINS, path: 'sub' }
  const out = mergeShippedMarketplaces([sub], SHIPPED, 4, 4)
  return out.length === 1
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll marketplaceDefaults tests passed')
