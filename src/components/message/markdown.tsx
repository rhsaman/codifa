import { fixArrowDirections, rehypeArrows } from '../../lib/arrowDir'
import { detectDir } from '../../lib/bidi'
import { extractInlinePathParts, filePathFromHref, looksLikeFilePath, splitPathLine } from '../../lib/fileTypes'
import { handleLinkClick, splitTextByUrls } from '../../lib/link'
import { rehypeLtrIslands } from '../../lib/ltrIslands'
import { FileChip } from '../FileIcon'
import { memo, useLayoutEffect, useRef } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock, MarkdownImage, VideoThumbnailCard, extractVideoEmbed, openExternalPreferred, textFromChildren } from './doccard'

import { cachedPrepare } from './shared'
export const mdComponents = {
  // react-markdown only puts the language in `className` and DROPS the rest of
  // the info string (e.g. `go:19-20:Plan.go` -> className `language-go`). We
  // stash the full meta (`19-20:Plan.go`) on `data-meta` so CodeBlock can read
  // the real line range and file name that foldLineCaptions injected.
  code: (props: any) => {
    const node = props.node;
    let meta = node?.data?.meta ?? "";
    // Fallback: react-markdown v9 may put the entire info string in className
    // (e.g. "language-go:19-20:Plan.go"). Extract meta after the language prefix.
    if (!meta) {
      const cn = String(node?.properties?.className ?? props.className ?? "");
      const m = /^language-[\w-]+:(.+)/.exec(cn);
      if (m) meta = m[1];
    }
    // Inline code that is a bare file path (`src/App.tsx`, `backend/x.py:12`)
    // renders as a clickable file chip instead of a code span. Fences with a
    // language/meta never chip (meta is set); a single-token bare fence that
    // slips into this branch is still safe — CodeBlock recovers the text from
    // the chip's props, so the block renders with the path verbatim.
    if (!meta) {
      const text = textFromChildren(props.children);
      // Inline code that contains an http(s) URL linkifies the URL part and
      // opens it in the OS browser (Chrome when available). URLs never become
      // FileChips: looksLikeFilePath already rejects schemes, and this branch
      // runs first so a URL is never misclassified as a path.
      if (!text.includes("\n")) {
        const urlParts = splitTextByUrls(text);
        if (urlParts.some((p) => typeof p !== "string")) {
          if (
            urlParts.length === 1 &&
            typeof urlParts[0] !== "string"
          ) {
            const url = (urlParts[0] as { url: string }).url;
            return (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  handleLinkClick(e, url, openExternalPreferred);
                }}
              >
                {url}
              </a>
            );
          }
          return (
            // One LTR island around the WHOLE split (chip pieces + links): as
            // separate siblings each piece is an isolated unit and the RTL
            // line orders them right-to-left, turning "/plugin install URL"
            // into "URL … install". Inside a single dir=ltr isolate the
            // pieces keep their left-to-right command order in both message
            // directions.
            <span dir="ltr" className="ltr-island">
              {urlParts.map((p, i) =>
                typeof p === "string" ? (
                  <code key={i} data-meta={meta}>
                    {p}
                  </code>
                ) : (
                  <a
                    key={i}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      handleLinkClick(e, p.url, openExternalPreferred);
                    }}
                  >
                    {p.url}
                  </a>
                ),
              )}
            </span>
          );
        }
      }
      if (looksLikeFilePath(text)) {
        const { path, line } = splitPathLine(text);
        return <FileChip path={path} line={line} display={text} />;
      }
      // Composite spans ("Edit fs.ts src/lib/ +49") keep their single pill:
      // the path inside becomes a clickable FileChip while the surrounding
      // words stay plain code text.
      const parts = extractInlinePathParts(text);
      if (parts.some((p) => typeof p !== "string")) {
        return (
          <code {...props} data-meta={meta}>
            {parts.map((p, i) =>
              typeof p === "string" ? (
                p
              ) : (
                <FileChip key={i} path={p.path} line={p.line} display={p.display} />
              ),
            )}
          </code>
        );
      }
    }
    return (
      <code {...props} data-meta={meta}>
        {props.children}
      </code>
    );
  },
  img: (props: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => (
    <MarkdownImage {...props} />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = props.href ?? "";
    const video = extractVideoEmbed(href);
    if (video) {
      return (
        <VideoThumbnailCard
          video={video}
          href={href}
          children={props.children}
        />
      );
    }
    // EVERY link that points at a workspace file — a code path, a path with a
    // line, an absolute path, a `file://` URL or a document (pdf/word/excel/
    // csv) — renders as a clickable chip that opens the viewer, exactly like
    // inline-code paths. As a plain `<a target="_blank">` the webview followed
    // the href and left the app (the OS browser opened) instead of opening the
    // file; only real web URLs and in-page anchors stay links.
    const fileRef = filePathFromHref(href);
    if (fileRef) {
      const label =
        typeof props.children === "string" && props.children
          ? props.children
          : href;
      return (
        <FileChip
          path={fileRef.path}
          line={fileRef.line}
          display={String(label)}
        />
      );
    }
    // react-markdown's sanitizer blanks the href of anything it refuses
    // (javascript:, data:, …): show the label as plain text — an anchor with an
    // empty href would reload the whole webview when clicked.
    if (!href) {
      return <>{props.children}</>;
    }
    return (
      <a
        {...props}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          // Forward http(s) links to the OS browser (Chrome when available);
          // internal anchors keep their default behaviour inside the app.
          handleLinkClick(e, props.href, openExternalPreferred);
        }}
      />
    );
  },
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <CodeBlock {...props} />
  ),
  table: ({
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLTableElement> & { node?: unknown }) => (
    <div className="markdown-table-scroll">
      <table {...props} />
    </div>
  ),
};

export const PROSE_REMARK_PLUGINS = [remarkGfm];
// rehypeArrows FIRST (it claims the arrows and isolates their operands),
// then the LTR islands for numbers / Latin word runs / mixed phrases.
export const PROSE_REHYPE_PLUGINS = [rehypeArrows, rehypeLtrIslands];

/** react-markdown blanks the href of every scheme it does not know, which
 *  killed `file://` citations before the `a` override could turn them into
 *  file chips. Keep `file:` AND `codifa-media://` (generated images/videos —
 *  MarkdownImage resolves them to local /media/file URLs) intact; every other
 *  scheme stays sanitized. */
export function keepFileUrls(url: string): string {
  return /^(file|codifa-media):/i.test(url) ? url : defaultUrlTransform(url);
}

/** One markdown prose block. Besides rendering, it fixes the direction of
 *  arrows in RTL text (see lib/arrowDir.ts).
 *
 *  The layout effect is keyed on `text` (the direction is already baked into it
 *  by `cachedPrepare`): with NO dependency array it re-ran after every commit,
 *  so a streaming reply walked the whole prose block —
 *  `querySelectorAll(".md-arrow")` plus a `createTreeWalker` per arrow — once per
 *  TOKEN, for every mounted message, defeating the point of the text cache. The
 *  arrow direction is a pure function of the text, so re-measuring it is only
 *  needed when the text actually changes.
 *
 *  `memo` keeps a parent re-render (dir toggle, sibling stream) from re-parsing
 *  markdown that did not change.
 *  Exported so ReadingMode renders through the exact same pipeline (plugins,
 *  components, arrow-direction effect) instead of a bare ReactMarkdown. */
export const MarkdownProse = memo(function MarkdownProse({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fixArrowDirections(ref.current);
  }, [text]);
  return (
    // dir from the WHOLE text (any Persian char → rtl), not dir="auto": a
    // mostly-Persian message that opens with a Latin word or heading
    // ("## EUR/USD تحلیل…") must not flip the whole block to LTR.
    <div ref={ref} className="chat-message markdown-body" dir={detectDir(text)}>
      <ReactMarkdown
        remarkPlugins={PROSE_REMARK_PLUGINS}
        rehypePlugins={PROSE_REHYPE_PLUGINS}
        urlTransform={keepFileUrls}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
})

