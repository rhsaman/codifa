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
  type SkillMention,
} from '../src/lib/skills.ts'

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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستهای کش پاس شدند ✅')
