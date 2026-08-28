// تست سطح تابع برای resetStreamForRetry: وقتی بک‌اند رویداد `retry` می‌فرستد،
// متن نیمه‌کاره‌ی attempt قبلی باید پاک شود (content خالی + حذف text segments)
// ولی tool/user segments (کار واقعیِ replay‌شده) باید بمانند.
// Run: npx esbuild test/retryStream.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=test/.tmp-rs.mjs --external:electron \
//        && node test/.tmp-rs.mjs
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const { resetStreamForRetry } = await import('../src/lib/retry.ts')

let failed = 0
const check = (n: string, c: boolean, e?: unknown) => {
  c ? console.log(`  ✅ ${n}`) : (failed++, console.error(`  ❌ ${n}`, e ?? ''))
}

console.log('resetStreamForRetry: پاک‌کردن متن نیمه‌کاره، حفظ tool/user:')
{
  const segs = [
    { kind: 'text', text: 'سلام من دارم ' },
    { kind: 'tool', index: 0 },
    { kind: 'text', text: 'فلان کار را ' },
    { kind: 'user', id: 'u1' },
  ] as any
  const r = resetStreamForRetry('سلام من دارم فلان کار را ', segs)
  check('content خالی شد', r.content === '', r)
  check('فقط textها حذف شدند', r.segments.length === 2, r.segments)
  check('tool حفظ شد', r.segments[0]?.kind === 'tool', r.segments)
  check('user حفظ شد', r.segments[1]?.kind === 'user', r.segments)
}

console.log('resetStreamForRetry: وقتی segments خالی باشد، فقط content ریست می‌شود:')
{
  const r = resetStreamForRetry('متن بدون segment', undefined)
  check('content خالی شد', r.content === '', r)
  check('segments آرایه خالی شد', Array.isArray(r.segments) && r.segments.length === 0, r.segments)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
