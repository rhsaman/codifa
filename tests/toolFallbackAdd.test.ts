// «+ Add fallback» در Settings → Tools: ردیفی که افزوده می‌شود باید فوراً در
// استور بنشیند (وگرنه دکمه مرده به نظر می‌رسد)، ترتیب فهرست حفظ شود، و همان
// ترتیب به بک‌اند برود. ردیف نیم‌خالی (پروایدر بدون مدل) زنده می‌ماند تا کاربر
// بتواند مدل را انتخاب کند، ولی به سیم نمی‌رود.
// Run: npx esbuild tests/toolFallbackAdd.test.ts --bundle --platform=node --format=esm \
//        --packages=external --outfile=tests/.tmp-tfa.mjs --external:electron && node tests/.tmp-tfa.mjs
import './_globals.ts'

const { useStore } = await import('../src/lib/store.ts')
const { toolFallbackEntries, toolChainRows, toolChainSet } = await import('../src/lib/toolSlots.ts')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

/** The rows the Tools card reads for one slot. */
const rowsOf = (slot: string) => useStore.getState().toolFallbacks[slot] ?? []
/** The slot's whole try order, exactly as the card renders it. The provider id
 *  set is required: an entry's head is only a provider PREFIX when it names a
 *  provider that exists (a model id may itself contain a slash). */
const chainOf = (slot: string, own = '', ids: string[] = ['prov-a', 'prov-b', 'prov-z']) =>
  toolChainRows(own, rowsOf(slot), new Set(ids))

console.log('1) افزودن ردیف: ردیف تازه باید در استور ظاهر شود:')
{
  // همان چیزی که دکمه می‌فرستد: یک پروایدر واقعی، مدل هنوز انتخاب نشده.
  useStore.getState().setToolFallbacks('explore', [{ providerId: 'prov-a', model: '' }])
  check('the added row is stored', rowsOf('explore').length === 1, rowsOf('explore'))
  check(
    'the row points at the picked provider',
    rowsOf('explore')[0]?.providerId === 'prov-a',
    rowsOf('explore')[0],
  )
  check('the added row joins the tool list', chainOf('explore', 'prov-z/own').length === 2)
}

console.log('2) انتخاب مدل روی ردیف تازه، آن را قابل مسیریابی می‌کند:')
{
  useStore.getState().setToolFallbacks('explore', [{ providerId: 'prov-a', model: 'm-1' }])
  const wire = toolFallbackEntries(useStore.getState().toolFallbacks)
  check('the picked model reaches the wire', wire.explore?.[0] === 'prov-a/m-1', wire.explore)
}

console.log('3) ترتیب فهرست همان ترتیب تلاش است:')
{
  useStore.getState().setToolFallbacks('explore', [
    { providerId: 'prov-a', model: 'm-1' },
    { providerId: 'prov-b', model: 'm-2' },
  ])
  const wire = toolFallbackEntries(useStore.getState().toolFallbacks)
  check(
    'the arranged order is the wire order',
    JSON.stringify(wire.explore) === JSON.stringify(['prov-a/m-1', 'prov-b/m-2']),
    wire.explore,
  )
  // و مدل خودِ تول هم ردیف اول همین فهرست است.
  const chain = chainOf('explore', 'prov-z/own')
  check(
    'the tool own model is row 1 of the same list',
    chain[0]?.providerId === 'prov-z' && chain[1]?.providerId === 'prov-a' && chain[2]?.providerId === 'prov-b',
    chain,
  )
}

console.log('4) جابه‌جایی: ردیف اول هم مثل بقیه جابه‌جا می‌شود:')
{
  const chain = chainOf('explore', 'prov-z/own')
  const moved = toolChainSet([chain[1], chain[0], chain[2]])
  check('the tool model follows the row that lands first', moved.own === 'prov-a/m-1', moved)
  check(
    'the displaced model becomes a fallback',
    JSON.stringify(moved.fallbacks) === JSON.stringify([
      { providerId: 'prov-z', model: 'own' },
      { providerId: 'prov-b', model: 'm-2' },
    ]),
    moved.fallbacks,
  )
}

console.log('5) ردیف بدون هدف یعنی مدل کامپوزر، و ردیف نیم‌خالی به سیم نمی‌رود:')
{
  useStore.getState().setToolFallbacks('vision', [
    { providerId: '', model: '' },
    { providerId: 'prov-c', model: '' },
  ])
  const wire = toolFallbackEntries(useStore.getState().toolFallbacks)
  check(
    'the main-model row travels by name, in its own place',
    wire.vision?.[0] === 'main model',
    wire.vision,
  )
  check('the half-filled row is dropped from the wire', wire.vision?.length === 1, wire.vision)
  check('the half-filled row is still shown in the card', rowsOf('vision').length === 2)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll tool fallback add tests passed')
