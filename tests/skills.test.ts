// Unit tests for @skill mention extraction (src/lib/skills.ts).
// Run: node test/skills.test.ts
//
// NOTE: extractMentionSkills only needs the SkillMention *type* (type-only
// import from api.ts, erased at runtime), so this test runs under plain Node
// with no Electron/window stub required.
// @ts-nocheck

import { extractMentionSkills, type SkillMention } from '../src/lib/skills.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const SKILLS: SkillMention[] = [
  { name: 'Anthropic Frontend Design', slug: 'anthropic-frontend-design' },
  { name: 'learning-explainer', slug: 'learning-explainer' },
  { name: 'data-analysis', slug: 'data-analysis' },
]

console.log('1) توکن slug (فرمت بی‌ابهام خط‌تیره):')
{
  const { skills, cleaned } = extractMentionSkills(
    '@anthropic-frontend-design یه داشبورد ساده طراحی کن',
    SKILLS,
  )
  check('نام اسکیل استخراج شد', skills.length === 1 && skills[0] === 'Anthropic Frontend Design', skills)
  check('متن پاک شد (بدون @)', !cleaned.includes('@'), cleaned)
  check('بقیهٔ جمله حفظ شد', cleaned.includes('یه داشبورد ساده طراحی کن'), cleaned)
}
{
  const { skills } = extractMentionSkills('@learning-explainer تفاوت async چیست؟', SKILLS)
  check('اسکیل تک‌کلمه‌ای با slug کار می‌کند', skills[0] === 'learning-explainer', skills)
}

console.log('2) سازگاری با نام نمایشی با فاصله (fallback):')
{
  const { skills, cleaned } = extractMentionSkills(
    '@Anthropic Frontend Design یه داشبورد ساده طراحی کن',
    SKILLS,
  )
  check('نام چندکلمه‌ای تشخیص داده شد', skills.length === 1 && skills[0] === 'Anthropic Frontend Design', skills)
  check('متن پاک شد', !cleaned.includes('@'), cleaned)
}

console.log('3) چند منشن در یک پیام:')
{
  const { skills } = extractMentionSkills(
    '@learning-explainer و @data-analysis رو مقایسه کن',
    SKILLS,
  )
  check('هر دو اسکیل پیدا شدند', skills.length === 2, skills)
  check('نام‌ها درست هستند', skills.includes('learning-explainer') && skills.includes('data-analysis'), skills)
}

console.log('4) منشن نامعتبر نادیده گرفته می‌شود:')
{
  const { skills, cleaned } = extractMentionSkills('@unknown-skill این رو تست کن', SKILLS)
  check('اسکیل نامعتبر استخراج نشد', skills.length === 0, skills)
  check('متن دست‌نخورده ماند', cleaned === '@unknown-skill این رو تست کن', cleaned)
}

console.log('5) بدون اسکیل در لیست:')
{
  const { skills, cleaned } = extractMentionSkills('@anthropic-frontend-design سلام', [])
  check('خروجی خالی است', skills.length === 0 && cleaned === '@anthropic-frontend-design سلام', { skills, cleaned })
}

console.log('6) حساسیت به حروف کوچک/بزرگ ندارد:')
{
  const { skills } = extractMentionSkills('@ANTHROPIC-FRONTEND-DESIGN x', SKILLS)
  check('slug با حروف بزرگ هم کار می‌کند', skills[0] === 'Anthropic Frontend Design', skills)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
