/**
 * Shared renderer-side types for the window.coder bridge API.
 *
 * This is the single source of truth for the bridge surface; both the Tauri
 * bridge (src/lib/tauriBridge.ts) and the web test harness stub conform to it.
 */

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

/** A live pty session (in-app terminal panel). */
export interface TerminalSessionInfo {
  id: string
  /** Shell binary basename (zsh, bash, …) shown in the terminal tab. */
  shell: string
  /** Command line the tab TOOLTIP shows (`zsh -l`, `nvim +42 /w/a.ts`).
   *  Optional so a stub/older bridge without it still type-checks. */
  program?: string
  /** Directory the shell was spawned in. */
  cwd: string
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string
  notes: string
  assetName: string | null
  assetUrl: string | null
  releaseUrl: string
}

export interface UpdateProgress {
  phase: 'downloading' | 'installing'
  percent: number
}

export interface OpResult {
  ok: boolean
  error?: string
}

export interface GoogleSignInResult {
  refreshToken: string
  accessToken: string
  expiresIn: number
}

export interface CoderApi {
  getSidecarUrl(): Promise<string | null>
  probeSidecar(): Promise<boolean>
  secretsGetKey(): Promise<string>
  getEnv(key: string): Promise<string | null>
  googleSignIn(
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<GoogleSignInResult>
  selectFolder(): Promise<string | null>
  selectFile(): Promise<string[] | null>
  importFile(absPath: string): Promise<string | null>
  fsList(root: string, rel: string): Promise<FileEntry[]>
  fsWalk(root: string): Promise<{ rel: string; name: string }[]>
  fsRead(root: string, rel: string): Promise<{ content: string } | null>
  fsWrite(root: string, rel: string, content: string): Promise<boolean>
  fsDelete(root: string, rel: string): Promise<boolean>
  /** Copy a file/folder to a new workspace-relative path. Rejects an existing
   *  destination (no silent overwrite). */
  fsCopy(root: string, from: string, to: string): Promise<boolean>
  /** Rename or move within the workspace (same primitive). */
  fsRename(root: string, from: string, to: string): Promise<boolean>
  coderList(rel: string): Promise<FileEntry[]>
  coderRead(rel: string): Promise<{ content: string }>
  coderWrite(rel: string, content: string): Promise<boolean>
  coderDelete(rel: string): Promise<boolean>
  copyText(text: string): Promise<boolean>
  searchContent(root: string, query: string): Promise<SearchMatch[]>
  readImage(absPath: string): Promise<string | null>
  /** Raw base64 of a PDF (no data-URL prefix), for the viewer's native PDF
   *  pane. Null when the file is missing or larger than the 64 MB cap. */
  readPdfBase64(absPath: string): Promise<string | null>
  normalizeImage(absPath: string): Promise<{ path: string; dataUrl: string } | null>
  captureScreen(): Promise<{ path: string; dataUrl: string } | null>
  /** Whether macOS grants this build Screen Recording and Accessibility. The
   *  Computer Use switch is useless without them, so the composer shows this.
   *  `identity` names the signing identity TCC keyed the grant to — an ad-hoc
   *  build gets a fresh one per compile, which is why the switch resets. */
  computerPermissions(): Promise<{
    screen: boolean
    accessibility: boolean
    identity: { id: string; name: string; path: string; adhoc: boolean } | null
  }>
  /** Raise macOS's own Screen Recording prompt; true when already granted. */
  requestScreenRecording(): Promise<boolean>
  getPathForFile(file: File): string
  storeGet<T>(key: string): Promise<T | null>
  storeSet(key: string, value: unknown): Promise<boolean>
  /** Fetch ONE chat's message body. The chat list in `settings.json` holds
   *  index rows, so a transcript is pulled in only when the user opens it. */
  chatGet<T>(id: string): Promise<T | null>
  getDataPath(): Promise<string>
  hasSettingsFile(): Promise<boolean>
  openExternal(url: string): Promise<void>
  openExternalChrome(url: string): Promise<void>
  openFileExternal(
    absPath: string,
    editor: 'nvim' | 'vscode' | 'cmux' | 'ghostty' | 'warp' | 'default',
  ): Promise<OpResult>
  openWorkspaceFolder(dir: string): Promise<OpResult>
  openWorkspaceTerminal(dir: string): Promise<OpResult>
  terminalCreate(
    cwd: string,
    program?: string | null,
    args?: string[] | null,
    shell?: string | null,
  ): Promise<TerminalSessionInfo>
  terminalList(): Promise<TerminalSessionInfo[]>
  terminalWrite(id: string, data: string): Promise<boolean>
  terminalResize(id: string, cols: number, rows: number): Promise<boolean>
  terminalKill(id: string): Promise<boolean>
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string, exitCode: number) => void): () => void
  moveDataPath(p: string): Promise<string>
  onSidecarChanged(cb: () => void): () => void
  onSidecarDead(cb: () => void): () => void
  onFlushPersist(cb: () => void): () => void
  flushPersistDone(): void
  onMigrateProgress(cb: (evt: { label: string; pct: number }) => void): () => void
  checkForUpdates(): Promise<UpdateInfo>
  startUpdate(): Promise<OpResult>
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void
}
