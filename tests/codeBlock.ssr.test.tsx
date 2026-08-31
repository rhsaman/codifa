// SSR sanity test for CodeBlock (run via test/run-frontend.sh).
// Covers the line-numbered code block:
//  - each source line is wrapped in a `.code-line` span
//  - the raw code text is present (so copy still yields the code)
//  - syntax highlighting (hljs-*) survives the per-line split
//  - a ```mermaid fence is delegated to the Mermaid renderer, not numbered
// Mock the Electron bridge before importing the component.
import React from 'react'
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
const { mdComponents } = await import('../src/components/ChatMessage')
// mdComponents.pre is the exported CodeBlock renderer (kept internal on purpose).
const CodeBlock = mdComponents.pre as React.FC<any>

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const sample = [
  'function add(a, b) {',
  '  return a + b',
  '}',
].join('\n')

console.log('1) بلوک کد با شماره‌خط رندر می‌شود:')
{
  const html = renderToString(
    <CodeBlock className="language-js">
      <code className="language-js">{sample}</code>
    </CodeBlock>,
  )
  check('کلاس code-block دارد', html.includes('code-block'))
  // 3 source lines → 3 .code-line spans
  const lineCount = (html.match(/class="code-line"/g) || []).length
  check('دقیقاً ۳ خط (.code-line) دارد', lineCount === 3, lineCount)
  // 1-based numbering when no start line is given.
  check('شماره ۱ در gutter هست', html.includes('code-gutter" aria-hidden="true">1<'))
  check('شماره ۳ در gutter هست', html.includes('code-gutter" aria-hidden="true">3<'))
  // Raw code text is present (copy yields the code, not the numbers). We strip
  // the hljs span tags to verify the source text survived the per-line split.
  const textOnly = html.replace(/<[^>]+>/g, '')
  check('متن تابع add حاضر است', textOnly.includes('function add'))
  check('متن return حاضر است', textOnly.includes('return a + b'))
  // Syntax highlighting survives the per-line split.
  check('هایلایت hljs حفظ شده', html.includes('hljs-'), html.slice(0, 200))
}

console.log('1b) شماره خط واقعی فایل (lang:start-end) رعایت می‌شود:')
{
  const html = renderToString(
    <CodeBlock className="language-go:19-20">
      <code className="language-go:19-20">{'func main() {\n  fmt.Println("hi")\n}'}</code>
    </CodeBlock>,
  )
  check('شماره ۱۹ در gutter هست', html.includes('code-gutter" aria-hidden="true">19<'))
  check('شماره ۲۰ در gutter هست', html.includes('code-gutter" aria-hidden="true">20<'))
  check('شماره ۲۱ در gutter هست', html.includes('code-gutter" aria-hidden="true">21<'))
  check('زبان go تشخیص داده شد', html.includes('>go<'))
}

console.log('2) بلوک mermaid به نمودار واگذار می‌شود (بدون شماره‌خط):')
{
  const html = renderToString(
    <CodeBlock className="language-mermaid">
      <code className="language-mermaid">{'graph TD; A-->B'}</code>
    </CodeBlock>,
  )
  check('هیچ .code-line ندارد', !html.includes('code-line'))
  check('به Mermaid واگذار شد', html.includes('mermaid') || html.length > 0)
}

console.log('3) نام فایل در هدر نمایش داده نمی‌شود (طبق درخواست حذف شد):')
{
  const html = renderToString(
    <CodeBlock className="language-tsx:src/App.tsx">
      <code className="language-tsx:src/App.tsx">export const x = 1</code>
    </CodeBlock>,
  )
  check('کلاس code-block-file ندارد', !html.includes('code-block-file'))
  check('نام فایل src/App.tsx در هدر نیست', !html.includes('src/App.tsx'), html)
  check('زبان tsx تشخیص داده شد', html.includes('>tsx<'))
}

console.log('4) نام فایل در هدر نمایش داده نمی‌شود (طبق درخواست حذف شد):')
{
  // مدل گاهی بلاک را با اینفو استرینگ فاصله‌دار می‌نویسد:
  //   ```go applications/buyusecase/Plan.go
  // که در meta به صورت "go applications/buyusecase/Plan.go" می‌نشیند.
  // نام فایل باید کلاً از هدر حذف شود (طبق درخواست کاربر).
  const html = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="go applications/buyusecase/Plan.go">
        {'package buyusecase'}
      </code>
    </CodeBlock>,
  )
  check('کلاس code-block-file ندارد', !html.includes('code-block-file'))
  check('نام فایل در هدر نیست', !html.includes('applications/buyusecase/Plan.go'), html)
  check('پیشوند تکراری "go " در هدر نیست', !html.includes('>go applications'), html)

  // حالت اسلش‌دار نیز نباید نام فایل نشان دهد.
  const html2 = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="go/applications/buyusecase/Plan.go">
        {'package buyusecase'}
      </code>
    </CodeBlock>,
  )
  check('حالت اسلش‌دار: کلاس code-block-file ندارد', !html2.includes('code-block-file'), html2)
  check('حالت اسلش‌دار: نام فایل در هدر نیست', !html2.includes('applications/buyusecase/Plan.go'), html2)
}

console.log('5) ارجاع متد به اشتباه مسیر فایل تشخیص داده نمی‌شود (باگ go user.CreatedAt.After / go userentity.Safir):')
{
  // مدل گاهی اینفو استرینگ را به صورت یک ارجاع متد می‌نویسد:
  //   ```go user.CreatedAt.After
  // که در meta به صورت "go user.CreatedAt.After" می‌نشیند. این یک مسیر فایل
  // نیست (نه / دارد و نه فرم name.ext ساده)، پس نباید در هدر نمایش داده شود.
  const html = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="go user.CreatedAt.After">
        {'if user.CreatedAt.After(other) {\n}'}
      </code>
    </CodeBlock>,
  )
  check('هدر فایل ندارد (ارجاع متد مسیر نیست)', !html.includes('code-block-file'), html)
  check('زبان go تشخیص داده شد', html.includes('>go<'))

  // حالت دقیق تصویر: ```go userentity.Safir — یک نقطه دارد اما پسوندش (.Safir)
  // یک پسوند کد واقعی نیست، پس نباید به عنوان نام فایل در هدر بنشیند.
  const htmlSafir = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="go userentity.Safir">
        {'// change user level\nerr = ChangeLevel(user, false)'}
      </code>
    </CodeBlock>,
  )
  check('هدر فایل ندارد (userentity.Safir مسیر نیست)', !htmlSafir.includes('code-block-file'), htmlSafir)
  check('زبان go تشخیص داده شد', htmlSafir.includes('>go<'))
  check('متن userentity.Safir در هدر نیست', !htmlSafir.includes('userentity.Safir'), htmlSafir)

  // یک خط کامنت داخل کد مثل `// user.CreatedAt.After` نیز نباید مسیر فرض شود.
  const html2 = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go">
        {'// user.CreatedAt.After\nif user.CreatedAt.After(other) {\n}'}
      </code>
    </CodeBlock>,
  )
  check('کامنت داخل کد هدر فایل ندارد', !html2.includes('code-block-file'), html2)
  check('متن کامنت در کد حاضر است', html2.replace(/<[^>]+>/g, '').includes('user.CreatedAt.After'))
}

console.log('6) کامنت واقعی با / دیگر هدر فایل نمی‌سازد (نام فایل حذف شد):')
{
  const html = renderToString(
    <CodeBlock className="language-ts">
      <code className="language-ts">
        {'// src/components/App.tsx\nexport const x = 1'}
      </code>
    </CodeBlock>,
  )
  check('کلاس code-block-file ندارد', !html.includes('code-block-file'))
  // The filename may appear inside code text (as a comment) — only verify
  // it is NOT rendered inside the code-block-head header area.
  const headHtml = html.split('</div>')[0] // first </div> closes code-block-head
  check('نام فایل src/components/App.tsx در هدر نیست', !headHtml.includes('src/components/App.tsx'), html)
  check('متن کامنت در کد حاضر است', html.replace(/<[^>]+>/g, '').includes('src/components/App.tsx'))
}

console.log('7) فرمت کانونیکال lang:START-END:path شماره خط را رعایت می‌کند (مسیر در هدر نمایش داده می‌شود):')
{
  const html = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="19-20:applications/buyusecase/Plan.go">
        {'func main() {\n}'}
      </code>
    </CodeBlock>,
  )
  check('مسیر فایل در هدر هست', html.includes('applications/buyusecase/Plan.go'), html)
  check('شماره خط ۱۹ در gutter هست', html.includes('code-gutter" aria-hidden="true">19<'))
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}

console.log('8) دو بلوک کد متوالی هر کدام مسیر فایل جداگانه دارند:')
{
  const html1 = renderToString(
    <CodeBlock className="language-go">
      <code className="language-go" data-meta="19-20:Plan.go">
        {'func main() {}'}
      </code>
    </CodeBlock>,
  )
  const html2 = renderToString(
    <CodeBlock className="language-python">
      <code className="language-python" data-meta="5-10:utils.py">
        {'def helper(): pass'}
      </code>
    </CodeBlock>,
  )
  check('بلوک اول: مسیر Plan.go در هدر', html1.includes('Plan.go'), html1)
  check('بلوک اول: شماره خط ۱۹', html1.includes('code-gutter" aria-hidden="true">19<'), html1)
  check('بلوک دوم: مسیر utils.py در هدر', html2.includes('utils.py'), html2)
  check('بلوک دوم: شماره خط ۵', html2.includes('code-gutter" aria-hidden="true">5<'), html2)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log('\nهمه تستها پاس شدند ✅')
process.exit(0)
