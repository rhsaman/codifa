import { ensureSidecar, peekSidecarUrl } from '../../lib/api'
import { fileBasename } from '../../lib/fileTypes'
import { handleLinkClick } from '../../lib/link'
import { codifaMediaPath, resolveLocalMedia } from '../../lib/mediaUrl'
import { isSkillTool, terminalOutputText } from '../../lib/toolActivity'
import { useViewerTabs } from '../../lib/viewerTabs'
import type { SearchResultItem, ToolActivity } from '../../types'
import { FileChip } from '../FileIcon'
import { memo, useEffect, useState } from 'react'

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Human label for a web-search engine kind (`duckduckgo` → DuckDuckGo). The
 *  backend reports the kind that actually answered the query — a fallback may
 *  have served it, so the settings primary is not necessarily the right one. */
export function webProviderLabel(kind: string): string {
  switch (kind) {
    case "duckduckgo":
      return "DuckDuckGo";
    case "tavily":
      return "Tavily";
    default:
      return kind;
  }
}

/** Tools whose rows are web hits/fetched pages rather than files. */
export function isWebRow(activity: ToolActivity): boolean {
  return activity.tool === "web_search" || activity.tool === "fetch_url";
}

/** Web rows start collapsed like every other row; the hits still render inside
 *  the expanded body, one click away (see `isWebRow`, which keeps driving the
 *  in-row renderer). */

/** The hits of a `web_search` / `fetch_url` row. Rendered at the bottom of the
 *  row's OWN expanded body — never as a sibling block hanging outside the tool
 *  call — so folding the call tucks the list back inside it. */
export const InlineWebResults = memo(function InlineWebResults({
  activity,
}: {
  activity: ToolActivity;
}) {
  const rows = activity.items ?? activity.results;
  if (!isWebRow(activity) || !rows || rows.length === 0) return null;
  return (
    <div className="trace-row-inline-results">
      <WebResultLinks items={rows} />
    </div>
  );
});

/** How many web hits the collapsed list shows before "+N more". */
export const WEB_RESULTS_VISIBLE = 3;

/** Shared, beautifully-styled list of web_search result links. Rendered in
 *  EVERY tool view (full card, single row, timeline row) so the links the
 *  model found are always visible — not just in the expanded card. Pure
 *  presentational component (no store/fullscreen hooks) so it can be
 *  unit-tested in isolation.
 *
 *  Collapsed to `WEB_RESULTS_VISIBLE` rows: a 5-10 hit search used to render a
 *  wall of full-height cards that pushed every following tool row off screen.
 *  The hidden rows open IN PLACE — these are links the user clicks, so the
 *  FileResultLinks pattern (dump the rest into the side panel) would make them
 *  unusable.
 *
 *  Each row may carry `fetched` from the backend: `true` = real page content
 *  reached the model, `false` = the fetch failed and only the snippet did. That
 *  flag and the "N results · M fetched" line are the only way to tell a thin
 *  answer caused by a broken fetch from one caused by bad results. */
export const WebResultLinks = memo(function WebResultLinks({
  items,
}: {
  items: SearchResultItem[];
}) {
  // Hooks run before the empty-list bail-out (rules of hooks).
  const [showAll, setShowAll] = useState(false);
  if (!items || items.length === 0) return null;
  // Only rows that actually carry the flag count — an old transcript shows no
  // badge and no count line at all.
  const fetchInfo = items.filter((it) => typeof it.fetched === "boolean");
  const fetchedCount = fetchInfo.filter((it) => it.fetched).length;
  const visible = showAll ? items : items.slice(0, WEB_RESULTS_VISIBLE);
  const hidden = items.length - visible.length;
  return (
    <>
      {fetchInfo.length > 0 && (
        <div className="web-results-head" dir="auto">
          <span className="web-results-count">
            {`${items.length} result${items.length === 1 ? "" : "s"}`}
          </span>
          <span className="web-results-sep" aria-hidden="true">
            ·
          </span>
          <span
            className={`web-results-fetched${fetchedCount === 0 ? " none" : ""}`}
            title="Results whose real page content was fetched. The rest reached the model as a short snippet only."
          >
            {`${fetchedCount} fetched`}
          </span>
        </div>
      )}
      <ul className="web-results" dir="auto">
        {visible.map((it, i) => {
        const host = hostOf(it.url);
        return (
          <li key={i} className="web-result">
            <a
              className="web-result-link"
              href={it.url}
              target="_blank"
              rel="noreferrer"
              title={it.url}
              onClick={(e) => {
                // Open external links in the OS browser, not inside the app's
                // own BrowserWindow. window.coder.openExternal → shell.openExternal.
                handleLinkClick(
                  e,
                  it.url,
                  (url) => void window.coder.openExternal(url),
                );
              }}
            >
              <span className="web-result-favicon" aria-hidden="true">
                {host ? (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
                    alt=""
                    loading="lazy"
                    width={16}
                    height={16}
                  />
                ) : (
                  <span className="web-result-glyph">🔗</span>
                )}
              </span>
              <span className="web-result-text">
                <span className="web-result-title">{it.title || it.url}</span>
                {it.snippet && (
                  <span className="web-result-snippet">{it.snippet}</span>
                )}
              </span>
              {/* Flag only the EXCEPTION (snippet-only) rows: a chip on every
                  successfully fetched row would just be noise on a 10-row list,
                  while a missing page is the thing worth noticing. */}
              {it.fetched === false && (
                <span
                  className="web-result-fetched"
                  title="This page could not be fetched — only the short search snippet reached the model."
                >
                  snippet
                </span>
              )}
              <span className="web-result-host">{host}</span>
              <span className="web-result-arrow" aria-hidden="true">
                ↗
              </span>
            </a>
          </li>
        );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="web-result-more-btn"
          onClick={() => setShowAll(true)}
          title="Show every result"
        >
          {`+${hidden} more`}
        </button>
      )}
      {showAll && items.length > WEB_RESULTS_VISIBLE && (
        <button
          type="button"
          className="web-result-more-btn"
          onClick={() => setShowAll(false)}
        >
          Show less
        </button>
      )}
    </>
  );
});

/** متن خروجی ترمینال (`run_terminal`): آیتم‌ها فقط فیلد `content` دارند
 *  (بدون `file`/`path`/`url`) پس `FileResultLinks` خالی رندر می‌شود.
 *  خروجی بلند با `trace-expand-pre` اسکرول عمودی می‌خورد. */
export const TerminalResultText = function TerminalResultText({
  items,
  fallbackText,
}: {
  items: unknown;
  /** Plain `event.result` string when the sidecar sent no result rows. */
  fallbackText?: string;
}) {
  const text = terminalOutputText(items) || fallbackText || "";
  if (!text) return null;
  // Long output scrolls inside this block (.trace-terminal-output max-height);
  // it never hops to the side panel (user request).
  return (
    <pre
      className="trace-expand-val trace-expand-pre trace-terminal-output"
      dir="ltr"
    >
      {text}
    </pre>
  );
};

/** نمایش نتایج grep/glob به‌صورت لیست مسیر فایل (با شمارهٔ خط) — نه لینک وب.
 *  آیتم‌های این ابزارها فیلد `url` ندارند، پس نباید از WebResultLinks (مخصوص
 *  web_search/fetch_url) استفاده شوند؛ وگرنه به‌جای مسیر فایل فقط آیکون 🔗
 *  نمایش داده می‌شد. */
/** File rows a card may render. A `load_skill` card NEVER lists files: its
 *  result is the skill's markdown body (a filename scan once turned every path
 *  it mentions into a chip), and transcripts saved before that fix still carry
 *  those bogus rows — the body is the real payload, so drop them here as well
 *  as at ingest. */
export function resultRows(activity: ToolActivity): Array<Record<string, unknown>> {
  if (isSkillTool(activity.tool)) return [];
  const rows = activity.items ?? activity.results;
  return Array.isArray(rows)
    ? (rows as unknown as Array<Record<string, unknown>>)
    : [];
}

/** The media-generation tools whose `results` rows carry generated files
 *  ({path, url: codifa-media://…, bytes, mime}) instead of web/file rows. */
export const MEDIA_TOOLS: ReadonlySet<string> = new Set([
  "generate_image",
  "edit_image",
  "generate_video",
  "edit_video",
]);

/** Inline preview strip for a media tool's result: real thumbnails for images
 *  and playable <video> elements for clips, straight off the /media/file
 *  route. Clicking opens the file in the Media viewer tab. */
export const MediaResultLinks = memo(function MediaResultLinks({
  items,
}: {
  items: Array<Record<string, unknown>>;
}) {
  // The sidecar URL resolves asynchronously (unknown right after a restart,
  // when replayed transcripts render first): resolve NOW and re-render when
  // it lands, so a fresh card never shows permanently broken thumbnails.
  const [, forceTick] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!peekSidecarUrl()) {
      void ensureSidecar().then((url) => {
        if (url && alive) forceTick((t) => t + 1);
      });
    }
    return () => {
      alive = false;
    };
  }, []);

  const rows: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    // Rows arrive in two shapes (structured {path,url} from the backend and
    // text-scanned {file} from the transcript replay) — the SAME file can
    // appear through both, so dedupe on the path itself or the card shows the
    // generated file twice.
    const raw = String(it.path ?? it.file ?? codifaMediaPath(String(it.url ?? "")) ?? "").trim();
    // Only real media files render here — error text can scan into a row
    // (model ids like "ag/gemini-3.1" look path-like), and a broken-image
    // tile for a model name is worse than no tile.
    if (!/\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v)$/i.test(raw)) continue;
    // Scan rows and structured rows can spell the same file with/without a
    // leading slash — normalize before deduping or the card shows it twice.
    const path = raw.replace(/^\/+/, "");
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push(path);
  }
  if (rows.length === 0) return null;
  const base = peekSidecarUrl();
  return (
    <div className="media-results">
      {rows.map((path, i) => {
        const resolved = resolveLocalMedia(`codifa-media://${path}`, base);
        if (!resolved) return null;
        return resolved.video ? (
          <video
            key={path}
            className="media-result-video"
            src={resolved.url}
            controls
            preload="metadata"
            onClick={() => useViewerTabs.getState().openMedia(path)}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- generated media thumbnail
          <img
            key={path}
            className="media-result-thumb"
            src={resolved.url}
            alt={path}
            title={`${path} — click to open in the Media editor`}
            loading="lazy"
            onClick={() => useViewerTabs.getState().openMedia(path)}
          />
        );
      })}
    </div>
  );
});

export const FileResultLinks = memo(function FileResultLinks({  tool,
  items,
}: {
  tool: string;
  items: Array<Record<string, unknown>>;
}) {
  if (!items || items.length === 0) return null;
  // Dedupe identical entries (same file + line + text). A read with several
  // ranges on one file emits one result per window, so without this the list
  // shows the same path N times. Distinct lines (grep hits) keep their own
  // rows since the line/text part of the key differs.
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const it of items) {
    const file = String(it.file ?? it.path ?? "");
    if (!file) continue;
    const line =
      it.line !== undefined && it.line !== null ? String(it.line) : "";
    const text = String(it.text ?? "");
    const key = `${file}\0${line}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  if (deduped.length === 0) return null;
  // Every hit renders right here and the list scrolls (.file-results carries a
  // max-height): the row expands IN PLACE — results never hop to the side
  // panel (user request).
  return (
    <ul className="file-results" dir="ltr" aria-label={`${tool} results`}>
      {deduped.map((it, i) => {
        const file = String(it.file ?? it.path ?? "");
        if (!file) return null;
        const line =
          it.line !== undefined && it.line !== null ? String(it.line) : "";
        const text = String(it.text ?? "");
        return (
          <li key={i} className="file-result">
            <FileChip
              path={file}
              line={line ? Number(line) : undefined}
              // Basename only in the UI — the full path stays in the tooltip.
              display={`${fileBasename(file)}${line ? `:${line}` : ""}`}
            />
            {text && <span className="file-result-text">{text}</span>}
          </li>
        );
      })}
    </ul>
  );
});

/** Keys already rendered as dedicated chips in the tool-card head. */
