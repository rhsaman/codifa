/**
 * Tauri bridge: exposes the exact same `window.coder` surface the Electron
 * preload used, backed by Tauri commands + events. The rest of src/ keeps
 * calling window.coder unchanged.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  CoderApi,
  FileEntry,
  OpResult,
  RegionRect,
  SearchMatch,
  TerminalSessionInfo,
  UpdateInfo,
  UpdateProgress,
} from '../types/coderApi'

/** Tauri commands reject non-identical arg names; snake_case args are passed
 *  explicitly in each invoke below. */

function eventSubscribe<T>(
  event: string,
  cb: (payload: T) => void,
): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  listen<T>(event, (e: { payload: T }) => cb(e.payload))
    .then((off: () => void) => {
      if (disposed) off()
      else unlisten = off
    })
    .catch(() => {
      /* web mode: no Tauri runtime */
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}

const bridge: CoderApi = {
  getSidecarUrl: () => invoke<string | null>('sidecar_url'),
  probeSidecar: () => invoke<boolean>('sidecar_probe'),
  secretsGetKey: () => invoke<string>('secrets_get_key'),
  getEnv: (key) => invoke<string | null>('get_env', { key }),
  googleSignIn: (clientId, clientSecret, scope) =>
    invoke('google_sign_in', {
      clientId,
      clientSecret,
      scope: scope ?? null,
    }),
  selectFolder: () => invoke<string | null>('select_folder'),
  selectFile: () => invoke<string[] | null>('select_file'),
  importFile: (absPath) => invoke<string | null>('import_file', { absPath }),
  fsList: (root, rel) => invoke<FileEntry[]>('fs_list', { root, rel }),
  fsWalk: (root) =>
    invoke<{ path: string; name: string }[]>('fs_walk', { root }).then((entries) =>
      entries.map((e) => ({ rel: e.path, name: e.name })),
    ),
  fsRead: (root, rel) => invoke<{ content: string } | null>('fs_read', { root, rel }),
  fsWrite: (root, rel, content) => invoke<boolean>('fs_write', { root, rel, content }),
  fsDelete: (root, rel) => invoke<boolean>('fs_delete', { root, rel }),
  coderList: (rel) => invoke<FileEntry[]>('coder_list', { rel }),
  coderRead: (rel) => invoke<{ content: string }>('coder_read', { rel }),
  coderWrite: (rel, content) => invoke<boolean>('coder_write', { rel, content }),
  coderDelete: (rel) => invoke<boolean>('coder_delete', { rel }),
  copyText: (text) => invoke<boolean>('copy_text', { text }),
  searchContent: (root, query) => invoke<SearchMatch[]>('search_content', { root, query }),
  readImage: (absPath) => invoke<string | null>('read_image', { absPath }),
  readPdfBase64: (absPath) => invoke<string | null>('read_pdf_base64', { absPath }),
  normalizeImage: (absPath) => invoke('normalize_image', { absPath }),
  captureScreen: () => invoke('capture_screen'),
  captureRegion: () => invoke('capture_region'),
  selectRegion: (rect: RegionRect) => {
    void invoke('overlay_selected', { rect })
  },
  cancelRegion: () => {
    void invoke('overlay_cancel')
  },
  // Tauri's drag-drop event carries absolute paths; the bridge records the
  // latest dropped path per File name so getPathForFile stays sync (parity
  // with Electron's webUtils.getPathForFile).
  getPathForFile: (file: File) => droppedPaths.get(file.name) ?? '',
  storeGet: <T>(key: string) => invoke<T | null>('store_get', { key }),
  storeSet: (key, value) => invoke<boolean>('store_set', { key, value }),
  chatGet: <T>(id: string) => invoke<T | null>('chat_get', { id }),
  getDataPath: () => invoke<string>('get_data_path'),
  hasSettingsFile: () => invoke<boolean>('has_settings_file'),
  openExternal: (url) => invoke<void>('open_external', { url }),
  openExternalChrome: (url) => invoke<void>('open_external_chrome', { url }),
  openFileExternal: (absPath, editor) =>
    invoke<OpResult>('open_file_external', { absPath, editor }),
  openWorkspaceFolder: (dir) => invoke<OpResult>('open_workspace_folder', { dir }),
  openWorkspaceTerminal: (dir) => invoke<OpResult>('open_workspace_terminal', { dir }),
  terminalCreate: (cwd) => invoke<TerminalSessionInfo>('terminal_create', { cwd }),
  terminalList: () => invoke<TerminalSessionInfo[]>('terminal_list'),
  terminalWrite: (id, data) => invoke<boolean>('terminal_write', { id, data }),
  terminalResize: (id, cols, rows) => invoke<boolean>('terminal_resize', { id, cols, rows }),
  terminalKill: (id) => invoke<boolean>('terminal_kill', { id }),
  onTerminalData: (cb) =>
    eventSubscribe<[string, string]>('terminal:data', ([id, data]) => cb(id, data)),
  onTerminalExit: (cb) =>
    eventSubscribe<[string, number]>('terminal:exit', ([id, code]) => cb(id, code)),
  moveDataPath: (p) => invoke<string>('move_data_path', { p }),
  onSidecarChanged: (cb) => eventSubscribe<null>('sidecar:changed', () => cb()),
  onSidecarDead: (cb) => eventSubscribe<null>('sidecar:dead', () => cb()),
  onFlushPersist: (cb) => eventSubscribe<null>('flush-persist', () => cb()),
  flushPersistDone: () => {
    void invoke('flush_persist_done')
  },
  onMigrateProgress: (cb) =>
    eventSubscribe<{ label: string; pct: number }>('migrate:progress', (evt) => cb(evt)),
  checkForUpdates: () => invoke<UpdateInfo>('check_for_updates'),
  startUpdate: () => invoke<OpResult>('start_update'),
  onUpdateProgress: (cb) =>
    eventSubscribe<UpdateProgress>('updater:progress', (p) => cb(p)),
}

/** Latest absolute path seen per dropped file name (see getPathForFile). */
const droppedPaths = new Map<string, string>()

/** Record absolute paths from Tauri drag-drop events (called from main.tsx). */
export function recordDroppedPaths(files: { name: string; path: string }[]): void {
  for (const { name, path } of files) droppedPaths.set(name, path)
}

/** Install the Tauri-backed window.coder bridge (no-op in web mode). */
export function installTauriBridge(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; coder?: unknown }
  if (!w.__TAURI_INTERNALS__ || w.coder) return false
  w.coder = bridge
  installDragShim()
  return true
}

/**
 * Translate the Electron-era CSS drag regions into Tauri window dragging.
 *
 * WKWebView only half-understands `-webkit-app-region`: it shows the no-drop
 * cursor and makes those elements non-interactive, but never starts a native
 * window drag from CSS. So we (1) neutralize the property globally — clicks
 * and cursors behave normally again — and (2) start the native drag from
 * mousedown when the hit lands in one of the known drag strips.
 */
const DRAG_REGION_SELECTOR =
  '.sidebar-drag, .titlebar-drag-spacer, .chat-tabs-row, .tab-bar.viewer-tabs, .viewer-pane-head'
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, [role="button"], [data-no-drag], [draggable="true"]'

function installDragShim(): void {
  const style = document.createElement('style')
  style.textContent = '* { -webkit-app-region: no-drag !important; }'
  document.head.appendChild(style)
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      // Interactive elements inside a drag strip keep their clicks.
      if (target?.closest(INTERACTIVE_SELECTOR)) return
      if (!target?.closest(DRAG_REGION_SELECTOR)) return
      e.preventDefault()
      void getCurrentWindow().startDragging()
    },
    true,
  )
  // WKWebView starts HTML5 drag sessions but never fires dragover/drop for
  // internal drags (WebKit bug 265857), so the native session is cancelled
  // at dragstart and replayed with mouse events carrying a shimmed
  // DataTransfer; existing React handlers work unchanged.
  installDndPolyfill()
}

/** Minimal DataTransfer stand-in: internal-drag handlers only use
 *  setData/getData/types/effectAllowed/dropEffect (never real OS files). */
function createShimDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types(): string[] {
      return [...data.keys()]
    },
    effectAllowed: "move",
    dropEffect: "move",
    files: [],
    items: [],
  } as unknown as DataTransfer
}

/** Mouse-based replay of HTML5 drag-and-drop for WKWebView, where native
 *  dragover/drop never fire for internal drags (WebKit bug 265857). The
 *  native session is cancelled at dragstart (bubble-phase React onDragStart
 *  handlers still run), then mouse movement synthesizes dragstart/dragover/
 *  drop/dragend with a shimmed DataTransfer so tabs reorder, sidebar chats
 *  drag into split windows, and viewer tabs rearrange as before. */
function installDndPolyfill(): void {
  let source: HTMLElement | null = null
  let active = false
  let startX = 0
  let startY = 0
  let dt: DataTransfer | null = null

  const dragEvent = (type: string, e: MouseEvent): DragEvent => {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: e.clientX,
      clientY: e.clientY,
      button: 0,
    }) as DragEvent
    Object.defineProperty(ev, "dataTransfer", { value: dt })
    return ev
  }

  // Native dragover fires periodically even for a stationary pointer; the
  // replay must do the same, or a layout shift under a still cursor (vacated
  // source pane, mounted ghost) leaves a stale preview at the wrong spot.
  let lastMove: MouseEvent | null = null
  let rafId = 0
  const stopReplay = () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    lastMove = null
    lastOver = null
  }
  // Native DnD fires dragleave on the previous target when the pointer enters
  // a new one. The replay must do the same, or a stale preview lingers on the
  // old pane (e.g. cursor back over the source or a neighbor's center).
  let lastOver: Element | null = null
  const fireOver = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (el !== lastOver) {
      if (lastOver) {
        const lv = dragEvent("dragleave", e)
        Object.defineProperty(lv, "relatedTarget", { value: el })
        lastOver.dispatchEvent(lv)
      }
      lastOver = el
    }
    el?.dispatchEvent(dragEvent("dragover", e))
  }
  const replayOver = () => {
    rafId = 0
    if (!active || !lastMove) return
    fireOver(lastMove)
    rafId = requestAnimationFrame(replayOver)
  }

  // Inline body styles lose to per-element user-select rules (message text),
  // so toggle a global class backed by an !important stylesheet instead.
  const style = document.createElement("style")
  style.textContent =
    "body.coder-dragging, body.coder-dragging * { user-select: none !important; -webkit-user-select: none !important; }"
  document.head.appendChild(style)

  const cancel = () => {
    const src = source
    const wasActive = active
    const over = lastOver
    stopReplay()
    source = null
    active = false
    document.body.classList.remove("coder-dragging")
    // Clear any preview the cancelled drag left behind.
    if (wasActive && over) over.dispatchEvent(dragEvent("dragleave", new MouseEvent("dragleave")))
    if (wasActive && src) src.dispatchEvent(dragEvent("dragend", new MouseEvent("dragend")))
    dt = null
  }

  // Kill the native session (its dragover/drop never fire in WKWebView);
  // propagation is untouched so React onDragStart still sets drag state.
  document.addEventListener(
    "dragstart",
    (e) => {
      if ((e.target as HTMLElement | null)?.closest('[draggable="true"]')) e.preventDefault()
    },
    true,
  )

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[draggable="true"]')
      if (!el) return
      source = el
      active = false
      // Block text selection from the very first pixel (the highlight flash
      // happened between mousedown and the 4px drag threshold).
      document.body.classList.add("coder-dragging")
      startX = e.clientX
      startY = e.clientY
      dt = createShimDataTransfer()
    },
    true,
  )

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!source) return
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 3) return
        active = true
        source.dispatchEvent(dragEvent("dragstart", e))
        lastMove = e
        if (!rafId) rafId = requestAnimationFrame(replayOver)
      }
      e.preventDefault()
      lastMove = e
      fireOver(e)
    },
    true,
  )

  document.addEventListener(
    "mouseup",
    (e) => {
      const src = source
      const wasActive = active
      stopReplay()
      source = null
      active = false
      // Drop must land with no dragging class set: the post-drop relayout is
      // instant (Electron parity) — animating flex-grow read as a delayed move.
      document.body.classList.remove("coder-dragging")
      if (!wasActive || !src || !dt) {
        dt = null
        return
      }
      const el = document.elementFromPoint(e.clientX, e.clientY)
      el?.dispatchEvent(dragEvent("drop", e))
      src.dispatchEvent(dragEvent("dragend", e))
      dt = null
    },
    true,
  )

  // Escape or leaving the window cancels the replayed drag.
  document.addEventListener(
    "keydown",
    (e) => {
      if (active && e.key === "Escape") cancel()
    },
    true,
  )
  document.documentElement.addEventListener("mouseleave", () => {
    if (active) cancel()
  })
  window.addEventListener("blur", () => {
    if (active) cancel()
  })
}
