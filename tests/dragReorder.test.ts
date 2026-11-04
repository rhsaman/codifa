// Unit tests for the shared drag-to-reorder math (src/lib/useDragReorder.ts
// + the captured-slot helpers in lib/tabBar.ts) used by the three reorderable
// Settings lists (Tools fallbacks, Web Provider engines, Media Provider
// ladders) and the provider API keys. The hook's drag events are browser-
// bound; what can break silently is the index/shift math, so that is pinned.
const { moveAt } = await import('../src/lib/useDragReorder')
const { slotShifts } = await import('../src/lib/tabBar')
const { previewOrder } = await import('../src/lib/tabOrder')

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}`, extra ?? '')
  }
}

const abcd = ['A', 'B', 'C', 'D']

// Dragging "above" a row lands the item at that row's index.
check(
  'move above: A over D → B C A D',
  JSON.stringify(moveAt(abcd, 0, 3)) === JSON.stringify(['B', 'C', 'A', 'D']),
  moveAt(abcd, 0, 3),
)

// Dragging "below" a row lands the item right after it.
check(
  'move below: D after A → A D B C',
  JSON.stringify(moveAt(abcd, 3, 1)) === JSON.stringify(['A', 'D', 'B', 'C']),
  moveAt(abcd, 3, 1),
)

// Dropping a row onto the gap it already occupies must not shuffle anything
// (the hook swallows it as a no-op, but the math itself must be identity too).
check(
  'no-op: A below B → unchanged',
  JSON.stringify(moveAt(abcd, 0, 1)) === JSON.stringify(abcd),
  moveAt(abcd, 0, 1),
)

check(
  'no-op: D above C? → D A B C is a real move',
  JSON.stringify(moveAt(abcd, 3, 2)) === JSON.stringify(['A', 'B', 'D', 'C']),
  moveAt(abcd, 3, 2),
)

// Consecutive swap via adjacent edges.
check(
  'adjacent swap: B above A → B A C D',
  JSON.stringify(moveAt(abcd, 1, 0)) === JSON.stringify(['B', 'A', 'C', 'D']),
  moveAt(abcd, 1, 0),
)

check(
  'adjacent swap: B below C → A C B D',
  JSON.stringify(moveAt(abcd, 1, 3)) === JSON.stringify(['A', 'C', 'B', 'D']),
  moveAt(abcd, 1, 3),
)

// The input list is never mutated (the Settings lists commit via new arrays).
const snapshot = JSON.stringify(abcd)
moveAt(abcd, 0, 3)
check('input not mutated', JSON.stringify(abcd) === snapshot)

// Out-of-range guards return a copy, not garbage.
check(
  'out-of-range from is a copy',
  JSON.stringify(moveAt(abcd, 9, 0)) === JSON.stringify(abcd),
  moveAt(abcd, 9, 0),
)

// Single-row list: any drag is a no-op (row 1 of a tool chain, one engine).
check(
  'single row unchanged',
  JSON.stringify(moveAt(['X'], 0, 0)) === JSON.stringify(['X']),
  moveAt(['X'], 0, 0),
)

// Chain of moves is stable — swap engines 2↔3 then promote the new last.
let list = ['a', 'b', 'c']
list = moveAt(list, 1, 3) // b below c → a c b
list = moveAt(list, 2, 0) // b to top → b a c
check(
  'chained moves compose',
  JSON.stringify(list) === JSON.stringify(['b', 'a', 'c']),
  list,
)

// ---------------------------------------------------------------------------
// slotShifts — the exact pixel deltas the drag preview slides by. These pin
// the two bugs that made drags jump: gaps left out of the slide distance, and
// uniform slot sizes over variable-width rows.
// ---------------------------------------------------------------------------

function slotsOf(starts: number[], ends: number[]) {
  const ids = starts.map((_, i) => `${i}`)
  return {
    ids,
    axis: 'y' as const,
    sign: 1 as const,
    start: new Map(ids.map((id, i) => [id, starts[i]])),
    end: new Map(ids.map((id, i) => [id, ends[i]])),
    scroller: null,
    scroll0: 0,
  }
}

// Equal rows (height 30) with an 8px gap → stride 38. Dragging row 0 below
// row 1 must slide each of them exactly one stride, not one offsetHeight.
{
  const slots = slotsOf([0, 38, 76], [30, 68, 106])
  const shifts = slotShifts(slots, '0', '1', true)
  check(
    'equal rows + gap: slide is a full stride',
    shifts.get('0') === 38 && shifts.get('1') === -38 && !shifts.has('2'),
    shifts,
  )
}

// Variable widths: A(0..100), B(100..150), C(150..250). Dragging A after B
// reflows to B@0, A@50, C@150 — B slides by ITS OWN slot, not A's.
{
  const slots = slotsOf([0, 100, 150], [100, 150, 250])
  const shifts = slotShifts(slots, '0', '1', true)
  check(
    'variable sizes: each row slides by the slot it crosses',
    shifts.get('0') === 50 && shifts.get('1') === -100 && !shifts.has('2'),
    shifts,
  )
}

// Dropping onto the row's own position produces no shifts (no-op preview).
{
  const slots = slotsOf([0, 38, 76], [30, 68, 106])
  const shifts = slotShifts(slots, '1', '1', false)
  check('no-op drop: zero shifts', shifts.size === 0, shifts)
}

// The previewed order equals the post-commit order (moveAt) for the same
// landing — the invariant that makes the commit invisible.
{
  const starts = [0, 40, 80, 120]
  const slots = slotsOf(starts, [36, 76, 116, 156])
  const shifts = slotShifts(slots, '3', '0', false)
  const next = previewOrder(slots.ids, '3', '0', false)
  // stride of original slot j: gap to the follower; the last slot's stride
  // is its own size (no follower).
  const stride = (j: number) =>
    j + 1 < slots.ids.length
      ? (slots.start.get(slots.ids[j + 1]) ?? 0) - (slots.start.get(slots.ids[j]) ?? 0)
      : (slots.end.get(slots.ids[j]) ?? 0) - (slots.start.get(slots.ids[j]) ?? 0)
  const landed = next.every((id, p) => {
    // final start of preview position p
    let top = slots.start.get(slots.ids[0]) ?? 0
    for (let q = 0; q < p; q++) top += stride(slots.ids.indexOf(next[q]))
    return (slots.start.get(id) ?? 0) + (shifts.get(id) ?? 0) === top
  })
  check('preview transforms land on the committed layout', landed, { next, shifts })
}

if (failed) {
  console.log(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('dragReorder: all checks passed')
