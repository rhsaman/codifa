import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/fs'
import type { CodeMap, CodeSymbol } from '../types'
import './CodeMapPanel.css'

interface Props {
  /** کلیک روی یک نماد → فایل در خط مشخص‌شده باز می‌شود. فعلاً به‌صورت
   *  CustomEvent روی window پیاده‌سازی شده تا هر listener (مثل editor آینده)
   *  بتونه فایل رو در خط دلخواه باز کنه. */
  onJumpToFile: (path: string, line: number) => void
}

interface State {
  data: CodeMap | null
  loading: boolean
  error: string | null
}

/** یک‌بار فچ کردن code map از بک‌اند. اگه sidecar در دسترس نبود (cold start)
 *  خودش صبر می‌کنه تا بالا بیاد (از الگوی `ensureSidecar` در `lib/api.ts`). */
async function fetchCodeMap(root: string, signal: AbortSignal): Promise<CodeMap> {
  const url = await api.getSidecarUrl()
  if (!url) throw new Error('sidecar not available')
  const res = await fetch(
    `${url}/code-map?root=${encodeURIComponent(root)}`,
    { signal },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<CodeMap>
}

/** فیلتر ساده: نام نماد یا مسیر فایل شامل query باشد (case-insensitive).
 *  اگه query خالی باشه، کل map برمی‌گرده.
 *
 *  قاعده: اگه فایل به خودیِ خود match داشته باشه (نه فقط نمادهایش)،
 *  همه‌ی نمادهای فایل رو برمی‌گردونیم — در غیر این صورت فایل با
 *  لیست خالی می‌مونه که در UI به شکل `<ul></ul>` خالی رندر می‌شه. */
export function filterCodeMap(map: CodeMap | null, query: string): CodeMap {
  if (!map) return {}
  const q = query.trim().toLowerCase()
  if (!q) return map
  const out: CodeMap = {}
  for (const [file, syms] of Object.entries(map)) {
    const fileMatches = file.toLowerCase().includes(q)
    const matchingSyms = syms.filter((s) => s.name.toLowerCase().includes(q))
    if (fileMatches) {
      // فایل match داره → کل نمادها رو نشون بده (حتی اگه نمادی match نکنه)
      out[file] = syms
    } else if (matchingSyms.length) {
      // فقط نمادها match دارن → فقط اون‌ها
      out[file] = matchingSyms
    }
  }
  return out
}

function symbolKey(s: CodeSymbol): string {
  // هر فایل ممکنه چند نماد همنام داشته باشه (مثل overloads) → line+name
  return `${s.line}:${s.name}`
}

export function CodeMapPanel({ onJumpToFile }: Props) {
  const root = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const [state, setState] = useState<State>({ data: null, loading: false, error: null })
  const [filter, setFilter] = useState('')
  // شناسه‌ی فچ فعلی — اگه کاربر workspace رو سریع عوض کنه، فقط آخرین نتیجه
  // setState می‌شه و درخواست‌های قدیمی silently ignore می‌شن.
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!root) {
      setState({ data: null, loading: false, error: null })
      return
    }
    const myId = ++reqIdRef.current
    const ctrl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    fetchCodeMap(root, ctrl.signal)
      .then((data) => {
        if (myId !== reqIdRef.current) return // نتیجه‌ی تاریخ‌گذشته
        setState({ data, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (myId !== reqIdRef.current) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return () => ctrl.abort()
  }, [root])

  const filtered = useMemo(() => filterCodeMap(state.data, filter), [state.data, filter])
  // فایل‌ها به ترتیب الفبایی (نه بر اساس محتوای چت) تا navigation قابل پیش‌بینی باشه
  const files = useMemo(
    () => Object.keys(filtered).sort((a, b) => a.localeCompare(b)),
    [filtered],
  )
  const totalSyms = useMemo(
    () => files.reduce((n, f) => n + (filtered[f]?.length ?? 0), 0),
    [files, filtered],
  )

  return (
    <aside
      className="codemap-panel"
      role="complementary"
      aria-label="Code map"
      dir="ltr"
    >
      <header className="codemap-header">
        <input
          className="codemap-search"
          type="search"
          placeholder="جستجو…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter symbols"
          autoFocus
        />
        <div className="codemap-meta" aria-live="polite">
          {state.loading
            ? 'در حال بارگذاری…'
            : state.error
              ? `خطا: ${state.error}`
              : root
                ? `${files.length} فایل · ${totalSyms} نماد`
                : 'هیچ workspace باز نیست'}
        </div>
      </header>
      <div className="codemap-tree">
        {!state.loading && !state.error && files.length === 0 && (
          <div className="codemap-empty">
            {root ? 'نمادی پیدا نشد' : 'یک workspace باز کنید تا code map نمایش داده شود.'}
          </div>
        )}
        {files.map((file) => {
          const syms = filtered[file] ?? []
          return (
            <details key={file} open className="codemap-file">
              <summary title={file}>
                <span className="codemap-file-icon" aria-hidden>📄</span>
                <span className="codemap-file-name">{file}</span>
                <span className="codemap-file-count">{syms.length}</span>
              </summary>
              {syms.length > 0 && (
                <ul className="codemap-symbols">
                  {syms.map((s) => (
                    <li key={symbolKey(s)}>
                      <button
                        type="button"
                        className={`codemap-symbol kind-${s.kind}`}
                        onClick={() => onJumpToFile(file, s.line)}
                        title={`${s.kind} · خط ${s.line}`}
                      >
                        <span className="codemap-kind">{s.kind}</span>
                        <span className="codemap-name">{s.name}</span>
                        <span className="codemap-line">L{s.line}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )
        })}
      </div>
    </aside>
  )
}
