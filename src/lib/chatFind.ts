/**
 * Find-in-chat engine behind the Cmd/Ctrl+F widget (ChatFindBar).
 *
 * The transcript is ReactMarkdown DOM owned by React, so matches are painted
 * with the CSS Custom Highlight API — Range-based highlights that never touch
 * the DOM, so streaming updates, memoized re-renders and the selection/comment
 * persist-spans are left alone. Every Tauri webview that matters ships it:
 * WKWebView (Safari 17.2+), WebKitGTK 2.46+ and WebView2 (Chromium 105+).
 * Without it the bar still counts and navigates; it only cannot paint.
 *
 * Matching granularity is the BLOCK: text inside one <p>/<li>/<pre>/… joins
 * into a single flattened run, so "hello **world**" is found across the
 * <strong> boundary. A block boundary or a <br> ends a run, so a query never
 * matches across two messages or across two lines of one message.
 *
 * The pure core (runs, matching, index stepping) is plain-node testable:
 * segments carry the text they stand for, and only the thin DOM layer knows
 * about real Text nodes, Ranges and CSS.highlights.
 */

/** Paint registry names (::highlight() rules in global.css). The registry is
 *  document-global, so one find bar owns the paint at a time — opening the bar
 *  in another chat window claims it and the previous owner closes (see
 *  claimFindPaint). */
export const FIND_HL_ALL = "chat-find";
export const FIND_HL_ACTIVE = "chat-find-active";

/** Hard cap so a pathological query (one letter over a 10MB transcript) can't
 *  build millions of Ranges. The bar renders the counter as "2000+". */
export const MAX_FIND_MATCHES = 2000;

// ── Pure core ───────────────────────────────────────────────────────────────

/** One DOM text node's contribution to a run: `node` is whatever produced
 *  `text` (a real Text node in the DOM layer, a stub in tests). */
export interface FindSeg {
  node: unknown;
  text: string;
}

/** Consecutive text inside one block, flattened for matching. */
export interface FindRun {
  segs: FindSeg[];
  text: string;
}

/** A query hit: `start` is the char offset into `run.text` (UTF-16 units, so
 *  offsets map 1:1 onto Text-node offsets). */
export interface RunMatch {
  run: FindRun;
  start: number;
  length: number;
}

export function makeRun(segs: FindSeg[]): FindRun {
  return { segs, text: segs.map((s) => s.text).join("") };
}

/** Non-overlapping indexOf loop over one flattened run, spending at most
 *  `budget` more matches. Case folding is plain toLowerCase: good enough for
 *  a findbar (Persian and most code queries are unaffected by the rare
 *  Unicode case-expansion edge case). */
export function findRunMatches(
  run: FindRun,
  query: string,
  matchCase: boolean,
  budget: number,
): RunMatch[] {
  const out: RunMatch[] = [];
  if (!query) return out;
  const hay = matchCase ? run.text : run.text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  let from = 0;
  while (out.length < budget) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push({ run, start: i, length: query.length });
    from = i + query.length;
  }
  return out;
}

export function findMatches(
  runs: FindRun[],
  query: string,
  matchCase: boolean,
  cap: number = MAX_FIND_MATCHES,
): RunMatch[] {
  const out: RunMatch[] = [];
  if (!query) return out;
  for (const run of runs) {
    if (out.length >= cap) break;
    out.push(...findRunMatches(run, query, matchCase, cap - out.length));
  }
  return out;
}

/** Wrap-around step for the match counter; -1 means "no matches". A stale or
 *  "not yet on a match" index (-1, past the end) wraps/clamps into range, so
 *  stepping from a fresh search lands on the first (or last) match. */
export function stepMatch(cur: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  const c = ((Math.trunc(cur) % count) + count) % count;
  return (c + delta + count) % count;
}

// ── Block classification (pure) ─────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "section", "article", "header", "footer", "main", "aside", "nav", "form",
  "fieldset", "figure", "figcaption", "dl", "dt", "dd", "details", "summary",
  "hr",
]);

export function isBlockTag(tag: string): boolean {
  return BLOCK_TAGS.has(tag.toLowerCase());
}

// ── DOM layer ───────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

/** Flatten the DOM under `root` into per-block runs of text segments. A run
 *  continues while consecutive text nodes share the same nearest block
 *  ancestor (inline wrappers — strong/em/a/code — stay inside the run); a
 *  <br> or a new block starts a new run. */
export function collectRuns(root: Node): FindRun[] {
  const doc = root.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.createTreeWalker !== "function") return [];
  const blockOf = new Map<Node, Node>();
  const runs: FindRun[] = [];
  let cur: { segs: FindSeg[]; block: Node } | null = null;

  const flush = () => {
    if (cur && cur.segs.length) runs.push(makeRun(cur.segs));
    cur = null;
  };

  // Nearest block ancestor (or `root`) of a text node, cached per parent —
  // sibling text nodes share it and markdown nests deeply.
  const nearestBlock = (textNode: Node): Node => {
    const p = textNode.parentNode;
    if (!p) return root;
    const cached = blockOf.get(p);
    if (cached) return cached;
    let n: Node | null = p;
    while (n && n !== root) {
      const tag = (n as Element).tagName;
      if (tag && isBlockTag(tag)) break;
      n = n.parentNode;
    }
    const block = n ?? root;
    blockOf.set(p, block);
    return block;
  };

  const walker = doc.createTreeWalker(
    root,
    // SHOW_ELEMENT (for <br> flush markers and skip subtrees) | SHOW_TEXT.
    0x1 | 0x4,
    {
      acceptNode(node: Node): number {
        if (node.nodeType === 3 /* TEXT_NODE */) return 1 /* ACCEPT */;
        const tag = ((node as Element).tagName || "").toLowerCase();
        if (SKIP_TAGS.has(tag)) return 2 /* REJECT — skips the subtree */;
        if (tag === "br") return 1 /* ACCEPT — line boundary */;
        return 3 /* SKIP — visit children */;
      },
    },
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== 3) {
      flush(); // <br>: a line break ends the run even inside one <p>
      continue;
    }
    const text = node as Text;
    if (!text.data) continue;
    const block = nearestBlock(text);
    if (cur && cur.block === block) cur.segs.push({ node: text, text: text.data });
    else {
      flush();
      cur = { segs: [{ node: text, text: text.data }], block };
    }
  }
  flush();
  return runs;
}

/** Map a match offset range back onto the DOM: a Range spanning the exact
 *  text, possibly across several inline nodes. Returns null for stub nodes
 *  (tests) or degenerate runs. */
export function rangeForMatch(m: RunMatch): Range | null {
  const first = m.run.segs[0]?.node as Text | undefined;
  const doc = first?.ownerDocument;
  if (!doc || typeof doc.createRange !== "function" || typeof first?.substringData !== "function") {
    return null;
  }
  const end = m.start + m.length;
  let acc = 0;
  let sc: Text | null = null;
  let so = 0;
  let ec: Text | null = null;
  let eo = 0;
  for (const seg of m.run.segs) {
    const segEnd = acc + seg.text.length;
    if (!sc && m.start < segEnd) {
      sc = seg.node as Text;
      so = m.start - acc;
    }
    if (end <= segEnd) {
      ec = seg.node as Text;
      eo = end - acc;
      break;
    }
    acc = segEnd;
  }
  if (!sc || !ec) return null;
  const r = doc.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  return r;
}

// ── Painting (CSS Custom Highlight API) ─────────────────────────────────────

interface HighlightRegistry {
  set(name: string, hl: unknown): unknown;
  delete(name: string): unknown;
}
interface HighlightCtor {
  new (...ranges: Range[]): { add(range: Range): unknown };
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

export function highlightSupported(): boolean {
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return typeof ctor === "function" && highlightRegistry() !== null;
}

/** Repaint the two highlight names. `active` is excluded from the "all" set
 *  and painted once with the stronger active style. */
export function paintFind(ranges: Range[], active: number): void {
  const reg = highlightRegistry();
  const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (!reg || !ctor) return;
  const all = new ctor();
  const act = new ctor();
  ranges.forEach((r, i) => {
    if (i === active) act.add(r);
    else all.add(r);
  });
  reg.set(FIND_HL_ALL, all);
  reg.set(FIND_HL_ACTIVE, act);
}

export function clearFindPaint(): void {
  highlightRegistry()?.delete(FIND_HL_ALL);
  highlightRegistry()?.delete(FIND_HL_ACTIVE);
}

/** Center the match in its scroll container. Uses the range's host element so
 *  matches inside deep inline wrappers still scroll into view. */
export function scrollToMatch(range: Range): void {
  const start = range.startContainer;
  const el = (start.nodeType === 1 ? start : start.parentElement) as HTMLElement | null;
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ── Single paint owner ──────────────────────────────────────────────────────
// The highlight registry is document-global while chat windows can be split,
// so the paint belongs to exactly one open bar: opening claims it, the
// previous owner closes its bar through the subscription below.

let paintOwner: symbol | null = null;
const ownerListeners = new Set<(t: symbol | null) => void>();

export function currentFindOwner(): symbol | null {
  return paintOwner;
}

export function claimFindPaint(token: symbol): void {
  if (paintOwner === token) return;
  paintOwner = token;
  ownerListeners.forEach((fn) => fn(paintOwner));
}

/** Clear the owner when the owning bar goes away. Deliberately SILENT: the
 *  only bar that cares is the one releasing (its subscription would otherwise
 *  fire during its own unmount and re-run its close path — the "Escape closed
 *  the bar but focus jumped to the transcript" regression). A claim by a new
 *  bar is the only owner change that needs announcing. */
export function releaseFindPaint(token: symbol): void {
  if (paintOwner !== token) return;
  paintOwner = null;
}

export function onFindPaintOwner(fn: (t: symbol | null) => void): () => void {
  ownerListeners.add(fn);
  return () => {
    ownerListeners.delete(fn);
  };
}
