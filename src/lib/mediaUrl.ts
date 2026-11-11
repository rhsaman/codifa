/**
 * `codifa-media://` resolution — the wire contract for generated media.
 *
 * The agent never writes a host or port: every tool result and reply carries
 * `codifa-media://media/<chat-slug>/<file>`, and the renderer rewrites it to
 * the local `/media/file` route using the LAST KNOWN sidecar URL. The path is
 * virtual and CHAT-SCOPED under the app's own data root (`~/.codifa/media/`),
 * so no workspace root or chat id rides on the wire — the backend resolves it
 * inside its own sandbox. Bare `media/...` paths the model may write by hand
 * resolve the same way. Pure helpers — the store stays out so the rewrite is
 * testable in isolation.
 */

const MEDIA_SCHEME_RE = /^codifa-media:\/\/(.+)$/i

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i

/** The path inside a `codifa-media://` URL, or null for any other string. */
export function codifaMediaPath(url: string | undefined | null): string | null {
  if (!url) return null
  const m = MEDIA_SCHEME_RE.exec(url.trim())
  return m ? m[1] : null
}

export function isMediaImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path)
}

export function isMediaVideoPath(path: string): boolean {
  return VIDEO_EXT_RE.test(path)
}

/** Build the `/media/file` URL for one virtual media path. `base` is the
 *  sidecar origin (nullable — no backend yet means nothing to fetch). `root`
 *  is the chat's workspace root, for the backend's workspace fallback: paths
 *  that miss the media sandbox (an absolute screenshot path, a workspace
 *  image) resolve there under the same containment the read tool uses. */
export function mediaFileUrl(relPath: string, base: string | null, root?: string | null): string {
  const b = (base ?? '').replace(/\/+$/, '')
  const ws = root?.trim() ? `&root=${encodeURIComponent(root.trim())}` : ''
  return `${b}/media/file?path=${encodeURIComponent(relPath)}${ws}`
}

/**
 * Resolve a markdown/tool-result source into a fetchable URL.
 *
 * Accepts the `codifa-media://` scheme and bare `media/...` workspace-style
 * paths; everything else (http(s), data:, blob:, file:, anchors, absolute
 * paths, plain text) returns null so the caller keeps the original src
 * untouched. `null` also comes back when the backend origin is not known yet
 * — the caller then retries once the sidecar resolves (see MarkdownImage) and
 * shows its fallback until then.
 */
export function resolveLocalMedia(
  src: string | undefined | null,
  base: string | null,
): { path: string; url: string; video: boolean } | null {
  if (!src) return null
  const trimmed = src.trim()
  let path = codifaMediaPath(trimmed)
  if (!path && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('#') && !trimmed.startsWith('/')) {
    // Scheme-less: only treat it as chat media when it NAMES a media file,
    // so a random relative link is never hijacked into a /media/file request.
    if (isMediaImagePath(trimmed) || isMediaVideoPath(trimmed)) path = trimmed
  }
  if (!path) return null
  if (!base) return null
  return {
    path,
    url: mediaFileUrl(path, base),
    video: isMediaVideoPath(path),
  }
}
