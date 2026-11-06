import type { SearchPluginConfig, SearchPluginKind, Settings, ToolActivity } from '../../types'
// Extracted verbatim from store.ts (pure helpers, no store access).

// Bounds on persisted toolActivity so the chat JSON (and every heartbeat IPC
// payload) stays small even for tool calls with huge args/diffs/results.
export const MAX_TOOL_TEXT = 4000 // summary / diff
export const MAX_TOOL_ARG = 2000 // per string value inside args
export const MAX_PERSIST_IMAGE_CHARS = 100_000
export function trimPersistImageValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v.length > MAX_PERSIST_IMAGE_CHARS && v.slice(0, 80).includes('base64')) {
      return v.slice(0, MAX_PERSIST_IMAGE_CHARS) + '…'
    }
    return v
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['data', 'dataUrl', 'url', 'content'] as const) {
      const s = o[k]
      if (typeof s === 'string' && s.length > MAX_PERSIST_IMAGE_CHARS && (s.startsWith('data:') || s.slice(0, 80).includes('base64'))) {
        return { ...o, [k]: s.slice(0, MAX_PERSIST_IMAGE_CHARS) + '…' }
      }
    }
  }
  return v
}

/** Validate a base64 image data URL, returning a clean version or null.
 *  Drops truncated payloads (persisted snapshots cut with '…'), whitespace,
 *  and non-base64 chars; repairs missing padding. Never throws. */
export function sanitizeImageDataUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s.startsWith('data:')) return null
  if (s.includes('\u2026')) return null
  const comma = s.indexOf(',')
  if (comma < 0) return null
  const head = s.slice(0, comma)
  let payload = s.slice(comma + 1).replace(/\s+/g, '')
  if (!payload) return null
  if (!/;base64/i.test(head)) {
    return head.startsWith('data:image/') ? null : s
  }
  if (/[^A-Za-z0-9+/=]/.test(payload)) return null
  if (payload.length % 4 === 1) return null
  payload += '='.repeat((4 - (payload.length % 4)) % 4)
  try {
    atob(payload)
  } catch {
    return null
  }
  return `${head},${payload}`
}

export function trimToolActivity(acts: ToolActivity[]): ToolActivity[] {
  return acts.map((a) => {
    const out: ToolActivity = { ...a }
    if (typeof out.summary === 'string' && out.summary.length > MAX_TOOL_TEXT) {
      out.summary = out.summary.slice(0, MAX_TOOL_TEXT) + '…'
    }
    if (typeof out.diff === 'string' && out.diff.length > MAX_TOOL_TEXT) {
      out.diff = out.diff.slice(0, MAX_TOOL_TEXT) + '…'
    }
    if (out.args && typeof out.args === 'object') {
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(out.args)) {
        args[k] = typeof v === 'string' && v.length > MAX_TOOL_ARG ? v.slice(0, MAX_TOOL_ARG) + '…' : v
      }
      out.args = args
    }
    // NOTE: `items` (the full tool result) is intentionally NOT truncated here.
    // It is the actual context the model receives (rebuilt into ToolMessages on
    // the backend), so trimming it would silently shrink the context sent to the
    // provider. We keep `summary`/`diff`/`args` trimming for file-size sanity,
    // but the verbatim result must stay complete so "all messages up to the last
    // compact" are truly sent. This is the user's explicit "send full context".
    if (Array.isArray(out.children)) out.children = trimToolActivity(out.children)
    return out
  })
}

/** Display labels for the built-in modes (used in the mode-switch history note). */
export const MODE_LABELS: Record<string, string> = { ask: 'Ask', plan: 'Plan', build: 'Build' }

/** Canonical display label per web-search engine kind — the label saved in a
 *  plugin row is derived metadata, never user-edited, so stale/legacy labels
 *  are replaced on hydration. */
export const SEARCH_PLUGIN_LABELS: Record<SearchPluginKind, string> = {
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily',
}

/** Reduce an ordered plugin list to the first occurrence of each kind, keeping
 *  the original order, so a stray duplicate (left by a migration) can't show
 *  twice in Settings → Plugins or be tried twice by the backend. */
export function dedupeByKind(rows: SearchPluginConfig[]): SearchPluginConfig[] {
  const seen = new Set<SearchPluginKind>()
  const out: SearchPluginConfig[] = []
  for (const r of rows) {
    if (seen.has(r.kind)) continue
    seen.add(r.kind)
    out.push(r)
  }
  return out
}

/** Map legacy prompt keys from before the modes registry onto current ids. */
export function migrateModePrompts(prompts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...prompts }
  if ('chat' in out && !('ask' in out)) {
    out.ask = out.chat
    delete out.chat
  }
  if ('codewriter' in out && !('build' in out)) {
    out.build = out.codewriter
    delete out.codewriter
  }
  // Legacy "coder" key is dropped outright (not mapped to build).
  if ('coder' in out) {
    delete out.coder
  }
  return out
}

