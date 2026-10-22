// Unit tests for the shared skill-list cache (src/lib/skills.ts).
// Covers the gap where a newly saved skill must show up in @mention matching
// without an app restart. Run: node test/skillsCache.test.ts
//
// The backend fetch is injected via setSkillsFetcher (so this module stays
// free of the Electron/window-bound `api` layer). We inject a controllable
// stub here instead of importing api.ts.

// @ts-nocheck
import {
  extractMentionSkills,
  getSkillsList,
  ensureSkillsList,
  invalidateSkillsList,
  resetSkillsCacheForTest,
  setSkillsFetcher,
  getAvailableSkills,
  ensureAvailableSkills,
  invalidateAvailableSkills,
  resetAvailableSkillsCacheForTest,
  setAvailableSkillsFetcher,
  pluginSkillCommands,
  type SkillMention,
} from '../src/lib/skills.ts'
import type { SkillRow } from '../src/lib/api.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const OLD: SkillMention[] = [
  { name: 'learning-explainer', slug: 'learning-explainer' },
]
const NEW: SkillMention[] = [
  ...OLD,
  { name: 'Anthropic Frontend Design', slug: 'anthropic-frontend-design' },
]

// Controllable backend: we flip `backendList` to simulate "skill added after save".
let backendList: SkillMention[] = OLD
setSkillsFetcher(async () => backendList)
// Second, wider catalog: store + enabled-plugin skills. Plugin rows carry
// `plugin`, which is what turns them into `/`-commands.
let availableList: SkillRow[] = []
setAvailableSkillsFetcher(async () => availableList)

console.log('1) کش در ابتدا خالی است:')
{
  resetSkillsCacheForTest()
  check('getSkillsList خالی برمی‌گرداند', getSkillsList().length === 0, getSkillsList())
}

console.log('2) بارگذاری اولیه از بک‌اند:')
{
  resetSkillsCacheForTest()
  backendList = OLD
  const list = await ensureSkillsList()
  check('لیست قدیمی بارگذاری شد', list.length === 1 && list[0].slug === 'learning-explainer', list)
  check('اسکیل جدید هنوز دیده نمی‌شود', !getSkillsList().some((s) => s.slug === 'anthropic-frontend-design'), getSkillsList())
}

console.log('3) سناریوی ذخیرهٔ اسکیل جدید (رفرش کش):')
{
  // Simulate: user saves a new skill in Settings -> backend now returns NEW,
  // and the UI calls invalidateSkillsList().
  backendList = NEW
  invalidateSkillsList()
  // Give the fire-and-forget refetch a tick to resolve.
  await new Promise((r) => setTimeout(r, 10))
  check('بعد از invalidate، اسکیل جدید در کش هست', getSkillsList().some((s) => s.slug === 'anthropic-frontend-design'), getSkillsList())

  const { skills } = extractMentionSkills('@anthropic-frontend-design طراحی کن', getSkillsList())
  check('منشن اسکیل تازه‌ذخیره‌شده کار می‌کند', skills.length === 1 && skills[0] === 'Anthropic Frontend Design', skills)
}

console.log('4) حذف اسکیل (رفرش لیست):')
{
  backendList = OLD
  invalidateSkillsList()
  await new Promise((r) => setTimeout(r, 10))
  check('اسکیل حذف‌شده دیگر در کش نیست', !getSkillsList().some((s) => s.slug === 'anthropic-frontend-design'), getSkillsList())
}

console.log('5) کامند /plugin skill → /<slug> و کش دومی:')
{
  resetSkillsCacheForTest()
  resetAvailableSkillsCacheForTest()
  setAvailableSkillsFetcher(async () => availableList)
  check('کش دومی ابتدا خالی است', getAvailableSkills().length === 0, getAvailableSkills())
  availableList = [
    { name: 'Ponytail', slug: 'ponytail', description: 'lazy senior dev', plugin: 'Ponytail' },
    { name: 'Ponytail Audit', slug: 'ponytail-audit', description: 'repo audit', plugin: 'Ponytail' },
    // A standalone skill: reachable by @mention, must NOT become a command.
    { name: 'Movie Finder', slug: 'movie-finder', description: 'find movies' },
  ]
  const rows = await ensureAvailableSkills()
  check('کاتالوگ کامل بارگذاری شد', rows.length === 3, rows)
  const cmds = pluginSkillCommands(rows)
  check('فقط skillهای پلاگین کامند می‌شوند', cmds.length === 2, cmds)
  check('نام کامند = slug', cmds[0].name === 'ponytail' && cmds[1].name === 'ponytail-audit', cmds)
  check('نام اسکیل برای attach = name', cmds[0].skill === 'Ponytail', cmds)
  check('پلاگین در hint آمده', cmds[0].hint.includes('Ponytail'), cmds[0].hint)

  // Toggling the plugin off must drop its commands on the next refresh.
  // The new list is in place BEFORE the invalidate, since the fetch starts
  // inside it and would otherwise read the old rows.
  availableList = [{ name: 'Movie Finder', slug: 'movie-finder', description: 'find movies' }]
  invalidateAvailableSkills()
  await new Promise((r) => setTimeout(r, 10))
  check('بعد از خاموش‌کردن پلاگین کامندی نمی‌ماند', pluginSkillCommands(getAvailableSkills()).length === 0, getAvailableSkills())
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستهای کش پاس شدند ✅')
