export function fixMixedText(text: string): string {
  return text.replace(
    /([A-Za-z0-9]+(?:[\s.\-][A-Za-z0-9]+)+|->|=>|<-|<=|>=|<<|>>|→|←|↑|↓|⇒|⇐|[A-Za-z0-9](?:[A-Za-z0-9@._:/~-]*[A-Za-z0-9])?)/g,
    (m) => "\u2068" + m + "\u2069",
  )
}

export function prepareContent(text: string, dir: 'rtl' | 'ltr'): string {
  if (dir !== 'rtl' || !text) return text
  const parts = text.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    return p
      .split('\n')
      .map((line) => fixMixedText(line))
      .join('\n')
  })
  return fixed.join('```')
}
