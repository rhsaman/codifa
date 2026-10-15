// Node test for the highlight-comment message the agent receives. The header
// states the path and position ONCE and the quote follows — the old format
// repeated them in separate File/Lines/Range lines plus a trailing "Direct
// edit" directive, which bloated every reply with the same path and line
// number three or four times.
// Run: npx esbuild tests/fileComment.test.ts --bundle --platform=node \
//        --format=esm --packages=external --outfile=tests/.tmp-fileComment.mjs && node tests/.tmp-fileComment.mjs
import './_globals.ts'
const { formatFileComment } = await import('../src/lib/fileComments.ts')

let failed = 0
function check(name: string, cond: boolean, actual?: unknown) {
  if (cond) {
    console.log(`ok - ${name}`)
  } else {
    failed++
    console.error(`FAIL - ${name}`, actual)
  }
}

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1

// 1) Code line: path and line appear exactly once, in the header.
{
  const out = formatFileComment('src/lib/fs.ts:185', 'export function')
  check('line comment states the path once', count(out, 'src/lib/fs.ts') === 1, out)
  check('line comment states the line once', count(out, '185') === 1, out)
  check('line comment keeps the quote', out.includes('> export function'), out)
  check('line comment has no redundant File: line', !out.includes('\nFile:'), out)
  check('line comment has no redundant Lines: line', !out.includes('\nLines:'), out)
  check('line comment has no Direct edit directive', !out.includes('Direct edit'), out)
  check('line comment has no Search Files directive', !out.includes('Search Files'), out)
}

// 2) Line range.
{
  const out = formatFileComment('src/a.ts:10-20', 'body')
  check('range comment says lines 10-20', out.includes('(lines 10-20)'), out)
  check('range comment repeats the range once', count(out, '10-20') === 1, out)
}

// 3) Spreadsheet cell range with sheet.
{
  const out = formatFileComment('data.xlsx:Sheet1!B3:D5', 'cell')
  check('sheet comment names the sheet once', count(out, 'Sheet1') === 1, out)
  check('sheet comment names the range once', count(out, 'B3:D5') === 1, out)
  check('sheet comment has no redundant Sheet: line', !out.includes('\nSheet:'), out)
  check('sheet comment has no redundant Range: line', !out.includes('\nRange:'), out)
}

// 4) Spreadsheet rows without columns.
{
  const out = formatFileComment('data.csv:rows 3-5', 'row')
  check('rows comment says rows 3-5', out.includes('(rows 3-5)'), out)
  check('rows comment repeats the rows once', count(out, '3-5') === 1, out)
}

// 5) No locator: the path is stated once.
{
  const out = formatFileComment('README.md', 'text')
  check('plain comment states the path once', count(out, 'README.md') === 1, out)
  check('plain comment keeps the quote', out.includes('> text'), out)
}

// 6) Multi-line quotes stay quoted line by line.
{
  const out = formatFileComment('a.ts:1', 'one\ntwo')
  check('multi-line quote prefixes every line', out.includes('> one\n> two'), out)
}

// 7) Invisible bidi/zero-width marks (RTL model output) must not defeat the
//    marker strip: a leading mark hid the "[" and the header then repeated the
//    path and line, and a mark inside the path broke the same-file comparison.
{
  const ZW = '\u200b'
  const RLM = '\u200f'
  const file = 'backend/tests/test_test_execution_rule.py'
  const marker = `[${file} line 3]`
  const quote = `${marker} Checks\n\nNote: hi`
  const lead = formatFileComment(`${file}:3`, `${ZW}${quote}`)
  check('leading invisible mark still strips the marker', !lead.includes(marker), lead)
  check('leading invisible mark states the path once', count(lead, file) === 1, lead)
  const inPath = formatFileComment(`${file}${ZW}:3`, quote)
  check('invisible mark in the path still strips the marker', !inPath.includes(marker), inPath)
  const inQuote = formatFileComment(`${file}:3`, `[${file}${RLM} line 3] Checks`)
  check('invisible mark inside the marker still strips it', !inQuote.includes('line 3]'), inQuote)
}

if (failed > 0) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
