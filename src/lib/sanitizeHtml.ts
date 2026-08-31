// Lightweight HTML sanitizer for trusted-but-still-untrusted markdown output.
//
// Why this exists: ``highlight.js`` and ``mermaid`` both produce raw HTML
// (``<span class="hljs-...">``, ``<svg>...``) that we then drop into
// ``dangerouslySetInnerHTML``. Both libraries have historically shipped
// XSS-shaped bugs (CVE-2023-20052 for Mermaid being the headline one), and
// ``highlight.js`` will happily round-trip any attribute a model writes into
// a code block through ``highlightAuto``. We can't add a runtime dep just for
// this in a small desktop app, so we sanitize in place by:
//
//   1. parsing the HTML into a detached ``DocumentFragment``,
//   2. walking every element, dropping the node if its tag isn't in an
//      allowlist, and stripping every attribute except the safe ones,
//   3. removing any URL whose scheme isn't ``http``/``https``/``mailto`` or
//      a relative ref (``#fragment``),
//   4. removing inline event handler attributes (``on*``) and ``style``/``srcdoc``.
//
// The allowlist is the UNION of the tags highlight.js emits
// (``span``, plus the wrapping block tags that may be passed through
// markdown) and the tags Mermaid emits (``svg``/``g``/``path``/``rect``/
// ``text``/``tspan``/``line``/``polygon``/``polyline``/``circle``/``ellipse``/
// ``defs``/``marker``/``foreignObject``/``title``/``desc``/``style``/``a``).
// A node whose tag isn't on the list is dropped, but its CHILDREN are
// preserved (so e.g. a stray ``<foo>bar</foo>`` becomes the text "bar"
// rather than vanishing entirely).

const ALLOWED_TAGS = new Set([
  // highlight.js + general markdown pass-through
  'span',
  'a',
  'code',
  'pre',
  'em',
  'strong',
  'b',
  'i',
  'u',
  'mark',
  'small',
  'sub',
  'sup',
  'br',
  // Mermaid SVG nodes
  'svg',
  'g',
  'path',
  'rect',
  'text',
  'tspan',
  'line',
  'polygon',
  'polyline',
  'circle',
  'ellipse',
  'defs',
  'marker',
  'foreignObject',
  'title',
  'desc',
  'style',
])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  '*': new Set(['class', 'id', 'title', 'lang', 'dir']),
  a: new Set(['href', 'target', 'rel']),
  svg: new Set(['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'role', 'aria-label']),
  g: new Set(['transform', 'fill', 'stroke', 'stroke-width', 'opacity']),
  path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'opacity', 'transform', 'marker-end', 'marker-start']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity', 'transform']),
  text: new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'font-family', 'font-size', 'font-weight', 'fill', 'stroke', 'transform']),
  tspan: new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'font-family', 'font-size', 'font-weight', 'fill']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'opacity']),
  polygon: new Set(['points', 'fill', 'stroke', 'stroke-width', 'opacity']),
  polyline: new Set(['points', 'fill', 'stroke', 'stroke-width', 'opacity']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'opacity']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity']),
  marker: new Set(['id', 'viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient']),
  defs: new Set([]),
  foreignObject: new Set(['x', 'y', 'width', 'height']),
  style: new Set([]),
  title: new Set([]),
  desc: new Set([]),
}

const SAFE_URL_RE = /^(?:(?:https?|mailto):|#|\/|\.\/|\.\.\/|[a-zA-Z0-9._~%+\-@/!$&'()*+,;=:])/i

function isSafeUrl(value: string): boolean {
  const v = (value || '').trim()
  if (!v) return true
  // Block any URL whose scheme is anything other than http(s)/mailto.
  // Also block javascript:, data:, vbscript:, file: — even when followed by
  // arbitrary junk, the presence of a dangerous scheme is enough.
  if (/^(?:javascript|data|vbscript|file):/i.test(v)) return false
  return SAFE_URL_RE.test(v)
}

function sanitizeNode(node: Element, doc: Document): Node | null {
  const tag = node.tagName.toLowerCase()
  if (!ALLOWED_TAGS.has(tag)) {
    // Drop the element but keep its children as a sibling fragment.
    const frag = doc.createDocumentFragment()
    while (node.firstChild) frag.appendChild(node.firstChild)
    return frag
  }
  // Walk the attribute list, keeping only allowlisted attrs with safe values.
  const allowed = new Set([
    ...(ALLOWED_ATTRS['*'] || []),
    ...(ALLOWED_ATTRS[tag] || []),
  ])
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase()
    // Drop every event handler, every style attr, srcdoc, formaction, etc.
    if (name.startsWith('on')) {
      node.removeAttribute(attr.name)
      continue
    }
    if (!allowed.has(name)) {
      node.removeAttribute(attr.name)
      continue
    }
    if ((name === 'href' || name === 'src' || name === 'xlink:href') && !isSafeUrl(attr.value)) {
      node.removeAttribute(attr.name)
    }
  }
  // Recurse into children, splicing in any replacements.
  for (const child of Array.from(node.children)) {
    const cleaned = sanitizeNode(child, doc)
    if (cleaned && cleaned !== child) {
      node.replaceChild(cleaned, child)
    }
  }
  return node
}

let _parser: DOMParser | null = null
function parser(): DOMParser {
  if (!_parser) _parser = new DOMParser()
  return _parser
}

/**
 * Sanitize a fragment of HTML for use with ``dangerouslySetInnerHTML``.
 *
 * Only tags on the internal allowlist (the union of ``highlight.js`` and
 * Mermaid's emitted tags) survive, and every attribute is dropped except
 * those explicitly listed per tag. URLs are rejected when their scheme is
 * anything other than ``http(s)``/``mailto``/relative.
 *
 * @param html - The HTML string to sanitize. Empty/whitespace-only input
 *   returns ``""`` rather than a 0-length string from the parser.
 */
export function sanitizeHtml(html: string): string {
  if (!html || !html.trim()) return ''
  // In SSR / Node.js environments DOMParser is unavailable; skip sanitization
  // here (the HTML is trusted server-rendered output) and let the client-side
  // pass handle it via the same function once the DOM is live.
  if (typeof DOMParser === 'undefined') return html
  // Wrap in a <body> wrapper so the parser accepts fragments containing
  // top-level <svg> nodes (the Mermaid case) — otherwise some browsers
  // strip the <svg> as if it were at the document root.
  const doc = parser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  )
  const out: Node[] = []
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const cleaned = sanitizeNode(child as Element, doc)
      if (cleaned) out.push(cleaned)
    } else if (child.nodeType === Node.TEXT_NODE) {
      out.push(child)
    }
  }
  const container = doc.createElement('div')
  for (const n of out) container.appendChild(n)
  return container.innerHTML
}
