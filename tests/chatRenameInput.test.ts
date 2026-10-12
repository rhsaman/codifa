// SSR test for the shared chat rename input (run via tests/run-frontend.sh).
// ChatRenameInput is used by the window header and the chat tab bar so the
// title can be edited with double-click, like the sidebar.
export {};

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { ChatRenameInput, normalizeRenameValue } = await import('../src/components/ChatRenameInput')

const el = React.createElement

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

console.log('1) normalizeRenameValue (sidebar-style fallback):')
{
  check('trims surrounding spaces', normalizeRenameValue('  hello  ') === 'hello')
  check('empty becomes New chat', normalizeRenameValue('   ') === 'New chat')
  check('keeps inner text', normalizeRenameValue('my chat') === 'my chat')
}

console.log('2) ChatRenameInput SSR render:')
{
  const html = renderToString(
    el(ChatRenameInput, {
      initialValue: 'my chat',
      dir: 'ltr',
      className: 'chat-rename-input editor-tab-rename-input',
      ariaLabel: 'Rename my chat',
      onCommit: () => {},
      onCancel: () => {},
    }),
  )
  check('renders an input', html.includes('<input'))
  check('has the tab rename class', html.includes('editor-tab-rename-input'))
  check('carries the initial value', html.includes('value="my chat"'))
  check('has the rename aria-label', html.includes('aria-label="Rename my chat"'))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll chat rename input checks passed')
process.exit(0)
