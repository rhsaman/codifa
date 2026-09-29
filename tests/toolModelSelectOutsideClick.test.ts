// Regression test: the ToolModelSelect dropdown inside SettingsModal must
// close on outside click. The settings modal root stops mousedown
// propagation, so the picker's document listener must use the capture phase.
// Run: npx esbuild tests/toolModelSelectOutsideClick.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-tmsoc.mjs --external:electron && node tests/.tmp-tmsoc.mjs
import * as fs from 'node:fs'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const src = fs.readFileSync('src/components/SettingsModal.tsx', 'utf8')

// The outside-click listener must be registered in the capture phase so it
// runs before the modal root's stopPropagation on mousedown.
check(
  'outside-click listener uses capture phase (addEventListener)',
  src.includes("document.addEventListener('mousedown', onDoc, true)"),
)
check(
  'outside-click listener cleanup matches capture phase (removeEventListener)',
  src.includes("document.removeEventListener('mousedown', onDoc, true)"),
)

// The chevron sits inside the picker wrapper (so outside-click ignores it)
// and must toggle the dropdown explicitly — otherwise clicking it while open
// re-opens via input onClick and the popup never closes.
check('chevron toggles the dropdown on mousedown', src.includes('model-select-combo-chevron') && src.includes('if (open) closeMenu()'))

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`)
  process.exit(1)
}
console.log('\n✅ toolModelSelect outside-click tests passed')
