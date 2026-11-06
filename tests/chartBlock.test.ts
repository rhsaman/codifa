// Unit tests for the ```chart spec parser (src/components/ChartBlock.tsx).
// Run: node tests/chartBlock.test.ts (via tests/run-frontend.sh).
import { niceMax, parseChartSpec } from '../src/components/ChartBlock.tsx'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) اسپک معتبر bar:')
{
  const spec = parseChartSpec(
    JSON.stringify({
      type: 'bar',
      title: 'عوامل فاندامنتال بر EUR/USD',
      unit: 'تعداد',
      labels: ['صعودی برای یورو', 'نزولی برای یورو', 'خنثی تا صعودی'],
      series: [{ name: 'اثر', values: [1, 3, 1] }],
    }),
  )
  check('type bar', spec?.type === 'bar')
  check('۳ لیبل', spec?.labels.length === 3)
  check('series values', spec?.series[0].values.join(',') === '1,3,1')
  check('title', spec?.title === 'عوامل فاندامنتال بر EUR/USD')
  check('unit', spec?.unit === 'تعداد')
}

console.log('2) مقادیر رشته‌ای/فارسی coerce می‌شوند:')
{
  const spec = parseChartSpec(
    JSON.stringify({ type: 'line', labels: ['الف', 'ب'], series: [{ values: ['1.12', '۴۰', 'x'] }] }),
  )
  check('اعداد coerce و آشغال حذف', spec?.series[0].values.join(',') === '1.12,40', spec?.series[0].values)
}

console.log('3) اسپک نامعتبر → null (fallback به سورس خام):')
{
  check('JSON خراب', parseChartSpec('{type: bar') === null)
  check('type ناشناخته', parseChartSpec('{"type":"donut","labels":[],"series":[]}') === null)
  check('بدون series', parseChartSpec('{"type":"bar","labels":["a"]}') === null)
  check('series خالی', parseChartSpec('{"type":"pie","labels":["a"],"series":[{"values":[]}]}') === null)
  check('values همه نامعتبر', parseChartSpec('{"type":"pie","labels":["a"],"series":[{"values":["x"]}]}') === null)
}

console.log('4) Pie با سری واحد:')
{
  const spec = parseChartSpec(
    JSON.stringify({ type: 'pie', labels: ['A', 'B'], series: [{ values: [2, 3] }] }),
  )
  check('pie ok', spec?.type === 'pie')
}

console.log('5) niceMax سقف محور:')
{
  check('3.2 → 5', niceMax(3.2) === 5, niceMax(3.2))
  check('1 → 1', niceMax(1) === 1)
  check('6 → 10', niceMax(6) === 10, niceMax(6))
  check('120 → 200', niceMax(120) === 200, niceMax(120))
  check('0/negative → 1', niceMax(0) === 1 && niceMax(-4) === 1)
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks`)
  process.exit(1)
}
console.log('\nAll chartBlock checks passed')
