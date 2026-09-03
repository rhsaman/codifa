import { prepareContent } from '../src/lib/bidi.ts'

const cases = [
  // نمونه‌ی واقعی از تصویر کاربر
  '```ts\n# HashMap نقش را بازی می‌کند\n```',
  // کامنت مخلوط فارسی/انگلیسی
  '```ts\n// کاربر user.id را ست کرد\n```',
  // کامنت فقط فارسی
  '```ts\n// این تابع کاربر را احراز هویت می‌کند\n```',
  // کامنت فقط انگلیسی
  '```ts\n// authenticate the user\n```',
]

for (const c of cases) {
  console.log('IN:  ' + JSON.stringify(c))
  console.log('OUT: ' + JSON.stringify(prepareContent(c)))
  console.log('---')
}
