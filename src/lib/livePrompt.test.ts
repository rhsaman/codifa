// Tests for the live-voice reply shaping in src/lib/livePrompt.ts.
// The suffix is what makes a spoken answer sound like speech instead of a
// document: one language, one script, plain prose, numbers as words.
// Run: npx esbuild src/lib/livePrompt.test.ts --bundle --platform=node
//        --format=esm --packages=external --external:electron
//        --outfile=tests/.tmp-live-prompt.mjs
//      && node tests/.tmp-live-prompt.mjs

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const { LIVE_VOICE_MARKER, buildLiveSpeakSuffix, isLiveVoiceSuffix } = await import('./livePrompt')

console.log('1) the suffix announces itself and is recognisable:')
{
  const fa = buildLiveSpeakSuffix('fa')
  check('the marker is present', fa.includes(LIVE_VOICE_MARKER), { head: fa.slice(0, 40) })
  check('isLiveVoiceSuffix recognises it', isLiveVoiceSuffix(fa))
  check('an empty suffix is not live', !isLiveVoiceSuffix(''))
  check('undefined is not live', !isLiveVoiceSuffix(undefined))
  check('a normal prompt is not live', !isLiveVoiceSuffix('You are a helpful coding agent.'))
  check('the suffix is trimmed', fa === fa.trim())
  check('the suffix is not a paragraph wall', fa.split('\n').length >= 5, { lines: fa.split('\n').length })
}

console.log('2) Persian answers must stay Persian, in the Persian alphabet:')
{
  const fa = buildLiveSpeakSuffix('fa')
  check('names the language', /persian/i.test(fa), { fa })
  check('demands the Persian alphabet', /persian alphabet/i.test(fa), { fa })
  check('forbids Latin letters', /latin/i.test(fa), { fa })
  check('forbids transliteration', /transliterat/i.test(fa), { fa })
  check('forbids English words', /no english/i.test(fa), { fa })
  check('forbids Arabic words', /no arabic/i.test(fa), { fa })
  check('is selected by the fa code regardless of case/space', buildLiveSpeakSuffix(' FA ') === fa)
}

console.log('3) every answer must be readable aloud:')
{
  const fa = buildLiveSpeakSuffix('fa')
  for (const word of ['markdown', 'code blocks', 'bullet', 'emoji', 'links', 'numbers']) {
    check(`the rules mention ${word}`, fa.toLowerCase().includes(word), { fa })
  }
  check('asks for short sentences', /short sentences/i.test(fa), { fa })
  check('asks for numbers as words', /numbers[\s\S]*as words/i.test(fa), { fa })
  check('forbids reading code aloud', /never read code/i.test(fa), { fa })
  check('forbids a preamble', /no preamble/i.test(fa), { fa })
  check('keeps the answer short by default', /two to four sentences/i.test(fa), { fa })
}

console.log('4) languages are distinct and unknown codes still get the rules:')
{
  const en = buildLiveSpeakSuffix('en')
  const fa = buildLiveSpeakSuffix('fa')
  const ar = buildLiveSpeakSuffix('ar')
  check('english differs from persian', en !== fa)
  check('arabic differs from persian', ar !== fa)
  check('english asks to stay in english', /english/i.test(en) && !/persian/i.test(en), { en })
  check('arabic asks for the arabic script', /arabic script/i.test(ar), { ar })
  check('russian asks for cyrillic', /cyrillic/i.test(buildLiveSpeakSuffix('ru')))

  // An unset language (Settings → Voice = Auto) must not silently drop the
  // voice rules: they are what makes the answer speakable at all.
  const auto = buildLiveSpeakSuffix('')
  check('auto still gets the voice rules', isLiveVoiceSuffix(auto))
  check('auto asks to stay in one language', /one language/i.test(auto), { auto })
  check('auto does not claim a specific language', !/persian alphabet/i.test(auto), { auto })
  check('an unknown code falls back like auto', buildLiveSpeakSuffix('xx') === auto, {
    unknown: buildLiveSpeakSuffix('xx'),
    auto,
  })
  check('a totally unknown code is still usable', buildLiveSpeakSuffix('klingon').length > 100)
}

console.log('5) the suffix stays small enough to send on every live turn:')
{
  const fa = buildLiveSpeakSuffix('fa')
  check('under 1200 characters', fa.length < 1200, { len: fa.length })
  check('over 300 characters (it carries real rules)', fa.length > 300, { len: fa.length })
  check('deterministic', buildLiveSpeakSuffix('fa') === fa)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall live prompt checks passed')
