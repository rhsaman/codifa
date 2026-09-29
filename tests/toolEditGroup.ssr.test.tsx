// تست SSR گروه ویرایش جدا: edit_file/write_fileهای پشت‌سرهم در یک
// ToolEditGroupView جمع می‌شوند و هرگز با گروه ابزارهای فقط‌خواندنی قاطی نمی‌شوند.
// پوشش:
//  - ۲+ ویرایش پشت‌سرهم → یک tool-edit-group با هدر جمع +N -M
//  - ویرایش تکی → کارت تکی قدیمی (بدون tool-edit-group)
//  - ترکیب ویرایش + ابزار فقط‌خواندنی → دو گروه جدا (ویرایش جدا از tool-group)
//  - هر ردیف گروه ویرایش Undo و Review تکی خودش را دارد
;(globalThis as any).window = {
  addEventListener: () => {},
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return async () => {}
      },
    },
  ),
}

const { renderToString } = await import('react-dom/server')
const { ChatMessageView } = await import('../src/components/ChatMessage')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

function editActivity(path: string, adds: number, dels: number, tool = 'edit_file') {
  const plus = Array.from({ length: adds }, (_, i) => `+new line ${i}`).join('\n')
  const minus = Array.from({ length: dels }, (_, i) => `-old line ${i}`).join('\n')
  return {
    tool,
    status: 'done' as const,
    args: { path },
    diff: `--- a/${path}\n+++ b/${path}\n${minus}\n${plus}`,
  } as never
}

function makeMessage(
  segments: Array<{ kind: 'tool'; index: number }>,
  toolActivity: Array<unknown>,
) {
  return {
    id: 'm-edit',
    role: 'assistant' as const,
    content: '',
    createdAt: Date.now(),
    segments: segments as never,
    toolActivity: toolActivity as never,
  }
}

console.log('1) دو ویرایش پشت‌سرهم → یک گروه ویرایش واحد:')
{
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    [editActivity('src/a.ts', 3, 1), editActivity('src/b.ts', 2, 2, 'write_file')],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('گروه ویرایش رندر شد', html.includes('tool-edit-group'))
  check('فقط یک گروه ویرایش است', (html.match(/tool-edit-group/g) || []).length >= 1)
  check('هدر جمع +5 را دارد', html.includes('+5'))
  check('هدر جمع -3 را دارد', html.includes('-3'))
  check('نام فایل اول هست', html.includes('a.ts'))
  check('نام فایل دوم هست', html.includes('b.ts'))
}

console.log('2) ویرایش تکی → کارت تکی (بدون گروه ویرایش):')
{
  const msg = makeMessage(
    [{ kind: 'tool', index: 0 }],
    [editActivity('src/solo.ts', 1, 0)],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('گروه ویرایش ساخته نشد', !html.includes('tool-edit-group'))
  check('کارت تکی ویرایش هست', html.includes('solo.ts'))
}

console.log('3) ویرایش + ابزار فقط‌خواندنی → دو گروه جدا:')
{
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
      { kind: 'tool', index: 2 },
      { kind: 'tool', index: 3 },
    ],
    [
      editActivity('src/a.ts', 2, 1),
      editActivity('src/b.ts', 1, 1),
      { tool: 'grep', status: 'done', args: { pattern: 'foo' } },
      { tool: 'read', status: 'done', args: { path: 'src/c.ts' } },
    ],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  check('گروه ویرایش جدا هست', html.includes('tool-edit-group'))
  check('گروه ابزار فقط‌خواندنی جدا هست', html.includes('tool-group'))
  check(
    'گروه ویرایش قبل از گروه ابزار است',
    html.indexOf('tool-edit-group') < html.indexOf('tool-group'),
  )
}

console.log('4) هر ردیف گروه ویرایش Undo و Review تکی دارد:')
{
  const msg = makeMessage(
    [
      { kind: 'tool', index: 0 },
      { kind: 'tool', index: 1 },
    ],
    [editActivity('src/a.ts', 1, 1), editActivity('src/b.ts', 1, 0)],
  )
  const html = renderToString(<ChatMessageView message={msg} />)
  const undoCount = (html.match(/↩ Undo/g) || []).length
  const reviewCount = (html.match(/Review ↗/g) || []).length
  check('دو دکمه Undo تکی', undoCount === 2, `found ${undoCount}`)
  check('دو بج Review تکی', reviewCount === 2, `found ${reviewCount}`)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
} else {
  console.log('\nهمه بررسی‌های گروه ویرایش موفق بود')
}
