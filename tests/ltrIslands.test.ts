// Unit tests for the LTR-island wrapper (src/lib/ltrIslands.ts) — mixed
// Persian/English chat text must keep numbers, ranges, percents and Latin
// word runs readable left-to-right in BOTH paragraph directions.
// The samples are the real strings that scrambled in chats mw3osi50 and
// mvzq140l. Run: node tests/ltrIslands.test.ts (via tests/run-frontend.sh).
import { isolateLtrRuns, rehypeLtrIslands, type HastNode } from '../src/lib/ltrIslands.ts'

const LRI = '\u2066'
const PDI = '\u2069'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

/** The islands are pure wrappers: stripping them must return the input. */
function roundTrips(input: string, out: string): boolean {
  return out.split(LRI).join('').split(PDI).join('') === input
}

console.log('1) رنج عددی در متن فارسی — LTR می‌ماند:')
{
  const out = isolateLtrRuns('دامنه 1.10–1.16')
  check('رنج داخل جزیره است', out === `دامنه ${LRI}1.10–1.16${PDI}`, JSON.stringify(out))
  check('round-trip', roundTrips('دامنه 1.10–1.16', out))
}

console.log('2) رنج فارسی با درصد — ٪ داخل جزیره می‌ماند:')
{
  const out = isolateLtrRuns('به ۳٫۷۵–۴٫۰۰٪ رسید')
  check('۳٫۷۵–۴٫۰۰٪ یک‌تکه', out.includes(`${LRI}۳٫۷۵–۴٫۰۰٪${PDI}`), JSON.stringify(out))
  const sign = isolateLtrRuns('ماه +۰٫۰۴٪ روزانه')
  check('علامت + و ٪ داخل جزیره', sign.includes(`${LRI}+۰٫۰۴٪${PDI}`), JSON.stringify(sign))
}

console.log('3) عبارت مخلوط TE: Q4 ≈ 1.12 (سلول جدول mvzq140l):')
{
  const out = isolateLtrRuns('TE: Q4 ≈ 1.12، ۱۲ماهه ≈ 1.14')
  check(
    'کل عبارت انگلیسی+عدد یک جزیره است (قبل از «ماهه» می‌شکند)',
    out === `${LRI}TE: Q4 ≈ 1.12، ۱۲${PDI}ماهه ≈ ${LRI}1.14${PDI}`,
    JSON.stringify(out),
  )
}

console.log('4) سلول CPI:')
{
  const out = isolateLtrRuns('CPI اکتبر ۴٫۰٪ (بالاترین از ۲۰۲۳)')
  // CPI تکی است و جزیره نمی‌گیرد؛ ۴٫۰٪ و ۲۰۲۳ جزیره می‌گیرند.
  check('CPI دست‌نخورده (تکنمی، نمی‌شکند)', out.startsWith('CPI اکتبر '), JSON.stringify(out))
  check('۴٫۰٪ جزیره', out.includes(`${LRI}۴٫۰٪${PDI} (`), JSON.stringify(out))
  check('۲۰۲۳ جزیره نمی‌گیرد (تکنمی، امن است)', out.endsWith('از ۲۰۲۳)'), JSON.stringify(out))
}

console.log('5) دستور /plugin (اسلش اول داخل جزیره می‌ماند — باگ اصلی mw3osi50):')
{
  const out = isolateLtrRuns(
    '/plugin install https://github.com/mnemox-ai/tradememory-plugin.git',
  )
  check(
    'کل دستور یک جزیره با اسلش اول',
    out === `${LRI}/plugin install https://github.com/mnemox-ai/tradememory-plugin.git${PDI}`,
    JSON.stringify(out),
  )
  const chip = isolateLtrRuns('با /plugin install wshobson/agents plugins/quantitative-trading نصب')
  check('چیپ وسط جمله هم یک‌تکه', chip.includes(`${LRI}/plugin install wshobson/agents plugins/quantitative-trading${PDI}`), JSON.stringify(chip))
}

console.log('6) لیست انگلیسی با کامای فارسی — نباید تکه‌تکه وارون شود:')
{
  const out = isolateLtrRuns('(VCP، CANSLIM، PEAD)')
  check('VCP، CANSLIM، PEAD یک جزیره', out === `(${LRI}VCP، CANSLIM، PEAD${PDI})`, JSON.stringify(out))
}

console.log('7) پرانتز دور محتوای فارسی نباید داخل جزیره بیفتد:')
{
  const out = isolateLtrRuns('از Trading Economics (۵ نوامبر) است')
  check('پرانتز از جزیره بیرون ماند', out === `از ${LRI}Trading Economics${PDI} (۵ نوامبر) است`, JSON.stringify(out))
  // A fully-enclosed Latin phrase (balanced parens) stays one island.
  const en = isolateLtrRuns('see foo(bar) docs')
  check('see foo(bar) docs یک جزیره', en === `${LRI}see foo(bar) docs${PDI}`, JSON.stringify(en))
}

console.log('8) فلش‌ها هرگز داخل جزیره نیستند (مال rehypeArrows):')
{
  const out = isolateLtrRuns('1.1180 → 1.1300–1.1400')
  check('فلش بیرون، دو عدد دو جزیره', out === `${LRI}1.1180${PDI} → ${LRI}1.1300–1.1400${PDI}`, JSON.stringify(out))
}

console.log('9) متن فارسی خالص دست‌نخورده:')
{
  const fa = 'سلام این یک متن فارسی است، خنثی تا صعودی؛ چسبنده.'
  check('بدون تغییر', isolateLtrRuns(fa) === fa)
  const short = isolateLtrRuns('خط ۵ و ۱۲')
  check('عدد تکی جزیره نمی‌گیرد', short === 'خط ۵ و ۱۲', JSON.stringify(short))
}

console.log('10) ران هرگز از خط نمی‌گذرد و تکنمی‌ها جزیره نمی‌گیرند:')
{
  // hello تکنمی است (هیچ glue ندارد) → جزیره نمی‌گیرد ولی نمی‌شکند.
  const out = isolateLtrRuns('hello\nسلام')
  check('بدون تغییر', out === 'hello\nسلام', JSON.stringify(out))
  const two = isolateLtrRuns('دامنه 1.10–1.16\nو بازگشت 1.16')
  check('جزیره از \n عبور نمی‌کند', two === `دامنه ${LRI}1.10–1.16${PDI}\nو بازگشت ${LRI}1.16${PDI}`, JSON.stringify(two))
}

console.log('11) شناسه‌ها و واژه‌های چندگانه:')
{
  const out = isolateLtrRuns('در Trading Economics دیدم')
  check('Trading Economics یک جزیره', out === `در ${LRI}Trading Economics${PDI} دیدم`, JSON.stringify(out))
  const kw = isolateLtrRuns('با Q4 و 1607MB و ~۱۵۰ واحد')
  // Q4 و 1607MB تکنمی‌اند (EN بعد از L داخل همان ران L می‌ماند) → بدون جزیره هم امن‌اند.
  check('Q4 دست‌نخورده', kw.includes('Q4') && !kw.includes(`Q4${PDI}`), JSON.stringify(kw))
  check('1607MB دست‌نخورده', kw.includes('1607MB') && !kw.includes(`1607MB${PDI}`), JSON.stringify(kw))
  check('~۱۵۰ با ~ داخل جزیره', kw.includes(`${LRI}~۱۵۰${PDI}`), JSON.stringify(kw))
}

console.log('12) rehypeLtrIslands — walker روی درخت hast:')
{
  const codeText = 'range = 1.10–1.16'
  const linkText = 'https://x.io/a/b'
  const tree: HastNode = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        children: [
          { type: 'text', value: 'دامنه 1.10–1.16 است' },
          { type: 'element', tagName: 'code', children: [{ type: 'text', value: codeText }] },
          { type: 'element', tagName: 'a', children: [{ type: 'text', value: linkText }] },
          { type: 'element', tagName: 'script', children: [{ type: 'text', value: 'x = 1.5' }] },
        ],
      },
    ],
  }
  rehypeLtrIslands()(tree)
  const p = tree.children![0] as HastNode
  check('متن پاراگراف جزیره گرفت', (p.children![0] as HastNode).value!.includes(`${LRI}1.10–1.16${PDI}`))
  check('code دست‌نخورده', (p.children![1] as HastNode).children![0].value === codeText)
  check('a دست‌نخورده', (p.children![2] as HastNode).children![0].value === linkText)
  check('script دست‌نخورده', (p.children![3] as HastNode).children![0].value === 'x = 1.5')
}

console.log('13) round-trip روی همه نمونه‌ها (هیچ کاراکتری گم نمی‌شود):')
{
  const samples = [
    'دامنه 1.10–1.16',
    'TE: Q4 ≈ 1.12، ۱۲ماهه ≈ 1.14',
    'CPI اکتبر ۴٫۰٪ (بالاترین از ۲۰۲۳)',
    '/plugin install https://github.com/pasie15/claude-trading-skills-marketplace.git',
    'بقیهٔ کاندیدها (مثل orion-trading-intelligence که فقط سیگنال بیتکوین میدهد) — swings روی سهام',
    'فدرال رزرو ۱۶ سپتامبر اولین افزایش از ۲۰۲۳ به ۳٫۷۵–۴٫۰۰٪؛ SEP و صورت‌جلسه',
    'مقامت روانی 1.1250 به‌عنوان سطحی که تحلیل‌گران روی آن متمرکز شده‌اند',
    'شکست **1.1180** → 1.1300–1.1400 — hmm',
    '',
  ]
  let all = true
  for (const s of samples) {
    if (!roundTrips(s, isolateLtrRuns(s))) {
      all = false
      console.error('    round-trip failed for:', JSON.stringify(s))
    }
  }
  check('همه نمونه‌ها', all)
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks`)
  process.exit(1)
}
console.log('\nAll ltrIslands checks passed')
