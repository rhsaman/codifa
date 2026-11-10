// The sidebar's Chats ⇄ Files switch: the persisted view store, plus the
// markup/CSS contract that makes the switch work (checked on the sources, like
// the other layout tests — effects and hooks do not run under SSR).
export {}
let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`, extra ?? '')
  }
}

// A junk value on disk: the store must fall back to Chats instead of trusting it.
const disk = new Map<string, string>([['coder:sidebarView', 'bogus']])
let writes = 0
;(globalThis as any).localStorage = {
  getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
  setItem: (k: string, v: string) => {
    writes += 1
    disk.set(k, String(v))
  },
  removeItem: (k: string) => {
    disk.delete(k)
  },
}

const { useSidebarView } = await import('../src/lib/sidebarView')
const { readFileSync } = await import('node:fs')

console.log('1) the view store:')
{
  check('an unknown stored value falls back to the chats view', useSidebarView.getState().view === 'chats')

  useSidebarView.getState().setView('files')
  check('setView switches to the Files view', useSidebarView.getState().view === 'files')
  check('the choice is persisted', disk.get('coder:sidebarView') === 'files')

  const before = writes
  useSidebarView.getState().setView('files')
  check('setting the same view again writes nothing', writes === before, { before, writes })

  useSidebarView.getState().setView('chats')
  check('and it switches back', useSidebarView.getState().view === 'chats' && disk.get('coder:sidebarView') === 'chats')
}

console.log('2) the switch markup:')
{
  const src = readFileSync('src/components/Sidebar.tsx', 'utf8')
  const chromeAt = src.indexOf('const chrome = (')
  const filesReturnAt = src.indexOf('if (view === "files")')
  const headAt = src.indexOf('<div className="sidebar-head">')
  check('the switch is part of the shared chrome', chromeAt !== -1 && src.indexOf('className="sidebar-switch"') > chromeAt)
  check('the chrome is defined before both returns', chromeAt < filesReturnAt && filesReturnAt < headAt)
  check('the chrome sits first in the Files return', /sidebar-inner">\s*\{chrome\}\s*<div className="sidebar-files-view">/.test(src))
  check('and first in the chats return, above the search head', /sidebar-inner">\s*\{chrome\}\s*<div className="sidebar-head">/.test(src))
  check('the explorer is mounted in the Files view', src.includes('<FilesPanel />'))
  check('the switch is a tablist with one tab per view', src.includes('role="tablist"') && src.includes('role="tab"'))
  check('the container exposes the view to the CSS thumb', src.includes('data-view={view}'))
  check('the segments are icon-only (label lives in aria-label/title)', !src.includes('<span>{v.label}</span>') && src.includes('aria-label={v.label}'))
}

console.log('3) the switch styles:')
{
  const css = readFileSync('src/styles/global/14-modern-file-explorer.css', 'utf8')
  check('the thumb slides to the second segment on Files', /\.sidebar-switch\[data-view="files"\] \.sidebar-switch-thumb\s*\{[^}]*translateX\(100%\)/.test(css))
  check('the thumb animates its movement', /\.sidebar-switch-thumb\s*\{[^}]*transition:\s*transform/.test(css))
  check('the explorer fills the space under the switch', /\.sidebar-files-view\s*\{[^}]*flex:\s*1 1 auto/.test(css))
  check('reduced motion switches the animation off', /prefers-reduced-motion[\s\S]*\.sidebar-switch-thumb/.test(css))
}

console.log('4) the explorer is gone from the right pane:')
{
  const bar = readFileSync('src/components/ViewerTabBar.tsx', 'utf8')
  check('the dock has no Files entry', !bar.includes('kind: "files"'))
  const content = readFileSync('src/components/ViewerContent.tsx', 'utf8')
  const windows = readFileSync('src/components/ViewerWindows.tsx', 'utf8')
  check('the pane no longer mounts the explorer', !content.includes('<FilesPanel') && !windows.includes('<FilesPanel'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
