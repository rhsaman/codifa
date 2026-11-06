import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode, SVGProps } from "react";
import { detectDir } from "../lib/bidi";
import { isolateLtrRuns } from "../lib/ltrIslands";

// Agent-driven chart rendering: a ```chart fenced block whose body is a JSON
// spec renders as a real chart (like ChatGPT's inline charts) instead of code.
//
//   ```chart
//   {"type":"bar","title":"عوامل فاندامنتال بر EUR/USD","labels":
//    ["صعودی برای یورو","نزولی برای یورو"],"series":[{"values":[1,2]}]}
//   ```
//
// The streaming contract is the same as Mermaid's: a body still containing
// fence markers is mid-stream and not rendered yet; after a short debounce an
// unparsable body falls back to the raw source in a plain block — never an
// error card. Zero chart dependency: the SVG is drawn by hand with the app's
// CSS-variable theme colors (same approach as Mermaid.tsx).

export type ChartType = "bar" | "line" | "pie";

export interface ChartSeries {
  name?: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  unit?: string;
  labels: string[];
  series: ChartSeries[];
  /** Logical pixel height of the plot area (default 300). */
  height?: number;
}

/** Parse + validate a ```chart body. null when the JSON is unusable — the
 *  component then shows the raw source. Tolerant on values: strings that look
 *  like numbers ("1.12", "۴۰") are coerced, junk entries are dropped. */
export function parseChartSpec(raw: string): ChartSpec | null {
  // prepareContent/fixCodeBlock may have injected LRM/ZWSP/bidi marks into the
  // fence body (they sit OUTSIDE the JSON strings and break JSON.parse) — strip
  // them, plus trailing commas models like to leave.
  const cleaned = raw
    .replace(/[​‎‏؜‪-‮⁦-⁩﻿]/g, "")
    .replace(/,(\s*[}\]])/g, "$1")
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const type = obj.type === "line" || obj.type === "pie" ? obj.type : obj.type === "bar" ? "bar" : null;
  if (!type) return null;
  const faDigits = "۰۱۲۳۴۵۶۷۸۹";
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const norm = v.replace(/[۰-۹]/g, (d) => String(faDigits.indexOf(d))).replace(/[٬,]/g, "").trim();
      const n = Number(norm);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const labels = Array.isArray(obj.labels)
    ? (obj.labels as unknown[]).filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    : [];
  const seriesIn = Array.isArray(obj.series) ? obj.series : [{ values: obj.values }];
  const series: ChartSeries[] = [];
  for (const s of seriesIn) {
    if (!s || typeof s !== "object") continue;
    const rawVals = (s as Record<string, unknown>).values;
    if (!Array.isArray(rawVals)) continue;
    const values = rawVals.map(toNum).filter((n): n is number => n !== null);
    if (values.length === 0) continue;
    const name = (s as Record<string, unknown>).name;
    series.push({ name: typeof name === "string" && name.trim() ? name : undefined, values });
  }
  if (series.length === 0) return null;
  const unit = typeof obj.unit === "string" && obj.unit.trim() ? obj.unit.trim() : undefined;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;
  const height =
    typeof obj.height === "number" && obj.height >= 160 && obj.height <= 800 ? obj.height : undefined;
  return { type, title, unit, labels, series, height };
}

// Palette tuned for the dark theme; the first color tracks --accent so charts
// blend with the app. (SVG presentation attributes can't hold var(), so these
// are literal hex values — the accent copy is read at render time.)
const FALLBACK_ACCENT = "#5b8def";
const PALETTE = ["#45a875", "#d2994a", "#c75f8f", "#7f8cc4", "#5fb8c9", "#b8654a"];

function useChartColors(): string[] {
  return useMemo(() => {
    let accent = FALLBACK_ACCENT;
    try {
      const cs = getComputedStyle(document.documentElement);
      accent = cs.getPropertyValue("--accent").trim() || FALLBACK_ACCENT;
    } catch {
      /* SSR / detached document — keep the fallback */
    }
    return [accent, ...PALETTE];
  }, []);
}

/** Round a max value up to a friendly axis ceiling (1/2/5 × 10^k). */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}

const fmtNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);

// ---- SVG text helpers -------------------------------------------------------

/** A <text> node whose content resolves its own bidi paragraph direction
 *  (unicode-bidi: plaintext = dir="auto" behavior for SVG text — React's SVG
 *  typings have no dir attribute) with numbers kept LTR via the island
 *  wrapper. */
function ChartText(props: SVGProps<SVGTextElement> & { lines?: string[] }) {
  const { lines, children, style, ...rest } = props;
  const content = typeof children === "string" ? isolateLtrRuns(children) : children;
  const bidiStyle = { ...(style as object), unicodeBidi: "plaintext" } as CSSProperties;
  if (lines && lines.length > 1) {
    return (
      <text {...rest} style={bidiStyle}>
        {lines.map((ln, i) => (
          <tspan key={i} x={rest.x} dy={i === 0 ? 0 : 13}>
            {isolateLtrRuns(ln)}
          </tspan>
        ))}
      </text>
    );
  }
  return (
    <text {...rest} style={bidiStyle}>
      {content}
    </text>
  );
}

/** Greedy word-wrap into at most `maxLines` lines of ~`width` px at ~6.4px/char. */
function wrapLabel(label: string, width: number, maxLines = 2): string[] {
  const perLine = Math.max(4, Math.floor(width / 6.4));
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= perLine || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (words.join(" ").length > lines.join(" ").length + 1 && last.length > perLine - 1) {
      lines[maxLines - 1] = last.slice(0, Math.max(1, perLine - 2)) + "…";
    }
  }
  return lines;
}

// ---- The component ----------------------------------------------------------

const W = 760;
const M = { top: 14, right: 14, bottom: 44, left: 48 };

export function ChartBlock({ spec }: { spec: string }) {
  // A body still containing ``` / ~~~ is mid-stream: keep showing the raw
  // source (styled like mermaid-fallback) and re-check after a debounce.
  const complete = Boolean(spec) && !/[`~]{3}/.test(spec);
  const [debounced, setDebounced] = useState(spec);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(spec), 400);
    return () => clearTimeout(t);
  }, [spec]);
  const parsed = useMemo(
    () => (complete ? parseChartSpec(debounced) : null),
    [complete, debounced],
  );
  const colors = useChartColors();

  if (!parsed) {
    return <pre className="chart-fallback">{spec}</pre>;
  }

  const { type, title, unit, labels, series, height: specH } = parsed;
  const plotH = specH ?? 300;
  // Pie legends are per-DATA-POINT (each slice = one label); bar/line legends
  // appear only with multiple series (one per series).
  const legendItems: { label: string; color: string }[] =
    type === "pie"
      ? labels.map((lb, i) => ({ label: lb, color: "" }))
      : series.length > 1
        ? series.map((s, i) => ({ label: s.name ?? labels[i] ?? `#${i + 1}`, color: "" }))
        : [];
  const legendRows = legendItems.length > 0 ? Math.ceil(legendItems.length / 4) : 0;
  const H = M.top + plotH + M.bottom + (title ? 24 : 0) + (legendRows > 1 ? (legendRows - 1) * 16 : 0);
  const titleY = title ? M.top + 14 : 0;
  const plotTop = M.top + (title ? 24 : 0);
  const plotW = W - M.left - M.right;
  const dir = detectDir(debounced);

  const allValues = series.flatMap((s) => s.values.map(Math.abs));
  const maxVal = niceMax(Math.max(1, ...allValues));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxVal);
  const y = (v: number) => plotTop + plotH - (v / maxVal) * plotH;

  const titleEl = title ? (
    <ChartText
      x={W / 2}
      y={titleY}
      textAnchor="middle"
      fontSize={14}
      fontWeight={600}
      style={{ fill: "var(--text)" }}
    >
      {unit ? `${title} (${unit})` : title}
    </ChartText>
  ) : null;

  const grid = (
    <g>
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={M.left}
            x2={W - M.right}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--border)"
            strokeDasharray={i === 0 ? undefined : "3 4"}
          />
          <ChartText
            x={M.left - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize={11}
            style={{ fill: "var(--text-dim)" }}
          >
            {fmtNum(t)}
          </ChartText>
        </g>
      ))}
    </g>
  );

  const legendWithColors = legendItems.map((item, i) => ({
    ...item,
    color: colors[i % colors.length],
  }));
  const legend =
    legendWithColors.length > 0 ? (
      <g>
        {legendWithColors.map((item, i) => {
          const label = item.label;
          const lw = label.length * 6.6 + 26;
          // Legend under the plot, laid out RTL when the chart is Persian.
          const slots = Math.max(1, Math.floor(plotW / Math.max(lw, 90)));
          const row = Math.floor(i / slots);
          const col = i % slots;
          const x =
            dir === "rtl"
              ? W - M.right - col * Math.max(lw, 90) - 14
              : M.left + col * Math.max(lw, 90) + 8;
          const ly = plotTop + plotH + 30 + row * 16;
          return (
            <g key={i}>
              <rect x={x - 12} y={ly - 8} width={10} height={10} rx={3} fill={item.color} />
              <ChartText x={x} y={ly} fontSize={11} style={{ fill: "var(--text-dim)" }}>
                {label}
              </ChartText>
            </g>
          );
        })}
      </g>
    ) : null;

  let body: ReactNode = null;

  if (type === "bar") {
    const n = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
    const slot = plotW / n;
    const groupW = slot * 0.7;
    const barW = Math.min(groupW / series.length, 64);
    body = (
      <g>
        {series.map((s, si) =>
          s.values.map((v, i) => {
            const inGroup =
              series.length === 1
                ? (groupW - barW) / 2
                : si * barW + (groupW - series.length * barW) / 2;
            const bx = M.left + i * slot + inGroup;
            const by = y(Math.max(0, v));
            const bh = Math.max(2, plotTop + plotH - by);
            return (
              <g key={`${si}-${i}`}>
                <rect
                  x={bx}
                  y={by}
                  width={barW}
                  height={bh}
                  rx={Math.min(6, barW / 3)}
                  fill={colors[si % colors.length]}
                  opacity={0.92}
                >
                  <title>{`${labels[i] ?? ""} ${s.name ? "— " + s.name : ""}: ${fmtNum(v)}`}</title>
                </rect>
                {series.length === 1 && (
                  <ChartText
                    x={bx + barW / 2}
                    y={by - 6}
                    textAnchor="middle"
                    fontSize={11}
                    style={{ fill: "var(--text-dim)" }}
                  >
                    {fmtNum(v)}
                  </ChartText>
                )}
              </g>
            );
          }),
        )}
        {labels.map((lb, i) => {
          const lines = wrapLabel(lb, slot * 0.94);
          return (
            <ChartText
              key={i}
              x={M.left + i * slot + slot / 2}
              y={plotTop + plotH + (lines.length > 1 ? 14 : 18)}
              textAnchor="middle"
              fontSize={12}
              lines={lines}
              style={{ fill: "var(--text)" }}
            >
              {lb}
            </ChartText>
          );
        })}
      </g>
    );
  } else if (type === "line") {
    const n = Math.max(labels.length, ...series.map((s) => s.values.length), 2);
    const step = plotW / (n - 1 || 1);
    const px = (i: number) => M.left + i * step;
    body = (
      <g>
        {series.map((s, si) => (
          <g key={si}>
            <polyline
              points={s.values.map((v, i) => `${px(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={colors[si % colors.length]}
              strokeWidth={2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.values.map((v, i) => (
              <circle key={i} cx={px(i)} cy={y(v)} r={3.4} fill={colors[si % colors.length]}>
                <title>{`${labels[i] ?? ""} ${s.name ? "— " + s.name : ""}: ${fmtNum(v)}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {labels.map((lb, i) => {
          const lines = wrapLabel(lb, Math.max(step, 48) * 0.94);
          return (
            <ChartText
              key={i}
              x={px(i)}
              y={plotTop + plotH + (lines.length > 1 ? 14 : 18)}
              textAnchor="middle"
              fontSize={12}
              lines={lines}
              style={{ fill: "var(--text)" }}
            >
              {lb}
            </ChartText>
          );
        })}
      </g>
    );
  } else {
    // pie — single series; slices in logical order, legend carries labels.
    const values = series[0].values;
    const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const cx = W / 2;
    const cy = plotTop + plotH / 2;
    const r = Math.min(plotH, plotW) / 2 - 12;
    let acc = -Math.PI / 2;
    body = (
      <g>
        {values.map((v, i) => {
          const frac = Math.abs(v) / total;
          const a1 = acc;
          const a2 = acc + frac * Math.PI * 2;
          acc = a2;
          const large = a2 - a1 > Math.PI ? 1 : 0;
          const x1 = cx + r * Math.cos(a1);
          const y1 = cy + r * Math.sin(a1);
          const x2 = cx + r * Math.cos(a2);
          const y2 = cy + r * Math.sin(a2);
          return (
            <path
              key={i}
              d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
              fill={colors[i % colors.length]}
              stroke="var(--bg-panel)"
              strokeWidth={2}
              opacity={0.95}
            >
              <title>{`${labels[i] ?? series[0].name ?? ""}: ${fmtNum(v)} (${Math.round(frac * 100)}%)`}</title>
            </path>
          );
        })}
      </g>
    );
  }

  return (
    <div className="chart-block">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={title ?? "chart"}
        style={{ display: "block" }}
      >
        {titleEl}
        {type !== "pie" && grid}
        {type !== "pie" && <line x1={M.left} x2={M.left} y1={plotTop} y2={plotTop + plotH} stroke="var(--border)" />}
        {body}
        {legend}
      </svg>
    </div>
  );
}
