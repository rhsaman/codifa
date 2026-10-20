import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FullscreenModal } from './FullscreenModal'
import { useFullscreen } from '../lib/fullscreen'
import { applyRtlToSvgText } from '../lib/bidi'
import { useVisible } from '../lib/useVisible'

/* eslint-disable react-refresh/only-export-components */


// Read the app's theme colors from CSS variables so the diagram matches the
// rest of the UI (and adapts automatically if a light theme is ever added).
// Mermaid's `base` theme is driven entirely by `themeVariables`.
function readThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const bg = v('--bg-panel', '#313244')
  const bgAlt = v('--bg-alt', '#181825')
  const text = v('--text', '#cdd6f4')
  const textDim = v('--text-dim', '#a6adc8')
  const border = v('--border', '#45475a')
  return {
    primaryColor: bg,
    primaryTextColor: text,
    primaryBorderColor: border,
    lineColor: textDim,
    secondaryColor: bgAlt,
    tertiaryColor: bgAlt,
    background: 'transparent',
    mainBkg: bg,
    nodeBorder: border,
    clusterBkg: bgAlt,
    clusterBorder: border,
    edgeLabelBackground: bg,
    textColor: text,
    titleColor: text,
    fontSize: '16px',
  }
}

/**
 * Renders a Mermaid diagram from `chart` source.
 *
 * While the assistant is still streaming, the source is incomplete and Mermaid
 * will fail to parse it — so we wait a beat (debounce) and, if it still fails,
 * fall back to showing the raw source in a code block instead of an error. Once
 * the block is complete it snaps into the rendered diagram.
 *
 * Clicking the diagram opens a full-screen read-only view. The full-screen copy
 * reuses the SVG we already rendered (we don't call `mermaid.render` a second
 * time inside the modal) so there's no double render / mermaid re-entrancy and
 * the enlarged diagram always matches the inline one.
 */

// The mermaid bundle (core + the diagram engine, hundreds of KB) is loaded on
// demand: it is imported dynamically the first time a diagram is actually about
// to be rendered, and initialized exactly once. A static import would put it in
// the startup chunk, where a chat that never shows a diagram still pays for it.
// Re-initializing on every render (with many diagrams on screen) races mermaid's
// global state and can make some renders reject — which would drop the diagram
// into the no-click fallback.
type MermaidApi = (typeof import('mermaid'))['default']
let mermaidApi: MermaidApi | null = null
let mermaidInit = false

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidApi) {
    const mod = await import('mermaid')
    mermaidApi = mod.default
  }
  if (!mermaidInit) {
    mermaidInit = true
    try {
      mermaidApi.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: readThemeVars(),
      })
    } catch {
      // best-effort; render below is what matters.
    }
  }
  return mermaidApi
}

/**
 * Strip invisible Unicode bidi/control characters injected by fixCodeBlock's
 * `injectLrmMarks` step.  Mermaid's parser treats these as unexpected tokens
 * and fails (e.g. "Expecting 'SOLID_ARROW', got 'NEWLINE'" or "Unrecognized
 * text").  The characters are pure rendering hints for the browser's bidi
 * algorithm inside code blocks — they carry no diagram semantics and are safe
 * to remove.
 */
const BIDI_CONTROL_RE = /[\u200B\u200E\u200F\u2066-\u2069\u061C]/g
function sanitizeChart(text: string): string {
  return text.replace(BIDI_CONTROL_RE, '')
}

/**
 * Belt-and-braces pass over the rendered SVG before it is injected.
 *
 * Mermaid already renders with `securityLevel: 'strict'` and
 * `applyRtlToSvgText` only adds `dir="auto"`, but the chart source comes from
 * the model, so the result is never trusted blindly. This walk removes exactly
 * what can execute — `<script>` nodes, `on*` handler attributes and
 * `javascript:` / inline-HTML URLs — and leaves every element, class and styling
 * attribute untouched, so the diagram renders identically. Browser-only: without
 * a DOMParser (SSR) the input is returned unchanged.
 */
function hardenSvg(svg: string | null): string | null {
  if (!svg || typeof DOMParser === 'undefined') return svg
  try {
    const doc = new DOMParser().parseFromString(svg, 'text/html')
    const root = doc.querySelector('svg')
    if (!root) return svg
    root.querySelectorAll('script').forEach((s) => s.remove())
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value.replace(/\s/g, '').toLowerCase()
        const isUrl = name === 'href' || name === 'xlink:href' || name === 'src'
        const dangerous =
          value.startsWith('javascript:') || value.startsWith('data:text/html')
        // `on*` handlers always go. Dangerous URL schemes go anywhere they
        // could be dereferenced — and also from `title` / `aria-label`
        // (mermaid emits the chart's `click` URL into a node `title`), where
        // they are inert but must never survive into the injected DOM.
        const isLabelish = name === 'title' || name.startsWith('aria-')
        if (name.startsWith('on') || (dangerous && (isUrl || isLabelish))) {
          el.removeAttribute(attr.name)
        }
      }
    })
    return root.outerHTML
  } catch {
    return svg
  }
}

export function Mermaid({ chart, embedded = false }: { chart: string; embedded?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Render generation + mount flag: an out-of-order (or post-unmount) mermaid
  // resolve used to paint the PREVIOUS chart into this block and leak its
  // temporary node, because nothing invalidated an in-flight render.
  const renderTokenRef = useRef(0)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      // Bump the token so an in-flight render can no longer commit.
      mountedRef.current = false
      renderTokenRef.current += 1
    }
  }, [])
  const myKey = useId()
  const activeKey = useFullscreen((s) => s.activeKey)
  const openFs = useFullscreen((s) => s.open)
  const closeFs = useFullscreen((s) => s.close)
  const expanded = activeKey === myKey

  const blockRef = useRef<HTMLDivElement | null>(null)
  // The chart source belt-and-suspenders check mirrors MermaidPlaceholder: a
  // block that still contains a fence marker is mid-stream (incomplete), so it is
  // not worth loading the engine for yet.
  const complete = Boolean(chart && !/[`~]{3}/.test(chart))
  const visible = useVisible(blockRef, complete)

  const renderDiagram = async () => {
    const token = ++renderTokenRef.current
    const commit = () => mountedRef.current && token === renderTokenRef.current
    setFailed(false)
    const id = `mmd-${Math.random().toString(36).slice(2)}`
    const cleanChart = sanitizeChart(chart)
    if (!cleanChart.trim()) return
    let mermaidMod: MermaidApi
    try {
      mermaidMod = await loadMermaid()
    } catch (err) {
      console.error('[Mermaid] engine failed to load:', err)
      if (commit()) setFailed(true)
      return
    }
    if (token !== renderTokenRef.current || !mountedRef.current) return
    // Render into a container we own and remove afterward. mermaid.render()
    // otherwise leaks a temporary node into <body> (the "duplicate diagram
    // appears at the bottom of the page" bug).
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.left = '-99999px'
    container.style.top = '0'
    document.body.appendChild(container)
    const cleanup = () => {
      container.remove()
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
    mermaidMod
      .render(id, cleanChart, container)
      .then((r) => {
        if (commit()) setSvg(applyRtlToSvgText(r.svg))
        return r
      })
      .catch((err) => {
        console.error('[Mermaid] render failed, retrying with dark theme:', err)
        // Do NOT call mermaid.initialize() here — it resets global state while a
        // render is still partially committed, which makes the retry fail too and
        // breaks every other diagram on the page.  Instead just re-render with
        // the same init (which already has themeVariables from readThemeVars());
        // if that fails it means the chart syntax itself is bad.
        return mermaidMod.render(`${id}-retry`, cleanChart, container)
      })
      .then((r) => {
        if (r && commit()) setSvg(applyRtlToSvgText(r.svg))
      })
      .catch((err) => {
        console.error('[Mermaid] retry also failed, showing fallback:', err)
        if (commit()) setFailed(true)
      })
      .finally(cleanup)
  }

  useEffect(() => {
    // Nothing to draw into the engine for an off-screen block: the 400 ms
    // debounce below would otherwise start a render for EVERY diagram in the
    // transcript as soon as it mounts.
    if (!visible) return
    const t = setTimeout(() => void renderDiagram(), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, visible])

  if (failed) {
    return (
      <>
        <pre
          className="mermaid-fallback"
          dir="auto"
          style={embedded ? undefined : { cursor: 'zoom-in' }}
          title={embedded ? undefined : 'Click to expand'}
          onClick={embedded ? undefined : () => openFs(myKey)}
        >
          {chart}
        </pre>
        {!embedded && (
          <FullscreenModal open={expanded} onClose={closeFs} title="Diagram">
            <div className="mermaid-fullscreen">
              <pre className="mermaid-fallback" dir="auto">
                {chart}
              </pre>
            </div>
          </FullscreenModal>
        )}
      </>
    )
  }

  // Mermaid output is hardened for the model-controlled chart source (no
  // `<script>`, `on*` handlers or `javascript:` URLs survive). Memoized so the
  // DOM walk runs once per rendered SVG instead of on every re-render.
  const safeSvg = useMemo(() => hardenSvg(svg), [svg])

  // Nothing is drawn yet (the engine chunk is still loading, the debounce has
  // not fired, or the block is off screen): keep the padded box so the
  // transcript height stays stable and the spinner explains the gap.
  if (!safeSvg) {
    return (
      <div className="mermaid-block mermaid-loading" ref={blockRef} data-visible={String(visible)} dir="auto">
        <span className="spinner" />
        <span>Diagram…</span>
      </div>
    )
  }

  const diagram = (
    <div
      className="mermaid-block"
      ref={blockRef}
      dir="auto"
      data-visible={String(visible)}
      style={embedded ? undefined : { cursor: 'zoom-in' }}
      title={embedded ? undefined : 'Click to expand'}
      onClick={embedded ? undefined : () => openFs(myKey)}
      dangerouslySetInnerHTML={{ __html: safeSvg }}
    />
  )

  if (embedded) return diagram

  return (
    <>
      {diagram}
      <FullscreenModal open={expanded} onClose={closeFs} title="Diagram">
        <div className="mermaid-fullscreen">
          {safeSvg ? (
            <div className="mermaid-block" dir="auto" dangerouslySetInnerHTML={{ __html: safeSvg }} />
          ) : (
            <Mermaid chart={chart} embedded />
          )}
        </div>
      </FullscreenModal>
    </>
  )
}
