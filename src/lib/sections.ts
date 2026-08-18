/**
 * Split a markdown document into sections for the reading-mode viewer.
 *
 * Primary structure: ATX headings (`#` … `######`). When a message has no
 * headings at all, agents often structure it with bold-only lines
 * (`**Title**`) or numbered items (`1. Title`, `۱. عنوان`) — those are used
 * as a fallback so the reading mode still works for such replies.
 *
 * Text before the first section marker is dropped. Sections with no content
 * after the marker are skipped (except numbered items, which are meaningful
 * on their own). Marker-looking lines inside fenced code blocks (``` / ~~~)
 * are NOT treated as sections. Returns [] when nothing matches.
 */

export interface Section {
  id: string
  title: string
  level: number
  content: string
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const BOLD_RE = /^\s*\*{2,3}(.+?)\*{2,3}\s*$/
const UNDER_RE = /^\s*_{2,3}(.+?)\_{2,3}\s*$/
const NUM_RE = /^\s*(?:\([\d۰-۹]{1,3}\)|[\d۰-۹]{1,3}[.)])\s+(.+)$/

/** Strip bold markers from a title (e.g. `**Install**` → `Install`). */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .trim()
}

/** Match a line that is *entirely* bold text (`**Title**`, `__Title__`,
 *  `***Title***`). Returns the title, or null. Lines like `**a** and **b**`
 *  or `**Note:** text` are NOT headings and return null. */
function matchBold(line: string): string | null {
  const m = BOLD_RE.exec(line) ?? UNDER_RE.exec(line)
  if (!m) return null
  const title = m[1].trim()
  if (title.includes('*') || title.includes('_')) return null
  return title
}

interface Pending {
  id: string
  title: string
  level: number
  /** Numbered items are meaningful even without a body — keep them. */
  keep: boolean
}

function collect(lines: string[], mode: 'heading' | 'fallback'): Section[] {
  const sections: Section[] = []
  let current: Pending | null = null
  let buf: string[] = []
  /** Fence marker ('`' or '~') when inside a fenced code block, else null. */
  let fence: string | null = null

  const flush = () => {
    if (!current) return
    const content = buf.join('\n').trim()
    if (content || current.keep) {
      sections.push({
        id: current.id,
        title: current.title,
        level: current.level,
        content: content || current.title,
      })
    }
    current = null
    buf = []
  }

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] === '`' ? '`' : '~'
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      buf.push(line)
      continue
    }
    if (fence) {
      buf.push(line)
      continue
    }

    let title: string | null = null
    let level = 1
    let keep = false
    if (mode === 'heading') {
      const m = HEADING_RE.exec(line)
      if (m) {
        title = m[2].trim()
        level = m[1].length
      }
    } else {
      const bold = matchBold(line)
      if (bold !== null) {
        title = bold
      } else {
        const n = NUM_RE.exec(line)
        if (n) {
          title = cleanTitle(n[1])
          keep = true
        }
      }
    }

    if (title !== null) {
      flush()
      current = { id: `s${sections.length}`, title, level, keep }
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

/** Split `markdown` into sections. See the module doc for the rules. */
export function splitSections(markdown: string): Section[] {
  if (!markdown) return []
  const lines = markdown.split('\n')
  const headingSections = collect(lines, 'heading')
  if (headingSections.length > 0) return headingSections
  return collect(lines, 'fallback')
}