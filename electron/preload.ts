import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FileEntry {
  name: string
  kind: 'file' | 'dir' | 'link'
  path: string
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

const api = {
  getSidecarUrl: (): Promise<string | null> => ipcRenderer.invoke('sidecar:url'),
  secretsGetKey: (): Promise<string> => ipcRenderer.invoke('secrets:getKey'),
  getEnv: (key: string): Promise<string | null> => ipcRenderer.invoke('env:get', key),
  googleSignIn: (
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> =>
    ipcRenderer.invoke('oauth:google', clientId, clientSecret, scope),
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-folder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-file'),
  fsList: (root: string, rel: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:list', root, rel),
  fsWalk: (root: string): Promise<{ rel: string; name: string }[]> =>
    ipcRenderer.invoke('fs:walk', root),
  fsRead: (root: string, rel: string): Promise<{ content: string }> => ipcRenderer.invoke('fs:read', root, rel),
  fsWrite: (root: string, rel: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:write', root, rel, content),
  fsDelete: (root: string, rel: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:delete', root, rel),
  coderList: (rel: string): Promise<FileEntry[]> => ipcRenderer.invoke('coder:list', rel),
  coderRead: (rel: string): Promise<{ content: string }> => ipcRenderer.invoke('coder:read', rel),
  coderWrite: (rel: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('coder:write', rel, content),
  coderDelete: (rel: string): Promise<boolean> => ipcRenderer.invoke('coder:delete', rel),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  searchContent: (root: string, query: string): Promise<SearchMatch[]> =>
    ipcRenderer.invoke('fs:search', root, query),
  readImage: (absPath: string): Promise<string | null> => ipcRenderer.invoke('fs:read-image', absPath),
  normalizeImage: (absPath: string): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('image:normalize', absPath),
  captureScreen: (): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('screenshot:capture'),
  captureRegion: (): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('screenshot:capture-region'),
  selectRegion: (rect: RegionRect): void => ipcRenderer.send('overlay:selected', rect),
  cancelRegion: (): void => ipcRenderer.send('overlay:cancel'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  storeGet: <T>(key: string): Promise<T | null> => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown): Promise<boolean> => ipcRenderer.invoke('store:set', key, value),
  getDataPath: () => ipcRenderer.invoke('data:path'),
  hasSettingsFile: (): Promise<boolean> => ipcRenderer.invoke('data:has-settings'),
  moveDataPath: (p: string): Promise<string> => ipcRenderer.invoke('data:move', p),
  onSidecarChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('sidecar:changed', listener)
    return () => ipcRenderer.removeListener('sidecar:changed', listener)
  },
  onFlushPersist: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('flush-persist', listener)
    return () => ipcRenderer.removeListener('flush-persist', listener)
  },
  flushPersistDone: (): void => {
    ipcRenderer.send('flush-persist-done')
  },
  onMigrateProgress: (cb: (evt: { label: string; pct: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: { label: string; pct: number }): void => cb(data)
    ipcRenderer.on('migrate:progress', listener)
    return () => ipcRenderer.removeListener('migrate:progress', listener)
  },
  getNvimFile: (): Promise<{ abs: string | null; diagnostics: unknown[] }> => ipcRenderer.invoke('nvim:get'),
  onNvimFile: (
    cb: (f: { abs: string | null; diagnostics: unknown[] }) => void,
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      f: { abs: string | null; diagnostics: unknown[] },
    ): void => cb(f)
    ipcRenderer.on('nvim:file', listener)
    return () => ipcRenderer.removeListener('nvim:file', listener)
  },
}

contextBridge.exposeInMainWorld('coder', api)

export type CoderApi = typeof api
