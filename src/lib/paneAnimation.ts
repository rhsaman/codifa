/* Why this exists: the sidebar and the right pane animate open/close on WIDTH
 * (flex-basis / width / max-width — `.sidebar` and `.viewer-group`). Width is
 * a layout property, so every frame of the 0.24–0.26s transition reflows the
 * whole shell, and the expensive part is the text of every mounted chat
 * window re-wrapping N_windows × 60 times per second — each frame shifts the
 * flex chain the windows live in. That is where the open/close stutter comes
 * from once more than one window is open.
 *
 * The guard: when a size transition starts on `.sidebar`/`.viewer-group`
 * (caught via transitionrun, so EVERY toggle path is covered without touching
 * any toggle site), the horizontal size of the heavy bodies — each visible
 * chat window's `.chat-scroll`, the `.sidebar-inner`, the `.viewer-content` —
 * is frozen inline for the duration. Frozen frames only reflow a handful of
 * container elements; the text re-wraps exactly once, when the freeze lifts.
 *
 * A frozen body can be WIDER than its shrinking container mid-slide, so
 * 20-pane-animation-guard.css clips the containers for the animation only. */

const SIZE_PROPERTIES = new Set(["flex-basis", "width", "max-width"])
const ANIMATED_CONTAINERS = ".sidebar, .viewer-group"
/** Safety net longer than the longest transition (0.26s): if an end event is
 *  missed (e.g. the tab is hidden mid-slide) the freeze still lifts. */
const FREEZE_MAX_MS = 500

let installed = false
/** Non-null while a freeze is live — doubles as the active flag. */
let endTimer: ReturnType<typeof setTimeout> | null = null
let frozen: { el: HTMLElement; width: string }[] = []
const endListeners = new Set<() => void>()

export function isPaneAnimating(): boolean {
  return (
    typeof document !== "undefined" &&
    document.body.classList.contains("pane-animating")
  )
}

/** Register a callback for when the freeze lifts — used to re-fit the window
 *  strip cluster, whose host stays frozen (and therefore ResizeObserver-silent)
 *  for the whole slide, leaving its last fit stale. */
export function onPaneAnimationEnd(cb: () => void): () => void {
  endListeners.add(cb)
  return () => {
    endListeners.delete(cb)
  }
}

function endFreeze() {
  if (endTimer === null) return
  clearTimeout(endTimer)
  endTimer = null
  document.body.classList.remove("pane-animating")
  for (const f of frozen) f.el.style.width = f.width
  frozen = []
  for (const cb of endListeners) cb()
}

/** Freeze `body` at `width` px, remembering the previous inline value. */
function freezeAt(body: HTMLElement | null, width: number): boolean {
  if (!body || width < 1) return false
  frozen.push({ el: body, width: body.style.width })
  body.style.width = `${Math.round(width)}px`
  return true
}

function beginFreeze() {
  if (endTimer !== null) {
    // flex-basis + width (+ max-width) start in the same frame, and a rapid
    // re-toggle mid-slide starts fresh transitions: re-arm, don't re-measure.
    clearTimeout(endTimer)
    endTimer = setTimeout(endFreeze, FREEZE_MAX_MS)
    return
  }
  let any = false
  // Chat scrollers freeze at their CURRENT width: the text keeps its present
  // wrap through the slide and re-wraps exactly once at the end.
  for (const el of document.querySelectorAll<HTMLElement>(".chat-scroll")) {
    any = freezeAt(el, el.getBoundingClientRect().width) || any
  }
  // The animated containers' own bodies. On OPEN freeze at the committed
  // target (the inline width the toggle just wrote — the live width is still
  // ~0 mid-slide), on CLOSE at the measured width; both give one re-wrap at
  // the end instead of one per frame. Hidden slots measure 0 and are skipped.
  for (const group of document.querySelectorAll<HTMLElement>(
    ".sidebar, .viewer-group",
  )) {
    const body = group.querySelector<HTMLElement>(
      ".sidebar-inner, .viewer-content",
    )
    const target = parseFloat(group.style.width)
    const width =
      target > 1 ? target : (body?.getBoundingClientRect().width ?? 0)
    any = freezeAt(body, width) || any
  }
  if (!any) return // nothing heavy mounted — nothing to guard
  document.body.classList.add("pane-animating")
  endTimer = setTimeout(endFreeze, FREEZE_MAX_MS)
}

function handleTransition(e: TransitionEvent) {
  // Only the containers' OWN size transitions count; the opacity fade and any
  // bubbled child transitions must not start (or end) a freeze.
  if (!SIZE_PROPERTIES.has(e.propertyName)) return
  if (!(e.target instanceof Element)) return
  if (!e.target.matches(ANIMATED_CONTAINERS)) return
  if (e.type === "transitionrun") beginFreeze()
  else endFreeze() // transitionend / transitioncancel — interrupted counts too
}

export function installPaneAnimationGuard(): void {
  if (installed || typeof document === "undefined") return
  installed = true
  document.addEventListener("transitionrun", handleTransition)
  document.addEventListener("transitionend", handleTransition)
  document.addEventListener("transitioncancel", handleTransition)
}
