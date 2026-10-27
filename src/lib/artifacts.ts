import { ensureSidecar } from './api'

/** One saved artifact document, as `GET /artifacts/get` returns it. */
export interface ArtifactDocument {
  id: string
  title: string
  kind?: string
  version?: number
  content: string
}

/** Read the latest saved body of an artifact.
 *
 *  The transcript card carries the content too, but viewer tabs are restored
 *  from localStorage with the body stripped (it is memory-only), so a tab that
 *  outlived a restart re-reads the document from disk here instead of showing
 *  an empty frame in a sandbox with no way to ask again.
 */
export async function getArtifact(
  chatId: string,
  id: string,
): Promise<ArtifactDocument | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString()
    const res = await fetch(`${url}/artifacts/get?${qs}`)
    const data = (await res.json().catch(() => ({}))) as ArtifactDocument & { detail?: string }
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` }
    if (!data.content) return { error: `artifact not found: ${id}` }
    return data
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read the supporting files (backend source, data, config) of one artifact.
 *
 *  They live beside the document rather than in the transcript, so the preview
 *  panel asks for them itself; an artifact with none is simply empty. */
export async function getArtifactAssets(
  chatId: string,
  id: string,
): Promise<{ files: Array<{ path: string; content: string }> } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString()
    const res = await fetch(`${url}/artifacts/assets?${qs}`)
    const data = (await res.json().catch(() => ({}))) as {
      files?: Array<{ path: string; content: string }>
      detail?: string
    }
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` }
    return { files: data.files ?? [] }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Delete one artifact: every saved version goes with it.
 *
 *  A missing artifact reports the backend's own error instead of looking like
 *  a success — the row the user clicked named a folder that was gone.
 */
export async function deleteArtifact(
  chatId: string,
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString()
    const res = await fetch(`${url}/artifacts?${qs}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string }
      return { error: data.detail || `delete failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** One row on the Artifacts page, as `GET /artifacts/list` returns it. Index
 *  data only: the body is fetched when a row is opened. */
export interface ArtifactSummary {
  id: string
  title: string
  /** Absolute folder of this artifact, when the list carries it — what an
   *  update session pins the composer badge to. */
  dir?: string
  kind?: string
  version?: number
  updatedAt: number
  /** Owner chat, so a row can jump back to the conversation it belongs to. */
  chatId: string
}

/** Every saved artifact, newest first (one chat's when `chatId` is given).
 *
 *  Reads only the saved indexes: a page listing dozens of generated documents
 *  must not load every body just to draw its rows. */
export async function listArtifacts(
  chatId?: string,
): Promise<ArtifactSummary[] | { error: string }> {
  const url = await ensureSidecar()
  if (!url) return { error: 'the local backend is not ready' }
  try {
    // The route spells the query `chat_id` (snake_case on the wire).
    const qs = chatId ? `?${new URLSearchParams({ chat_id: chatId }).toString()}` : ''
    const res = await fetch(`${url}/artifacts/list${qs}`)
    const data = (await res.json().catch(() => ({}))) as {
      artifacts?: Array<{
        id: string
        title: string
        kind?: string
        version?: number
        updated_at?: number
        chat_id?: string
        dir?: string
      }>
      detail?: string
    }
    if (!res.ok) return { error: data.detail || `list failed (${res.status})` }
    return (data.artifacts ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      version: a.version,
      updatedAt: a.updated_at ?? 0,
      chatId: a.chat_id ?? '',
      // Absolute folder — what a `/artifact update <id>` session pins the
      // composer badge to (dropped here once, the pick then silently no-oped).
      dir: a.dir,
    }))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
