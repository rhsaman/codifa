import { useCallback, useEffect, useMemo, useState } from "react";
import { useViewerTabs } from "../lib/viewerTabs";
import {
  deleteArtifact,
  getArtifact,
  listArtifacts,
  type ArtifactSummary,
} from "../lib/artifacts";

/** The Artifacts page: every document the agent built, newest first.
 *
 *  A LIST page and nothing else: artifacts are created and edited from the
 *  chat (`/artifact <description>` owns that), so this page never grows a
 *  form. Opening a row fetches the saved body and docks the sandboxed preview
 *  — the same panel the transcript card opens.
 *
 *  Independent of the chat on screen: a row opens a GLOBAL viewer tab (see
 *  `openArtifact`), so picking a document never switches or focuses a chat,
 *  and a document whose chat was deleted still opens. */
export function ArtifactsPanel() {
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Row awaiting a second click on its trash button (the inline confirm).
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped by Refresh: re-runs the fetch effect without remounting the page.
  const [gen, setGen] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    const out = await listArtifacts();
    if ("error" in out) {
      setError(out.error);
      setItems([]);
      return;
    }
    setItems(out);
  }, []);

  useEffect(() => {
    void load();
  }, [load, gen]);

  /** Rows after the search box: title and format are the only labels the page
   *  shows, so they are also what a query has to match. */
  const shown = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.title} ${it.kind ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);

  /** Fetched on click, never in the list: a page listing dozens of generated
   *  documents must not pull every body just to draw its rows. */
  const open = async (item: ArtifactSummary) => {
    const doc = await getArtifact(item.chatId, item.id);
    if ("error" in doc) {
      setError(doc.error);
      return;
    }
    // The tab is global, so it shows in whatever chat is on screen: the owner
    // chat travels with it only so a restored tab can re-read its body.
    useViewerTabs.getState().openArtifact(item.chatId, {
      id: doc.id,
      title: doc.title,
      kind: doc.kind ?? "html",
      body: doc.content,
      version: doc.version,
    });
  };

  /** Delete one document: its folder on disk, and its viewer tab if it is open.
   *  The tab id is the same one `openArtifact` builds, so a deleted document
   *  cannot be left behind as a frame that would only fail to reload. */
  const remove = async (item: ArtifactSummary) => {
    const key = rowKey(item);
    setBusy(key);
    const out = await deleteArtifact(item.chatId, item.id);
    setBusy(null);
    setConfirming(null);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    // A successful delete clears the previous failure: leaving the old banner
    // up would keep telling the user about a problem that is already solved.
    setError(null);
    useViewerTabs.getState().closeViewer(`artifact:${item.chatId}:${item.id}`);
    setItems((cur) => (cur ?? []).filter((x) => rowKey(x) !== key));
  };

  // Search only makes sense once there is something to search. Deliberately
  // NOT tied to `error`: a failed delete must leave the list (and its search
  // box) usable, and the banner sits above the rows either way.
  const searchable = items !== null && items.length > 0;

  return (
    <div className="artifacts-panel">
      <div className="artifacts-panel-head">
        <span className="artifacts-panel-title">Artifacts</span>
        <span className="artifacts-panel-count">
          {items === null ? "" : `${items.length}`}
        </span>
        <button
          type="button"
          className="artifacts-refresh"
          title="Refresh the artifact list"
          aria-label="Refresh the artifact list"
          onClick={() => setGen((g) => g + 1)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 5v6h-6" />
          </svg>
        </button>
      </div>

      {searchable && (
        <div className="review-search-row">
          <label className="review-search" dir="ltr">
            <span aria-hidden="true">🔍</span>
            <input
              className="review-search-input"
              type="search"
              placeholder="Search artifacts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() ? (
              <>
                <span className="review-search-count">
                  {shown?.length ?? 0}/{items?.length ?? 0}
                </span>
                <button
                  type="button"
                  className="review-search-btn"
                  title="Clear search"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  ✕
                </button>
              </>
            ) : null}
          </label>
        </div>
      )}

      {error && (
        <div className="artifacts-error" role="alert">
          {error}
        </div>
      )}

      {/* A failed DELETE still has a list to show: hiding the rows on any
          error left the page blank right when the user needed to see which
          document survived and retry. Only an empty list falls back to the
          error banner alone (there is nothing else to draw). */}
      {items === null ? (
        <div className="artifacts-loading">Loading artifacts…</div>
      ) : items.length === 0 ? (
        error ? null : (
          <div className="viewer-empty">
            No artifacts yet. Build one from the chat with{" "}
            <code>/artifact &lt;description&gt;</code>.
          </div>
        )
      ) : shown !== null && shown.length === 0 ? (
        <div className="viewer-empty">No artifact matches “{query.trim()}”.</div>
      ) : (
        <div className="artifacts-list">
          {(shown ?? []).map((it) => (
            <div className="artifacts-row" key={rowKey(it)}>
              <button
                type="button"
                className="artifacts-open"
                title={`Open ${it.title}`}
                onClick={() => void open(it)}
              >
                <span className="artifacts-icon" aria-hidden="true">
                  {it.kind === "md" ? "¶" : "</>"}
                </span>
                <span className="artifacts-title">{it.title}</span>
                <span className="artifacts-meta">
                  {it.kind ?? "html"}
                  {it.version ? ` · v${it.version}` : ""}
                </span>
                <span className="artifacts-time">{ago(it.updatedAt)}</span>
              </button>
              {confirming === rowKey(it) ? (
                <button
                  type="button"
                  className="artifacts-delete danger active"
                  title={`Delete ${it.title} for good`}
                  aria-label={`Confirm deleting ${it.title}`}
                  disabled={busy === rowKey(it)}
                  onClick={() => void remove(it)}
                >
                  Delete
                </button>
              ) : (
                <button
                  type="button"
                  className="artifacts-delete"
                  title={`Delete ${it.title}`}
                  aria-label={`Delete ${it.title}`}
                  onClick={() => setConfirming(rowKey(it))}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16" />
                    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Identity of a row: an artifact id is unique inside its chat, not globally. */
function rowKey(it: ArtifactSummary): string {
  return `${it.chatId}:${it.id}`;
}

/** Coarse age of a save, for the row's trailing label. Seconds-resolution and
 *  English-only on purpose: the page lists technical documents, and a fixed
 *  wording stays readable at any pane width. */
function ago(updatedAt: number): string {
  if (!updatedAt) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - updatedAt);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
