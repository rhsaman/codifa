// Unit tests for the repo-address heuristic (src/lib/repoAddress.ts).
//
// Why it matters: `/plugin install eurusd` used to reach the backend and fail
// with "cannot read a repo from …", which reads as a bug when the user simply
// named a bundle they wanted made. The composer now asks THIS function which of
// the two the argument is, so it must agree with `repo::looks_like_repo_address`
// — a bare word is a NAME, anything address-shaped is an address.

import { looksLikeRepoAddress } from '../src/lib/repoAddress.ts'
import { readFileSync } from 'node:fs'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

console.log('1) a bare word is a NAME, not an address:')
{
  check('eurusd', looksLikeRepoAddress('eurusd') === false)
  check('multi-word name', looksLikeRepoAddress('release notes') === false)
  check('empty string', looksLikeRepoAddress('') === false)
  check('whitespace only', looksLikeRepoAddress('   ') === false)
  check('trailing space still a name', looksLikeRepoAddress(' eurusd ') === false)
}

console.log('2) the shapes that ARE addresses:')
{
  check('owner/repo', looksLikeRepoAddress('anthropics/claude-plugins-official') === true)
  check('https URL', looksLikeRepoAddress('https://github.com/a/b') === true)
  check('absolute path', looksLikeRepoAddress('/Users/saman/plugins/mine') === true)
  check('relative path', looksLikeRepoAddress('./mine') === true)
  check('home path', looksLikeRepoAddress('~/mine') === true)
  check('ssh address', looksLikeRepoAddress('git@github.com:a/b.git') === true)
}

console.log('3) trimming does not change the answer:')
{
  check('padded address', looksLikeRepoAddress('  owner/repo  ') === true)
  check('padded name', looksLikeRepoAddress('  eurusd  ') === false)
}

console.log('4) the composer asks the SAME question for /skill and /mcp install:')
{
  // `/plugin install eurusd` was fixed first; the skill and MCP branches kept
  // sending "install from this repo" for a bare name, which the backend answers
  // with "cannot read a repo from …" after spending a whole turn. The composer
  // must route a NAME to create and only an ADDRESS to install, for all three.
  const src = readFileSync('src/components/Chat.tsx', 'utf8')
  check(
    'the skill/mcp install branch consults the heuristic',
    /if \(verb === "install" && tail\.length > 0\) \{[\s\S]{0,700}?looksLikeRepoAddress\(first\)/.test(src),
  )
  check(
    'an address-shaped argument still sends the install prompt',
    src.includes('Install a skill from this repo: "${first}"') &&
      src.includes('Install an MCP connector bundle from this repo: "${first}"'),
  )
  check(
    'a bare name sends a CREATE prompt instead of a doomed install',
    src.includes('Create a skill named "${first}"') &&
      src.includes('Create an MCP connector named "${first}"'),
  )
  check(
    'the created skill prompt forbids the repo path that would fail',
    src.includes('Do not pass "repo" — there is no repository here'),
  )
  // `/artifact` has no `install` sub-command at all (a document is authored, not
  // read from a repo), so the same trap cannot exist there — assert that rather
  // than leaving it untested.
  check(
    '/artifact never claims an install sub-command',
    !/\/artifact install/.test(src),
  )
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll tests passed. ✅')
}
