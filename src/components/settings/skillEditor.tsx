
import { NEW_SKILL_KEY } from '../SettingsModal'

export function SkillFilesEditor({
  serverFiles,
  extraFiles,
  deletedFiles,
  activeFile,
  newFileName,
  onSelect,
  onContentChange,
  onNewFileNameChange,
  onAdd,
  onRemove,
}: {
  serverFiles: string[]
  extraFiles: Record<string, string>
  deletedFiles: string[]
  activeFile: string
  newFileName: string
  onSelect: (file: string) => void
  onContentChange: (file: string, content: string) => void
  onNewFileNameChange: (value: string) => void
  onAdd: () => void
  onRemove: (file: string) => void
}) {
  const deleted = new Set(deletedFiles)
  const visible = [...serverFiles.filter((f) => !deleted.has(f))]
  for (const f of Object.keys(extraFiles)) if (!visible.includes(f)) visible.push(f)
  visible.sort()
  const activeContent = activeFile ? extraFiles[activeFile] : null
  const loading = activeFile !== '' && activeContent === undefined && !deleted.has(activeFile)
  return (
    <div className="skill-files" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', clear: 'both' }}>
      <div className="field-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <label>Extra files</label>
      </div>
      {visible.length === 0 ? (
        <div className="hint">Single-file skill (only skill.md). Add a supporting file below, e.g. notes.md.</div>
      ) : (
        <div className="skill-file-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {visible.map((f) => (
            <div key={f} className={`skill-file-row ${f === activeFile ? 'active' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn tiny"
                onClick={() => onSelect(f)}
                title="View/edit file content"
                style={f === activeFile ? { borderColor: 'var(--accent)' } : undefined}
              >
                {f}
              </button>
              <button className="btn tiny danger" onClick={() => onRemove(f)} title="Remove file">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {activeFile && activeContent !== null && !deleted.has(activeFile) && (
        <div className="skill-file-editor" style={{ marginTop: 8 }}>
          <label className="field-label">{activeFile}</label>
          {loading ? (
            <div className="hint">Loading {activeFile}…</div>
          ) : (
            <textarea
              className="system-prompt skill-raw"
              value={activeContent ?? ''}
              onChange={(e) => onContentChange(activeFile, e.target.value)}
              rows={8}
              dir="ltr"
              spellCheck={false}
              placeholder="File content..."
              style={{ width: '100%' }}
            />
          )}
        </div>
      )}
      <div className="skill-file-add" style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <input
          value={newFileName}
          onChange={(e) => onNewFileNameChange(e.target.value)}
          placeholder="e.g. notes.md"
          dir="ltr"
          spellCheck={false}
          style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd() }}
        />
        <button className="btn tiny" onClick={onAdd} disabled={!newFileName.trim()}>
          + Add file
        </button>
      </div>
    </div>
  )
}

// ---- Skills & MCP helpers ------------------------------------------------ //

/** Parse `name` / `description` out of a SKILL.md frontmatter block. */
export function skillMeta(raw: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!m) return { name: '', description: '' }
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  return { name, description }
}

export const PLACEHOLDER_SKILL_NAMES = new Set(['new-skill', 'new_skill', 'skill', 'new skill', 'untitled'])

export function isPlaceholderSkillName(name: string): boolean {
  return PLACEHOLDER_SKILL_NAMES.has(name.trim().toLowerCase())
}

/** First `# Heading` after stripping frontmatter — e.g. `# Market-Analysis`. */
export function skillTitleFallback(raw: string): string {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const m = /^#\s+(.+)$/m.exec(body)
  return (m?.[1] ?? '').trim()
}

/** Prefer a real frontmatter name, else the `# Title`, else the existing key. */
export function resolveSkillName(content: string, key: string): string {
  const meta = skillMeta(content)
  const title = skillTitleFallback(content)
  const existing = key !== NEW_SKILL_KEY ? key : ''
  for (const candidate of [meta.name, title, existing]) {
    const v = (candidate ?? '').trim()
    if (v && !isPlaceholderSkillName(v)) return v
  }
  return 'new-skill'
}

/** Rewrite/insert frontmatter `name:` so stored file matches the resolved name. */
export function withSkillName(raw: string, newName: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!m) {
    return `---\nname: ${newName}\n---\n\n${raw.replace(/^\s+/, '')}`
  }
  const block = m[1]
  const rest = raw.slice(m[0].length)
  const nextBlock = /^name:\s*.+$/m.test(block)
    ? block.replace(/^name:\s*.+$/m, `name: ${newName}`)
    : `name: ${newName}\n${block}`
  return `---\n${nextBlock}\n---\n${rest}`
}

