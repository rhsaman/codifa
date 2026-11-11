var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/bidi.ts
function stripBidiMarks(text) {
  if (typeof text !== "string") return "";
  return text.replace(BIDI_MARKS, "");
}
function fixZwsp(text) {
  return text.replace(INVISIBLE_SEP, (sep, offset) => {
    const before = text[offset - 1];
    const after = text[offset + sep.length];
    if (before && /\s/u.test(before)) return "";
    if (after && /\s/u.test(after)) return "";
    const leftOk = before === void 0 ? true : LEFT_WORDISH.test(before);
    const rightOk = after === void 0 ? true : RIGHT_WORDISH.test(after);
    return leftOk && rightOk ? " " : "";
  });
}
function applyRtlToSvgText(svg) {
  const markSvg = (s, tag) => {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
    return s.replace(re, (m, attrs, content) => {
      if (RTL_CHAR_RE.test(content) && !/\bdir\s*=/.test(attrs)) {
        return `<${tag} dir="auto"${attrs}>${content}</${tag}>`;
      }
      return m;
    });
  };
  let out = markSvg(markSvg(svg, "tspan"), "text");
  out = out.replace(/<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/g, (fo) => {
    return fo.replace(
      /<(div|p|span|label|td|li)\b([^>]*)>([\s\S]*?)<\/\1>/g,
      (m, tag, attrs, content) => {
        if (/\bdir\s*=/.test(attrs)) return m;
        if (!RTL_CHAR_RE.test(content)) return m;
        return `<${tag} dir="auto"${attrs}>${content}</${tag}>`;
      }
    );
  });
  return out;
}
function detectDir(text) {
  return RTL_CHAR_RE.test(text) ? "rtl" : "ltr";
}
function faToLat(n) {
  return n.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
}
function foldLineCaptions(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let lastPath = "";
  while (i < lines.length) {
    let rangeM = LINE_RANGE_RE.exec(lines[i]);
    if (rangeM && !rangeM[2]) rangeM = LINE_RANGE_CONN_RE.exec(lines[i]) ?? rangeM;
    let pathM = PATH_RE.exec(lines[i]);
    if (!pathM && rangeM) {
      const looseM = /([\w\/\\-]+\.\w{1,5})(?:\s|$|[:\(])/.exec(lines[i]);
      if (looseM) {
        pathM = [looseM[0], looseM[1], "", ""];
      }
    }
    if (rangeM && pathM) {
      const startN = parseInt(faToLat(rangeM[1]), 10);
      const endN = rangeM[2] ? parseInt(faToLat(rangeM[2]), 10) : startN;
      const lo = Math.min(startN, endN);
      const hi = Math.max(startN, endN);
      lastPath = pathM[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].trim().length > 0 && lines[j].trim().length <= 12 && !lines[j].trim().startsWith("```")) {
        j++;
        while (j < lines.length && lines[j].trim() === "") j++;
      }
      const fence = j < lines.length ? /^```\s*([\w-]+)/.exec(lines[j]) : null;
      if (fence) {
        const lang = fence[1] || "text";
        lines[j] = "```" + lang + ":" + lo + "-" + hi + ":" + pathM[1];
        i = j;
        continue;
      }
    } else if (pathM && !rangeM) {
      lastPath = pathM[1];
      if (pathM[2]) {
        const startN = parseInt(faToLat(pathM[2]), 10);
        const endN = pathM[3] ? parseInt(faToLat(pathM[3]), 10) : startN;
        const lo = Math.min(startN, endN);
        const hi = Math.max(startN, endN);
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && lines[j].trim().length > 0 && lines[j].trim().length <= 12 && !lines[j].trim().startsWith("```")) {
          j++;
          while (j < lines.length && lines[j].trim() === "") j++;
        }
        const fence = j < lines.length ? /^```\s*([\w-]+)/.exec(lines[j]) : null;
        if (fence) {
          const bare = BARE_RANGE_FENCE_RE.exec(lines[j]);
          if (bare) {
            lines[j] = "```" + (bare[1] || "text") + ":" + faToLat(bare[2]) + "-" + faToLat(bare[3]) + ":" + pathM[1];
          } else {
            lines[j] = "```" + (fence[1] || "text") + ":" + lo + "-" + hi + ":" + pathM[1];
          }
          out.push(lines[i]);
          i = j;
          continue;
        }
      }
    } else {
      const bare = BARE_RANGE_FENCE_RE.exec(lines[i]);
      if (bare && lastPath) {
        lines[i] = "```" + (bare[1] || "text") + ":" + faToLat(bare[2]) + "-" + faToLat(bare[3]) + ":" + lastPath;
      }
    }
    out.push(lines[i]);
    i++;
  }
  const result = [];
  let k = 0;
  while (k < out.length) {
    const fenceOpen = /^```(\s*)([\w-]*)/.exec(out[k]);
    if (fenceOpen) {
      const indent = fenceOpen[1];
      const existingLang = faToLat(fenceOpen[2]);
      let contentIdx = k + 1;
      while (contentIdx < out.length && out[contentIdx].trim() === "") contentIdx++;
      if (contentIdx < out.length) {
        const commentM = /^#\s*((?:[\w\/\\-]+\/)*[\w\/\\-]*[\w.-]+\.\w+):(\d+)(?:-(\d+))?/.exec(out[contentIdx].trim());
        if (commentM) {
          const startN = parseInt(commentM[2], 10);
          const endN = commentM[3] ? parseInt(commentM[3], 10) : startN;
          const lo = Math.min(startN, endN);
          const hi = Math.max(startN, endN);
          lastPath = commentM[1];
          const lang = existingLang || "text";
          result.push("```" + lang + ":" + lo + "-" + hi + ":" + commentM[1]);
          k = contentIdx + 1;
          while (k < out.length && !/^```\s*$/.test(out[k])) {
            result.push(out[k]);
            k++;
          }
          if (k < out.length && /^```\s*$/.test(out[k])) {
            result.push(out[k]);
            k++;
          }
          continue;
        }
      }
    }
    result.push(out[k]);
    k++;
  }
  return result.join("\n");
}
function prepareContent(text, _dir) {
  if (text == null) return "";
  if (typeof text !== "string") {
    try {
      text = String(text);
    } catch {
      return "";
    }
  }
  if (!text) return text;
  const brCleaned = text.split(/(```[\s\S]*?```)/g).map((seg, i) => i % 2 === 1 ? seg : seg.replace(/<\/?br\s*\/?>/gi, "\n")).join("");
  const cleaned = stripBidiMarks(brCleaned);
  const folded = foldLineCaptions(cleaned);
  const parts = folded.split(/```/g);
  const REF_DEF_RE = /^\[([^\]]+)\]:\s+https?:\/\//i;
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return /^\s*(chart|json|jsonc)\b/i.test(p) ? p : fixCodeBlock(p);
    return p.split("\n").map((line) => {
      if (REF_DEF_RE.test(line)) return line;
      return fixZwsp(line);
    }).join("\n");
  });
  return fixed.join("```");
}
function isMostlyRtlText(text) {
  const nonWs = text.replace(/\s+/g, "");
  if (nonWs.length < RTL_PROSE_MIN_CHARS) return false;
  const rtl = nonWs.length - nonWs.replace(RTL_CHAR_ALL_RE, "").length;
  return rtl / nonWs.length >= RTL_PROSE_RATIO;
}
function fixCodeBlock(code) {
  return code.split("\n").map((line) => {
    const cmt = COMMENT_PREFIX_RE.exec(line);
    const start = cmt ? cmt[0].length : 0;
    const head = line.slice(0, start);
    const tail = line.slice(start);
    if (!RTL_CHAR_RE.test(tail)) return line;
    const PERSIAN_RUN_RE = new RegExp(`[${PERSIAN_RANGE}][^\\x00-\\x7F]*`, "g");
    let result = "";
    let cursor = 0;
    let m;
    while ((m = PERSIAN_RUN_RE.exec(tail)) !== null) {
      result += tail.slice(cursor, m.index);
      result += fixZwsp(m[0]);
      cursor = m.index + m[0].length;
    }
    result += tail.slice(cursor);
    let prev;
    do {
      prev = result;
      result = result.replace(MIXED_WORD_RE, (mm, fa1, as1, as2, fa2) => {
        return fa1 !== void 0 ? fa1 + " " + as1 : as2 + " " + fa2;
      });
    } while (result !== prev);
    return head + injectLrmMarks(result);
  }).join("\n");
}
function injectLrmMarks(text) {
  if (!RTL_CHAR_RE.test(text)) return text;
  const LEADING_PERSIAN_RE = new RegExp(`^[^${PERSIAN_RANGE}]*[${PERSIAN_RANGE}]`);
  if (LEADING_PERSIAN_RE.test(text)) {
    text = LRM + text;
  }
  return text.replace(SCRIPT_BOUNDARY_RE, (m, fa1, as1, as2, fa2) => {
    return fa1 !== void 0 ? fa1 + LRM + as1 : as2 + LRM + fa2;
  });
}
var PERSIAN_RANGE, RTL_CHAR_RE, BIDI_MARKS, INVISIBLE_SEP, LEFT_WORDISH, RIGHT_WORDISH, FA_DIGITS, DIGITS_RE, LINE_RANGE_RE, LINE_RANGE_CONN_RE, PATH_RE, BARE_RANGE_FENCE_RE, RTL_PROSE_RATIO, RTL_PROSE_MIN_CHARS, RTL_CHAR_ALL_RE, COMMENT_PREFIX_RE, MIXED_WORD_RE, LRM, SCRIPT_BOUNDARY_RE;
var init_bidi = __esm({
  "src/lib/bidi.ts"() {
    "use strict";
    PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
    RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
    BIDI_MARKS = /[\u202A-\u202E\u2066-\u2069]/g;
    INVISIBLE_SEP = /[\u200B\u200E\u200F\u061C]+/g;
    LEFT_WORDISH = /[\p{L}\p{N}\)\]\u060C\u061B\u061F,.;!?:»«\u2013\u2014"']/u;
    RIGHT_WORDISH = /[\p{L}\p{N}(*_`\[\u2013\u2014«»"']/u;
    FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
    DIGITS_RE = `[0-9${FA_DIGITS}]`;
    LINE_RANGE_RE = new RegExp(
      `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*[-\u2013\u2014~]\\s*(${DIGITS_RE}+))?`
    );
    LINE_RANGE_CONN_RE = new RegExp(
      `\u062E\u0637\\s*(${DIGITS_RE}+)\\s+(?:\u062A\u0627|\u0627\u0644\u06CC)\\s+(${DIGITS_RE}+)`
    );
    PATH_RE = new RegExp(
      `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`
    );
    BARE_RANGE_FENCE_RE = new RegExp(
      "^```\\s*([\\w-]+):(" + DIGITS_RE + "+)-(" + DIGITS_RE + "+)\\s*$"
    );
    RTL_PROSE_RATIO = 0.3;
    RTL_PROSE_MIN_CHARS = 8;
    RTL_CHAR_ALL_RE = new RegExp(`[${PERSIAN_RANGE}]`, "g");
    COMMENT_PREFIX_RE = /^\s*(#|\/\/\/?)/;
    MIXED_WORD_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
    LRM = "\u200E";
    SCRIPT_BOUNDARY_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
  }
});

// src/lib/fileTypes.ts
function isDocPath(raw) {
  if (!raw) return false;
  const s = raw.replace(INVISIBLE, "").trim();
  if (!s) return false;
  const { path } = splitPathLine(s);
  return DOC_EXTS.has(extOf(path));
}
function filePathFromHref(raw) {
  if (!raw) return null;
  const s = raw.replace(INVISIBLE, "").trim();
  if (!s || s.startsWith("#") || WEB_HREF_RE.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^file:/i.test(s)) return null;
  const body = s.replace(/^file:\/\//i, "").trim();
  if (!body) return null;
  const { path, line } = splitPathLine(body);
  if (!path) return null;
  if (!/[\\/]/.test(path) && !extOf(path)) return null;
  return line === void 0 ? { path } : { path, line };
}
function extOf(path) {
  const base2 = path.replace(INVISIBLE, "").trim().replace(/[.,;:)\]}'"`]+$/, "");
  const name = base2.split(/[\\/]/).pop() ?? base2;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return ext;
}
function splitPathLine(raw) {
  const s = raw.replace(INVISIBLE, "").trim().replace(/[.,;)\]}'"]+$/, "");
  const m = /^(.+?):(\d{1,7})(?:-\d{1,7})?$/.exec(s);
  if (m) {
    const line = parseInt(m[2], 10);
    if (Number.isFinite(line) && line > 0) return { path: m[1], line };
  }
  return { path: s };
}
function looksLikeFilePath(raw) {
  const s = raw.replace(INVISIBLE, "").trim();
  if (!s || s.length > 300 || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  if (s.startsWith("#") || s.startsWith("@") || s.startsWith("$")) return false;
  if (s.includes("**") || s.includes("<") || s.includes(">")) return false;
  const { path } = splitPathLine(s);
  const ext = extOf(path);
  if (!ext) return false;
  const name = path.split(/[\\/]/).pop() ?? path;
  if (name.startsWith(".") && name.lastIndexOf(".") === 0) {
    return WHITELIST_EXTRA.has(ext) || ext in FILE_BADGES;
  }
  return ext in FILE_BADGES || WHITELIST_EXTRA.has(ext);
}
function extractInlinePathParts(raw) {
  if (!raw || !raw.includes("/")) return [raw];
  const tokens = raw.split(/(\s+)/).filter((t) => t !== "");
  const nextNonSep = (from) => {
    let j = from;
    while (j < tokens.length && /^\s+$/.test(tokens[j])) j++;
    return j;
  };
  const parts = [];
  let text = "";
  const flushText = () => {
    if (text) {
      parts.push(text);
      text = "";
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok)) {
      text += tok;
      continue;
    }
    const lead = /^[([{'"`]+/.exec(tok)?.[0] ?? "";
    const core = tok.slice(lead.length).replace(/[.,;:)\]}'"`]+$/, "");
    if (!core) {
      text += tok;
      continue;
    }
    if (core.includes("/") && looksLikeFilePath(core)) {
      flushText();
      if (lead) parts.push(lead);
      const { path, line } = splitPathLine(core);
      parts.push({ path, line, display: core });
      const tail = tok.slice(lead.length + core.length);
      if (tail) text += tail;
      continue;
    }
    if (!core.includes("/") && BARE_NAME_RE.test(core) && looksLikeFilePath(core)) {
      const j = nextNonSep(i + 1);
      if (j < tokens.length && DIR_TOKEN_RE.test(tokens[j])) {
        flushText();
        if (lead) parts.push(lead);
        const display = tokens[j] + core;
        const { path, line } = splitPathLine(display);
        parts.push({ path, line, display });
        const tail = tok.slice(lead.length + core.length);
        if (tail) text += tail;
        i = j;
        continue;
      }
    }
    text += tok;
  }
  flushText();
  return parts.length > 0 ? parts : [raw];
}
function fileBasename(path) {
  return path.replace(INVISIBLE, "").trim().split(/[\\/]/).pop() || path;
}
function dedupDocPaths(docs, attachments) {
  const attached = new Set(
    attachments.map((a) => fileBasename(a).toLowerCase())
  );
  const seenBase = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of docs) {
    const base2 = fileBasename(p).toLowerCase();
    if (attached.has(base2)) continue;
    if (seenBase.has(base2)) continue;
    seenBase.add(base2);
    out.push(p);
  }
  return out;
}
var INVISIBLE, FILE_BADGES, IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS, DOC_EXTS, WEB_HREF_RE, WHITELIST_EXTRA, BARE_NAME_RE, DIR_TOKEN_RE;
var init_fileTypes = __esm({
  "src/lib/fileTypes.ts"() {
    "use strict";
    INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
    FILE_BADGES = {
      js: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
      cjs: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
      mjs: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
      jsx: { label: "JSX", bg: "#f1e05a", fg: "#3b3106" },
      ts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
      mts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
      cts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
      tsx: { label: "TSX", bg: "#3178c6", fg: "#ffffff" },
      json: { label: "{}", bg: "#cbcb41", fg: "#3b3106" },
      jsonc: { label: "{}", bg: "#cbcb41", fg: "#3b3106" },
      html: { label: "5", bg: "#e34f26", fg: "#ffffff" },
      htm: { label: "5", bg: "#e34f26", fg: "#ffffff" },
      css: { label: "CSS", bg: "#264de4", fg: "#ffffff" },
      scss: { label: "SCSS", bg: "#c6538c", fg: "#ffffff" },
      sass: { label: "SASS", bg: "#c6538c", fg: "#ffffff" },
      less: { label: "LESS", bg: "#2b5e9d", fg: "#ffffff" },
      md: { label: "MD", bg: "#083fa1", fg: "#ffffff" },
      markdown: { label: "MD", bg: "#083fa1", fg: "#ffffff" },
      mdx: { label: "MDX", bg: "#083fa1", fg: "#ffffff" },
      py: { label: "PY", bg: "#3572a5", fg: "#ffffff" },
      pyi: { label: "PY", bg: "#3572a5", fg: "#ffffff" },
      rs: { label: "RS", bg: "#dea584", fg: "#57330f" },
      go: { label: "GO", bg: "#00add8", fg: "#ffffff" },
      rb: { label: "RB", bg: "#701516", fg: "#ffffff" },
      java: { label: "JAVA", bg: "#5382a1", fg: "#ffffff" },
      kt: { label: "KT", bg: "#a97bff", fg: "#241536" },
      swift: { label: "SWIFT", bg: "#f05138", fg: "#ffffff" },
      c: { label: "C", bg: "#555555", fg: "#ffffff" },
      h: { label: "H", bg: "#777777", fg: "#ffffff" },
      cpp: { label: "C++", bg: "#f34b7d", fg: "#ffffff" },
      cc: { label: "C++", bg: "#f34b7d", fg: "#ffffff" },
      hpp: { label: "HPP", bg: "#f34b7d", fg: "#ffffff" },
      cs: { label: "C#", bg: "#178600", fg: "#ffffff" },
      php: { label: "PHP", bg: "#4f5d95", fg: "#ffffff" },
      lua: { label: "LUA", bg: "#000080", fg: "#ffffff" },
      sh: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
      bash: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
      zsh: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
      fish: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
      ps1: { label: "PS", bg: "#012456", fg: "#ffffff" },
      sql: { label: "SQL", bg: "#e38c00", fg: "#ffffff" },
      yml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
      yaml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
      toml: { label: "TOML", bg: "#9c4221", fg: "#ffffff" },
      ini: { label: "INI", bg: "#8d8d8d", fg: "#ffffff" },
      env: { label: "ENV", bg: "#8d8d8d", fg: "#ffffff" },
      txt: { label: "TXT", bg: "#9e9e9e", fg: "#26221e" },
      pdf: { label: "PDF", bg: "#d0021b", fg: "#ffffff" },
      svg: { label: "SVG", bg: "#ffb13b", fg: "#57330f" },
      lock: { label: "LOCK", bg: "#7c7c7c", fg: "#ffffff" },
      // Additional languages / formats so every whitelisted ext gets a tile.
      vue: { label: "VUE", bg: "#41b883", fg: "#35495e" },
      svelte: { label: "S", bg: "#ff3e00", fg: "#ffffff" },
      astro: { label: "A", bg: "#ff5d01", fg: "#ffffff" },
      dart: { label: "DA", bg: "#0175c8", fg: "#ffffff" },
      ex: { label: "EX", bg: "#6e4a7e", fg: "#ffffff" },
      exs: { label: "EX", bg: "#6e4a7e", fg: "#ffffff" },
      erl: { label: "ER", bg: "#a90533", fg: "#ffffff" },
      hs: { label: "HS", bg: "#5e5086", fg: "#ffffff" },
      clj: { label: "CL", bg: "#63b132", fg: "#ffffff" },
      cljs: { label: "CL", bg: "#63b132", fg: "#ffffff" },
      pl: { label: "PL", bg: "#39457e", fg: "#ffffff" },
      pm: { label: "PL", bg: "#39457e", fg: "#ffffff" },
      r: { label: "R", bg: "#276dc3", fg: "#ffffff" },
      jl: { label: "JL", bg: "#9558b2", fg: "#ffffff" },
      graphql: { label: "GQL", bg: "#e10098", fg: "#ffffff" },
      gql: { label: "GQL", bg: "#e10098", fg: "#ffffff" },
      proto: { label: "PR", bg: "#4285f4", fg: "#ffffff" },
      ipynb: { label: "IP", bg: "#f37726", fg: "#ffffff" },
      csv: { label: "CSV", bg: "#0f9d58", fg: "#ffffff" },
      tsv: { label: "TSV", bg: "#0f9d58", fg: "#ffffff" },
      log: { label: "LOG", bg: "#8d8d8d", fg: "#26221e" },
      diff: { label: "DIF", bg: "#4d7a3a", fg: "#ffffff" },
      patch: { label: "DIF", bg: "#4d7a3a", fg: "#ffffff" },
      dockerfile: { label: "DK", bg: "#2496ed", fg: "#ffffff" },
      makefile: { label: "MK", bg: "#6a9fb5", fg: "#26221e" },
      mk: { label: "MK", bg: "#6a9fb5", fg: "#26221e" },
      cmake: { label: "CM", bg: "#ba1e44", fg: "#ffffff" },
      gradle: { label: "GR", bg: "#02303a", fg: "#ffffff" },
      tex: { label: "TEX", bg: "#008080", fg: "#ffffff" },
      sty: { label: "TEX", bg: "#008080", fg: "#ffffff" },
      bat: { label: "BAT", bg: "#3d3d3d", fg: "#ffffff" },
      cmd: { label: "CMD", bg: "#3d3d3d", fg: "#ffffff" },
      doc: { label: "W", bg: "#2b579a", fg: "#ffffff" },
      docx: { label: "W", bg: "#2b579a", fg: "#ffffff" },
      xls: { label: "X", bg: "#217346", fg: "#ffffff" },
      xlsx: { label: "X", bg: "#217346", fg: "#ffffff" },
      xlsm: { label: "X", bg: "#217346", fg: "#ffffff" },
      ppt: { label: "P", bg: "#d24726", fg: "#ffffff" },
      pptx: { label: "P", bg: "#d24726", fg: "#ffffff" },
      zip: { label: "ZIP", bg: "#b98a3f", fg: "#26221e" },
      tar: { label: "TAR", bg: "#b98a3f", fg: "#26221e" },
      gz: { label: "GZ", bg: "#b98a3f", fg: "#26221e" },
      bz2: { label: "BZ", bg: "#b98a3f", fg: "#26221e" },
      xz: { label: "XZ", bg: "#b98a3f", fg: "#26221e" },
      "7z": { label: "7Z", bg: "#b98a3f", fg: "#26221e" },
      rar: { label: "RAR", bg: "#b98a3f", fg: "#26221e" },
      jar: { label: "JAR", bg: "#e76f00", fg: "#ffffff" },
      war: { label: "WAR", bg: "#e76f00", fg: "#ffffff" },
      apk: { label: "APK", bg: "#3ddc84", fg: "#1b4423" },
      aab: { label: "AAB", bg: "#3ddc84", fg: "#1b4423" },
      wasm: { label: "WA", bg: "#654ff0", fg: "#ffffff" },
      ttf: { label: "TTF", bg: "#5c6bc0", fg: "#ffffff" },
      otf: { label: "OTF", bg: "#5c6bc0", fg: "#ffffff" },
      woff: { label: "WOFF", bg: "#5c6bc0", fg: "#ffffff" },
      woff2: { label: "W2", bg: "#5c6bc0", fg: "#ffffff" },
      dylib: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
      so: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
      dll: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
      exe: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
      bin: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
      gitignore: { label: "GI", bg: "#f05033", fg: "#ffffff" },
      gitattributes: { label: "GA", bg: "#f05033", fg: "#ffffff" },
      editorconfig: { label: "EC", bg: "#6d8086", fg: "#ffffff" },
      npmrc: { label: "NR", bg: "#cb3837", fg: "#ffffff" },
      nvmrc: { label: "NV", bg: "#43853d", fg: "#ffffff" },
      babelrc: { label: "BA", bg: "#f5da55", fg: "#3b3106" },
      prettierrc: { label: "PT", bg: "#56b3b4", fg: "#ffffff" },
      eslintrc: { label: "ES", bg: "#4b32c3", fg: "#ffffff" },
      cfg: { label: "CFG", bg: "#8d8d8d", fg: "#26221e" },
      conf: { label: "CONF", bg: "#8d8d8d", fg: "#26221e" },
      properties: { label: "PRO", bg: "#8d8d8d", fg: "#26221e" },
      plist: { label: "PLS", bg: "#8d8d8d", fg: "#26221e" }
    };
    IMAGE_EXTS = /* @__PURE__ */ new Set([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "avif",
      "heic"
    ]);
    AUDIO_EXTS = /* @__PURE__ */ new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);
    VIDEO_EXTS = /* @__PURE__ */ new Set(["mp4", "mov", "webm", "mkv", "avi"]);
    DOC_EXTS = /* @__PURE__ */ new Set([
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "xlsm",
      "csv"
    ]);
    WEB_HREF_RE = /^(?:https?|mailto|tel):/i;
    WHITELIST_EXTRA = /* @__PURE__ */ new Set([
      "gitignore",
      "gitattributes",
      "editorconfig",
      "npmrc",
      "nvmrc",
      "babelrc",
      "prettierrc",
      "eslintrc",
      "dockerfile",
      "makefile",
      "cmake",
      "gradle",
      "ipynb",
      "proto",
      "graphql",
      "gql",
      "vue",
      "svelte",
      "astro",
      "dart",
      "ex",
      "exs",
      "erl",
      "hs",
      "clj",
      "cljs",
      "fs",
      "fsi",
      "vb",
      "pl",
      "pm",
      "r",
      "jl",
      "tcl",
      "bat",
      "cmd",
      "mk",
      "patch",
      "diff",
      "log",
      "csv",
      "tsv",
      "rst",
      "adoc",
      "tex",
      "sty",
      "cfg",
      "conf",
      "properties",
      "plist",
      "aab",
      "apk",
      "jar",
      "war",
      "dylib",
      "so",
      "dll",
      "exe",
      "bin",
      "wasm",
      "zip",
      "tar",
      "gz",
      "bz2",
      "xz",
      "7z",
      "rar",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "xlsm",
      "ppt",
      "pptx",
      "ttf",
      "otf",
      "woff",
      "woff2"
    ]);
    BARE_NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
    DIR_TOKEN_RE = /^(?:[A-Za-z0-9_.-]+\/)+$/;
  }
});

// src/lib/nvimTerminals.ts
function resolveNvimTerminal(_v) {
  return DEFAULT_NVIM_TERMINAL;
}
function shellLabel(shell2) {
  const s = shell2.trim();
  return s ? s : "System default ($SHELL)";
}
var DEFAULT_NVIM_TERMINAL, DEFAULT_TERMINAL_SHELL;
var init_nvimTerminals = __esm({
  "src/lib/nvimTerminals.ts"() {
    "use strict";
    DEFAULT_NVIM_TERMINAL = "inapp";
    DEFAULT_TERMINAL_SHELL = "zsh";
  }
});

// src/lib/xtermTheme.ts
function clampCodeFontSize(raw, fallback) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(24, Math.max(9, Math.round(raw)));
}
function applyTerminalFontSize(px) {
  for (const s of liveScreens) {
    s.term.options.fontSize = px;
    s.refit();
  }
}
var DEFAULT_VIEWER_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE, liveScreens;
var init_xtermTheme = __esm({
  "src/lib/xtermTheme.ts"() {
    "use strict";
    DEFAULT_VIEWER_FONT_SIZE = 14;
    DEFAULT_TERMINAL_FONT_SIZE = 14;
    liveScreens = /* @__PURE__ */ new Set();
  }
});

// src/lib/marketplaceDefaults.ts
function marketSourceKey(m) {
  return `${m.repo}\0${m.path ?? ""}\0${m.git_ref ?? ""}`;
}
function dropRetired(rows) {
  const gone = new Set(RETIRED_MARKETPLACES);
  return rows.filter((m) => {
    if (m.path || m.git_ref) return true;
    return !gone.has(m.repo.trim().toLowerCase());
  });
}
function mergeShippedMarketplaces(rows, shipped, fileVersion, currentVersion) {
  const kept = dropRetired(rows);
  if (fileVersion >= currentVersion) return kept;
  const fresh = dropRetired(shipped);
  const have = new Set(kept.map(marketSourceKey));
  const missing = fresh.filter((m) => !have.has(marketSourceKey(m)));
  return missing.length === 0 ? kept : [...kept, ...missing];
}
var RETIRED_MARKETPLACES;
var init_marketplaceDefaults = __esm({
  "src/lib/marketplaceDefaults.ts"() {
    "use strict";
    RETIRED_MARKETPLACES = ["anthropics/claude-plugins-official"];
  }
});

// src/types/providers.ts
function normalizeRunMode(value) {
  return value === "code" ? "code" : "chat";
}
var init_providers = __esm({
  "src/types/providers.ts"() {
    "use strict";
  }
});

// src/types/mcp.ts
var init_mcp = __esm({
  "src/types/mcp.ts"() {
    "use strict";
  }
});

// src/types/settings.ts
var init_settings = __esm({
  "src/types/settings.ts"() {
    "use strict";
  }
});

// src/types/chat.ts
var init_chat = __esm({
  "src/types/chat.ts"() {
    "use strict";
  }
});

// src/types/trace.ts
var init_trace = __esm({
  "src/types/trace.ts"() {
    "use strict";
  }
});

// src/types/market.ts
var init_market = __esm({
  "src/types/market.ts"() {
    "use strict";
  }
});

// src/types.ts
var init_types = __esm({
  "src/types.ts"() {
    "use strict";
    init_providers();
    init_mcp();
    init_settings();
    init_chat();
    init_trace();
    init_market();
  }
});

// src/lib/fs.ts
function normPath(p) {
  return p.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}
var api;
var init_fs = __esm({
  "src/lib/fs.ts"() {
    "use strict";
    api = {
      getSidecarUrl: () => window.coder.getSidecarUrl(),
      probeSidecar: () => window.coder.probeSidecar(),
      getEnv: (key) => window.coder.getEnv(key),
      googleSignIn: (clientId, clientSecret, scope) => window.coder.googleSignIn(clientId, clientSecret, scope),
      selectFolder: () => window.coder.selectFolder(),
      saveMediaAs: (path, defaultName, dataUrl) => window.coder.saveMediaAs?.(path, defaultName, dataUrl) ?? null,
      selectFile: (startDir) => window.coder.selectFile(startDir),
      importFile: (absPath) => window.coder.importFile(absPath),
      fsList: (root, rel) => window.coder.fsList(root, rel),
      fsWalk: (root) => window.coder.fsWalk(root),
      fsRead: (root, rel) => window.coder.fsRead(root, rel),
      fsWrite: (root, rel, content) => window.coder.fsWrite(root, rel, content),
      fsDelete: (root, rel) => window.coder.fsDelete(root, rel),
      fsCopy: (root, from, to) => window.coder.fsCopy(root, from, to),
      fsRename: (root, from, to) => window.coder.fsRename(root, from, to),
      coderList: (rel) => window.coder.coderList(rel),
      coderRead: (rel) => window.coder.coderRead(rel),
      coderWrite: (rel, content) => window.coder.coderWrite(rel, content),
      coderDelete: (rel) => window.coder.coderDelete(rel),
      searchContent: (root, query) => window.coder.searchContent(root, query),
      readImage: (absPath) => window.coder.readImage(absPath),
      readPdfBase64: (absPath) => window.coder.readPdfBase64(absPath),
      normalizeImage: (absPath) => window.coder.normalizeImage(absPath),
      captureScreen: () => window.coder.captureScreen(),
      computerPermissions: () => window.coder.computerPermissions(),
      requestScreenRecording: () => window.coder.requestScreenRecording(),
      getPathForFile: (file) => window.coder.getPathForFile(file),
      storeGet: (key) => window.coder.storeGet(key),
      storeSet: (key, value) => window.coder.storeSet(key, value),
      chatGet: (id, opts) => window.coder.chatGet(id, opts),
      getDataPath: () => window.coder.getDataPath(),
      hasSettingsFile: () => window.coder.hasSettingsFile(),
      moveDataPath: (p) => window.coder.moveDataPath(p),
      onSidecarChanged: (cb) => window.coder.onSidecarChanged(cb),
      onSidecarDead: (cb) => window.coder.onSidecarDead(cb),
      onFlushPersist: (cb) => window.coder.onFlushPersist(cb),
      flushPersistDone: () => window.coder.flushPersistDone(),
      onMigrateProgress: (cb) => window.coder.onMigrateProgress(cb),
      createBackup: (destDir) => window.coder.createBackup(destDir),
      cancelBackup: () => window.coder.cancelBackup(),
      onBackupProgress: (cb) => window.coder.onBackupProgress(cb),
      backupInfo: (path) => window.coder.backupInfo(path),
      restoreBackup: (path) => window.coder.restoreBackup(path),
      onRestoreProgress: (cb) => window.coder.onRestoreProgress(cb),
      restartApp: () => window.coder.restartApp(),
      openFileExternal: async (absPath, editor) => {
        try {
          const fn = window.coder?.openFileExternal;
          if (typeof fn !== "function") {
            return { ok: false, error: "External open is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
          }
          const res = await fn.call(window.coder, absPath, editor);
          if (res && typeof res.ok === "boolean") return res;
          return { ok: false, error: "External open is unavailable in this environment." };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      openWorkspaceFolder: async (dir) => {
        try {
          const fn = window.coder?.openWorkspaceFolder;
          if (typeof fn !== "function") {
            return { ok: false, error: "Reveal in file manager is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
          }
          const res = await fn.call(window.coder, dir);
          if (res && typeof res.ok === "boolean") return res;
          return { ok: false, error: "Reveal in file manager is unavailable in this environment." };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      openWorkspaceTerminal: async (dir) => {
        try {
          const fn = window.coder?.openWorkspaceTerminal;
          if (typeof fn !== "function") {
            return { ok: false, error: "Terminal open is unavailable (the desktop bridge is outdated \u2014 rebuild the app)." };
          }
          const res = await fn.call(window.coder, dir);
          if (res && typeof res.ok === "boolean") return res;
          return { ok: false, error: "Terminal open is unavailable in this environment." };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    };
  }
});

// src/lib/historyWindow.ts
var init_historyWindow = __esm({
  "src/lib/historyWindow.ts"() {
    "use strict";
  }
});

// src/lib/context.ts
function modelReasoning(provider, model) {
  if (!provider) return null;
  const manual = provider.manualReasoningMap ?? {};
  const directManual = manual[model];
  if (typeof directManual === "boolean") return directManual;
  const prefixedManual = manual[`${provider.id ?? ""}/${model}`];
  if (typeof prefixedManual === "boolean") return prefixedManual;
  const observed = provider.observedReasoningMap ?? {};
  const directObserved = observed[model];
  if (typeof directObserved === "boolean") return directObserved;
  const prefixedObserved = observed[`${provider.id ?? ""}/${model}`];
  if (typeof prefixedObserved === "boolean") return prefixedObserved;
  const map = provider.reasoningMap ?? {};
  const direct = map[model];
  if (typeof direct === "boolean") return direct;
  const prefixed = map[`${provider.id ?? ""}/${model}`];
  return typeof prefixed === "boolean" ? prefixed : null;
}
var PERSIAN_CHAR;
var init_context = __esm({
  "src/lib/context.ts"() {
    "use strict";
    init_bidi();
    init_historyWindow();
    PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
  }
});

// src/lib/retry.ts
var init_retry = __esm({
  "src/lib/retry.ts"() {
    "use strict";
  }
});

// src/lib/stt.ts
var init_stt = __esm({
  "src/lib/stt.ts"() {
    "use strict";
    init_bidi();
  }
});

// src/lib/api.ts
async function isSidecarAlive(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
function peekSidecarUrl() {
  return lastSidecarUrl;
}
function noteSidecarUrl(url) {
  lastSidecarUrl = url;
}
async function ensureSidecar() {
  if (sidecarInFlight) return sidecarInFlight;
  const p = (async () => {
    if (sidecarUrl) {
      const probeFresh = Date.now() - sidecarProbedAt < SIDECAR_PROBE_TTL_MS;
      if (probeFresh || await isSidecarAlive(sidecarUrl)) {
        sidecarProbedAt = Date.now();
        noteSidecarUrl(sidecarUrl);
        return sidecarUrl;
      }
      sidecarProbedAt = 0;
      sidecarUrl = null;
    }
    let timer;
    try {
      const url = await Promise.race([
        // The IPC itself can throw when the bridge is missing (a bare browser,
        // a harness without the preload) — and it throws SYNCHRONOUSLY, so a
        // bare `.catch()` would never attach. Wrapping it in a promise keeps
        // the contract below: this function never rejects, and a missing
        // bridge is just "no backend", which every caller already handles.
        Promise.resolve().then(() => api.getSidecarUrl()).catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), SIDECAR_RESOLVE_TIMEOUT_MS);
        })
      ]);
      if (url) sidecarUrl = url;
      if (sidecarUrl && await isSidecarAlive(sidecarUrl)) {
        sidecarProbedAt = Date.now();
      } else {
        sidecarProbedAt = 0;
      }
      noteSidecarUrl(sidecarUrl);
      return sidecarUrl;
    } finally {
      clearTimeout(timer);
    }
  })();
  sidecarInFlight = p;
  p.finally(() => {
    if (sidecarInFlight === p) sidecarInFlight = null;
  });
  return p;
}
function providerKeys(cfg) {
  const raw = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : [];
  const out = raw.filter((k) => typeof k === "string" && k.trim() !== "");
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "" && !out.includes(cfg.apiKey.trim())) out.push(cfg.apiKey.trim());
  return out;
}
async function speakTextStream(text, opts, onChunk, callerSignal) {
  const url = await ensureSidecar();
  if (!url) throw new Error("the local backend is not ready");
  const body = {
    text,
    provider: opts.kind
  };
  {
    body.base_url = opts.baseUrl;
    if ((opts.model ?? "").trim()) body.model = (opts.model ?? "").trim();
    if ((opts.voice ?? "").trim()) body.voice = (opts.voice ?? "").trim();
    const speakKeys = (opts.apiKeys ?? []).filter((k) => typeof k === "string" && k);
    if (speakKeys.length > 0) body.api_keys = JSON.stringify(speakKeys);
  }
  const timeoutSignal = AbortSignal.timeout(12e4);
  const anyFn = AbortSignal.any;
  const signal = callerSignal && typeof anyFn === "function" ? anyFn([callerSignal, timeoutSignal]) : callerSignal ?? timeoutSignal;
  const post = async (base2) => {
    const chunks = [];
    let first = true;
    await postTtsChunks(base2, body, signal, (chunk) => {
      chunks.push(chunk);
      try {
        onChunk?.(chunk, first);
      } finally {
        first = false;
      }
    });
    const firstType = chunks.length > 0 && chunks[0] instanceof Blob ? chunks[0].type : "";
    return new Blob(chunks, { type: firstType || "audio/mpeg" });
  };
  try {
    return await post(url);
  } catch (err) {
    if (callerSignal?.aborted) throw err;
    if (err instanceof TypeError) {
      sidecarUrl = null;
      const retryUrl = await ensureSidecar();
      if (retryUrl && retryUrl !== url) {
        return await post(retryUrl);
      }
    }
    throw err;
  }
}
async function postTtsChunks(base2, body, signal, onChunk) {
  const res = await fetch(`${base2}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.detail || `speech synthesis failed (${res.status})`
    );
  }
  const contentType = res.headers?.get?.("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
  if (!res.body || typeof res.body.getReader !== "function") {
    const blob = await res.blob();
    onChunk(blob.size > 0 ? blob : new Blob([], { type: contentType }));
    return;
  }
  const reader = res.body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const copy = value.slice().buffer;
        onChunk(new Blob([copy], { type: contentType }));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
function splitTtsSentences(text, maxLen = 160) {
  const clean = (text ?? "").replace(/[^\S\n]+/g, " ").replace(/ *\n+ */g, "\n").trim();
  if (!clean) return [];
  const parts = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = "";
  };
  const chars = Array.from(clean);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      flush();
      continue;
    }
    cur += ch;
    if (ch === "." && /[\p{L}\p{N}]/u.test(chars[i + 1] ?? "")) continue;
    if (SENTENCE_END_RE.test(ch) || ch === "\u060C" && cur.trim().length >= COMMA_SPLIT_MIN_CHARS) {
      flush();
    }
  }
  flush();
  const sentences = parts.length > 0 ? parts : [clean];
  const out = [];
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    const words = s.split(" ");
    let cur2 = "";
    for (const w of words) {
      const next = cur2 ? `${cur2} ${w}` : w;
      if (next.length > maxLen && cur2) {
        out.push(cur2);
        cur2 = w;
      } else {
        cur2 = next;
      }
    }
    if (cur2) out.push(cur2);
  }
  return out;
}
async function steerChat(chatId, id, prompt, attachments = [], images = [], opts = {}) {
  const url = await ensureSidecar();
  if (!url) return false;
  try {
    const res = await fetch(`${url}/chat/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        id,
        prompt,
        attachments,
        images,
        mcp_servers: opts.mcpServers ?? {},
        skills: opts.skills ?? []
      })
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body.ok !== false;
  } catch {
    return false;
  }
}
async function cancelSteer(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/chat/steer/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, id })
    });
  } catch {
  }
}
async function pushSlotModel(slot, model) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/chat/slot_model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, model })
    });
  } catch {
  }
}
async function requestChatTitle(params) {
  const none = { title: null, usage: null };
  const url = await ensureSidecar();
  if (!url) {
    console.warn("[title] sidecar unreachable \u2014 keeping default chat title");
    return none;
  }
  try {
    const res = await fetch(`${url}/chats/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: params.provider.kind,
        provider_id: params.provider.id,
        api_keys: providerKeys(params.provider),
        base_url: params.provider.baseUrl,
        model: params.provider.model,
        subagent_models: params.subagentModels ?? {},
        subagent_thinking: params.subagentThinking ?? {},
        tool_fallbacks: params.toolFallbacks ?? {},
        providers: params.providers ?? {},
        model_reasoning: params.modelReasoning ?? false,
        text: params.text,
        chat_id: params.chatId ?? ""
      }),
      // Long budget so the whole backend fallback chain fits inside one
      // request: each candidate gets a 30s window (a timed-out candidate and
      // the next one alone already spend 60s), and the chain is the user's own
      // try order — aborting at 90s killed the later rungs mid-flight, so a
      // model that would have answered never got the chance. Fire-and-forget:
      // it never blocks the turn.
      signal: AbortSignal.timeout(3e5)
    });
    if (!res.ok) {
      console.warn(`[title] sidecar answered ${res.status} \u2014 keeping default chat title`);
      return none;
    }
    const data = await res.json().catch(() => ({}));
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) {
      const why = typeof data.error === "string" && data.error.trim() ? ` \u2014 ${data.error}` : "";
      console.warn(`[title] no title reply \u2014 keeping default chat title${why}`);
    } else console.info("[title] got title:", title, (params.chatId ?? "").slice(-6));
    return { title: title || null, usage: data.usage ?? null };
  } catch (err) {
    console.warn("[title] request failed \u2014 keeping default chat title", err);
    return none;
  }
}
async function respondAsk(id, answer) {
  return postAnswer("/ask/respond", { id, answer });
}
async function postAnswer(path, body) {
  const url = await ensureSidecar();
  if (!url) return false;
  try {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1e4)
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function listMcp() {
  const url = await ensureSidecar();
  if (!url) return { mcpServers: {}, builtins: [] };
  try {
    const res = await fetch(`${url}/plugins/mcp`);
    if (!res.ok) return { mcpServers: {}, builtins: [] };
    const data = await res.json();
    const out = {};
    const dirs = {};
    for (const r of data.connectors ?? []) {
      if (!r.name || r.plugin_enabled === false) continue;
      out[r.name] = r.cfg ?? {};
      if (r.dir) dirs[r.name] = r.dir;
    }
    return { mcpServers: out, builtins: [], dirs };
  } catch {
    return { mcpServers: {}, builtins: [] };
  }
}
async function saveMcp(name, cfg) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/plugins/mcp/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cfg })
    });
  } catch {
  }
}
async function deleteMcp(name) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/plugins/mcp/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
  } catch {
  }
}
async function restoreCheckpoint(chatId, seq, root) {
  const url = await ensureSidecar();
  if (!url) return { ok: false, error: "the local backend is not ready" };
  try {
    const res = await fetch(
      `${url}/checkpoints/${encodeURIComponent(chatId)}/${seq}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root })
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.detail || `restore failed (${res.status})` };
    }
    return { ok: true, result: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
var sidecarUrl, sidecarInFlight, SIDECAR_RESOLVE_TIMEOUT_MS, SIDECAR_PROBE_TTL_MS, sidecarProbedAt, lastSidecarUrl, SENTENCE_END_RE, COMMA_SPLIT_MIN_CHARS;
var init_api = __esm({
  "src/lib/api.ts"() {
    "use strict";
    init_fs();
    init_context();
    init_retry();
    init_stt();
    sidecarUrl = null;
    sidecarInFlight = null;
    SIDECAR_RESOLVE_TIMEOUT_MS = 1e4;
    SIDECAR_PROBE_TTL_MS = 2e3;
    sidecarProbedAt = 0;
    api.onSidecarChanged(() => {
      sidecarUrl = null;
      noteSidecarUrl(null);
      sidecarInFlight = null;
      sidecarProbedAt = 0;
    });
    api.onSidecarDead(() => {
      sidecarUrl = null;
      noteSidecarUrl(null);
      sidecarInFlight = null;
      sidecarProbedAt = 0;
    });
    lastSidecarUrl = null;
    SENTENCE_END_RE = /[.!?…؟!]/;
    COMMA_SPLIT_MIN_CHARS = 40;
  }
});

// src/lib/modes.ts
function allModes(_settings) {
  return [...BUILTIN_MODES];
}
function getMode(settings, id) {
  return allModes(settings).find((m) => m.id === id) ?? BUILTIN_MODES.find((m) => m.id === "ask");
}
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "build";
  return id || "ask";
}
var BUILTIN_MODES, BUILTIN_IDS, FALLBACK_MODE;
var init_modes = __esm({
  "src/lib/modes.ts"() {
    "use strict";
    BUILTIN_MODES = [
      {
        id: "ask",
        label: "Ask",
        icon: "chat",
        description: "Mentor mode: short, simple answers in plain words \u2014 which file, which line, what to change. Expands only when you ask for detail. Reads and inspects freely (files, shell, web); never writes.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
      },
      {
        id: "plan",
        label: "Plan",
        icon: "list",
        description: "Plans the work: a short, scannable step list naming the files it touches, for Build mode to execute. Reads and inspects freely; never writes.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
      },
      {
        id: "build",
        label: "Build",
        icon: "code",
        description: "Write and edit code, run commands. Full access to your project \u2014 the edit is the artifact, the reply is a short report of what changed.",
        capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true }
      }
    ];
    BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
    FALLBACK_MODE = BUILTIN_MODES[0];
  }
});

// src/lib/secrets.ts
function getKey() {
  if (!keyPromise) {
    const p = (async () => {
      try {
        const b64 = await window.coder.secretsGetKey();
        if (!b64) return null;
        const raw = Uint8Array.from(atob(b64), (c2) => c2.charCodeAt(0));
        return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      } catch {
        return null;
      }
    })();
    p.then((k) => {
      if (!k) keyPromise = null;
    }).catch(() => {
      keyPromise = null;
    });
    keyPromise = p;
  }
  return keyPromise;
}
function toB64(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function encryptSecret(plain) {
  if (!plain) return "";
  const k = await getKey();
  if (!k) throw new Error("encryption key unavailable \u2014 refusing to store secret in plaintext");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new Uint8Array(enc.encode(plain))));
  return `${PREFIX}${toB64(iv)}.${toB64(ct)}`;
}
async function decryptSecret(val) {
  if (!val || !val.startsWith(PREFIX)) return val;
  const k = await getKey();
  if (!k) return "";
  try {
    const body = val.slice(PREFIX.length);
    const sep = body.indexOf(".");
    const iv = fromB64(body.slice(0, sep));
    const ct = fromB64(body.slice(sep + 1));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct);
    return dec.decode(pt);
  } catch {
    return "";
  }
}
async function encryptKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k) continue;
    out.push(await encryptSecret(k));
  }
  return out;
}
async function decryptKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k) continue;
    const d = await decryptSecret(k);
    if (d) out.push(d);
  }
  return out;
}
async function encryptProvider(p) {
  const out = { ...p };
  out.apiKeys = await encryptKeyList(p.apiKeys);
  out.headers = Array.isArray(p.headers) ? await Promise.all(
    p.headers.map(async (h) => ({ key: h.key, value: await encryptSecret(h.value || "") }))
  ) : [];
  const legacy = p.apiKey;
  if (out.apiKeys.length === 0 && typeof legacy === "string" && legacy) {
    out.apiKeys = [await encryptSecret(legacy)];
  }
  delete out.apiKey;
  return out;
}
async function decryptProvider(p) {
  const out = { ...p };
  out.apiKeys = await decryptKeyList(p.apiKeys);
  out.headers = Array.isArray(p.headers) ? await Promise.all(p.headers.map(async (h) => ({ key: h.key, value: await decryptSecret(h.value || "") }))) : [];
  const legacy = p.apiKey;
  if (out.apiKeys.length === 0 && typeof legacy === "string" && legacy) {
    const d = await decryptSecret(legacy);
    if (d) out.apiKeys = [d];
  }
  delete out.apiKey;
  return out;
}
async function encryptSettings(raw) {
  const providers = Array.isArray(raw.providers) ? await Promise.all(raw.providers.map(encryptProvider)) : raw.providers;
  const searchConsole = raw.searchConsole ? {
    ...raw.searchConsole,
    clientId: await encryptSecret(raw.searchConsole.clientId || ""),
    clientSecret: await encryptSecret(raw.searchConsole.clientSecret || ""),
    refreshToken: await encryptSecret(raw.searchConsole.refreshToken || "")
  } : raw.searchConsole;
  const searchPlugins = Array.isArray(raw.searchPlugins) ? await Promise.all(
    raw.searchPlugins.map(async (p) => ({ ...p, apiKey: await encryptSecret(p.apiKey || "") }))
  ) : raw.searchPlugins;
  return { ...raw, providers, searchConsole, searchPlugins };
}
async function decryptSettings(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const providers = Array.isArray(raw.providers) ? await Promise.all(raw.providers.map(decryptProvider)) : raw.providers;
  const searchConsole = raw.searchConsole ? {
    ...raw.searchConsole,
    clientId: await decryptSecret(raw.searchConsole.clientId || ""),
    clientSecret: await decryptSecret(raw.searchConsole.clientSecret || ""),
    refreshToken: await decryptSecret(raw.searchConsole.refreshToken || "")
  } : raw.searchConsole;
  const searchPlugins = Array.isArray(raw.searchPlugins) ? await Promise.all(
    raw.searchPlugins.map(async (p) => ({ ...p, apiKey: await decryptSecret(p.apiKey || "") }))
  ) : raw.searchPlugins;
  const provider = raw.provider ? await decryptProvider(raw.provider) : raw.provider;
  return { ...raw, providers, searchConsole, searchPlugins, provider };
}
var PREFIX, keyPromise, enc, dec;
var init_secrets = __esm({
  "src/lib/secrets.ts"() {
    "use strict";
    PREFIX = "enc:v1:";
    keyPromise = null;
    enc = new TextEncoder();
    dec = new TextDecoder();
  }
});

// src/lib/provider-meta.ts
function providerMeta(kind) {
  return PROVIDER_META[kind ?? "custom"] ?? PROVIDER_META.custom;
}
function accountScopedBaseUrl(kind, accountId) {
  const template = providerMeta(kind).accountScopedBaseUrl;
  if (!template) return void 0;
  const id = accountIdFromBase(accountId).trim() || (accountId ?? "").trim();
  if (!id || /[/\\?&#{}\s]/.test(id)) return "";
  return template.replace("{account}", id);
}
function accountIdFromBase(url) {
  const raw = (url ?? "").trim();
  const at = raw.toLowerCase().indexOf("/accounts/");
  if (at < 0) return "";
  const seg = raw.slice(at + "/accounts/".length).split(/[/?#]/)[0].trim();
  return seg.includes("{") ? "" : seg;
}
var PROVIDER_META, FOREIGN_PROVIDER_PREFIXES;
var init_provider_meta = __esm({
  "src/lib/provider-meta.ts"() {
    "use strict";
    PROVIDER_META = {
      openrouter: {
        kind: "openrouter",
        label: "OpenRouter",
        name: "OpenRouter",
        requiresKey: true,
        builtin: true,
        baseUrlHint: "https://openrouter.ai/api/v1",
        defaultBaseUrl: "https://openrouter.ai/api/v1"
      },
      google: {
        kind: "google",
        label: "Google",
        name: "Google",
        requiresKey: true,
        builtin: true,
        baseUrlHint: "https://generativelanguage.googleapis.com/v1beta/openai",
        baseUrlDesc: "Gemini models via Google.",
        defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
      },
      nvidia: {
        kind: "nvidia",
        label: "NVIDIA",
        name: "NVIDIA",
        requiresKey: true,
        builtin: true,
        baseUrlHint: "https://integrate.api.nvidia.com/v1",
        baseUrlDesc: "NVIDIA NIM hosted models.",
        defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
      },
      cloudflare: {
        kind: "cloudflare",
        label: "Cloudflare",
        name: "Cloudflare",
        requiresKey: true,
        builtin: true,
        // The catalog and the chat endpoint are both account-scoped, so the account
        // id has to come from the user. It has its OWN field (`accountId`) and the
        // base URL is built from this template — the row used to carry a read-only
        // hint holding the literal template, which no user could ever fill in, so
        // every request died on "missing account id".
        accountScopedBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
        accountIdHint: "Cloudflare dashboard \u2192 Workers & Pages \u2192 Account ID. The endpoint is built from it.",
        baseUrlDesc: "Workers AI.",
        extraHint: "The token needs Workers AI read access."
      },
      ollama: {
        kind: "ollama",
        label: "local",
        name: "local",
        requiresKey: false,
        builtin: true,
        local: true,
        editableBaseUrl: true
      },
      custom: {
        kind: "custom",
        label: "Custom API",
        name: "Custom API",
        requiresKey: false,
        builtin: false,
        editableBaseUrl: true,
        manualContextInput: true
      },
      anthropic: {
        kind: "anthropic",
        label: "Anthropic-compatible",
        name: "Anthropic",
        requiresKey: true,
        builtin: false,
        editableBaseUrl: true,
        baseUrlHint: "https://api.anthropic.com",
        baseUrlDesc: "Native Anthropic protocol (/v1/messages, x-api-key). Works with any Anthropic-compatible gateway."
      }
    };
    FOREIGN_PROVIDER_PREFIXES = /* @__PURE__ */ new Set([
      ...Object.keys(PROVIDER_META),
      "opencode"
    ]);
  }
});

// src/lib/themes.ts
var DEFAULT_THEME;
var init_themes = __esm({
  "src/lib/themes.ts"() {
    "use strict";
    DEFAULT_THEME = "codex";
  }
});

// src/lib/usage.ts
function normalizeUsageEntry(raw, chatProviderId, providerIds = []) {
  if (!raw || typeof raw !== "object") return void 0;
  if (Array.isArray(raw.entries)) {
    return raw;
  }
  const legacy = raw;
  const entries = [];
  for (const [key, v] of Object.entries(legacy)) {
    if (!v || typeof v !== "object") continue;
    const slash = key.indexOf("/");
    let providerId = chatProviderId;
    let model = key;
    if (slash > 0) {
      const prefix = key.slice(0, slash);
      if (prefix === chatProviderId) {
        model = key.slice(slash + 1);
      }
    }
    entries.push({
      providerId,
      model: normalizeUsageModel(providerId, model),
      input: v.input ?? 0,
      output: v.output ?? 0,
      cacheRead: v.cacheRead ?? 0,
      cacheWrite: v.cacheWrite ?? 0,
      lastUsed: v.lastUsed
    });
  }
  return { entries };
}
function normalizeUsageModel(providerId, model) {
  const m = (model || "").trim() || "main";
  if (m.includes("/")) {
    const prefix = m.slice(0, m.indexOf("/"));
    if (prefix === providerId) return m.slice(m.indexOf("/") + 1);
  }
  return m;
}
var init_usage = __esm({
  "src/lib/usage.ts"() {
    "use strict";
  }
});

// src/lib/thinking.ts
function supportsReasoning(modelId, kind = "openrouter", reasoning) {
  const id = (modelId || "").trim();
  if (!id) return false;
  if (typeof reasoning === "boolean") return reasoning;
  return REASONING_PATTERNS.some((re) => re.test(id));
}
var REASONING_PATTERNS;
var init_thinking = __esm({
  "src/lib/thinking.ts"() {
    "use strict";
    REASONING_PATTERNS = [
      /\b(qwen3|qwq)\b/i,
      /deepseek[-_.]?(r1|v4|v3\.1)\b/i,
      /\b(o1|o3|o4)([-._-]|$)/i,
      /\bgpt[-_.]?5/i,
      /\breason(er|ing)?\b/i,
      /\bthinking\b/i,
      /glm[-_.]?4\.(5|6)/i,
      /kimi[-_.]?k2[-_.]?thinking/i,
      /\bturbo[-_.]?reasoning/i,
      /\bexp\b.*\breason/i
    ];
  }
});

// src/lib/toolSlots.ts
function toolFallbackEntries(map) {
  const out = {};
  if (!map) return out;
  for (const slot of TOOL_FALLBACK_SLOTS) {
    const list = (map[slot] ?? []).map((r) => {
      const pid = r.providerId.trim();
      const model = r.model.trim();
      if (!pid && !model) return MAIN_MODEL_ENTRY;
      return `${pid}/${model}`;
    }).filter((entry) => !entry.startsWith("/") && !entry.endsWith("/"));
    if (list.length) out[slot] = list;
  }
  return out;
}
function isMainModelEntry(entry) {
  return MAIN_MODEL_ENTRIES.has((entry ?? "").trim().toLowerCase());
}
function otherSlotModel(models) {
  for (const key of OTHER_SLOTS) {
    const v = (models?.[key] ?? "").trim();
    if (!isMainModelEntry(v)) return v;
  }
  return "";
}
function withOtherSlotsFilled(models) {
  const out = { ...models ?? {} };
  const group = otherSlotModel(out);
  if (!group) return out;
  for (const key of OTHER_SLOTS) {
    if (isMainModelEntry(out[key])) out[key] = group;
  }
  return out;
}
var OTHER_SLOTS, TOOL_FALLBACK_SLOTS, MAIN_MODEL_ENTRY, MAIN_MODEL_ENTRIES;
var init_toolSlots = __esm({
  "src/lib/toolSlots.ts"() {
    "use strict";
    OTHER_SLOTS = ["compact", "web", "title"];
    TOOL_FALLBACK_SLOTS = ["explore", "vision", "schedule", ...OTHER_SLOTS];
    MAIN_MODEL_ENTRY = "main model";
    MAIN_MODEL_ENTRIES = /* @__PURE__ */ new Set(["", "main", "main_model", "main model"]);
  }
});

// src/lib/mcpTools.ts
function bareToolName(tool) {
  if (!tool.startsWith("mcp__")) return tool;
  const rest = tool.slice(5);
  const i = rest.indexOf("__");
  return i > 0 ? rest.slice(i + 2) : tool;
}
function mcpServerOf(tool) {
  if (!tool.startsWith("mcp__")) return "";
  const rest = tool.slice(5);
  const i = rest.indexOf("__");
  return i > 0 ? rest.slice(0, i) : "";
}
var init_mcpTools = __esm({
  "src/lib/mcpTools.ts"() {
    "use strict";
  }
});

// src/lib/subagents.ts
function isDelegationTool(tool) {
  return tool === "explore" || tool.startsWith(DELEGATION_PREFIX);
}
function subagentIdOf(tool) {
  return tool.startsWith(DELEGATION_PREFIX) ? tool.slice(DELEGATION_PREFIX.length).trim() : "";
}
var DELEGATION_PREFIX;
var init_subagents = __esm({
  "src/lib/subagents.ts"() {
    "use strict";
    DELEGATION_PREFIX = "agent__";
  }
});

// src/lib/toolActivity.ts
function editTargetOf(args) {
  return editTargetsOf(args)[0] ?? "";
}
function editTargetsOf(args) {
  const out = [];
  const push = (p) => {
    if (typeof p === "string" && p.trim() && !out.includes(p)) out.push(p);
  };
  push(args?.path ?? args?.filePath);
  for (const key of ["edits", "files"]) {
    const items = args?.[key];
    if (!Array.isArray(items)) continue;
    for (const e of items) push(e?.path);
  }
  return out;
}
function diffStatsFromUnified(diff2) {
  let adds = 0;
  let dels = 0;
  for (const line of diff2.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
}
function normalizeToolName(tool) {
  const t = tool ?? "tool";
  return t === "task" || t === "subagent" ? "explore" : t;
}
function isSkillTool(tool) {
  const t = (tool ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
  return t === "load_plugin" || t === "load_skill" || t === "skill" || t === "load_skill_file";
}
function normalizeToolActivity(acts) {
  return acts.map((a) => {
    const out = a.tool === "explore" ? a : { ...a, tool: normalizeToolName(a.tool) };
    if (Array.isArray(out.children)) out.children = normalizeToolActivity(out.children);
    return out;
  });
}
function latestNarrationLine(activity) {
  const lines = (activity.narration ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}
function terminalOutputText(items) {
  if (!Array.isArray(items)) return "";
  const parts = [];
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const value = row.content ?? row.snippet ?? row.text ?? row.title ?? row.url ?? row.path ?? row.file;
    if (value !== void 0 && value !== null && String(value) !== "") {
      parts.push(String(value));
    }
  }
  return parts.join("\n");
}
var MEMORY_TOOLS;
var init_toolActivity = __esm({
  "src/lib/toolActivity.ts"() {
    "use strict";
    init_mcpTools();
    init_subagents();
    MEMORY_TOOLS = /* @__PURE__ */ new Set([
      "search_memory",
      "save_memory",
      "delete_memory"
    ]);
  }
});

// src/lib/chatFocus.ts
function composerFor(chatId) {
  if (!chatId || typeof document === "undefined") return null;
  try {
    const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(chatId) : chatId.replace(/["\\]/g, "");
    return document.querySelector(
      `[data-chat-window="${esc}"] textarea.composer-input, [data-chat-id="${esc}"] textarea.composer-input`
    );
  } catch {
    return null;
  }
}
function focusChatInput(chatId) {
  if (!chatId || typeof document === "undefined") return false;
  const el = composerFor(chatId);
  if (el) {
    el.focus({ preventScroll: true });
    return true;
  }
  try {
    const fallback = document.querySelector(
      ".chat-window.focused textarea.composer-input"
    );
    if (fallback) {
      fallback.focus({ preventScroll: true });
      return true;
    }
  } catch {
  }
  return false;
}
function focusChatInputSoon(chatId, frames = 12) {
  if (!chatId || typeof document === "undefined") return;
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    const el = composerFor(chatId);
    if (el) {
      el.focus({ preventScroll: true });
      return;
    }
    if (frames > 0) focusChatInputSoon(chatId, frames - 1);
  });
}
var init_chatFocus = __esm({
  "src/lib/chatFocus.ts"() {
    "use strict";
  }
});

// src/lib/store/data.ts
function capCompactedMessages(messages) {
  let overflow = 0;
  for (const m of messages) if (m.compacted) overflow++;
  if (overflow <= MAX_COMPACTED_PER_CHAT) return messages;
  overflow -= MAX_COMPACTED_PER_CHAT;
  const out = [];
  for (const m of messages) {
    if (m.compacted && overflow > 0) {
      overflow--;
      continue;
    }
    out.push(m);
  }
  return out;
}
function forkSeedLine(m) {
  const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Context";
  const flat = m.content.replace(/\s+/g, " ").trim();
  const body = flat.length > FORK_SEED_CHARS_PER_MESSAGE ? `${flat.slice(0, FORK_SEED_CHARS_PER_MESSAGE).trimEnd()}\u2026` : flat;
  return `${who}: ${body}`;
}
function forkSeedMessage(src, forkIndex) {
  const upto = src.messages.slice(0, forkIndex + 1).filter((m) => !m.compacted && !m.modeSwitch);
  const lines = [];
  let budget = FORK_SEED_MAX_CHARS;
  for (let i = upto.length - 1; i >= 0; i--) {
    const line = forkSeedLine(upto[i]);
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.unshift(line);
  }
  const body = lines.join("\n");
  const header = src.title && src.title !== "New chat" ? src.title : "Forked conversation";
  return {
    id: uid(),
    role: "system",
    content: `[Forked from \xAB${header}\xBB \u2014 compacted context up to the fork point]
` + (body || "(no earlier context)") + "\n[End of forked context \u2014 continue from here.]",
    // Deliberately NOT `compacted`: that flag means "folded into a summary, so
    // keep it OFF the wire" (isWireHistoryMessage), and this seed IS the wire
    // context the fork runs on. As a plain `system` message it travels like any
    // other system turn, and the send path sorts it to the FRONT of the history
    // — so the model reads it before the user's first new message.
    createdAt: Date.now()
  };
}
function lspStatusLabel(status) {
  if (!status) return null;
  if (status.phase === "done" || status.phase === "error") return null;
  const lang = (status.language ?? "").trim();
  const suffix = lang ? ` ${lang}` : "";
  if (status.phase === "updating") return `\u062F\u0631 \u062D\u0627\u0644 \u0622\u067E\u062F\u06CC\u062A LSP${suffix}...`;
  return `\u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628 LSP${suffix}...`;
}
var uid, MAX_COMPACTED_PER_CHAT, FORK_SEED_CHARS_PER_MESSAGE, FORK_SEED_MAX_CHARS;
var init_data = __esm({
  "src/lib/store/data.ts"() {
    "use strict";
    uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    MAX_COMPACTED_PER_CHAT = 50;
    FORK_SEED_CHARS_PER_MESSAGE = 600;
    FORK_SEED_MAX_CHARS = 4e3;
  }
});

// src/lib/store/sanitize.ts
function trimPersistImageValue(v) {
  if (typeof v === "string") {
    if (v.length > MAX_PERSIST_IMAGE_CHARS && v.slice(0, 80).includes("base64")) {
      return v.slice(0, MAX_PERSIST_IMAGE_CHARS) + "\u2026";
    }
    return v;
  }
  if (v && typeof v === "object") {
    const o = v;
    for (const k of ["data", "dataUrl", "url", "content"]) {
      const s = o[k];
      if (typeof s === "string" && s.length > MAX_PERSIST_IMAGE_CHARS && (s.startsWith("data:") || s.slice(0, 80).includes("base64"))) {
        return { ...o, [k]: s.slice(0, MAX_PERSIST_IMAGE_CHARS) + "\u2026" };
      }
    }
  }
  return v;
}
function trimToolActivity(acts) {
  return acts.map((a) => {
    const out = { ...a };
    if (typeof out.summary === "string" && out.summary.length > MAX_TOOL_TEXT) {
      out.summary = out.summary.slice(0, MAX_TOOL_TEXT) + "\u2026";
    }
    if (typeof out.diff === "string" && out.diff.length > MAX_TOOL_TEXT) {
      out.diff = out.diff.slice(0, MAX_TOOL_TEXT) + "\u2026";
    }
    if (out.args && typeof out.args === "object") {
      const args = {};
      for (const [k, v] of Object.entries(out.args)) {
        args[k] = typeof v === "string" && v.length > MAX_TOOL_ARG ? v.slice(0, MAX_TOOL_ARG) + "\u2026" : v;
      }
      out.args = args;
    }
    if (Array.isArray(out.children)) out.children = trimToolActivity(out.children);
    return out;
  });
}
function dedupeByKind(rows) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    out.push(r);
  }
  return out;
}
function migrateModePrompts(prompts) {
  const out = { ...prompts };
  if ("chat" in out && !("ask" in out)) {
    out.ask = out.chat;
    delete out.chat;
  }
  if ("codewriter" in out && !("build" in out)) {
    out.build = out.codewriter;
    delete out.codewriter;
  }
  if ("coder" in out) {
    delete out.coder;
  }
  return out;
}
var MAX_TOOL_TEXT, MAX_TOOL_ARG, MAX_PERSIST_IMAGE_CHARS, MODE_LABELS, SEARCH_PLUGIN_LABELS;
var init_sanitize = __esm({
  "src/lib/store/sanitize.ts"() {
    "use strict";
    MAX_TOOL_TEXT = 4e3;
    MAX_TOOL_ARG = 2e3;
    MAX_PERSIST_IMAGE_CHARS = 1e5;
    MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build" };
    SEARCH_PLUGIN_LABELS = {
      duckduckgo: "DuckDuckGo",
      tavily: "Tavily"
    };
  }
});

// src/lib/store/normalize.ts
function pruneQueued(queued, now = Date.now()) {
  if (!queued || queued.length === 0) return queued;
  const kept = queued.filter((q) => !q.sent || now - (q.createdAt ?? 0) < QUEUED_SENT_GRACE_MS);
  return kept.length === queued.length ? queued : kept;
}
function sanitizeChats(chats) {
  const out = [];
  const now = Date.now();
  for (const original of chats) {
    const pruned = pruneQueued(original.queued, now);
    const c2 = pruned === original.queued ? original : { ...original, queued: pruned };
    const hasBody = Array.isArray(c2.messages) && c2.messages.length > 0;
    if (c2.hydrated === false || (c2.bodyStart ?? 0) > 0) {
      const {
        messages: _omitted,
        hydrated: _h,
        bodyStart: _bs,
        bodyTotal: _bt,
        ...meta
      } = c2;
      out.push(meta);
      continue;
    }
    if (!hasBody) continue;
    if (c2.pendingFirstMessage && !c2.messages.some((m) => m.role === "user")) continue;
    const clean = { ...c2 };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
    delete clean.bodyStart;
    delete clean.bodyTotal;
    out.push({
      ...clean,
      messages: capCompactedMessages(c2.messages.map((m) => {
        const msg = { ...m };
        delete msg.retry;
        if (msg.streaming) msg.interrupted = true;
        delete msg.streaming;
        delete msg.thinking;
        delete msg.lspStatus;
        if (Array.isArray(msg.toolActivity)) {
          msg.toolActivity = trimToolActivity(msg.toolActivity);
        }
        if (Array.isArray(msg.images)) {
          msg.images = msg.images.map(trimPersistImageValue);
        }
        return msg;
      }))
    });
  }
  return out;
}
var QUEUED_SENT_GRACE_MS;
var init_normalize = __esm({
  "src/lib/store/normalize.ts"() {
    "use strict";
    init_data();
    init_sanitize();
    QUEUED_SENT_GRACE_MS = 10 * 60 * 1e3;
  }
});

// src/lib/tabOrder.ts
var init_tabOrder = __esm({
  "src/lib/tabOrder.ts"() {
    "use strict";
  }
});

// src/lib/tabBar.ts
var init_tabBar = __esm({
  "src/lib/tabBar.ts"() {
    "use strict";
    init_tabOrder();
  }
});

// src/lib/useDragReorder.ts
import { useCallback, useEffect, useRef, useState } from "react";
function moveAt(list, from, insertAt) {
  if (from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [row] = next.splice(from, 1);
  next.splice(from < insertAt ? insertAt - 1 : insertAt, 0, row);
  return next;
}
var init_useDragReorder = __esm({
  "src/lib/useDragReorder.ts"() {
    "use strict";
    init_tabBar();
  }
});

// src/lib/store/markets.ts
var ANTROPIC_SKILLS_MARKETPLACE, COMMUNITY_MARKETPLACE, SUPERPOWERS_MARKETPLACE, AGENTS_MARKETPLACE, DEFAULT_MARKETPLACES, MARKETPLACE_DEFAULTS_VERSION;
var init_markets = __esm({
  "src/lib/store/markets.ts"() {
    "use strict";
    ANTROPIC_SKILLS_MARKETPLACE = {
      repo: "anthropics/skills",
      label: "Anthropic skills",
      kind: "skills"
    };
    COMMUNITY_MARKETPLACE = {
      repo: "anthropics/claude-plugins-community",
      label: "Community",
      kind: "mcp"
    };
    SUPERPOWERS_MARKETPLACE = {
      repo: "obra/superpowers-marketplace",
      label: "Superpowers",
      kind: "plugins"
    };
    AGENTS_MARKETPLACE = {
      repo: "wshobson/agents",
      label: "Claude agents",
      kind: "skills"
    };
    DEFAULT_MARKETPLACES = [
      ANTROPIC_SKILLS_MARKETPLACE,
      COMMUNITY_MARKETPLACE,
      SUPERPOWERS_MARKETPLACE,
      AGENTS_MARKETPLACE
    ];
    MARKETPLACE_DEFAULTS_VERSION = 5;
  }
});

// src/lib/store/chats.ts
function dedupeChats(chats) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = chats.length - 1; i >= 0; i--) {
    const c2 = chats[i];
    if (!c2?.id || seen.has(c2.id)) continue;
    seen.add(c2.id);
    out.push(c2);
  }
  out.reverse();
  return out;
}
function selectLoadedChats(prev, incoming, opts) {
  const fresh = incoming && incoming.length > 0 ? incoming : [];
  if (fresh.length === 0 && prev.length > 0) {
    if (opts.settingsMissing && opts.hasSettingsFile) {
      return { chats: prev, kept: true, emptyMiss: true };
    }
    if (!opts.settingsMissing) {
      return { chats: prev, kept: true, emptyMiss: false };
    }
    return { chats: [], kept: false, emptyMiss: false };
  }
  return { chats: fresh, kept: false, emptyMiss: false };
}
var init_chats = __esm({
  "src/lib/store/chats.ts"() {
    "use strict";
  }
});

// src/lib/chatTree.ts
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clampSize(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}
function makeLeaf(chatId, size = 1, id) {
  return { kind: "leaf", id: id ?? nid("leaf"), chatId, size: clampSize(size) };
}
function makeSplit(dir, children, size = 1, id) {
  return { kind: "split", id: id ?? nid("split"), dir, size: clampSize(size), children };
}
function dirForPos(pos) {
  if (pos === "left" || pos === "right") return "row";
  if (pos === "top" || pos === "bottom") return "col";
  return null;
}
function beforePos(pos) {
  return pos === "left" || pos === "top";
}
function bestSplitDir(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "row";
  return width >= height ? "row" : "col";
}
function collectChatIds(node) {
  if (!node) return [];
  if (node.kind === "leaf") return [node.chatId];
  const out = [];
  for (const c2 of node.children) out.push(...collectChatIds(c2));
  return out;
}
function leafCount(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce((n, c2) => n + leafCount(c2), 0);
}
function containsChat(node, chatId) {
  if (!node) return false;
  if (node.kind === "leaf") return node.chatId === chatId;
  return node.children.some((c2) => containsChat(c2, chatId));
}
function findLeafByChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? node : null;
  for (const c2 of node.children) {
    const hit = findLeafByChat(c2, chatId);
    if (hit) return hit;
  }
  return null;
}
function findParent(node, childId) {
  if (!node || node.kind !== "split") return null;
  for (const c2 of node.children) {
    if (c2.id === childId) return node;
    if (c2.kind === "split") {
      const hit = findParent(c2, childId);
      if (hit) return hit;
    }
  }
  return null;
}
function removeChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? null : node;
  const children = [];
  let changed = false;
  for (const c2 of node.children) {
    const next = removeChat(c2, chatId);
    if (next) children.push(next);
    if (next !== c2) changed = true;
  }
  if (!changed) return node;
  if (children.length === 0) return null;
  return { ...node, children };
}
function swapChats(node, a, b) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (node.chatId === a) return { ...node, chatId: b };
    if (node.chatId === b) return { ...node, chatId: a };
    return node;
  }
  let changed = false;
  const children = node.children.map((c2) => {
    const next = swapChats(c2, a, b) ?? c2;
    if (next !== c2) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function replaceChat(node, targetChatId, nextChatId) {
  if (node.kind === "leaf") {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node;
  }
  let changed = false;
  const children = node.children.map((c2) => {
    const next = replaceChat(c2, targetChatId, nextChatId);
    if (next !== c2) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function normalizeTree(node, validIds, seen = /* @__PURE__ */ new Set()) {
  if (!node) return null;
  if (node.kind === "leaf") {
    if (!validIds.has(node.chatId) || seen.has(node.chatId)) return null;
    seen.add(node.chatId);
    const size = clampSize(node.size);
    return size === node.size ? node : { ...node, size };
  }
  const children = [];
  let changed = false;
  for (const c2 of node.children) {
    const next = normalizeTree(c2, validIds, seen);
    if (next) children.push(next);
    if (next !== c2) changed = true;
  }
  if (children.length === 0) return null;
  if (children.length === 1 && children[0].size !== 1) {
    children[0] = { ...children[0], size: 1 };
    changed = true;
  }
  if (!changed) return node;
  return { ...node, children };
}
function buildFromList(ids, dir, sizes) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return null;
  if (clean.length === 1) return makeLeaf(clean[0], sizes?.[clean[0]] ?? 1);
  return makeSplit(
    dir,
    clean.map((chatId) => makeLeaf(chatId, sizes?.[chatId] ?? 1))
  );
}
function appendChat(node, chatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  if (leafCount(node) >= CHAT_WINDOW_MAX) return node;
  if (node.kind === "leaf") {
    return makeSplit(dir, [node, makeLeaf(chatId)]);
  }
  return { ...node, children: [...node.children, makeLeaf(chatId)] };
}
function openBeside(node, chatId, targetChatId, dir) {
  if (!node) return makeLeaf(chatId);
  if (containsChat(node, chatId)) return node;
  const fresh = makeLeaf(chatId);
  if (node.kind === "leaf") return makeSplit(dir, [node, fresh]);
  const target = findLeafByChat(node, targetChatId);
  if (!target) {
    if (node.dir === dir) return { ...node, children: [...node.children, fresh] };
    return makeSplit(dir, [node, fresh]);
  }
  const parent = findParent(node, target.id);
  if (parent && parent.dir === dir) {
    const idx = parent.children.findIndex((c2) => c2.id === target.id);
    const children = parent.children.slice();
    children.splice(idx + 1, 0, fresh);
    return replaceNode(node, parent.id, { ...parent, children });
  }
  return replaceNode(node, target.id, makeSplit(dir, [{ ...target }, fresh]));
}
function dropOnto(root, dragChatId, targetChatId, pos) {
  if (!dragChatId || !targetChatId) return root;
  if (dragChatId === targetChatId) return root;
  if (root && !containsChat(root, dragChatId) && leafCount(root) >= CHAT_WINDOW_MAX && pos !== "center") return root;
  if (pos === "center") {
    if (!root) return makeLeaf(dragChatId);
    if (containsChat(root, dragChatId)) return swapChats(root, dragChatId, targetChatId);
    if (!containsChat(root, targetChatId)) return appendChat(root, dragChatId, "col");
    return replaceChat(root, targetChatId, dragChatId);
  }
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const targetLeaf = findLeafByChat(root, targetChatId);
  if (dragLeaf && targetLeaf) {
    const pDrag = findParent(root, dragLeaf.id);
    const pTarget = findParent(root, targetLeaf.id);
    if (pDrag && pTarget && pDrag.id === pTarget.id && pDrag.dir === dirNeeded) {
      const rest = pTarget.children.filter((c2) => c2.id !== dragLeaf.id);
      let dest = rest.findIndex((c2) => c2.id === targetLeaf.id) + (before ? 0 : 1);
      dest = Math.max(0, Math.min(rest.length, dest));
      const reordered = rest.slice();
      reordered.splice(dest, 0, dragLeaf);
      return replaceNode(root, pTarget.id, { ...pTarget, children: reordered });
    }
  }
  const dragSize = dragLeaf?.size ?? 1;
  const base2 = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root;
  if (!base2) return makeLeaf(dragChatId, dragSize);
  const target = findLeafByChat(base2, targetChatId);
  if (!target) return appendChat(base2, dragChatId, dirNeeded);
  const fresh = makeLeaf(dragChatId, dragSize);
  const parent = findParent(base2, target.id);
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c2) => c2.id === target.id);
    const children = parent.children.slice();
    children.splice(before ? idx : idx + 1, 0, fresh);
    return replaceNode(base2, parent.id, { ...parent, children });
  }
  const split = makeSplit(
    dirNeeded,
    before ? [fresh, { ...target }] : [{ ...target }, fresh],
    target.size
  );
  split.children[0].size = 1;
  split.children[1].size = 1;
  return replaceNode(base2, target.id, split);
}
function dropOntoRoot(root, dragChatId, pos) {
  if (!dragChatId) return root;
  const dirNeeded = dirForPos(pos);
  if (!dirNeeded) return root;
  const before = beforePos(pos);
  if (!root) return makeLeaf(dragChatId);
  const dragLeaf = findLeafByChat(root, dragChatId);
  const dragSize = dragLeaf?.size ?? 1;
  if (dragLeaf) {
    if (leafCount(root) <= 1) return root;
    const base2 = removeChat(root, dragChatId);
    if (!base2) return makeLeaf(dragChatId, dragSize);
    const fresh2 = makeLeaf(dragChatId, dragSize);
    if (base2.kind === "split" && base2.dir === dirNeeded) {
      const children = before ? [fresh2, ...base2.children] : [...base2.children, fresh2];
      return { ...base2, children };
    }
    return makeSplit(dirNeeded, before ? [fresh2, base2] : [base2, fresh2]);
  }
  if (leafCount(root) >= CHAT_WINDOW_MAX) return root;
  const fresh = makeLeaf(dragChatId);
  if (root.kind === "split" && root.dir === dirNeeded) {
    const children = before ? [fresh, ...root.children] : [...root.children, fresh];
    return { ...root, children };
  }
  return makeSplit(dirNeeded, before ? [fresh, root] : [root, fresh]);
}
function replaceNode(node, id, next) {
  if (node.id === id) return next;
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c2) => {
    const r = replaceNode(c2, id, next);
    if (r !== c2) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}
function setNodeSize(node, id, size) {
  if (!node) return null;
  if (node.id === id) return { ...node, size: clampSize(size) };
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c2) => {
    const next = setNodeSize(c2, id, size);
    if (next && next !== c2) changed = true;
    return next ?? c2;
  });
  return changed ? { ...node, children } : node;
}
function setChatSize(node, chatId, size) {
  const leaf = findLeafByChat(node, chatId);
  if (!leaf) return node;
  return setNodeSize(node, leaf.id, size);
}
function resizePair(node, parentId, firstId, secondId, firstSize, secondSize) {
  const step = setNodeSize(node, firstId, firstSize);
  return setNodeSize(step, secondId, secondSize);
}
function setRootDir(node, dir) {
  if (!node || node.kind !== "split") return node;
  if (node.dir === dir) return node;
  return { ...node, dir };
}
function sizesByChat(node) {
  const out = {};
  const walk = (n) => {
    if (!n) return;
    if (n.kind === "leaf") out[n.chatId] = clampSize(n.size);
    else n.children.forEach(walk);
  };
  walk(node);
  return out;
}
function loadChatTree() {
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind !== "leaf" && parsed.kind !== "split") return null;
    return parsed;
  } catch {
    return null;
  }
}
function persistChatTree(tree) {
  try {
    if (!tree) localStorage.removeItem(TREE_KEY);
    else localStorage.setItem(TREE_KEY, JSON.stringify(tree));
  } catch {
  }
}
function loadSavedChatTree() {
  try {
    const raw = localStorage.getItem(SAVED_TREE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind !== "leaf" && parsed.kind !== "split") return null;
    return parsed;
  } catch {
    return null;
  }
}
function persistSavedChatTree(tree) {
  try {
    if (!tree) localStorage.removeItem(SAVED_TREE_KEY);
    else localStorage.setItem(SAVED_TREE_KEY, JSON.stringify(tree));
  } catch {
  }
}
function restoreMultiTree(saved, openIds, validIds, activeId, dir) {
  let tree = normalizeTree(saved, validIds);
  if (!tree) tree = buildFromList(openIds.filter((id) => validIds.has(id)), dir);
  if (!tree) return null;
  const wants = activeId && validIds.has(activeId) && !openIds.includes(activeId) ? [...openIds, activeId] : openIds;
  const inTree = new Set(collectChatIds(tree));
  for (const id of wants) {
    if (!validIds.has(id) || inTree.has(id)) continue;
    tree = openBeside(tree, id, activeId, dir);
    inTree.add(id);
  }
  return tree;
}
function toggleFullscreenId(current, target) {
  if (!target) return current;
  return current === target ? null : target;
}
var TREE_KEY, SAVED_TREE_KEY, CHAT_WINDOW_MAX;
var init_chatTree = __esm({
  "src/lib/chatTree.ts"() {
    "use strict";
    TREE_KEY = "coder:chatTree";
    SAVED_TREE_KEY = "coder:chatTreeSaved";
    CHAT_WINDOW_MAX = 6;
  }
});

// src/lib/store.ts
import { create } from "zustand";
function normalizeWorkspaceRunModes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    out[key] = normalizeRunMode(value);
  }
  return out;
}
function normalizeScheduleRunsSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN);
}
function capTitleWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS).join(" ");
}
function coercePositiveInt(v, fallback) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
function coerceNonNegInt(v, fallback) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}
function coerceBoundedInt(v, fallback, min, max) {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return Math.max(min, Math.min(max, r));
}
function normalizeSttFallbacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId) continue;
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    out.push({ providerId, model });
  }
  return out;
}
function normalizeToolFallbackRows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    out.push({ providerId, model });
  }
  return out;
}
function normalizeToolFallbacks(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [slot, list] of Object.entries(raw)) {
    if (!TOOL_FALLBACK_SLOTS.includes(slot)) continue;
    const rows = normalizeToolFallbackRows(list);
    if (rows.length) out[slot] = rows;
  }
  return out;
}
function defaultCustomSubagents() {
  return [
    {
      id: "browser",
      name: "Browser Navigator",
      description: "Drives the real browser: opens pages, reads their rendered content, clicks, types and inspects the page. Use for anything about a live page \u2014 page screenshots and page checks are browser work, not desktop work.",
      prompt: [
        "You are a browser sub-agent. You drive a real browser through the browser tools. You own all page work: navigating, reading rendered content, clicking, typing, scrolling and page screenshots.",
        "",
        "HOW TO WORK",
        "- Start with browser_navigate for a URL. Its result already carries the page summary and fresh refs: read it. Do NOT call browser_snapshot again right after a navigate unless the result has no page data.",
        '- Re-snapshot only when the page changed in a way the last result does not show, or when the refs you need went stale. A plain browser_snapshot on an unchanged page returns a short "unchanged" note, not the page again: trust it and keep the refs you already have. Pass full=true only for a deliberate re-read.',
        "- Complete the WHOLE delegated task in this run, including its verification. Do not stop after a partial step expecting a follow-up call.",
        "- Before an IRREVERSIBLE action (post, publish, send, upload, delete, pay), check the current state and make sure it did not already happen. If a tool call was cut off, verify the result before repeating it.",
        "- Prefer the rendered text you were asked for. Take a screenshot only when the user asked for one or when text and layout cannot answer the question.",
        '- For a list, grid or profile, collect the item URLs with ONE browser_evaluate (for example Array.from(document.querySelectorAll("a")).map(a => a.href)) and navigate directly to the exact URLs you still need. Do not click tiles one by one.',
        "- If browser_evaluate returns null/[] or a value you already had, stop probing that way: use browser_find or the page text, and report what the page exposes. After two empty probes, stop.",
        "- After an action whose result already shows the new page, do not screenshot or snapshot it again just to confirm the change.",
        "",
        "IDENTITY AND ACCOUNT",
        '- The logged-in account is shown ONLY by site navigation or account controls (the Profile link, the avatar menu, "Logged in as ..."). A name on a post, feed card or comment belongs to its AUTHOR, not to the session.',
        "- If the account is not visible in the nav/account controls, say so. Never infer it from a post author or guess it.",
        "",
        "PLUGINS",
        "- Installed plugins are already listed in your catalog. Load one with load_plugin only when the task clearly needs its toolbox; do not load a plugin just because it exists.",
        "- Reading or checking a page is browser work: browser tools are enough. Do not load a plugin merely to read one page.",
        "",
        "BOUNDARIES",
        "- Never use desktop/computer tools: native app windows belong to the desktop agent, not to you.",
        "- If the task needs a native app, report that it must go to the desktop agent instead of trying to do it here.",
        "",
        "FINISH",
        "- Finish with a short factual report: the URLs visited, what you saw, what you did, and what you could not verify. Quote exact text when identity, counts or dates matter. Never invent page content."
      ].join("\n"),
      kind: "browser"
    },
    {
      id: "computer",
      name: "Desktop Operator",
      description: "Controls the machine desktop: native app windows, screenshots, mouse and keyboard. Use only when the work must happen in a real app rather than a page; file creation and export (PPTX/DOCX/XLSX/PDF) is a terminal-script job, and page content and page screenshots belong to the browser agent. Ask it to LOOK and report: it never saves screenshot files or writes folders \u2014 describe the screen, not a path. The user is asked for permission before this agent runs.",
      prompt: [
        "You are a desktop sub-agent. You control the machine with the computer tool.",
        "",
        "- THE DESKTOP IS THE LAST RESORT: use it only for an app that has no usable command line.",
        "- File creation, conversion and export (PPTX/DOCX/XLSX/PDF, a deck or report built from data, converting a document) are NOT desktop work: do them with `run_terminal` in ONE call using python-pptx/python-docx/openpyxl or `soffice --headless`. Never drive PowerPoint/Word/Excel menus for work a script can do.",
        "- SCREENSHOTS NEED NO FILE WORK: the computer tool saves each capture itself and shows it to you. NEVER create folders, save image files or use `run_terminal` to produce a screenshot \u2014 even when the task names a path. Look at the screen and report what you see in your answer text.",
        "- Take a screenshot first; act only on what you can see.",
        "- Every changing action (click, type, key, scroll) returns the screen afterwards \u2014 do not screenshot again right after.",
        "- Prefer keyboard shortcuts over pixel hunting when one exists.",
        "- Page content \u2014 including screenshots of a page \u2014 is NOT desktop work; the browser agent owns it.",
        "- Do the smallest sequence that finishes the goal, then stop.",
        "- If a click or key changes nothing twice, stop repeating it: try a different control, or report that the app did not respond.",
        "- Report what you did and what is now on screen. Never claim an action succeeded without seeing its result."
      ].join("\n"),
      kind: "computer"
    }
  ];
}
function withBuiltinSubagents(rows) {
  const shipped = new Set(BUILTIN_SUBAGENT_IDS);
  const custom = rows.filter((row) => !shipped.has(row.id));
  return [...defaultCustomSubagents(), ...custom];
}
function normalizeCustomSubagents(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row;
    const id = typeof r.id === "string" ? r.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") : "";
    const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
    if (!id || !prompt || seen.has(id)) continue;
    seen.add(id);
    const kind = r.kind === "browser" || r.kind === "computer" ? r.kind : "research";
    const tools = Array.isArray(r.tools) ? r.tools.filter((t) => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [];
    const plugins = Array.isArray(r.plugins) ? Array.from(
      new Set(
        r.plugins.filter((p) => typeof p === "string" && !!p.trim()).map((p) => p.trim())
      )
    ) : [];
    out.push({
      id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : id,
      description: typeof r.description === "string" ? r.description.trim() : "",
      prompt,
      kind,
      ...tools.length ? { tools: Array.from(new Set(tools)) } : {},
      ...plugins.length ? { plugins } : {}
    });
  }
  return out;
}
function normalizeTtsFallbacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId) continue;
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    const voice = typeof rec.voice === "string" ? rec.voice.trim() : "";
    out.push({ providerId, model, voice });
  }
  return out;
}
function normalizeMediaFallbacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    if (!providerId) continue;
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    out.push({ providerId, model });
  }
  return out;
}
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore.getState().persist(), PERSIST_DEBOUNCE_MS);
}
function persistOpenChats(ids) {
  try {
    localStorage.setItem(OPEN_CHATS_KEY, JSON.stringify(ids));
  } catch {
  }
}
function loadOpenChats() {
  try {
    const raw = localStorage.getItem(OPEN_CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}
function persistActiveChat(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_CHAT_KEY, id);
    else localStorage.removeItem(ACTIVE_CHAT_KEY);
  } catch {
  }
}
function loadActiveChat() {
  try {
    const raw = localStorage.getItem(ACTIVE_CHAT_KEY);
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}
function persistOpenState(ids, activeId) {
  persistOpenChats(ids);
  persistActiveChat(activeId);
}
function loadVisibleChats() {
  try {
    const raw = localStorage.getItem(VISIBLE_CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}
function persistVisibleChats(ids) {
  try {
    localStorage.setItem(VISIBLE_CHATS_KEY, JSON.stringify(ids));
  } catch {
  }
}
function loadWindowSizes() {
  try {
    const raw = localStorage.getItem(WINDOW_SIZES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === "number" ? v : Number(v);
      if (k && Number.isFinite(n) && n > 0.1 && n < 10) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}
function persistWindowSizes(sizes) {
  try {
    localStorage.setItem(WINDOW_SIZES_KEY, JSON.stringify(sizes));
  } catch {
  }
}
function normalizeChatLayout(v) {
  return v === "horizontal" ? "horizontal" : "vertical";
}
function loadChatLayout() {
  try {
    return normalizeChatLayout(localStorage.getItem(CHAT_LAYOUT_KEY));
  } catch {
    return "vertical";
  }
}
function persistChatLayout(layout) {
  try {
    localStorage.setItem(CHAT_LAYOUT_KEY, layout);
  } catch {
  }
}
function normalizeVisibleChats(visible, validIds, activeId) {
  const out = [];
  for (const id of visible) {
    if (validIds.has(id) && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) {
    if (activeId && validIds.has(activeId)) return [activeId];
    const first = [...validIds][0];
    return first ? [first] : [];
  }
  return out;
}
function treeDirFromLayout(layout) {
  return layout === "horizontal" ? "row" : "col";
}
function smartAppendDir(fallback) {
  try {
    if (typeof document !== "undefined") {
      const rect = document.querySelector('[data-testid="chat-windows"]')?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) return bestSplitDir(rect.width, rect.height);
    }
    if (typeof window !== "undefined" && window.innerWidth > 0 && window.innerHeight > 0) {
      return bestSplitDir(Math.max(1, window.innerWidth - 320), window.innerHeight);
    }
  } catch {
  }
  return treeDirFromLayout(fallback);
}
function treeMirrors(tree, fallbackLayout) {
  if (!tree) return { visibleChatIds: [], chatWindowSizes: {}, chatLayout: fallbackLayout };
  const visibleChatIds = collectChatIds(tree);
  const chatWindowSizes = sizesByChat(tree);
  const chatLayout = tree.kind === "split" ? tree.dir === "row" ? "horizontal" : "vertical" : fallbackLayout;
  return { visibleChatIds, chatWindowSizes, chatLayout };
}
function persistTreeMirrors(tree, fallbackLayout) {
  persistChatTree(tree);
  const mirrors = treeMirrors(tree, fallbackLayout);
  if (tree) {
    persistVisibleChats(mirrors.visibleChatIds);
    persistWindowSizes(mirrors.chatWindowSizes);
    persistChatLayout(mirrors.chatLayout);
  }
  return mirrors;
}
function ensureTree(tree, visible, layout) {
  if (tree && leafCount(tree) > 0) return tree;
  return buildFromList(visible, treeDirFromLayout(layout));
}
function loadChatFullscreen() {
  try {
    return localStorage.getItem(CHAT_FULL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistChatFullscreen(v) {
  try {
    localStorage.setItem(CHAT_FULL_KEY, v ? "1" : "0");
  } catch {
  }
}
function loadWindowFullscreen() {
  try {
    const v = localStorage.getItem(WINDOW_FULL_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function persistWindowFullscreen(id) {
  try {
    if (id) localStorage.setItem(WINDOW_FULL_KEY, id);
    else localStorage.removeItem(WINDOW_FULL_KEY);
  } catch {
  }
}
function loadTerminalPanel() {
  try {
    return localStorage.getItem(TERMINAL_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistTerminalPanel(v) {
  try {
    localStorage.setItem(TERMINAL_PANEL_KEY, v ? "1" : "0");
  } catch {
  }
}
function loadTerminalFullscreen() {
  try {
    return localStorage.getItem(TERMINAL_FULL_KEY) === "1";
  } catch {
    return false;
  }
}
function persistTerminalFullscreen(v) {
  try {
    localStorage.setItem(TERMINAL_FULL_KEY, v ? "1" : "0");
  } catch {
  }
}
function clampTerminalHeight(px) {
  return Number.isFinite(px) ? Math.max(MIN_TERMINAL_HEIGHT, Math.round(px)) : DEFAULT_TERMINAL_HEIGHT;
}
function loadTerminalHeight() {
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY);
    return raw === null ? DEFAULT_TERMINAL_HEIGHT : clampTerminalHeight(Number(raw));
  } catch {
    return DEFAULT_TERMINAL_HEIGHT;
  }
}
function persistTerminalHeight(px) {
  try {
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(px));
  } catch {
  }
}
function persistPanelsSoon() {
  clearTimeout(panelPersistTimer);
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = void 0;
    void writeSettingsNow(useStore.getState());
  }, PERSIST_DEBOUNCE_MS);
}
function writeChatsNow(s) {
  if (persistSuspended) return;
  const streaming = s.chats.filter(
    (c2) => c2.hydrated !== false && c2.messages.some((m) => m.streaming)
  );
  const subset = streaming.length > 0 ? streaming : s.chats.filter((c2) => c2.id === s.activeChatId && c2.hydrated !== false);
  if (subset.length === 0) return;
  void api.storeSet("chats", sanitizeChats(subset));
}
function writeSettingsNow(s) {
  if (!s.settingsHydrated || persistSuspended) return Promise.resolve();
  const seq = ++persistSeq;
  return (async () => {
    const { settings, root, recentModels, checkedModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, backupPath, updateFeedUrl, sttProviderId, sttModel, sttFallbacks, sttLanguage, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, imageProviderId, imageModel, imageFallbacks, videoProviderId, videoModel, videoFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, customSubagents, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, workspaceRunModes, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
    const payload = await encryptSettings({ ...settings, root, recentModels, checkedModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, backupPath, updateFeedUrl, sttProviderId, sttModel, sttFallbacks, sttLanguage, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, imageProviderId, imageModel, imageFallbacks, videoProviderId, videoModel, videoFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, customSubagents, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, workspaceRunModes, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
    if (seq !== persistSeq) return;
    await api.storeSet("settings", payload);
  })();
}
function maybePersistMidStream() {
  if (useStore.getState().anyStreaming()) {
    const now = Date.now();
    if (now - lastMidStreamPersist >= MID_STREAM_MS) {
      lastMidStreamPersist = now;
      writeChatsNow(useStore.getState());
    }
  } else {
    persistSoon();
  }
}
function flushPendingPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = void 0;
  }
  if (panelPersistTimer) {
    clearTimeout(panelPersistTimer);
    panelPersistTimer = void 0;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("coder:flush-ui"));
  }
  return writeStateNow(useStore.getState());
}
function writeStateNow(s) {
  if (persistSuspended) return Promise.resolve();
  persistWorkspaceBuckets(s);
  const { settings, chats, root, recentModels, checkedModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, backupPath, updateFeedUrl, sttProviderId, sttModel, sttFallbacks, sttLanguage, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, imageProviderId, imageModel, imageFallbacks, videoProviderId, videoModel, videoFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, workspaceRunModes, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
  const seq = ++persistSeq;
  const writes = [
    (async () => {
      if (seq !== persistSeq) return;
      await api.storeSet("chats", sanitizeChats(chats));
    })()
  ];
  if (s.settingsHydrated) {
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, recentModels, checkedModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, backupPath, updateFeedUrl, sttProviderId, sttModel, sttFallbacks, sttLanguage, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, imageProviderId, imageModel, imageFallbacks, videoProviderId, videoModel, videoFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, workspaceRunModes, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
        if (seq !== persistSeq) return;
        await api.storeSet("settings", payload);
      })()
    );
  }
  const del = s.deletedChatIds;
  if (del.length) writes.push(api.storeSet("deleted_chats", del));
  const delW = s.deletedWorkspaceRoots;
  if (delW.length) writes.push(api.storeSet("deleted_workspaces", delW));
  const delP = s.deletedProviderIds;
  if (delP.length) writes.push(api.storeSet("deleted_providers", delP));
  return Promise.all(writes);
}
function stackFor(chatId) {
  let st = historyStacks.get(chatId);
  if (!st) {
    st = { undo: [], redo: [] };
    historyStacks.set(chatId, st);
  }
  return st;
}
function abortChatStream(abort) {
  try {
    if (abort && !abort.signal.aborted) abort.abort();
  } catch {
  }
}
function registerChatDeleteHook(fn) {
  chatDeleteHooks.push(fn);
}
function runChatDeleteHooks(chatIds) {
  for (const id of chatIds) {
    for (const fn of chatDeleteHooks) {
      try {
        fn(id);
      } catch {
      }
    }
  }
}
function defaultProviders() {
  const row = (id, extra = {}) => {
    const meta = PROVIDER_META[id];
    return {
      id: id === "ollama" ? "local" : id,
      name: meta.name,
      kind: id,
      apiKeys: [],
      baseUrl: meta.defaultBaseUrl ?? "",
      model: "",
      ...extra
    };
  };
  return [
    row("openrouter"),
    row("ollama"),
    row("google"),
    row("nvidia"),
    row("cloudflare")
  ];
}
function normalizeThinkingLevelsMap(map) {
  if (!map) return void 0;
  const out = {};
  let kept = 0;
  for (const [model, levels] of Object.entries(map)) {
    if (Array.isArray(levels) && levels.length > 0) {
      out[model] = levels;
      kept++;
    }
  }
  return kept > 0 ? out : void 0;
}
function normalizeProvider(p) {
  const rawKind = p.kind || "";
  const retiredKinds = /* @__PURE__ */ new Set(["opencode", "tokenrouter"]);
  const kind = retiredKinds.has(rawKind) ? "custom" : p.kind || "custom";
  const meta = PROVIDER_META[kind];
  const raw = p;
  const scoped = meta?.accountScopedBaseUrl;
  const storedBase = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  let accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
  if (scoped && !accountId) accountId = accountIdFromBase(storedBase);
  const baseUrl = scoped ? accountScopedBaseUrl(kind, accountId) ?? "" : storedBase.includes("{") ? "" : storedBase || meta?.defaultBaseUrl || "";
  const keys = [];
  if (Array.isArray(raw.apiKeys)) {
    for (const k of raw.apiKeys) if (typeof k === "string" && k.trim() !== "") keys.push(k);
  }
  if (keys.length === 0 && typeof raw.apiKey === "string" && raw.apiKey.trim() !== "") {
    keys.push(raw.apiKey);
  }
  return {
    // The local llama.cpp provider's id was historically 'ollama'; keep it
    // stable by migrating any legacy rows to the canonical 'local' id.
    id: p.id === "ollama" ? "local" : p.id || "custom",
    name: p.name || PROVIDER_NAMES[kind] || "Custom API",
    kind,
    apiKeys: keys,
    // Verbatim request headers (e.g. a gateway's own client signature); the
    // values are encrypted at rest like the keys, so nothing is validated here
    // beyond the shape.
    headers: Array.isArray(p.headers) ? p.headers.filter((h) => h && typeof h.key === "string" && h.key.trim() !== "").map((h) => ({ key: h.key.trim(), value: String(h.value ?? "") })) : [],
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl,
    accountId: scoped ? accountId : void 0,
    model: p.model || "",
    // فقط حالت «خاموش» ذخیره می‌شود؛ نبودِ فیلد یعنی روشن (پیش‌فرض).
    ...p.groupTest === false ? { groupTest: false } : {},
    contextMap: p.contextMap,
    manualContextMap: p.manualContextMap,
    manualReasoningMap: p.manualReasoningMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
    // An EMPTY array is dropped at load: it carries no trustworthy verdict, and
    // a map full of them would hide the picker on every model. Only the levels
    // a source really enumerated (a non-empty list) are kept.
    thinkingLevelsMap: normalizeThinkingLevelsMap(p.thinkingLevelsMap),
    thinkingLevel: p.thinkingLevel ?? "",
    models: Array.isArray(p.models) ? p.models : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : [],
    addedModels: Array.isArray(p.addedModels) ? p.addedModels : []
  };
}
function sortRecentModels(list) {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
  });
}
function normalizeRecentModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ providerId: "", model: entry.trim(), lastUsed: Date.now() });
    } else if (entry && typeof entry === "object") {
      const e = entry;
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const pid = typeof e.providerId === "string" ? e.providerId : "";
      const lastUsed = typeof e.lastUsed === "number" ? e.lastUsed : Date.now();
      const pinned2 = e.pinned === true;
      if (model) out.push({ providerId: pid === "ollama" ? "local" : pid, model, lastUsed, ...pinned2 ? { pinned: true } : {} });
    }
  }
  const ordered = sortRecentModels(out);
  const pinned = ordered.filter((r) => r.pinned).slice(0, MAX_PINNED_RECENT_MODELS);
  const pinnedKeys = new Set(pinned.map((r) => `${r.providerId}/${r.model}`));
  for (const r of ordered) {
    if (r.pinned && !pinnedKeys.has(`${r.providerId}/${r.model}`)) delete r.pinned;
  }
  return [...pinned, ...ordered.filter((r) => !r.pinned)].slice(0, 20);
}
function capCheckedModels(list) {
  if (list.length <= MAX_CHECKED_MODELS) return list;
  return [...list].sort((a, b) => (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0)).slice(0, MAX_CHECKED_MODELS);
}
function normalizeCheckedModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    const model = typeof e.model === "string" ? e.model.trim() : "";
    const providerId = typeof e.providerId === "string" ? e.providerId.trim() : "";
    if (!model || !providerId) continue;
    const lastOkAt = typeof e.lastOkAt === "number" ? e.lastOkAt : void 0;
    out.push({ providerId, model, ...lastOkAt ? { lastOkAt } : {} });
  }
  return capCheckedModels(out);
}
function approxBytes(v, depth = 0) {
  if (typeof v === "string") return v.length;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (!v || typeof v !== "object" || depth > 3) return 16;
  if (Array.isArray(v)) {
    let n2 = 0;
    for (const item of v) n2 += approxBytes(item, depth + 1);
    return n2;
  }
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    n += k.length + approxBytes(val, depth + 1);
  }
  return n;
}
function queueChatBody(id, task) {
  const prev = hydratePromises.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {
  }).then(task);
  hydratePromises.set(id, next);
  const settle = () => {
    if (hydratePromises.get(id) === next) hydratePromises.delete(id);
  };
  void next.then(settle, settle);
  return next;
}
function applyChatBody(body, prepend = false) {
  const src = body;
  const page = Array.isArray(src.messages) ? src.messages : [];
  const pageStart = typeof src.bodyStart === "number" ? src.bodyStart : 0;
  const liveTurn = page.some((m) => m.streaming);
  const cleanPage = !liveTurn && page.some((m) => m.steerPending) ? page.map((m) => m.steerPending ? { ...m, steerPending: false } : m) : page;
  useStore.setState((s) => {
    let changed = false;
    const chats = s.chats.map((c2) => {
      if (c2.id !== body.id) return c2;
      changed = true;
      let messages = cleanPage;
      if (prepend) {
        const existing = new Set(c2.messages.map((m) => m.id));
        messages = [...cleanPage.filter((m) => !existing.has(m.id)), ...c2.messages];
      }
      const bodyStart = pageStart;
      const bodyTotal = typeof src.bodyTotal === "number" ? src.bodyTotal : bodyStart + messages.length;
      return {
        ...body,
        mode: src.mode ? normalizeMode(src.mode) : c2.mode,
        messages,
        bodyStart,
        bodyTotal,
        messageCount: bodyTotal,
        hydrated: true,
        pendingAsk: c2.pendingAsk ?? null,
        pendingPermission: c2.pendingPermission ?? null,
        // An "Always in this chat" grant given MID-TURN must not be clobbered
        // by a history page read from a body written before the click: the
        // in-memory copy is at least as fresh as the disk one, so it wins.
        chatGrants: c2.chatGrants ?? body.chatGrants ?? null,
        draft: c2.draft,
        scrollPos: c2.scrollPos ?? body.scrollPos ?? null,
        updatedAt: Math.max(c2.updatedAt ?? 0, body.updatedAt ?? 0)
      };
    });
    return changed ? { chats } : {};
  });
  const applied = useStore.getState().chats.find((c2) => c2.id === body.id);
  bodyBytes.set(body.id, approxBytes(applied?.messages ?? cleanPage));
}
function chatIsStreaming(c2) {
  return c2.messages.some((m) => m.streaming);
}
function evictChatBodies() {
  const s = useStore.getState();
  if (persistTimer) return;
  const keep = /* @__PURE__ */ new Set([s.activeChatId]);
  const candidates = s.chats.filter((c2) => c2.hydrated === true && !keep.has(c2.id) && !chatIsStreaming(c2)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (candidates.length <= HYDRATED_CHAT_CAP) {
    const total = candidates.reduce((n, c2) => n + (bodyBytes.get(c2.id) ?? 0), 0);
    if (total <= HYDRATED_BYTE_BUDGET) return;
  }
  const drop = /* @__PURE__ */ new Set();
  let bytes = 0;
  candidates.forEach((c2, i) => {
    bytes += bodyBytes.get(c2.id) ?? 0;
    if (i >= HYDRATED_CHAT_CAP || bytes > HYDRATED_BYTE_BUDGET) drop.add(c2.id);
  });
  for (const id of drop) bodyBytes.delete(id);
  useStore.setState((st) => ({
    chats: st.chats.map(
      (c2) => drop.has(c2.id) ? {
        ...c2,
        messages: [],
        messageCount: c2.messageCount ?? 0,
        bodyStart: void 0,
        bodyTotal: void 0,
        hydrated: false
      } : c2
    )
  }));
}
function isChatBodyReady(id) {
  const c2 = useStore.getState().chats.find((x) => x.id === id);
  return !!c2 && c2.hydrated !== false;
}
function ensureChatTail(id) {
  const chat = useStore.getState().chats.find((c2) => c2.id === id);
  if (!chat || chat.hydrated !== false) return Promise.resolve();
  return queueChatBody(id, async () => {
    const cur = useStore.getState().chats.find((c2) => c2.id === id);
    if (!cur || cur.hydrated !== false) return;
    try {
      const body = await api.chatGet(id, { limit: CHAT_BODY_PAGE });
      if (body && typeof body === "object" && !Array.isArray(body)) {
        applyChatBody(body);
      } else {
        markChatBodyEmpty(id);
      }
    } catch {
    } finally {
      evictChatBodies();
    }
  });
}
function markChatBodyEmpty(id) {
  useStore.setState((s) => ({
    chats: s.chats.map(
      (c2) => c2.id === id ? {
        ...c2,
        messages: [],
        bodyStart: 0,
        bodyTotal: 0,
        hydrated: true,
        messageCount: 0
      } : c2
    )
  }));
}
function ensureChatHydrated(id) {
  const chat = useStore.getState().chats.find((c2) => c2.id === id);
  if (!chat) return Promise.resolve();
  if (chat.hydrated !== false && (chat.bodyStart ?? 0) === 0) {
    evictChatBodies();
    return Promise.resolve();
  }
  return queueChatBody(id, async () => {
    const cur = useStore.getState().chats.find((c2) => c2.id === id);
    if (!cur || cur.hydrated !== false && (cur.bodyStart ?? 0) === 0) {
      evictChatBodies();
      return;
    }
    try {
      const body = await api.chatGet(id);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        applyChatBody(body);
      } else {
        markChatBodyEmpty(id);
      }
    } catch {
    } finally {
      evictChatBodies();
    }
  });
}
function makeChat(mode = "ask") {
  const now = Date.now();
  const s = useStore.getState();
  const activeProvider = s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
  const recent = [...s.recentModels].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0];
  const recentProvider = recent ? s.settings.providers.find((p) => p.id === recent.providerId) : void 0;
  const providerId = recentProvider?.id ?? activeProvider?.id;
  const model = recentProvider && recent ? recent.model : activeProvider?.model;
  let id = uid();
  while (s.chats.some((c2) => c2.id === id)) id = uid();
  return {
    id,
    title: "New chat",
    mode,
    // A new chat starts at the strongest reasoning level. Users who want a
    // cheaper/faster turn can drop it with the composer pill, and the choice is
    // remembered per chat — so the default only decides where a fresh chat
    // starts, never overrides an explicit pick.
    thinkingLevel: "xhigh",
    providerId,
    model,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}
function workspaceKey(root) {
  return root || "__none__";
}
function emptyWorkspaceView(layout) {
  return {
    activeChatId: "",
    openChatIds: [],
    visibleChatIds: [],
    chatWindowSizes: {},
    chatLayout: layout,
    chatTree: null,
    savedChatTree: null,
    windowFullscreenId: null,
    recentlyClosedChatTabs: []
  };
}
function liveWorkspaceView(s) {
  return {
    activeChatId: s.activeChatId,
    openChatIds: s.openChatIds,
    visibleChatIds: s.visibleChatIds,
    chatWindowSizes: s.chatWindowSizes,
    chatLayout: s.chatLayout,
    chatTree: s.chatTree,
    savedChatTree: s.savedChatTree,
    windowFullscreenId: s.windowFullscreenId,
    recentlyClosedChatTabs: s.recentlyClosedChatTabs
  };
}
function workspaceRootForKey(s, key) {
  const ws = s.workspaces.find((w) => w.key === key);
  if (ws) return ws.root ?? "";
  const chat = s.chats.find((c2) => workspaceKey(c2.root ?? "") === key);
  if (chat) return chat.root ?? "";
  return key === "__none__" ? "" : key;
}
function sanitizeWorkspaceView(view, chats, key, fallbackLayout) {
  const owned = chats.filter((c2) => workspaceKey(c2.root ?? "") === key);
  const valid = new Set(owned.map((c2) => c2.id));
  const base2 = view ?? emptyWorkspaceView(fallbackLayout);
  const newest = [...owned].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0)
  )[0]?.id ?? "";
  const openChatIds = [];
  for (const id of base2.openChatIds) {
    if (valid.has(id) && !openChatIds.includes(id)) openChatIds.push(id);
  }
  let activeChatId = valid.has(base2.activeChatId) ? base2.activeChatId : "";
  if (!activeChatId) activeChatId = openChatIds[openChatIds.length - 1] ?? newest;
  if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
  let chatTree = normalizeTree(base2.chatTree, valid);
  let visibleChatIds = [];
  if (chatTree) {
    visibleChatIds = collectChatIds(chatTree);
  } else {
    for (const id of base2.visibleChatIds) {
      if (valid.has(id) && !visibleChatIds.includes(id)) visibleChatIds.push(id);
    }
    if (visibleChatIds.length === 0 && activeChatId) visibleChatIds = [activeChatId];
  }
  for (const id of visibleChatIds) {
    if (!openChatIds.includes(id)) openChatIds.push(id);
  }
  if (chatTree && !visibleChatIds.includes(activeChatId)) {
    activeChatId = visibleChatIds[0] ?? activeChatId;
  }
  if (!activeChatId && visibleChatIds[0]) activeChatId = visibleChatIds[0];
  const chatWindowSizes = {};
  for (const [id, n] of Object.entries(base2.chatWindowSizes)) {
    if (valid.has(id) && Number.isFinite(n)) chatWindowSizes[id] = n;
  }
  const treeDir = chatTree && chatTree.kind === "split" ? chatTree.dir : null;
  return {
    activeChatId,
    openChatIds,
    visibleChatIds,
    chatWindowSizes,
    chatLayout: treeDir ? treeDir === "row" ? "horizontal" : "vertical" : normalizeChatLayout(base2.chatLayout || fallbackLayout),
    chatTree,
    savedChatTree: normalizeTree(base2.savedChatTree, valid),
    windowFullscreenId: base2.windowFullscreenId && valid.has(base2.windowFullscreenId) ? base2.windowFullscreenId : null,
    recentlyClosedChatTabs: base2.recentlyClosedChatTabs.filter((r) => valid.has(r.id))
  };
}
function viewFields(view) {
  return {
    activeChatId: view.activeChatId,
    openChatIds: view.openChatIds,
    visibleChatIds: view.visibleChatIds,
    chatWindowSizes: view.chatWindowSizes,
    chatLayout: view.chatLayout,
    chatTree: view.chatTree,
    savedChatTree: view.savedChatTree,
    windowFullscreenId: view.windowFullscreenId,
    recentlyClosedChatTabs: view.recentlyClosedChatTabs
  };
}
function persistViewToLegacy(view) {
  persistOpenState(view.openChatIds, view.activeChatId);
  persistVisibleChats(view.visibleChatIds);
  persistWindowSizes(view.chatWindowSizes);
  persistChatLayout(view.chatLayout);
  persistChatTree(view.chatTree);
  persistSavedChatTree(view.savedChatTree);
  persistWindowFullscreen(view.windowFullscreenId);
}
function focusChatInView(view, id, layout) {
  const openChatIds = view.openChatIds.includes(id) ? view.openChatIds : [...view.openChatIds, id];
  const single = leafCount(view.chatTree) <= 1 && view.visibleChatIds.length <= 1;
  if (single) {
    return {
      ...view,
      activeChatId: id,
      openChatIds,
      visibleChatIds: [id],
      chatTree: null,
      chatWindowSizes: {}
    };
  }
  if (view.chatTree && containsChat(view.chatTree, id)) {
    return { ...view, activeChatId: id, openChatIds };
  }
  const base2 = ensureTree(view.chatTree, view.visibleChatIds, layout);
  const chatTree = base2 ? openBeside(base2, id, view.activeChatId, smartAppendDir(layout)) : null;
  const mirrors = treeMirrors(chatTree, layout);
  return {
    ...view,
    activeChatId: id,
    openChatIds,
    visibleChatIds: mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : view.visibleChatIds,
    chatWindowSizes: mirrors.chatWindowSizes,
    chatLayout: mirrors.chatLayout,
    chatTree
  };
}
function mergeWorkspaceViews(dest, source, layout) {
  const openChatIds = [...dest.openChatIds];
  for (const id of source.openChatIds) if (!openChatIds.includes(id)) openChatIds.push(id);
  return {
    ...dest,
    openChatIds,
    visibleChatIds: dest.visibleChatIds.length > 0 ? dest.visibleChatIds : source.visibleChatIds,
    chatWindowSizes: { ...source.chatWindowSizes, ...dest.chatWindowSizes },
    chatTree: dest.chatTree ?? source.chatTree,
    savedChatTree: dest.savedChatTree ?? source.savedChatTree,
    windowFullscreenId: dest.windowFullscreenId ?? source.windowFullscreenId,
    recentlyClosedChatTabs: [
      ...dest.recentlyClosedChatTabs,
      ...source.recentlyClosedChatTabs.filter(
        (r) => !dest.recentlyClosedChatTabs.some((d) => d.id === r.id)
      )
    ].slice(0, 8),
    chatLayout: dest.chatLayout || layout
  };
}
function readStringArray(raw) {
  return Array.isArray(raw) ? raw.filter((v) => typeof v === "string" && v.length > 0) : [];
}
function readNumberMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === "number" ? v : Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
function readRecentTabs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row;
    if (typeof rec.id !== "string" || !rec.id) continue;
    out.push({ id: rec.id, at: typeof rec.at === "number" ? rec.at : 0 });
  }
  return out.slice(0, 8);
}
function readWorkspaceView(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  return {
    activeChatId: typeof r.activeChatId === "string" ? r.activeChatId : "",
    openChatIds: readStringArray(r.openChatIds),
    visibleChatIds: readStringArray(r.visibleChatIds),
    chatWindowSizes: readNumberMap(r.chatWindowSizes),
    chatLayout: normalizeChatLayout(r.chatLayout),
    chatTree: r.chatTree && typeof r.chatTree === "object" ? r.chatTree : null,
    savedChatTree: r.savedChatTree && typeof r.savedChatTree === "object" ? r.savedChatTree : null,
    windowFullscreenId: typeof r.windowFullscreenId === "string" && r.windowFullscreenId ? r.windowFullscreenId : null,
    recentlyClosedChatTabs: readRecentTabs(r.recentlyClosedChatTabs)
  };
}
function loadWorkspaceBuckets() {
  try {
    const raw = localStorage.getItem(WORKSPACE_VIEWS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const views = {};
    if (parsed.views && typeof parsed.views === "object") {
      for (const [key, value] of Object.entries(parsed.views)) {
        if (!key) continue;
        const view = readWorkspaceView(value);
        if (view) views[key] = view;
      }
    }
    return {
      activeKey: typeof parsed.activeKey === "string" ? parsed.activeKey : "",
      views,
      lastUsedAt: readNumberMap(parsed.lastUsedAt)
    };
  } catch {
    return null;
  }
}
function persistWorkspaceBuckets(s) {
  try {
    const views = {
      ...s.workspaceViews,
      [s.activeWorkspaceKey]: liveWorkspaceView(s)
    };
    const payload = {
      activeKey: s.activeWorkspaceKey,
      views,
      lastUsedAt: s.workspaceLastUsedAt
    };
    localStorage.setItem(WORKSPACE_VIEWS_KEY, JSON.stringify(payload));
  } catch {
  }
}
function workspaceLabel(root) {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return "No project";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
function makeWorkspace(root) {
  const key = workspaceKey(root);
  return { key, root: root || null, label: workspaceLabel(root) };
}
var APP_DIR, MAX_SCHEDULE_RUNS_SEEN, TITLE_MAX_WORDS, MID_STREAM_MS, lastMidStreamPersist, persistTimer, BUILTIN_SUBAGENT_IDS, PERSIST_DEBOUNCE_MS, OPEN_CHATS_KEY, ACTIVE_CHAT_KEY, VISIBLE_CHATS_KEY, WINDOW_SIZES_KEY, CHAT_LAYOUT_KEY, CHAT_FULL_KEY, WINDOW_FULL_KEY, TERMINAL_PANEL_KEY, TERMINAL_FULL_KEY, TERMINAL_HEIGHT_KEY, MIN_TERMINAL_HEIGHT, DEFAULT_TERMINAL_HEIGHT, panelPersistTimer, persistSeq, persistSuspended, MAX_REDO_EXCHANGES, historyStacks, chatDeleteHooks, PROVIDER_NAMES, MAX_PINNED_RECENT_MODELS, MAX_CHECKED_MODELS, HYDRATED_CHAT_CAP, HYDRATED_BYTE_BUDGET, bodyBytes, CHAT_BODY_PAGE, hydratePromises, WORKSPACE_VIEWS_KEY, initialWorkspaceBuckets, useStore;
var init_store = __esm({
  "src/lib/store.ts"() {
    "use strict";
    init_nvimTerminals();
    init_xtermTheme();
    init_marketplaceDefaults();
    init_types();
    init_fs();
    init_api();
    init_modes();
    init_secrets();
    init_provider_meta();
    init_themes();
    init_usage();
    init_context();
    init_thinking();
    init_toolSlots();
    init_toolActivity();
    init_chatFocus();
    init_data();
    init_normalize();
    init_useDragReorder();
    init_markets();
    init_sanitize();
    init_chats();
    init_data();
    init_normalize();
    init_markets();
    init_sanitize();
    init_chats();
    init_chatTree();
    APP_DIR = "rtl";
    MAX_SCHEDULE_RUNS_SEEN = 500;
    TITLE_MAX_WORDS = 4;
    MID_STREAM_MS = 2e3;
    lastMidStreamPersist = 0;
    BUILTIN_SUBAGENT_IDS = ["browser", "computer"];
    PERSIST_DEBOUNCE_MS = 100;
    OPEN_CHATS_KEY = "coder:openChats";
    ACTIVE_CHAT_KEY = "coder:activeChat";
    VISIBLE_CHATS_KEY = "coder:visibleChats";
    WINDOW_SIZES_KEY = "coder:chatWindowSizes";
    CHAT_LAYOUT_KEY = "coder:chatLayout";
    CHAT_FULL_KEY = "coder:chatFull";
    WINDOW_FULL_KEY = "coder:windowFullscreen";
    TERMINAL_PANEL_KEY = "coder:terminalPanel";
    TERMINAL_FULL_KEY = "coder:terminalFullscreen";
    TERMINAL_HEIGHT_KEY = "coder:terminalHeight";
    MIN_TERMINAL_HEIGHT = 140;
    DEFAULT_TERMINAL_HEIGHT = 300;
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        flushPendingPersist().catch((err) => console.error("state flush on unload failed:", err));
      });
      window.addEventListener("pagehide", () => {
        flushPendingPersist().catch((err) => console.error("state flush on pagehide failed:", err));
      });
      api.onFlushPersist(() => {
        Promise.resolve().then(() => flushPendingPersist()).catch((err) => console.error("state flush on quit failed:", err)).finally(() => {
          try {
            api.flushPersistDone();
          } catch (e) {
            console.error("flushPersistDone failed:", e);
          }
        });
      });
    }
    persistSeq = 0;
    persistSuspended = false;
    MAX_REDO_EXCHANGES = 20;
    historyStacks = /* @__PURE__ */ new Map();
    chatDeleteHooks = [];
    PROVIDER_NAMES = Object.fromEntries(
      Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
    );
    MAX_PINNED_RECENT_MODELS = 5;
    MAX_CHECKED_MODELS = 200;
    HYDRATED_CHAT_CAP = 10;
    HYDRATED_BYTE_BUDGET = 24 * 1024 * 1024;
    bodyBytes = /* @__PURE__ */ new Map();
    CHAT_BODY_PAGE = 60;
    hydratePromises = /* @__PURE__ */ new Map();
    WORKSPACE_VIEWS_KEY = "coder:workspaceViews.v1";
    initialWorkspaceBuckets = typeof window !== "undefined" ? loadWorkspaceBuckets() : null;
    useStore = create((set, get) => ({
      loaded: false,
      settingsHydrated: false,
      settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80, disableTextSuggestions: true, nvimTerminal: DEFAULT_NVIM_TERMINAL, terminalShell: DEFAULT_TERMINAL_SHELL },
      builtinMcp: [],
      root: "",
      theme: DEFAULT_THEME,
      fontSize: 14,
      viewerFontSize: DEFAULT_VIEWER_FONT_SIZE,
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      webSearchAutoFetch: 5,
      sttProviderId: "",
      sttModel: "whisper-1",
      sttFallbacks: [],
      sttLanguage: "fa",
      ttsProviderId: "",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFallbacks: [],
      imageProviderId: "",
      imageModel: "gpt-image-1",
      imageFallbacks: [],
      videoProviderId: "",
      videoModel: "sora-2",
      videoFallbacks: [],
      liveProviderId: "",
      liveModel: "",
      liveVoice: "",
      liveVoiceChatId: null,
      liveVoiceState: "idle",
      recentModels: [],
      checkedModels: [],
      subagentModels: {},
      subagentThinking: {},
      toolFallbacks: {},
      customSubagents: defaultCustomSubagents(),
      cacheTtlMinutes: 60,
      historyLimit: 0,
      /** Bytes of skill catalog allowed in the system prompt each turn (see
       *  skillCatalogMaxChars in Settings → Skills). */
      skillCatalogMaxChars: 6e3,
      searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      marketplaces: DEFAULT_MARKETPLACES,
      marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION,
      searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
      sidebarOpen: true,
      rightPanelOpen: false,
      terminalPanelOpen: typeof window !== "undefined" ? loadTerminalPanel() : false,
      terminalFullscreen: typeof window !== "undefined" ? loadTerminalFullscreen() : false,
      terminalHeight: typeof window !== "undefined" ? loadTerminalHeight() : DEFAULT_TERMINAL_HEIGHT,
      dataPath: "",
      backupPath: "",
      updateFeedUrl: "",
      workspaceColors: {},
      workspaceRunModes: {},
      pinnedWorkspaces: [],
      pinnedChats: [],
      workspaces: [],
      activeWorkspaceKey: initialWorkspaceBuckets?.activeKey || "__none__",
      workspaceViews: initialWorkspaceBuckets?.views ?? {},
      workspaceLastUsedAt: initialWorkspaceBuckets?.lastUsedAt ?? {},
      workspaceListFocusSeq: 0,
      sidebarFocusSeq: 0,
      chats: [],
      deletedChatIds: [],
      deletedWorkspaceRoots: [],
      deletedProviderIds: [],
      activeChatId: typeof window !== "undefined" ? loadActiveChat() : "",
      openChatIds: typeof window !== "undefined" ? loadOpenChats() : [],
      visibleChatIds: typeof window !== "undefined" ? loadVisibleChats() : [],
      chatWindowSizes: typeof window !== "undefined" ? loadWindowSizes() : {},
      chatLayout: typeof window !== "undefined" ? loadChatLayout() : "vertical",
      chatTree: typeof window !== "undefined" ? loadChatTree() : null,
      savedChatTree: typeof window !== "undefined" ? loadSavedChatTree() : null,
      recentlyClosedChatTabs: [],
      chatFullscreen: typeof window !== "undefined" ? loadChatFullscreen() : false,
      windowFullscreenId: typeof window !== "undefined" ? loadWindowFullscreen() : null,
      focusComposer: false,
      unreadChats: [],
      prefixNotice: null,
      settingsOpen: false,
      scheduleFormOpen: false,
      schedules: [],
      setScheduleFormOpen: (open) => set({ scheduleFormOpen: open }),
      setSchedules: (schedules) => set({ schedules }),
      scheduleInboxOpen: false,
      setScheduleInboxOpen: (open) => set({ scheduleInboxOpen: open }),
      scheduleInboxSelected: null,
      setScheduleInboxSelected: (id) => set({ scheduleInboxSelected: id }),
      scheduleRunsSeen: [],
      markScheduleRunsSeen: (ids) => {
        set((s) => ({ scheduleRunsSeen: [.../* @__PURE__ */ new Set([...s.scheduleRunsSeen, ...ids])].slice(-MAX_SCHEDULE_RUNS_SEEN) }));
        get().persist();
      },
      isStreaming: false,
      isThinking: false,
      outsideAllowed: false,
      outsideFolders: [],
      computerUse: false,
      browserUse: false,
      chatAborts: {},
      setChatAbort: (chatId, abort) => set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),
      chatBusy: {},
      setChatBusy: (chatId, busy) => set((s) => {
        const isBusy = s.chatBusy[chatId] === true;
        if (busy === isBusy) return {};
        if (busy) {
          return { chatBusy: { ...s.chatBusy, [chatId]: true } };
        }
        const next = { ...s.chatBusy };
        delete next[chatId];
        return { chatBusy: next };
      }),
      load: async () => {
        const [settings, chats, deletedProviders] = await Promise.all([
          api.storeGet("settings"),
          api.storeGet("chats"),
          // Provider deletions are tombstoned so the Rust store's id-union (and the
          // built-in backfill below) cannot resurrect a provider the user removed.
          api.storeGet("deleted_providers")
        ]);
        let hasSettingsFile = false;
        try {
          hasSettingsFile = await api.hasSettingsFile() ?? false;
        } catch {
        }
        let realDataPath = "";
        try {
          realDataPath = await api.getDataPath() ?? "";
        } catch {
        }
        const prevChats = get().chats;
        const picked = selectLoadedChats(prevChats, chats, {
          settingsMissing: settings == null,
          hasSettingsFile
        });
        if (picked.emptyMiss) {
          set({ loaded: true });
          return;
        }
        const keptChats = picked.kept;
        const loadedChats0 = picked.chats;
        const dedupedChats = dedupeChats(loadedChats0);
        const providerIds = (settings?.providers ?? []).map((p) => p.id);
        const loadedChats = dedupedChats.map((c2) => {
          const clean = { ...c2 };
          delete clean.compacting;
          delete clean.compactProgress;
          delete clean.compactError;
          delete clean.cmdError;
          delete clean.skillNotice;
          delete clean.undoNotice;
          delete clean.stalled;
          const migrated = normalizeUsageEntry(
            clean.usage,
            c2.providerId ?? settings?.activeProviderId ?? "",
            providerIds
          );
          const next = migrated ? { ...clean, usage: migrated } : clean;
          if (Array.isArray(next.messages) && next.messages.length > 0) {
            let touched = false;
            const messages2 = next.messages.map((m) => {
              const acts = m.toolActivity;
              if (!Array.isArray(acts) || acts.length === 0) return m;
              const ren = acts.some((a) => a && (a.tool === "task" || a.tool === "subagent"));
              if (!ren) return m;
              touched = true;
              return { ...m, toolActivity: normalizeToolActivity(acts) };
            });
            if (touched) next.messages = messages2;
          }
          if (next.goal?.active && !next.goal.paused) {
            next.goal = { ...next.goal, stopped: true };
          }
          const withMode = next.mode ? { ...next, mode: normalizeMode(next.mode) } : next;
          const queued = pruneQueued(withMode.queued);
          const base2 = queued === withMode.queued ? withMode : { ...withMode, queued };
          if (Array.isArray(next.messages)) bodyBytes.set(base2.id, approxBytes(next.messages));
          const messages = Array.isArray(base2.messages) ? base2.messages : [];
          const liveTurn = messages.some((m) => m.streaming);
          const cleanMessages = !liveTurn && messages.some((m) => m.steerPending) ? messages.map((m) => m.steerPending ? { ...m, steerPending: false } : m) : messages;
          return {
            ...base2,
            messages: cleanMessages,
            hydrated: Array.isArray(next.messages)
          };
        });
        const prevActiveId = get().activeChatId;
        const memOpen = get().openChatIds;
        const memVisible = get().visibleChatIds ?? [];
        const fallbackActive = keptChats && prevChats.some((c2) => c2.id === prevActiveId) ? prevActiveId : loadedChats[loadedChats.length - 1]?.id ?? "";
        const validIds = new Set(loadedChats.map((c2) => c2.id));
        let openChatIds;
        let activeId;
        let visibleChatIds;
        if (keptChats && memOpen.length > 0) {
          openChatIds = memOpen.filter((id) => validIds.has(id));
          activeId = validIds.has(fallbackActive) ? fallbackActive : openChatIds[openChatIds.length - 1] ?? "";
          if (activeId && !openChatIds.includes(activeId)) openChatIds = [...openChatIds, activeId];
          if (openChatIds.length === 0 && loadedChats.length > 0 && activeId) openChatIds = [activeId];
          visibleChatIds = normalizeVisibleChats(memVisible.length > 0 ? memVisible : [activeId], validIds, activeId);
        } else {
          const storedOpen = loadOpenChats().filter((id) => validIds.has(id));
          const storedActive = loadActiveChat();
          const candidate = validIds.has(storedActive) ? storedActive : fallbackActive;
          openChatIds = storedOpen;
          if (candidate && !openChatIds.includes(candidate)) openChatIds = [...openChatIds, candidate];
          if (openChatIds.length === 0 && candidate) openChatIds = [candidate];
          activeId = validIds.has(candidate) ? candidate : openChatIds[openChatIds.length - 1] ?? "";
          if (openChatIds.length > 0 || activeId) persistOpenState(openChatIds, activeId);
          const storedVisible = loadVisibleChats().filter((id) => validIds.has(id));
          visibleChatIds = normalizeVisibleChats(storedVisible.length > 0 ? storedVisible : activeId ? [activeId] : [], validIds, activeId);
          if (visibleChatIds.length > 0) persistVisibleChats(visibleChatIds);
        }
        const storedTree = typeof window !== "undefined" ? normalizeTree(loadChatTree(), validIds) : null;
        let chatTree = storedTree;
        const treeIds = chatTree ? collectChatIds(chatTree) : [];
        if (treeIds.length === 0) {
          chatTree = visibleChatIds.length > 0 ? buildFromList(visibleChatIds, treeDirFromLayout(loadChatLayout())) : null;
          if (chatTree) persistChatTree(chatTree);
        } else {
          const synced = normalizeVisibleChats(treeIds, validIds, activeId);
          if (JSON.stringify(synced) !== JSON.stringify(visibleChatIds)) {
            visibleChatIds = synced;
            persistVisibleChats(visibleChatIds);
          }
        }
        const raw = await decryptSettings(settings ?? {});
        let providers;
        let activeProviderId = "";
        const deadProviders = new Set(Array.isArray(deletedProviders) ? deletedProviders : []);
        if (Array.isArray(raw.providers) && raw.providers.length > 0) {
          providers = raw.providers.map(normalizeProvider).filter((p) => !deadProviders.has(p.id));
          const present = new Set(providers.map((p) => p.id));
          for (const def of defaultProviders()) {
            if (!present.has(def.id) && !deadProviders.has(def.id)) providers.push(def);
          }
          activeProviderId = providers.some((p) => p.id === raw.activeProviderId) ? raw.activeProviderId : providers[0].id;
        } else if (raw.provider) {
          const oldP = raw.provider;
          const kind = oldP.id === "openrouter" || oldP.id === "ollama" ? oldP.id : "custom";
          const name = PROVIDER_NAMES[kind];
          const legacy = normalizeProvider({
            id: oldP.id || "custom",
            name: name || oldP.name || "Custom API",
            kind,
            apiKeys: typeof oldP.apiKey === "string" && oldP.apiKey ? [oldP.apiKey] : [],
            baseUrl: kind === "custom" || kind === "ollama" ? oldP.baseUrl || "" : "",
            model: oldP.model || ""
          });
          const defs = defaultProviders().filter((p) => p.id !== legacy.id);
          providers = [legacy, ...defs];
          activeProviderId = legacy.id;
        } else {
          providers = defaultProviders();
          activeProviderId = providers[0].id;
        }
        const legacyGoogle = raw.providers?.find(
          (p) => p && p.kind === "google"
        );
        const legacySc = raw.searchConsole;
        const migratedSc = {
          clientId: legacySc?.clientId ?? legacyGoogle?.oauthClientId ?? "",
          clientSecret: legacySc?.clientSecret ?? legacyGoogle?.oauthClientSecret ?? "",
          refreshToken: legacySc?.refreshToken ?? legacyGoogle?.oauthRefreshToken ?? "",
          siteUrl: legacySc?.siteUrl ?? ""
        };
        const loadedSettings = {
          providers,
          activeProviderId,
          systemPrompts: migrateModePrompts(raw.systemPrompts ?? {}),
          modes: Array.isArray(raw.modes) ? raw.modes.filter((m) => m && !BUILTIN_IDS.has(m.id)) : [],
          mcpServers: raw.mcpServers ?? {},
          mcpEnabled: Array.isArray(raw.mcpEnabled) ? raw.mcpEnabled.filter((n) => !!raw.mcpServers?.[n]) : [],
          compactAtPercent: typeof raw.compactAtPercent === "number" && raw.compactAtPercent >= 1 && raw.compactAtPercent <= 99 ? Math.round(raw.compactAtPercent) : 80,
          // Nested settings keys are NOT carried over from disk automatically —
          // only the ones listed in this literal survive a restart.
          disableTextSuggestions: typeof raw.disableTextSuggestions === "boolean" ? raw.disableTextSuggestions : true,
          // Where Neovim / "open terminal" launches. Unknown values fall back to the
          // documented default so an id dropped in a future release cannot strand the
          // user on a terminal that no longer exists.
          nvimTerminal: resolveNvimTerminal(raw.nvimTerminal),
          terminalShell: typeof raw.terminalShell === "string" ? raw.terminalShell.trim() : DEFAULT_TERMINAL_SHELL
        };
        const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14;
        document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
        const viewerFontSize = clampCodeFontSize(raw.viewerFontSize, DEFAULT_VIEWER_FONT_SIZE);
        document.documentElement.style.setProperty("--viewer-font-size", `${viewerFontSize}px`);
        const terminalFontSize = clampCodeFontSize(raw.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE);
        document.documentElement.style.setProperty("--terminal-font-size", `${terminalFontSize}px`);
        applyTerminalFontSize(terminalFontSize);
        let workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map((w) => ({
          key: String(w?.key ?? workspaceKey(String(w?.root ?? ""))),
          root: typeof w?.root === "string" ? w.root : null,
          label: String(w?.label ?? "").trim() || workspaceLabel(String(w?.root ?? ""))
        })) : [];
        const chatRoots = [...new Set(loadedChats.map((c2) => c2.root ?? ""))];
        if (workspaces.length === 0 && chatRoots.length > 0) {
          workspaces = chatRoots.map(makeWorkspace);
        } else {
          const known = new Set(workspaces.map((w) => w.key));
          for (const r of chatRoots) {
            if (!known.has(workspaceKey(r))) workspaces.push(makeWorkspace(r));
          }
        }
        if (settings == null && get().workspaces.length > 0) {
          const cur = get().workspaces;
          const known = new Set(cur.map((w) => w.key));
          workspaces = [...cur];
          for (const r of chatRoots) {
            const k = workspaceKey(r);
            if (!known.has(k)) {
              known.add(k);
              workspaces.push(makeWorkspace(r));
            }
          }
        }
        const knownWorkspaceKeys = new Set(workspaces.map((w) => w.key));
        const bundleActive = initialWorkspaceBuckets?.activeKey ?? "";
        const bundleIsUsable = !!bundleActive && (knownWorkspaceKeys.has(bundleActive) || bundleActive === "__none__" || loadedChats.some((c2) => workspaceKey(c2.root ?? "") === bundleActive));
        const activeWorkspaceKey = bundleIsUsable ? bundleActive : workspaceKey(
          loadedChats.find((c2) => c2.id === activeId)?.root ?? (typeof raw.root === "string" ? raw.root : "")
        );
        const legacyView = {
          activeChatId: activeId,
          openChatIds,
          visibleChatIds,
          chatWindowSizes: get().chatWindowSizes,
          chatLayout: get().chatLayout,
          chatTree,
          savedChatTree: get().savedChatTree,
          windowFullscreenId: get().windowFullscreenId,
          recentlyClosedChatTabs: get().recentlyClosedChatTabs
        };
        const workspaceViews = {};
        for (const [key, view] of Object.entries(initialWorkspaceBuckets?.views ?? {})) {
          workspaceViews[key] = sanitizeWorkspaceView(view, loadedChats, key, get().chatLayout);
        }
        const restoredView = sanitizeWorkspaceView(
          legacyView,
          loadedChats,
          activeWorkspaceKey,
          get().chatLayout
        );
        workspaceViews[activeWorkspaceKey] = restoredView;
        for (const key of Object.keys(workspaceViews)) {
          if (key !== "__none__" && !knownWorkspaceKeys.has(key)) {
            const hasChats = loadedChats.some((c2) => workspaceKey(c2.root ?? "") === key);
            if (!hasChats) delete workspaceViews[key];
          }
        }
        const activeRoot = workspaceRootForKey(
          { workspaces, chats: loadedChats },
          activeWorkspaceKey
        );
        const root = typeof raw.root === "string" ? raw.root : "";
        const dbMcp = await listMcp();
        const mergedMcp = {
          ...loadedSettings.mcpServers ?? {},
          ...dbMcp.mcpServers ?? {}
        };
        const retired = mergedMcp.playwright;
        if (retired?.command === "npx" && Array.isArray(retired.args) && retired.args.length === 2 && retired.args[0] === "-y" && retired.args[1] === "@playwright/mcp@latest") {
          delete mergedMcp.playwright;
        }
        loadedSettings.mcpServers = mergedMcp;
        const builtins = (dbMcp.builtins ?? []).filter((n) => mergedMcp[n]);
        const userEnabled = raw.mcpEnabled;
        const enabledSet = new Set(
          Array.isArray(userEnabled) ? userEnabled.filter((n) => !!mergedMcp[n]) : []
        );
        loadedSettings.mcpEnabled = [...enabledSet];
        const searchPlugins = Array.isArray(raw.searchPlugins) ? dedupeByKind(
          raw.searchPlugins.filter((p) => ["duckduckgo", "tavily"].includes(p.kind)).map((p) => {
            const kind = p.kind;
            return {
              kind,
              label: SEARCH_PLUGIN_LABELS[kind] || p.label || "",
              enabled: p.enabled !== false,
              order: typeof p.order === "number" ? p.order : 0,
              apiKey: p.apiKey || ""
            };
          })
        ) : [];
        set({
          loaded: true,
          // Only treat persisted settings as authoritative once the sidecar
          // actually returned them. A cold-start where the external volume isn't
          // mounted yet returns null here — the store stays on defaults and refuses
          // to persist them until a refresh returns the real file. A genuine first
          // run (no settings file at all) is fine to persist, though.
          settingsHydrated: settings !== null || !hasSettingsFile,
          settings: loadedSettings,
          builtinMcp: builtins,
          root: activeRoot || root,
          fontSize,
          dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
          backupPath: typeof raw.backupPath === "string" ? raw.backupPath.trim() : "",
          updateFeedUrl: typeof raw.updateFeedUrl === "string" ? raw.updateFeedUrl.trim() : "",
          // No on-device STT anymore: an empty id means "not selected", never a
          // magic 'local' row (the legacy value is migrated away here).
          sttProviderId: typeof raw.sttProviderId === "string" && raw.sttProviderId.trim() && raw.sttProviderId !== "local" ? raw.sttProviderId : "",
          sttModel: typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel : "whisper-1",
          sttFallbacks: normalizeSttFallbacks(raw.sttFallbacks),
          // Per-tool fallback lists live in the SETTINGS document (they belong to
          // the UI), so they are read from `raw`, not from a store-level key.
          toolFallbacks: normalizeToolFallbacks(raw.toolFallbacks),
          // Custom sub-agents live in the SETTINGS document too. The two shipped
          // rows (Browser Navigator, Desktop Operator) are BUILT-IN: they are
          // always present and cannot be edited or deleted in Settings, so a file
          // that lost them gets them back. User rows otherwise load verbatim.
          customSubagents: withBuiltinSubagents(
            raw.customSubagents === void 0 ? [] : normalizeCustomSubagents(raw.customSubagents)
          ),
          // Empty means "auto": resolveSttLanguage() then follows the UI direction.
          sttLanguage: typeof raw.sttLanguage === "string" ? raw.sttLanguage.trim().toLowerCase() : "fa",
          ttsProviderId: typeof raw.ttsProviderId === "string" && raw.ttsProviderId.trim() !== "local" ? raw.ttsProviderId.trim() : "",
          // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
          // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
          ttsModel: typeof raw.ttsModel === "string" ? raw.ttsModel.trim() : "tts-1",
          ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim() : "alloy",
          ttsFallbacks: normalizeTtsFallbacks(raw.ttsFallbacks),
          // Media generation slots (image / video). Empty id = not configured; the
          // agent tools then answer "configure an Image provider in Settings" like
          // STT/TTS do, instead of guessing a provider.
          imageProviderId: typeof raw.imageProviderId === "string" && raw.imageProviderId.trim() !== "local" ? raw.imageProviderId.trim() : "",
          imageModel: typeof raw.imageModel === "string" ? raw.imageModel.trim() : "gpt-image-1",
          imageFallbacks: normalizeMediaFallbacks(raw.imageFallbacks),
          videoProviderId: typeof raw.videoProviderId === "string" && raw.videoProviderId.trim() !== "local" ? raw.videoProviderId.trim() : "",
          videoModel: typeof raw.videoModel === "string" ? raw.videoModel.trim() : "sora-2",
          videoFallbacks: normalizeMediaFallbacks(raw.videoFallbacks),
          // Realtime speech-to-speech. All three empty means "not configured",
          // which makes live voice use the chunked STT + TTS pipeline instead.
          liveProviderId: typeof raw.liveProviderId === "string" ? raw.liveProviderId.trim() : "",
          liveModel: typeof raw.liveModel === "string" ? raw.liveModel.trim() : "",
          liveVoice: typeof raw.liveVoice === "string" ? raw.liveVoice.trim() : "",
          subagentModels: (() => {
            if (typeof raw.subagentModels !== "object" || raw.subagentModels === null) return {};
            return withOtherSlotsFilled(raw.subagentModels);
          })(),
          subagentThinking: (() => {
            if (raw.subagentThinking === void 0 || raw.subagentThinking === null) {
              return { explore: "low" };
            }
            if (typeof raw.subagentThinking !== "object") return {};
            const m = { ...raw.subagentThinking };
            for (const k of Object.keys(m)) m[k] === "max" && (m[k] = "xhigh");
            return m;
          })(),
          // Coerce numbers defensively: settings.json may round-trip numbers
          // through JSON safely, but the IPC layer or an older settings file
          // can hand us string-shaped digits ("30") or null. Accept anything that
          // coerces to a valid value rather than silently falling back to the
          // default — the user did set it, so don't erase their choice.
          cacheTtlMinutes: coercePositiveInt(raw.cacheTtlMinutes, 60),
          historyLimit: coerceNonNegInt(raw.historyLimit, 0),
          // The agent clamps this to [1500, 12000] when it builds the catalog, so a
          // hand-edited file cannot disable the skill list entirely.
          skillCatalogMaxChars: coerceBoundedInt(raw.skillCatalogMaxChars, 6e3, 1500, 12e3),
          // 0 is a valid, deliberate value (page fetch disabled) — keep it.
          webSearchAutoFetch: coerceBoundedInt(raw.webSearchAutoFetch, 5, 0, 10),
          // Hard desktop-control switch: absent/false in old settings files = OFF.
          computerUse: raw.computerUse === true,
          // Hard browsing switch: absent/false in old settings files = OFF, which is
          // also what stops the agent from opening a browser window on its own.
          browserUse: raw.browserUse === true,
          // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
          // are dropped here so they disappear from Settings → Plugins on reload.
          searchPlugins: searchPlugins.length > 0 ? searchPlugins : [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
          // Hand-edited or half-written rows are dropped rather than kept as a
          // broken source the browse UI would keep retrying: a marketplace with no
          // repo cannot be read at all.
          marketplaces: (() => {
            const rows = (Array.isArray(raw.marketplaces) ? raw.marketplaces : []).filter((m) => !!m && typeof m.repo === "string" && !!m.repo.trim()).map((m) => ({
              repo: m.repo.trim(),
              // The kind survives the round-trip: dropping it here silently
              // filed EVERY marketplace under the Plugins tab after a reload.
              ...m.kind ? { kind: m.kind } : {},
              ...m.label ? { label: m.label } : {},
              ...m.path ? { path: m.path } : {},
              ...m.git_ref ? { git_ref: m.git_ref } : {}
            }));
            const fileVersion = Number(
              raw.marketplaceDefaultsVersion ?? 0
            );
            if (!("marketplaces" in raw)) return DEFAULT_MARKETPLACES;
            return mergeShippedMarketplaces(
              rows,
              DEFAULT_MARKETPLACES,
              fileVersion,
              MARKETPLACE_DEFAULTS_VERSION
            );
          })(),
          // The file now CARRIES the current default set (the merge above applied
          // it), so it is stamped as such: re-running the merge on every launch
          // would keep re-adding the kinds it missed and never let the file settle.
          marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION,
          searchConsole: migratedSc,
          recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
          checkedModels: normalizeCheckedModels(raw.checkedModels),
          sidebarOpen: raw.sidebarOpen !== false,
          rightPanelOpen: raw.rightPanelOpen === true,
          workspaceColors: raw.workspaceColors ?? {},
          workspaceRunModes: normalizeWorkspaceRunModes(raw.workspaceRunModes),
          pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
          pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
          scheduleRunsSeen: normalizeScheduleRunsSeen(raw.scheduleRunsSeen),
          workspaces,
          activeWorkspaceKey,
          workspaceViews,
          workspaceLastUsedAt: initialWorkspaceBuckets?.lastUsedAt ?? {},
          chats: loadedChats,
          activeChatId: restoredView.activeChatId,
          openChatIds: restoredView.openChatIds,
          visibleChatIds: restoredView.visibleChatIds,
          chatWindowSizes: restoredView.chatWindowSizes,
          chatLayout: restoredView.chatLayout,
          chatTree: restoredView.chatTree,
          savedChatTree: restoredView.savedChatTree,
          windowFullscreenId: restoredView.windowFullscreenId,
          recentlyClosedChatTabs: restoredView.recentlyClosedChatTabs,
          // Self-clean pre-existing empty chats left on disk by older builds (a
          // fresh tab used to persist immediately). They stay usable in-memory
          // but are queued for file deletion on the next persist; live chats that
          // already have messages are untouched. In-memory-only empty tabs can
          // never appear here (they are filtered from disk writes), so this only
          // ever matches stale files.
          deletedChatIds: [
            .../* @__PURE__ */ new Set([
              ...get().deletedChatIds,
              // Self-clean stale empty chats left on disk by older builds (a fresh
              // tab used to persist immediately). Only chats whose BODY is really
              // in memory and empty qualify — an index-only row must never be
              // queued for deletion, or the migration's own rows would wipe the
              // sidebar on the first load.
              ...loadedChats.filter((c2) => c2.hydrated === true && (c2.messages?.length ?? 0) === 0).map((c2) => c2.id)
            ])
          ]
        });
        {
          const wanted = new Set(
            [activeId, ...openChatIds, ...visibleChatIds].filter(Boolean)
          );
          for (const id of wanted) void ensureChatTail(id);
        }
      },
      persist: () => {
        persistWorkspaceBuckets(get());
        if (get().anyStreaming()) {
          const now = Date.now();
          if (now - lastMidStreamPersist >= MID_STREAM_MS) {
            lastMidStreamPersist = now;
            writeChatsNow(get());
          } else {
            persistSoon();
          }
          return;
        }
        lastMidStreamPersist = 0;
        writeStateNow(get());
      },
      flushNow: () => {
        flushPendingPersist();
      },
      setProviderConfig: (patch) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map(
              (p) => p.id === s.settings.activeProviderId ? { ...p, ...patch } : p
            ),
            activeProviderId: s.settings.activeProviderId
          }
        }));
        get().persist();
      },
      updateProvider: (id, patch) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map(
              (p) => p.id === id ? normalizeProvider({ ...p, ...patch }) : p
            ),
            activeProviderId: s.settings.activeProviderId
          }
        }));
        get().persist();
      },
      addProvider: () => {
        const id = `custom-${Date.now().toString(36)}`;
        const provider = {
          id,
          // Nameless on purpose: the Settings form's Name input must open EMPTY.
          // UI labels fall back via providerDisplayName() until the user names it;
          // a Save (or the next load's normalizeProvider) backfills the kind name.
          name: "",
          kind: "custom",
          apiKeys: [],
          baseUrl: "",
          model: "",
          models: []
        };
        set((s) => ({
          settings: { ...s.settings, providers: [...s.settings.providers, provider] }
        }));
        get().persist();
        return id;
      },
      removeProvider: (id) => {
        set((s) => {
          const providers = s.settings.providers.filter((p) => p.id !== id);
          const out = providers.length > 0 ? providers : defaultProviders();
          const active = s.settings.activeProviderId === id || !out.some((p) => p.id === s.settings.activeProviderId) ? out[0].id : s.settings.activeProviderId;
          return {
            settings: { ...s.settings, providers: out, activeProviderId: active },
            // Tombstone the id: the store unions providers by id, so without this
            // the removed row would be restored by the next settings write.
            deletedProviderIds: s.deletedProviderIds.includes(id) ? s.deletedProviderIds : [...s.deletedProviderIds, id]
          };
        });
        get().persist();
      },
      setActiveProvider: (id) => {
        set((s) => {
          if (!s.settings.providers.some((p) => p.id === id)) return {};
          return { settings: { ...s.settings, activeProviderId: id } };
        });
        get().persist();
      },
      setProviderModels: (id, models) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map(
              (p) => p.id === id ? {
                ...p,
                models: Array.from(new Set(models.filter(Boolean))),
                // Explicitly re-added models are no longer hidden.
                removedModels: (p.removedModels ?? []).filter((m) => !models.includes(m)),
                // Manual models survive as long as they are still in the list.
                addedModels: (p.addedModels ?? []).filter((m) => models.includes(m))
              } : p
            )
          }
        }));
        get().persist();
      },
      // افزودن دستی یک مدل به پروایدر: هم به لیست ظاهری اضافه می‌شود و هم در
      // addedModels ثبت می‌شود تا فچ‌های بعدی (حتی ناموفق) آن را حذف نکنند.
      // افزودن دستی مدل + ثبت اختیاری کانتکست دستی؛ ورودی دستی کانتکست فقط برای
      // kind‌هایی معنا دارد که /models‌شان پنجره‌ی قابل‌اعتماد گزارش نمی‌کند
      // (`manualContextInput` در PROVIDER_META — همین یک رجیستری، بدون چک done‌شده‌ی kind).
      addManualModel: (id, model, contextTokens) => {
        const m = model.trim();
        if (!m) return;
        const ctx = typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens) : void 0;
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => {
              if (p.id !== id) return p;
              const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
              const acceptsManual = !!PROVIDER_META[p.kind]?.manualContextInput;
              const manual = ctx !== void 0 && acceptsManual ? { ...p.manualContextMap ?? {}, [bare]: ctx } : p.manualContextMap;
              return {
                ...p,
                models: Array.from(/* @__PURE__ */ new Set([...p.models ?? [], m])),
                addedModels: Array.from(/* @__PURE__ */ new Set([...p.addedModels ?? [], m])),
                removedModels: (p.removedModels ?? []).filter((x) => x !== m),
                ...manual !== void 0 ? { manualContextMap: manual } : {}
              };
            })
          }
        }));
        get().persist();
      },
      // ویرایش/حذف مقدار دستی کانتکست یک مدل دستی (کلید نرمال‌شده‌ی bare). مثل
      // افزودن، فقط برای kind‌های دارای manualContextInput اعمال می‌شود.
      setManualModelContext: (id, model, contextTokens) => {
        const m = model.trim();
        if (!m) return;
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => {
              if (p.id !== id) return p;
              if (!PROVIDER_META[p.kind]?.manualContextInput) return p;
              const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
              const next = { ...p.manualContextMap ?? {} };
              if (contextTokens === null || !(contextTokens > 0)) delete next[bare];
              else next[bare] = Math.floor(contextTokens);
              return { ...p, manualContextMap: next };
            })
          }
        }));
        get().persist();
      },
      // ثبت/حذف پرچم دستی reasoning برای یک مدل دستی (کلید نرمال‌شده‌ی bare).
      // برخلاف کانتکست، به kind گیت‌وی وابسته نیست: هر مدلی که کاربر دستی اضافه
      // کرده می‌تواند reasoning-capable اعلام شود تا pill تغییر effort در کامپوزر
      // نمایش داده شود و reasoning_effort به بک‌اند ارسال گردد.
      setManualModelReasoning: (id, model, reasoning) => {
        const m = model.trim();
        if (!m) return;
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => {
              if (p.id !== id) return p;
              const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
              const next = { ...p.manualReasoningMap ?? {} };
              if (reasoning === null) {
                delete next[bare];
                delete next[m];
              } else {
                next[bare] = reasoning;
              }
              return { ...p, manualReasoningMap: next };
            })
          }
        }));
        get().persist();
      },
      // حذف یک مدل دستی به‌همراه مقادیر دستی کانتکست و reasoning آن.
      removeManualModel: (id, model) => {
        const m = model.trim();
        if (!m) return;
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => {
              if (p.id !== id) return p;
              const bare = m.startsWith(`${p.id}/`) ? m.slice(p.id.length + 1) : m;
              const next = { ...p.manualContextMap ?? {} };
              delete next[bare];
              delete next[m];
              const nextReasoning = { ...p.manualReasoningMap ?? {} };
              delete nextReasoning[bare];
              delete nextReasoning[m];
              return {
                ...p,
                models: (p.models ?? []).filter((x) => x !== m),
                addedModels: (p.addedModels ?? []).filter((x) => x !== m),
                manualContextMap: next,
                manualReasoningMap: nextReasoning
              };
            })
          }
        }));
        get().persist();
      },
      setProviderContextMap: (id, contextMap) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => p.id === id ? { ...p, contextMap } : p)
          }
        }));
        get().persist();
      },
      setProviderPricingMap: (id, pricingMap) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => p.id === id ? { ...p, pricingMap } : p)
          }
        }));
        get().persist();
      },
      setProviderReasoningMap: (id, reasoningMap) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => p.id === id ? { ...p, reasoningMap } : p)
          }
        }));
        get().persist();
      },
      setProviderVisionMap: (id, visionMap) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => p.id === id ? { ...p, visionMap } : p)
          }
        }));
        get().persist();
      },
      /** Record that a provider+model DEMONSTRABLY reasoned (its response streamed
       *  reasoning content). Positive evidence only: a call that produced no
       *  reasoning proves nothing, so `false` is never written and a model that
       *  reasoned once stays marked. Stored under the RAW wire id — a gateway's id
       *  can itself be vendor-namespaced ("nvidia/nemotron-…"), so it must not be
       *  normalized against the provider id. A no-op once recorded, because this
       *  runs on every usage event of every step. */
      learnModelReasoning: (id, model) => {
        const m = model.trim();
        if (!m) return;
        const p = get().settings.providers.find((x) => x.id === id);
        if (!p || (p.observedReasoningMap ?? {})[m] === true) return;
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map(
              (row) => row.id === id ? {
                ...row,
                observedReasoningMap: { ...row.observedReasoningMap ?? {}, [m]: true }
              } : row
            )
          }
        }));
        get().persist();
      },
      setProviderThinkingLevelsMap: (id, thinkingLevelsMap) => {
        set((s) => ({
          settings: {
            ...s.settings,
            providers: s.settings.providers.map((p) => p.id === id ? { ...p, thinkingLevelsMap } : p)
          }
        }));
        get().persist();
      },
      // ترمیم خودکار ارجاع‌های مدلِ ازکاتالوگ‌رفته: وقتی لیست زنده‌ی /models
      // می‌آید، مدل‌های حذف‌شده/تغییرنام‌یافته‌ی پروایدر دیگر معتبر نیستند.
      // چت‌هایی که هنوز روی چنین مدلی هستند به اولین مدل معتبر برمی‌گردند و
      // recents همان پروایدر پاکسازی می‌شوند تا ارسال بعدی هرگز با خطای
      // «No such model» شکست نخورد. updatedAt عمداً دست نمی‌خورد تا ترتیب
      // چت‌ها در سایدبار جابه‌جا نشود.
      healStaleModels: (providerId, validModels) => {
        if (validModels.length === 0) return;
        const bare = (m) => m.startsWith(`${providerId}/`) ? m.slice(providerId.length + 1) : m;
        const valid = new Set(validModels.map(bare));
        const fallback = bare(validModels[0]);
        set((s) => ({
          chats: s.chats.map((c2) => {
            const owner = c2.providerId ?? s.settings.activeProviderId;
            if (owner !== providerId || !c2.model || valid.has(bare(c2.model))) return c2;
            return { ...c2, model: fallback };
          }),
          recentModels: s.recentModels.filter(
            (r) => r.providerId !== providerId || valid.has(bare(r.model))
          ),
          checkedModels: s.checkedModels.filter(
            (c2) => c2.providerId !== providerId || valid.has(bare(c2.model))
          )
        }));
        get().persist();
      },
      setMcpServers: (mcpServers) => {
        set((s) => ({ settings: { ...s.settings, mcpServers } }));
        get().persist();
      },
      addMcpServer: (name, cfg) => {
        set((s) => {
          const mcpServers = { ...s.settings.mcpServers ?? {}, [name]: cfg };
          return { settings: { ...s.settings, mcpServers } };
        });
        get().persist();
        void saveMcp(name, cfg);
      },
      updateMcpServer: (name, cfg) => {
        set((s) => {
          const mcpServers = { ...s.settings.mcpServers ?? {}, [name]: cfg };
          return { settings: { ...s.settings, mcpServers } };
        });
        get().persist();
        void saveMcp(name, cfg);
      },
      removeMcpServer: (name) => {
        if (get().builtinMcp.includes(name)) return;
        set((s) => {
          const mcpServers = { ...s.settings.mcpServers ?? {} };
          delete mcpServers[name];
          const mcpEnabled = (s.settings.mcpEnabled ?? []).filter((n) => n !== name);
          return { settings: { ...s.settings, mcpServers, mcpEnabled } };
        });
        get().persist();
        void deleteMcp(name);
      },
      setMcpEnabled: (name, on) => {
        set((s) => {
          const cur = new Set(s.settings.mcpEnabled ?? []);
          if (on) cur.add(name);
          else cur.delete(name);
          return { settings: { ...s.settings, mcpEnabled: [...cur] } };
        });
        get().persist();
      },
      setSystemPrompt: (mode, text) => {
        set((s) => ({
          settings: {
            ...s.settings,
            systemPrompts: { ...s.settings.systemPrompts ?? {}, [mode]: text }
          }
        }));
        get().persist();
      },
      setRunMode: (key, runMode) => {
        set((s) => ({ workspaceRunModes: { ...s.workspaceRunModes, [key]: runMode } }));
        get().persist();
      },
      activeRunMode: () => {
        const s = get();
        return normalizeRunMode(s.workspaceRunModes[s.activeWorkspaceKey]);
      },
      removeMode: (id) => {
        set((s) => {
          const modes = (s.settings.modes ?? []).filter((m) => m.id !== id);
          const systemPrompts = { ...s.settings.systemPrompts ?? {} };
          delete systemPrompts[id];
          return { settings: { ...s.settings, modes, systemPrompts } };
        });
        get().persist();
      },
      setRoot: (root) => {
        set({ root, outsideAllowed: false, outsideFolders: [] });
        get().persist();
      },
      setTheme: (theme) => {
        set({ theme });
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("coder:theme", theme);
        } catch {
        }
      },
      setFontSize: (fontSize) => {
        const n = Math.min(24, Math.max(10, Math.round(fontSize)));
        document.documentElement.style.setProperty("--chat-font-size", `${n}px`);
        set({ fontSize: n });
        get().persist();
      },
      setViewerFontSize: (viewerFontSize) => {
        const n = Math.min(24, Math.max(9, Math.round(viewerFontSize)));
        document.documentElement.style.setProperty("--viewer-font-size", `${n}px`);
        set({ viewerFontSize: n });
        get().persist();
      },
      setTerminalFontSize: (terminalFontSize) => {
        const n = Math.min(24, Math.max(9, Math.round(terminalFontSize)));
        document.documentElement.style.setProperty("--terminal-font-size", `${n}px`);
        applyTerminalFontSize(n);
        set({ terminalFontSize: n });
        get().persist();
      },
      setDataPath: (dataPath) => {
        set({ dataPath: (dataPath ?? "").trim() });
        get().persist();
      },
      setBackupPath: (backupPath) => {
        set({ backupPath: (backupPath ?? "").trim() });
        get().persist();
      },
      setUpdateFeedUrl: (url) => {
        set({ updateFeedUrl: (url ?? "").trim() });
        get().persist();
      },
      setSttProviderId: (id) => {
        set({ sttProviderId: (id ?? "").trim() });
        get().persist();
      },
      setSttModel: (m) => {
        set({ sttModel: (m ?? "").trim() || "whisper-1" });
        get().persist();
      },
      setSttFallbacks: (f) => {
        set({ sttFallbacks: normalizeSttFallbacks(f) });
        get().persist();
      },
      setCustomSubagents: (rows) => {
        set({ customSubagents: withBuiltinSubagents(normalizeCustomSubagents(rows)) });
        get().persist();
      },
      setToolFallbacks: (slot, rows) => {
        set((s) => {
          const toolFallbacks = { ...s.toolFallbacks };
          const clean = normalizeToolFallbackRows(rows);
          if (clean.length) toolFallbacks[slot] = clean;
          else delete toolFallbacks[slot];
          return { toolFallbacks };
        });
        get().persist();
      },
      setSttLanguage: (l) => {
        set({ sttLanguage: (l ?? "").trim().toLowerCase() });
        get().persist();
      },
      setLiveProviderId: (id) => {
        set({ liveProviderId: (id ?? "").trim() });
        get().persist();
      },
      setLiveModel: (m) => {
        set({ liveModel: (m ?? "").trim() });
        get().persist();
      },
      setLiveVoice: (v) => {
        set({ liveVoice: (v ?? "").trim() });
        get().persist();
      },
      setLiveVoiceSession: (liveVoiceChatId, state) => {
        set({ liveVoiceChatId, liveVoiceState: state });
      },
      setTtsProviderId: (id) => {
        set({ ttsProviderId: (id ?? "").trim() });
        get().persist();
      },
      setTtsModel: (m) => {
        set({ ttsModel: (m ?? "").trim() });
        get().persist();
      },
      setTtsVoice: (v) => {
        set({ ttsVoice: (v ?? "").trim() });
        get().persist();
      },
      setTtsFallbacks: (f) => {
        set({ ttsFallbacks: normalizeTtsFallbacks(f) });
        get().persist();
      },
      setImageProviderId: (id) => {
        set({ imageProviderId: (id ?? "").trim() });
        get().persist();
      },
      setImageModel: (m) => {
        set({ imageModel: (m ?? "").trim() });
        get().persist();
      },
      setImageFallbacks: (f) => {
        set({ imageFallbacks: normalizeMediaFallbacks(f) });
        get().persist();
      },
      setVideoProviderId: (id) => {
        set({ videoProviderId: (id ?? "").trim() });
        get().persist();
      },
      setVideoModel: (m) => {
        set({ videoModel: (m ?? "").trim() });
        get().persist();
      },
      setVideoFallbacks: (f) => {
        set({ videoFallbacks: normalizeMediaFallbacks(f) });
        get().persist();
      },
      setWebSearchAutoFetch: (n) => {
        const r = Math.round(n);
        set({ webSearchAutoFetch: Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 5 });
        get().persist();
      },
      setSubagentModel: (agent, model) => {
        set((s) => {
          const subagentModels = { ...s.subagentModels };
          if (model) subagentModels[agent] = model;
          else delete subagentModels[agent];
          return { subagentModels };
        });
        get().persist();
        void pushSlotModel(agent, model);
      },
      setSubagentThinking: (agent, level) => {
        set((s) => {
          const subagentThinking = { ...s.subagentThinking };
          if (level) subagentThinking[agent] = level;
          else delete subagentThinking[agent];
          return { subagentThinking };
        });
        get().persist();
      },
      setMemoryTtlConfig: (c2) => {
        set({
          cacheTtlMinutes: typeof c2.cache === "number" && c2.cache > 0 ? Math.round(c2.cache) : get().cacheTtlMinutes
        });
        get().persist();
      },
      setHistoryLimit: (n) => {
        set({ historyLimit: Math.max(0, Math.round(n) || 0) });
        get().persist();
      },
      setSkillCatalogMaxChars: (n) => {
        set({ skillCatalogMaxChars: Math.min(12e3, Math.max(1500, Math.round(n) || 6e3)) });
        get().persist();
      },
      setSearchPlugins: (plugins) => {
        set({ searchPlugins: plugins });
        get().persist();
      },
      setMarketplaces: (marketplaces) => {
        set({ marketplaces });
        get().persist();
      },
      setSearchConsole: (patch) => {
        set((s) => ({ searchConsole: { ...s.searchConsole, ...patch } }));
        get().persist();
      },
      setSidebarOpen: (sidebarOpen) => {
        set({ sidebarOpen });
        persistPanelsSoon();
      },
      toggleSidebar: () => {
        const next = !get().sidebarOpen;
        get().setSidebarOpen(next);
      },
      setRightPanelOpen: (rightPanelOpen) => {
        set({ rightPanelOpen });
        persistPanelsSoon();
      },
      toggleRightPanel: () => {
        const next = !get().rightPanelOpen;
        get().setRightPanelOpen(next);
      },
      setTerminalPanelOpen: (terminalPanelOpen) => {
        set((s) => ({
          terminalPanelOpen,
          terminalFullscreen: terminalPanelOpen ? s.terminalFullscreen : false
        }));
        persistTerminalPanel(terminalPanelOpen);
        if (!terminalPanelOpen) persistTerminalFullscreen(false);
      },
      toggleTerminalPanel: () => {
        const next = !get().terminalPanelOpen;
        get().setTerminalPanelOpen(next);
      },
      setTerminalFullscreen: (v) => {
        if (v && !get().terminalPanelOpen) get().setTerminalPanelOpen(true);
        persistTerminalFullscreen(v);
        set({ terminalFullscreen: v });
      },
      toggleTerminalFullscreen: () => {
        get().setTerminalFullscreen(!get().terminalFullscreen);
      },
      setTerminalHeight: (px) => {
        const next = clampTerminalHeight(px);
        persistTerminalHeight(next);
        set({ terminalHeight: next });
      },
      setRecentModels: (recentModels) => {
        set({ recentModels });
        get().persist();
      },
      setCheckedModels: (checkedModels) => {
        set({ checkedModels: capCheckedModels(checkedModels) });
        get().persist();
      },
      addRecentModel: (model, providerId) => {
        const m = (model || "").trim();
        if (!m) return;
        const pid = providerId || "";
        const now = Date.now();
        set((s) => {
          const prev = s.recentModels.find((x) => x.model === m && x.providerId === pid);
          const pinned = prev?.pinned === true;
          const rest = s.recentModels.filter((x) => x.model !== m || x.providerId !== pid);
          const entry = { providerId: pid, model: m, lastUsed: now, ...pinned ? { pinned: true } : {} };
          const pinnedRest = sortRecentModels(rest.filter((x) => x.pinned)).slice(0, MAX_PINNED_RECENT_MODELS);
          const unpinnedRest = sortRecentModels(rest.filter((x) => !x.pinned));
          const recentModels = pinned ? [entry, ...pinnedRest, ...unpinnedRest].slice(0, 20) : [...pinnedRest, entry, ...unpinnedRest].slice(0, 20);
          return { recentModels };
        });
        get().persist();
      },
      removeRecentModel: (model, providerId) => {
        const m = (model || "").trim();
        if (!m) return;
        const pid = providerId || "";
        set((s) => ({
          recentModels: s.recentModels.filter((x) => x.model !== m || x.providerId !== pid || x.pinned)
        }));
        get().persist();
      },
      togglePinRecentModel: (model, providerId) => {
        const m = (model || "").trim();
        if (!m) return false;
        const pid = providerId || "";
        let pinnedNow = false;
        let changed = false;
        set((s) => {
          const target = s.recentModels.find((x) => x.model === m && x.providerId === pid);
          if (!target) return {};
          if (target.pinned) {
            changed = true;
            return { recentModels: sortRecentModels(s.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: void 0 } : x)) };
          }
          if (s.recentModels.filter((x) => x.pinned).length >= MAX_PINNED_RECENT_MODELS) return {};
          pinnedNow = true;
          changed = true;
          return { recentModels: sortRecentModels(s.recentModels.map((x) => x.model === m && x.providerId === pid ? { ...x, pinned: true } : x)) };
        });
        if (changed) get().persist();
        return pinnedNow;
      },
      newChat: (mode) => {
        const chat = makeChat(mode ?? "ask");
        const s = useStore.getState();
        const key = s.activeWorkspaceKey;
        const root = workspaceRootForKey(s, key);
        chat.root = root || void 0;
        const activeChatId = chat.id;
        set((st) => {
          const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
          persistOpenState(openChatIds, activeChatId);
          const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
          const workspaceLastUsedAt = { ...st.workspaceLastUsedAt, [key]: Date.now() };
          if (single) {
            persistVisibleChats([activeChatId]);
            persistChatTree(null);
            return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false, workspaceLastUsedAt };
          }
          const base2 = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
          const chatTree = openBeside(base2, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
          return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false, workspaceLastUsedAt };
        });
        get().persist();
        focusChatInputSoon(activeChatId);
        return activeChatId;
      },
      newChatInRoot: (root, mode) => {
        const key = workspaceKey(root ?? "");
        if (!get().workspaces.some((w) => w.key === key)) get().createWorkspace(root ?? "");
        if (get().activeWorkspaceKey !== key) get().switchWorkspace(key);
        return get().newChat(mode);
      },
      createWorkspace: (root) => {
        const key = workspaceKey(root ?? "");
        const ws = makeWorkspace(root ?? "");
        set((s) => {
          const workspaces = s.workspaces.some((w) => w.key === key) ? s.workspaces : [...s.workspaces, ws];
          return { workspaces };
        });
        get().persist();
        return key;
      },
      switchWorkspace: (key) => {
        const s = get();
        const now = Date.now();
        const lastUsedAt = { ...s.workspaceLastUsedAt, [key]: now };
        if (key === s.activeWorkspaceKey) {
          set({ workspaceLastUsedAt: lastUsedAt });
          persistWorkspaceBuckets(useStore.getState());
          return;
        }
        const views = { ...s.workspaceViews };
        views[s.activeWorkspaceKey] = sanitizeWorkspaceView(
          liveWorkspaceView(s),
          s.chats,
          s.activeWorkspaceKey,
          s.chatLayout
        );
        const restored = sanitizeWorkspaceView(
          views[key],
          s.chats,
          key,
          s.chatLayout
        );
        views[key] = restored;
        const nextRoot = workspaceRootForKey(s, key);
        set({
          activeWorkspaceKey: key,
          workspaceViews: views,
          workspaceLastUsedAt: lastUsedAt,
          ...viewFields(restored),
          // Moving into another project re-arms the outside-workspace permission
          // prompts, exactly like setRoot does.
          root: nextRoot,
          outsideAllowed: false,
          outsideFolders: []
        });
        persistViewToLegacy(restored);
        persistWorkspaceBuckets(useStore.getState());
      },
      requestWorkspaceListFocus: () => {
        set((s) => ({ workspaceListFocusSeq: s.workspaceListFocusSeq + 1 }));
      },
      requestSidebarFocus: () => {
        set((s) => ({ sidebarFocusSeq: s.sidebarFocusSeq + 1 }));
      },
      setWorkspaceOrder: (keys) => {
        set((s) => {
          const ordered = [...keys].map((k) => s.workspaces.find((w) => w.key === k)).filter((w) => Boolean(w));
          const known = new Set(ordered.map((w) => w.key));
          for (const w of s.workspaces) if (!known.has(w.key)) ordered.push(w);
          return { workspaces: ordered };
        });
        get().persist();
      },
      deleteChat: (id) => {
        abortChatStream(get().chatAborts[id]);
        historyStacks.delete(id);
        set((s) => {
          const chats = s.chats.filter((c2) => c2.id !== id);
          const openChatIds = s.openChatIds.filter((cid) => cid !== id);
          let activeChatId = s.activeChatId;
          if (s.activeChatId === id) {
            const idx = s.openChatIds.indexOf(id);
            const remaining = openChatIds;
            activeChatId = remaining[Math.min(Math.max(idx - 1, 0), remaining.length - 1)] ?? chats[chats.length - 1]?.id ?? "";
            if (!remaining.includes(activeChatId) && activeChatId) remaining.push(activeChatId);
          }
          const finalOpen = openChatIds.includes(activeChatId) || !activeChatId ? openChatIds : [...openChatIds, activeChatId];
          persistOpenState(finalOpen, activeChatId);
          const validIds = new Set(chats.map((c2) => c2.id));
          const baseTree = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const normalized = normalizeTree(removeChat(baseTree, id), validIds);
          const fallbackVisible = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          const chatWindowSizes = mirrors.chatWindowSizes;
          const chatAborts = { ...s.chatAborts };
          delete chatAborts[id];
          const chatBusy = { ...s.chatBusy };
          delete chatBusy[id];
          const workspaceViews = { ...s.workspaceViews };
          for (const [key, view] of Object.entries(workspaceViews)) {
            if (key === s.activeWorkspaceKey) continue;
            const held = view.activeChatId === id || view.openChatIds.includes(id) || view.visibleChatIds.includes(id) || view.recentlyClosedChatTabs.some((r) => r.id === id) || (view.chatTree ? containsChat(view.chatTree, id) : false);
            if (held) workspaceViews[key] = sanitizeWorkspaceView(view, chats, key, s.chatLayout);
          }
          return {
            chats,
            activeChatId,
            openChatIds: finalOpen,
            visibleChatIds,
            chatWindowSizes,
            chatTree,
            chatAborts,
            chatBusy,
            workspaceViews,
            deletedChatIds: [...s.deletedChatIds, id],
            pinnedChats: s.pinnedChats.filter((k) => k !== id),
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        get().persist();
        runChatDeleteHooks([id]);
      },
      deleteWorkspace: (key) => {
        const doomed = get().chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id);
        for (const id of doomed) {
          abortChatStream(get().chatAborts[id]);
          historyStacks.delete(id);
        }
        set((s) => {
          const chats = s.chats.filter((c2) => workspaceKey(c2.root ?? "") !== key);
          const workspaces = s.workspaces.filter((w) => w.key !== key);
          const doomedIds = new Set(
            s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id)
          );
          const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key);
          const pinnedChats = s.pinnedChats.filter((k) => !doomedIds.has(k));
          const chatAborts = { ...s.chatAborts };
          for (const id of doomed) delete chatAborts[id];
          const workspaceLastUsedAt = { ...s.workspaceLastUsedAt };
          delete workspaceLastUsedAt[key];
          const workspaceViews = {};
          for (const [k, view] of Object.entries(s.workspaceViews)) {
            if (k === key) continue;
            workspaceViews[k] = sanitizeWorkspaceView(view, chats, k, s.chatLayout);
          }
          const deletedChatIds = s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id);
          const deletedWorkspaceRoots = s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.root ?? "");
          if (s.activeWorkspaceKey !== key) {
            const live = sanitizeWorkspaceView(
              liveWorkspaceView(s),
              chats,
              s.activeWorkspaceKey,
              s.chatLayout
            );
            workspaceViews[s.activeWorkspaceKey] = live;
            persistViewToLegacy(live);
            return {
              ...viewFields(live),
              chats,
              workspaces,
              pinnedWorkspaces,
              pinnedChats,
              chatAborts,
              workspaceViews,
              workspaceLastUsedAt,
              unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
              deletedChatIds: [...s.deletedChatIds, ...deletedChatIds],
              deletedWorkspaceRoots: [...s.deletedWorkspaceRoots, ...deletedWorkspaceRoots]
            };
          }
          const candidates = /* @__PURE__ */ new Set();
          for (const w of workspaces) candidates.add(w.key);
          for (const c2 of chats) candidates.add(workspaceKey(c2.root ?? ""));
          const fallbackKey = [...candidates].sort(
            (a, b) => (workspaceLastUsedAt[b] ?? 0) - (workspaceLastUsedAt[a] ?? 0)
          )[0] ?? "__none__";
          const restored = workspaceViews[fallbackKey] ?? sanitizeWorkspaceView(void 0, chats, fallbackKey, s.chatLayout);
          workspaceViews[fallbackKey] = restored;
          persistViewToLegacy(restored);
          return {
            ...viewFields(restored),
            chats,
            workspaces,
            pinnedWorkspaces,
            pinnedChats,
            chatAborts,
            activeWorkspaceKey: fallbackKey,
            workspaceViews,
            workspaceLastUsedAt,
            root: workspaceRootForKey({ workspaces, chats }, fallbackKey),
            outsideAllowed: false,
            outsideFolders: [],
            unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
            deletedChatIds: [...s.deletedChatIds, ...deletedChatIds],
            deletedWorkspaceRoots: [...s.deletedWorkspaceRoots, ...deletedWorkspaceRoots]
          };
        });
        get().persist();
        runChatDeleteHooks(doomed);
      },
      setWorkspaceColor: (key, color) => {
        set((s) => {
          const workspaceColors = { ...s.workspaceColors };
          if (color) workspaceColors[key] = color;
          else delete workspaceColors[key];
          return { workspaceColors };
        });
        get().persist();
      },
      togglePinWorkspace: (key) => {
        set((s) => {
          const wasPinned = s.pinnedWorkspaces.includes(key);
          const pinnedWorkspaces = wasPinned ? s.pinnedWorkspaces.filter((k) => k !== key) : [key, ...s.pinnedWorkspaces];
          return { pinnedWorkspaces };
        });
        get().persist();
      },
      renameWorkspace: (key, label) => {
        set((s) => ({
          workspaces: s.workspaces.map(
            (w) => w.key === key ? { ...w, label } : w
          )
        }));
        get().persist();
      },
      moveWorkspace: (key, root) => {
        const trimmed = (root ?? "").trim();
        const nextRoot = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
        const nextKey = workspaceKey(nextRoot);
        const prev = get().workspaces.find((w) => w.key === key);
        const prevRoot = prev?.root ?? get().chats.find((c2) => workspaceKey(c2.root ?? "") === key)?.root ?? "";
        if (nextKey === key) {
          set((s) => ({
            workspaces: s.workspaces.map(
              (w) => w.key === key ? { ...w, root: nextRoot || null } : w
            ),
            chats: s.chats.map(
              (c2) => workspaceKey(c2.root ?? "") === key ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
            ),
            root: s.root === prevRoot ? nextRoot : s.root
          }));
          get().persist();
          return key;
        }
        if (!prev && get().chats.every((c2) => workspaceKey(c2.root ?? "") !== key)) {
          get().createWorkspace(nextRoot);
          return nextKey;
        }
        set((s) => {
          const targetExists = s.workspaces.some((w) => w.key === nextKey);
          const prevLabel = prev?.label ?? workspaceLabel(prevRoot);
          const label = prev && prevLabel !== workspaceLabel(prevRoot) ? prevLabel : workspaceLabel(nextRoot);
          let workspaces;
          if (targetExists) {
            workspaces = s.workspaces.filter((w) => w.key !== key).map((w) => w.key === nextKey ? { ...w, root: nextRoot || null } : w);
          } else {
            workspaces = s.workspaces.map(
              (w) => w.key === key ? { ...w, key: nextKey, root: nextRoot || null, label } : w
            );
          }
          const workspaceColors = { ...s.workspaceColors };
          if (workspaceColors[key] !== void 0 && workspaceColors[nextKey] === void 0) {
            workspaceColors[nextKey] = workspaceColors[key];
          }
          delete workspaceColors[key];
          const workspaceRunModes = { ...s.workspaceRunModes };
          if (workspaceRunModes[key] !== void 0 && workspaceRunModes[nextKey] === void 0) {
            workspaceRunModes[nextKey] = workspaceRunModes[key];
          }
          delete workspaceRunModes[key];
          const chats = s.chats.map(
            (c2) => workspaceKey(c2.root ?? "") === key ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
          );
          const workspaceViews = { ...s.workspaceViews };
          const movingView = s.activeWorkspaceKey === key ? liveWorkspaceView(s) : workspaceViews[key];
          delete workspaceViews[key];
          const movingSanitized = movingView ? sanitizeWorkspaceView(movingView, chats, nextKey, s.chatLayout) : null;
          if (movingSanitized) {
            const dest = workspaceViews[nextKey];
            workspaceViews[nextKey] = dest ? mergeWorkspaceViews(
              sanitizeWorkspaceView(dest, chats, nextKey, s.chatLayout),
              movingSanitized,
              s.chatLayout
            ) : movingSanitized;
          }
          const workspaceLastUsedAt = { ...s.workspaceLastUsedAt };
          if (workspaceLastUsedAt[key] !== void 0) {
            workspaceLastUsedAt[nextKey] = Math.max(
              workspaceLastUsedAt[nextKey] ?? 0,
              workspaceLastUsedAt[key]
            );
            delete workspaceLastUsedAt[key];
          }
          const base2 = {
            workspaces,
            chats,
            workspaceColors,
            workspaceRunModes,
            pinnedWorkspaces: s.pinnedWorkspaces.map((k) => k === key ? nextKey : k),
            workspaceViews,
            workspaceLastUsedAt,
            deletedWorkspaceRoots: prevRoot ? [...s.deletedWorkspaceRoots, prevRoot] : s.deletedWorkspaceRoots
          };
          if (s.activeWorkspaceKey === key) {
            const restored = workspaceViews[nextKey] ?? emptyWorkspaceView(s.chatLayout);
            workspaceViews[nextKey] = restored;
            persistViewToLegacy(restored);
            return {
              ...base2,
              ...viewFields(restored),
              activeWorkspaceKey: nextKey,
              root: nextRoot,
              outsideAllowed: false,
              outsideFolders: []
            };
          }
          if (s.activeWorkspaceKey === nextKey) {
            delete workspaceViews[nextKey];
            const openChatIds = [...s.openChatIds];
            if (movingSanitized) {
              for (const id of movingSanitized.openChatIds) {
                if (!openChatIds.includes(id)) openChatIds.push(id);
              }
            }
            persistOpenState(openChatIds, s.activeChatId);
            return { ...base2, openChatIds };
          }
          return { ...base2 };
        });
        get().persist();
        return nextKey;
      },
      togglePinChat: (id) => {
        set((s) => {
          const wasPinned = s.pinnedChats.includes(id);
          const pinnedChats = wasPinned ? s.pinnedChats.filter((k) => k !== id) : [id, ...s.pinnedChats];
          return { pinnedChats };
        });
        get().persist();
      },
      setActiveChat: (id) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (target && workspaceKey(target.root ?? "") !== get().activeWorkspaceKey) {
          get().switchWorkspace(workspaceKey(target.root ?? ""));
        }
        set((s) => {
          const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
          persistOpenState(openChatIds, id);
          const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1;
          let chatTree = s.chatTree;
          let visibleChatIds = s.visibleChatIds;
          let chatWindowSizes = s.chatWindowSizes;
          let chatLayout = s.chatLayout;
          if (single) {
            visibleChatIds = [id];
            chatTree = null;
            persistVisibleChats(visibleChatIds);
            persistChatTree(null);
          } else if (!containsChat(chatTree, id)) {
            const base2 = ensureTree(chatTree, visibleChatIds, s.chatLayout);
            chatTree = openBeside(base2, id, s.activeChatId, smartAppendDir(s.chatLayout));
            const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
            visibleChatIds = mirrors.visibleChatIds;
            chatWindowSizes = mirrors.chatWindowSizes;
            chatLayout = mirrors.chatLayout;
          }
          return {
            activeChatId: id,
            openChatIds,
            visibleChatIds,
            chatTree,
            chatWindowSizes,
            chatLayout,
            // Opening a chat clears its green "new message" dot.
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      openChat: (id) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (!target) return;
        if (workspaceKey(target.root ?? "") !== get().activeWorkspaceKey) {
          get().switchWorkspace(workspaceKey(target.root ?? ""));
        }
        set((s) => {
          if (!s.chats.some((c2) => c2.id === id)) return {};
          const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
          persistOpenState(openChatIds, id);
          const single = leafCount(s.chatTree) <= 1 && s.visibleChatIds.length <= 1;
          let chatTree = s.chatTree;
          let visibleChatIds = s.visibleChatIds;
          let chatWindowSizes = s.chatWindowSizes;
          let chatLayout = s.chatLayout;
          if (single) {
            visibleChatIds = [id];
            chatTree = null;
            persistVisibleChats(visibleChatIds);
            persistChatTree(null);
          } else if (!containsChat(chatTree, id)) {
            const base2 = ensureTree(chatTree, visibleChatIds, s.chatLayout);
            chatTree = openBeside(base2, id, s.activeChatId, smartAppendDir(s.chatLayout));
            const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
            visibleChatIds = mirrors.visibleChatIds;
            chatWindowSizes = mirrors.chatWindowSizes;
            chatLayout = mirrors.chatLayout;
          }
          return {
            activeChatId: id,
            openChatIds,
            visibleChatIds,
            chatTree,
            chatWindowSizes,
            chatLayout,
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      closeChatTab: (id) => {
        set((s) => {
          if (!s.openChatIds.includes(id)) return {};
          const idx = s.openChatIds.indexOf(id);
          const openChatIds = s.openChatIds.filter((cid) => cid !== id);
          let activeChatId = s.activeChatId;
          if (s.activeChatId === id) {
            activeChatId = openChatIds[Math.min(idx, openChatIds.length - 1)] ?? "";
          }
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(s.chats.map((c2) => c2.id));
          const baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const normalizedCt = normalizeTree(removeChat(baseTreeCt, id), validIds);
          const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout);
          const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
          const recentlyClosedChatTabs = s.chats.some((c2) => c2.id === id) ? [{ id, at: Date.now() }, ...s.recentlyClosedChatTabs.filter((r) => r.id !== id)].slice(0, 8) : s.recentlyClosedChatTabs;
          return { openChatIds, activeChatId, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
        });
        persistSoon();
      },
      closeInactiveChatTabs: () => {
        let closed = [];
        set((s) => {
          const streaming = new Set(
            s.chats.filter((c2) => c2.messages.some((m) => m.streaming || m.retry?.reconnecting === true)).map((c2) => c2.id)
          );
          const visible = new Set(s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds);
          const toClose = s.openChatIds.filter(
            (id) => id !== s.activeChatId && !streaming.has(id) && !visible.has(id)
          );
          if (toClose.length === 0) return {};
          closed = toClose;
          const drop = new Set(toClose);
          const openChatIds = s.openChatIds.filter((cid) => !drop.has(cid));
          persistOpenState(openChatIds, s.activeChatId);
          const validIds = new Set(s.chats.map((c2) => c2.id));
          let baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          for (const id of toClose) {
            if (!baseTreeCt) break;
            baseTreeCt = removeChat(baseTreeCt, id);
          }
          const normalizedCt = normalizeTree(baseTreeCt, validIds);
          const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !drop.has(cid)), validIds, s.activeChatId);
          const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout);
          const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
          const now = Date.now();
          const kept = toClose.filter((id) => s.chats.some((c2) => c2.id === id));
          const recentlyClosedChatTabs = [
            ...kept.map((id, i) => ({ id, at: now - i })),
            ...s.recentlyClosedChatTabs.filter((r) => !drop.has(r.id))
          ].slice(0, 8);
          return { openChatIds, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
        });
        persistSoon();
        return closed;
      },
      reopenChatTab: (id) => {
        set((s) => ({
          recentlyClosedChatTabs: s.recentlyClosedChatTabs.filter((r) => r.id !== id)
        }));
        get().openChat(id);
      },
      moveChatTab: (fromId, toId, after = false) => {
        set((s) => {
          const from = s.openChatIds.indexOf(fromId);
          if (from === -1 || !s.openChatIds.includes(toId) || fromId === toId) return {};
          const rest = s.openChatIds.filter((cid) => cid !== fromId);
          let dest = rest.indexOf(toId) + (after ? 1 : 0);
          dest = Math.max(0, Math.min(rest.length, dest));
          const openChatIds = rest.slice();
          openChatIds.splice(dest, 0, fromId);
          persistOpenState(openChatIds, fromId);
          return {
            openChatIds,
            activeChatId: fromId,
            unreadChats: s.unreadChats.filter((cid) => cid !== fromId)
          };
        });
        persistSoon();
      },
      openInWindow: (id) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (!target) return;
        if (workspaceKey(target.root ?? "") !== get().activeWorkspaceKey) {
          get().switchWorkspace(workspaceKey(target.root ?? ""));
        }
        set((s) => {
          if (!s.chats.some((c2) => c2.id === id)) return {};
          const base2 = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [s.activeChatId], s.chatLayout);
          const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
          persistOpenState(openChatIds, id);
          const chatTree = containsChat(base2, id) ? base2 : openBeside(base2, id, s.activeChatId, smartAppendDir(s.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          return {
            activeChatId: id,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      toggleChatWindows: () => {
        set((s) => {
          const treeIds = s.chatTree ? collectChatIds(s.chatTree) : [];
          const visibleIds = treeIds.length > 0 ? treeIds : s.visibleChatIds;
          if (visibleIds.length > 1) {
            const activeChatId = s.activeChatId && visibleIds.includes(s.activeChatId) ? s.activeChatId : visibleIds[visibleIds.length - 1] ?? "";
            if (!activeChatId) return {};
            const savedChatTree = s.chatTree ?? buildFromList(visibleIds, treeDirFromLayout(s.chatLayout));
            persistSavedChatTree(savedChatTree);
            persistVisibleChats([activeChatId]);
            persistChatTree(null);
            persistWindowSizes({});
            return { savedChatTree, chatTree: null, visibleChatIds: [activeChatId], chatWindowSizes: {}, activeChatId };
          }
          const validIds = new Set(s.chats.map((c2) => c2.id));
          const chatTree = restoreMultiTree(s.savedChatTree, s.openChatIds, validIds, s.activeChatId, treeDirFromLayout(s.chatLayout));
          if (!chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          return {
            chatTree,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout
          };
        });
        persistSoon();
      },
      closeWindow: (id) => {
        set((s) => {
          const treeIds = s.chatTree ? collectChatIds(s.chatTree) : [];
          const ids = treeIds.length > 0 ? treeIds : s.visibleChatIds;
          if (!ids.includes(id) && !s.visibleChatIds.includes(id)) return {};
          if ((/* @__PURE__ */ new Set([...treeIds, ...s.visibleChatIds])).size <= 1 && ids.length <= 1) return {};
          const idx = ids.indexOf(id);
          const base2 = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const pruned = removeChat(base2, id);
          const fallbackVisible = (s.visibleChatIds.length > 0 ? s.visibleChatIds : ids).filter((cid) => cid !== id);
          const chatTree = pruned ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          let activeChatId = s.activeChatId;
          if (s.activeChatId === id) {
            activeChatId = visibleChatIds[Math.min(Math.max(idx, 0), visibleChatIds.length - 1)] ?? "";
          }
          if (activeChatId !== s.activeChatId) persistOpenState(s.openChatIds, activeChatId);
          const windowFullscreenId = s.windowFullscreenId === id ? null : s.windowFullscreenId;
          if (s.windowFullscreenId === id) persistWindowFullscreen(null);
          return {
            visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            activeChatId,
            windowFullscreenId,
            unreadChats: s.unreadChats.filter((cid) => cid !== activeChatId)
          };
        });
      },
      focusWindow: (id) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (target && workspaceKey(target.root ?? "") !== get().activeWorkspaceKey) {
          get().switchWorkspace(workspaceKey(target.root ?? ""));
        }
        set((s) => {
          if (!s.chats.some((c2) => c2.id === id)) return {};
          if (s.activeChatId === id) return {};
          const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
          persistOpenState(openChatIds, id);
          let chatTree = s.chatTree;
          let visibleChatIds = s.visibleChatIds;
          let chatWindowSizes = s.chatWindowSizes;
          let chatLayout = s.chatLayout;
          if (!containsChat(chatTree, id)) {
            if (leafCount(chatTree) <= 1 && visibleChatIds.length <= 1) {
              visibleChatIds = [id];
              chatTree = null;
              persistVisibleChats(visibleChatIds);
              persistChatTree(null);
            } else {
              const base2 = ensureTree(chatTree, visibleChatIds, s.chatLayout);
              chatTree = openBeside(base2, id, s.activeChatId, smartAppendDir(s.chatLayout));
              const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
              visibleChatIds = mirrors.visibleChatIds;
              chatWindowSizes = mirrors.chatWindowSizes;
              chatLayout = mirrors.chatLayout;
            }
          }
          return {
            activeChatId: id,
            openChatIds,
            visibleChatIds,
            chatTree,
            chatWindowSizes,
            chatLayout,
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        persistSoon();
      },
      moveWindow: (fromId, toId, after = false) => {
        set((s) => {
          if (s.chatTree) {
            const base2 = ensureTree(s.chatTree, s.visibleChatIds, s.chatLayout);
            if (!base2) return {};
            const flatDir = base2.kind === "split" ? base2.dir : treeDirFromLayout(s.chatLayout);
            const isFlat = base2.kind !== "split" || base2.children.every((c2) => c2.kind === "leaf");
            const root = isFlat && base2.kind === "split" ? base2 : buildFromList(collectChatIds(base2), flatDir);
            if (!root || root.kind !== "split") return {};
            const ids = collectChatIds(root);
            if (!ids.includes(fromId) || !ids.includes(toId) || fromId === toId) return {};
            const rest2 = ids.filter((cid) => cid !== fromId);
            let dest2 = rest2.indexOf(toId) + (after ? 1 : 0);
            dest2 = Math.max(0, Math.min(rest2.length, dest2));
            const ordered = rest2.slice();
            ordered.splice(dest2, 0, fromId);
            const sizes = sizesByChat(base2);
            const chatTree = buildFromList(ordered, root.dir, sizes);
            const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
            return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
          }
          const from = s.visibleChatIds.indexOf(fromId);
          if (from === -1 || !s.visibleChatIds.includes(toId) || fromId === toId) return {};
          const rest = s.visibleChatIds.filter((cid) => cid !== fromId);
          let dest = rest.indexOf(toId) + (after ? 1 : 0);
          dest = Math.max(0, Math.min(rest.length, dest));
          const visibleChatIds = rest.slice();
          visibleChatIds.splice(dest, 0, fromId);
          persistVisibleChats(visibleChatIds);
          return { visibleChatIds };
        });
        persistSoon();
      },
      setWindowSize: (id, size) => {
        const clamped = Number.isFinite(size) ? Math.max(0.25, Math.min(4, size)) : 1;
        set((s) => {
          const ids = s.chatTree ? collectChatIds(s.chatTree) : s.visibleChatIds;
          if (!ids.includes(id)) return {};
          if (s.chatTree) {
            const chatTree = setChatSize(s.chatTree, id, clamped);
            const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
            return { chatTree, chatWindowSizes: mirrors.chatWindowSizes, visibleChatIds: mirrors.visibleChatIds, chatLayout: mirrors.chatLayout };
          }
          const chatWindowSizes = { ...s.chatWindowSizes, [id]: clamped };
          persistWindowSizes(chatWindowSizes);
          return { chatWindowSizes };
        });
      },
      setChatLayout: (layout) => {
        const next = normalizeChatLayout(layout);
        set((s) => {
          if (s.chatTree && s.chatTree.kind === "split") {
            const chatTree = setRootDir(s.chatTree, next === "horizontal" ? "row" : "col");
            const mirrors = persistTreeMirrors(chatTree, next);
            return { chatLayout: mirrors.chatLayout, chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes };
          }
          persistChatLayout(next);
          return { chatLayout: next };
        });
      },
      dropChatOnto: (dragChatId, targetChatId, pos) => {
        if (!dragChatId || !targetChatId) return;
        if (dragChatId === targetChatId) return;
        set((s) => {
          if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
          if (!s.chats.some((c2) => c2.id === targetChatId)) return {};
          const base2 = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [targetChatId], s.chatLayout);
          if (base2 && !containsChat(base2, dragChatId) && leafCount(base2) >= CHAT_WINDOW_MAX && pos !== "center") {
            const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOnto(base2, dragChatId, targetChatId, pos);
          if (!chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          if (s.windowFullscreenId) persistWindowFullscreen(null);
          return {
            activeChatId: dragChatId,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            windowFullscreenId: null,
            unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId)
          };
        });
        persistSoon();
      },
      dropChatOntoRoot: (dragChatId, pos) => {
        if (!dragChatId) return;
        if (pos === "center") return;
        set((s) => {
          if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
          const base2 = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [dragChatId], s.chatLayout);
          if (!base2) return {};
          if (!containsChat(base2, dragChatId) && leafCount(base2) >= CHAT_WINDOW_MAX) {
            const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOntoRoot(base2, dragChatId, pos);
          if (!chatTree || chatTree === base2) return { openChatIds };
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          if (s.windowFullscreenId) persistWindowFullscreen(null);
          return {
            activeChatId: dragChatId,
            openChatIds,
            visibleChatIds: mirrors.visibleChatIds,
            chatWindowSizes: mirrors.chatWindowSizes,
            chatLayout: mirrors.chatLayout,
            chatTree,
            windowFullscreenId: null,
            unreadChats: s.unreadChats.filter((cid) => cid !== dragChatId)
          };
        });
        persistSoon();
      },
      setTreeNodeSize: (nodeId, size) => {
        set((s) => {
          if (!s.chatTree) return {};
          const chatTree = setNodeSize(s.chatTree, nodeId, size);
          if (!chatTree || chatTree === s.chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
        });
      },
      resizeTreePair: (parentId, firstId, secondId, firstSize, secondSize) => {
        set((s) => {
          if (!s.chatTree) return {};
          const chatTree = resizePair(s.chatTree, parentId, firstId, secondId, firstSize, secondSize);
          if (!chatTree || chatTree === s.chatTree) return {};
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          return { chatTree, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout };
        });
      },
      setChatFullscreen: (v) => {
        set(() => {
          persistChatFullscreen(v);
          return { chatFullscreen: v };
        });
      },
      toggleChatFullscreen: () => {
        set((s) => {
          persistChatFullscreen(!s.chatFullscreen);
          return { chatFullscreen: !s.chatFullscreen };
        });
      },
      setWindowFullscreen: (id) => {
        persistWindowFullscreen(id);
        set({ windowFullscreenId: id });
      },
      toggleWindowFullscreen: (id) => {
        const st = get();
        const target = id ?? st.activeChatId;
        if (!target) return;
        const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
        if (ids.length < 2 && !st.windowFullscreenId) return;
        const next = toggleFullscreenId(st.windowFullscreenId, target);
        persistWindowFullscreen(next);
        if (next && st.activeChatId !== next) {
          const openChatIds = st.openChatIds.includes(next) ? st.openChatIds : [...st.openChatIds, next];
          persistOpenState(openChatIds, next);
          set({ windowFullscreenId: next, activeChatId: next, openChatIds, unreadChats: st.unreadChats.filter((cid) => cid !== next) });
        } else {
          set({ windowFullscreenId: next });
        }
      },
      setChatMode: (id, mode) => {
        if (!isChatBodyReady(id)) return;
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== id) return c2;
            const label = MODE_LABELS[mode] ?? mode;
            const modeMsg = {
              id: uid(),
              role: "system",
              content: `[Mode switched to ${label} \u2014 the next user message runs in ${label} mode.]`,
              modeSwitch: true,
              createdAt: Date.now()
            };
            return { ...c2, mode, messages: [...c2.messages, modeMsg], updatedAt: Date.now() };
          })
        }));
        get().persist();
      },
      setChatModeQuiet: (id, mode) => {
        if (!isChatBodyReady(id)) return;
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, mode, updatedAt: Date.now() } : c2)
        }));
        get().persist();
      },
      setChatEditTarget: (id, target) => {
        let refused = false;
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== id) return c2;
            if (c2.editTarget && (c2.editTarget.target !== target.target || c2.editTarget.name !== target.name)) {
              refused = true;
              return c2;
            }
            const prevMode = c2.editTarget ? c2.editTargetPrevMode : c2.mode === "build" ? void 0 : c2.mode;
            return {
              ...c2,
              editTarget: target,
              // Save the chat's real mode only on FIRST pin (the echo keeps it).
              editTargetPrevMode: prevMode,
              // An update session IS a build session — force it now, not per-send.
              mode: "build",
              updatedAt: Date.now()
            };
          })
        }));
        if (!refused) get().persist();
        return !refused;
      },
      clearChatEditTarget: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.editTarget ? {
              ...c2,
              editTarget: void 0,
              mode: c2.editTargetPrevMode ?? c2.mode,
              editTargetPrevMode: void 0,
              updatedAt: Date.now()
            } : c2
          )
        }));
        get().persist();
      },
      setChatPluginSession: (id, session) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? { ...c2, pluginSession: session, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      clearChatPluginSession: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.pluginSession ? { ...c2, pluginSession: void 0, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      setGoal: (id, condition) => {
        const text = (condition ?? "").trim();
        if (!text) return;
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? { ...c2, goal: { condition: text, active: true, paused: false, stopped: false, startedAt: Date.now(), turns: 0 }, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      clearGoal: (id) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, goal: null, updatedAt: Date.now() } : c2)
        }));
        get().persist();
      },
      pauseGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.goal?.active ? { ...c2, goal: { ...c2.goal, paused: true, stopped: false }, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      resumeGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.goal?.active ? { ...c2, goal: { ...c2.goal, paused: false, stopped: false }, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      stopGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.goal?.active && !c2.goal.paused ? { ...c2, goal: { ...c2.goal, stopped: true }, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      rearmGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.goal?.active && c2.goal.stopped ? { ...c2, goal: { ...c2.goal, stopped: false }, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      incrementGoalTurn: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id && c2.goal?.active && !c2.goal.paused ? { ...c2, goal: { ...c2.goal, turns: (c2.goal.turns ?? 0) + 1 } } : c2
          )
        }));
        get().persist();
      },
      setChatRoot: (id, root) => {
        set((s) => {
          const chat = s.chats.find((c2) => c2.id === id);
          if (!chat) return {};
          const nextRoot = root ?? "";
          const prevKey = workspaceKey(chat.root ?? "");
          const nextKey = workspaceKey(nextRoot);
          const chats = s.chats.map(
            (c2) => c2.id === id ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
          );
          if (prevKey === nextKey) {
            return { chats, root: s.activeChatId === id ? nextRoot : s.root };
          }
          const workspaces = nextKey === "__none__" || s.workspaces.some((w) => w.key === nextKey) ? s.workspaces : [...s.workspaces, makeWorkspace(nextRoot)];
          const workspaceViews = { ...s.workspaceViews };
          const prevLive = s.activeWorkspaceKey === prevKey;
          const destLive = s.activeWorkspaceKey === nextKey;
          const prevView = prevLive ? liveWorkspaceView(s) : workspaceViews[prevKey] ?? emptyWorkspaceView(s.chatLayout);
          const destBase = destLive ? liveWorkspaceView(s) : workspaceViews[nextKey] ?? emptyWorkspaceView(s.chatLayout);
          const wasOpen = prevView.openChatIds.includes(id);
          const movingFocus = s.activeChatId === id;
          const prevSanitized = sanitizeWorkspaceView(prevView, chats, prevKey, s.chatLayout);
          workspaceViews[prevKey] = prevSanitized;
          let dest = sanitizeWorkspaceView(destBase, chats, nextKey, s.chatLayout);
          if (wasOpen || movingFocus) {
            dest = {
              ...dest,
              openChatIds: dest.openChatIds.includes(id) ? dest.openChatIds : [...dest.openChatIds, id]
            };
          }
          if (movingFocus) dest = focusChatInView(dest, id, s.chatLayout);
          const workspaceViewsWithDest = { ...workspaceViews, [nextKey]: dest };
          if (movingFocus) {
            persistViewToLegacy(dest);
            return {
              chats,
              workspaces,
              workspaceViews: workspaceViewsWithDest,
              workspaceLastUsedAt: { ...s.workspaceLastUsedAt, [nextKey]: Date.now() },
              activeWorkspaceKey: nextKey,
              ...viewFields(dest),
              root: nextRoot,
              outsideAllowed: false,
              outsideFolders: []
            };
          }
          if (prevLive) {
            persistViewToLegacy(prevSanitized);
            return {
              chats,
              workspaces,
              workspaceViews: workspaceViewsWithDest,
              ...viewFields(prevSanitized)
            };
          }
          if (destLive) {
            const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
            persistOpenState(openChatIds, s.activeChatId);
            delete workspaceViewsWithDest[nextKey];
            return {
              chats,
              workspaces,
              workspaceViews: workspaceViewsWithDest,
              workspaceLastUsedAt: { ...s.workspaceLastUsedAt, [nextKey]: Date.now() },
              openChatIds
            };
          }
          return { chats, workspaces, workspaceViews: workspaceViewsWithDest };
        });
        get().persist();
      },
      setChatDraft: (id, patch) => {
        set((s) => {
          const idx = s.chats.findIndex((c2) => c2.id === id);
          if (idx === -1) return {};
          const cur = s.chats[idx];
          const next = { ...cur.draft, ...patch };
          const prev = cur.draft ?? {};
          const keys = /* @__PURE__ */ new Set([...Object.keys(prev), ...Object.keys(next)]);
          let changed = false;
          for (const k of keys) {
            if (prev[k] !== next[k]) {
              changed = true;
              break;
            }
          }
          if (!changed) return {};
          const chats = s.chats.slice();
          chats[idx] = { ...cur, draft: next };
          return { chats };
        });
      },
      setChatThinkingLevel: (id, level) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, thinkingLevel: level, updatedAt: Date.now() } : c2)
        }));
        get().persist();
      },
      // Per-chat auto-compaction threshold override (the context popover's
      // slider). `null` clears the override so the chat follows Settings →
      // General again; a number is clamped to the backend's 1–99 range.
      setChatCompactAtPercent: (id, value) => {
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== id) return c2;
            const next = { ...c2, updatedAt: Date.now() };
            if (value === null) delete next.compactAtPercent;
            else next.compactAtPercent = Math.round(Math.min(99, Math.max(1, value)));
            return next;
          })
        }));
        get().persist();
      },
      setChatProvider: (id, providerId, model) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, providerId, model, updatedAt: Date.now() } : c2)
        }));
        get().persist();
      },
      renameChat: (id, title) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, title, updatedAt: Date.now() } : c2)
        }));
        get().persist();
      },
      forkSection: (messageId, sectionTitle, sectionContent) => {
        const s = useStore.getState();
        const src = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
        if (!src) return;
        const chatId = s.newChatInRoot(src.root ?? "", src.mode);
        if (src.providerId) {
          useStore.getState().setChatProvider(chatId, src.providerId, src.model ?? "");
        }
        const label = sectionTitle.trim() || "\u0628\u062E\u0634";
        const context = `\u{1F4CC} \u0628\u062E\u0634 \xAB${label}\xBB \u0627\u0632 \u067E\u0627\u0633\u062E \u0642\u0628\u0644\u06CC:

${sectionContent.trim()}`;
        useStore.getState().addMessage(chatId, { role: "user", content: context });
        useStore.getState().renameChat(chatId, label);
        useStore.getState().setFocusComposer(true);
      },
      setFocusComposer: (v) => set({ focusComposer: v }),
      forkChatFromMessage: (messageId) => {
        const src = get().chats.find((c2) => c2.messages.some((m) => m.id === messageId));
        if (!src) return null;
        const idx = src.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return null;
        const chatId = get().newChatInRoot(src.root ?? "", src.mode);
        if (src.providerId) {
          get().setChatProvider(chatId, src.providerId, src.model ?? "");
        }
        const seed = forkSeedMessage(src, idx);
        set((st) => ({
          chats: st.chats.map(
            (c2) => c2.id === chatId ? {
              ...c2,
              messages: [seed],
              // 'New chat' (not "(fork)") on purpose: the title generator only
              // fires while the title is still the untouched placeholder, so
              // the user's FIRST new message here renames the fork for real.
              title: "New chat",
              // A fork with no user turn yet is PENDING: it holds only the
              // system seed, so persisting it would pin every exploratory
              // fork into the sidebar forever — exactly what an untouched new
              // chat avoids (sanitizeChats drops empty chats). Cleared by
              // addMessage as soon as the first user message lands.
              pendingFirstMessage: true,
              thinkingLevel: src.thinkingLevel,
              updatedAt: Date.now()
            } : c2
          ),
          activeChatId: chatId
        }));
        get().persist();
        get().setFocusComposer(true);
        return chatId;
      },
      addMessage: (chatId, message) => {
        if (!isChatBodyReady(chatId)) {
          throw new Error("chat body not hydrated");
        }
        const id = uid();
        const full = { ...message, id, createdAt: Date.now() };
        const prev = get().chats.find((c2) => c2.id === chatId);
        const autoTitle = capTitleWords(message.content);
        const hasPriorUser = !!prev?.messages.some((m) => m.role === "user");
        const shouldTitle = message.role === "user" && !!prev && !hasPriorUser && prev.title === "New chat" && message.content.trim() !== "";
        set((s) => {
          if (message.role === "user") {
            const st = stackFor(chatId);
            st.redo = [];
          }
          const chats = s.chats.map(
            (c2) => c2.id === chatId ? {
              ...c2,
              messages: [...c2.messages, full],
              // Keep the absolute count in step with the appended message so
              // paging labels/metering never lag one turn behind.
              bodyTotal: (c2.bodyTotal ?? c2.messages.length) + 1,
              messageCount: (c2.bodyTotal ?? c2.messages.length) + 1,
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c2.updatedAt,
              title: c2.messages.length === 0 && message.role === "user" ? autoTitle : c2.title,
              // The first user turn graduates a PENDING fork into a real chat:
              // from here on it persists like everything else.
              pendingFirstMessage: message.role === "user" ? false : c2.pendingFirstMessage
            } : c2
          );
          return { chats };
        });
        get().persist();
        if (shouldTitle) {
          console.info("[title] generating title for new chat", chatId.slice(-6));
          void (async () => {
            try {
              const st = get();
              const chat = st.chats.find((c2) => c2.id === chatId);
              const provider = st.settings.providers.find(
                (p) => p.id === (chat?.providerId ?? st.settings.activeProviderId)
              ) ?? st.settings.providers[0];
              if (!provider) return;
              const res = await requestChatTitle({
                provider,
                subagentModels: st.subagentModels ?? {},
                subagentThinking: st.subagentThinking ?? {},
                toolFallbacks: toolFallbackEntries(st.toolFallbacks),
                providers: Object.fromEntries(
                  (st.settings.providers ?? []).map((p) => [p.id, p])
                ),
                // Mirror the main call's gate: a model that is not known to reason
                // must not have a reasoning parameter forced onto it.
                modelReasoning: modelReasoning(provider, provider.model) ?? supportsReasoning(provider.model, provider.kind),
                text: message.content.slice(0, 1e3),
                chatId
              });
              const title = capTitleWords(typeof res?.title === "string" ? res.title : "");
              if (title) {
                try {
                  const cur = get().chats.find((c2) => c2.id === chatId);
                  if (!cur) {
                    console.info("[title] chat gone \u2014 skipping apply");
                  } else if (cur.title !== "New chat" && cur.title !== autoTitle && (cur.title || "").trim() !== "") {
                    console.info("[title] title changed meanwhile \u2014 keeping it:", cur.title);
                  } else {
                    get().renameChat(chatId, title);
                    console.info("[title] applied title:", title, chatId.slice(-6));
                  }
                } catch (err) {
                  console.warn("[title] apply failed \u2014 keeping auto title", err);
                }
              }
              const cu = res?.usage;
              if (cu) {
                try {
                  const pid = cu.provider_id || cu.provider || provider.id;
                  const usageModel = normalizeUsageModel(pid, cu.model || provider.model || "main");
                  get().accrueChatUsage(chatId, pid, usageModel, {
                    input: cu.input_tokens ?? 0,
                    output: cu.output_tokens ?? 0,
                    cacheRead: cu.cache_read_tokens ?? 0,
                    cacheWrite: cu.cache_write_tokens ?? 0
                  });
                } catch (err) {
                  console.warn("[title] usage accrue failed", err);
                }
              }
            } catch (err) {
              console.warn("[title] title flow failed \u2014 keeping auto title", err);
            }
          })();
        } else if (message.role === "user" && !!prev && !hasPriorUser && message.content.trim() !== "") {
          if (prev.title !== autoTitle) {
            console.info("[title] trigger skipped \u2014 current title:", prev.title, chatId.slice(-6));
          } else {
            console.debug("[title] trigger skipped \u2014 title already matches first message", chatId.slice(-6));
          }
        }
        return full;
      },
      removeMessage: (chatId, id) => {
        if (!isChatBodyReady(chatId)) return;
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === chatId ? { ...c2, messages: c2.messages.filter((m) => m.id !== id) } : c2
          )
        }));
        get().persist();
      },
      queueMessage: (chatId, msg) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === chatId ? { ...c2, queued: [...c2.queued ?? [], { ...msg, createdAt: Date.now() }] } : c2
          )
        }));
        get().persist();
      },
      removeQueuedMessage: (chatId, id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === chatId ? { ...c2, queued: (c2.queued ?? []).filter((q) => q.id !== id) } : c2
          )
        }));
        get().persist();
      },
      clearQueue: (chatId) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, queued: [] } : c2)
        }));
        get().persist();
      },
      markQueuedSent: (chatId, id) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === chatId ? { ...c2, queued: (c2.queued ?? []).map((q) => q.id === id ? { ...q, sent: true } : q) } : c2
          )
        }));
        get().persist();
      },
      moveQueuedMessage: (chatId, from, insertAt) => {
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== chatId) return c2;
            const queued = c2.queued ?? [];
            const unsent = queued.filter((q) => !q.sent);
            if (from < 0 || from >= unsent.length || unsent.length < 2) return c2;
            const next = moveAt(unsent, from, insertAt);
            const sentPart = queued.filter((q) => q.sent);
            return { ...c2, queued: [...sentPart, ...next] };
          })
        }));
        get().persist();
      },
      updateMessage: (id, patch) => {
        set((s) => {
          const targetChat = s.chats.find((c2) => c2.messages.some((m) => m.id === id));
          if (!targetChat) return {};
          const msg = targetChat.messages.find((m) => m.id === id);
          const completes = msg.streaming === true && patch.streaming === false;
          const updatedChat = {
            ...targetChat,
            messages: targetChat.messages.map((m) => m.id === id ? { ...m, ...patch } : m),
            updatedAt: completes ? Date.now() : targetChat.updatedAt
          };
          const unreadChats = completes && targetChat.id !== s.activeChatId && !s.unreadChats.includes(targetChat.id) ? [...s.unreadChats, targetChat.id] : s.unreadChats;
          return {
            chats: s.chats.map((c2) => c2.id === targetChat.id ? updatedChat : c2),
            unreadChats
          };
        });
        maybePersistMidStream();
      },
      appendMessageSegments: (id, segments) => {
        if (!segments || segments.length === 0) return false;
        let added = false;
        set((s) => {
          const targetChat = s.chats.find((c2) => c2.messages.some((m) => m.id === id));
          if (!targetChat) return {};
          const msg = targetChat.messages.find((m) => m.id === id);
          const cur = msg.segments ?? [];
          const next = [...cur];
          for (const seg of segments) {
            const dup = next.some((e) => {
              if (e.kind !== seg.kind) return false;
              if (seg.kind === "user" && e.kind === "user") return e.id === seg.id;
              if (seg.kind === "compact" && e.kind === "compact") return e.id === seg.id;
              if (seg.kind === "tool" && e.kind === "tool")
                return e.index === seg.index;
              return false;
            });
            if (!dup) {
              next.push(seg);
              added = true;
            }
          }
          if (!added) return {};
          return {
            chats: s.chats.map(
              (c2) => c2.id === targetChat.id ? {
                ...c2,
                messages: c2.messages.map(
                  (m) => m.id === id ? { ...m, segments: next } : m
                )
              } : c2
            )
          };
        });
        if (added) maybePersistMidStream();
        return added;
      },
      accrueChatUsage: (chatId, providerId, model, delta) => {
        const hasTokens = (delta.input || 0) > 0 || (delta.output || 0) > 0 || (delta.cacheRead || 0) > 0 || (delta.cacheWrite || 0) > 0;
        if (!hasTokens) return;
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== chatId) return c2;
            const entries = [...c2.usage?.entries ?? []];
            const idx = entries.findIndex(
              (e) => e.providerId === providerId && e.model === model
            );
            if (idx >= 0) {
              const prev = entries[idx];
              entries[idx] = {
                ...prev,
                input: prev.input + (delta.input || 0),
                output: prev.output + (delta.output || 0),
                cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
                cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
                lastUsed: Date.now()
              };
            } else {
              entries.push({
                providerId,
                model,
                input: delta.input || 0,
                output: delta.output || 0,
                cacheRead: delta.cacheRead ?? 0,
                cacheWrite: delta.cacheWrite ?? 0,
                lastUsed: Date.now()
              });
            }
            const working = c2.messages.some((m) => m.streaming);
            return { ...c2, usage: { entries }, updatedAt: working ? c2.updatedAt : Date.now() };
          })
        }));
        persistSoon();
      },
      resetChatUsage: (chatId) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === chatId ? { ...c2, usage: void 0, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      setChatPendingAsk: (chatId, req) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, pendingAsk: req } : c2)
        }));
      },
      setChatPendingPermission: (chatId, req) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === chatId ? { ...c2, pendingPermission: req } : c2)
        }));
      },
      setChatGrant: (chatId, patch) => {
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== chatId) return c2;
            const prev = c2.chatGrants ?? {};
            const folders = [...prev.folders ?? []];
            for (const f of patch.folders ?? []) {
              if (!folders.includes(f)) folders.push(f);
            }
            const hosts = [...prev.hosts ?? []];
            for (const h of patch.hosts ?? []) {
              if (!hosts.includes(h)) hosts.push(h);
            }
            return {
              ...c2,
              chatGrants: {
                desktop: (prev.desktop ?? false) || (patch.desktop ?? false),
                outsideAll: (prev.outsideAll ?? false) || (patch.outsideAll ?? false),
                confirm: (prev.confirm ?? false) || (patch.confirm ?? false),
                folders,
                hosts
              }
            };
          })
        }));
      },
      setChatCompacting: (id, compacting) => {
        set((s) => ({
          chats: s.chats.map(
            (c2) => (
              // Clearing the flag also drops the progress, so a later compaction can
              // never inherit a stale phase/elapsed pair from the previous run.
              c2.id === id ? { ...c2, compacting, compactProgress: compacting ? c2.compactProgress : null } : c2
            )
          )
        }));
      },
      setChatCompactProgress: (id, compactProgress) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactProgress } : c2)
        }));
      },
      setChatCompactError: (id, compactError) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactError } : c2)
        }));
      },
      setChatCmdError: (id, cmdError) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, cmdError } : c2)
        }));
      },
      setChatLiveError: (id, liveError) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, liveError } : c2)
        }));
      },
      setChatTtsError: (id, ttsError) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, ttsError } : c2)
        }));
      },
      setChatSkillNotice: (id, skillNotice) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, skillNotice } : c2)
        }));
      },
      setChatMcpActive: (id, mcpActive) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, mcpActive } : c2)
        }));
      },
      setChatUndoNotice: (id, undoNotice) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, undoNotice } : c2)
        }));
      },
      docRev: {},
      bumpDocRev: (absPath) => {
        set((s) => ({
          docRev: { ...s.docRev, [absPath]: (s.docRev[absPath] ?? 0) + 1 }
        }));
      },
      setChatScrollPos: (id, pos) => {
        set((s) => ({
          // Deliberately NOT bumping updatedAt: scrolling shouldn't reorder chats.
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, scrollPos: pos } : c2)
        }));
        get().persist();
      },
      // In-memory-only variant: updates the store WITHOUT persisting. Used by the
      // `coder:flush-ui` handler so a chat panel can push its ref-held scroll
      // position into the store right before a flush writes the snapshot — no
      // redundant write, no recursion into persist().
      setChatScrollPosMem: (id, pos) => {
        set((s) => {
          const cur = s.chats.find((c2) => c2.id === id)?.scrollPos ?? null;
          const same = cur === null && pos === null || cur !== null && pos !== null && cur.id === pos.id && cur.offset === pos.offset && cur.atBottom === pos.atBottom;
          if (same) return {};
          return {
            chats: s.chats.map((c2) => c2.id === id ? { ...c2, scrollPos: pos } : c2)
          };
        });
      },
      setPrefixNotice: (prefixNotice) => {
        set({ prefixNotice });
      },
      markToolReverted: (messageId, index) => {
        set((s) => ({
          chats: s.chats.map((c2) => {
            const has = c2.messages.some((m) => m.id === messageId);
            if (!has) return c2;
            return {
              ...c2,
              messages: c2.messages.map(
                (m) => m.id === messageId ? {
                  ...m,
                  toolActivity: (m.toolActivity ?? []).map(
                    (act, i) => i === index ? { ...act, reverted: true } : act
                  )
                } : m
              ),
              updatedAt: Date.now()
            };
          })
        }));
        persistSoon();
      },
      clearChat: (id) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (!target || !isChatBodyReady(id) || (target.bodyStart ?? 0) > 0) return;
        abortChatStream(get().chatAborts[id]);
        historyStacks.delete(id);
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? {
              ...c2,
              messages: [],
              bodyStart: 0,
              bodyTotal: 0,
              messageCount: 0,
              usage: void 0,
              updatedAt: Date.now()
            } : c2
          )
        }));
        get().persist();
      },
      truncateTo: (messageId) => {
        const s = get();
        const target = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
        if (!target) return false;
        if ((target.bodyStart ?? 0) > 0) return false;
        const idx = target.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return false;
        const targetId = target.id;
        set((st) => ({
          chats: st.chats.map(
            (c2) => c2.id === targetId ? {
              ...c2,
              messages: c2.messages.slice(0, idx),
              bodyTotal: idx,
              messageCount: idx,
              updatedAt: Date.now()
            } : c2
          )
        }));
        get().persist();
        return true;
      },
      compactChat: (id, summary, keep = 0) => {
        const target = get().chats.find((c2) => c2.id === id);
        if (!target || !isChatBodyReady(id) || (target.bodyStart ?? 0) > 0) return;
        set((s) => ({
          chats: s.chats.map((c2) => {
            if (c2.id !== id) return c2;
            const nonSys = c2.messages.filter((m) => m.role !== "system");
            const recentStart = Math.max(nonSys.length - keep, 0);
            const compactedIds = new Set(
              nonSys.slice(0, recentStart).map((m) => m.id)
            );
            for (const m of c2.messages) {
              if (m.streaming) compactedIds.delete(m.id);
            }
            for (const m of c2.messages) {
              if (m.role === "system") compactedIds.add(m.id);
            }
            const messages = c2.messages.map(
              (m) => compactedIds.has(m.id) ? { ...m, compacted: true } : { ...m, usage: void 0 }
            );
            const summaryMsg = {
              id: uid(),
              role: "system",
              content: summary,
              usage: void 0,
              compacted: false,
              createdAt: Date.now()
            };
            const streaming = messages.find((m) => m.streaming);
            const withSeg = streaming ? messages.map(
              (m) => m.id === streaming.id ? {
                ...m,
                segments: [
                  ...m.segments ?? [],
                  { kind: "compact", id: summaryMsg.id }
                ]
              } : m
            ) : messages;
            withSeg.push(summaryMsg);
            return {
              ...c2,
              messages: withSeg,
              updatedAt: Date.now()
            };
          })
        }));
        get().persist();
      },
      undoMessage: () => {
        const s = get();
        const chat = s.chats.find((c2) => c2.id === s.activeChatId);
        if (!chat || chat.messages.length === 0) return false;
        if ((chat.bodyStart ?? 0) > 0) return false;
        if (chat.messages.some((m) => m.streaming)) {
          abortChatStream(s.chatAborts[chat.id]);
          return false;
        }
        let idx = -1;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].role === "user") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return false;
        const removed = chat.messages.slice(idx);
        const st = stackFor(chat.id);
        st.redo.push(removed);
        if (st.redo.length > MAX_REDO_EXCHANGES) {
          st.redo.splice(0, st.redo.length - MAX_REDO_EXCHANGES);
        }
        set((stt) => ({
          chats: stt.chats.map(
            (c2) => c2.id === chat.id ? { ...c2, messages: c2.messages.slice(0, idx), updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
        return true;
      },
      redoMessage: () => {
        const s = get();
        const chat = s.chats.find((c2) => c2.id === s.activeChatId);
        if (!chat) return false;
        if ((chat.bodyStart ?? 0) > 0) return false;
        if (chat.messages.some((m) => m.streaming)) return false;
        const st = stackFor(chat.id);
        const exchange = st.redo.pop();
        if (!exchange) return false;
        set((stt) => ({
          chats: stt.chats.map(
            (c2) => c2.id === chat.id ? { ...c2, messages: [...c2.messages, ...exchange], updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
        return true;
      },
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setStreaming: (active, thinking) => set((s) => {
        if (s.isStreaming === active && s.isThinking === thinking) return {};
        return { isStreaming: active, isThinking: thinking };
      }),
      setOutsideAllowed: (allowed) => set({ outsideAllowed: allowed }),
      addOutsideFolder: (folder) => set((s) => ({
        outsideFolders: folder && !s.outsideFolders.includes(folder) ? [...s.outsideFolders, folder] : s.outsideFolders
      })),
      setComputerUse: (v) => set({ computerUse: v }),
      setBrowserUse: (v) => set({ browserUse: v }),
      anyStreaming: () => get().chats.some((c2) => c2.messages.some((m) => m.streaming)),
      setCompactAtPercent: (percent) => {
        set((s) => ({ settings: { ...s.settings, compactAtPercent: percent } }));
        get().persist();
      },
      setDisableTextSuggestions: (on) => {
        set((s) => ({ settings: { ...s.settings, disableTextSuggestions: on } }));
        get().persist();
      },
      setNvimTerminal: (id) => {
        set((s) => ({ settings: { ...s.settings, nvimTerminal: resolveNvimTerminal(id) } }));
        get().persist();
      },
      setTerminalShell: (shell2) => {
        const picked = (shell2 ?? "").trim();
        set((s) => ({
          settings: { ...s.settings, terminalShell: picked || DEFAULT_TERMINAL_SHELL }
        }));
        get().persist();
      }
    }));
    api.onSidecarChanged(() => {
      void useStore.getState().load();
    });
  }
});

// src/lib/nvimEdit.ts
function runTargetKey(argv) {
  return argv.join("\0");
}
var init_nvimEdit = __esm({
  "src/lib/nvimEdit.ts"() {
    "use strict";
  }
});

// src/lib/sidebarView.ts
import { create as create2 } from "zustand";
function load() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "files" ? "files" : "chats";
  } catch {
    return "chats";
  }
}
var STORAGE_KEY, useSidebarView;
var init_sidebarView = __esm({
  "src/lib/sidebarView.ts"() {
    "use strict";
    STORAGE_KEY = "coder:sidebarView";
    useSidebarView = create2((set, get) => ({
      view: load(),
      setView: (view) => {
        if (get().view === view) return;
        set({ view });
        try {
          localStorage.setItem(STORAGE_KEY, view);
        } catch {
        }
      }
    }));
  }
});

// src/lib/fuzzy.ts
var init_fuzzy = __esm({
  "src/lib/fuzzy.ts"() {
    "use strict";
  }
});

// src/lib/fileTree.ts
function rootPrefix(root) {
  return root.replace(/\/+$/, "");
}
function toWorkspacePath(root, path) {
  if (!root || !path.startsWith("/")) return path;
  const dir = rootPrefix(root);
  if (!dir || !path.startsWith(`${dir}/`)) return path;
  return path.slice(dir.length + 1);
}
var init_fileTree = __esm({
  "src/lib/fileTree.ts"() {
    "use strict";
    init_fuzzy();
  }
});

// src/lib/viewerTabs.ts
import { create as create3 } from "zustand";
function viewerTabId(kind, scopeKey, path) {
  if (kind === "file" || kind === "media") {
    const clean = (path ?? "").trim();
    return clean ? `${kind}:${scopeKey}:${clean}` : `${kind}:${scopeKey}`;
  }
  if (kind === "terminal") {
    const target = (path ?? "").trim();
    return target ? `terminal:${scopeKey}:${target}` : `terminal:${scopeKey}`;
  }
  return CHAT_SCOPED_KINDS.has(kind) || WORKSPACE_SCOPED_KINDS.has(kind) ? `${kind}:${scopeKey}` : kind;
}
function workspaceKeyForChat(chatId) {
  const st = useStore.getState();
  const root = (chatId ? st.chats.find((c2) => c2.id === chatId)?.root : void 0) ?? st.root ?? "";
  return workspaceKey(root);
}
function viewerScopeForChat(chatId) {
  return { wsKey: workspaceKeyForChat(chatId), chatId: chatId ?? currentChatId() };
}
function visibleTabs(tabs, scope) {
  return tabs.filter((t) => tabVisibleInScope(t, scope));
}
function tabVisibleInScope(t, scope) {
  if (t.kind === "file" && !t.chatId && !t.wsKey) return true;
  if (t.kind === "trace" && (t.chatId ?? "").startsWith("schedule-")) return true;
  if (CHAT_SCOPED_KINDS.has(t.kind)) return t.chatId === scope.chatId;
  if (WORKSPACE_SCOPED_KINDS.has(t.kind)) return (t.wsKey ?? "") === scope.wsKey;
  return true;
}
function notifyTabClosed(tabId) {
  for (const hook of tabCloseHooks) {
    try {
      hook(tabId);
    } catch {
    }
  }
}
function currentChatId() {
  return useStore.getState().activeChatId;
}
function showExplorer() {
  useSidebarView.getState().setView("files");
  const st = useStore.getState();
  if (!st.sidebarOpen) st.setSidebarOpen(true);
}
function capTabs(tabs) {
  const next = capTabsRaw(tabs);
  if (next.length !== tabs.length) {
    const kept = new Set(next.map((t) => t.id));
    for (const t of tabs) {
      if (!kept.has(t.id)) notifyTabClosed(t.id);
    }
  }
  return next;
}
function capTabsRaw(tabs) {
  let next = tabs;
  const files = next.filter((t) => t.kind === "file").sort((a, b) => a.createdAt - b.createdAt);
  if (files.length > FILE_TAB_CAP) {
    const dropFiles = new Set(files.slice(0, files.length - FILE_TAB_CAP).map((t) => t.id));
    next = next.filter((t) => !dropFiles.has(t.id));
  }
  if (next.length <= TOTAL_TAB_CAP) return next;
  const filesByAge = next.filter((t) => t.kind === "file").sort((a, b) => a.createdAt - b.createdAt);
  const drop = /* @__PURE__ */ new Set();
  let over = next.length - TOTAL_TAB_CAP;
  for (const f of filesByAge) {
    if (over <= 0) break;
    drop.add(f.id);
    over--;
  }
  next = next.filter((t) => !drop.has(t.id));
  if (next.length > TOTAL_TAB_CAP) {
    const sorted = [...next].sort((a, b) => a.createdAt - b.createdAt);
    const extra = new Set(sorted.slice(0, next.length - TOTAL_TAB_CAP).map((t) => t.id));
    next = next.filter((t) => !extra.has(t.id));
  }
  return next;
}
function slimTab(t) {
  if (t.kind === "text") return { ...t, textBody: void 0 };
  if (t.kind === "artifact") return { ...t, artifactBody: void 0 };
  if (t.kind === "file") {
    return {
      id: t.id,
      kind: t.kind,
      ...t.chatId ? { chatId: t.chatId } : {},
      title: t.title,
      filePath: t.filePath,
      fileLine: t.fileLine,
      fileRoot: t.fileRoot,
      createdAt: t.createdAt
    };
  }
  return t;
}
function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY2);
    if (!raw) return { tabs: [], activeId: null, closed: [] };
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed.tabs) ? parsed.tabs.filter(
      (t) => t && typeof t.id === "string" && VALID_KINDS.has(t.kind) && !EPHEMERAL_KINDS.has(t.kind)
    ) : [];
    const seen = /* @__PURE__ */ new Set();
    const tabs = [];
    for (const t of valid) {
      const artifactChatId = t.kind === "artifact" && !t.chatId && t.id.startsWith("artifact:") ? t.id.split(":")[1] ?? "" : "";
      if (t.kind === "terminal") {
        if (!t.wsKey) continue;
      } else if (t.kind !== "file" && !t.chatId && !artifactChatId && (CHAT_SCOPED_KINDS.has(t.kind) || WORKSPACE_SCOPED_KINDS.has(t.kind)))
        continue;
      const legacyId = viewerTabId(t.kind, t.chatId ?? "");
      const id = (
        // Artifact tabs carry the artifact id in their own id
        // (`artifact:<chatId>:<artifactId>`), exactly like file tabs carry the
        // path: recomputing via `viewerTabId` collapses every artifact of one
        // chat into a single `artifact:<chatId>` tab and silently drops the
        // rest on reload.
        // Terminal tabs keep their OWN id: `terminal:<wsKey>:<target>`, where
        // target is `shell` for the default shell or `shell-<stamp>-<n>` for
        // every "new terminal". Recomputing it from `chatId` (the generic path
        // below) dropped the wsKey AND the unique suffix, collapsing every
        // restored terminal of one chat into a single tab.
        t.kind === "file" || t.kind === "artifact" || t.kind === "terminal" ? t.id : t.kind === "trace" && typeof t.traceTaskId === "string" && t.traceTaskId ? t.id.startsWith("trace:") ? t.id : `trace:${t.chatId}:${t.traceTaskId}` : legacyId
      );
      if (seen.has(id)) continue;
      seen.add(id);
      tabs.push({
        ...t,
        id,
        // An older artifact tab carried its owner chat only in its id.
        ...artifactChatId ? { chatId: artifactChatId } : {},
        // Tabs persisted before `artifactId` existed carry the id only inside
        // their tab id (`artifact:<chatId>:<artifactId>`) — recover it so the
        // restored panel can still re-read its body instead of showing the
        // "no longer in memory" notice forever.
        ...t.kind === "artifact" && !t.artifactId ? { artifactId: id.split(":").slice(2).join(":") || void 0 } : {},
        title: t.kind === "review" ? "Git" : t.title
      });
    }
    const capped = capTabs(tabs);
    const activeId = typeof parsed.activeId === "string" && capped.some((t) => t.id === parsed.activeId) ? parsed.activeId : null;
    const closed = Array.isArray(parsed.closed) ? parsed.closed.filter((c2) => c2 && typeof c2.closedAt === "number" && c2.tab && typeof c2.tab.id === "string" && VALID_KINDS.has(c2.tab.kind)).slice(0, CLOSED_CAP) : [];
    return { tabs: capped, activeId, closed };
  } catch {
    return { tabs: [], activeId: null, closed: [] };
  }
}
function persist(tabs, activeId, closed = []) {
  try {
    const keep = (t) => !EPHEMERAL_KINDS.has(t.kind);
    const slim = tabs.filter(keep).map((t) => slimTab(t));
    localStorage.setItem(
      STORAGE_KEY2,
      JSON.stringify({
        tabs: slim,
        // No "first tab" rescue: when the active id is gone (closed tab,
        // ephemeral terminal, or the no-tab todos resting state) it persists
        // as null so a restart restores the todos page, not a leftover
        // workspace tab like the Git diff.
        activeId: tabs.some((t) => t.id === activeId && keep(t)) ? activeId : null,
        closed: closed.filter((c2) => keep(c2.tab)).map((c2) => ({ tab: slimTab(c2.tab), closedAt: c2.closedAt }))
      })
    );
  } catch {
  }
}
function loadFullscreen() {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}
function persistFullscreen(v) {
  try {
    localStorage.setItem(FULLSCREEN_KEY, v ? "1" : "0");
  } catch {
  }
}
function loadPaneOpen(tabCount) {
  try {
    const raw = localStorage.getItem(PANE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
  }
  return tabCount > 0;
}
function persistPaneOpen(v) {
  try {
    localStorage.setItem(PANE_KEY, v ? "1" : "0");
  } catch {
  }
}
function revealViewerTab(tree, activeId, focusedId, knownIds) {
  if (!activeId || !knownIds.has(activeId)) return null;
  if (!tree) return { tree: buildFromList([activeId], "row"), focusedId: activeId };
  if (containsChat(tree, activeId)) return { tree, focusedId: activeId };
  const anchor = focusedId && containsChat(tree, focusedId) ? focusedId : collectChatIds(tree)[0] ?? null;
  const nextTree = anchor ? replaceChat(tree, anchor, activeId) : buildFromList([activeId], "row");
  return { tree: nextTree, focusedId: activeId };
}
function loadViewerTree() {
  try {
    const raw = localStorage.getItem(VIEWER_TREE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind !== "leaf" && parsed.kind !== "split") return null;
    return parsed;
  } catch {
    return null;
  }
}
function persistViewerTree(tree) {
  try {
    if (!tree) localStorage.removeItem(VIEWER_TREE_KEY);
    else localStorage.setItem(VIEWER_TREE_KEY, JSON.stringify(tree));
  } catch {
  }
}
function migrateTabScopes() {
  if (scopesMigrated) return;
  const st = useStore.getState();
  if (!Array.isArray(st.chats) || st.chats.length === 0) return;
  scopesMigrated = true;
  unsubScopeMigration?.();
  const keyFor = (chatId) => {
    const root = (chatId ? st.chats.find((c2) => c2.id === chatId)?.root : void 0) ?? st.root ?? "";
    return workspaceKey(root);
  };
  const vt = useViewerTabs.getState();
  let changed = false;
  let activeId = vt.activeId;
  const seen = /* @__PURE__ */ new Set();
  const remap = /* @__PURE__ */ new Map();
  const migrate = (tab) => {
    if (tab.kind === "plan" && tab.chatId) {
      const id2 = viewerTabId("plan", tab.chatId);
      if (id2 === tab.id) return tab;
      changed = true;
      remap.set(tab.id, id2);
      if (activeId === tab.id) activeId = id2;
      return { ...tab, id: id2 };
    }
    if (!WORKSPACE_SCOPED_KINDS.has(tab.kind) || tab.wsKey) return tab;
    if (tab.kind === "file" && !tab.chatId) return tab;
    const wsKey = keyFor(tab.chatId);
    const id = tab.kind !== "file" ? viewerTabId(tab.kind, wsKey) : (tab.filePath ?? "").trim() ? viewerTabId("file", wsKey, tab.filePath) : tab.id;
    if (id === tab.id) return { ...tab, wsKey };
    changed = true;
    remap.set(tab.id, id);
    if (activeId === tab.id) activeId = id;
    return { ...tab, id, wsKey };
  };
  const tabs = [];
  for (const tab of vt.tabs) {
    const next = migrate(tab);
    if (seen.has(next.id)) {
      notifyTabClosed(tab.id);
      if (activeId === tab.id) activeId = remap.get(tab.id) ?? tabs[tabs.length - 1]?.id ?? null;
      changed = true;
      continue;
    }
    seen.add(next.id);
    if (next !== tab) changed = true;
    tabs.push(next);
  }
  let closedChanged = false;
  const closedTabs = vt.closedTabs.map((c2) => {
    const tab = migrate(c2.tab);
    if (tab !== c2.tab) closedChanged = true;
    return { ...c2, tab };
  });
  if (!changed && !closedChanged) return;
  persist(tabs, activeId, closedTabs);
  useViewerTabs.setState({ tabs, activeId, closedTabs });
}
var CHAT_SCOPED_KINDS, WORKSPACE_SCOPED_KINDS, EPHEMERAL_KINDS, shellCounter, VALID_KINDS, TAB_STRIP_KINDS, tabCloseHooks, STORAGE_KEY2, CLOSED_CAP, TOTAL_TAB_CAP, FILE_TAB_CAP, initial, FULLSCREEN_KEY, PANE_KEY, VIEWER_TREE_KEY, VIEWER_WINDOW_MAX, initialViewerTree, useViewerTabs, scopesMigrated, unsubScopeMigration;
var init_viewerTabs = __esm({
  "src/lib/viewerTabs.ts"() {
    "use strict";
    init_nvimEdit();
    init_nvimTerminals();
    init_store();
    init_sidebarView();
    init_chatTree();
    init_fileTree();
    CHAT_SCOPED_KINDS = /* @__PURE__ */ new Set(["trace", "browser", "plan", "artifact"]);
    WORKSPACE_SCOPED_KINDS = /* @__PURE__ */ new Set(["review", "todos", "text", "explore", "file", "media", "terminal"]);
    EPHEMERAL_KINDS = /* @__PURE__ */ new Set([]);
    shellCounter = 0;
    VALID_KINDS = /* @__PURE__ */ new Set([
      "review",
      "trace",
      "inbox",
      "schedule",
      "todos",
      "plan",
      "browser",
      "file",
      "text",
      "explore",
      "artifact",
      "artifacts",
      "media",
      "terminal"
    ]);
    TAB_STRIP_KINDS = /* @__PURE__ */ new Set([
      "file",
      "browser",
      "trace",
      "text",
      "explore",
      "artifact"
    ]);
    tabCloseHooks = [];
    STORAGE_KEY2 = "coder:viewerTabs";
    CLOSED_CAP = 8;
    TOTAL_TAB_CAP = 30;
    FILE_TAB_CAP = 20;
    initial = typeof window !== "undefined" ? loadPersisted() : { tabs: [], activeId: null, closed: [] };
    FULLSCREEN_KEY = "coder:viewerFull";
    PANE_KEY = "coder:viewerPane";
    VIEWER_TREE_KEY = "coder:viewerTree";
    VIEWER_WINDOW_MAX = 4;
    initialViewerTree = (() => {
      if (typeof window === "undefined") return null;
      const valid = new Set(initial.tabs.map((t) => t.id));
      const norm = normalizeTree(loadViewerTree(), valid);
      if (norm) return norm;
      if (initial.tabs.length === 0) return null;
      const id = initial.activeId && valid.has(initial.activeId) ? initial.activeId : initial.tabs[0]?.id;
      return id ? buildFromList([id], "row") : null;
    })();
    useViewerTabs = create3((set, get) => ({
      tabs: initial.tabs,
      activeId: initial.activeId,
      viewerTree: initialViewerTree,
      focusedViewerId: initial.activeId,
      lastActiveByChat: {},
      closedTabs: initial.closed,
      filesFilterFocusAt: 0,
      expandedByChat: {},
      filesReveal: null,
      fullscreen: typeof window !== "undefined" ? loadFullscreen() : false,
      paneOpen: typeof window !== "undefined" ? loadPaneOpen(initial.tabs.length) : false,
      setPaneOpen: (v) => set(() => {
        persistPaneOpen(v);
        return { paneOpen: v };
      }),
      togglePane: () => set((s) => {
        persistPaneOpen(!s.paneOpen);
        return { paneOpen: !s.paneOpen };
      }),
      focusFilesFilter: () => {
        const s = get();
        const tab = s.tabs.find((t) => t.id === s.activeId);
        if (tab?.kind === "file" && tab.filePath) {
          const rel = toWorkspacePath(tab.fileRoot, tab.filePath) || tab.filePath;
          if (!rel.startsWith("/") && !rel.startsWith("~/")) {
            get().revealFile(rel, true);
            return;
          }
        }
        showExplorer();
        set((st) => ({ filesFilterFocusAt: st.filesFilterFocusAt + 1 }));
      },
      setExpandedDirs: (chatId, dirs) => set((s) => {
        const cid = chatId ?? currentChatId();
        if (!cid) return s;
        const next = [...new Set(dirs)].sort();
        const prev = s.expandedByChat[cid];
        if (prev && prev.length === next.length && prev.every((d, i) => d === next[i])) return s;
        return { expandedByChat: { ...s.expandedByChat, [cid]: next } };
      }),
      revealFile: (path, focus = false) => {
        showExplorer();
        const cid = currentChatId();
        set((s) => ({
          filesReveal: { chatId: cid ?? null, path, at: (s.filesReveal?.at ?? 0) + 1, focus }
        }));
      },
      openViewer: (tab) => set((s) => {
        const normalized = tab.kind === "review" ? { ...tab, title: "Git" } : tab;
        const exists = s.tabs.some((t) => t.id === normalized.id);
        const tabs = capTabs(exists ? s.tabs.map((t) => t.id === normalized.id ? { ...t, ...normalized } : t) : [...s.tabs, { ...normalized, createdAt: Date.now() }]);
        const lastActiveByChat = normalized.chatId ? { ...s.lastActiveByChat, [normalized.chatId]: normalized.id } : s.lastActiveByChat;
        const next = { tabs, activeId: tab.id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openReview: (messageId, path, chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const id = viewerTabId("review", wsKey);
        const tab = {
          id,
          kind: "review",
          chatId: cid,
          wsKey,
          title: "Git",
          reviewMessageId: messageId,
          reviewPath: path,
          reviewSource: "turn",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? tab : t) : [...s.tabs, tab]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openGitDiff: (chatId) => {
        const wsKey = workspaceKeyForChat((chatId ?? currentChatId()) || void 0);
        if (useStore.getState().workspaceRunModes[wsKey] !== "code") return;
        set((s) => {
          const cid = chatId ?? currentChatId();
          const wsKey2 = workspaceKeyForChat(cid || void 0);
          const id = viewerTabId("review", wsKey2);
          const tab = {
            id,
            kind: "review",
            chatId: cid,
            wsKey: wsKey2,
            title: "Git",
            reviewMessageId: null,
            reviewSource: "uncommitted",
            createdAt: Date.now()
          };
          const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? tab : t) : [...s.tabs, tab]);
          const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
          const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
          persist(next.tabs, next.activeId);
          return next;
        });
      },
      openTraces: (chatId, tab, taskId, title) => set((s) => {
        const cid = chatId ?? currentChatId();
        const tid = (taskId ?? "").trim();
        const id = tid ? `trace:${cid}:${tid}` : viewerTabId("trace", cid);
        const short = tid ? tid.slice(0, 8) : "";
        const label = (title ?? "").trim();
        const entry = {
          id,
          kind: "trace",
          chatId: cid,
          title: tid ? `Trace \xB7 ${label ? label.slice(0, 28) : short}` : (
            // No sub-agent id (e.g. a schedule-run trace): the label is the
            //  only thing telling two such tabs apart in the rail.
            label ? `Trace \xB7 ${label.slice(0, 28)}` : "Trace"
          ),
          traceChatId: chatId,
          traceTab: tab,
          traceTaskId: tid || void 0,
          traceTitle: label || void 0,
          createdAt: Date.now()
        };
        const prev = s.tabs.find((t) => t.id === id);
        const tabs = capTabs(prev ? s.tabs.map(
          (t) => t.id === id ? {
            ...entry,
            traceTab: tab ?? t.traceTab ?? prev.traceTab,
            traceTitle: label || (t.traceTitle ?? prev.traceTitle)
          } : t
        ) : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openInbox: () => set((s) => {
        const id = "inbox";
        const entry = {
          id,
          kind: "inbox",
          title: "Inbox",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const next = { tabs, activeId: id, paneOpen: true };
        persist(next.tabs, next.activeId);
        useStore.getState().setScheduleInboxOpen(true);
        return next;
      }),
      openSchedule: () => set((s) => {
        const id = "schedule";
        const entry = {
          id,
          kind: "schedule",
          title: "Schedule",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const next = { tabs, activeId: id, paneOpen: true };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openArtifacts: () => set((s) => {
        const id = "artifacts";
        const entry = {
          id,
          kind: "artifacts",
          title: "Artifacts",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const next = { tabs, activeId: id, paneOpen: true };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openPlan: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const id = viewerTabId("plan", cid);
        const entry = {
          id,
          kind: "plan",
          chatId: cid,
          wsKey,
          title: "Plan",
          createdAt: Date.now()
        };
        const tabs = capTabs(
          s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, chatId: cid, wsKey } : t) : [...s.tabs, entry]
        );
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      setBrowserUrl: (chatId, url) => set((s) => {
        const id = viewerTabId("browser", chatId);
        if (!s.tabs.some((t) => t.id === id)) return s;
        const tabs = s.tabs.map(
          (t) => t.id === id ? { ...t, browserUrl: url } : t
        );
        persist(tabs, s.activeId);
        return { tabs };
      }),
      openArtifact: (chatId, artifact) => set((s) => {
        const cid = chatId || currentChatId();
        const id = `artifact:${cid}:${artifact.id}`;
        const entry = {
          id,
          kind: "artifact",
          chatId: cid,
          title: artifact.title || artifact.id,
          artifactBody: artifact.body,
          artifactKind: artifact.kind === "md" ? "md" : "html",
          artifactId: artifact.id,
          ...artifact.version ? { artifactVersion: artifact.version } : {},
          createdAt: Date.now()
        };
        const tabs = capTabs(
          s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? entry : t) : [...s.tabs, entry]
        );
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openBrowser: (chatId, url) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("browser", cid);
        const entry = {
          id,
          kind: "browser",
          chatId: cid,
          title: "Browser",
          // The agent's browser tool hands its `url` here (see Chat.tsx): the
          // panel then launches on the page the agent is really working with.
          ...url && url !== "about:blank" ? { browserUrl: url } : {},
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openFile: (path, line, root, chatId) => {
        if (/\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v)$/i.test(path.trim())) {
          return get().openMedia(path, root, chatId);
        }
        const owner = (chatId ?? "").trim();
        if (owner) {
          const st = useStore.getState();
          if (owner !== st.activeChatId && (st.openChatIds.includes(owner) || st.visibleChatIds.includes(owner))) {
            st.focusWindow(owner);
          }
        }
        return set((s) => {
          const clean = path.trim();
          if (!clean) return {};
          const cid = (chatId ?? currentChatId()).trim();
          const wsKey = workspaceKeyForChat(cid || void 0);
          const id = cid ? viewerTabId("file", wsKey, clean) : `file:${clean}`;
          const entry = {
            id,
            kind: "file",
            ...cid ? { chatId: cid, wsKey } : {},
            title: clean.split(/[\\/]/).pop() || clean,
            filePath: clean,
            fileLine: line,
            fileRoot: root,
            createdAt: Date.now()
          };
          const raw = s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, fileLine: line, fileRoot: root ?? t.fileRoot, ...cid ? { chatId: cid, wsKey } : {} } : t) : [...s.tabs, entry];
          const tabs = capTabs(raw);
          const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
          const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
          const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(tabs.map((t) => t.id)));
          if (revealed?.tree && revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree);
          persist(next.tabs, next.activeId);
          return {
            ...next,
            viewerTree: revealed?.tree ?? s.viewerTree,
            focusedViewerId: revealed?.focusedId ?? s.focusedViewerId
          };
        });
      },
      openMedia: (path, root, chatId) => {
        const owner = (chatId ?? "").trim();
        if (owner) {
          const st = useStore.getState();
          if (owner !== st.activeChatId && (st.openChatIds.includes(owner) || st.visibleChatIds.includes(owner))) {
            st.focusWindow(owner);
          }
        }
        return set((s) => {
          const clean = path.trim();
          if (!clean) return {};
          const cid = (chatId ?? currentChatId()).trim();
          const wsKey = workspaceKeyForChat(cid || void 0);
          const id = cid ? viewerTabId("media", wsKey, clean) : `media:${clean}`;
          const entry = {
            id,
            kind: "media",
            ...cid ? { chatId: cid, wsKey } : {},
            title: clean.split(/[\\/]/).pop() || clean,
            filePath: clean,
            fileRoot: root,
            createdAt: Date.now()
          };
          const raw = s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, fileRoot: root ?? t.fileRoot, ...cid ? { chatId: cid, wsKey } : {} } : t) : [...s.tabs, entry];
          const tabs = capTabs(raw);
          const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
          const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
          const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(tabs.map((t) => t.id)));
          if (revealed?.tree && revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree);
          persist(next.tabs, next.activeId);
          return {
            ...next,
            viewerTree: revealed?.tree ?? s.viewerTree,
            focusedViewerId: revealed?.focusedId ?? s.focusedViewerId
          };
        });
      },
      openText: (title, body, format) => set((s) => {
        if (!body) return {};
        const cid = currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const id = viewerTabId("text", wsKey);
        const entry = {
          id,
          kind: "text",
          chatId: cid,
          wsKey,
          title: title.trim() || "Text",
          textBody: body,
          textFormat: format,
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? entry : t) : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openExplore: (messageId, index, title, chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const id = viewerTabId("explore", wsKey);
        const label = (title ?? "").trim();
        const entry = {
          id,
          kind: "explore",
          chatId: cid,
          wsKey,
          title: label ? `Explore \xB7 ${label.slice(0, 60)}` : "Explore",
          exploreMessageId: messageId,
          exploreIndex: index,
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, ...entry } : t) : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openTodos: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const id = viewerTabId("todos", wsKey);
        const entry = {
          id,
          kind: "todos",
          chatId: cid,
          wsKey,
          title: "Panel",
          createdAt: Date.now()
        };
        const tabs = capTabs(
          s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, chatId: cid, wsKey } : t) : [...s.tabs, entry]
        );
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openFiles: () => showExplorer(),
      openTerminal: (opts) => set((s) => {
        const cid = opts?.chatId ?? currentChatId();
        const wsKey = workspaceKeyForChat(cid || void 0);
        const program = (opts?.program ?? "").trim();
        const args = opts?.args ?? [];
        const target = program ? runTargetKey([program, ...args]) : opts?.fresh ? `shell-${Date.now()}-${shellCounter++}` : "shell";
        const id = viewerTabId("terminal", wsKey, target);
        const existing = program ? s.tabs.find(
          (t) => t.kind === "terminal" && t.terminalProgram != null && runTargetKey([t.terminalProgram, ...t.terminalArgs ?? []]) === target
        ) ?? s.tabs.find((t) => t.id === id) : s.tabs.find((t) => t.id === id);
        if (existing) {
          const reopenSeq = (existing.reopenSeq ?? 0) + 1;
          const title = opts?.title ?? existing.title;
          const tabs2 = s.tabs.map((t) => t === existing ? { ...t, title, reopenSeq } : t);
          const lastActiveByChat2 = cid ? { ...s.lastActiveByChat, [cid]: existing.id } : s.lastActiveByChat;
          return { tabs: tabs2, activeId: existing.id, paneOpen: true, lastActiveByChat: lastActiveByChat2, focusedViewerId: existing.id };
        }
        const cwd = opts?.cwd ?? useStore.getState().root ?? "";
        const entry = {
          id,
          kind: "terminal",
          chatId: cid,
          wsKey,
          // A terminal tab shows WHAT it runs ("nvim — a.ts", "zsh — codifa"):
          // "Terminal" for every one of them would make the rail unreadable.
          title: opts?.title || (program ? program : shellLabel(opts?.shell || DEFAULT_TERMINAL_SHELL)),
          terminalCwd: cwd,
          ...program ? { terminalProgram: program, terminalArgs: args } : { terminalShell: (opts?.shell ?? "").trim() || DEFAULT_TERMINAL_SHELL },
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, lastActiveByChat };
        const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(tabs.map((t) => t.id)));
        if (revealed?.tree && revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree);
        persist(next.tabs, next.activeId);
        return {
          ...next,
          viewerTree: revealed?.tree ?? s.viewerTree,
          focusedViewerId: revealed?.focusedId ?? s.focusedViewerId
        };
      }),
      closeViewer: (id) => set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return {};
        const removed = s.tabs[idx];
        notifyTabClosed(id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeId = s.activeId;
        if (s.activeId === id) {
          const scope = viewerScopeForChat(useStore.getState().activeChatId || void 0);
          const surfaces = visibleTabs(tabs, scope).filter((t) => TAB_STRIP_KINDS.has(t.kind));
          const terminals = visibleTabs(tabs, scope).filter((t) => t.kind === "terminal");
          const terminating = removed.kind === "terminal" && terminals.length > 0;
          const termIdx = Math.max(0, terminals.findIndex((t) => t.id === id));
          const nextTerminal = terminating ? terminals[Math.min(termIdx, terminals.length - 1)]?.id ?? terminals[0].id : null;
          activeId = nextTerminal ?? surfaces[Math.min(idx, surfaces.length - 1)]?.id ?? null;
        }
        const closedTabs = [
          { tab: removed, closedAt: Date.now() },
          ...s.closedTabs.filter((c2) => c2.tab.id !== id)
        ].slice(0, CLOSED_CAP);
        persist(tabs, activeId, closedTabs);
        const lastActiveByChat = { ...s.lastActiveByChat };
        if (removed.chatId && lastActiveByChat[removed.chatId] === id) {
          delete lastActiveByChat[removed.chatId];
        }
        let viewerTree = s.viewerTree;
        let focusedViewerId = s.focusedViewerId;
        if (viewerTree && containsChat(viewerTree, id)) {
          const valid = new Set(tabs.map((t) => t.id));
          viewerTree = normalizeTree(removeChat(viewerTree, id), valid);
          if (!viewerTree && tabs.length > 0) {
            const fallback = activeId && valid.has(activeId) ? activeId : tabs[0]?.id;
            viewerTree = fallback ? buildFromList([fallback], "row") : null;
          }
          persistViewerTree(viewerTree);
          const ids = viewerTree ? collectChatIds(viewerTree) : [];
          if (focusedViewerId === id || focusedViewerId && !ids.includes(focusedViewerId)) {
            focusedViewerId = activeId ?? ids[0] ?? null;
          }
        } else if (focusedViewerId === id) {
          focusedViewerId = activeId;
        }
        return { tabs, activeId, closedTabs, lastActiveByChat, viewerTree, focusedViewerId };
      }),
      closeAllViewers: (chatId) => set((s) => {
        const toClose = chatId ? visibleTabs(s.tabs, viewerScopeForChat(chatId)) : s.tabs;
        if (toClose.length === 0) return {};
        const closeIds = new Set(toClose.map((t) => t.id));
        for (const t of toClose) notifyTabClosed(t.id);
        const tabs = s.tabs.filter((t) => !closeIds.has(t.id));
        const scope = viewerScopeForChat(useStore.getState().activeChatId || void 0);
        const surfaces = visibleTabs(tabs, scope).filter((t) => TAB_STRIP_KINDS.has(t.kind));
        const activeId = s.activeId && closeIds.has(s.activeId) ? surfaces[surfaces.length - 1]?.id ?? null : s.activeId;
        const closedTabs = [
          ...toClose.map((tab) => ({ tab, closedAt: Date.now() })),
          ...s.closedTabs.filter((c2) => !closeIds.has(c2.tab.id))
        ].slice(0, CLOSED_CAP);
        persist(tabs, activeId, closedTabs);
        const lastActiveByChat = { ...s.lastActiveByChat };
        for (const removed of toClose) {
          if (removed.chatId && lastActiveByChat[removed.chatId] && closeIds.has(lastActiveByChat[removed.chatId])) {
            delete lastActiveByChat[removed.chatId];
          }
        }
        let viewerTree = s.viewerTree;
        let focusedViewerId = s.focusedViewerId;
        if (viewerTree && toClose.some((t) => containsChat(viewerTree, t.id))) {
          const valid = new Set(tabs.map((t) => t.id));
          let tree = viewerTree;
          for (const t of toClose) {
            tree = removeChat(tree, t.id);
            if (!tree) break;
          }
          viewerTree = normalizeTree(tree, valid);
          if (!viewerTree && tabs.length > 0) {
            const fallback = activeId && valid.has(activeId) ? activeId : tabs[0]?.id;
            viewerTree = fallback ? buildFromList([fallback], "row") : null;
          }
          persistViewerTree(viewerTree);
          const ids = viewerTree ? collectChatIds(viewerTree) : [];
          if (focusedViewerId && closeIds.has(focusedViewerId) || focusedViewerId && !ids.includes(focusedViewerId)) {
            focusedViewerId = activeId ?? ids[0] ?? null;
          }
        } else if (focusedViewerId && closeIds.has(focusedViewerId)) {
          focusedViewerId = activeId;
        }
        return { tabs, activeId, closedTabs, lastActiveByChat, viewerTree, focusedViewerId };
      }),
      renameViewer: (id, title) => set((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return {};
        const next = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (next === tab.title) return {};
        const tabs = s.tabs.map((t) => t.id === id ? { ...t, title: next } : t);
        persist(tabs, s.activeId, s.closedTabs);
        return { tabs };
      }),
      setActiveViewer: (id) => set((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return {};
        persist(s.tabs, id, s.closedTabs);
        const lastActiveByChat = tab.chatId ? { ...s.lastActiveByChat, [tab.chatId]: id } : s.lastActiveByChat;
        const revealed = revealViewerTab(s.viewerTree, id, s.focusedViewerId, new Set(s.tabs.map((t) => t.id)));
        if (!revealed) return { activeId: id, lastActiveByChat };
        if (revealed.tree !== s.viewerTree) persistViewerTree(revealed.tree);
        return {
          activeId: id,
          lastActiveByChat,
          viewerTree: revealed.tree,
          focusedViewerId: revealed.focusedId
        };
      }),
      reopenClosedViewerTab: (id) => set((s) => {
        const entry = s.closedTabs.find((c2) => c2.tab.id === id);
        if (!entry) return {};
        if (EPHEMERAL_KINDS.has(entry.tab.kind) || entry.tab.kind === "terminal") {
          const closedTabs2 = s.closedTabs.filter((c2) => c2.tab.id !== id);
          persist(s.tabs, s.activeId, closedTabs2);
          return { closedTabs: closedTabs2 };
        }
        const closedTabs = s.closedTabs.filter((c2) => c2.tab.id !== id);
        const exists = s.tabs.some((t) => t.id === id);
        const tabs = capTabs(exists ? s.tabs : [...s.tabs, entry.tab]);
        const lastActiveByChat = entry.tab.chatId ? { ...s.lastActiveByChat, [entry.tab.chatId]: id } : s.lastActiveByChat;
        const next = { closedTabs, tabs, activeId: id, paneOpen: true, lastActiveByChat };
        persist(next.tabs, next.activeId, next.closedTabs);
        return next;
      }),
      setFullscreen: (v) => set(() => {
        persistFullscreen(v);
        return { fullscreen: v };
      }),
      toggleFullscreen: () => set((s) => {
        persistFullscreen(!s.fullscreen);
        return { fullscreen: !s.fullscreen };
      }),
      moveViewerTab: (fromId, toId, after = false) => set((s) => {
        const from = s.tabs.findIndex((t) => t.id === fromId);
        const to = s.tabs.findIndex((t) => t.id === toId);
        if (from === -1 || to === -1 || from === to) return {};
        const tabs = s.tabs.slice();
        const [moved] = tabs.splice(from, 1);
        let dest = tabs.findIndex((t) => t.id === toId) + (after ? 1 : 0);
        dest = Math.max(0, Math.min(tabs.length, dest));
        tabs.splice(dest, 0, moved);
        persist(tabs, fromId);
        const lastActiveByChat = moved.chatId ? { ...s.lastActiveByChat, [moved.chatId]: fromId } : s.lastActiveByChat;
        return { tabs, activeId: fromId, lastActiveByChat };
      }),
      ensureViewerTree: () => set((s) => {
        const valid = new Set(s.tabs.map((t) => t.id));
        let tree = s.viewerTree ? normalizeTree(s.viewerTree, valid) : null;
        if (!tree) {
          if (s.tabs.length === 0) {
            if (s.viewerTree !== null || s.focusedViewerId !== null) {
              persistViewerTree(null);
              return { viewerTree: null, focusedViewerId: null };
            }
            return {};
          }
          const id = s.activeId && valid.has(s.activeId) ? s.activeId : s.tabs[0].id;
          tree = buildFromList([id], "row");
        }
        let focusedViewerId = s.focusedViewerId;
        const revealed = revealViewerTab(tree, s.activeId, focusedViewerId, valid);
        if (revealed) {
          tree = revealed.tree;
          focusedViewerId = revealed.focusedId;
        }
        persistViewerTree(tree);
        const ids = collectChatIds(tree);
        if (!focusedViewerId || !ids.includes(focusedViewerId)) {
          focusedViewerId = s.activeId && ids.includes(s.activeId) ? s.activeId : ids[0] ?? null;
        }
        if (tree === s.viewerTree && focusedViewerId === s.focusedViewerId) return {};
        return { viewerTree: tree, focusedViewerId };
      }),
      openViewerInWindow: (id) => set((s) => {
        if (!s.tabs.some((t) => t.id === id)) return {};
        let tree = s.viewerTree ?? (s.activeId ? buildFromList([s.activeId], "row") : null);
        if (!tree) tree = buildFromList([id], "row");
        else if (!containsChat(tree, id)) {
          if (leafCount(tree) >= VIEWER_WINDOW_MAX) {
            persist(s.tabs, id, s.closedTabs);
            return { activeId: id, focusedViewerId: id };
          }
          tree = appendChat(tree, id, "row");
        }
        persistViewerTree(tree);
        persist(s.tabs, id, s.closedTabs);
        return { viewerTree: tree, activeId: id, focusedViewerId: id, paneOpen: true };
      }),
      dropViewerOnto: (dragId, targetId, pos) => set((s) => {
        if (!dragId || !targetId || dragId === targetId) return {};
        if (!s.tabs.some((t) => t.id === dragId) || !s.tabs.some((t) => t.id === targetId)) return {};
        const base2 = s.viewerTree ?? buildFromList([targetId], "row");
        if (!base2) return {};
        if (!containsChat(base2, dragId) && leafCount(base2) >= VIEWER_WINDOW_MAX) {
          persist(s.tabs, s.activeId, s.closedTabs);
          return { activeId: targetId, focusedViewerId: targetId };
        }
        const tree = dropOnto(base2, dragId, targetId, pos);
        if (!tree) return {};
        persistViewerTree(tree);
        persist(s.tabs, dragId, s.closedTabs);
        return { viewerTree: tree, activeId: dragId, focusedViewerId: dragId, paneOpen: true };
      }),
      closeViewerWindow: (id) => set((s) => {
        if (!s.viewerTree || !containsChat(s.viewerTree, id)) return {};
        const ids = collectChatIds(s.viewerTree);
        if (ids.length <= 1) return {};
        const idx = ids.indexOf(id);
        const valid = new Set(s.tabs.map((t) => t.id));
        const tree = normalizeTree(removeChat(s.viewerTree, id), valid) ?? buildFromList(ids.filter((x) => x !== id), "row");
        persistViewerTree(tree);
        const nextIds = collectChatIds(tree);
        const fallback = nextIds[Math.min(Math.max(idx, 0), nextIds.length - 1)] ?? nextIds[0] ?? s.activeId;
        persist(s.tabs, fallback, s.closedTabs);
        return { viewerTree: tree, activeId: fallback, focusedViewerId: fallback };
      }),
      focusViewerWindow: (id) => set((s) => {
        if (!s.tabs.some((t) => t.id === id)) return {};
        if (s.focusedViewerId === id && s.activeId === id) return {};
        const tab = s.tabs.find((t) => t.id === id);
        persist(s.tabs, id, s.closedTabs);
        const lastActiveByChat = tab?.chatId ? { ...s.lastActiveByChat, [tab.chatId]: id } : s.lastActiveByChat;
        return { activeId: id, focusedViewerId: id, lastActiveByChat };
      }),
      resizeViewerPair: (parentId, firstId, secondId, firstSize, secondSize) => set((s) => {
        if (!s.viewerTree) return {};
        const tree = resizePair(s.viewerTree, parentId, firstId, secondId, firstSize, secondSize);
        if (!tree || tree === s.viewerTree) return {};
        persistViewerTree(tree);
        return { viewerTree: tree };
      }),
      setViewerTreeNodeSize: (nodeId, size) => set((s) => {
        if (!s.viewerTree) return {};
        const tree = setNodeSize(s.viewerTree, nodeId, size);
        if (!tree || tree === s.viewerTree) return {};
        persistViewerTree(tree);
        return { viewerTree: tree };
      })
    }));
    registerChatDeleteHook((chatId) => {
      useViewerTabs.getState().closeAllViewers(chatId);
    });
    scopesMigrated = false;
    unsubScopeMigration = null;
    migrateTabScopes();
    unsubScopeMigration = useStore.subscribe(migrateTabScopes);
  }
});

// src/components/FileIcon.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function Tile({
  size,
  fill,
  children
}) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      className: "file-icon-svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx(
          "rect",
          {
            x: "2",
            y: "2",
            width: "20",
            height: "20",
            rx: "6",
            fill,
            stroke: "rgba(0,0,0,0.32)",
            strokeWidth: "1"
          }
        ),
        /* @__PURE__ */ jsx(
          "rect",
          {
            x: "3",
            y: "3",
            width: "18",
            height: "9",
            rx: "4",
            fill: "#ffffff",
            opacity: "0.10"
          }
        ),
        /* @__PURE__ */ jsx(
          "rect",
          {
            x: "2.5",
            y: "2.5",
            width: "19",
            height: "19",
            rx: "5.5",
            fill: "none",
            stroke: "rgba(255,255,255,0.14)",
            strokeWidth: "1"
          }
        ),
        children
      ]
    }
  );
}
function Monogram({ label, color }) {
  const fontSize = label.length === 1 ? 11.5 : label.length <= 2 ? 9.2 : label.length === 3 ? 7.2 : 5.8;
  return /* @__PURE__ */ jsx(
    "text",
    {
      x: "12",
      y: "12.6",
      textAnchor: "middle",
      dominantBaseline: "central",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      fontSize,
      fontWeight: "800",
      letterSpacing: "0.01em",
      fill: color,
      children: label
    }
  );
}
function ReactIcon({ size }) {
  return /* @__PURE__ */ jsxs("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxs("g", { fill: "none", stroke: "#61dafb", strokeWidth: "1.5", children: [
      /* @__PURE__ */ jsx("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7" }),
      /* @__PURE__ */ jsx("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7", transform: "rotate(60 12 12)" }),
      /* @__PURE__ */ jsx("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7", transform: "rotate(-60 12 12)" })
    ] }),
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "1.9", fill: "#61dafb" })
  ] });
}
function PythonIcon({ size }) {
  return /* @__PURE__ */ jsxs("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 128 128", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx("path", { d: PYTHON_BLUE, fill: "#3776ab" }),
    /* @__PURE__ */ jsx("path", { d: PYTHON_YELLOW, fill: "#ffd43b" })
  ] });
}
function MarkdownIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#083fa1", children: /* @__PURE__ */ jsxs("g", { stroke: "#ffffff", strokeWidth: "1.7", fill: "none", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx("path", { d: "M5.4 15.8V8.2l3 3.5 3-3.5v7.6" }),
    /* @__PURE__ */ jsx("path", { d: "M17 8.2v7.4M14.5 13.4l2.5 2.6 2.5-2.6" })
  ] }) });
}
function ShieldMonogram({ size, fill, numeral, textColor }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill, children: [
    /* @__PURE__ */ jsx("path", { d: "M6.4 5.4h11.2l-1 11.6L12 18.8l-4.6-1.8z", fill: "#ffffff", opacity: "0.96" }),
    /* @__PURE__ */ jsx(
      "text",
      {
        x: "12",
        y: "13",
        textAnchor: "middle",
        dominantBaseline: "central",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "9",
        fontWeight: "700",
        fill: textColor,
        children: numeral
      }
    )
  ] });
}
function ShellIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#89e051", children: /* @__PURE__ */ jsxs("g", { stroke: "#1e3b0d", strokeWidth: "2", fill: "none", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx("path", { d: "M7.2 8.4l3.6 3.6-3.6 3.6" }),
    /* @__PURE__ */ jsx("path", { d: "M12.6 15.6h4.2" })
  ] }) });
}
function JsonIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#cbcb41", children: /* @__PURE__ */ jsxs("g", { stroke: "#3b3106", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx("path", { d: "M11.2 6.8c-1.6 0-2.4.8-2.4 2.2v1.2c0 1-.6 1.6-1.7 1.8 1.1.2 1.7.8 1.7 1.8v1.2c0 1.4.8 2.2 2.4 2.2" }),
    /* @__PURE__ */ jsx("path", { d: "M12.8 6.8c1.6 0 2.4.8 2.4 2.2v1.2c0 1 .6 1.6 1.7 1.8-1.1.2-1.7.8-1.7 1.8v1.2c0 1.4-.8 2.2-2.4 2.2" })
  ] }) });
}
function SqlIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#e38c00", children: /* @__PURE__ */ jsxs("g", { stroke: "#ffffff", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx("ellipse", { cx: "12", cy: "7.6", rx: "6", ry: "2.4" }),
    /* @__PURE__ */ jsx("path", { d: "M6 7.6v8.8c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V7.6" }),
    /* @__PURE__ */ jsx("path", { d: "M6 12c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4", opacity: "0.65" })
  ] }) });
}
function RubyIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#9b1111", children: [
    /* @__PURE__ */ jsx("path", { d: "M7.2 8h9.6l3 4-7.8 7.4L4.2 12z", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsxs("g", { stroke: "#9b1111", strokeWidth: "1.1", fill: "none", strokeLinejoin: "round", children: [
      /* @__PURE__ */ jsx("path", { d: "M4.2 12h15.6" }),
      /* @__PURE__ */ jsx("path", { d: "M7.2 8l2.3 4 2.5-4 2.5 4 2.3-4" }),
      /* @__PURE__ */ jsx("path", { d: "M9.5 12L12 19.4l2.5-7.4" })
    ] })
  ] });
}
function PhpIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#4f5d95", children: [
    /* @__PURE__ */ jsx("ellipse", { cx: "12", cy: "12", rx: "8.4", ry: "4.7", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx(
      "text",
      {
        x: "12",
        y: "12.6",
        textAnchor: "middle",
        dominantBaseline: "central",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        fontSize: "5.4",
        fontWeight: "800",
        fontStyle: "italic",
        fill: "#4f5d95",
        children: "php"
      }
    )
  ] });
}
function JavaIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#5382a1", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M6.8 10.2h8.4v3.4a3.5 3.5 0 0 1-3.5 3.5h-1.4a3.5 3.5 0 0 1-3.5-3.5z",
        fill: "#ffffff",
        opacity: "0.95"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M15.4 11h1.2a2 2 0 0 1 0 4h-1.6",
        fill: "none",
        stroke: "#ffffff",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ jsxs("g", { fill: "none", stroke: "#ffffff", strokeWidth: "1.4", strokeLinecap: "round", children: [
      /* @__PURE__ */ jsx("path", { d: "M9.4 5.2c0 1.1.9 1.3.9 2.4" }),
      /* @__PURE__ */ jsx("path", { d: "M12.6 5.2c0 1.1.9 1.3.9 2.4" })
    ] })
  ] });
}
function KotlinIcon({ size }) {
  return /* @__PURE__ */ jsxs("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx("path", { d: "M3.4 3.4h17.2v17.2H3.4z", fill: "#a855f7" }),
    /* @__PURE__ */ jsx("path", { d: "M20.6 3.4L3.4 20.6h17.2z", fill: "#f97316" })
  ] });
}
function LuaIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#000080", children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12.2", r: "6.6", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx("circle", { cx: "14.1", cy: "10.1", r: "6.6", fill: "#000080" }),
    /* @__PURE__ */ jsx("circle", { cx: "17.4", cy: "6.6", r: "1.5", fill: "#ffffff" })
  ] });
}
function GearGlyph({ size, fill, letter, letterColor }) {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315];
  return /* @__PURE__ */ jsxs(Tile, { size, fill, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "6.4", fill: "none", stroke: "#ffffff", strokeWidth: "1.7", opacity: "0.95" }),
    teeth.map((deg) => /* @__PURE__ */ jsx(
      "rect",
      {
        x: "11.15",
        y: "2.6",
        width: "1.7",
        height: "3",
        rx: "0.7",
        fill: "#ffffff",
        opacity: "0.95",
        transform: `rotate(${deg} 12 12)`
      },
      deg
    )),
    letter ? /* @__PURE__ */ jsx(Monogram, { label: letter, color: letterColor ?? "#57330f" }) : null
  ] });
}
function VueIcon({ size }) {
  return /* @__PURE__ */ jsxs("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx("path", { d: "M2.4 4.4h4.9L12 12.2l4.7-7.8h4.9L12 21.2z", fill: "#41b883" }),
    /* @__PURE__ */ jsx("path", { d: "M7.3 4.4h2.6L12 8l2.1-3.6h2.6L12 13.1z", fill: "#35495e" })
  ] });
}
function GraphqlIcon({ size }) {
  return /* @__PURE__ */ jsxs("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M12 5.2l5.9 3.4v6.8L12 18.8l-5.9-3.4V8.6z",
        fill: "none",
        stroke: "#e10098",
        strokeWidth: "1.4"
      }
    ),
    /* @__PURE__ */ jsxs("g", { fill: "#e10098", children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "5.2", r: "1.5" }),
      /* @__PURE__ */ jsx("circle", { cx: "17.9", cy: "8.6", r: "1.5" }),
      /* @__PURE__ */ jsx("circle", { cx: "17.9", cy: "15.4", r: "1.5" }),
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "18.8", r: "1.5" }),
      /* @__PURE__ */ jsx("circle", { cx: "6.1", cy: "15.4", r: "1.5" }),
      /* @__PURE__ */ jsx("circle", { cx: "6.1", cy: "8.6", r: "1.5" })
    ] })
  ] });
}
function ElixirIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#6e4a7e", children: /* @__PURE__ */ jsx(
    "path",
    {
      d: "M12 3.8c2.5 3.2 5 6.1 5 9.3a5 5 0 0 1-10 0c0-3.2 2.5-6.1 5-9.3z",
      fill: "#c79fe0"
    }
  ) });
}
function CsvIcon({ size }) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: "#0f9d58", children: /* @__PURE__ */ jsxs("g", { stroke: "#ffffff", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx("rect", { x: "5", y: "6", width: "14", height: "12", rx: "1.6" }),
    /* @__PURE__ */ jsx("path", { d: "M5 10.1h14M10.3 6v12", opacity: "0.9" })
  ] }) });
}
function ZipIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#b98a3f", children: [
    /* @__PURE__ */ jsx("rect", { x: "6.6", y: "4.2", width: "10.8", height: "15.6", rx: "1.8", fill: "none", stroke: "#ffffff", strokeWidth: "1.5", opacity: "0.95" }),
    /* @__PURE__ */ jsx("path", { d: "M12 5.6v12.8", stroke: "#ffffff", strokeWidth: "1.6", strokeDasharray: "2.1 1.9", strokeLinecap: "round" })
  ] });
}
function AndroidIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#3ddc84", children: [
    /* @__PURE__ */ jsx("path", { d: "M5.9 14.6a6.1 6.1 0 0 1 12.2 0z", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsxs("g", { stroke: "#ffffff", strokeWidth: "1.4", strokeLinecap: "round", children: [
      /* @__PURE__ */ jsx("path", { d: "M8.3 6.4L7 4.4" }),
      /* @__PURE__ */ jsx("path", { d: "M15.7 6.4L17 4.4" })
    ] }),
    /* @__PURE__ */ jsx("circle", { cx: "9.6", cy: "12", r: "0.85", fill: "#3ddc84" }),
    /* @__PURE__ */ jsx("circle", { cx: "14.4", cy: "12", r: "0.85", fill: "#3ddc84" })
  ] });
}
function PictureIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#a074c4", children: [
    /* @__PURE__ */ jsx("circle", { cx: "9.3", cy: "9.6", r: "1.7", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M5.5 16.8l4.6-5 3.1 3.2 2.5-2.4 3.8 4.2z",
        fill: "#ffffff",
        opacity: "0.92"
      }
    )
  ] });
}
function AudioIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#2aa895", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M10 16.8V8.2l7.5-1.6v8.2",
        fill: "none",
        stroke: "#ffffff",
        strokeWidth: "1.8",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        opacity: "0.95"
      }
    ),
    /* @__PURE__ */ jsx("circle", { cx: "7.8", cy: "16.8", r: "2.1", fill: "#ffffff" }),
    /* @__PURE__ */ jsx("circle", { cx: "15.3", cy: "14.8", r: "2.1", fill: "#ffffff" })
  ] });
}
function VideoIcon({ size }) {
  return /* @__PURE__ */ jsxs(Tile, { size, fill: "#9b4ab8", children: [
    /* @__PURE__ */ jsx(
      "rect",
      {
        x: "5.2",
        y: "7.5",
        width: "9.3",
        height: "9",
        rx: "2.2",
        fill: "rgba(255,255,255,0.28)"
      }
    ),
    /* @__PURE__ */ jsx("path", { d: "M8.4 10.3l3.8 2.2-3.8 2.2z", fill: "#ffffff" }),
    /* @__PURE__ */ jsx("path", { d: "M14.8 10.5l4.2-2.5v8l-4.2-2.5z", fill: "#ffffff", opacity: "0.95" })
  ] });
}
function Html5Icon({ size }) {
  return /* @__PURE__ */ jsx(ShieldMonogram, { size, fill: "#e34f26", numeral: "5", textColor: "#e34f26" });
}
function GenericIcon({ size }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      className: "file-icon-svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M6.5 3h6.8L18 7.7V20a1.6 1.6 0 0 1-1.6 1.6H6.5A1.6 1.6 0 0 1 4.9 20V4.6A1.6 1.6 0 0 1 6.5 3z",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            style: { opacity: 0.65 }
          }
        ),
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M13.3 3v4.7H18",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinejoin: "round",
            style: { opacity: 0.65 }
          }
        ),
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M8 12.5h8M8 15.5h5.5",
            stroke: "currentColor",
            strokeWidth: "1.4",
            strokeLinecap: "round",
            style: { opacity: 0.4 }
          }
        )
      ]
    }
  );
}
function BadgeIcon({
  label,
  bg,
  fg,
  size
}) {
  return /* @__PURE__ */ jsx(Tile, { size, fill: bg, children: /* @__PURE__ */ jsx(Monogram, { label, color: fg }) });
}
function FileIcon({
  path,
  size = 16
}) {
  const base2 = fileBasename(path);
  const dot = base2.lastIndexOf(".");
  const ext = dot > 0 || base2.startsWith(".") ? base2.slice(dot + 1).toLowerCase() : "";
  const lowerBase = base2.toLowerCase();
  const badge = FILE_BADGES[ext] ?? (lowerBase in FILE_BADGES ? FILE_BADGES[lowerBase] : void 0);
  if (ext === "tsx" || ext === "jsx") return /* @__PURE__ */ jsx(ReactIcon, { size });
  if (ext === "py" || ext === "pyi") return /* @__PURE__ */ jsx(PythonIcon, { size });
  if (ext === "md" || ext === "markdown" || ext === "mdx") return /* @__PURE__ */ jsx(MarkdownIcon, { size });
  if (ext === "css") return /* @__PURE__ */ jsx(ShieldMonogram, { size, fill: "#264de4", numeral: "3", textColor: "#264de4" });
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return /* @__PURE__ */ jsx(ShellIcon, { size });
  if (ext === "json" || ext === "jsonc") return /* @__PURE__ */ jsx(JsonIcon, { size });
  if (ext === "sql") return /* @__PURE__ */ jsx(SqlIcon, { size });
  if (ext === "rb") return /* @__PURE__ */ jsx(RubyIcon, { size });
  if (ext === "php") return /* @__PURE__ */ jsx(PhpIcon, { size });
  if (ext === "java" || ext === "jar" || ext === "war") return /* @__PURE__ */ jsx(JavaIcon, { size });
  if (ext === "kt") return /* @__PURE__ */ jsx(KotlinIcon, { size });
  if (ext === "lua") return /* @__PURE__ */ jsx(LuaIcon, { size });
  if (ext === "rs") return /* @__PURE__ */ jsx(GearGlyph, { size, fill: "#dea584", letter: "R" });
  if (ext === "vue") return /* @__PURE__ */ jsx(VueIcon, { size });
  if (ext === "graphql" || ext === "gql") return /* @__PURE__ */ jsx(GraphqlIcon, { size });
  if (ext === "ex" || ext === "exs") return /* @__PURE__ */ jsx(ElixirIcon, { size });
  if (ext === "csv" || ext === "tsv") return /* @__PURE__ */ jsx(CsvIcon, { size });
  if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "bz2" || ext === "xz" || ext === "7z" || ext === "rar") return /* @__PURE__ */ jsx(ZipIcon, { size });
  if (ext === "apk" || ext === "aab") return /* @__PURE__ */ jsx(AndroidIcon, { size });
  if (ext === "dylib" || ext === "so" || ext === "dll" || ext === "exe" || ext === "bin") return /* @__PURE__ */ jsx(GearGlyph, { size, fill: "#6b7280" });
  if (ext === "wasm") return /* @__PURE__ */ jsx(GearGlyph, { size, fill: "#654ff0", letter: "W", letterColor: "#ffffff" });
  if (ext === "html" || ext === "htm") return /* @__PURE__ */ jsx(Html5Icon, { size });
  if (IMAGE_EXTS.has(ext)) return /* @__PURE__ */ jsx(PictureIcon, { size });
  if (AUDIO_EXTS.has(ext)) return /* @__PURE__ */ jsx(AudioIcon, { size });
  if (VIDEO_EXTS.has(ext)) return /* @__PURE__ */ jsx(VideoIcon, { size });
  if (badge) {
    return /* @__PURE__ */ jsx(BadgeIcon, { label: badge.label, bg: badge.bg, fg: badge.fg, size });
  }
  return /* @__PURE__ */ jsx(GenericIcon, { size });
}
function openWorkspaceFile(path, line) {
  let clean = normPath(path);
  if (!clean) return;
  if (line === void 0) {
    const m = clean.match(/^(.+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/);
    if (m) {
      clean = m[1];
      line = Number(m[2]);
    }
  }
  try {
    window.dispatchEvent(
      new CustomEvent("coder:open-file", { detail: { path: clean, line } })
    );
  } catch {
  }
  const st = useStore.getState();
  if (st.chatFullscreen) st.setChatFullscreen(false);
  const root = st.chats.find((c2) => c2.id === st.activeChatId)?.root ?? st.root;
  useViewerTabs.getState().openFile(clean, line, root);
}
function FileChip({
  path,
  line,
  display,
  className,
  onClick
}) {
  const handle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.();
    openWorkspaceFile(path, line);
  };
  const label = display ?? path;
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      className: `file-chip${className ? ` ${className}` : ""}`,
      dir: "ltr",
      title: `${path}${line ? `:${line}` : ""} \u2014 click to open`,
      onPointerDown: handle,
      onClick: handle,
      children: /* @__PURE__ */ jsx("span", { className: "file-chip-name", dir: "ltr", children: label })
    }
  );
}
var PYTHON_BLUE, PYTHON_YELLOW;
var init_FileIcon = __esm({
  "src/components/FileIcon.tsx"() {
    "use strict";
    init_store();
    init_fs();
    init_viewerTabs();
    init_fileTypes();
    PYTHON_BLUE = "M63.391 1.988c-4.222.02-8.252.379-11.8 1.007-10.45 1.846-12.346 5.71-12.346 12.837v9.411h24.693v3.137H29.977c-7.176 0-13.46 4.313-15.426 12.521-2.268 9.405-2.368 15.275 0 25.096 1.755 7.311 5.947 12.519 13.124 12.519h8.491V67.234c0-8.151 7.051-15.34 15.426-15.34h24.665c6.866 0 12.346-5.654 12.346-12.548V15.833c0-6.693-5.646-11.72-12.346-12.837-4.244-.706-8.645-1.027-12.84-1.008zM50.037 9.557c2.55 0 4.634 2.117 4.634 4.721 0 2.593-2.083 4.69-4.634 4.69-2.56 0-4.633-2.097-4.633-4.69-.001-2.604 2.073-4.721 4.633-4.721z";
    PYTHON_YELLOW = "M91.682 28.38v10.966c0 8.5-7.208 15.655-15.426 15.655H51.591c-6.756 0-12.346 5.783-12.346 12.549v23.515c0 6.691 5.818 10.628 12.346 12.547 7.816 2.297 15.312 2.713 24.665 0 6.216-1.801 12.346-5.423 12.346-12.547v-9.412H63.938v-3.138h37.012c7.176 0 9.852-5.005 12.348-12.519 2.578-7.735 2.467-15.174 0-25.096-1.774-7.145-5.161-12.521-12.348-12.521h-9.268zM77.809 87.927c2.561 0 4.634 2.097 4.634 4.692 0 2.602-2.074 4.719-4.634 4.719-2.55 0-4.633-2.117-4.633-4.719 0-2.595 2.083-4.692 4.633-4.692z";
  }
});

// src/lib/renderCap.ts
function fmtSize(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}KB`;
  return `${n} chars`;
}
var RENDER_CAP;
var init_renderCap = __esm({
  "src/lib/renderCap.ts"() {
    "use strict";
    RENDER_CAP = 1e5;
  }
});

// src/lib/messageViewEqual.ts
function chatMessageViewPropsEqual(prev, next) {
  if (prev.onRetry !== next.onRetry) return false;
  if (prev.onResume !== next.onResume) return false;
  if (prev.onCompactRetry !== next.onCompactRetry) return false;
  if (prev.onEdit !== next.onEdit) return false;
  if (prev.editingDisabled !== next.editingDisabled) return false;
  const a = prev.message;
  const b = next.message;
  if (a === b) return true;
  return a.id === b.id && a.role === b.role && a.content === b.content && a.streaming === b.streaming && a.thinking === b.thinking && a.thinkingActive === b.thinkingActive && a.thinkingStartedAt === b.thinkingStartedAt && a.workingStartedAt === b.workingStartedAt && a.turnElapsedMs === b.turnElapsedMs && a.error === b.error && // `errorReason` and `footerStatus` decide whether the footer renders a
  // notice at all. Without them here, the prop change created by
  // `{ ...m, footerStatus }` in Chat.tsx compared EQUAL and the component
  // skipped re-rendering — the footer notice never appeared.
  a.errorReason === b.errorReason && a.footerStatus?.text === b.footerStatus?.text && a.footerStatus?.kind === b.footerStatus?.kind && a.footerStatus?.percent === b.footerStatus?.percent && a.footerStatus?.elapsedSecs === b.footerStatus?.elapsedSecs && a.footerStatus?.budgetSecs === b.footerStatus?.budgetSecs && a.footerStatus?.attempt === b.footerStatus?.attempt && a.footerStatus?.attempts === b.footerStatus?.attempts && a.footerStatus?.action === b.footerStatus?.action && a.retry === b.retry && a.toolActivity === b.toolActivity && a.segments === b.segments && a.plan === b.plan && a.planDoc === b.planDoc && a.attachments === b.attachments && a.images === b.images && a.usage === b.usage && a.compacted === b.compacted && a.mode === b.mode && a.modeSwitch === b.modeSwitch && a.steerPending === b.steerPending && a.steerInterleaved === b.steerInterleaved && a.statusText === b.statusText && a.lspStatus === b.lspStatus && a.interrupted === b.interrupted;
}
var init_messageViewEqual = __esm({
  "src/lib/messageViewEqual.ts"() {
    "use strict";
  }
});

// src/lib/planDoc.ts
function isPlanDoc(doc) {
  const body = (doc?.body ?? "").trim();
  if (!body) return false;
  if (hasHeading(body)) return true;
  const stepLines = body.split("\n").filter((l) => /^\s*(?:[-*|]|\d+[.)])\s/.test(l));
  return stepLines.length >= 2;
}
function hasHeading(body) {
  return /^#{1,6}\s/m.test(body);
}
function planDisplay(message) {
  const stored = isPlanDoc(message.planDoc) ? message.planDoc : null;
  const artifact = planFromArtifact(message);
  const planDoc = artifact ?? (stored && hasHeading(stored.body) ? stored : planFromMessage(message));
  if (!planDoc) return { content: message.content, segments: message.segments };
  const exact = planDoc === message.planDoc;
  let segments = message.segments;
  if (segments && segments.length > 0) {
    const planStart = (text) => {
      const bodyIdx = planDoc.body ? text.lastIndexOf(planDoc.body) : -1;
      if (bodyIdx >= 0) return { start: bodyIdx, end: bodyIdx + planDoc.body.length };
      const m = text.match(/^#{1,3}\s*(plan|پلن)\b/im);
      return m && m.index != null ? { start: m.index, end: text.length } : null;
    };
    const kept = [];
    let planStarted = false;
    for (const seg of segments) {
      if (seg.kind !== "text") {
        kept.push(seg);
        continue;
      }
      if (planStarted && exact) continue;
      const span = planStart(seg.text);
      if (!span) {
        kept.push(seg);
        continue;
      }
      planStarted = true;
      const before = seg.text.slice(0, span.start).trimEnd();
      if (before) kept.push({ kind: "text", text: before });
      if (!exact) {
        const after = seg.text.slice(span.end).trim();
        if (after) kept.push({ kind: "text", text: after });
      }
    }
    if (!planStarted) {
      if (artifact) {
        segments = kept;
      } else {
        let lastTool = -1;
        for (let i = 0; i < kept.length; i++) {
          if (kept[i].kind !== "text") lastTool = i;
        }
        segments = lastTool >= 0 ? kept.slice(0, lastTool + 1) : [];
      }
    } else {
      segments = kept;
    }
    segments = planDoc.preamble && !segments.some((s) => s.kind === "text") ? [{ kind: "text", text: planDoc.preamble }, ...segments] : segments;
  }
  let content = message.content;
  if (content) {
    const bodyIdx = planDoc.body ? content.lastIndexOf(planDoc.body) : -1;
    if (bodyIdx >= 0 && exact) {
      content = content.slice(0, bodyIdx).trimEnd();
    } else if (bodyIdx >= 0) {
      content = (content.slice(0, bodyIdx) + content.slice(bodyIdx + planDoc.body.length)).trim();
    } else {
      const m = content.match(/^#{1,3}\s*(plan|پلن)\b[^\n]*$/im);
      if (m && m.index != null) {
        content = content.slice(0, m.index).trimEnd();
      }
    }
  }
  return { content, segments, planDoc };
}
function planFromMessage(message) {
  if (message.mode !== "plan") return null;
  const texts = (message.segments ?? []).filter((s) => s.kind === "text").map((s) => s.text).concat(message.content ? [message.content] : []);
  for (const text of texts) {
    const start = text.search(/^#{1,3}\s*(plan|پلن)\b/im);
    if (start < 0) continue;
    const body = text.slice(start).trim();
    if (isPlanDoc({ body })) return { title: "", body };
  }
  return null;
}
function looksLikePlanName(text) {
  return /\bplan(?:ning|s)?\b|پلن|طرح/i.test(text);
}
function planFromArtifact(message) {
  if (message.mode !== "plan") return null;
  for (const seg of message.segments ?? []) {
    if (seg.kind !== "artifact" || seg.artifactKind !== "md") continue;
    const body = (seg.content ?? "").trim();
    if (!body || !isPlanDoc({ body })) continue;
    const title = (seg.title ?? "").trim();
    const heading = /^#{1,6}[ \t]*(.+)$/m.exec(body)?.[1] ?? "";
    if (!looksLikePlanName(title) && !looksLikePlanName(heading)) continue;
    return { title, body };
  }
  return null;
}
var init_planDoc = __esm({
  "src/lib/planDoc.ts"() {
    "use strict";
  }
});

// src/lib/tts.ts
import { useCallback as useCallback2, useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
function notifyTts() {
  for (const l of listeners) {
    try {
      l(activeStatus, activeOwner);
    } catch {
    }
  }
}
function friendlyTtsError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.trim();
  if (!msg) return "\u067E\u062E\u0634 \u0635\u062F\u0627 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F \u2014 \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F";
  const lower = msg.toLowerCase();
  const timedOut = lower.includes("timeout") || lower.includes("timed out");
  if (!timedOut && (lower.includes("aborted") || lower.includes("aborterror"))) return "";
  if (msg.includes("the local backend is not ready")) return "\u0633\u0631\u0648\u06CC\u0633 \u0635\u0648\u062A\u06CC \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A \u2014 \u0628\u0631\u0646\u0627\u0645\u0647 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u06A9\u0646\u06CC\u062F";
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("load failed"))
    return "\u0627\u0631\u062A\u0628\u0627\u0637 \u0628\u0627 \u0633\u0631\u0648\u06CC\u0633 \u0635\u0648\u062A\u06CC \u0642\u0637\u0639 \u0634\u062F \u2014 \u0627\u062A\u0635\u0627\u0644 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A/\u0633\u0631\u0648\u0631 \u0645\u062D\u0644\u06CC \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "\u0633\u0627\u062E\u062A \u0635\u062F\u0627 \u0637\u0648\u0644 \u06A9\u0634\u06CC\u062F \u2014 \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F \u06CC\u0627 \u0645\u062A\u0646 \u06A9\u0648\u062A\u0627\u0647\u200C\u062A\u0631\u06CC \u0628\u062F\u0647\u06CC\u062F";
  if (msg.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("bad key"))
    return "\u06A9\u0644\u06CC\u062F \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 TTS \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A \u2014 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u2190 \u0645\u062F\u0644\u200C\u0647\u0627 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F";
  if (msg.includes("402") || msg.includes("429") || lower.includes("quota") || lower.includes("insufficient") || lower.includes("rate limit"))
    return "\u0633\u0647\u0645\u06CC\u0647 TTS \u062A\u0645\u0627\u0645 \u0634\u062F\u0647 \u06CC\u0627 \u0645\u062D\u062F\u0648\u062F \u0634\u062F \u2014 \u0627\u0639\u062A\u0628\u0627\u0631/\u067E\u0644\u0646 \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F";
  if (msg.includes("remote speech synthesis failed") || msg.includes("speech synthesis failed"))
    return `\u0633\u0627\u062E\u062A \u0635\u062F\u0627 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F \u2014 ${msg}`;
  return msg.length > 300 ? `${msg.slice(0, 300)}\u2026` : msg;
}
function subscribeTts(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function stopTtsGlobal() {
  activeSeq = -1;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }
  activeOwner = -1;
  if (activeStatus !== "idle") {
    activeStatus = "idle";
    notifyTts();
  }
}
function stopTts(owner) {
  if (owner === void 0 || activeOwner === owner) stopTtsGlobal();
}
function spokenForm(text) {
  if (!/[A-Za-z]/.test(text)) return text;
  if (!/[؀-ۿ]/.test(text)) return text;
  let out = text;
  out = out.replace(/[\w.@-]+(?:\/[\w.@-]+)+(?::\d+(?:[-–]\d+)?)?/g, " ");
  out = out.replace(/([A-Za-z])[:](\d+)(?:[-–]\d+)?/g, "$1");
  out = out.replace(/([A-Za-z0-9])[_]+(?=[A-Za-z0-9])/g, "$1 ");
  out = out.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  out = out.replace(/([A-Za-z])\.(?=[A-Za-z])/g, "$1 \u0646\u0642\u0637\u0647 ");
  out = out.replace(/([A-Za-z])\/(?=[A-Za-z])/g, "$1 ");
  out = out.replace(/:\s*(?=\d)/g, " ");
  out = out.replace(/(?<![A-Za-z])([A-Za-z]{1,12})(?![A-Za-z])/g, (m, w) => {
    const hit = SPOKEN_TERMS[w.toLowerCase()];
    if (hit) return hit;
    if (/^[A-Z]{2,5}$/.test(w)) return w.toLowerCase().split("").map((c2) => LETTER_NAMES[c2] ?? c2).join(" ");
    return m;
  });
  return out.replace(/[ \t]{2,}/g, " ");
}
function normalizeSpeechChunks(chunks) {
  const letters = (s) => (s.match(/\p{L}/gu) ?? []).length;
  const out = [];
  let carry = "";
  for (const c2 of chunks) {
    if (letters(c2) === 0) continue;
    const merged = carry ? `${carry} ${c2}` : c2;
    if (letters(merged) < MIN_SPEECH_LETTERS) {
      carry = merged;
      continue;
    }
    out.push(merged);
    carry = "";
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
    else out.push(carry);
  }
  return out;
}
function packSpeechChunks(chunks, keepFirst = true, maxLen = PACK_MAX_CHARS) {
  const out = [];
  const floor = keepFirst ? 1 : 0;
  for (let i = 0; i < chunks.length; i++) {
    const c2 = chunks[i];
    if (out.length <= floor) {
      out.push(c2);
      continue;
    }
    const last = out[out.length - 1];
    if (/[.!?…؟]$/.test(last) && last.length + 1 + c2.length <= maxLen) {
      out[out.length - 1] = `${last} ${c2}`;
    } else {
      out.push(c2);
    }
  }
  return out;
}
function isRateLimitedError(err) {
  const m = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return m.includes("429") || m.includes("rate limit") || m.includes("too many requests");
}
function toTtsChain(opts) {
  return Array.isArray(opts) ? opts : [opts];
}
function sleepAbortAware(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function fetchSentenceRobust(sentence, chain, signal) {
  const providers = toTtsChain(chain);
  const attemptOnce = (providerOpts) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`TTS sentence timed out after ${SENTENCE_FETCH_TIMEOUT_MS / 1e3}s`));
    }, SENTENCE_FETCH_TIMEOUT_MS);
    speakTextStream(sentence, providerOpts, void 0, signal).then(
      (blob) => {
        clearTimeout(timer);
        if (!blob || blob.size === 0) {
          reject(new Error("speech synthesis returned no audio"));
          return;
        }
        resolve(blob);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
  const run = async () => {
    let lastErr = new Error("TTS failed: empty provider chain");
    let rounds = Math.max(1, TTS_RETRY_ATTEMPTS);
    let extraRateRounds = 0;
    for (let round = 0; round < rounds; round++) {
      for (const providerOpts of providers) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          return await attemptOnce(providerOpts);
        } catch (err) {
          if (signal.aborted) throw err;
          lastErr = err;
        }
      }
      if (round === rounds - 1 && extraRateRounds < 2 && isRateLimitedError(lastErr)) {
        extraRateRounds++;
        rounds++;
      }
      if (round < rounds - 1) {
        const delay = isRateLimitedError(lastErr) ? TTS_RETRY_DELAY_MS * 3 * (round + 1) : TTS_RETRY_DELAY_MS;
        await sleepAbortAware(delay, signal);
      }
    }
    throw lastErr;
  };
  return run();
}
async function playTts(text, opts, owner) {
  stopTtsGlobal();
  const controller = new AbortController();
  activeAbort = controller;
  const seq = ++seqCounter;
  activeSeq = seq;
  activeOwner = owner;
  activeStatus = "loading";
  notifyTts();
  const chain = toTtsChain(opts);
  const fetchOne = (sentence, signal) => fetchSentenceRobust(sentence, chain, signal);
  const sentences = packSpeechChunks(normalizeSpeechChunks(splitTtsSentences(spokenForm(text))));
  const queue = sentences.length > 1 ? sentences : sentences.length === 1 ? sentences : [text];
  const pending = /* @__PURE__ */ new Map();
  const ensureFetch = (idx) => {
    if (idx >= queue.length || pending.has(idx) || controller.signal.aborted) return;
    const job = fetchOne(queue[idx], controller.signal);
    job.catch(() => {
    });
    pending.set(idx, job);
  };
  ensureFetch(0);
  ensureFetch(1);
  let playedAny = false;
  let lastErr = null;
  try {
    for (let i = 0; i < queue.length; i++) {
      if (activeSeq !== seq || controller.signal.aborted) return;
      ensureFetch(i + 1);
      const job = pending.get(i);
      pending.delete(i);
      let blob;
      try {
        blob = job ? await job : await fetchOne(queue[i], controller.signal);
      } catch (err) {
        if (activeSeq !== seq || controller.signal.aborted) return;
        lastErr = err;
        continue;
      }
      if (activeSeq !== seq || controller.signal.aborted) return;
      if (blob.size === 0) continue;
      await playBlobChunk(blob, seq, controller, !playedAny);
      playedAny = true;
      if (i < queue.length - 1 && !controller.signal.aborted && activeSeq === seq) {
        try {
          await sleepAbortAware(INTER_SENTENCE_GAP_MS, controller.signal);
        } catch {
          return;
        }
      }
    }
  } catch (err) {
    if (activeAbort === controller) activeAbort = null;
    if (activeSeq !== seq || controller.signal.aborted) return;
    stopTtsGlobal();
    throw err;
  }
  if (activeAbort === controller) activeAbort = null;
  const stillMine = activeSeq === seq;
  if (stillMine) stopTtsGlobal();
  if (!playedAny && lastErr && stillMine) throw lastErr;
}
async function padWavLeadIn(blob, ms = LEAD_IN_MS) {
  try {
    if (!(blob.type || "").toLowerCase().includes("wav")) return blob;
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    if (buf.byteLength < 44) return blob;
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return blob;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let dataStart = -1;
    let dataSizeOffset = -1;
    let pos = 12;
    while (pos + 8 <= buf.byteLength) {
      const id = tag(pos);
      const size = view.getUint32(pos + 4, true);
      if (id === "fmt ") {
        channels = view.getUint16(pos + 10, true);
        sampleRate = view.getUint32(pos + 12, true);
        bits = view.getUint16(pos + 22, true);
      } else if (id === "data") {
        dataStart = pos + 8;
        dataSizeOffset = pos + 4;
        break;
      }
      pos += 8 + size + size % 2;
    }
    if (dataStart < 0 || !sampleRate || !channels || bits !== 16) return blob;
    const pad = Math.floor(sampleRate * ms / 1e3) * channels * 2;
    const declared = view.getUint32(dataSizeOffset, true);
    const dataLen = Math.min(declared, buf.byteLength - dataStart);
    const out = new Uint8Array(dataStart + pad + dataLen);
    out.set(new Uint8Array(buf, 0, dataStart), 0);
    out.set(new Uint8Array(buf, dataStart, dataLen), dataStart + pad);
    const ov = new DataView(out.buffer);
    ov.setUint32(dataSizeOffset, pad + dataLen, true);
    ov.setUint32(4, out.length - 8, true);
    return new Blob([out], { type: blob.type });
  } catch {
    return blob;
  }
}
async function playBlobChunk(blob, seq, controller, leadIn = false) {
  if (leadIn) blob = await padWavLeadIn(blob);
  return playBlobChunkNow(blob, seq, controller);
}
function playBlobChunkNow(blob, seq, controller) {
  return new Promise((resolve, reject) => {
    if (activeSeq !== seq || controller.signal.aborted) {
      resolve();
      return;
    }
    const url = URL.createObjectURL(blob);
    if (activeSeq !== seq || controller.signal.aborted) {
      URL.revokeObjectURL(url);
      resolve();
      return;
    }
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      activeAudio.pause();
      activeAudio = null;
    }
    if (activeUrl) {
      URL.revokeObjectURL(activeUrl);
      activeUrl = null;
    }
    activeUrl = url;
    const audio = new Audio(url);
    try {
      audio.playbackRate = 1;
    } catch {
    }
    activeAudio = audio;
    let settled = false;
    let watchdog = null;
    const clearWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const release = () => {
      clearWatchdog();
      audio.onended = null;
      audio.onerror = null;
      if (activeAudio === audio) activeAudio = null;
      if (activeUrl === url) activeUrl = null;
      URL.revokeObjectURL(url);
    };
    const armWatchdog = () => {
      clearWatchdog();
      const budget = Math.min(
        PLAYBACK_WATCHDOG_MAX_MS,
        Math.max(PLAYBACK_WATCHDOG_MIN_MS, blob.size * PLAYBACK_WATCHDOG_PER_BYTE_MS)
      );
      watchdog = setTimeout(() => {
        if (settled) return;
        try {
          if (audio.paused && activeSeq === seq && !controller.signal.aborted) {
            armWatchdog();
            return;
          }
        } catch {
        }
        settled = true;
        release();
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, budget);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      release();
      try {
        audio.pause();
      } catch {
      }
      resolve();
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    audio.onended = () => {
      if (settled) return;
      settled = true;
      release();
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    audio.onerror = () => {
      if (settled) return;
      settled = true;
      release();
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    activeStatus = "speaking";
    notifyTts();
    armWatchdog();
    audio.play().then(() => {
      if (activeSeq !== seq || controller.signal.aborted) {
        try {
          audio.pause();
        } catch {
        }
      }
    }).catch((err) => {
      settled = true;
      clearWatchdog();
      controller.signal.removeEventListener("abort", onAbort);
      if (activeSeq !== seq || controller.signal.aborted) {
        resolve();
        return;
      }
      reject(err);
    });
  });
}
function pauseActive() {
  if (activeStatus !== "speaking" || !activeAudio) return;
  try {
    activeAudio.pause();
  } catch {
  }
  activeStatus = "paused";
  notifyTts();
}
function pauseTts(owner) {
  if (owner !== void 0 && activeOwner !== owner) return;
  if (activeStatus === "loading") {
    stopTtsGlobal();
    return;
  }
  pauseActive();
}
async function resumeTts(owner) {
  if (owner !== void 0 && activeOwner !== owner) return;
  const audio = activeAudio;
  if (activeStatus !== "paused" || !audio) return;
  activeStatus = "speaking";
  notifyTts();
  try {
    await audio.play();
  } catch {
    if (activeAudio === audio) stopTtsGlobal();
  }
}
async function toggleTts(text, opts, owner) {
  if (activeOwner === owner) {
    if (activeStatus === "speaking") {
      pauseActive();
      return;
    }
    if (activeStatus === "paused") {
      await resumeTts(owner);
      return;
    }
    if (activeStatus === "loading") {
      stopTtsGlobal();
      return;
    }
  }
  await playTts(text, opts, owner);
}
function useTtsPlayback() {
  const idRef = useRef2(-1);
  if (idRef.current === -1) idRef.current = nextOwnerId++;
  const myId = idRef.current;
  const [status, setStatus] = useState2(
    () => activeOwner === myId || activeOwner === -1 ? activeStatus : "idle"
  );
  useEffect2(() => {
    const listener = (s, owner) => {
      setStatus(owner === myId ? s : "idle");
    };
    const unsubscribe = subscribeTts(listener);
    listener(activeStatus, activeOwner);
    return unsubscribe;
  }, [myId]);
  const stop = useCallback2(() => {
    stopTts(myId);
    setStatus((prev) => activeOwner === myId ? prev : "idle");
  }, [myId]);
  const play = useCallback2(
    async (text, opts) => {
      await playTts(text, opts, myId);
    },
    [myId]
  );
  const toggle = useCallback2(
    async (text, opts) => {
      await toggleTts(text, opts, myId);
    },
    [myId]
  );
  const pause = useCallback2(() => {
    pauseTts(myId);
  }, [myId]);
  const resume = useCallback2(async () => {
    await resumeTts(myId);
  }, [myId]);
  useEffect2(() => () => stopTts(idRef.current), []);
  return { status, play, stop, toggle, pause, resume };
}
function speakableMessageText(message) {
  const display = planDisplay(message);
  const segments = display.segments;
  if (segments && segments.length > 0) {
    const prose = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.kind !== "text") continue;
      if (!seg.text.trim()) continue;
      const next = segments[i + 1];
      if (next && next.kind === "tool") continue;
      prose.push(seg.text);
    }
    return stripMarkdownForTts(prose.join("\n\n"));
  }
  return stripMarkdownForTts(display.content ?? "");
}
function dropPipelessTables(text) {
  const lines = text.split("\n");
  const sep = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  const drop = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!sep.test(lines[i])) continue;
    drop[i] = true;
    if (i > 0 && lines[i - 1].includes("|")) drop[i - 1] = true;
    for (let j = i + 1; j < lines.length && lines[j].includes("|"); j++) drop[j] = true;
  }
  return lines.map((l, i) => drop[i] ? " " : l).join("\n");
}
function stripMarkdownForTts(text) {
  let out = text ?? "";
  out = out.replace(
    /<(tool_call|tool_use|tool_result|function_calls|function_call|invoke|antml:[a-z_]+)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,
    " "
  );
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/```[\s\S]*$/, " ");
  out = dropPipelessTables(out);
  out = out.replace(/^[^\S\n]*\|[^\n]*\|[^\S\n]*$/gm, " ");
  out = out.replace(/`([^`]*)`/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^[ \t]*[\d۰-۹٠-٩]+[.)][ \t]*$/gm, "");
  out = out.replace(/^\s{0,3}(?:[-*+]|[\d۰-۹٠-٩]+[.)])\s+/gm, "");
  out = out.replace(/^\s{0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  out = out.replace(/\|/g, " ");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/(\*\*|__)/g, "");
  out = out.replace(/~~/g, "");
  out = out.replace(/https?:\/\/\S+/g, "link");
  out = out.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/gu, " ");
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
function buildTtsChain(st) {
  const providers = st.settings.providers ?? [];
  const toSpeakOpts = (provider, model, voice) => ({
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    apiKeys: [...provider.apiKeys ?? (provider.apiKey ? [provider.apiKey] : [])],
    model,
    voice
  });
  const chain = [];
  const primary = providers.find((p) => p.id === st.ttsProviderId);
  if (primary) chain.push(toSpeakOpts(primary, st.ttsModel, st.ttsVoice));
  for (const fb of st.ttsFallbacks ?? []) {
    const p = providers.find((x) => x.id === fb.providerId);
    if (!p) continue;
    chain.push(toSpeakOpts(p, fb.model, fb.voice));
  }
  return chain;
}
function useSpeakText(getState) {
  const { status, toggle, stop } = useTtsPlayback();
  const getStateRef = useRef2(getState);
  getStateRef.current = getState;
  useEffect2(() => () => stop(), [stop]);
  const speak = useCallback2(
    async (rawText) => {
      const st = getStateRef.current();
      if (st.liveVoiceState === "live" || st.liveVoiceState === "speaking" || st.liveVoiceState === "connecting") {
        return null;
      }
      const chain = buildTtsChain(st);
      if (chain.length === 0) {
        return "\u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0635\u062F\u0627 \u0627\u0628\u062A\u062F\u0627 \u06CC\u06A9 \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 TTS \u062F\u0631 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u2190 \u0645\u062F\u0644\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F";
      }
      const text = stripBidiMarks(fixZwsp(rawText));
      if (!text.trim()) return "\u0645\u062A\u0646 \u0642\u0627\u0628\u0644 \u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0646\u06CC\u0633\u062A";
      try {
        await toggle(text, chain);
        return null;
      } catch (err) {
        const friendly = friendlyTtsError(err);
        console.warn("speak failed", err);
        return friendly || null;
      }
    },
    [toggle]
  );
  return { status, speak, stop };
}
var activeAudio, activeUrl, activeOwner, activeStatus, nextOwnerId, activeSeq, seqCounter, activeAbort, listeners, SENTENCE_FETCH_TIMEOUT_MS, TTS_RETRY_ATTEMPTS, TTS_RETRY_DELAY_MS, SPOKEN_TERMS, LETTER_NAMES, MIN_SPEECH_LETTERS, PACK_MAX_CHARS, PLAYBACK_WATCHDOG_MIN_MS, PLAYBACK_WATCHDOG_PER_BYTE_MS, PLAYBACK_WATCHDOG_MAX_MS, INTER_SENTENCE_GAP_MS, LEAD_IN_MS;
var init_tts = __esm({
  "src/lib/tts.ts"() {
    "use strict";
    init_api();
    init_planDoc();
    init_bidi();
    activeAudio = null;
    activeUrl = null;
    activeOwner = -1;
    activeStatus = "idle";
    nextOwnerId = 0;
    activeSeq = 0;
    seqCounter = 0;
    activeAbort = null;
    listeners = /* @__PURE__ */ new Set();
    SENTENCE_FETCH_TIMEOUT_MS = 9e4;
    TTS_RETRY_ATTEMPTS = 2;
    TTS_RETRY_DELAY_MS = 1e3;
    SPOKEN_TERMS = {
      api: "\u0627\u06CC \u067E\u06CC \u0622\u06CC",
      cli: "\u0633\u06CC \u0627\u0644 \u0622\u06CC",
      json: "\u062C\u06CC\u0633\u0648\u0646",
      plugin: "\u067E\u0644\u0627\u06AF\u06CC\u0646",
      plugins: "\u067E\u0644\u0627\u06AF\u06CC\u0646\u200C\u0647\u0627",
      bundle: "\u0628\u0627\u0646\u062F\u0644",
      code: "\u06A9\u062F",
      file: "\u0641\u0627\u06CC\u0644",
      files: "\u0641\u0627\u06CC\u0644\u200C\u0647\u0627",
      server: "\u0633\u0631\u0648\u0631",
      client: "\u06A9\u0644\u0627\u06CC\u0646\u062A",
      github: "\u06AF\u06CC\u062A\u200C\u0647\u0627\u0628",
      git: "\u06AF\u06CC\u062A",
      docker: "\u062F\u0627\u06A9\u0631",
      python: "\u067E\u0627\u06CC\u062A\u0648\u0646",
      javascript: "\u062C\u0627\u0648\u0627\u0627\u0633\u06A9\u0631\u06CC\u067E\u062A",
      typescript: "\u062A\u0627\u06CC\u067E\u200C\u0627\u0633\u06A9\u0631\u06CC\u067E\u062A",
      react: "\u0631\u06CC\u200C\u0627\u06A9\u062A",
      rust: "\u0631\u0627\u0633\u062A",
      tauri: "\u062A\u0648\u0631\u06CC",
      electron: "\u0627\u0644\u06A9\u062A\u0631\u0648\u0646",
      node: "\u0646\u0648\u062F",
      npm: "\u0627\u0646 \u067E\u06CC \u0627\u0645",
      http: "\u0627\u0686 \u062A\u06CC \u062A\u06CC \u067E\u06CC",
      https: "\u0627\u0686 \u062A\u06CC \u062A\u06CC \u067E\u06CC \u0627\u0633",
      url: "\u06CC\u0648 \u0622\u0631 \u0627\u0644",
      html: "\u0627\u0686 \u062A\u06CC \u0627\u0645 \u0627\u0644",
      css: "\u0633\u06CC \u0627\u0633 \u0627\u0633",
      sql: "\u0627\u0633 \u06A9\u06CC\u0648 \u0627\u0644",
      ui: "\u06CC\u0648 \u0622\u06CC",
      ux: "\u06CC\u0648 \u0627\u06A9\u0633",
      ai: "\u0627\u06CC \u0622\u06CC",
      tts: "\u062A\u06CC \u062A\u06CC \u0627\u0633",
      stt: "\u0627\u0633 \u062A\u06CC \u062A\u06CC",
      bug: "\u0628\u0627\u06AF",
      debug: "\u062F\u06CC\u0628\u0627\u06AF",
      commit: "\u06A9\u0627\u0645\u06CC\u062A",
      branch: "\u0628\u0631\u0646\u0686",
      merge: "\u0645\u0631\u062C",
      build: "\u0628\u06CC\u0644\u062F",
      deploy: "\u062F\u06CC\u067E\u0644\u0648\u06CC",
      app: "\u0627\u067E",
      chat: "\u0686\u062A",
      token: "\u062A\u0648\u06A9\u0646",
      prompt: "\u067E\u0631\u0627\u0645\u067E\u062A",
      model: "\u0645\u062F\u0644",
      provider: "\u067E\u0631\u0648\u0627\u06CC\u062F\u0631",
      endpoint: "\u0627\u0646\u062F\u067E\u0648\u06CC\u0646\u062A",
      command: "\u06A9\u0627\u0645\u0646\u062F",
      slash: "\u0627\u0633\u0644\u0634",
      terminal: "\u062A\u0631\u0645\u06CC\u0646\u0627\u0644",
      error: "\u0627\u0631\u0648\u0631",
      log: "\u0644\u0627\u06AF",
      config: "\u06A9\u0627\u0646\u0641\u06CC\u06AF",
      tool: "\u062A\u0648\u0644",
      agent: "\u0627\u06CC\u062C\u0646\u062A",
      create: "\u06A9\u0631\u06CC\u062A",
      root: "\u0631\u0648\u062A",
      body: "\u0628\u0627\u062F\u06CC",
      bluetooth: "\u0628\u0644\u0648\u062A\u0648\u062B",
      wifi: "\u0648\u0627\u06CC\u200C\u0641\u0627\u06CC",
      windows: "\u0648\u06CC\u0646\u062F\u0648\u0632",
      mac: "\u0645\u06A9",
      macos: "\u0645\u06A9\u200C\u0627\u0648\u0627\u0633",
      linux: "\u0644\u06CC\u0646\u0648\u06A9\u0633",
      ios: "\u0622\u06CC\u200C\u0627\u0648\u0627\u0633",
      android: "\u0627\u0646\u062F\u0631\u0648\u06CC\u062F",
      rs: "\u0622\u0631 \u0627\u0633",
      ts: "\u062A\u06CC \u0627\u0633",
      tsx: "\u062A\u06CC \u0627\u0633 \u0627\u06A9\u0633",
      js: "\u062C\u06CC \u0627\u0633",
      py: "\u067E\u0627\u06CC",
      md: "\u0627\u0645 \u062F\u06CC",
      css3: "\u0633\u06CC \u0627\u0633 \u0627\u0633"
    };
    LETTER_NAMES = {
      a: "\u0627\u06CC",
      b: "\u0628\u06CC",
      c: "\u0633\u06CC",
      d: "\u062F\u06CC",
      e: "\u0627\u06CC",
      f: "\u0627\u0641",
      g: "\u062C\u06CC",
      h: "\u0627\u06CC\u0686",
      i: "\u0622\u06CC",
      j: "\u062C\u06CC",
      k: "\u06A9\u06CC",
      l: "\u0627\u0644",
      m: "\u0627\u0645",
      n: "\u0627\u0646",
      o: "\u0627\u0648",
      p: "\u067E\u06CC",
      q: "\u06A9\u06CC\u0648",
      r: "\u0622\u0631",
      s: "\u0627\u0633",
      t: "\u062A\u06CC",
      u: "\u06CC\u0648",
      v: "\u0648\u06CC",
      w: "\u062F\u0627\u0628\u0644\u06CC\u0648",
      x: "\u0627\u06A9\u0633",
      y: "\u0648\u0627\u06CC",
      z: "\u0632\u062F"
    };
    MIN_SPEECH_LETTERS = 5;
    PACK_MAX_CHARS = 200;
    PLAYBACK_WATCHDOG_MIN_MS = 2e4;
    PLAYBACK_WATCHDOG_PER_BYTE_MS = 0.25;
    PLAYBACK_WATCHDOG_MAX_MS = 18e4;
    INTER_SENTENCE_GAP_MS = 350;
    LEAD_IN_MS = 280;
  }
});

// src/lib/sections.ts
function cleanTitle(raw) {
  return raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();
}
function matchBold(line) {
  const m = BOLD_RE.exec(line) ?? UNDER_RE.exec(line);
  if (!m) return null;
  const title = m[1].trim();
  if (title.includes("*") || title.includes("_")) return null;
  return title;
}
function collect(lines, mode) {
  const sections = [];
  let current = null;
  let buf = [];
  let fence = null;
  const flush = () => {
    if (!current) return;
    const content = buf.join("\n").trim();
    if (content || current.keep) {
      sections.push({
        id: current.id,
        title: current.title,
        level: current.level,
        content: content || current.title
      });
    }
    current = null;
    buf = [];
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] === "`" ? "`" : "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      buf.push(line);
      continue;
    }
    if (fence) {
      buf.push(line);
      continue;
    }
    let title = null;
    let level = 1;
    let keep = false;
    if (mode === "heading") {
      const m = HEADING_RE.exec(line);
      if (m) {
        title = m[2].trim();
        level = m[1].length;
      }
    } else {
      const bold = matchBold(line);
      if (bold !== null) {
        title = bold;
      } else {
        const n = NUM_RE.exec(line);
        if (n) {
          title = cleanTitle(n[1]);
          keep = true;
        }
      }
    }
    if (title !== null) {
      flush();
      current = { id: `s${sections.length}`, title, level, keep };
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
function splitSections(markdown2) {
  if (!markdown2) return [];
  const lines = markdown2.split("\n");
  const headingSections = collect(lines, "heading");
  if (headingSections.length > 0) return headingSections;
  return collect(lines, "fallback");
}
var HEADING_RE, BOLD_RE, UNDER_RE, NUM_RE;
var init_sections = __esm({
  "src/lib/sections.ts"() {
    "use strict";
    HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
    BOLD_RE = /^\s*\*{2,3}(.+?)\*{2,3}\s*$/;
    UNDER_RE = /^\s*_{2,3}(.+?)\_{2,3}\s*$/;
    NUM_RE = /^\s*(?:\([\d۰-۹]{1,3}\)|[\d۰-۹]{1,3}[.)])\s+(.+)$/;
  }
});

// src/lib/scrollKeys.ts
function scrollDelta(dir, fast = false) {
  const k = (dir ?? "").toLowerCase();
  if (k !== "h" && k !== "j" && k !== "k" && k !== "l") return null;
  const step = fast ? SCROLL_STEP_PX * SCROLL_FAST_MULTIPLIER : SCROLL_STEP_PX;
  if (k === "h") return { dx: -step, dy: 0 };
  if (k === "l") return { dx: step, dy: 0 };
  if (k === "k") return { dx: 0, dy: -step };
  return { dx: 0, dy: step };
}
function halfPageDelta(dir, viewportHeight) {
  const step = Math.max(1, Math.round(Math.abs(viewportHeight) / 2));
  return { dx: 0, dy: dir === "down" ? step : -step };
}
function edgeDelta(edge, view) {
  if (edge === "top") return { dx: 0, dy: -Math.max(0, view.scrollTop) };
  return {
    dx: 0,
    dy: Math.max(0, view.scrollHeight - view.clientHeight - Math.max(0, view.scrollTop))
  };
}
function clampGlide(el, left, top) {
  const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
  const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
  return {
    left: Number.isFinite(maxX) ? Math.min(Math.max(0, left), maxX) : left,
    top: Number.isFinite(maxY) ? Math.min(Math.max(0, top), maxY) : top
  };
}
function glideTo(el, g) {
  if (g.raf) cancelAnimationFrame(g.raf);
  const step = () => {
    if (!el.isConnected) {
      glides.delete(el);
      return;
    }
    const dl = g.left - el.scrollLeft;
    const dt = g.top - el.scrollTop;
    if (Math.abs(dl) < SMOOTH_SNAP_PX && Math.abs(dt) < SMOOTH_SNAP_PX) {
      el.scrollLeft = g.left;
      el.scrollTop = g.top;
      glides.delete(el);
      return;
    }
    el.scrollLeft += dl * SMOOTH_EASE;
    el.scrollTop += dt * SMOOTH_EASE;
    g.raf = requestAnimationFrame(step);
  };
  g.raf = requestAnimationFrame(step);
}
function applyScroll(el, delta, smooth = true) {
  if (!el) return false;
  if (!smooth || typeof requestAnimationFrame !== "function") {
    const g2 = typeof requestAnimationFrame === "function" ? glides.get(el) : void 0;
    if (g2?.raf) cancelAnimationFrame(g2.raf);
    glides.delete(el);
    const beforeLeft = el.scrollLeft;
    const beforeTop = el.scrollTop;
    el.scrollLeft = beforeLeft + delta.dx;
    el.scrollTop = beforeTop + delta.dy;
    return el.scrollLeft !== beforeLeft || el.scrollTop !== beforeTop;
  }
  let g = glides.get(el);
  if (!g) {
    g = { left: el.scrollLeft, top: el.scrollTop, raf: 0 };
    glides.set(el, g);
  }
  g.left += delta.dx;
  g.top += delta.dy;
  const c2 = clampGlide(el, g.left, g.top);
  g.left = c2.left;
  g.top = c2.top;
  glideTo(el, g);
  return delta.dx !== 0 || delta.dy !== 0;
}
var SCROLL_STEP_PX, SCROLL_FAST_MULTIPLIER, SMOOTH_EASE, SMOOTH_SNAP_PX, glides;
var init_scrollKeys = __esm({
  "src/lib/scrollKeys.ts"() {
    "use strict";
    SCROLL_STEP_PX = 48;
    SCROLL_FAST_MULTIPLIER = 4;
    SMOOTH_EASE = 0.35;
    SMOOTH_SNAP_PX = 1;
    glides = /* @__PURE__ */ new WeakMap();
  }
});

// src/lib/shortcuts.ts
function physicalKey(e) {
  const c2 = e.code || "";
  if (c2.startsWith("Key")) return c2.slice(3).toLowerCase();
  if (c2 === "Comma") return ",";
  if (c2 === "Slash") return "/";
  if (c2 === "BracketLeft") return "[";
  if (c2 === "BracketRight") return "]";
  return (e.key || "").toLowerCase();
}
var init_shortcuts = __esm({
  "src/lib/shortcuts.ts"() {
    "use strict";
  }
});

// src/lib/prefixState.ts
function isPrefixArmed() {
  return armed;
}
function watchPrefixFlag() {
  return () => {
  };
}
var armed;
var init_prefixState = __esm({
  "src/lib/prefixState.ts"() {
    "use strict";
    armed = false;
    if (typeof window !== "undefined") {
      window.addEventListener("coder:prefix", (e) => {
        armed = !!e.detail;
      });
    }
  }
});

// src/lib/panePointer.ts
function contains(root, el) {
  if (!el) return false;
  try {
    return root.contains(el);
  } catch {
    return false;
  }
}
function isEditable(el) {
  if (!el || typeof el.matches !== "function") return false;
  try {
    return el.matches(EDITABLE);
  } catch {
    return false;
  }
}
function isEditableTarget(t) {
  return isEditable(t);
}
function snapshotIntent() {
  if (typeof document === "undefined") {
    return { region: activeRegion, regionAt, typingAt, caretInRegion: null, caret: null, caretEditable: null };
  }
  const el = document.activeElement;
  const body = !el || el === document.body || el === document.documentElement;
  let caretInRegion = null;
  if (!body && el) {
    for (const r of regions) {
      if (contains(r, el)) {
        caretInRegion = r;
        break;
      }
    }
  }
  return {
    region: activeRegion,
    regionAt,
    typingAt,
    caretInRegion,
    caret: body ? null : el,
    caretEditable: !body && el && isEditable(el) ? el : null
  };
}
function decideVimOwner(st, root, target) {
  if (st.caretEditable) return "typing";
  if (isEditable(target)) return "typing";
  const paneNewest = st.region === root && st.regionAt >= st.typingAt;
  if (paneNewest) return "scroll";
  if (st.caretInRegion && (st.caretInRegion === root || contains(root, st.caretInRegion)) && st.typingAt >= st.regionAt) {
    return isEditable(st.caret) ? "typing" : "scroll";
  }
  if (st.caretEditable || isEditable(target)) {
    if (st.typingAt > st.regionAt) return "typing";
    return st.region === root ? "scroll" : null;
  }
  return st.region === root ? "scroll" : null;
}
function isNodeLike(t) {
  return !!t && typeof t.contains === "function";
}
function handleInteractionTarget(t) {
  if (isNodeLike(t)) {
    if (isEditable(t)) {
      typingAt = nextIntent();
      return;
    }
    for (const root of regions) {
      if (contains(root, t)) {
        activeRegion = root;
        regionAt = nextIntent();
        return;
      }
    }
  }
  activeRegion = null;
}
function onPointerDown(e) {
  if (isPrefixArmed()) return;
  handleInteractionTarget(e.target);
}
function onFocusIn(e) {
  if (isPrefixArmed()) return;
  handleInteractionTarget(e.target);
}
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("mousedown", onPointerDown, true);
  window.addEventListener("focusin", onFocusIn, true);
}
function registerVimRegion(root) {
  install();
  regions.add(root);
}
function unregisterVimRegion(root) {
  regions.delete(root);
  if (activeRegion === root) activeRegion = null;
}
function markVimRegion(root) {
  activeRegion = root;
  if (root) regionAt = Date.now();
}
var regions, activeRegion, regionAt, typingAt, intentStamp, nextIntent, installed, EDITABLE;
var init_panePointer = __esm({
  "src/lib/panePointer.ts"() {
    "use strict";
    init_prefixState();
    regions = /* @__PURE__ */ new Set();
    activeRegion = null;
    regionAt = 0;
    typingAt = 0;
    intentStamp = 0;
    nextIntent = () => ++intentStamp;
    installed = false;
    EDITABLE = 'input, textarea, select, [contenteditable="true" i], [contenteditable="" i], [contenteditable="plaintext-only" i]';
  }
});

// src/lib/useVimScroll.ts
import { useEffect as useEffect3 } from "react";
function isScroller(el) {
  const cs = getComputedStyle(el);
  const scrollsY = (cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
  const scrollsX = (cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth;
  return scrollsY || scrollsX;
}
function scrollableHost(from, root) {
  let node = from;
  while (node && node !== root) {
    if (isScroller(node)) return node;
    node = node.parentElement;
  }
  if (isScroller(root)) return root;
  const walk = (el) => {
    for (const child of Array.from(el.children)) {
      const c2 = child;
      if (isScroller(c2)) return c2;
      const found = walk(c2);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}
function useVimScroll(rootRef, intentRef) {
  useEffect3(() => watchPrefixFlag(), []);
  useEffect3(() => {
    const root = rootRef.current;
    if (!root) return;
    const intent = intentRef?.current ?? root;
    registerVimRegion(intent);
    let gAt = 0;
    const GG_TIMEOUT_MS = 800;
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      if (isPrefixArmed()) return;
      if (e.altKey || e.shiftKey && (e.ctrlKey || e.metaKey)) return;
      const key = physicalKey(e);
      const mod = (e.ctrlKey || e.metaKey) && !e.shiftKey;
      const halfDown = mod && key === "d";
      const halfUp = mod && key === "u";
      if ((e.ctrlKey || e.metaKey) && !halfDown && !halfUp) return;
      if (isEditableTarget(e.target)) return;
      if (decideVimOwner(snapshotIntent(), intent, e.target) !== "scroll") return;
      const target = e.target instanceof Element && root.contains(e.target) ? e.target : root;
      const el = document.activeElement;
      const focusInside = !!el && el !== document.body && el !== document.documentElement && root.contains(el);
      const host = scrollableHost(focusInside && el ? el : target, root);
      if (!host) return;
      const run = (delta2, smooth) => {
        e.preventDefault();
        e.stopPropagation();
        if (!delta2.dx && !delta2.dy) return;
        if (applyScroll(host, delta2, smooth)) {
          window.dispatchEvent(new CustomEvent("coder:vim-scroll", { detail: host }));
        }
      };
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plain && !e.shiftKey && key === "g") {
        const now = Date.now();
        if (now - gAt <= GG_TIMEOUT_MS) {
          gAt = 0;
          run(edgeDelta("top", host), false);
          return;
        }
        gAt = now;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      gAt = 0;
      if (plain && e.shiftKey && key === "g") {
        run(edgeDelta("bottom", host), false);
        return;
      }
      if (halfDown || halfUp) {
        run(halfPageDelta(halfDown ? "down" : "up", host.clientHeight), !e.repeat);
        return;
      }
      const delta = scrollDelta(key, e.shiftKey);
      if (!delta) return;
      run(delta, !e.repeat);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      unregisterVimRegion(intent);
    };
  }, []);
}
var init_useVimScroll = __esm({
  "src/lib/useVimScroll.ts"() {
    "use strict";
    init_scrollKeys();
    init_shortcuts();
    init_prefixState();
    init_panePointer();
  }
});

// src/lib/artifacts.ts
var init_artifacts = __esm({
  "src/lib/artifacts.ts"() {
    "use strict";
    init_api();
  }
});

// src/components/ArtifactsPanel.tsx
import { useCallback as useCallback3, useEffect as useEffect4, useMemo, useRef as useRef3, useState as useState3 } from "react";
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function ArtifactGlyph({ size = 14 }) {
  return /* @__PURE__ */ jsxs2("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx2("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }),
    /* @__PURE__ */ jsx2("path", { d: "M14 3v5h5" }),
    /* @__PURE__ */ jsx2("path", { d: "M9 13h6" }),
    /* @__PURE__ */ jsx2("path", { d: "M9 17h4" })
  ] });
}
var init_ArtifactsPanel = __esm({
  "src/components/ArtifactsPanel.tsx"() {
    "use strict";
    init_store();
    init_viewerTabs();
    init_useVimScroll();
    init_artifacts();
  }
});

// src/components/ArtifactCard.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function ArtifactCard({
  segment,
  messageId
}) {
  const open = () => {
    const st = useStore.getState();
    const owner = messageId ? st.chats.find((c2) => c2.messages.some((m) => m.id === messageId)) : void 0;
    if (owner && st.activeChatId !== owner.id) st.focusWindow(owner.id);
    useViewerTabs.getState().openArtifact(owner?.id ?? st.activeChatId ?? "", {
      id: segment.id,
      title: segment.title,
      kind: segment.artifactKind,
      body: segment.content
    });
  };
  return /* @__PURE__ */ jsx3("div", { className: "artifact-card", children: /* @__PURE__ */ jsxs3("div", { className: "artifact-card-head", children: [
    /* @__PURE__ */ jsx3("span", { className: "artifact-card-icon", "aria-hidden": "true", children: /* @__PURE__ */ jsx3(ArtifactGlyph, { size: 15 }) }),
    /* @__PURE__ */ jsx3("span", { className: "artifact-card-title", title: segment.title || segment.id, children: segment.title || segment.id }),
    /* @__PURE__ */ jsxs3("span", { className: "artifact-card-meta", children: [
      segment.artifactKind,
      " \xB7 v",
      segment.version
    ] }),
    /* @__PURE__ */ jsx3("button", { className: "btn secondary artifact-card-open", onClick: open, children: "Open" })
  ] }) });
}
var init_ArtifactCard = __esm({
  "src/components/ArtifactCard.tsx"() {
    "use strict";
    init_ArtifactsPanel();
    init_store();
    init_viewerTabs();
  }
});

// src/lib/downloadProgress.ts
function looksLikeSize(token) {
  return HUMAN_SIZE_RE.test(token) || /^\d+$/.test(token);
}
function parseDownloadProgress(tail) {
  if (!tail) return null;
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const parsed = parseCurlMeter(line) ?? parseCurlBar(line) ?? parseWgetBar(line);
    if (parsed) return parsed;
  }
  return null;
}
function parseCurlMeter(line) {
  const f = line.trim().split(/\s+/);
  if (f.length < 12) return null;
  if (!TIME_RE.test(f[8]) || !TIME_RE.test(f[9]) || !TIME_RE.test(f[10])) return null;
  const percent = Number(f[0]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (!looksLikeSize(f[1]) || !looksLikeSize(f[3])) return null;
  return {
    percent,
    total: f[1],
    received: f[3],
    speed: f[11] || f[6] || void 0,
    eta: f[10]
  };
}
function parseCurlBar(line) {
  const m = line.match(/^(#{2,})\s+(\d{1,3}(?:\.\d+)?)%\s*$/);
  if (!m) return null;
  const percent = Number(m[2]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return { percent };
}
function parseWgetBar(line) {
  const m = line.match(/^\s*(\d{1,3})%\s*(?:\[[= >]*\])?\s*([\d,.]+)?\s*([^\s]*\/s)?\s*(?:eta\s+(\S+))?/i);
  if (!m) return null;
  const percent = Number(m[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (!m[2] && !m[3] && !m[4]) return null;
  return {
    percent,
    received: m[2] || void 0,
    speed: m[3] || void 0,
    eta: m[4] || void 0
  };
}
var TIME_RE, HUMAN_SIZE_RE;
var init_downloadProgress = __esm({
  "src/lib/downloadProgress.ts"() {
    "use strict";
    TIME_RE = /^\d+:\d{2}:\d{2}$/;
    HUMAN_SIZE_RE = /^\d[\d,.]*[kKMGTP]?i?B?$/i;
  }
});

// src/lib/reviewTurn.ts
function reviewPathOf(a) {
  return editTargetOf(a.args);
}
var init_reviewTurn = __esm({
  "src/lib/reviewTurn.ts"() {
    "use strict";
    init_toolActivity();
  }
});

// src/lib/clipboard.ts
async function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    return ok;
  } finally {
    document.body.removeChild(ta);
    if (sel && prevRange) {
      sel.removeAllRanges();
      sel.addRange(prevRange);
    } else if (sel) {
      sel.removeAllRanges();
    }
  }
}
async function copyToClipboard(text) {
  const value = String(text ?? "");
  try {
    const w = window;
    if (typeof w.coder?.copyText === "function") {
      const ok = await w.coder.copyText(value);
      if (ok) return true;
    }
  } catch {
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  return legacyCopy(value);
}
var init_clipboard = __esm({
  "src/lib/clipboard.ts"() {
    "use strict";
  }
});

// src/lib/diffComments.ts
function commentSyntax(path) {
  if (!path) return NO_COMMENT_SYNTAX;
  const clean = path.split("?")[0].toLowerCase();
  const base2 = clean.split(/[\\/]/).pop() ?? "";
  const ext = base2.split(".").pop() ?? "";
  if (!base2.includes(".") && HASH_EXT.has(base2)) return { line: ["#"] };
  if (SLASH_EXT.has(ext)) return { line: ["//"], block: SLASH_BLOCK };
  if (HASH_EXT.has(ext)) return { line: ["#"] };
  if (DASH_EXT.has(ext)) return { line: ["--"] };
  if (SLASH_BLOCK_EXT.has(ext)) return { line: [], block: SLASH_BLOCK };
  if (HTML_BLOCK_EXT.has(ext)) return { line: [], block: HTML_BLOCK };
  return NO_COMMENT_SYNTAX;
}
function scanCommentLine(text, syntax, startInBlock = false) {
  const spans = [];
  const block = syntax.block;
  let i = 0;
  if (startInBlock) {
    if (!block) return { spans, open: false };
    const close = text.indexOf(block.close);
    if (close < 0) return { spans: [{ start: 0, end: text.length }], open: true };
    const end = close + block.close.length;
    spans.push({ start: 0, end });
    i = end;
  }
  let quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (block && text.startsWith(block.open, i)) {
      const close = text.indexOf(block.close, i + block.open.length);
      if (close < 0) {
        spans.push({ start: i, end: text.length });
        return { spans, open: true };
      }
      const end = close + block.close.length;
      spans.push({ start: i, end });
      i = end - 1;
      continue;
    }
    let lineHit = false;
    for (const m of syntax.line) {
      if (text.startsWith(m, i)) {
        spans.push({ start: i, end: text.length });
        lineHit = true;
        break;
      }
    }
    if (lineHit) return { spans, open: false };
  }
  return { spans, open: false };
}
function buildCommentSpans(lines, syntax) {
  const map = /* @__PURE__ */ new Map();
  if (syntax.line.length === 0 && !syntax.block) return map;
  let open = false;
  for (const line of lines) {
    const result = scanCommentLine(line.text, syntax, open);
    open = result.open;
    if (result.spans.length > 0 && line.lineNo >= 0) {
      map.set(line.lineNo, result.spans);
    }
  }
  return map;
}
function splitCommentSegments(text, spans) {
  if (!spans || spans.length === 0) return [{ text, comment: false }];
  const out = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(at, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > at) out.push({ text: text.slice(at, start), comment: false });
    if (end > start) out.push({ text: text.slice(start, end), comment: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), comment: false });
  return out;
}
var SLASH_BLOCK, HTML_BLOCK, NO_COMMENT_SYNTAX, SLASH_EXT, HASH_EXT, DASH_EXT, SLASH_BLOCK_EXT, HTML_BLOCK_EXT;
var init_diffComments = __esm({
  "src/lib/diffComments.ts"() {
    "use strict";
    SLASH_BLOCK = { open: "/*", close: "*/" };
    HTML_BLOCK = { open: "<!--", close: "-->" };
    NO_COMMENT_SYNTAX = { line: [] };
    SLASH_EXT = /* @__PURE__ */ new Set([
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "rs",
      "go",
      "java",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "kt",
      "swift",
      "scss",
      "less",
      "mm",
      "dart",
      "zig",
      "jsonc",
      "proto",
      "groovy",
      "php"
    ]);
    HASH_EXT = /* @__PURE__ */ new Set([
      // `toml` is deliberately absent: TomlLine renders those diffs with its own
      // key/value highlighting, and two dimming paths must not fight over a line.
      "py",
      "rb",
      "sh",
      "bash",
      "zsh",
      "fish",
      "yml",
      "yaml",
      "ini",
      "cfg",
      "conf",
      "pl",
      "jl",
      "nim",
      "tf",
      "hcl",
      "dockerfile",
      "makefile",
      "mk"
    ]);
    DASH_EXT = /* @__PURE__ */ new Set(["sql", "lua", "hs", "elm"]);
    SLASH_BLOCK_EXT = /* @__PURE__ */ new Set(["css"]);
    HTML_BLOCK_EXT = /* @__PURE__ */ new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);
  }
});

// src/lib/diffSearch.ts
function countOccurrences(haystack, query) {
  const q = query.trim().toLowerCase();
  if (!q || !haystack) return 0;
  const lower = haystack.toLowerCase();
  let n = 0;
  let i = 0;
  for (; ; ) {
    const j = lower.indexOf(q, i);
    if (j < 0) return n;
    n++;
    i = j + q.length;
  }
}
var init_diffSearch = __esm({
  "src/lib/diffSearch.ts"() {
    "use strict";
  }
});

// src/lib/chatSends.ts
function unregisterChatSend(chatId) {
  registry.delete(chatId);
}
function sendQueuedNext(chatId) {
  const store = useStore.getState();
  const chat = store.chats.find((c2) => c2.id === chatId);
  const queued = chat?.queued?.filter((q) => !q.sent);
  if (!chat || !queued || queued.length === 0) return false;
  const fn = registry.get(chatId);
  if (!fn) return false;
  const next = queued[0];
  store.markQueuedSent(chatId, next.id);
  fn(next.text, next.attachments ?? [], next.images ?? [], void 0, void 0, void 0, void 0, {
    mcpServers: next.mcpServers,
    skills: next.skills,
    plugins: next.plugins
  });
  return true;
}
var registry;
var init_chatSends = __esm({
  "src/lib/chatSends.ts"() {
    "use strict";
    init_store();
    registry = /* @__PURE__ */ new Map();
    registerChatDeleteHook(unregisterChatSend);
  }
});

// src/lib/fileComments.ts
function makeId() {
  const uuid = typeof crypto !== "undefined" ? crypto.randomUUID?.() : void 0;
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function formatFileComment(path, quote) {
  const { file, loc } = splitLocator(path);
  const body = stripQuoteLocator(quote, file);
  const short = body.length > MAX_QUOTE_CHARS ? `${body.slice(0, MAX_QUOTE_CHARS)}\u2026` : body;
  const quoted = `> ${short.split("\n").join("\n> ")}`;
  const a1Match = loc.match(/^(?:(.+)!)?([A-Z]+\d+(?::[A-Z]+\d+)?)$/);
  const rowsMatch = loc.match(/^rows?\s+(\d+(?:-\d+)?)$/i);
  const linesMatch = loc.match(/^(\d+(?:-\d+)?)$/);
  if (a1Match) {
    const rawSheet = (a1Match[1] ?? "").trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
    const range = a1Match[2];
    const where = rawSheet ? `sheet ${rawSheet}, range ${range}` : `range ${range}`;
    return `Comment on \`${file}\` (${where}):
${quoted}`;
  }
  if (rowsMatch) {
    const rows = rowsMatch[1];
    const where = rows.includes("-") ? `rows ${rows}` : `row ${rows}`;
    return `Comment on \`${file}\` (${where}):
${quoted}`;
  }
  if (linesMatch) {
    const lines = linesMatch[1];
    const where = lines.includes("-") ? `lines ${lines}` : `line ${lines}`;
    return `Comment on \`${file}\` (${where}):
${quoted}`;
  }
  return `Comment on \`${path}\`:
${quoted}`;
}
function splitLocator(path) {
  const patterns = [
    /^(.*?):(\d+(?:-\d+)?)$/,
    // code/text lines: 42, 42-45
    /^(.*?):(rows?\s+\d+(?:-\d+)?)$/i,
    // spreadsheet rows: rows 3-5
    /^(.*?):((?:[^:!]+!)?[A-Z]+\d+(?::[A-Z]+\d+)?)$/
    // A1 cell/range, optional sheet
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m) return { file: m[1], loc: m[2] };
  }
  return { file: path, loc: "" };
}
function stripInvisible(s) {
  return s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}
function stripQuoteLocator(quote, file) {
  const cleanFile = stripInvisible(file);
  const base2 = cleanFile.split("/").pop() ?? cleanFile;
  let body = quote;
  for (; ; ) {
    const lead = body.match(/^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]*/);
    const rest = lead ? body.slice(lead[0].length) : body;
    const m = rest.match(/^\[([^\]]*)\]\s*/);
    if (!m) return body;
    const inner = stripInvisible(m[1]).trim();
    const loc = inner.match(/^(.*?)\s+lines?\s+\d+(?:-\d+)?$/);
    const innerPath = (loc ? loc[1] : inner).trim();
    const sameFile = innerPath === cleanFile || innerPath === base2 || innerPath.endsWith(`/${base2}`);
    if (!sameFile) return body;
    body = rest.slice(m[0].length);
  }
}
function addFileComment(chatId, path, quote) {
  const trimmed = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}\u2026` : quote;
  const comment = {
    id: makeId(),
    chatId,
    path,
    quote: trimmed,
    createdAt: Date.now()
  };
  const list = [...commentsByChat.get(chatId) ?? [], comment].slice(
    -MAX_COMMENTS_PER_CHAT
  );
  commentsByChat.set(chatId, list);
  return comment;
}
function commentFileSelection(chatId, path, quote, opts) {
  const comment = addFileComment(chatId, path, quote);
  const text = formatFileComment(path, comment.quote);
  const store = useStore.getState();
  const chat = store.chats.find((c2) => c2.id === chatId);
  if (chat && chat.hydrated === false) {
    store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    void ensureChatHydrated(chatId).then(() => {
      const fresh = useStore.getState().chats.find((c2) => c2.id === chatId);
      if (!fresh || fresh.hydrated === false) return;
      const busy = fresh.messages.some(
        (m) => m.streaming || m.retry?.reconnecting === true
      );
      if (busy) return;
      try {
        sendQueuedNext(chatId);
      } catch {
      }
    });
    return comment;
  }
  const compacting = chat?.compacting ?? false;
  const streaming = chat?.messages.some((m) => m.streaming) ?? false;
  const reconnecting = chat?.messages.some((m) => m.retry?.reconnecting) ?? false;
  const waiting = chat?.pendingAsk != null || chat?.pendingPermission != null;
  if (opts?.queue || compacting || waiting) {
    store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    return comment;
  }
  if (streaming || reconnecting) {
    try {
      const userMsg = store.addMessage(chatId, {
        role: "user",
        content: text,
        steerPending: true
      });
      void steerChat(chatId, userMsg.id, text);
    } catch {
      store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
    }
    return comment;
  }
  store.queueMessage(chatId, { id: comment.id, text, kind: "queue" });
  try {
    sendQueuedNext(chatId);
  } catch {
  }
  return comment;
}
var commentsByChat, MAX_COMMENTS_PER_CHAT, MAX_QUOTE_CHARS;
var init_fileComments = __esm({
  "src/lib/fileComments.ts"() {
    "use strict";
    init_chatSends();
    init_api();
    init_store();
    commentsByChat = /* @__PURE__ */ new Map();
    registerChatDeleteHook((chatId) => {
      commentsByChat.delete(chatId);
    });
    MAX_COMMENTS_PER_CHAT = 100;
    MAX_QUOTE_CHARS = 500;
  }
});

// src/lib/sanitizeHtml.ts
function isSafeUrl(value) {
  const v = (value || "").trim();
  if (!v) return true;
  if (/^(?:javascript|data|vbscript|file):/i.test(v)) return false;
  return SAFE_URL_RE.test(v);
}
function sanitizeNode(node, doc) {
  const tag = node.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    const frag = doc.createDocumentFragment();
    while (node.firstChild) frag.appendChild(node.firstChild);
    return frag;
  }
  const allowed = /* @__PURE__ */ new Set([
    ...ALLOWED_ATTRS["*"] || [],
    ...ALLOWED_ATTRS[tag] || []
  ]);
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      node.removeAttribute(attr.name);
      continue;
    }
    if (!allowed.has(name)) {
      node.removeAttribute(attr.name);
      continue;
    }
    if ((name === "href" || name === "src" || name === "xlink:href") && !isSafeUrl(attr.value)) {
      node.removeAttribute(attr.name);
    }
  }
  for (const child of Array.from(node.children)) {
    const cleaned = sanitizeNode(child, doc);
    if (cleaned && cleaned !== child) {
      node.replaceChild(cleaned, child);
    }
  }
  return node;
}
function parser() {
  if (!_parser) _parser = new DOMParser();
  return _parser;
}
function sanitizeHtml(html) {
  if (!html || !html.trim()) return "";
  if (typeof DOMParser === "undefined") return html;
  const doc = parser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html"
  );
  const out = [];
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const cleaned = sanitizeNode(child, doc);
      if (cleaned) out.push(cleaned);
    } else if (child.nodeType === Node.TEXT_NODE) {
      out.push(child);
    }
  }
  const container = doc.createElement("div");
  for (const n of out) container.appendChild(n);
  return container.innerHTML;
}
var ALLOWED_TAGS, ALLOWED_ATTRS, SAFE_URL_RE, _parser;
var init_sanitizeHtml = __esm({
  "src/lib/sanitizeHtml.ts"() {
    "use strict";
    ALLOWED_TAGS = /* @__PURE__ */ new Set([
      // highlight.js + general markdown pass-through
      "span",
      "a",
      "code",
      "pre",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "mark",
      "small",
      "sub",
      "sup",
      "br",
      // Mermaid SVG nodes
      "svg",
      "g",
      "path",
      "rect",
      "text",
      "tspan",
      "line",
      "polygon",
      "polyline",
      "circle",
      "ellipse",
      "defs",
      "marker",
      "foreignObject",
      "title",
      "desc",
      "style"
    ]);
    ALLOWED_ATTRS = {
      "*": /* @__PURE__ */ new Set(["class", "id", "title", "lang", "dir"]),
      a: /* @__PURE__ */ new Set(["href", "target", "rel"]),
      svg: /* @__PURE__ */ new Set(["xmlns", "viewBox", "width", "height", "preserveAspectRatio", "role", "aria-label"]),
      g: /* @__PURE__ */ new Set(["transform", "fill", "stroke", "stroke-width", "opacity"]),
      path: /* @__PURE__ */ new Set(["d", "fill", "stroke", "stroke-width", "opacity", "transform", "marker-end", "marker-start"]),
      rect: /* @__PURE__ */ new Set(["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width", "opacity", "transform"]),
      text: /* @__PURE__ */ new Set(["x", "y", "dx", "dy", "text-anchor", "font-family", "font-size", "font-weight", "fill", "stroke", "transform"]),
      tspan: /* @__PURE__ */ new Set(["x", "y", "dx", "dy", "text-anchor", "font-family", "font-size", "font-weight", "fill"]),
      line: /* @__PURE__ */ new Set(["x1", "y1", "x2", "y2", "stroke", "stroke-width", "opacity"]),
      polygon: /* @__PURE__ */ new Set(["points", "fill", "stroke", "stroke-width", "opacity"]),
      polyline: /* @__PURE__ */ new Set(["points", "fill", "stroke", "stroke-width", "opacity"]),
      circle: /* @__PURE__ */ new Set(["cx", "cy", "r", "fill", "stroke", "stroke-width", "opacity"]),
      ellipse: /* @__PURE__ */ new Set(["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width", "opacity"]),
      marker: /* @__PURE__ */ new Set(["id", "viewBox", "refX", "refY", "markerWidth", "markerHeight", "orient"]),
      defs: /* @__PURE__ */ new Set([]),
      foreignObject: /* @__PURE__ */ new Set(["x", "y", "width", "height"]),
      style: /* @__PURE__ */ new Set([]),
      title: /* @__PURE__ */ new Set([]),
      desc: /* @__PURE__ */ new Set([])
    };
    SAFE_URL_RE = /^(?:(?:https?|mailto):|#|\/|\.\/|\.\.\/|[a-zA-Z0-9._~%+\-@/!$&'()*+,;=:])/i;
    _parser = null;
  }
});

// src/lib/highlight.ts
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
function ensureHljsLanguages() {
  if (hljsReady) return;
  for (const [name, grammar] of HLJS_LANGUAGES) {
    hljs.registerLanguage(name, grammar);
  }
  for (const [alias, target] of Object.entries(HLJS_ALIASES)) {
    const grammar = HLJS_BY_NAME[target];
    if (grammar) hljs.registerLanguage(alias, grammar);
  }
  hljsReady = true;
}
function hasHighlightLanguage(lang) {
  if (!lang) return false;
  ensureHljsLanguages();
  return Boolean(hljs.getLanguage(lang));
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function splitHighlightedHtml(html) {
  const lines = [];
  const openTags = [];
  let current = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "\n") {
      current += "</span>".repeat(openTags.length);
      lines.push(current);
      current = openTags.join("");
      i++;
      continue;
    }
    if (html.startsWith("<span", i)) {
      const end = html.indexOf(">", i) + 1;
      const tag = html.slice(i, end);
      openTags.push(tag);
      current += tag;
      i = end;
      continue;
    }
    if (html.startsWith("</span>", i)) {
      openTags.pop();
      current += "</span>";
      i += 7;
      continue;
    }
    current += ch;
    i++;
  }
  lines.push(current);
  return lines;
}
function getHighlightedLines(whole, lang) {
  const key = `${lang}
${whole}`;
  const hit = highlightCache.get(key);
  if (hit) return hit;
  ensureHljsLanguages();
  let lines;
  try {
    const html = lang && hljs.getLanguage(lang) ? hljs.highlight(whole, { language: lang }).value : hljs.highlightAuto(whole).value;
    lines = splitHighlightedHtml(sanitizeHtml(html));
  } catch {
    lines = whole.split("\n").map(escapeHtml);
  }
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== void 0) highlightCache.delete(oldest);
  }
  highlightCache.set(key, lines);
  return lines;
}
function highlightSideLines(lines, lang) {
  const out = /* @__PURE__ */ new Map();
  if (lines.length === 0 || !hasHighlightLanguage(lang)) return out;
  const html = getHighlightedLines(
    lines.map((line) => line.text).join("\n"),
    lang
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fragment = html[i];
    if (fragment !== void 0 && line.lineNo >= 0) out.set(line.lineNo, fragment);
  }
  return out;
}
function languageOfPath(path) {
  if (!path) return "";
  const clean = path.split("?")[0];
  const ext = extOf(clean);
  if (ext) return ext;
  const base2 = (clean.split(/[\\/]/).pop() ?? "").toLowerCase();
  return base2;
}
var HLJS_LANGUAGES, HLJS_ALIASES, hljsReady, HLJS_BY_NAME, highlightCache, HIGHLIGHT_CACHE_MAX;
var init_highlight = __esm({
  "src/lib/highlight.ts"() {
    "use strict";
    init_sanitizeHtml();
    init_fileTypes();
    HLJS_LANGUAGES = [
      ["bash", bash],
      ["c", c],
      ["cpp", cpp],
      ["csharp", csharp],
      ["css", css],
      ["diff", diff],
      ["dockerfile", dockerfile],
      ["go", go],
      ["graphql", graphql],
      ["ini", ini],
      ["java", java],
      ["javascript", javascript],
      ["json", json],
      ["kotlin", kotlin],
      ["less", less],
      ["lua", lua],
      ["makefile", makefile],
      ["markdown", markdown],
      ["nginx", nginx],
      ["objectivec", objectivec],
      ["perl", perl],
      ["php", php],
      ["plaintext", plaintext],
      ["python", python],
      ["ruby", ruby],
      ["rust", rust],
      ["scss", scss],
      ["shell", shell],
      ["sql", sql],
      ["swift", swift],
      ["typescript", typescript],
      ["xml", xml],
      ["yaml", yaml]
    ];
    HLJS_ALIASES = {
      sh: "bash",
      zsh: "bash",
      ksh: "bash",
      console: "bash",
      shellscript: "shell",
      py: "python",
      python3: "python",
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      node: "javascript",
      ts: "typescript",
      tsx: "typescript",
      rs: "rust",
      golang: "go",
      yml: "yaml",
      jsonc: "json",
      json5: "json",
      html: "xml",
      htm: "xml",
      svg: "xml",
      vue: "xml",
      "c++": "cpp",
      cc: "cpp",
      hpp: "cpp",
      hxx: "cpp",
      h: "c",
      cs: "csharp",
      "c#": "csharp",
      rb: "ruby",
      objc: "objectivec",
      "objective-c": "objectivec",
      md: "markdown",
      patch: "diff",
      docker: "dockerfile",
      make: "makefile",
      postgres: "sql",
      postgresql: "sql",
      mysql: "sql",
      text: "plaintext",
      txt: "plaintext",
      log: "plaintext",
      toml: "ini",
      cfg: "ini",
      conf: "ini",
      env: "ini",
      properties: "ini",
      sass: "scss"
    };
    hljsReady = false;
    HLJS_BY_NAME = Object.fromEntries(HLJS_LANGUAGES);
    highlightCache = /* @__PURE__ */ new Map();
    HIGHLIGHT_CACHE_MAX = 150;
  }
});

// src/lib/hoverCardPos.ts
function diffPopupPos(rect, vw, vh, width = DIFF_POP_W, gap = 8) {
  const viewW = vw || 1200;
  const viewH = vh || 800;
  const w = Math.max(240, Math.min(width, viewW - 16));
  const left = Math.min(Math.max(rect.left, 8), Math.max(viewW - w - 8, 8));
  const below = viewH - rect.bottom - gap - 8;
  const above = rect.top - gap - 8;
  if (below < DIFF_POP_H && above > below) {
    const maxHeight2 = Math.max(DIFF_POP_MIN_H, Math.min(DIFF_POP_H, above));
    return {
      top: Math.max(8, rect.top - gap - maxHeight2),
      left,
      width: w,
      maxHeight: maxHeight2,
      bottom: viewH - rect.top + gap
    };
  }
  const maxHeight = Math.max(DIFF_POP_MIN_H, Math.min(DIFF_POP_H, below));
  return { top: rect.bottom + gap, left, width: w, maxHeight };
}
var DIFF_POP_W, DIFF_POP_H, DIFF_POP_MIN_H;
var init_hoverCardPos = __esm({
  "src/lib/hoverCardPos.ts"() {
    "use strict";
    DIFF_POP_W = 720;
    DIFF_POP_H = 440;
    DIFF_POP_MIN_H = 150;
  }
});

// src/lib/reviewDiff.ts
function parseHunks(diff2) {
  const out = [];
  let cur = null;
  let bLine = 0;
  let aLine = 0;
  let pendingDel = [];
  let pendingAdd = [];
  const flushPairs = () => {
    if (!pendingDel.length && !pendingAdd.length) return;
    const n = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < n; i++) {
      const hasB = i < pendingDel.length;
      const hasA = i < pendingAdd.length;
      const type = hasB && hasA ? "mod" : hasB ? "del" : "add";
      cur?.rows.push({
        type,
        before: hasB ? pendingDel[i] : "",
        after: hasA ? pendingAdd[i] : "",
        bLine: hasB ? bLine : -1,
        aLine: hasA ? aLine : -1
      });
      if (hasB) bLine++;
      if (hasA) aLine++;
    }
    pendingDel = [];
    pendingAdd = [];
  };
  for (const line of diff2.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const hm = HUNK_RE.exec(line);
    if (hm) {
      flushPairs();
      bLine = parseInt(hm[1], 10);
      aLine = parseInt(hm[3], 10);
      cur = {
        header: line,
        newStart: aLine,
        newCount: hm[4] ? parseInt(hm[4], 10) : 1,
        rows: []
      };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("\\")) {
      flushPairs();
      cur.rows.push({ type: "info", text: line });
    } else if (line.startsWith("-")) {
      pendingDel.push(line.slice(1));
    } else if (line.startsWith("+")) {
      pendingAdd.push(line.slice(1));
    } else {
      flushPairs();
      cur.rows.push({
        type: "same",
        before: line.slice(1),
        after: line.slice(1),
        bLine,
        aLine
      });
      bLine++;
      aLine++;
    }
  }
  flushPairs();
  return out;
}
function parseDiffRows(diff2) {
  const out = [];
  for (const h of parseHunks(diff2)) {
    out.push({ type: "hunk", text: h.header });
    out.push(...h.rows);
  }
  return out;
}
function parseSideBySide(diff2) {
  const hunks = parseHunks(diff2);
  const items = [];
  let prevNewEnd = 0;
  hunks.forEach((h, i) => {
    const gap = h.newStart - prevNewEnd - 1;
    if (i > 0 && gap > 0) {
      items.push({ kind: "gap", count: gap, key: `gap-${i}` });
    }
    items.push({ kind: "rows", rows: h.rows, key: `hunk-${i}` });
    prevNewEnd = h.newStart + h.newCount - 1;
  });
  return items;
}
var HUNK_RE;
var init_reviewDiff = __esm({
  "src/lib/reviewDiff.ts"() {
    "use strict";
    HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  }
});

// src/lib/selectionBar.ts
function selectionBarPos(rect, vw, vh) {
  const width = vw || 800;
  const height = vh || 600;
  return {
    x: Math.min(Math.max(rect.left, 8), Math.max(width - SEL_BAR_W - 8, 8)),
    y: Math.max(8, Math.min(rect.bottom + 6, Math.max(height - SEL_BAR_H - 8, 8)))
  };
}
var SEL_BAR_W, SEL_BAR_H;
var init_selectionBar = __esm({
  "src/lib/selectionBar.ts"() {
    "use strict";
    SEL_BAR_W = 76;
    SEL_BAR_H = 34;
  }
});

// src/lib/useDiffScrollbars.ts
import { useEffect as useEffect5 } from "react";
function useOverlayScrollbars(hostRef, signature) {
  useEffect5(() => {
    const host = hostRef && "current" in hostRef ? hostRef.current : hostRef;
    if (!host) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    host.querySelectorAll(":scope > .sp-bar").forEach((n) => n.remove());
    const makeBar = (axis) => {
      const lane = document.createElement("div");
      lane.className = "sp-bar";
      lane.dataset.axis = axis;
      lane.setAttribute("aria-hidden", "true");
      const thumb = document.createElement("div");
      thumb.className = "sp-thumb";
      thumb.dataset.axis = axis;
      lane.appendChild(thumb);
      return { lane, thumb, axis };
    };
    const v = makeBar("y");
    const h = makeBar("x");
    host.classList.add("sp-host", "sp-scroll");
    host.dataset.sp = "h";
    const nested = laneHost(host).nested;
    const thumbLen = (view, content) => Math.max(MIN_THUMB, Math.round(view * view / Math.max(1, content)));
    const place = () => {
      const maxL = host.scrollWidth - host.clientWidth;
      const maxT = host.scrollHeight - host.clientHeight;
      const box = maxT > 1 || maxL > 1 ? laneBox(host) : null;
      let outerX = false;
      for (let el = host.parentElement; el; el = el.parentElement) {
        if (el.classList.contains("sp-host") && el.scrollWidth - el.clientWidth > 1) {
          outerX = true;
          break;
        }
      }
      if (maxT > 1 && box) {
        const track = box.height;
        const len = thumbLen(track, host.scrollHeight);
        v.lane.style.display = "";
        placeLane(v.lane, box, "y");
        v.thumb.style.height = `${len}px`;
        v.thumb.style.transform = `translateY(${Math.round(host.scrollTop / maxT * (track - len))}px)`;
      } else {
        v.lane.style.display = "none";
      }
      if (maxL > 1 && !outerX && box) {
        const track = box.width;
        const len = thumbLen(track, host.scrollWidth);
        h.lane.style.display = "";
        placeLane(h.lane, box, "x");
        h.thumb.style.width = `${len}px`;
        h.thumb.style.transform = `translateX(${Math.round(host.scrollLeft / maxL * (track - len))}px)`;
      } else {
        h.lane.style.display = "none";
      }
    };
    let drag = null;
    const onDown = (bar) => (e) => {
      const axis = bar.axis;
      const max = axis === "y" ? host.scrollHeight - host.clientHeight : host.scrollWidth - host.clientWidth;
      if (max <= 1) return;
      e.preventDefault();
      const rect = bar.lane.getBoundingClientRect();
      const track = axis === "y" ? bar.lane.clientHeight : bar.lane.clientWidth;
      const len = axis === "y" ? bar.thumb.offsetHeight : bar.thumb.offsetWidth;
      const p = axis === "y" ? e.clientY - rect.top : e.clientX - rect.left;
      const tr = bar.thumb.getBoundingClientRect();
      const inside = axis === "y" ? e.clientY >= tr.top && e.clientY <= tr.bottom : e.clientX >= tr.left && e.clientX <= tr.right;
      const ratio = inside ? (axis === "y" ? host.scrollTop : host.scrollLeft) / max : Math.min(1, Math.max(0, (p - len / 2) / Math.max(1, track - len)));
      const startScroll = ratio * max;
      if (axis === "y") host.scrollTop = startScroll;
      else host.scrollLeft = startScroll;
      drag = {
        axis,
        start: axis === "y" ? e.clientY : e.clientX,
        startScroll,
        len,
        max,
        track
      };
    };
    v.lane.addEventListener("pointerdown", onDown(v));
    h.lane.addEventListener("pointerdown", onDown(h));
    const move = (e) => {
      if (!drag) return;
      const d = (drag.axis === "y" ? e.clientY : e.clientX) - drag.start;
      const next = drag.startScroll + d * (drag.max / Math.max(1, drag.track - drag.len));
      if (drag.axis === "y") host.scrollTop = next;
      else host.scrollLeft = next;
      e.preventDefault();
    };
    const release = () => {
      drag = null;
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    const relayout = () => place();
    host.addEventListener("scroll", relayout, { passive: true });
    const onAncestorScroll = (e) => {
      if (e.target !== host) place();
    };
    if (nested) document.addEventListener("scroll", onAncestorScroll, true);
    place();
    let raf = requestAnimationFrame(() => {
      place();
      raf = requestAnimationFrame(place);
    });
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(relayout);
      ro.observe(host);
    }
    const mo = new MutationObserver(relayout);
    mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    let ticks = 0;
    let settled = { w: -1, h: -1 };
    const poll = window.setInterval(() => {
      place();
      const w = host.scrollWidth;
      const ht = host.scrollHeight;
      if (++ticks > 2 && w === settled.w && ht === settled.h) window.clearInterval(poll);
      settled = { w, h: ht };
      if (ticks > 20) window.clearInterval(poll);
    }, 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      ro?.disconnect();
      mo.disconnect();
      host.removeEventListener("scroll", relayout);
      document.removeEventListener("scroll", onAncestorScroll, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      v.lane.remove();
      h.lane.remove();
      host.classList.remove("sp-host", "sp-scroll");
      delete host.dataset.sp;
    };
  }, [hostRef, signature]);
}
function useDiffScrollbars(hostRef, signature) {
  return useOverlayScrollbars(hostRef, signature);
}
var MIN_THUMB, THICK, scrolls, laneHost, laneBox, placeLane;
var init_useDiffScrollbars = __esm({
  "src/lib/useDiffScrollbars.ts"() {
    "use strict";
    "use client";
    MIN_THUMB = 22;
    THICK = 12;
    scrolls = (el) => {
      const cs = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(cs.overflowX) || /(auto|scroll|overlay)/.test(cs.overflowY);
    };
    laneHost = (host) => {
      let nested = false;
      for (let el = host.parentElement; el; el = el.parentElement) {
        if (scrolls(el)) {
          nested = true;
          continue;
        }
        if (getComputedStyle(el).position !== "static") return { el, nested };
      }
      return { el: document.body, nested };
    };
    laneBox = (host) => {
      const { el: parent } = laneHost(host);
      const hr = host.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      const root = parent === document.body ? document.scrollingElement : null;
      const inset = Number.parseFloat(getComputedStyle(host).getPropertyValue("--sp-inset-bottom")) || 0;
      return {
        parent,
        left: hr.left + host.clientLeft - pr.left - parent.clientLeft + (root?.scrollLeft ?? parent.scrollLeft),
        top: hr.top + host.clientTop - pr.top - parent.clientTop + (root?.scrollTop ?? parent.scrollTop),
        width: host.clientWidth,
        height: Math.max(MIN_THUMB, host.clientHeight - inset)
      };
    };
    placeLane = (lane, box, axis) => {
      if (lane.parentElement !== box.parent) box.parent.appendChild(lane);
      if (axis === "y") {
        lane.style.left = `${box.left + box.width - THICK}px`;
        lane.style.top = `${box.top}px`;
        lane.style.width = `${THICK}px`;
        lane.style.height = `${box.height}px`;
      } else {
        lane.style.left = `${box.left}px`;
        lane.style.top = `${box.top + box.height - THICK}px`;
        lane.style.width = `${box.width}px`;
        lane.style.height = `${THICK}px`;
      }
    };
  }
});

// src/lib/useDragScroll.tsx
import { useRef as useRef4 } from "react";
import { jsx as jsx4 } from "react/jsx-runtime";
function scrollTarget(el) {
  const own = getComputedStyle(el);
  if (own.overflowX !== "visible" || own.overflowY !== "visible") return el;
  for (let n = el.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const sx = (cs.overflowX === "auto" || cs.overflowX === "scroll") && n.scrollWidth > n.clientWidth;
    const sy = (cs.overflowY === "auto" || cs.overflowY === "scroll") && n.scrollHeight > n.clientHeight;
    if (sx || sy) return n;
  }
  return el;
}
function useDragScroll() {
  const ref = useRef4(null);
  const drag = useRef4(null);
  const onMouseDown = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const own = ref.current;
    if (!own) return;
    const el = scrollTarget(own);
    e.preventDefault();
    drag.current = {
      el,
      sx: e.clientX,
      sy: e.clientY,
      scrollX: el.scrollLeft,
      scrollY: el.scrollTop
    };
    el.style.cursor = "grabbing";
    el.style.userSelect = "none";
  };
  const onMouseMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.el.scrollLeft = d.scrollX - (e.clientX - d.sx);
    d.el.scrollTop = d.scrollY - (e.clientY - d.sy);
  };
  const end = () => {
    const d = drag.current;
    if (d) {
      d.el.style.cursor = "";
      d.el.style.userSelect = "";
    }
    drag.current = null;
  };
  const handlers = {
    ref,
    onMouseDown,
    onMouseMove,
    onMouseUp: end,
    onMouseLeave: end
  };
  return handlers;
}
var init_useDragScroll = __esm({
  "src/lib/useDragScroll.tsx"() {
    "use strict";
  }
});

// src/components/toolcall/diff.tsx
import { memo, useCallback as useCallback4, useEffect as useEffect6, useMemo as useMemo2, useRef as useRef5, useState as useState4 } from "react";
import { createPortal } from "react-dom";
import { Fragment as Fragment2, jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
function TomlLine({ text }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#")) return /* @__PURE__ */ jsx5("span", { className: "toml-comment", children: text });
  const eq = text.indexOf("=");
  if (eq < 0) return /* @__PURE__ */ jsx5(Fragment2, { children: text });
  const key = text.slice(0, eq).trimEnd();
  const rest = text.slice(eq);
  const value = rest.slice(1).trimStart();
  const isString = value.startsWith('"') || value.startsWith("'");
  return /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsx5("span", { className: "toml-key", children: key }),
    /* @__PURE__ */ jsx5("span", { className: "toml-eq", children: " = " }),
    /* @__PURE__ */ jsx5("span", { className: isString ? "toml-string" : "toml-value", children: rest.slice(1).trimStart() })
  ] });
}
function DiffLineText({
  text,
  path,
  html,
  commentSpans,
  query,
  hitBase = 0,
  activeHit = -1,
  activeRef
}) {
  const q = (query ?? "").trim();
  if (q)
    return /* @__PURE__ */ jsx5(Fragment2, { children: highlightParts(text, q, hitBase, activeHit, activeRef) });
  if (path && path.split("?")[0].toLowerCase().endsWith(".toml")) {
    return /* @__PURE__ */ jsx5(TomlLine, { text });
  }
  if (html != null) {
    return /* @__PURE__ */ jsx5(
      "span",
      {
        className: "diff-code",
        dir: "auto",
        dangerouslySetInnerHTML: { __html: html === "" ? "\n" : html }
      }
    );
  }
  const segments = splitCommentSegments(text, commentSpans);
  if (segments.length === 1 && !segments[0].comment) return /* @__PURE__ */ jsx5(Fragment2, { children: text });
  return /* @__PURE__ */ jsx5(Fragment2, { children: segments.map(
    (seg, i) => seg.comment ? /* @__PURE__ */ jsx5("span", { className: "diff-comment", children: seg.text }, i) : /* @__PURE__ */ jsx5("span", { children: seg.text }, i)
  ) });
}
function highlightParts(text, query, base2, active, activeRef) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  let ordinal = 0;
  for (; ; ) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      if (i < text.length) out.push(/* @__PURE__ */ jsx5("span", { children: text.slice(i) }, k++));
      break;
    }
    if (j > i) out.push(/* @__PURE__ */ jsx5("span", { children: text.slice(i, j) }, k++));
    const idx = base2 + ordinal;
    ordinal++;
    const isActive = idx === active;
    out.push(
      /* @__PURE__ */ jsx5(
        "mark",
        {
          className: isActive ? "diff-hit diff-hit-active" : "diff-hit",
          ...isActive ? { "aria-current": "true" } : {},
          ref: isActive && activeRef ? (el) => {
            activeRef.current = el;
          } : void 0,
          children: text.slice(j, j + q.length)
        },
        k++
      )
    );
    i = j + q.length;
  }
  return out;
}
function shouldShowSideBySide(width, threshold = DIFF_SIDE_BY_SIDE_THRESHOLD) {
  return width >= threshold;
}
function diffQuoteForSelection(container, sel, path, text) {
  const nums = [];
  const collect2 = (node) => {
    if (!node) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || typeof el.closest !== "function") return;
    const lined = el.closest("[data-lineno]");
    if (lined) {
      const n = parseInt(lined.getAttribute("data-lineno") ?? "", 10);
      if (Number.isFinite(n)) {
        nums.push(n);
        return;
      }
    }
    const row = el.closest(".diff-u-row, .diff-line");
    if (row) {
      const numText = row.querySelector(".diff-u-num")?.textContent?.trim() ?? "";
      const n = parseInt(numText, 10);
      if (numText !== "" && Number.isFinite(n)) {
        nums.push(n);
        return;
      }
      const all = Array.from(container.querySelectorAll(".diff-u-row, .diff-line"));
      const idx = all.indexOf(row);
      if (idx >= 0) nums.push(idx + 1);
    }
  };
  collect2(sel.anchorNode);
  if (sel.focusNode && sel.focusNode !== sel.anchorNode) collect2(sel.focusNode);
  if (nums.length === 0) return `[${path}] ${text}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return `[${path} line ${min}] ${text}`;
  return `[${path} lines ${min}-${max}] ${text}`;
}
function useDiffPreview() {
  const [snap, setSnap] = useState4(null);
  const openedAt = useRef5(0);
  const open = useCallback4((el, diff2, path) => {
    if (!el || !diff2 || typeof window === "undefined") return;
    openedAt.current = Date.now();
    setSnap({
      diff: diff2,
      path,
      pos: diffPopupPos(
        el.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight
      )
    });
  }, []);
  const close = useCallback4(() => setSnap(null), []);
  const keep = useCallback4(() => {
    openedAt.current = Date.now();
  }, []);
  useEffect6(() => {
    if (!snap) return;
    const onKey = (e) => {
      if (e.key === "Escape") setSnap(null);
    };
    const onDown = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== "function") return;
      if (t.closest(".diff-preview-card, .fv-sel-bar, .fv-comment-float")) return;
      if (Date.now() - openedAt.current < 250) return;
      setSnap(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [snap]);
  return { snap, open, close, keep };
}
function DiffView({
  diff: diff2,
  path,
  query,
  activeHit = -1,
  layout = "auto",
  threshold = DIFF_SIDE_BY_SIDE_THRESHOLD,
  commentable = true
}) {
  const rows = parseDiffRows(diff2);
  const sideItems = parseSideBySide(diff2);
  const drag = useDragScroll();
  const measureRef = useRef5(null);
  const [measuredWidth, setMeasuredWidth] = useState4(0);
  useEffect6(() => {
    const el = measureRef.current;
    if (!el) return;
    const update = (w) => setMeasuredWidth(w);
    update(el.clientWidth || 0);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [diff2]);
  const showSide = layout === "unified" ? false : layout === "side-by-side" ? measuredWidth > 0 ? shouldShowSideBySide(measuredWidth, threshold) : true : shouldShowSideBySide(measuredWidth, threshold);
  useDiffScrollbars(measureRef, showSide ? `${diff2}|side` : diff2);
  const lang = languageOfPath(path);
  const { beforeHtml, afterHtml, beforeSpans, afterSpans } = useMemo2(() => {
    const before = [];
    const after = [];
    for (const row of rows) {
      if ("text" in row) continue;
      if (row.type === "add") {
        after.push({ lineNo: row.aLine, text: row.after });
      } else if (row.type === "del") {
        before.push({ lineNo: row.bLine, text: row.before });
      } else {
        before.push({ lineNo: row.bLine, text: row.before });
        after.push({ lineNo: row.aLine, text: row.after });
      }
    }
    const syntax = commentSyntax(path);
    return {
      beforeHtml: highlightSideLines(before, lang),
      afterHtml: highlightSideLines(after, lang),
      beforeSpans: buildCommentSpans(before, syntax),
      afterSpans: buildCommentSpans(after, syntax)
    };
  }, [rows, path, lang]);
  const activeRef = useRef5(null);
  useEffect6(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff2]);
  const chatId = useStore((s) => s.activeChatId);
  const [box, setBox] = useState4(null);
  const [selBar, setSelBar] = useState4(null);
  const [note, setNote] = useState4("");
  const commentInputRef = useRef5(null);
  useEffect6(() => {
    if (!box) return;
    const id = requestAnimationFrame(() => {
      try {
        commentInputRef.current?.focus?.({ preventScroll: true });
      } catch {
        commentInputRef.current?.focus?.();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [box]);
  useEffect6(() => {
    if (!box && !selBar) return;
    const onDown = (e) => {
      const t = e.target;
      if (t && typeof t.closest === "function" && t.closest(".fv-comment-float, .fv-sel-bar")) return;
      const container = measureRef.current;
      if (container && t instanceof Element && container.contains(t)) return;
      setBox(null);
      setSelBar(null);
      setNote("");
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [box, selBar]);
  if (rows.length === 0) return null;
  const closeBox = () => {
    setBox(null);
    setNote("");
  };
  const closeSelBar = () => {
    setSelBar(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
    }
  };
  const openBox = () => {
    if (!selBar) return;
    setBox({ base: selBar.base, x: selBar.x, y: selBar.y });
    setSelBar(null);
    setNote("");
  };
  const copySelection = () => {
    if (!selBar) return;
    let live = "";
    try {
      live = window.getSelection()?.toString().trim() ?? "";
    } catch {
      live = "";
    }
    void copyToClipboard(live || selBar.base);
    closeSelBar();
  };
  const sendBox = (queued) => {
    if (!box || !chatId) {
      closeBox();
      return;
    }
    const filePath = path ?? "diff";
    const trimmed = note.trim();
    const quote = trimmed ? `${box.base}

Note: ${trimmed}` : box.base;
    const lineMatch = box.base.match(/\[.* lines? (\d+(?:-\d+)?)\]/);
    const target = lineMatch ? `${filePath}:${lineMatch[1]}` : filePath;
    commentFileSelection(chatId, target, quote, { queue: queued });
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
    }
    closeBox();
  };
  const refreshHighlight = () => {
    if (!commentable) return;
    if (box) return;
    const container = measureRef.current;
    if (!container) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || !container.contains(sel.anchorNode)) return;
    if (sel.isCollapsed) {
      if (selBar) setSelBar(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      if (selBar) setSelBar(null);
      return;
    }
    const filePath = path ?? "diff";
    const base2 = diffQuoteForSelection(container, sel, filePath, text.slice(0, 500));
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (rect && typeof window !== "undefined") {
        setSelBar({
          base: base2,
          ...selectionBarPos(rect, window.innerWidth, window.innerHeight)
        });
        return;
      }
    } catch {
    }
    setSelBar({ base: base2, x: 16, y: 96 });
  };
  let hitCursor = 0;
  const renderRow = (key, cls, gutter, lineNo, text, side) => {
    const q = (query ?? "").trim();
    const base2 = hitCursor;
    if (q) hitCursor += countOccurrences(text, q);
    return /* @__PURE__ */ jsxs4("div", { className: `diff-u-row ${cls}`, children: [
      /* @__PURE__ */ jsx5("span", { className: "diff-u-gutter", children: gutter }),
      /* @__PURE__ */ jsx5("span", { className: "diff-u-num", children: lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx5("span", { className: "diff-u-text", children: /* @__PURE__ */ jsx5(
        DiffLineText,
        {
          text,
          path,
          html: side === "before" ? beforeHtml.get(lineNo) : side === "after" ? afterHtml.get(lineNo) : afterHtml.get(lineNo) ?? beforeHtml.get(lineNo),
          commentSpans: side === "before" ? beforeSpans.get(lineNo) : side === "after" ? afterSpans.get(lineNo) : afterSpans.get(lineNo) ?? beforeSpans.get(lineNo),
          query,
          hitBase: base2,
          activeHit,
          activeRef
        }
      ) })
    ] }, key);
  };
  const renderSideCell = (key, cls, lineNo, text, empty, side) => {
    const q = (query ?? "").trim();
    const base2 = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    const marker = cls === "diff-line-del" ? "-" : cls === "diff-line-add" ? "+" : " ";
    return /* @__PURE__ */ jsxs4("span", { className: `diff-line ${cls}`, children: [
      /* @__PURE__ */ jsx5("span", { className: "diff-u-gutter", children: empty ? "" : marker }),
      /* @__PURE__ */ jsx5("span", { className: "diff-u-num", children: !empty && lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx5("span", { className: "diff-u-text", children: !empty ? /* @__PURE__ */ jsx5(
        DiffLineText,
        {
          text,
          path,
          html: side === "before" ? beforeHtml.get(lineNo) : afterHtml.get(lineNo),
          commentSpans: side === "before" ? beforeSpans.get(lineNo) : afterSpans.get(lineNo),
          query,
          hitBase: base2,
          activeHit,
          activeRef
        }
      ) : "\xA0" })
    ] }, key);
  };
  const syncPairScroll = (e) => {
    const src = e.target;
    if (!src || !src.classList?.contains("diff-col-code")) return;
    const pair = e.currentTarget;
    pair.querySelectorAll(".diff-col-code").forEach((el) => {
      if (el !== src && el.scrollLeft !== src.scrollLeft) el.scrollLeft = src.scrollLeft;
    });
  };
  const renderSide = () => /* @__PURE__ */ jsxs4("div", { className: "diff-columns", dir: "ltr", ...drag, children: [
    /* @__PURE__ */ jsxs4("div", { className: "diff-columns-head", children: [
      /* @__PURE__ */ jsx5("div", { className: "diff-col-header diff-col-before", children: "Before" }),
      /* @__PURE__ */ jsx5("div", { className: "diff-col-header diff-col-after", children: "After" })
    ] }),
    sideItems.map((item) => {
      if (item.kind === "gap") {
        return /* @__PURE__ */ jsxs4("div", { className: "diff-gap", children: [
          item.count,
          " unmodified lines"
        ] }, item.key);
      }
      const metas = item.rows.filter((r) => "text" in r);
      const contents = item.rows.filter((r) => !("text" in r));
      return /* @__PURE__ */ jsxs4("div", { className: "diff-hunk-pair", onScrollCapture: syncPairScroll, children: [
        metas.map((m, mi) => /* @__PURE__ */ jsx5("div", { className: `diff-u-meta ${m.type}`, children: "text" in m ? m.text : "" }, `${item.key}-m${mi}`)),
        /* @__PURE__ */ jsx5("div", { className: "diff-col diff-col-before", children: /* @__PURE__ */ jsx5("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
          if ("text" in r) return null;
          if (r.type === "same")
            return renderSideCell(`${ri}-b`, "", r.bLine, r.before, false, "before");
          if (r.type === "del" || r.type === "mod")
            return renderSideCell(
              `${ri}-b`,
              "diff-line-del",
              r.bLine,
              r.before,
              false,
              "before"
            );
          return renderSideCell(`${ri}-b`, "diff-line-empty", -1, "", true, "before");
        }) }) }),
        /* @__PURE__ */ jsx5("div", { className: "diff-col diff-col-after", children: /* @__PURE__ */ jsx5("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
          if ("text" in r) return null;
          if (r.type === "same")
            return renderSideCell(`${ri}-a`, "", r.aLine, r.after, false, "after");
          if (r.type === "add" || r.type === "mod")
            return renderSideCell(
              `${ri}-a`,
              "diff-line-add",
              r.aLine,
              r.after,
              false,
              "after"
            );
          return renderSideCell(`${ri}-a`, "diff-line-empty", -1, "", true, "after");
        }) }) })
      ] }, item.key);
    })
  ] });
  const renderUnified = () => /* @__PURE__ */ jsx5("div", { className: "diff-unified", dir: "ltr", ...drag, children: rows.flatMap((row, i) => {
    if ("text" in row) {
      return /* @__PURE__ */ jsx5("div", { className: `diff-u-meta ${row.type}`, children: row.text }, i);
    }
    if (row.type === "same")
      return renderRow(i, "diff-u-ctx", " ", row.aLine, row.after, "both");
    if (row.type === "del")
      return renderRow(i, "diff-u-del", "-", row.bLine, row.before, "before");
    if (row.type === "add")
      return renderRow(i, "diff-u-add", "+", row.aLine, row.after, "after");
    return [
      renderRow(`${i}-d`, "diff-u-del", "-", row.bLine, row.before, "before"),
      renderRow(`${i}-a`, "diff-u-add", "+", row.aLine, row.after, "after")
    ];
  }) });
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      ref: measureRef,
      className: "diff-responsive sp-scroll",
      "data-layout": showSide ? "side-by-side" : "unified",
      onMouseUp: refreshHighlight,
      onKeyUp: refreshHighlight,
      children: [
        showSide ? renderSide() : renderUnified(),
        commentable && selBar && !box && typeof document !== "undefined" ? createPortal(
          /* @__PURE__ */ jsxs4(
            "div",
            {
              className: "fv-sel-bar",
              style: { position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 },
              onMouseUp: (e) => e.stopPropagation(),
              onKeyUp: (e) => e.stopPropagation(),
              children: [
                /* @__PURE__ */ jsx5(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Copy",
                    "aria-label": "Copy selection",
                    onClick: copySelection,
                    children: /* @__PURE__ */ jsxs4("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx5("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
                      /* @__PURE__ */ jsx5("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                    ] })
                  }
                ),
                /* @__PURE__ */ jsx5(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Reply",
                    "aria-label": "Reply to selection",
                    onClick: openBox,
                    children: /* @__PURE__ */ jsxs4("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx5("polyline", { points: "9 17 4 12 9 7" }),
                      /* @__PURE__ */ jsx5("path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" })
                    ] })
                  }
                )
              ]
            }
          ),
          document.body
        ) : null,
        commentable && box && typeof document !== "undefined" ? createPortal(
          /* @__PURE__ */ jsx5(
            "div",
            {
              className: "fv-comment-float",
              style: {
                position: "fixed",
                left: box.x,
                top: box.y,
                zIndex: 9999
              },
              onMouseUp: (e) => e.stopPropagation(),
              onKeyUp: (e) => e.stopPropagation(),
              children: /* @__PURE__ */ jsx5(
                "textarea",
                {
                  ref: commentInputRef,
                  className: "fv-comment-input",
                  dir: "auto",
                  value: note,
                  onChange: (e) => setNote(e.target.value),
                  onMouseUp: (e) => e.stopPropagation(),
                  onKeyUp: (e) => e.stopPropagation(),
                  onKeyDown: (e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      try {
                        window.getSelection()?.removeAllRanges();
                      } catch {
                      }
                      closeBox();
                    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      sendBox(true);
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendBox(false);
                    }
                  },
                  rows: 2,
                  placeholder: "Write a comment\u2026 Enter to send, Esc to cancel",
                  "aria-label": "Comment on diff highlight"
                }
              )
            }
          ),
          document.body
        ) : null
      ]
    }
  );
}
function parseHunks2(diff2) {
  const hunks = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let cur = null;
  const lines = diff2.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = hunkRe.exec(line);
    if (m) {
      cur = { newStart: parseInt(m[2], 10), items: [] };
      hunks.push(cur);
    } else if (cur) {
      if (line.startsWith("\\")) cur.items.push({ kind: "marker", text: "" });
      else if (line.startsWith("+"))
        cur.items.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-"))
        cur.items.push({ kind: "del", text: line.slice(1) });
      else cur.items.push({ kind: "ctx", text: line.slice(1) });
    }
  }
  return hunks;
}
function applyReverseDiff(diff2, current) {
  const cur = current.split("\n");
  if (current.endsWith("\n")) cur.pop();
  const hunks = parseHunks2(diff2);
  const out = [];
  let ci = 0;
  let oldEofNoNewline = false;
  for (const hunk of hunks) {
    const target = hunk.newStart - 1;
    while (ci < target && ci < cur.length) {
      out.push(cur[ci]);
      ci++;
    }
    let prev = null;
    for (const item of hunk.items) {
      if (item.kind === "marker") {
        if (prev === "del" || prev === "ctx") oldEofNoNewline = true;
        prev = null;
        continue;
      }
      if (item.kind === "ctx") {
        prev = "ctx";
        out.push(ci < cur.length ? cur[ci] : item.text);
        ci++;
      } else if (item.kind === "add") {
        prev = "add";
        ci++;
      } else {
        prev = "del";
        out.push(item.text);
      }
    }
  }
  for (; ci < cur.length; ci++) out.push(cur[ci]);
  let content = out.join("\n");
  if (!oldEofNoNewline) content += "\n";
  return content;
}
var DIFF_SIDE_BY_SIDE_THRESHOLD, DiffPreview;
var init_diff = __esm({
  "src/components/toolcall/diff.tsx"() {
    "use strict";
    init_chatFocus();
    init_clipboard();
    init_diffComments();
    init_diffSearch();
    init_fileComments();
    init_highlight();
    init_hoverCardPos();
    init_panePointer();
    init_reviewDiff();
    init_selectionBar();
    init_store();
    init_useDiffScrollbars();
    init_useDragScroll();
    init_useVimScroll();
    DIFF_SIDE_BY_SIDE_THRESHOLD = 768;
    DiffPreview = memo(function DiffPreview2({
      diff: diff2,
      path,
      pos,
      onClose,
      onPress
    }) {
      const basename = path ? path.split("/").pop() ?? path : "";
      const cardRef = useRef5(null);
      useVimScroll(cardRef);
      const previewBodyRef = useRef5(null);
      useDiffScrollbars(previewBodyRef, diff2);
      useEffect6(() => {
        const el = cardRef.current;
        if (!el) return;
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
        markVimRegion(el);
        return () => {
          const a = document.activeElement;
          if (a && a !== document.body) return;
          const id = useStore.getState().activeChatId;
          if (id) requestAnimationFrame(() => focusChatInput(id));
        };
      }, []);
      return /* @__PURE__ */ jsxs4(
        "div",
        {
          ref: cardRef,
          className: "diff-preview-card",
          style: {
            position: "fixed",
            ...pos.bottom !== void 0 ? { bottom: pos.bottom } : { top: pos.top },
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            zIndex: 9998
          },
          role: "dialog",
          "aria-label": basename ? `Diff preview for ${basename}` : "Diff preview",
          dir: "ltr",
          onPointerDown: onPress,
          children: [
            /* @__PURE__ */ jsxs4("div", { className: "diff-preview-head", children: [
              /* @__PURE__ */ jsx5("span", { className: "diff-preview-path", dir: "auto", title: path, children: basename }),
              /* @__PURE__ */ jsx5(
                "button",
                {
                  type: "button",
                  className: "diff-preview-close",
                  title: "Close preview",
                  "aria-label": "Close diff preview",
                  onClick: onClose,
                  children: /* @__PURE__ */ jsxs4("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx5("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                    /* @__PURE__ */ jsx5("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
                  ] })
                }
              )
            ] }),
            /* @__PURE__ */ jsx5("div", { className: "diff-preview-body", ref: previewBodyRef, children: /* @__PURE__ */ jsx5(DiffView, { diff: diff2, path, layout: "unified" }) })
          ]
        }
      );
    });
  }
});

// src/components/toolcall/naming.ts
import { useEffect as useEffect7, useState as useState5 } from "react";
function ensureSharedTick() {
  if (sharedTickId !== null) return;
  sharedTickId = setInterval(() => {
    for (const cb of tickListeners) cb();
  }, TICK_MS);
  const t = sharedTickId;
  if (typeof t.unref === "function") t.unref();
}
function releaseSharedTick() {
  if (tickListeners.size === 0 && sharedTickId !== null) {
    clearInterval(sharedTickId);
    sharedTickId = null;
  }
}
function useRunningClock(running) {
  const [now, setNow] = useState5(() => Date.now());
  useEffect7(() => {
    if (!running) return;
    setNow(Date.now());
    const cb = () => setNow(Date.now());
    tickListeners.add(cb);
    ensureSharedTick();
    return () => {
      tickListeners.delete(cb);
      releaseSharedTick();
    };
  }, [running]);
  return now;
}
function canonicalTool(tool) {
  const aliased = TOOL_ALIAS[tool] ?? TOOL_ALIAS[tool.trim().toLowerCase().replace(/[-\s]/g, "_")] ?? tool;
  const direct = Object.keys(TOOL_LABEL).find(
    (k) => k.toLowerCase() === aliased.trim().toLowerCase()
  );
  return direct ?? aliased;
}
function toolIcon(tool) {
  return TOOL_ICON[tool] ?? "\u2022";
}
function toolLabel(tool) {
  const server = mcpServerOf(tool);
  if (server) return `${bareToolName(tool)} \xB7 ${server}`;
  const canonical = canonicalTool(tool);
  return TOOL_LABEL[canonical] ?? canonical;
}
function batchOpTools(activity) {
  const out = [];
  let ops = activity.args?.ops;
  if (typeof ops === "string") {
    try {
      ops = JSON.parse(ops);
    } catch {
      ops = void 0;
    }
  }
  if (Array.isArray(ops)) {
    for (const op of ops) {
      const name = typeof op?.tool === "string" ? op.tool.trim() : "";
      if (name) out.push(canonicalTool(name));
    }
  }
  if (out.length === 0) {
    for (const m of (activity.resultText ?? "").matchAll(
      /=== \[\d+\/\d+\] ([A-Za-z0-9_]+)/g
    )) {
      out.push(canonicalTool(m[1]));
    }
  }
  return out;
}
function activityLabel(activity) {
  if (activity.tool === "batch") {
    const counts = /* @__PURE__ */ new Map();
    for (const tool of batchOpTools(activity)) {
      const label = toolLabel(tool);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size > 0) {
      return [...counts.entries()].map(([label, n]) => n > 1 ? `${label} \xD7${n}` : label).join(", ");
    }
  }
  return toolLabel(activity.tool);
}
function subagentDisplayName(tool, rows) {
  if (tool === "explore") return "Explore";
  const id = subagentIdOf(tool);
  if (!id) return toolLabel(tool);
  const row = rows.find((r) => r.id === id);
  const name = row?.name?.trim();
  if (name) return name;
  const pretty = id.split(/[_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return pretty || "Sub-agent";
}
function editGroupStats(activities) {
  let adds = 0;
  let dels = 0;
  for (const { activity } of activities) {
    if (!activity.diff) continue;
    const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
    adds += s.adds;
    dels += s.dels;
  }
  return { adds, dels };
}
var TICK_MS, sharedTickId, tickListeners, TOOL_LABEL, TOOL_ALIAS, TOOL_ICON, isSubagentCard, EDIT_TOOLS, isEditActivity;
var init_naming = __esm({
  "src/components/toolcall/naming.ts"() {
    "use strict";
    init_mcpTools();
    init_toolActivity();
    init_subagents();
    TICK_MS = 500;
    sharedTickId = null;
    tickListeners = /* @__PURE__ */ new Set();
    TOOL_LABEL = {
      write_file: "Write File",
      edit_file: "Edit File",
      list_files: "List Directory",
      read: "Read File",
      grep: "Search Files",
      glob: "Search Files",
      find_symbol: "Find Symbol",
      web_search: "Web Search",
      run_terminal: "Ran a command",
      run_tests: "Ran related tests",
      search_memory: "Search Memory",
      memory: "Memory",
      ask_user: "Ask User",
      fetch_url: "Fetch URL",
      explore: "Explore",
      vision: "Vision",
      create_skill: "Create Skill",
      create_mcp: "Create MCP",
      load_skill: "Load Skill",
      load_plugin: "Load Plugin",
      update_plan: "Update Plan",
      git_status: "Git Status",
      git_diff: "Git Diff",
      git_commit: "Git Commit",
      git_log: "Git Log",
      current_time: "Current Time",
      system_stats: "System Stats",
      computer: "Computer",
      search_console: "Search Console",
      // Safety net only: a batch card is labelled with the tools it ran
      // (`activityLabel`), so this shows just when no op is known yet.
      batch: "Tools"
    };
    TOOL_ALIAS = {
      read_client: "read",
      read_file: "read",
      readfile: "read",
      view_file: "read",
      read_text_file: "read",
      get_file: "read",
      search_files: "grep",
      search_content: "grep",
      ripgrep: "grep",
      find_files: "glob",
      list_dir: "glob",
      ls: "glob",
      list_directory: "glob",
      shell: "run_terminal",
      bash: "run_terminal",
      sh: "run_terminal",
      run_command: "run_terminal",
      execute_command: "run_terminal",
      search_web: "web_search",
      websearch: "web_search",
      skill: "load_skill",
      create_file: "write_file",
      writefile: "write_file",
      str_replace: "edit_file",
      replace_in_file: "edit_file",
      todos: "update_plan",
      todo_write: "update_plan",
      write_todos: "update_plan",
      update_todos: "update_plan",
      ask: "ask_user",
      ask_question: "ask_user",
      permission: "confirm_action",
      request_permission: "confirm_action"
    };
    TOOL_ICON = {
      run_terminal: "\u276F",
      run_tests: "\u{1F9EA}",
      list_files: "\u{1F4C1}",
      read: "\u{1F4C4}",
      grep: "\u{1F50D}",
      glob: "\u{1F50D}",
      find_symbol: "\u{1F50E}",
      web_search: "\u{1F310}",
      fetch_url: "\u{1F310}",
      search_memory: "\u{1F9E0}",
      memory: "\u{1F9E0}",
      ask_user: "\u2753",
      explore: "\u{1F50D}",
      vision: "\u{1F5BC}",
      create_skill: "\u2699",
      create_mcp: "\u{1F50C}",
      load_skill: "\u{1F4D8}",
      load_plugin: "\u{1F4E6}",
      update_plan: "\u{1F4DD}",
      git_status: "\u{1F33F}",
      git_diff: "\u{1F4CA}",
      git_commit: "\u2705",
      git_log: "\u{1F558}",
      current_time: "\u{1F552}",
      system_stats: "\u{1F4CA}",
      computer: "\u{1F5A5}",
      search_console: "\u{1F50E}"
    };
    isSubagentCard = (a) => isDelegationTool(a.tool);
    EDIT_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
    isEditActivity = (a) => EDIT_TOOLS.has(a.tool);
  }
});

// src/components/toolcall/args.tsx
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
function fmtArgValue(v) {
  if (typeof v === "string") return fixZwsp(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(fmtArgValue).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function ToolArgs({
  args,
  tool
}) {
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(tool ?? "")];
  if (tool === "batch") return null;
  const entries = Object.entries(args).filter(
    ([k]) => !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k) && !skip?.has(k)
  );
  if (entries.length === 0) return null;
  return /* @__PURE__ */ jsx6("span", { className: "tool-args", dir: "ltr", children: entries.map(([k, v]) => /* @__PURE__ */ jsxs5("span", { className: "tool-arg", children: [
    /* @__PURE__ */ jsx6("span", { className: "tool-arg-key", children: k }),
    /* @__PURE__ */ jsx6("span", { className: "tool-arg-val", children: fmtArgValue(v) })
  ] }, k)) });
}
function rowDetail(activity) {
  const tool = canonicalTool(activity.tool);
  if (tool === "batch") return "";
  if (tool === "load_plugin") {
    const what = [activity.args?.slug, activity.args?.skill].filter((v) => typeof v === "string" && v.trim().length > 0).join(" / ");
    if (what) return shortArg(what, 60);
    const q = String(activity.args?.query ?? "");
    return q ? shortArg(q, 48) : "";
  }
  if (tool === "load_skill") {
    const name = String(activity.args?.name ?? activity.args?.file ?? "");
    if (name) return shortArg(name, 60);
  }
  return activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
}
var HEADER_SHOWN_KEYS, HIDDEN_KEYS, REDUNDANT_ARG_KEYS;
var init_args = __esm({
  "src/components/toolcall/args.tsx"() {
    "use strict";
    init_bidi();
    init_groups();
    init_naming();
    HEADER_SHOWN_KEYS = /* @__PURE__ */ new Set([
      "command",
      "path",
      "filePath",
      "offset",
      "limit",
      "start",
      "end",
      "query",
      "pattern",
      "description",
      "subagent_type",
      "prompt",
      "task_id",
      "text",
      "subject",
      "paths",
      "engine"
    ]);
    HIDDEN_KEYS = /* @__PURE__ */ new Set(["content", "old_string", "new_string"]);
    REDUNDANT_ARG_KEYS = {
      load_skill: /* @__PURE__ */ new Set(["name", "file", "query"]),
      load_plugin: /* @__PURE__ */ new Set(["slug", "skill", "file", "query"])
    };
  }
});

// src/components/toolcall/icons.tsx
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
function IconChevron({
  open,
  className
}) {
  return /* @__PURE__ */ jsx7(
    "svg",
    {
      className: `${className ?? ""} ${open ? "open" : ""}`,
      width: "22",
      height: "22",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: {
        transition: "transform 0.18s ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)"
      },
      children: /* @__PURE__ */ jsx7("path", { d: "M9 18l6-6-6-6" })
    }
  );
}
function IconCheck({ className }) {
  return /* @__PURE__ */ jsx7(
    "svg",
    {
      className,
      width: "14",
      height: "14",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx7("path", { d: "M20 6L9 17l-5-5" })
    }
  );
}
function IconX({ className }) {
  return /* @__PURE__ */ jsx7(
    "svg",
    {
      className,
      width: "14",
      height: "14",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx7("path", { d: "M18 6L6 18M6 6l12 12" })
    }
  );
}
function StatusIcon({ status }) {
  if (status === "running") return /* @__PURE__ */ jsx7("span", { className: "spinner" });
  if (status === "error") return /* @__PURE__ */ jsx7(IconX, { className: "status-err" });
  if (status === "denied") return /* @__PURE__ */ jsx7("span", { className: "status-denied", children: "\u23F9" });
  return /* @__PURE__ */ jsx7(IconCheck, { className: "status-ok" });
}
function TerminalRowIcon() {
  return /* @__PURE__ */ jsxs6(
    "svg",
    {
      className: "trace-row-term-icon",
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx7("path", { d: "M5 7l5 5-5 5" }),
        /* @__PURE__ */ jsx7("path", { d: "M13 17h6" })
      ]
    }
  );
}
var init_icons = __esm({
  "src/components/toolcall/icons.tsx"() {
    "use strict";
  }
});

// src/components/toolcall/editGroup.tsx
import { memo as memo2, useState as useState6 } from "react";
import { createPortal as createPortal2 } from "react-dom";
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
function groupSpanMs(acts, now) {
  let start = Infinity;
  let end = -Infinity;
  let summed = 0;
  for (const a of acts) {
    const own = a.status === "running" && a.startedAt ? Math.max(0, now - a.startedAt) : a.elapsedMs || 0;
    summed += own;
    if (!a.startedAt) continue;
    start = Math.min(start, a.startedAt);
    end = Math.max(end, a.startedAt + own);
  }
  return start === Infinity ? summed : Math.max(0, end - start);
}
function fmtTime(ms) {
  if (!ms) return "";
  if (ms < 1e3) return `${ms}ms`;
  const totalSec = ms / 1e3;
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}
var ToolEditGroupView;
var init_editGroup = __esm({
  "src/components/toolcall/editGroup.tsx"() {
    "use strict";
    init_api();
    init_fileTree();
    init_fs();
    init_reviewTurn();
    init_store();
    init_toolActivity();
    init_viewerTabs();
    init_diff();
    init_icons();
    init_naming();
    ToolEditGroupView = memo2(function ToolEditGroupView2({
      activities,
      messageId,
      chatId,
      onReverted
    }) {
      const [open, setOpen] = useState6(true);
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const [reverting, setReverting] = useState6(null);
      const preview = useDiffPreview();
      const running = activities.some((a) => a.activity.status === "running");
      const { adds, dels } = editGroupStats(activities);
      const now = useRunningClock(running);
      const totalMs = groupSpanMs(
        activities.map((a) => a.activity),
        now
      );
      const revertOne = async (entry) => {
        if (!root) return;
        setReverting(entry.index);
        try {
          const cid = chatId ?? activeChatId;
          if (entry.activity.checkpoint != null && cid) {
            const res = await restoreCheckpoint(cid, entry.activity.checkpoint, root);
            if (res.ok) {
              onReverted?.(entry.index);
              return;
            }
          }
          if (!entry.activity.diff) return;
          const path = reviewPathOf(entry.activity);
          if (!path) return;
          const revertDiff = entry.activity.diffs?.find((e) => e.path === path)?.diff ?? entry.activity.diff;
          const { content: current } = await api.fsRead(root, path) ?? {};
          const oldContent = applyReverseDiff(revertDiff, current ?? "");
          const ok = await api.fsWrite(root, path, oldContent);
          if (ok) onReverted?.(entry.index);
        } finally {
          setReverting(null);
        }
      };
      return /* @__PURE__ */ jsxs7("div", { className: `tool-edit-group ${open ? "open" : ""} ${running ? "running" : "done"}`, children: [
        /* @__PURE__ */ jsxs7("button", { className: "trace-head edit-group-head", onClick: () => setOpen((o) => !o), children: [
          /* @__PURE__ */ jsx8("span", { className: "edit-group-icon", "aria-hidden": "true", children: "\u270E" }),
          /* @__PURE__ */ jsx8("span", { className: "trace-head-pills", children: /* @__PURE__ */ jsxs7("span", { className: "trace-pill edit-group-pill", children: [
            activities.length,
            " file",
            activities.length === 1 ? "" : "s",
            " edited"
          ] }) }),
          /* @__PURE__ */ jsxs7("span", { className: "trace-head-right", children: [
            (adds > 0 || dels > 0) && /* @__PURE__ */ jsxs7("span", { className: "edit-group-stats", dir: "ltr", children: [
              /* @__PURE__ */ jsx8("span", { className: "review-count-add", children: `+${adds}` }),
              " ",
              /* @__PURE__ */ jsx8("span", { className: "review-count-del", children: `-${dels}` })
            ] }),
            totalMs > 0 && /* @__PURE__ */ jsx8("span", { className: "trace-time", children: fmtTime(totalMs) }),
            /* @__PURE__ */ jsx8(IconChevron, { open, className: "trace-chev" })
          ] })
        ] }),
        open && /* @__PURE__ */ jsx8("div", { className: "edit-group-list", children: activities.map((entry) => {
          const path = reviewPathOf(entry.activity);
          const base2 = path.split("/").pop() || path;
          const targets = editTargetsOf(entry.activity.args);
          const more = targets.length > 1 ? targets.length - 1 : 0;
          const st = entry.activity.diff ? entry.activity.diffStats ?? diffStatsFromUnified(entry.activity.diff) : null;
          const stats = st && (st.adds || st.dels) ? `+${st.adds} -${st.dels}` : null;
          return /* @__PURE__ */ jsx8(
            "div",
            {
              className: `edit-group-row ${entry.activity.status}${entry.activity.reverted ? " reverted" : ""}`,
              children: /* @__PURE__ */ jsxs7(
                "div",
                {
                  className: "edit-group-row-main",
                  role: "button",
                  tabIndex: 0,
                  title: path ? more ? targets.join("\n") : toWorkspacePath(root, path) : void 0,
                  onClick: () => messageId && openReview(messageId, path),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (messageId) openReview(messageId, path);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsx8(StatusIcon, { status: entry.activity.status }),
                    /* @__PURE__ */ jsx8("span", { className: "edit-group-file", dir: "auto", children: base2 }),
                    more > 0 && /* @__PURE__ */ jsxs7("span", { className: "tool-path tool-more", dir: "ltr", children: [
                      "+",
                      more,
                      " more"
                    ] }),
                    /* @__PURE__ */ jsxs7("span", { className: "edit-group-row-end", children: [
                      stats && /* @__PURE__ */ jsx8("span", { className: "trace-row-diff-stats", dir: "ltr", children: stats }),
                      entry.activity.reverted && /* @__PURE__ */ jsx8("span", { className: "reverted-tag", children: "reverted" }),
                      (() => {
                        const act = entry.activity;
                        const ms = act.status === "running" && act.startedAt ? Math.max(0, now - act.startedAt) : act.elapsedMs;
                        return ms ? /* @__PURE__ */ jsx8("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null;
                      })(),
                      entry.activity.diff && /* @__PURE__ */ jsx8(
                        "button",
                        {
                          type: "button",
                          className: "trace-row-review",
                          title: "Preview diff",
                          onClick: (e) => {
                            e.stopPropagation();
                            preview.open(
                              e.currentTarget.closest(".edit-group-row"),
                              entry.activity.diff,
                              reviewPathOf(entry.activity)
                            );
                          },
                          children: "Review \u2197"
                        }
                      )
                    ] })
                  ]
                }
              )
            },
            entry.index
          );
        }) }),
        preview.snap && typeof document !== "undefined" && createPortal2(
          /* @__PURE__ */ jsx8(
            DiffPreview,
            {
              diff: preview.snap.diff,
              path: preview.snap.path,
              pos: preview.snap.pos,
              onClose: preview.close,
              onPress: preview.keep
            }
          ),
          document.body
        )
      ] });
    });
  }
});

// src/components/toolcall/ioBlocks.tsx
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
function requestEntries(activity) {
  const args = activity.args;
  if (!args) return [];
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(activity.tool)];
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (HIDDEN_KEYS.has(k) || skip?.has(k)) continue;
    const text = fmtArgValue(v).trim();
    if (!text) continue;
    out.push([k, text]);
  }
  return out;
}
function IOBlock({
  title,
  children
}) {
  return /* @__PURE__ */ jsxs8("div", { className: "trace-io", children: [
    /* @__PURE__ */ jsx9("div", { className: "trace-io-head", children: title }),
    /* @__PURE__ */ jsx9("div", { className: "trace-io-body", children })
  ] });
}
function TraceRequestBlock({ activity }) {
  const entries = requestEntries(activity);
  if (entries.length === 0) return null;
  return /* @__PURE__ */ jsx9(IOBlock, { title: "Request", children: entries.map(([k, v]) => /* @__PURE__ */ jsxs8("div", { className: "trace-io-row", children: [
    /* @__PURE__ */ jsx9("span", { className: "trace-io-key", children: k }),
    /* @__PURE__ */ jsx9("span", { className: "trace-io-val", dir: "auto", children: fixZwsp(v) })
  ] }, k)) });
}
function TraceResponseBlock({ activity }) {
  if (canonicalTool(activity.tool) === "run_terminal") return null;
  const text = activity.resultText?.trim();
  if (!text) return null;
  return /* @__PURE__ */ jsx9(IOBlock, { title: "Response", children: /* @__PURE__ */ jsx9("pre", { className: "trace-io-pre", dir: "auto", children: fixZwsp(text) }) });
}
function TraceTextBlock({
  title,
  text,
  pre = true
}) {
  if (!text.trim()) return null;
  return /* @__PURE__ */ jsx9(IOBlock, { title, children: pre ? /* @__PURE__ */ jsx9("pre", { className: "trace-io-pre", dir: "auto", children: fixZwsp(text) }) : /* @__PURE__ */ jsx9("div", { className: "trace-io-val", dir: "auto", children: fixZwsp(text) }) });
}
var init_ioBlocks = __esm({
  "src/components/toolcall/ioBlocks.tsx"() {
    "use strict";
    init_bidi();
    init_args();
    init_naming();
  }
});

// src/lib/link.ts
function isExternalHref(href) {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}
function handleLinkClick(e, href, openExternal) {
  if (isExternalHref(href)) {
    e.preventDefault();
    openExternal(href);
    return true;
  }
  if (href && !href.startsWith("#") && !SCHEME_RE.test(href)) {
    e.preventDefault();
    return true;
  }
  return false;
}
function splitTextByUrls(raw) {
  if (!raw || raw.indexOf("http") === -1) return [raw];
  const parts = [];
  const re = new RegExp(URL_SPLIT_RE);
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let url = m[0];
    const trail = URL_TRAIL_RE.exec(url)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    if (!url) continue;
    const start = m.index;
    if (start > last) parts.push(raw.slice(last, start));
    parts.push({ url });
    last = start + url.length;
  }
  if (last < raw.length) parts.push(raw.slice(last));
  const nonEmpty = parts.filter((p) => typeof p !== "string" || p.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [raw];
}
var SCHEME_RE, URL_SPLIT_RE, URL_TRAIL_RE;
var init_link = __esm({
  "src/lib/link.ts"() {
    "use strict";
    SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
    URL_SPLIT_RE = /https?:\/\/[^\s<>"'`]+/gi;
    URL_TRAIL_RE = /[.,;:!?)\]}'"`]+$/;
  }
});

// src/lib/mediaUrl.ts
function codifaMediaPath(url) {
  if (!url) return null;
  const m = MEDIA_SCHEME_RE.exec(url.trim());
  return m ? m[1] : null;
}
function isMediaImagePath(path) {
  return IMAGE_EXT_RE.test(path);
}
function isMediaVideoPath(path) {
  return VIDEO_EXT_RE.test(path);
}
function mediaFileUrl(relPath, base2) {
  const b = (base2 ?? "").replace(/\/+$/, "");
  return `${b}/media/file?path=${encodeURIComponent(relPath)}`;
}
function resolveLocalMedia(src, base2) {
  if (!src) return null;
  const trimmed = src.trim();
  let path = codifaMediaPath(trimmed);
  if (!path && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("#") && !trimmed.startsWith("/")) {
    if (isMediaImagePath(trimmed) || isMediaVideoPath(trimmed)) path = trimmed;
  }
  if (!path) return null;
  if (!base2) return null;
  return {
    path,
    url: mediaFileUrl(path, base2),
    video: isMediaVideoPath(path)
  };
}
var MEDIA_SCHEME_RE, IMAGE_EXT_RE, VIDEO_EXT_RE;
var init_mediaUrl = __esm({
  "src/lib/mediaUrl.ts"() {
    "use strict";
    MEDIA_SCHEME_RE = /^codifa-media:\/\/(.+)$/i;
    IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
    VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
  }
});

// src/components/toolcall/results.tsx
import { memo as memo3, useEffect as useEffect8, useState as useState7 } from "react";
import { Fragment as Fragment3, jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function webProviderLabel(kind) {
  switch (kind) {
    case "duckduckgo":
      return "DuckDuckGo";
    case "tavily":
      return "Tavily";
    default:
      return kind;
  }
}
function isWebRow(activity) {
  return activity.tool === "web_search" || activity.tool === "fetch_url";
}
function resultRows(activity) {
  if (isSkillTool(activity.tool)) return [];
  const rows = activity.items ?? activity.results;
  return Array.isArray(rows) ? rows : [];
}
var InlineWebResults, WEB_RESULTS_VISIBLE, WebResultLinks, TerminalResultText, MEDIA_TOOLS, MediaResultLinks, FileResultLinks;
var init_results = __esm({
  "src/components/toolcall/results.tsx"() {
    "use strict";
    init_api();
    init_fileTypes();
    init_link();
    init_mediaUrl();
    init_toolActivity();
    init_viewerTabs();
    init_FileIcon();
    InlineWebResults = memo3(function InlineWebResults2({
      activity
    }) {
      const rows = activity.items ?? activity.results;
      if (!isWebRow(activity) || !rows || rows.length === 0) return null;
      return /* @__PURE__ */ jsx10("div", { className: "trace-row-inline-results", children: /* @__PURE__ */ jsx10(WebResultLinks, { items: rows }) });
    });
    WEB_RESULTS_VISIBLE = 3;
    WebResultLinks = memo3(function WebResultLinks2({
      items
    }) {
      const [showAll, setShowAll] = useState7(false);
      if (!items || items.length === 0) return null;
      const fetchInfo = items.filter((it) => typeof it.fetched === "boolean");
      const fetchedCount = fetchInfo.filter((it) => it.fetched).length;
      const visible = showAll ? items : items.slice(0, WEB_RESULTS_VISIBLE);
      const hidden = items.length - visible.length;
      return /* @__PURE__ */ jsxs9(Fragment3, { children: [
        fetchInfo.length > 0 && /* @__PURE__ */ jsxs9("div", { className: "web-results-head", dir: "auto", children: [
          /* @__PURE__ */ jsx10("span", { className: "web-results-count", children: `${items.length} result${items.length === 1 ? "" : "s"}` }),
          /* @__PURE__ */ jsx10("span", { className: "web-results-sep", "aria-hidden": "true", children: "\xB7" }),
          /* @__PURE__ */ jsx10(
            "span",
            {
              className: `web-results-fetched${fetchedCount === 0 ? " none" : ""}`,
              title: "Results whose real page content was fetched. The rest reached the model as a short snippet only.",
              children: `${fetchedCount} fetched`
            }
          )
        ] }),
        /* @__PURE__ */ jsx10("ul", { className: "web-results", dir: "auto", children: visible.map((it, i) => {
          const host = hostOf(it.url);
          return /* @__PURE__ */ jsx10("li", { className: "web-result", children: /* @__PURE__ */ jsxs9(
            "a",
            {
              className: "web-result-link",
              href: it.url,
              target: "_blank",
              rel: "noreferrer",
              title: it.url,
              onClick: (e) => {
                handleLinkClick(
                  e,
                  it.url,
                  (url) => void window.coder.openExternal(url)
                );
              },
              children: [
                /* @__PURE__ */ jsx10("span", { className: "web-result-favicon", "aria-hidden": "true", children: host ? /* @__PURE__ */ jsx10(
                  "img",
                  {
                    src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
                    alt: "",
                    loading: "lazy",
                    width: 16,
                    height: 16
                  }
                ) : /* @__PURE__ */ jsx10("span", { className: "web-result-glyph", children: "\u{1F517}" }) }),
                /* @__PURE__ */ jsxs9("span", { className: "web-result-text", children: [
                  /* @__PURE__ */ jsx10("span", { className: "web-result-title", children: it.title || it.url }),
                  it.snippet && /* @__PURE__ */ jsx10("span", { className: "web-result-snippet", children: it.snippet })
                ] }),
                it.fetched === false && /* @__PURE__ */ jsx10(
                  "span",
                  {
                    className: "web-result-fetched",
                    title: "This page could not be fetched \u2014 only the short search snippet reached the model.",
                    children: "snippet"
                  }
                ),
                /* @__PURE__ */ jsx10("span", { className: "web-result-host", children: host }),
                /* @__PURE__ */ jsx10("span", { className: "web-result-arrow", "aria-hidden": "true", children: "\u2197" })
              ]
            }
          ) }, i);
        }) }),
        hidden > 0 && /* @__PURE__ */ jsx10(
          "button",
          {
            type: "button",
            className: "web-result-more-btn",
            onClick: () => setShowAll(true),
            title: "Show every result",
            children: `+${hidden} more`
          }
        ),
        showAll && items.length > WEB_RESULTS_VISIBLE && /* @__PURE__ */ jsx10(
          "button",
          {
            type: "button",
            className: "web-result-more-btn",
            onClick: () => setShowAll(false),
            children: "Show less"
          }
        )
      ] });
    });
    TerminalResultText = function TerminalResultText2({
      items,
      fallbackText
    }) {
      const text = terminalOutputText(items) || fallbackText || "";
      if (!text) return null;
      return /* @__PURE__ */ jsx10(
        "pre",
        {
          className: "trace-expand-val trace-expand-pre trace-terminal-output",
          dir: "ltr",
          children: text
        }
      );
    };
    MEDIA_TOOLS = /* @__PURE__ */ new Set([
      "generate_image",
      "edit_image",
      "generate_video",
      "edit_video"
    ]);
    MediaResultLinks = memo3(function MediaResultLinks2({
      items
    }) {
      const [, forceTick] = useState7(0);
      useEffect8(() => {
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
      const rows = [];
      const seen = /* @__PURE__ */ new Set();
      for (const it of items) {
        const raw = String(it.path ?? it.file ?? codifaMediaPath(String(it.url ?? "")) ?? "").trim();
        if (!/\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v)$/i.test(raw)) continue;
        const path = raw.replace(/^\/+/, "");
        if (seen.has(path)) continue;
        seen.add(path);
        rows.push(path);
      }
      if (rows.length === 0) return null;
      const base2 = peekSidecarUrl();
      return /* @__PURE__ */ jsx10("div", { className: "media-results", children: rows.map((path, i) => {
        const resolved = resolveLocalMedia(`codifa-media://${path}`, base2);
        if (!resolved) return null;
        return resolved.video ? /* @__PURE__ */ jsx10(
          "video",
          {
            className: "media-result-video",
            src: resolved.url,
            controls: true,
            preload: "metadata",
            onClick: () => useViewerTabs.getState().openMedia(path)
          },
          path
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- generated media thumbnail
          /* @__PURE__ */ jsx10(
            "img",
            {
              className: "media-result-thumb",
              src: resolved.url,
              alt: path,
              title: `${path} \u2014 click to open in the Media editor`,
              loading: "lazy",
              onClick: () => useViewerTabs.getState().openMedia(path)
            },
            path
          )
        );
      }) });
    });
    FileResultLinks = memo3(function FileResultLinks2({
      tool,
      items
    }) {
      if (!items || items.length === 0) return null;
      const seen = /* @__PURE__ */ new Set();
      const deduped = [];
      for (const it of items) {
        const file = String(it.file ?? it.path ?? "");
        if (!file) continue;
        const line = it.line !== void 0 && it.line !== null ? String(it.line) : "";
        const text = String(it.text ?? "");
        const key = `${file}\0${line}\0${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(it);
      }
      if (deduped.length === 0) return null;
      const basenameCounts = /* @__PURE__ */ new Map();
      for (const it of deduped) {
        const base2 = fileBasename(String(it.file ?? it.path ?? "")).toLowerCase();
        basenameCounts.set(base2, (basenameCounts.get(base2) ?? 0) + 1);
      }
      return /* @__PURE__ */ jsx10("ul", { className: "file-results", dir: "ltr", "aria-label": `${tool} results`, children: deduped.map((it, i) => {
        const file = String(it.file ?? it.path ?? "");
        if (!file) return null;
        const line = it.line !== void 0 && it.line !== null ? String(it.line) : "";
        const text = String(it.text ?? "");
        const ambiguous = (basenameCounts.get(fileBasename(file).toLowerCase()) ?? 0) > 1;
        return /* @__PURE__ */ jsxs9("li", { className: "file-result", children: [
          /* @__PURE__ */ jsx10(
            FileChip,
            {
              path: file,
              line: line ? Number(line) : void 0,
              display: `${ambiguous ? file : fileBasename(file)}${line ? `:${line}` : ""}`
            }
          ),
          text && /* @__PURE__ */ jsx10("span", { className: "file-result-text", children: text })
        ] }, i);
      }) });
    });
  }
});

// src/components/toolcall/groups.tsx
import { Fragment as Fragment4, memo as memo4, useEffect as useEffect9, useLayoutEffect, useRef as useRef6, useState as useState8 } from "react";
import { createPortal as createPortal3 } from "react-dom";
import { Fragment as Fragment5, jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
function shortArg(s, max) {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}\u2026`;
}
function subArgSummary(activity) {
  const args = activity.args;
  if (!args) return "";
  const parts = [];
  if (activity.tool === "batch") return "";
  if (canonicalTool(activity.tool) === "load_plugin") {
    const what = [args.slug, args.skill].filter((v) => typeof v === "string" && v.trim().length > 0).join(" / ");
    if (what) return shortArg(what, 60);
    const q = String(args.query ?? "");
    return q ? shortArg(q, 48) : "";
  }
  if (canonicalTool(activity.tool) === "load_skill") {
    const skill = String(args.name ?? args.file ?? "");
    if (skill) return shortArg(skill, 60);
    const q = String(args.query ?? "");
    return q ? shortArg(q, 48) : "";
  }
  if (args.command !== void 0 && args.command !== "") {
    parts.push(shortArg(String(args.command), 80));
  }
  const path = String(args.filePath ?? editTargetOf(args) ?? "");
  if (path) {
    let p = path;
    const startRaw = args.offset ?? args.start;
    const limitRaw = args.limit;
    const st = Number(startRaw);
    const lm = Number(limitRaw);
    if (startRaw !== void 0 && startRaw !== "" && Number.isFinite(st) && st >= 0) {
      if (limitRaw !== void 0 && limitRaw !== "" && Number.isFinite(lm) && lm > 0) {
        p += `:${st}\u2013${st + lm - 1}`;
      } else {
        p += `:${st}`;
      }
    } else if (limitRaw !== void 0 && limitRaw !== "" && Number.isFinite(lm) && lm > 0) {
      p += `:1\u2013${lm}`;
    }
    const slash = p.lastIndexOf("/");
    parts.push(slash >= 0 ? p.slice(slash + 1) : p);
  }
  const pattern = String(args.pattern ?? args.query ?? "");
  if (pattern) parts.push(shortArg(pattern, 48));
  const description = String(args.description ?? "");
  if (description) parts.push(shortArg(description, 60));
  const memText = String(args.text ?? args.subject ?? "");
  if (memText) parts.push(shortArg(memText, 48));
  const url = String(args.url ?? "");
  if (url) parts.push(shortArg(url, 60));
  const engine = String(args.engine ?? "");
  if (engine) parts.push(engine);
  const rangesRaw = args.ranges;
  if (Array.isArray(rangesRaw) && rangesRaw.length > 0) {
    const rs = rangesRaw.map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object" && "path" in r) {
        const o = r;
        return [o.path, o.offset, o.limit].filter((v) => v != null).join(":");
      }
      return "";
    }).filter(Boolean);
    if (rs.length > 0) parts.push(rs.length > 2 ? `${rs.slice(0, 2).join(", ")} +${rs.length - 2} more` : rs.join(", "));
  } else if (typeof rangesRaw === "string" && rangesRaw) {
    parts.push(rangesRaw);
  } else {
    const listRaw = args.filePaths ?? args.paths;
    if (Array.isArray(listRaw) && listRaw.length > 0) {
      const ps = listRaw.map((p) => String(p)).filter(Boolean);
      if (ps.length > 0) parts.push(ps.length > 2 ? `${ps.slice(0, 2).join(", ")} +${ps.length - 2} more` : ps.join(", "));
    }
  }
  const covered = /* @__PURE__ */ new Set([
    "command",
    "path",
    "filePath",
    "filePaths",
    "paths",
    "ranges",
    "include",
    "includes",
    "offset",
    "limit",
    "start",
    "end",
    "query",
    "pattern",
    "description",
    "text",
    "subject",
    "url",
    "engine",
    "content",
    "old_string",
    "new_string",
    "prompt",
    "subagent_type",
    "task_id"
  ]);
  const rest = Object.entries(args).filter(([k]) => !covered.has(k)).map(([k, v]) => `${k}:${fmtArgValue(v)}`);
  if (rest.length > 0) parts.push(rest.join(" "));
  return parts.join(" \xB7 ");
}
function ToolPathSpan({ path }) {
  const open = (e) => {
    e.stopPropagation();
    openWorkspaceFile(path);
  };
  return /* @__PURE__ */ jsx11(
    "span",
    {
      className: "tool-path tool-path-open",
      dir: "ltr",
      role: "button",
      tabIndex: 0,
      title: `${path} \u2014 open in the side panel`,
      onClick: open,
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      },
      children: fileBasename(path)
    }
  );
}
function DownloadProgressBar({ progress }) {
  const pct = Math.max(0, Math.min(100, progress.percent));
  const meta = [];
  if (progress.received && progress.total) meta.push(`${progress.received} / ${progress.total}`);
  else if (progress.received) meta.push(progress.received);
  else if (progress.total) meta.push(progress.total);
  if (progress.speed) meta.push(progress.speed);
  if (progress.eta) meta.push(`eta ${progress.eta}`);
  return /* @__PURE__ */ jsxs10("div", { className: "tool-download-progress", role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100, children: [
    /* @__PURE__ */ jsx11("div", { className: "tool-download-progress-track", children: /* @__PURE__ */ jsx11("div", { className: "tool-download-progress-fill", style: { width: `${pct}%` } }) }),
    /* @__PURE__ */ jsxs10("div", { className: "tool-download-progress-meta", dir: "ltr", children: [
      /* @__PURE__ */ jsxs10("span", { className: "tool-download-progress-pct", children: [
        pct % 1 === 0 ? pct : pct.toFixed(1),
        "%"
      ] }),
      meta.length > 0 && /* @__PURE__ */ jsx11("span", { className: "tool-download-progress-detail", children: meta.join(" \xB7 ") })
    ] })
  ] });
}
var ToolGroupView, ToolSubRow, TraceRow, ToolTimelineRow, PREVIEW_COUNT, ToolCascade, TraceNarration, ToolSingleRow, LiveTerminalTail;
var init_groups = __esm({
  "src/components/toolcall/groups.tsx"() {
    "use strict";
    init_bidi();
    init_fileTypes();
    init_reviewTurn();
    init_toolActivity();
    init_viewerTabs();
    init_store();
    init_FileIcon();
    init_args();
    init_diff();
    init_editGroup();
    init_icons();
    init_ioBlocks();
    init_naming();
    init_results();
    ToolGroupView = memo4(function ToolGroupView2({
      activities,
      captions,
      subagent
    }) {
      const [open, setOpen] = useState8(false);
      const subagentRows = useStore((s) => s.customSubagents);
      const subagentRunning = subagent?.status === "running";
      const running = activities.some((a) => a.activity.status === "running") || subagentRunning;
      const subagentName = subagent ? subagentDisplayName(subagent.tool, subagentRows) : null;
      const subagentDesc = subagent ? shortArg(String(subagent.args?.description ?? ""), 70) : "";
      const subagentCaption = subagent ? latestNarrationLine(subagent) || subagentDesc : void 0;
      const headCaption = (() => {
        for (let i = (captions?.length ?? 0) - 1; i >= 0; i--) {
          if (captions?.[i]) return captions[i];
        }
        return subagentCaption;
      })();
      const now = useRunningClock(running);
      const ms = groupSpanMs(
        [...subagent ? [subagent] : [], ...activities.map((a) => a.activity)],
        now
      );
      const headText = prepareContent(
        headCaption || subagentName || activityLabel(activities[0].activity) || ""
      );
      const subagentParts = subagent?.narrationParts ?? [];
      return /* @__PURE__ */ jsxs10(
        "div",
        {
          className: `tool-group ${open ? "open" : ""} ${running ? "running" : "done"}`,
          children: [
            /* @__PURE__ */ jsxs10(
              "button",
              {
                className: `trace-head ${open ? "open" : ""}`,
                onClick: () => setOpen((o) => !o),
                "aria-expanded": open,
                children: [
                  running && /* @__PURE__ */ jsxs10("span", { className: "trace-head-dots", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx11("i", {}),
                    /* @__PURE__ */ jsx11("i", {}),
                    /* @__PURE__ */ jsx11("i", {})
                  ] }),
                  /* @__PURE__ */ jsx11("span", { className: "trace-head-text", dir: "auto", title: headText, children: headText }),
                  ms ? /* @__PURE__ */ jsx11("span", { className: "trace-head-ms", children: fmtTime(ms) }) : null,
                  /* @__PURE__ */ jsx11(IconChevron, { open, className: "trace-chev" })
                ]
              }
            ),
            open && /* @__PURE__ */ jsxs10("div", { className: "trace-body", children: [
              activities.map(({ activity, index }, i) => /* @__PURE__ */ jsxs10(Fragment4, { children: [
                subagentParts.filter((p) => p.after === i).map((p, pi) => /* @__PURE__ */ jsx11(TraceNarration, { text: p.text }, `sn-${i}-${pi}`)),
                captions?.[i] && /* @__PURE__ */ jsx11(TraceNarration, { text: captions[i] }),
                /* @__PURE__ */ jsx11(TraceRow, { activity })
              ] }, index)),
              subagentParts.filter((p) => p.after >= activities.length).map((p, pi) => /* @__PURE__ */ jsx11(TraceNarration, { text: p.text }, `se-${pi}`))
            ] })
          ]
        }
      );
    });
    ToolSubRow = memo4(function ToolSubRow2({
      activity,
      hideResult
    }) {
      const [now, setNow] = useState8(() => Date.now());
      const running = activity.status === "running";
      useEffect9(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const subagentRows = useStore((s) => s.customSubagents);
      const subSummary = subArgSummary(activity);
      return /* @__PURE__ */ jsxs10(Fragment5, { children: [
        /* @__PURE__ */ jsxs10(
          "div",
          {
            className: `tool-sub-row ${activity.status}${running ? " running" : ""}`,
            children: [
              /* @__PURE__ */ jsx11(StatusIcon, { status: activity.status }),
              /* @__PURE__ */ jsx11("span", { className: "tool-sub-name", children: isSubagentCard(activity) ? subagentDisplayName(activity.tool, subagentRows) : activityLabel(activity) }),
              /* @__PURE__ */ jsx11("span", { className: "tool-sub-args", title: subSummary, children: subSummary }),
              activity.summary && !isSkillTool(activity.tool) && /* @__PURE__ */ jsx11("span", { className: "tool-sub-summary", children: fixZwsp(activity.summary) }),
              /* @__PURE__ */ jsx11("span", { className: "tool-ms", children: fmtTime(ms) })
            ]
          }
        ),
        activity.resultText && !hideResult && /* @__PURE__ */ jsx11("pre", { className: "tool-sub-result", dir: "auto", children: activity.resultText })
      ] });
    });
    TraceRow = memo4(function TraceRow2({
      activity
    }) {
      const [now, setNow] = useState8(() => Date.now());
      const [expanded, setExpanded] = useState8(
        () => activity.tool === "edit_file" || activity.tool === "write_file"
      );
      const running = activity.status === "running";
      useEffect9(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const subagentRows = useStore((s) => s.customSubagents);
      const label = isSubagentCard(activity) ? subagentDisplayName(activity.tool, subagentRows) : activityLabel(activity);
      const detail = rowDetail(activity);
      const isEdit = activity.tool === "edit_file" || activity.tool === "write_file";
      const onHeadClick = () => setExpanded((e) => !e);
      return /* @__PURE__ */ jsxs10(
        "div",
        {
          className: `trace-row ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs10(
              "button",
              {
                className: "trace-row-head",
                onClick: onHeadClick,
                children: [
                  /* @__PURE__ */ jsx11("span", { className: "trace-row-bullet", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx11("span", { className: "spinner" }) : activity.tool === "run_terminal" ? /* @__PURE__ */ jsx11(TerminalRowIcon, {}) : "\u2022" }),
                  /* @__PURE__ */ jsx11("span", { className: "trace-pill", children: label }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx11("span", { className: "trace-row-engine", title: "Web search provider", children: webProviderLabel(activity.engine) }),
                  /* @__PURE__ */ jsx11("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  /* @__PURE__ */ jsxs10("span", { className: "trace-row-end", children: [
                    ms ? /* @__PURE__ */ jsx11("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx11(StatusIcon, { status: activity.status }),
                    /* @__PURE__ */ jsx11(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded && /* @__PURE__ */ jsxs10("div", { className: "trace-row-expand", children: [
              /* @__PURE__ */ jsx11(TraceRequestBlock, { activity }),
              activity.summary && !isSkillTool(activity.tool) && /* @__PURE__ */ jsx11(
                TraceTextBlock,
                {
                  title: "Summary",
                  text: activity.summary,
                  pre: false
                }
              ),
              activity.diff && /* @__PURE__ */ jsx11(TraceTextBlock, { title: "Diff", text: activity.diff }),
              /* @__PURE__ */ jsx11(TraceResponseBlock, { activity }),
              isWebRow(activity) && /* @__PURE__ */ jsx11(InlineWebResults, { activity }),
              !isWebRow(activity) && !(activity.resultText && canonicalTool(activity.tool) !== "run_terminal") && (resultRows(activity).length > 0 || activity.tool === "run_terminal" && Boolean(activity.resultText)) && /* @__PURE__ */ jsxs10("div", { className: "trace-io", children: [
                /* @__PURE__ */ jsx11("div", { className: "trace-io-head", children: "Response" }),
                /* @__PURE__ */ jsx11("div", { className: "trace-io-body", children: activity.tool === "run_terminal" ? /* @__PURE__ */ jsx11(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                ) : MEDIA_TOOLS.has(activity.tool) ? (
                  // Generated media renders as REAL thumbnails/playables here —
                  // FileResultLinks' icon+name rows hid the picture entirely.
                  /* @__PURE__ */ jsx11(MediaResultLinks, { items: resultRows(activity) })
                ) : /* @__PURE__ */ jsx11(
                  FileResultLinks,
                  {
                    tool: activity.tool,
                    items: resultRows(activity)
                  }
                ) })
              ] })
            ] })
          ]
        }
      );
    });
    ToolTimelineRow = memo4(function ToolTimelineRow2({
      activity
    }) {
      const [now, setNow] = useState8(() => Date.now());
      const running = activity.status === "running";
      useEffect9(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const detail = subArgSummary(activity);
      return /* @__PURE__ */ jsxs10("div", { className: `tool-timeline-item ${activity.status}`, children: [
        /* @__PURE__ */ jsx11("span", { className: "tool-timeline-icon", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx11("span", { className: "spinner" }) : toolIcon(activity.tool) }),
        /* @__PURE__ */ jsx11("span", { className: "tool-timeline-label", children: activityLabel(activity) }),
        detail && /* @__PURE__ */ jsx11("span", { className: "tool-timeline-detail", title: detail, children: detail }),
        /* @__PURE__ */ jsx11(StatusIcon, { status: activity.status }),
        /* @__PURE__ */ jsx11("span", { className: "tool-ms", children: fmtTime(ms) }),
        resultRows(activity).length > 0 && (MEDIA_TOOLS.has(activity.tool) ? /* @__PURE__ */ jsx11(MediaResultLinks, { items: resultRows(activity) }) : activity.tool === "web_search" || activity.tool === "fetch_url" ? /* @__PURE__ */ jsx11(WebResultLinks, { items: activity.items ?? activity.results }) : /* @__PURE__ */ jsx11(FileResultLinks, { tool: activity.tool, items: resultRows(activity) }))
      ] });
    });
    PREVIEW_COUNT = 3;
    ToolCascade = memo4(function ToolCascade2({
      activities
    }) {
      const last = activities.slice(-PREVIEW_COUNT);
      const listRef = useRef6(null);
      const prevTops = useRef6(/* @__PURE__ */ new Map());
      const firstRun = useRef6(true);
      useLayoutEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const items = Array.from(el.children);
        const nextTops = /* @__PURE__ */ new Map();
        const glide = "transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease";
        for (const item of items) {
          const key = item.dataset.key ?? "";
          const next = item.offsetTop;
          const prev = prevTops.current.get(key);
          if (firstRun.current) {
            nextTops.set(key, next);
            continue;
          }
          if (prev === void 0) {
            item.style.transition = "none";
            item.style.transform = "translateY(14px)";
            item.style.opacity = "0";
            void item.offsetHeight;
            item.style.transition = glide;
            item.style.transform = "";
            item.style.opacity = "";
          } else if (prev !== next) {
            item.style.transition = "none";
            item.style.transform = `translateY(${prev - next}px)`;
            void item.offsetHeight;
            item.style.transition = glide;
            item.style.transform = "";
          }
          nextTops.set(key, next);
        }
        prevTops.current = nextTops;
        firstRun.current = false;
      }, [last]);
      return /* @__PURE__ */ jsx11("div", { className: "tool-cascade", ref: listRef, children: last.map((a, i) => /* @__PURE__ */ jsx11(
        "div",
        {
          "data-key": a.callId ?? `${a.tool}-${i}`,
          className: "tool-cascade-item",
          style: { zIndex: i + 1 },
          children: /* @__PURE__ */ jsx11(ToolSubRow, { activity: a, hideResult: true })
        },
        a.callId ?? `${a.tool}-${i}`
      )) });
    });
    TraceNarration = memo4(function TraceNarration2({
      text
    }) {
      return /* @__PURE__ */ jsx11("div", { className: "trace-narration", dir: "auto", children: prepareContent(text) });
    });
    ToolSingleRow = memo4(function ToolSingleRow2({
      activity,
      messageId
    }) {
      const [now, setNow] = useState8(() => Date.now());
      const [expanded, setExpanded] = useState8(false);
      const preview = useDiffPreview();
      const running = activity.status === "running";
      useEffect9(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const subagentRows = useStore((s) => s.customSubagents);
      const label = isSubagentCard(activity) ? subagentDisplayName(activity.tool, subagentRows) : activityLabel(activity);
      const detail = rowDetail(activity);
      const isEdit = activity.tool === "edit_file" || activity.tool === "write_file";
      const openReview = useViewerTabs((s) => s.openReview);
      const onHeadClick = () => {
        if (isEdit) {
          if (messageId) openReview(messageId, reviewPathOf(activity));
          return;
        }
        setExpanded((e) => !e);
      };
      const diffStats = (() => {
        if (!activity.diff) return null;
        const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
        return s.adds || s.dels ? `+${s.adds} -${s.dels}` : null;
      })();
      return /* @__PURE__ */ jsxs10(
        "div",
        {
          className: `trace-row single ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs10(
              "div",
              {
                className: "trace-row-head",
                role: "button",
                tabIndex: 0,
                onClick: onHeadClick,
                title: isEdit ? "Review changes in the side panel" : void 0,
                onKeyDown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onHeadClick();
                  }
                },
                children: [
                  /* @__PURE__ */ jsx11(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx11("span", { className: "trace-pill", children: label }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx11("span", { className: "trace-row-engine", title: "Web search provider", children: webProviderLabel(activity.engine) }),
                  isEdit ? /* @__PURE__ */ jsx11(
                    "span",
                    {
                      className: "trace-row-detail",
                      dir: "auto",
                      title: reviewPathOf(activity),
                      children: reviewPathOf(activity).split("/").pop()
                    }
                  ) : /* @__PURE__ */ jsx11("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  /* @__PURE__ */ jsxs10("span", { className: "trace-row-end", children: [
                    isEdit && diffStats && /* @__PURE__ */ jsx11("span", { className: "trace-row-diff-stats", children: diffStats }),
                    isEdit && activity.diff && /* @__PURE__ */ jsx11(
                      "button",
                      {
                        type: "button",
                        className: "trace-row-review",
                        title: "Preview diff",
                        onClick: (e) => {
                          e.stopPropagation();
                          preview.open(
                            e.currentTarget.closest(".trace-row.single"),
                            activity.diff,
                            reviewPathOf(activity)
                          );
                        },
                        children: "Review \u2197"
                      }
                    ),
                    ms ? /* @__PURE__ */ jsx11("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx11(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded ? /* @__PURE__ */ jsxs10("div", { className: "trace-row-expand", children: [
              /* @__PURE__ */ jsx11(TraceRequestBlock, { activity }),
              activity.summary && !isSkillTool(activity.tool) && /* @__PURE__ */ jsx11(
                TraceTextBlock,
                {
                  title: "Summary",
                  text: activity.summary,
                  pre: false
                }
              ),
              activity.diff && /* @__PURE__ */ jsx11(TraceTextBlock, { title: "Diff", text: activity.diff }),
              /* @__PURE__ */ jsx11(TraceResponseBlock, { activity }),
              isWebRow(activity) && /* @__PURE__ */ jsx11(InlineWebResults, { activity }),
              !isWebRow(activity) && !(activity.resultText && canonicalTool(activity.tool) !== "run_terminal") && (resultRows(activity).length > 0 || activity.tool === "run_terminal" && Boolean(activity.resultText)) && /* @__PURE__ */ jsxs10("div", { className: "trace-io", children: [
                /* @__PURE__ */ jsx11("div", { className: "trace-io-head", children: "Response" }),
                /* @__PURE__ */ jsx11("div", { className: "trace-io-body", children: activity.tool === "run_terminal" ? /* @__PURE__ */ jsx11(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                ) : MEDIA_TOOLS.has(activity.tool) ? (
                  // Generated media renders as REAL thumbnails/playables here —
                  // FileResultLinks' icon+name rows hid the picture entirely.
                  /* @__PURE__ */ jsx11(MediaResultLinks, { items: resultRows(activity) })
                ) : /* @__PURE__ */ jsx11(
                  FileResultLinks,
                  {
                    tool: activity.tool,
                    items: resultRows(activity)
                  }
                ) })
              ] })
            ] }) : null,
            preview.snap && typeof document !== "undefined" && createPortal3(
              /* @__PURE__ */ jsx11(
                DiffPreview,
                {
                  diff: preview.snap.diff,
                  path: preview.snap.path,
                  pos: preview.snap.pos,
                  onClose: preview.close,
                  onPress: preview.keep
                }
              ),
              document.body
            )
          ]
        }
      );
    });
    LiveTerminalTail = function LiveTerminalTail2({ tail }) {
      const ref = useRef6(null);
      useEffect9(() => {
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [tail]);
      return /* @__PURE__ */ jsx11(
        "pre",
        {
          ref,
          className: "trace-expand-val trace-expand-pre trace-terminal-output tool-live-output",
          dir: "auto",
          children: tail
        }
      );
    };
  }
});

// src/components/ToolCallView.tsx
import {
  memo as memo5,
  useState as useState9,
  useMemo as useMemo3
} from "react";
import { createPortal as createPortal4 } from "react-dom";
import { Fragment as Fragment7, jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
var ToolCallView;
var init_ToolCallView = __esm({
  "src/components/ToolCallView.tsx"() {
    "use strict";
    init_store();
    init_toolActivity();
    init_downloadProgress();
    init_reviewTurn();
    init_viewerTabs();
    init_fs();
    init_api();
    init_bidi();
    init_diff();
    init_diff();
    init_diff();
    init_diff();
    init_groups();
    init_naming();
    init_results();
    init_args();
    init_args();
    init_icons();
    init_icons();
    init_editGroup();
    init_icons();
    init_results();
    init_groups();
    init_results();
    init_results();
    init_groups();
    init_args();
    init_icons();
    init_naming();
    init_naming();
    init_naming();
    init_naming();
    init_naming();
    init_results();
    init_icons();
    init_diff();
    init_args();
    init_groups();
    init_editGroup();
    init_groups();
    init_groups();
    init_groups();
    init_groups();
    init_groups();
    init_groups();
    init_groups();
    init_results();
    init_results();
    init_diff();
    init_args();
    init_naming();
    init_diff();
    init_naming();
    init_naming();
    init_args();
    init_editGroup();
    init_naming();
    init_diff();
    init_results();
    init_naming();
    init_naming();
    init_naming();
    init_results();
    init_diff();
    init_naming();
    init_results();
    init_args();
    init_naming();
    init_groups();
    init_diff();
    init_groups();
    init_naming();
    init_naming();
    init_naming();
    init_naming();
    init_diff();
    init_naming();
    init_results();
    init_args();
    init_diff();
    init_editGroup();
    init_groups();
    init_icons();
    init_naming();
    init_results();
    ToolCallView = memo5(function ToolCallView2({
      activity,
      chatId,
      messageId,
      onReverted
    }) {
      const [reverting, setReverting] = useState9(false);
      const preview = useDiffPreview();
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const subagentRows = useStore((s) => s.customSubagents);
      const [collapsed, setCollapsed] = useState9(isSubagentCard(activity));
      const collapsible = isSubagentCard(activity) && ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary)) || activity.tool === "run_terminal";
      const toolRunning = activity.status === "running" || (activity.children?.some((c2) => c2.status === "running") ?? false);
      const now = useRunningClock(toolRunning);
      const ms = activity.status === "running" && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const isWrite = activity.tool === "write_file" || activity.tool === "edit_file";
      const writePath = reviewPathOf(activity);
      const writeTargets = isWrite ? editTargetsOf(activity.args) : [];
      const writeMore = writeTargets.length > 1 ? writeTargets.length - 1 : 0;
      const readPaths = Array.isArray(activity.args?.ranges) ? activity.args.ranges.map((r) => typeof r?.path === "string" ? r.path : "").filter(Boolean) : Array.isArray(activity.args?.paths) ? activity.args.paths : [];
      const fetchSummary = activity.tool === "fetch_url" ? activity.summary : "";
      const liveProgress = useMemo3(
        () => activity.status === "running" && activity.tool === "run_terminal" && activity.liveTail ? parseDownloadProgress(activity.liveTail) : null,
        [activity.status, activity.tool, activity.liveTail]
      );
      const skillName = isSkillTool(activity.tool) ? String(
        activity.args?.slug ?? activity.args?.skill ?? activity.args?.name ?? activity.args?.file ?? activity.args?.query ?? ""
      ) : "";
      const revert = async () => {
        if (!root) return;
        setReverting(true);
        try {
          const cid = chatId ?? activeChatId;
          if (activity.checkpoint != null && cid) {
            const res = await restoreCheckpoint(cid, activity.checkpoint, root);
            if (res.ok) {
              onReverted?.();
              return;
            }
          }
          if (!activity.diff) return;
          const path = String(activity.args?.filePath ?? editTargetOf(activity.args) ?? "");
          const revertDiff = activity.diffs?.find((e) => e.path === path)?.diff ?? activity.diff;
          const { content: current } = await api.fsRead(root, path) ?? {};
          const oldContent = applyReverseDiff(revertDiff, current ?? "");
          const ok = await api.fsWrite(root, path, oldContent);
          if (ok) onReverted?.();
        } finally {
          setReverting(false);
        }
      };
      return /* @__PURE__ */ jsxs11(
        "div",
        {
          className: `tool-card ${activity.status}${isSubagentCard(activity) ? " explore" : ""}`,
          children: [
            /* @__PURE__ */ jsxs11(
              "div",
              {
                className: `tool-card-head${collapsible ? " collapsible" : ""}${isWrite ? " write-head" : ""}`,
                onClick: isWrite ? () => messageId && openReview(messageId, writePath) : collapsible ? () => setCollapsed((c2) => !c2) : void 0,
                role: isWrite || collapsible ? "button" : void 0,
                tabIndex: isWrite || collapsible ? 0 : void 0,
                "aria-expanded": collapsible ? !collapsed : void 0,
                title: isWrite ? "Review changes in the side panel" : activity.tool === "run_terminal" ? "Toggle command output" : void 0,
                onKeyDown: isWrite || collapsible ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isWrite) {
                      if (messageId) openReview(messageId, writePath);
                    } else {
                      setCollapsed((c2) => !c2);
                    }
                  }
                } : void 0,
                children: [
                  /* @__PURE__ */ jsx12(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx12("span", { className: "tool-name", children: isWrite ? /* @__PURE__ */ jsxs11(Fragment7, { children: [
                    /* @__PURE__ */ jsx12("span", { className: "tool-verb", children: activity.tool === "write_file" ? "Wrote" : "Edited" }),
                    /* @__PURE__ */ jsx12(
                      "span",
                      {
                        className: "tool-file",
                        title: writeMore ? writeTargets.join("\n") : writePath,
                        children: /* @__PURE__ */ jsx12("span", { className: "tool-file-name", dir: "ltr", children: writePath.split("/").pop() ?? writePath })
                      }
                    ),
                    writeMore > 0 && /* @__PURE__ */ jsxs11("span", { className: "tool-path tool-more", dir: "ltr", children: [
                      "+",
                      writeMore,
                      " more"
                    ] })
                  ] }) : isSubagentCard(activity) ? subagentDisplayName(activity.tool, subagentRows) : (
                    // A batch is named after the tools it ran, never "batch" itself.
                    activityLabel(activity)
                  ) }),
                  skillName && /* @__PURE__ */ jsx12("span", { className: "tool-skill", title: `Skill: ${skillName}`, dir: "ltr", children: skillName }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx12("span", { className: "tool-badge tool-engine-badge", children: activity.engine }),
                  activity.args && activity.args.command !== void 0 && /* @__PURE__ */ jsx12("span", { className: "tool-cmd", title: String(activity.args.command), children: String(activity.args.command) }),
                  activity.args && activity.args.path !== void 0 && !isWrite && /* @__PURE__ */ jsx12(ToolPathSpan, { path: String(activity.args.path) }),
                  activity.args && activity.args.filePath !== void 0 && !isWrite && /* @__PURE__ */ jsx12(ToolPathSpan, { path: String(activity.args.filePath) }),
                  activity.args && activity.args.filePath !== void 0 && (String(activity.args.offset ?? 1) !== "1" || Number(activity.args.limit ?? 2e3) < 2e3) && /* @__PURE__ */ jsx12("span", { className: "tool-path", children: `${activity.args.offset ?? 1}\u2013${Number(activity.args.offset ?? 1) + Number(activity.args.limit ?? 2e3) - 1}` }),
                  activity.args && activity.args.start !== void 0 && /* @__PURE__ */ jsxs11("span", { className: "tool-path", children: [
                    String(activity.args.start),
                    activity.args.end !== void 0 && activity.args.end !== -1 ? `\u2013${String(activity.args.end)}` : "+"
                  ] }),
                  activity.args && activity.args.query !== void 0 && /* @__PURE__ */ jsx12(
                    "span",
                    {
                      className: "tool-cmd",
                      title: fixZwsp(String(activity.args.query)),
                      children: fixZwsp(String(activity.args.query))
                    }
                  ),
                  activity.args && activity.args.pattern !== void 0 && /* @__PURE__ */ jsx12(
                    "span",
                    {
                      className: "tool-cmd",
                      title: fixZwsp(String(activity.args.pattern)),
                      children: fixZwsp(String(activity.args.pattern))
                    }
                  ),
                  activity.args && activity.args.description !== void 0 && /* @__PURE__ */ jsx12(
                    "span",
                    {
                      className: "tool-cmd tool-task",
                      title: String(activity.args.description),
                      children: fixZwsp(
                        String(activity.args.description).length > 120 ? `${String(activity.args.description).slice(0, 120)}\u2026` : String(activity.args.description)
                      )
                    }
                  ),
                  isSubagentCard(activity) && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsxs11("span", { className: "tool-badge tool-sub-count", children: [
                    activity.children.length,
                    " call",
                    activity.children.length === 1 ? "" : "s"
                  ] }),
                  activity.tool === "memory" && activity.args && /* @__PURE__ */ jsx12("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.text || activity.args.subject || "")) }),
                  readPaths.length > 0 && /* @__PURE__ */ jsxs11(Fragment7, { children: [
                    readPaths.slice(0, 2).map((p, i) => /* @__PURE__ */ jsx12(ToolPathSpan, { path: p }, i)),
                    readPaths.length > 2 && /* @__PURE__ */ jsxs11("span", { className: "tool-path tool-more", children: [
                      "+",
                      readPaths.length - 2,
                      " more"
                    ] })
                  ] }),
                  fetchSummary && /* @__PURE__ */ jsx12("span", { className: "tool-cmd", children: fixZwsp(fetchSummary) }),
                  activity.args && !isSubagentCard(activity) && /* @__PURE__ */ jsx12(ToolArgs, { args: activity.args, tool: activity.tool }),
                  /* @__PURE__ */ jsxs11("span", { className: "tool-card-head-end", children: [
                    liveProgress && /* @__PURE__ */ jsxs11("span", { className: "tool-progress-chip", dir: "ltr", children: [
                      "\u21E3 ",
                      liveProgress.percent % 1 === 0 ? liveProgress.percent : liveProgress.percent.toFixed(1),
                      "%"
                    ] }),
                    ms ? /* @__PURE__ */ jsx12("span", { className: "tool-ms", children: fmtTime(ms) }) : null,
                    isWrite && activity.diff && (() => {
                      const s = activity.diffStats ?? {
                        adds: (activity.diff.match(/^\+[^+]/gm) || []).length,
                        dels: (activity.diff.match(/^-[^-]/gm) || []).length
                      };
                      return s.adds + s.dels > 0 ? /* @__PURE__ */ jsxs11("span", { className: "tool-diff-stats", children: [
                        /* @__PURE__ */ jsxs11("span", { className: "review-count-add", children: [
                          "+",
                          s.adds
                        ] }),
                        " ",
                        /* @__PURE__ */ jsxs11("span", { className: "review-count-del", children: [
                          "-",
                          s.dels
                        ] })
                      ] }) : null;
                    })(),
                    isWrite && activity.diff && /* @__PURE__ */ jsx12(
                      "button",
                      {
                        className: "tool-review-btn",
                        title: "Preview diff",
                        onClick: (e) => {
                          e.stopPropagation();
                          preview.open(
                            e.currentTarget.closest(".tool-card"),
                            activity.diff,
                            writePath
                          );
                        },
                        children: "Review \u2197"
                      }
                    ),
                    isWrite && activity.reverted && /* @__PURE__ */ jsx12("span", { className: "reverted-tag", children: "reverted" }),
                    collapsible && /* @__PURE__ */ jsx12("span", { className: `chev${collapsed ? "" : " open"}`, children: "\u25BE" })
                  ] })
                ]
              }
            ),
            collapsed && isSubagentCard(activity) && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx12(ToolCascade, { activities: activity.children }),
            !collapsed && !isWrite && /* @__PURE__ */ jsxs11("div", { className: "tool-card-body", children: [
              activity.summary && !isWrite && activity.tool !== "batch" && !isSkillTool(activity.tool) && /* @__PURE__ */ jsx12("div", { className: "tool-summary", children: fixZwsp(activity.summary) }),
              activity.tool === "read" && activity.resultText && /* @__PURE__ */ jsx12(
                "pre",
                {
                  className: "trace-expand-val trace-expand-pre trace-terminal-output",
                  dir: "ltr",
                  children: activity.resultText
                }
              ),
              isSkillTool(activity.tool) && activity.resultText && /* @__PURE__ */ jsx12(
                "pre",
                {
                  className: "trace-expand-val trace-expand-pre trace-terminal-output",
                  dir: "auto",
                  children: activity.resultText
                }
              ),
              isSubagentCard(activity) && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx12("div", { className: "tool-sub-list", children: activity.children.map((child, i) => /* @__PURE__ */ jsx12(
                ToolSubRow,
                {
                  activity: child,
                  hideResult: child.tool === "read"
                },
                `${child.tool}-${i}-${child.callId ?? i}`
              )) }),
              (activity.tool === "web_search" || activity.tool === "fetch_url") && (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsx12(WebResultLinks, { items: activity.items ?? activity.results }),
              MEDIA_TOOLS.has(activity.tool) && resultRows(activity).length > 0 && /* @__PURE__ */ jsx12(MediaResultLinks, { items: resultRows(activity) }),
              MEMORY_TOOLS.has(activity.tool) && activity.resultText && /* @__PURE__ */ jsx12(
                "pre",
                {
                  className: "trace-expand-val trace-expand-pre trace-terminal-output",
                  dir: "auto",
                  children: activity.resultText
                }
              ),
              activity.tool === "run_terminal" && activity.status === "running" && activity.liveTail && /* @__PURE__ */ jsxs11(Fragment7, { children: [
                liveProgress && /* @__PURE__ */ jsx12(DownloadProgressBar, { progress: liveProgress }),
                /* @__PURE__ */ jsx12("span", { className: "trace-expand-key", children: "Live output" }),
                /* @__PURE__ */ jsx12(LiveTerminalTail, { tail: activity.liveTail })
              ] }),
              activity.tool === "run_terminal" && (((activity.items ?? activity.results)?.length ?? 0) > 0 || Boolean(activity.resultText)) && /* @__PURE__ */ jsxs11(Fragment7, { children: [
                /* @__PURE__ */ jsx12("span", { className: "trace-expand-key", children: "Output" }),
                /* @__PURE__ */ jsx12(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                )
              ] }),
              activity.diff && /* @__PURE__ */ jsx12(
                DiffView,
                {
                  diff: activity.diff,
                  path: reviewPathOf(activity)
                }
              )
            ] }),
            preview.snap && typeof document !== "undefined" && createPortal4(
              /* @__PURE__ */ jsx12(
                DiffPreview,
                {
                  diff: preview.snap.diff,
                  path: preview.snap.path,
                  pos: preview.snap.pos,
                  onClose: preview.close,
                  onPress: preview.keep
                }
              ),
              document.body
            )
          ]
        }
      );
    });
  }
});

// src/lib/askUser.ts
function toggleSelected(prev, index, max = Infinity) {
  const set = new Set(prev);
  if (set.has(index)) {
    set.delete(index);
  } else {
    if (!(prev.length < max)) return prev;
    set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}
function joinAnswer(options, selected, freeText) {
  const parts = [];
  for (const index of selected) {
    const label = options[index];
    if (typeof label === "string" && label.trim().length > 0) parts.push(label.trim());
  }
  const trimmedFree = freeText.trim();
  if (trimmedFree.length > 0) parts.push(trimmedFree);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.join("\n");
}
function canSubmit(options, selected, freeText) {
  if (freeText.trim().length > 0) return true;
  return selected.some((index) => {
    const label = options[index];
    return typeof label === "string" && label.trim().length > 0;
  });
}
function sectionLabels(sec, selected) {
  return selected.map((idx) => sec.options[idx]).filter((l) => typeof l === "string" && l.trim().length > 0).map((l) => l.trim());
}
function sectionOwnAnswer(index, secOwn, secFreeText) {
  if (!secOwn?.[index]) return "";
  return (secFreeText?.[index] ?? "").trim();
}
function joinSectionAnswer(sections, secSelected, secOwn, secFreeText) {
  const lines = [];
  sections.forEach((sec, i) => {
    const parts = sectionLabels(sec, secSelected[i] ?? []);
    const own = sectionOwnAnswer(i, secOwn, secFreeText);
    if (own.length > 0) parts.push(own);
    if (parts.length === 0) return;
    const title = sec.title.trim();
    lines.push(title.length > 0 ? `${title}: ${parts.join(", ")}` : parts.join(", "));
  });
  return lines.join("\n");
}
function canSubmitSections(sections, secSelected, secOwn, secFreeText) {
  if (sections.length === 0) return false;
  return sections.every((sec, i) => {
    if (sectionOwnAnswer(i, secOwn, secFreeText).length > 0) return true;
    return sectionLabels(sec, secSelected[i] ?? []).length > 0;
  });
}
function setSectionAt(prev, section, value, pad) {
  const next = [...prev];
  while (next.length <= section) next.push(pad);
  next[section] = value;
  return next;
}
function toggleSectionSelected(prev, section, index) {
  const next = prev.map((arr) => [...arr]);
  while (next.length <= section) next.push([]);
  next[section] = toggleSelected(next[section] ?? [], index);
  return next;
}
var init_askUser = __esm({
  "src/lib/askUser.ts"() {
    "use strict";
  }
});

// src/components/AskUserCard.tsx
import { useEffect as useEffect11, useRef as useRef8, useState as useState10 } from "react";
import { Fragment as Fragment8, jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function coerceSections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((sec) => {
    const o = sec ?? {};
    const opts = Array.isArray(o.options) ? o.options : [];
    return {
      title: typeof o.title === "string" ? o.title.trim() : "",
      options: opts.map((x) => (typeof x === "string" ? x : x == null ? "" : String(x)).trim()).filter((x) => x.length > 0)
    };
  }).filter((s) => s.title.length > 0 && s.options.length > 0);
}
function AskUserCard({
  req,
  activity,
  messageId,
  live = false,
  inline = false,
  initialSelected,
  initialFreeText
}) {
  const chatId = useStore((s) => {
    if (req?.id) {
      const byAsk = s.chats.find((c2) => c2.pendingAsk?.id === req.id);
      if (byAsk) return byAsk.id;
    }
    if (messageId) {
      const byMsg = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
      if (byMsg) return byMsg.id;
    }
    return typeof s.activeChatId === "string" ? s.activeChatId : void 0;
  });
  const isActive = useStore((s) => req?.id ? s.chats.some((c2) => c2.pendingAsk?.id === req.id) : false);
  const argSections = coerceSections(activity?.args?.sections);
  const resolvedReq = req ?? (activity ? {
    id: "",
    question: String(activity.args?.question ?? ""),
    options: Array.isArray(activity.args?.options) ? activity.args.options.map((o) => String(o)) : [],
    sections: argSections.length > 0 ? argSections : void 0
  } : null);
  const sections = resolvedReq?.sections ?? [];
  const multiPart = sections.length > 0;
  const [localSelected, setLocalSelected] = useState10(
    () => initialSelected && initialSelected.length ? initialSelected : req?.selected && req.selected.length ? req.selected : []
  );
  const [localSecSel, setLocalSecSel] = useState10(
    () => req?.secSelected && req.secSelected.length === sections.length ? req.secSelected : sections.map(() => [])
  );
  const [localSecOwn, setLocalSecOwn] = useState10(
    () => req?.secOwn && req.secOwn.length === sections.length ? req.secOwn : sections.map(() => false)
  );
  const [localSecFree, setLocalSecFree] = useState10(
    () => req?.secFreeText && req.secFreeText.length === sections.length ? req.secFreeText : sections.map(() => "")
  );
  const [localOwn, setLocalOwn] = useState10(() => req?.own ?? false);
  const [localFree, setLocalFree] = useState10(() => initialFreeText ?? req?.freeText ?? "");
  const [sending, setSending] = useState10(false);
  const [error, setError] = useState10(null);
  const sendingRef = useRef8(false);
  const freeRef = useRef8(null);
  const secFreeRefs = useRef8([]);
  const question = (resolvedReq?.question ?? "").toString();
  const options = resolvedReq?.options ?? [];
  const fa = detectDir(question) === "rtl";
  const pendingId = resolvedReq?.id ?? "";
  const flatOwn = !multiPart && options.length > 0;
  const flatFreeActive = !multiPart && (!flatOwn || localOwn);
  const showFreeField = multiPart || flatFreeActive;
  useEffect11(() => {
    if (req?.selected) setLocalSelected(req.selected);
  }, [JSON.stringify(req?.selected)]);
  useEffect11(() => {
    if (req?.secSelected) setLocalSecSel(req.secSelected);
  }, [JSON.stringify(req?.secSelected)]);
  useEffect11(() => {
    if (req?.secOwn) setLocalSecOwn(req.secOwn);
  }, [JSON.stringify(req?.secOwn)]);
  useEffect11(() => {
    if (req?.secFreeText) setLocalSecFree(req.secFreeText);
  }, [JSON.stringify(req?.secFreeText)]);
  useEffect11(() => {
    if (typeof req?.freeText === "string") setLocalFree(req.freeText);
  }, [req?.freeText]);
  useEffect11(() => {
    if (typeof req?.own === "boolean") setLocalOwn(req.own);
  }, [req?.own]);
  const prevOwn = useRef8(localOwn);
  useEffect11(() => {
    if (flatOwn && localOwn && !prevOwn.current) freeRef.current?.focus();
    prevOwn.current = localOwn;
  }, [localOwn, flatOwn]);
  const prevSecOwn = useRef8(localSecOwn);
  useEffect11(() => {
    localSecOwn.forEach((on, si) => {
      if (on && !prevSecOwn.current?.[si]) secFreeRefs.current[si]?.focus();
    });
    prevSecOwn.current = localSecOwn;
  }, [JSON.stringify(localSecOwn)]);
  const answered = activity?.status === "done" || activity?.status === "error";
  const replyText = answered ? (activity?.resultText ?? activity?.summary ?? "").replace(/^\s*the user answered\s*:?\s*/i, "").trim() : "";
  const persist2 = (patch) => {
    if (live && chatId && req) {
      useStore.getState().setChatPendingAsk(chatId, { ...req, ...patch });
    }
  };
  const toggle = (i) => {
    if (!isActive && !live) return;
    const next = toggleSelected(localSelected, i);
    setLocalSelected(next);
    persist2({ selected: next });
  };
  const toggleSection = (sec, i) => {
    if (!isActive && !live) return;
    const next = toggleSectionSelected(localSecSel, sec, i);
    setLocalSecSel(next);
    persist2({ secSelected: next });
  };
  const toggleOwn = () => {
    if (!isActive && !live) return;
    const next = !localOwn;
    setLocalOwn(next);
    persist2({ own: next });
  };
  const changeFree = (v) => {
    setLocalFree(v);
    persist2({ freeText: v });
  };
  const toggleSectionOwn = (sec) => {
    if (!isActive && !live) return;
    const next = setSectionAt(localSecOwn, sec, !localSecOwn[sec], false);
    setLocalSecOwn(next);
    persist2({ secOwn: next });
  };
  const changeSectionFree = (sec, v) => {
    const next = setSectionAt(localSecFree, sec, v, "");
    setLocalSecFree(next);
    persist2({ secFreeText: next });
  };
  const submit = async () => {
    if (sendingRef.current) return;
    const answer = multiPart ? [
      joinSectionAnswer(sections, localSecSel, localSecOwn, localSecFree),
      localFree.trim()
    ].filter((part) => part.length > 0).join("\n") : joinAnswer(options, localSelected, flatFreeActive ? localFree : "");
    if (!answer) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const ok = pendingId ? await respondAsk(pendingId, answer) : true;
      if (ok) {
        if (chatId) useStore.getState().setChatPendingAsk(chatId, null);
      } else {
        setError(fa ? "\u0627\u0631\u0633\u0627\u0644 \u0646\u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F." : "Failed to send. Try again.");
      }
    } catch {
      setError(fa ? "\u0627\u0631\u0633\u0627\u0644 \u0646\u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F." : "Failed to send. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const handleKey = (e) => {
    const ready = multiPart ? canSubmitSections(sections, localSecSel, localSecOwn, localSecFree) : canSubmit(options, localSelected, flatFreeActive ? localFree : "");
    if (e.key === "Enter" && !e.shiftKey && ready) {
      e.preventDefault();
      void submit();
    }
  };
  if (!resolvedReq) return null;
  const readyToSubmit = multiPart ? canSubmitSections(sections, localSecSel, localSecOwn, localSecFree) : canSubmit(options, localSelected, flatFreeActive ? localFree : "");
  return /* @__PURE__ */ jsxs12(
    "div",
    {
      className: `ask-card${inline ? " ask-card-inline" : ""}`,
      role: "region",
      "aria-label": fa ? "\u067E\u0631\u0633\u0634 \u0639\u0627\u0645\u0644" : "Agent question",
      dir: fa ? "rtl" : "ltr",
      children: [
        /* @__PURE__ */ jsx13("div", { className: "ask-header", children: /* @__PURE__ */ jsx13("span", { className: "ask-badge", children: fa ? "\u067E\u0631\u0633\u0634 \u0639\u0627\u0645\u0644" : "Agent Question" }) }),
        question.length > 0 && /* @__PURE__ */ jsx13("div", { className: "ask-card-question", dir: fa ? "rtl" : "ltr", children: prepareContent(question) }),
        multiPart ? (
          // One card, several facets: each section keeps its own multi-select
          // list; Apply unlocks only when EVERY section has a pick, then all
          // answers travel together in ONE request.
          /* @__PURE__ */ jsx13("div", { className: "ask-sections", children: sections.map((sec, si) => /* @__PURE__ */ jsxs12("div", { className: "ask-section", children: [
            /* @__PURE__ */ jsx13("div", { className: "ask-section-title", dir: detectDir(sec.title), children: prepareContent(sec.title) }),
            /* @__PURE__ */ jsx13(
              "div",
              {
                className: "ask-options",
                role: "group",
                "aria-label": sec.title,
                children: sec.options.map((opt, oi) => {
                  const checked = (localSecSel[si] ?? []).includes(oi);
                  return /* @__PURE__ */ jsxs12(
                    "button",
                    {
                      type: "button",
                      role: "checkbox",
                      "aria-checked": checked,
                      className: `ask-option${checked ? " selected" : ""}`,
                      onClick: () => toggleSection(si, oi),
                      disabled: !isActive && !live,
                      children: [
                        /* @__PURE__ */ jsx13("span", { className: "ask-option-mark", "aria-hidden": true, children: checked ? "\u2611" : "\u2610" }),
                        /* @__PURE__ */ jsx13("span", { className: "ask-option-text", dir: detectDir(opt), children: prepareContent(opt) })
                      ]
                    },
                    oi
                  );
                })
              }
            ),
            /* @__PURE__ */ jsxs12(
              "button",
              {
                type: "button",
                role: "checkbox",
                "aria-checked": !!localSecOwn[si],
                className: `ask-option ask-option-own${localSecOwn[si] ? " selected" : ""}`,
                onClick: () => toggleSectionOwn(si),
                disabled: !isActive && !live,
                children: [
                  /* @__PURE__ */ jsx13("span", { className: "ask-option-mark", "aria-hidden": true, children: localSecOwn[si] ? "\u2611" : "\u2610" }),
                  /* @__PURE__ */ jsx13("span", { className: "ask-option-text", dir: fa ? "rtl" : "ltr", children: fa ? "\u067E\u0627\u0633\u062E \u062E\u0648\u062F\u0645 \u0631\u0627 \u0645\u06CC\u200C\u0646\u0648\u06CC\u0633\u0645\u2026" : "Write my own answer\u2026" })
                ]
              }
            ),
            localSecOwn[si] && /* @__PURE__ */ jsx13(
              "textarea",
              {
                className: "ask-input ask-section-input",
                ref: (el) => {
                  secFreeRefs.current[si] = el;
                },
                rows: 2,
                dir: detectDir(localSecFree[si] ?? "") === "rtl" || fa ? "rtl" : "ltr",
                value: localSecFree[si] ?? "",
                placeholder: fa ? "\u067E\u0627\u0633\u062E \u062E\u0648\u062F \u0631\u0627 \u0628\u0646\u0648\u06CC\u0633\u06CC\u062F\u2026" : "Type your answer\u2026",
                onChange: (e) => changeSectionFree(si, e.target.value),
                onKeyDown: handleKey,
                disabled: !isActive && !live,
                "aria-label": fa ? `\u067E\u0627\u0633\u062E \u0634\u0645\u0627 \u0628\u0631\u0627\u06CC ${sec.title}` : `Your answer for ${sec.title}`
              }
            )
          ] }, si)) })
        ) : options.length > 0 && /* @__PURE__ */ jsxs12("div", { className: "ask-options", role: "group", "aria-label": fa ? "\u06AF\u0632\u06CC\u0646\u0647\u200C\u0647\u0627" : "Options", children: [
          options.map((opt, i) => {
            const checked = localSelected.includes(i);
            return /* @__PURE__ */ jsxs12(
              "button",
              {
                type: "button",
                role: "checkbox",
                "aria-checked": checked,
                className: `ask-option${checked ? " selected" : ""}`,
                onClick: () => toggle(i),
                disabled: !isActive && !live,
                children: [
                  /* @__PURE__ */ jsx13("span", { className: "ask-option-mark", "aria-hidden": true, children: checked ? "\u2611" : "\u2610" }),
                  /* @__PURE__ */ jsx13("span", { className: "ask-option-text", dir: detectDir(opt), children: prepareContent(opt) })
                ]
              },
              i
            );
          }),
          !answered && /* @__PURE__ */ jsxs12(
            "button",
            {
              type: "button",
              role: "checkbox",
              "aria-checked": localOwn,
              className: `ask-option ask-option-own${localOwn ? " selected" : ""}`,
              onClick: toggleOwn,
              disabled: !isActive && !live,
              children: [
                /* @__PURE__ */ jsx13("span", { className: "ask-option-mark", "aria-hidden": true, children: localOwn ? "\u2611" : "\u2610" }),
                /* @__PURE__ */ jsx13("span", { className: "ask-option-text", dir: fa ? "rtl" : "ltr", children: fa ? "\u067E\u0627\u0633\u062E \u062E\u0648\u062F\u0645 \u0631\u0627 \u0645\u06CC\u200C\u0646\u0648\u06CC\u0633\u0645\u2026" : "Write my own answer\u2026" })
              ]
            }
          )
        ] }),
        answered ? (
          // The answer row appears only when a reply was actually recorded. A card
          // that closed without one (the user typed in the chat instead, or the
          // turn moved on) used to show "پاسخ: —" — an answer slot that is
          // empty and cannot be typed into.
          replyText ? /* @__PURE__ */ jsxs12("div", { className: "ask-answer", dir: detectDir(replyText), children: [
            /* @__PURE__ */ jsx13("svg", { className: "ask-answer-check", width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.4", strokeLinecap: "round", strokeLinejoin: "round", "aria-label": fa ? "\u067E\u0627\u0633\u062E \u062F\u0627\u062F\u0647 \u0634\u062F" : "Answered", children: /* @__PURE__ */ jsx13("path", { d: "M20 6 9 17l-5-5" }) }),
            /* @__PURE__ */ jsx13("span", { className: "ask-answer-text", dir: detectDir(replyText), children: prepareContent(replyText) })
          ] }) : null
        ) : /* @__PURE__ */ jsxs12(Fragment8, { children: [
          showFreeField && /* @__PURE__ */ jsx13("div", { className: "ask-freetext", children: /* @__PURE__ */ jsx13(
            "textarea",
            {
              className: "ask-input",
              ref: freeRef,
              rows: 2,
              autoFocus: live,
              dir: detectDir(localFree) === "rtl" || fa ? "rtl" : "ltr",
              value: localFree,
              placeholder: multiPart ? fa ? "\u062A\u0648\u0636\u06CC\u062D \u0627\u0636\u0627\u0641\u0647 (\u0627\u062E\u062A\u06CC\u0627\u0631\u06CC)\u2026" : "Anything to add? (optional)\u2026" : fa ? "\u067E\u0627\u0633\u062E \u062E\u0648\u062F \u0631\u0627 \u0628\u0646\u0648\u06CC\u0633\u06CC\u062F\u2026" : "Type your answer\u2026",
              onChange: (e) => changeFree(e.target.value),
              onKeyDown: handleKey,
              disabled: !isActive && !live
            }
          ) }),
          error && /* @__PURE__ */ jsx13("div", { className: "ask-error", children: error }),
          /* @__PURE__ */ jsx13("div", { className: "ask-footer", children: /* @__PURE__ */ jsx13(
            "button",
            {
              type: "button",
              className: "btn ask-send",
              disabled: sending || !readyToSubmit,
              onClick: () => void submit(),
              children: sending ? fa ? "\u062F\u0631 \u062D\u0627\u0644 \u0627\u0631\u0633\u0627\u0644\u2026" : "Sending\u2026" : fa ? "\u0627\u0639\u0645\u0627\u0644 \u0627\u0646\u062A\u062E\u0627\u0628" : "Apply"
            }
          ) })
        ] })
      ]
    }
  );
}
var init_AskUserCard = __esm({
  "src/components/AskUserCard.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_bidi();
    init_askUser();
  }
});

// src/components/ModalIcons.tsx
import { jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function DownloadIcon({ size = 15 }) {
  return /* @__PURE__ */ jsxs13("svg", { ...base, width: size, height: size, children: [
    /* @__PURE__ */ jsx14("path", { d: "M12 3v12" }),
    /* @__PURE__ */ jsx14("path", { d: "m7 10 5 5 5-5" }),
    /* @__PURE__ */ jsx14("path", { d: "M4.5 21h15" })
  ] });
}
function ResetZoomIcon({ size = 15 }) {
  return /* @__PURE__ */ jsxs13("svg", { ...base, width: size, height: size, children: [
    /* @__PURE__ */ jsx14("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
    /* @__PURE__ */ jsx14("path", { d: "M3 3v5h5" })
  ] });
}
function CloseIcon({ size = 15 }) {
  return /* @__PURE__ */ jsxs13("svg", { ...base, width: size, height: size, children: [
    /* @__PURE__ */ jsx14("path", { d: "M18 6 6 18" }),
    /* @__PURE__ */ jsx14("path", { d: "m6 6 12 12" })
  ] });
}
function CheckIcon({ size = 15 }) {
  return /* @__PURE__ */ jsx14("svg", { ...base, width: size, height: size, children: /* @__PURE__ */ jsx14("path", { d: "M20 6 9 17l-5-5" }) });
}
function AlertIcon({ size = 15 }) {
  return /* @__PURE__ */ jsxs13("svg", { ...base, width: size, height: size, children: [
    /* @__PURE__ */ jsx14("path", { d: "m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }),
    /* @__PURE__ */ jsx14("path", { d: "M12 9v4" }),
    /* @__PURE__ */ jsx14("path", { d: "M12 17h.01" })
  ] });
}
var base;
var init_ModalIcons = __esm({
  "src/components/ModalIcons.tsx"() {
    "use strict";
    base = {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true
    };
  }
});

// src/components/FullscreenModal.tsx
import { useEffect as useEffect12, useRef as useRef9, useState as useState11 } from "react";
import { createPortal as createPortal5 } from "react-dom";
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}
function FullscreenModal({
  open,
  onClose,
  title,
  children,
  bodyClass,
  scrollable = false,
  actions
}) {
  const [zoom, setZoom] = useState11(1);
  const [pan, setPan] = useState11({ x: 0, y: 0 });
  const [sel, setSel] = useState11(null);
  const [cursor, setCursor] = useState11("grab");
  const dragRef = useRef9(null);
  const selRef = useRef9(null);
  const viewportRef = useRef9(null);
  const zoomRef = useRef9(zoom);
  const panRef = useRef9(pan);
  useEffect12(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect12(() => {
    if (!open || !scrollable) return;
    const prev = document.activeElement;
    const vp = viewportRef.current;
    if (vp) {
      if (!vp.hasAttribute("tabindex")) vp.setAttribute("tabindex", "-1");
      vp.focus({ preventScroll: true });
    }
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isPrefixArmed()) return;
      if (isEditableTarget(e.target)) return;
      const delta = scrollDelta(physicalKey(e), e.shiftKey);
      const el = viewportRef.current;
      if (!delta || !el) return;
      e.preventDefault();
      e.stopPropagation();
      applyScroll(el, delta, !e.repeat);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, [open, scrollable]);
  useEffect12(() => {
    if (open) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setSel(null);
    }
  }, [open]);
  useEffect12(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);
  useEffect12(() => {
    if (scrollable) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const el2 = viewportRef.current;
      if (!el2) return;
      const rect = el2.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;
      const z = zoomRef.current;
      const nz = clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      if (nz === z) return;
      const p = panRef.current;
      const cx = (vx - p.x) / z;
      const cy = (vy - p.y) / z;
      setZoom(nz);
      setPan({ x: vx - cx * nz, y: vy - cy * nz });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);
  if (!open) return null;
  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const zoomTo = (sx, sy, sw, sh) => {
    const el = viewportRef.current;
    if (!el || sw < 6 || sh < 6) return;
    const rect = el.getBoundingClientRect();
    const W2 = rect.width;
    const H = rect.height;
    const nz = clampZoom(zoom * Math.min(W2 / sw, H / sh));
    const ccx = (sx + sw / 2 - pan.x) / zoom;
    const ccy = (sy + sh / 2 - pan.y) / zoom;
    const nx = W2 / 2 - ccx * nz;
    const ny = H / 2 - ccy * nz;
    setZoom(nz);
    setPan({ x: nx, y: ny });
  };
  const onMouseDown = (e) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (scrollable) {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      dragRef.current = {
        mode: "scroll",
        sx: e.clientX,
        sy: e.clientY,
        panX: 0,
        panY: 0,
        scrollX: el.scrollLeft,
        scrollY: el.scrollTop
      };
      el.style.userSelect = "none";
      el.style.webkitUserSelect = "none";
      setCursor("grabbing");
      return;
    }
    const marquee = e.metaKey || e.ctrlKey;
    e.preventDefault();
    dragRef.current = {
      mode: marquee ? "marquee" : "pan",
      sx: x,
      sy: y,
      panX: panRef.current.x,
      panY: panRef.current.y,
      scrollX: 0,
      scrollY: 0
    };
    if (marquee) {
      selRef.current = { x, y, w: 0, h: 0 };
      setSel({ x, y, w: 0, h: 0 });
      setCursor("crosshair");
    } else {
      setCursor("grabbing");
    }
  };
  const onMouseMove = (e) => {
    const d = dragRef.current;
    const el = viewportRef.current;
    if (!d || !el) return;
    if (d.mode === "scroll") {
      el.scrollLeft = d.scrollX - (e.clientX - d.sx);
      el.scrollTop = d.scrollY - (e.clientY - d.sy);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (d.mode === "marquee") {
      const next = {
        x: Math.min(d.sx, x),
        y: Math.min(d.sy, y),
        w: Math.abs(x - d.sx),
        h: Math.abs(y - d.sy)
      };
      selRef.current = next;
      setSel(next);
    } else {
      setPan({ x: d.panX + (x - d.sx), y: d.panY + (y - d.sy) });
    }
  };
  const onMouseUp = () => {
    const d = dragRef.current;
    const s = selRef.current;
    dragRef.current = null;
    selRef.current = null;
    if (d?.mode === "marquee" && s && s.w >= 6 && s.h >= 6) {
      zoomTo(s.x, s.y, s.w, s.h);
    }
    setSel(null);
    if (d?.mode === "scroll") {
      const el = viewportRef.current;
      if (el) {
        el.style.userSelect = "";
        el.style.webkitUserSelect = "";
      }
      setCursor("grab");
    }
  };
  return createPortal5(
    /* @__PURE__ */ jsx15("div", { className: "fullscreen-modal-scrim", role: "presentation", children: /* @__PURE__ */ jsxs14(
      "div",
      {
        className: "fullscreen-modal-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title ?? "Full screen",
        children: [
          /* @__PURE__ */ jsxs14("div", { className: "fullscreen-modal-head", children: [
            /* @__PURE__ */ jsx15("span", { className: "fullscreen-modal-title", children: title }),
            /* @__PURE__ */ jsxs14("div", { className: "fullscreen-modal-actions", children: [
              actions,
              !scrollable && /* @__PURE__ */ jsx15(
                "button",
                {
                  className: "fullscreen-icon-btn",
                  onClick: reset,
                  "aria-label": "Reset zoom",
                  title: "Reset zoom (100%)",
                  children: /* @__PURE__ */ jsx15(ResetZoomIcon, {})
                }
              ),
              /* @__PURE__ */ jsx15(
                "button",
                {
                  className: "fullscreen-icon-btn",
                  onClick: onClose,
                  "aria-label": "Close",
                  title: "Close (Esc)",
                  children: /* @__PURE__ */ jsx15(CloseIcon, {})
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsx15("div", { className: `fullscreen-modal-body ${bodyClass ?? ""}`, children: /* @__PURE__ */ jsxs14(
            "div",
            {
              className: `fullscreen-pan-viewport${scrollable ? " scrollable" : ""}`,
              ref: viewportRef,
              style: scrollable ? cursor === "grabbing" ? { cursor: "grabbing" } : void 0 : { cursor },
              onMouseDown,
              onMouseMove,
              onMouseUp,
              onMouseLeave: onMouseUp,
              children: [
                /* @__PURE__ */ jsx15(
                  "div",
                  {
                    className: "fullscreen-pan-content",
                    style: scrollable ? void 0 : { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` },
                    children
                  }
                ),
                !scrollable && sel && /* @__PURE__ */ jsx15(
                  "div",
                  {
                    className: "fullscreen-marquee",
                    style: {
                      left: sel.x,
                      top: sel.y,
                      width: sel.w,
                      height: sel.h
                    }
                  }
                )
              ]
            }
          ) })
        ]
      }
    ) }),
    document.body
  );
}
var MIN_ZOOM, MAX_ZOOM, ZOOM_STEP;
var init_FullscreenModal = __esm({
  "src/components/FullscreenModal.tsx"() {
    "use strict";
    init_shortcuts();
    init_scrollKeys();
    init_panePointer();
    init_prefixState();
    init_ModalIcons();
    MIN_ZOOM = 1;
    MAX_ZOOM = 5;
    ZOOM_STEP = 0.02;
  }
});

// src/lib/fullscreen.ts
import { create as create4 } from "zustand";
var useFullscreen;
var init_fullscreen = __esm({
  "src/lib/fullscreen.ts"() {
    "use strict";
    useFullscreen = create4((set) => ({
      activeKey: null,
      open: (key) => set({ activeKey: key }),
      close: () => set({ activeKey: null })
    }));
  }
});

// src/lib/saveMedia.ts
async function downloadMedia(url, virtualPath, dataUrl) {
  const name = virtualPath.split("/").pop() || "media";
  if (api.saveMediaAs) {
    const dest = await api.saveMediaAs(virtualPath, name, dataUrl);
    return dest ? "saved" : "cancelled";
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5e3);
  return "downloaded";
}
var init_saveMedia = __esm({
  "src/lib/saveMedia.ts"() {
    "use strict";
    init_fs();
  }
});

// src/components/MessageImages.tsx
import { useEffect as useEffect13, useId, useRef as useRef10, useState as useState12 } from "react";
import { Fragment as Fragment9, jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
function MessageImages({
  images,
  modalTitle
}) {
  const fsKey = useId();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const [selected, setSelected] = useState12(null);
  const [dlState, setDlState] = useState12(null);
  const dlBusy = useRef10(false);
  const dlTimer = useRef10(null);
  useEffect13(() => () => {
    if (dlTimer.current !== null) window.clearTimeout(dlTimer.current);
  }, []);
  if (!images || images.length === 0) return null;
  const usable = (u) => !!u && !u.includes("\u2026");
  const expanded = activeKey === fsKey && selected !== null;
  const current = selected !== null ? images[selected] : null;
  const open = (idx) => {
    const du = images[idx]?.dataUrl;
    if (!du || du.includes("\u2026")) return;
    setSelected(idx);
    openFs(fsKey);
  };
  const close = () => {
    closeFs();
    setSelected(null);
    setDlState(null);
    dlBusy.current = false;
  };
  const download = async () => {
    if (!current?.dataUrl || dlBusy.current) return;
    dlBusy.current = true;
    try {
      const r = await downloadMedia(current.dataUrl, current.path || current.name, current.dataUrl);
      setDlState(r === "cancelled" ? null : "saved");
    } catch {
      setDlState("error");
    } finally {
      dlBusy.current = false;
    }
    if (dlTimer.current !== null) window.clearTimeout(dlTimer.current);
    dlTimer.current = window.setTimeout(() => setDlState(null), 2400);
  };
  return /* @__PURE__ */ jsxs15(Fragment9, { children: [
    /* @__PURE__ */ jsx16("div", { className: "msg-images", dir: "ltr", children: images.map((img, idx) => /* @__PURE__ */ jsx16(
      "div",
      {
        className: `msg-image${usable(img.dataUrl) ? " zoomable" : ""}`,
        title: usable(img.dataUrl) ? `${img.name} \u2014 click to expand` : img.name,
        role: usable(img.dataUrl) ? "button" : void 0,
        tabIndex: usable(img.dataUrl) ? 0 : void 0,
        "aria-label": usable(img.dataUrl) ? `Expand image ${img.name}` : void 0,
        style: usable(img.dataUrl) ? { cursor: "zoom-in" } : void 0,
        onClick: usable(img.dataUrl) ? () => open(idx) : void 0,
        onKeyDown: img.dataUrl ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open(idx);
          }
        } : void 0,
        children: usable(img.dataUrl) ? /* @__PURE__ */ jsx16(
          "img",
          {
            src: img.dataUrl,
            alt: img.name,
            loading: "lazy",
            decoding: "async"
          }
        ) : /* @__PURE__ */ jsx16("span", { className: "msg-image-ph", children: img.name })
      },
      img.path
    )) }),
    current && usable(current.dataUrl) && /* @__PURE__ */ jsx16(
      FullscreenModal,
      {
        open: expanded,
        onClose: close,
        title: modalTitle ?? current.name,
        bodyClass: "image-fs-body",
        actions: /* @__PURE__ */ jsx16(
          "button",
          {
            className: `fullscreen-icon-btn${dlState === "saved" ? " ok" : dlState === "error" ? " err" : ""}`,
            onClick: download,
            disabled: !usable(current.dataUrl),
            "aria-label": "Save image",
            title: dlState === "saved" ? "Saved" : "Save image as\u2026",
            children: dlState === "saved" ? /* @__PURE__ */ jsx16(CheckIcon, {}) : dlState === "error" ? /* @__PURE__ */ jsx16(AlertIcon, {}) : /* @__PURE__ */ jsx16(DownloadIcon, {})
          }
        ),
        children: /* @__PURE__ */ jsx16("div", { className: "image-fullscreen", children: /* @__PURE__ */ jsx16("img", { src: current.dataUrl, alt: current.name, decoding: "async" }) })
      }
    )
  ] });
}
var init_MessageImages = __esm({
  "src/components/MessageImages.tsx"() {
    "use strict";
    init_FullscreenModal();
    init_ModalIcons();
    init_fullscreen();
    init_saveMedia();
  }
});

// src/lib/time.ts
function fmtElapsed(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const totalSec = ms / 1e3;
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}
var init_time = __esm({
  "src/lib/time.ts"() {
    "use strict";
  }
});

// src/components/MessageActionsBar.tsx
import { useState as useState13 } from "react";
import { Fragment as Fragment10, jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
function UsageBadge({
  input,
  output,
  total,
  live
}) {
  const body = `\u2191 ${fmtTokens(input)} in \xB7 \u2193 ${live ? "\u2026" : fmtTokens(output)} out`;
  return /* @__PURE__ */ jsx17(
    "span",
    {
      className: `msg-usage${live ? " live" : ""}`,
      title: `${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`,
      dir: "ltr",
      children: body
    }
  );
}
function fmtTokens(n) {
  if (!n) return "0";
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
}
function MsgClocks({
  turnElapsedMs,
  hide
}) {
  if (hide || turnElapsedMs == null) return null;
  return /* @__PURE__ */ jsxs16("span", { className: "msg-elapsed", dir: "ltr", children: [
    /* @__PURE__ */ jsxs16(
      "svg",
      {
        className: "msg-elapsed-icon",
        width: "11",
        height: "11",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: [
          /* @__PURE__ */ jsx17("path", { d: "M10 2h4" }),
          /* @__PURE__ */ jsx17("path", { d: "M12 14l3-3" }),
          /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "14", r: "8" })
        ]
      }
    ),
    fmtElapsed(turnElapsedMs)
  ] });
}
function MessageActionsBar({
  text,
  usage,
  ttsStatus,
  onSpeak,
  onStopTts,
  fork,
  onFork,
  read,
  onRead,
  children
}) {
  const [copied, setCopied] = useState13(false);
  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(text)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  const showSpeak = Boolean(onSpeak) && Boolean(ttsStatus);
  return (
    // FIXED geometry in both message directions (user request): the status
    // group (children: retry line, thinking, timer) is ALWAYS flush-left and
    // the tools group (usage + copy/fork/speak/read) ALWAYS flush-right. The
    // row runs direction:ltr for stable sides; the retry chip manages its own
    // bidi internally.
    /* @__PURE__ */ jsxs16("div", { className: "msg-actions", children: [
      children != null && /* @__PURE__ */ jsx17("div", { className: "msg-actions-status", children }),
      /* @__PURE__ */ jsxs16("div", { className: "msg-actions-tools", children: [
        text && /* @__PURE__ */ jsxs16(Fragment10, { children: [
          /* @__PURE__ */ jsx17(
            "button",
            {
              className: `msg-copy ${copied ? "copied" : ""}`,
              onClick: copy,
              title: copied ? "Copied" : "Copy message",
              "aria-label": copied ? "Copied" : "Copy message",
              children: copied ? /* @__PURE__ */ jsx17(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2.5",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: /* @__PURE__ */ jsx17("path", { d: "M20 6 9 17l-5-5" })
                }
              ) : /* @__PURE__ */ jsxs16(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: [
                    /* @__PURE__ */ jsx17("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                    /* @__PURE__ */ jsx17("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                  ]
                }
              )
            }
          ),
          fork && onFork && /* @__PURE__ */ jsx17(
            "button",
            {
              className: "msg-copy msg-fork",
              onClick: onFork,
              title: "Fork chat from here",
              "aria-label": "Fork chat from here",
              children: /* @__PURE__ */ jsxs16(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: [
                    /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "18", r: "3" }),
                    /* @__PURE__ */ jsx17("circle", { cx: "6", cy: "6", r: "3" }),
                    /* @__PURE__ */ jsx17("circle", { cx: "18", cy: "6", r: "3" }),
                    /* @__PURE__ */ jsx17("path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }),
                    /* @__PURE__ */ jsx17("path", { d: "M12 12v3" })
                  ]
                }
              )
            }
          ),
          showSpeak && /* @__PURE__ */ jsx17(
            "button",
            {
              className: `msg-copy msg-speak ${ttsStatus === "speaking" ? "speaking" : ""} ${ttsStatus === "loading" ? "loading" : ""} ${ttsStatus === "paused" ? "paused" : ""}`,
              onClick: onSpeak,
              title: ttsStatus === "speaking" ? "\u062A\u0648\u0642\u0641 \u0645\u0648\u0642\u062A" : ttsStatus === "paused" ? "\u0627\u062F\u0627\u0645\u0647 \u067E\u062E\u0634" : ttsStatus === "loading" ? "\u0644\u063A\u0648" : "\u062E\u0648\u0627\u0646\u062F\u0646 \u0628\u0627 \u0635\u062F\u0627",
              "aria-label": ttsStatus === "speaking" ? "Pause" : ttsStatus === "paused" ? "Resume" : ttsStatus === "loading" ? "Cancel" : "Speak",
              children: ttsStatus === "loading" ? /* @__PURE__ */ jsx17(
                "svg",
                {
                  className: "tts-spinner",
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2.5",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: /* @__PURE__ */ jsx17("path", { d: "M21 12a9 9 0 1 1-6.2-8.56" })
                }
              ) : ttsStatus === "speaking" ? /* @__PURE__ */ jsx17(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "3",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: /* @__PURE__ */ jsx17("path", { d: "M9 5v14M15 5v14" })
                }
              ) : ttsStatus === "paused" ? /* @__PURE__ */ jsx17("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: /* @__PURE__ */ jsx17("path", { d: "M8 5v14l11-7z" }) }) : /* @__PURE__ */ jsxs16(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: [
                    /* @__PURE__ */ jsx17("polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }),
                    /* @__PURE__ */ jsx17("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" })
                  ]
                }
              )
            }
          ),
          onStopTts && (ttsStatus === "speaking" || ttsStatus === "paused") && /* @__PURE__ */ jsx17(
            "button",
            {
              className: "msg-copy msg-speak msg-tts-stop",
              onClick: onStopTts,
              title: "\u062A\u0648\u0642\u0641 \u067E\u062E\u0634",
              "aria-label": "Stop TTS",
              children: /* @__PURE__ */ jsx17("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: /* @__PURE__ */ jsx17("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }) })
            }
          ),
          read && onRead && /* @__PURE__ */ jsx17(
            "button",
            {
              className: "msg-copy",
              onClick: onRead,
              title: "Reading mode \u2014 study each section separately and ask about it",
              "aria-label": "Read",
              children: /* @__PURE__ */ jsxs16(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  children: [
                    /* @__PURE__ */ jsx17("path", { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" }),
                    /* @__PURE__ */ jsx17("path", { d: "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" })
                  ]
                }
              )
            }
          )
        ] }),
        usage && /* @__PURE__ */ jsx17(
          UsageBadge,
          {
            input: usage.inputTokens,
            output: usage.outputTokens,
            total: usage.totalTokens
          }
        )
      ] })
    ] })
  );
}
var init_MessageActionsBar = __esm({
  "src/components/MessageActionsBar.tsx"() {
    "use strict";
    init_clipboard();
    init_bidi();
    init_time();
  }
});

// src/lib/ltrIslands.ts
function trimUnbalanced(core) {
  let tail = "";
  for (; ; ) {
    const stack = [];
    let cut = -1;
    for (let i = 0; i < core.length; i++) {
      const ch = core[i];
      if (OPENERS[ch]) stack.push({ ch, idx: i });
      else if (CLOSERS[ch] && stack.pop()?.ch !== CLOSERS[ch]) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      tail = core.slice(cut) + tail;
      core = core.slice(0, cut);
      continue;
    }
    if (stack.length > 0) {
      tail = core.slice(stack[0].idx) + tail;
      core = core.slice(0, stack[0].idx);
      continue;
    }
    break;
  }
  const m = /[ \t\u00A0]+$/.exec(core);
  if (m) {
    tail = m[0] + tail;
    core = core.slice(0, core.length - m[0].length);
  }
  return { core, tail };
}
function isolateRun(m) {
  let first = 0;
  while (first < m.length && !STRONG_CHAR_RE.test(m[first])) first++;
  let last = m.length - 1;
  while (last > first && !STRONG_CHAR_RE.test(m[last])) last--;
  const lead = m.slice(0, first);
  const bal = trimUnbalanced(m.slice(first, last + 1));
  const core = bal.core;
  const trail = bal.tail + m.slice(last + 1);
  const leadKeep = LEAD_KEEP_RE.exec(lead)?.[0] ?? "";
  const trailKeep = TRAIL_KEEP_RE.exec(trail)?.[0] ?? "";
  if (!core || !GLUE_CHAR_RE.test(core) && !leadKeep && !trailKeep) return m;
  return lead.slice(0, lead.length - leadKeep.length) + LRI + leadKeep + core + trailKeep + PDI + trail.slice(trailKeep.length);
}
function isolateLtrRuns(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(RUN_RE, isolateRun);
}
function dirByText(text) {
  if (typeof text !== "string" || !text) return "ltr";
  let rtl = 0;
  let ltr = 0;
  let run = 0;
  let first = null;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!token || !HAS_LETTER_RE.test(token)) continue;
    if (RTL_TOKEN_RE.test(token)) {
      rtl++;
      run = 0;
      first ??= "rtl";
    } else {
      if (run < 2) ltr++;
      run++;
      first ??= "ltr";
    }
  }
  if (rtl === ltr) return first ?? "ltr";
  return rtl > ltr ? "rtl" : "ltr";
}
function walkIslands(node) {
  if (node.type === "text") {
    if (node.value) node.value = isolateLtrRuns(node.value);
    return;
  }
  if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) {
    return;
  }
  if (node.type === "element" && node.tagName && DIR_BLOCKS.has(node.tagName)) {
    let text = "";
    const collect2 = (n) => {
      if (n.type === "text") {
        text += n.value ?? "";
        return;
      }
      if (n.type === "element" && n.tagName && SKIP_TAGS.has(n.tagName)) return;
      n.children?.forEach(collect2);
    };
    (node.children ?? []).forEach(collect2);
    if (!node.properties) node.properties = {};
    node.properties.dir = dirByText(text);
  }
  const kids = node.children;
  if (kids) for (const kid of kids) walkIslands(kid);
}
function rehypeLtrIslands() {
  return (tree) => {
    walkIslands(tree);
  };
}
var LRI, PDI, STRONG, GLUE, STRONG_CHAR_RE, GLUE_CHAR_RE, RUN_RE, LEAD_KEEP_RE, TRAIL_KEEP_RE, OPENERS, CLOSERS, RTL_TOKEN_RE, HAS_LETTER_RE, SKIP_TAGS, DIR_BLOCKS;
var init_ltrIslands = __esm({
  "src/lib/ltrIslands.ts"() {
    "use strict";
    LRI = "\u2066";
    PDI = "\u2069";
    STRONG = "A-Za-z0-9\u06F0-\u06F9\u0660-\u0669";
    GLUE = " \\t\\u00A0\\u200B\\u200C\\u200D\\u200E\\u00AB\\u00BB\\u2018\\u2019\\u201C\\u201D!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~\\u2010-\\u2015\\u2022\\u2027\\u2030\\u060C\\u061B\\u061F\\u066A\\u066B\\u066C\\u2212\\u2248\\u2260\\u2264\\u2265\\u20AC\\u00A3\\u00A5";
    STRONG_CHAR_RE = new RegExp(`[${STRONG}]`);
    GLUE_CHAR_RE = new RegExp(`[${GLUE}]`);
    RUN_RE = new RegExp(
      `[${GLUE}]*[${STRONG}][${STRONG}]*([${GLUE}]+[${STRONG}][${STRONG}]*)*[${GLUE}]*`,
      "g"
    );
    LEAD_KEEP_RE = /[+\u2212~$/.]+$/;
    TRAIL_KEEP_RE = /^[%\u066A]+/;
    OPENERS = { "(": ")", "[": "]", "{": "}" };
    CLOSERS = { ")": "(", "]": "[", "}": "{" };
    RTL_TOKEN_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    HAS_LETTER_RE = /[\p{L}\p{N}]/u;
    SKIP_TAGS = /* @__PURE__ */ new Set(["code", "pre", "a", "style", "script"]);
    DIR_BLOCKS = /* @__PURE__ */ new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote"]);
  }
});

// src/components/message/shared.tsx
import { useEffect as useEffect14, useState as useState14 } from "react";
import { jsx as jsx18 } from "react/jsx-runtime";
function attachmentBasename(a) {
  const idx = Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\"));
  return idx >= 0 ? a.slice(idx + 1) : a;
}
function docPathsFromActivities(list) {
  if (!list || list.length === 0) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const a of list) {
    const tool = a.tool ?? "";
    const isDocTool = tool === "write_document" || tool === "edit_file" || tool === "write_file";
    if (isDocTool) {
      const raw = editTargetOf(a.args) || void 0;
      const candidates = [
        typeof raw === "string" ? raw : "",
        typeof a.summary === "string" ? a.summary : ""
      ];
      for (const c2 of candidates) {
        if (!c2) continue;
        const token = c2.trim().split(/\s+/).find((t) => isDocPath(t)) ?? "";
        const target = token || (isDocPath(c2) ? c2.trim() : "");
        if (!target) continue;
        const { path } = splitPathLine(target);
        const clean = path.trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
      }
    }
    if (a.children && a.children.length > 0) {
      for (const p of docPathsFromActivities(a.children)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}
function DocFileChips({ paths }) {
  if (paths.length === 0) return null;
  return /* @__PURE__ */ jsx18("div", { className: "msg-attachments", dir: "ltr", children: paths.map((p) => /* @__PURE__ */ jsx18(FileChip, { path: p, display: attachmentBasename(p) }, p)) });
}
function perLineDir(text) {
  return text.split("\n").map((ln, i) => (
    // dir = LANGUAGE MAJORITY of the line (dirByText): first-strong flips a
    // mostly-English line that merely contains a Persian word. Numbers/ranges
    // get the LTR-island wrapper so ۳٫۷۵–۴٫۰۰٪ never reverses (plain user
    // text never goes through the markdown pipeline where islands run).
    /* @__PURE__ */ jsx18("div", { className: "user-text-line", dir: dirByText(ln), children: ln ? isolateLtrRuns(ln) : "\xA0" }, i)
  ));
}
function dropPrepared(id) {
  const hit = preparedCache.get(id);
  if (hit) {
    preparedCacheChars -= hit.text.length + hit.out.length;
    preparedCache.delete(id);
  }
}
function computePrepared(id, text, dir) {
  const hit = preparedCache.get(id);
  if (hit && hit.text === text) return hit.out;
  const out = prepareContent(text, dir);
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return out;
  dropPrepared(id);
  while (preparedCache.size > 0 && (preparedCache.size >= PREPARED_CACHE_MAX || preparedCacheChars + text.length + out.length > PREPARED_CACHE_MAX_CHARS)) {
    const oldest = preparedCache.keys().next().value;
    if (oldest === void 0) break;
    dropPrepared(oldest);
  }
  preparedCache.set(id, { text, out });
  preparedCacheChars += text.length + out.length;
  return out;
}
function cachedPrepare(id, text, dir) {
  if (!text) return text;
  return computePrepared(id, text, dir);
}
function cachedPrepareText(text, dir) {
  if (!text) return text;
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return prepareContent(text, dir);
  return computePrepared(`t:${text}`, text, dir);
}
function useCapped(id, text, live) {
  const over = !live && text.length > RENDER_CAP;
  const [showAll, setShowAll] = useState14(false);
  useEffect14(() => {
    setShowAll(false);
  }, [id]);
  const shown = over && !showAll ? text.slice(0, RENDER_CAP) : text;
  return { shown, over, cut: text.length - shown.length, showAll, setShowAll };
}
var preparedCache, PREPARED_CACHE_MAX, PREPARED_CACHE_MAX_CHARS, PREPARED_CACHE_SKIP_CHARS, preparedCacheChars;
var init_shared = __esm({
  "src/components/message/shared.tsx"() {
    "use strict";
    init_bidi();
    init_fileTypes();
    init_renderCap();
    init_FileIcon();
    init_ltrIslands();
    init_toolActivity();
    preparedCache = /* @__PURE__ */ new Map();
    PREPARED_CACHE_MAX = 400;
    PREPARED_CACHE_MAX_CHARS = 2e6;
    PREPARED_CACHE_SKIP_CHARS = 4e4;
    preparedCacheChars = 0;
  }
});

// src/components/ChartBlock.tsx
import { useEffect as useEffect15, useMemo as useMemo5, useState as useState15 } from "react";
import { jsx as jsx19, jsxs as jsxs17 } from "react/jsx-runtime";
function parseChartSpec(raw) {
  const cleaned = raw.replace(/[​‎‏؜‪-‮⁦-⁩﻿]/g, "").replace(/,(\s*[}\]])/g, "$1").trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data;
  const type = obj.type === "line" || obj.type === "pie" ? obj.type : obj.type === "bar" ? "bar" : null;
  if (!type) return null;
  const faDigits = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
  const toNum = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const norm = v.replace(/[۰-۹]/g, (d) => String(faDigits.indexOf(d))).replace(/[٬,]/g, "").trim();
      const n = Number(norm);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const labels = Array.isArray(obj.labels) ? obj.labels.filter((l) => typeof l === "string" && l.trim().length > 0) : [];
  const seriesIn = Array.isArray(obj.series) ? obj.series : [{ values: obj.values }];
  const series = [];
  for (const s of seriesIn) {
    if (!s || typeof s !== "object") continue;
    const rawVals = s.values;
    if (!Array.isArray(rawVals)) continue;
    const values = rawVals.map(toNum).filter((n) => n !== null);
    if (values.length === 0) continue;
    const name = s.name;
    series.push({ name: typeof name === "string" && name.trim() ? name : void 0, values });
  }
  if (series.length === 0) return null;
  const unit = typeof obj.unit === "string" && obj.unit.trim() ? obj.unit.trim() : void 0;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : void 0;
  const height = typeof obj.height === "number" && obj.height >= 160 && obj.height <= 800 ? obj.height : void 0;
  return { type, title, unit, labels, series, height };
}
function useChartColors() {
  return useMemo5(() => {
    let accent = FALLBACK_ACCENT;
    try {
      const cs = getComputedStyle(document.documentElement);
      accent = cs.getPropertyValue("--accent").trim() || FALLBACK_ACCENT;
    } catch {
    }
    return [accent, ...PALETTE];
  }, []);
}
function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base2 = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * base2) return m * base2;
  }
  return 10 * base2;
}
function ChartText(props) {
  const { lines, children, style, ...rest } = props;
  const content = typeof children === "string" ? isolateLtrRuns(children) : children;
  const bidiStyle = { ...style, unicodeBidi: "plaintext" };
  if (lines && lines.length > 1) {
    return /* @__PURE__ */ jsx19("text", { ...rest, style: bidiStyle, children: lines.map((ln, i) => /* @__PURE__ */ jsx19("tspan", { x: rest.x, dy: i === 0 ? 0 : 13, children: isolateLtrRuns(ln) }, i)) });
  }
  return /* @__PURE__ */ jsx19("text", { ...rest, style: bidiStyle, children: content });
}
function wrapLabel(label, width, maxLines = 2) {
  const perLine = Math.max(4, Math.floor(width / 6.4));
  const words = label.split(/\s+/);
  const lines = [];
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
      lines[maxLines - 1] = last.slice(0, Math.max(1, perLine - 2)) + "\u2026";
    }
  }
  return lines;
}
function ChartBlock({ spec }) {
  const complete = Boolean(spec) && !/[`~]{3}/.test(spec);
  const [debounced, setDebounced] = useState15(spec);
  useEffect15(() => {
    const t = setTimeout(() => setDebounced(spec), 400);
    return () => clearTimeout(t);
  }, [spec]);
  const parsed = useMemo5(
    () => complete ? parseChartSpec(debounced) : null,
    [complete, debounced]
  );
  const colors = useChartColors();
  if (!parsed) {
    return /* @__PURE__ */ jsx19("pre", { className: "chart-fallback", children: spec });
  }
  const { type, title, unit, labels, series, height: specH } = parsed;
  const plotH = specH ?? 300;
  const legendItems = type === "pie" ? labels.map((lb, i) => ({ label: lb, color: "" })) : series.length > 1 ? series.map((s, i) => ({ label: s.name ?? labels[i] ?? `#${i + 1}`, color: "" })) : [];
  const legendRows = legendItems.length > 0 ? Math.ceil(legendItems.length / 4) : 0;
  const H = M.top + plotH + M.bottom + (title ? 24 : 0) + (legendRows > 1 ? (legendRows - 1) * 16 : 0);
  const titleY = title ? M.top + 14 : 0;
  const plotTop = M.top + (title ? 24 : 0);
  const plotW = W - M.left - M.right;
  const dir = detectDir(debounced);
  const allValues = series.flatMap((s) => s.values.map(Math.abs));
  const maxVal = niceMax(Math.max(1, ...allValues));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxVal);
  const y = (v) => plotTop + plotH - v / maxVal * plotH;
  const titleEl = title ? /* @__PURE__ */ jsx19(
    ChartText,
    {
      x: W / 2,
      y: titleY,
      textAnchor: "middle",
      fontSize: 14,
      fontWeight: 600,
      style: { fill: "var(--text)" },
      children: unit ? `${title} (${unit})` : title
    }
  ) : null;
  const grid = /* @__PURE__ */ jsx19("g", { children: ticks.map((t, i) => /* @__PURE__ */ jsxs17("g", { children: [
    /* @__PURE__ */ jsx19(
      "line",
      {
        x1: M.left,
        x2: W - M.right,
        y1: y(t),
        y2: y(t),
        stroke: "var(--border)",
        strokeDasharray: i === 0 ? void 0 : "3 4"
      }
    ),
    /* @__PURE__ */ jsx19(
      ChartText,
      {
        x: M.left - 8,
        y: y(t) + 4,
        textAnchor: "end",
        fontSize: 11,
        style: { fill: "var(--text-dim)" },
        children: fmtNum(t)
      }
    )
  ] }, i)) });
  const legendWithColors = legendItems.map((item, i) => ({
    ...item,
    color: colors[i % colors.length]
  }));
  const legend = legendWithColors.length > 0 ? /* @__PURE__ */ jsx19("g", { children: legendWithColors.map((item, i) => {
    const label = item.label;
    const lw = label.length * 6.6 + 26;
    const slots = Math.max(1, Math.floor(plotW / Math.max(lw, 90)));
    const row = Math.floor(i / slots);
    const col = i % slots;
    const x = dir === "rtl" ? W - M.right - col * Math.max(lw, 90) - 14 : M.left + col * Math.max(lw, 90) + 8;
    const ly = plotTop + plotH + 30 + row * 16;
    return /* @__PURE__ */ jsxs17("g", { children: [
      /* @__PURE__ */ jsx19("rect", { x: x - 12, y: ly - 8, width: 10, height: 10, rx: 3, fill: item.color }),
      /* @__PURE__ */ jsx19(ChartText, { x, y: ly, fontSize: 11, style: { fill: "var(--text-dim)" }, children: label })
    ] }, i);
  }) }) : null;
  let body = null;
  if (type === "bar") {
    const n = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
    const slot = plotW / n;
    const groupW = slot * 0.7;
    const barW = Math.min(groupW / series.length, 64);
    body = /* @__PURE__ */ jsxs17("g", { children: [
      series.map(
        (s, si) => s.values.map((v, i) => {
          const inGroup = series.length === 1 ? (groupW - barW) / 2 : si * barW + (groupW - series.length * barW) / 2;
          const bx = M.left + i * slot + inGroup;
          const by = y(Math.max(0, v));
          const bh = Math.max(2, plotTop + plotH - by);
          return /* @__PURE__ */ jsxs17("g", { children: [
            /* @__PURE__ */ jsx19(
              "rect",
              {
                x: bx,
                y: by,
                width: barW,
                height: bh,
                rx: Math.min(6, barW / 3),
                fill: colors[si % colors.length],
                opacity: 0.92,
                children: /* @__PURE__ */ jsx19("title", { children: `${labels[i] ?? ""} ${s.name ? "\u2014 " + s.name : ""}: ${fmtNum(v)}` })
              }
            ),
            series.length === 1 && /* @__PURE__ */ jsx19(
              ChartText,
              {
                x: bx + barW / 2,
                y: by - 6,
                textAnchor: "middle",
                fontSize: 11,
                style: { fill: "var(--text-dim)" },
                children: fmtNum(v)
              }
            )
          ] }, `${si}-${i}`);
        })
      ),
      labels.map((lb, i) => {
        const lines = wrapLabel(lb, slot * 0.94);
        return /* @__PURE__ */ jsx19(
          ChartText,
          {
            x: M.left + i * slot + slot / 2,
            y: plotTop + plotH + (lines.length > 1 ? 14 : 18),
            textAnchor: "middle",
            fontSize: 12,
            lines,
            style: { fill: "var(--text)" },
            children: lb
          },
          i
        );
      })
    ] });
  } else if (type === "line") {
    const n = Math.max(labels.length, ...series.map((s) => s.values.length), 2);
    const step = plotW / (n - 1 || 1);
    const px = (i) => M.left + i * step;
    body = /* @__PURE__ */ jsxs17("g", { children: [
      series.map((s, si) => /* @__PURE__ */ jsxs17("g", { children: [
        /* @__PURE__ */ jsx19(
          "polyline",
          {
            points: s.values.map((v, i) => `${px(i)},${y(v)}`).join(" "),
            fill: "none",
            stroke: colors[si % colors.length],
            strokeWidth: 2.2,
            strokeLinejoin: "round",
            strokeLinecap: "round"
          }
        ),
        s.values.map((v, i) => /* @__PURE__ */ jsx19("circle", { cx: px(i), cy: y(v), r: 3.4, fill: colors[si % colors.length], children: /* @__PURE__ */ jsx19("title", { children: `${labels[i] ?? ""} ${s.name ? "\u2014 " + s.name : ""}: ${fmtNum(v)}` }) }, i))
      ] }, si)),
      labels.map((lb, i) => {
        const lines = wrapLabel(lb, Math.max(step, 48) * 0.94);
        return /* @__PURE__ */ jsx19(
          ChartText,
          {
            x: px(i),
            y: plotTop + plotH + (lines.length > 1 ? 14 : 18),
            textAnchor: "middle",
            fontSize: 12,
            lines,
            style: { fill: "var(--text)" },
            children: lb
          },
          i
        );
      })
    ] });
  } else {
    const values = series[0].values;
    const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
    const cx = W / 2;
    const cy = plotTop + plotH / 2;
    const r = Math.min(plotH, plotW) / 2 - 12;
    let acc = -Math.PI / 2;
    body = /* @__PURE__ */ jsx19("g", { children: values.map((v, i) => {
      const frac = Math.abs(v) / total;
      const a1 = acc;
      const a2 = acc + frac * Math.PI * 2;
      acc = a2;
      const large = a2 - a1 > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      return /* @__PURE__ */ jsx19(
        "path",
        {
          d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
          fill: colors[i % colors.length],
          stroke: "var(--bg-panel)",
          strokeWidth: 2,
          opacity: 0.95,
          children: /* @__PURE__ */ jsx19("title", { children: `${labels[i] ?? series[0].name ?? ""}: ${fmtNum(v)} (${Math.round(frac * 100)}%)` })
        },
        i
      );
    }) });
  }
  return /* @__PURE__ */ jsx19("div", { className: "chart-block", children: /* @__PURE__ */ jsxs17(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      width: "100%",
      role: "img",
      "aria-label": title ?? "chart",
      style: { display: "block" },
      children: [
        titleEl,
        type !== "pie" && grid,
        type !== "pie" && /* @__PURE__ */ jsx19("line", { x1: M.left, x2: M.left, y1: plotTop, y2: plotTop + plotH, stroke: "var(--border)" }),
        body,
        legend
      ]
    }
  ) });
}
var FALLBACK_ACCENT, PALETTE, fmtNum, W, M;
var init_ChartBlock = __esm({
  "src/components/ChartBlock.tsx"() {
    "use strict";
    init_bidi();
    init_ltrIslands();
    FALLBACK_ACCENT = "#5b8def";
    PALETTE = ["#45a875", "#d2994a", "#c75f8f", "#7f8cc4", "#5fb8c9", "#b8654a"];
    fmtNum = (n) => Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
    W = 760;
    M = { top: 14, right: 14, bottom: 44, left: 48 };
  }
});

// src/lib/useVisible.ts
import { useEffect as useEffect16, useState as useState16 } from "react";
function useVisible(ref, enabled = true) {
  const [visible, setVisible] = useState16(false);
  useEffect16(() => {
    if (visible || !enabled) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
            return;
          }
        }
      },
      // Start a bit early so the block is ready by the time it is scrolled to.
      { rootMargin: "200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, visible]);
  return visible;
}
var init_useVisible = __esm({
  "src/lib/useVisible.ts"() {
    "use strict";
  }
});

// src/components/Mermaid.tsx
import { useEffect as useEffect17, useId as useId2, useMemo as useMemo6, useRef as useRef11, useState as useState17 } from "react";
import { Fragment as Fragment11, jsx as jsx20, jsxs as jsxs18 } from "react/jsx-runtime";
function readThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const bg = v("--bg-panel", "#313244");
  const bgAlt = v("--bg-alt", "#181825");
  const text = v("--text", "#cdd6f4");
  const textDim = v("--text-dim", "#a6adc8");
  const border = v("--border", "#45475a");
  return {
    primaryColor: bg,
    primaryTextColor: text,
    primaryBorderColor: border,
    lineColor: textDim,
    secondaryColor: bgAlt,
    tertiaryColor: bgAlt,
    background: "transparent",
    mainBkg: bg,
    nodeBorder: border,
    clusterBkg: bgAlt,
    clusterBorder: border,
    edgeLabelBackground: bg,
    textColor: text,
    titleColor: text,
    fontSize: "16px"
  };
}
async function loadMermaid() {
  if (!mermaidApi) {
    const mod = await import("mermaid");
    mermaidApi = mod.default;
  }
  if (!mermaidInit) {
    mermaidInit = true;
    try {
      mermaidApi.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: readThemeVars()
      });
    } catch {
    }
  }
  return mermaidApi;
}
function sanitizeChart(text) {
  return text.replace(BIDI_CONTROL_RE, "");
}
function hardenSvg(svg) {
  if (!svg || typeof DOMParser === "undefined") return svg;
  try {
    const doc = new DOMParser().parseFromString(svg, "text/html");
    const root = doc.querySelector("svg");
    if (!root) return svg;
    root.querySelectorAll("script").forEach((s) => s.remove());
    root.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/\s/g, "").toLowerCase();
        const isUrl = name === "href" || name === "xlink:href" || name === "src";
        const dangerous = value.startsWith("javascript:") || value.startsWith("data:text/html");
        const isLabelish = name === "title" || name.startsWith("aria-");
        if (name.startsWith("on") || dangerous && (isUrl || isLabelish)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return root.outerHTML;
  } catch {
    return svg;
  }
}
function Mermaid({ chart, embedded = false }) {
  const [svg, setSvg] = useState17(null);
  const [failed2, setFailed] = useState17(false);
  const renderTokenRef = useRef11(0);
  const mountedRef = useRef11(false);
  useEffect17(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      renderTokenRef.current += 1;
    };
  }, []);
  const myKey = useId2();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const expanded = activeKey === myKey;
  const blockRef = useRef11(null);
  const complete = Boolean(chart && !/[`~]{3}/.test(chart));
  const visible = useVisible(blockRef, complete);
  const renderDiagram = async () => {
    const token = ++renderTokenRef.current;
    const commit = () => mountedRef.current && token === renderTokenRef.current;
    setFailed(false);
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    const cleanChart = sanitizeChart(chart);
    if (!cleanChart.trim()) return;
    let mermaidMod;
    try {
      mermaidMod = await loadMermaid();
    } catch (err) {
      console.error("[Mermaid] engine failed to load:", err);
      if (commit()) setFailed(true);
      return;
    }
    if (token !== renderTokenRef.current || !mountedRef.current) return;
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    document.body.appendChild(container);
    const cleanup = () => {
      container.remove();
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    };
    mermaidMod.render(id, cleanChart, container).then((r) => {
      if (commit()) setSvg(applyRtlToSvgText(r.svg));
      return r;
    }).catch((err) => {
      console.error("[Mermaid] render failed, retrying with dark theme:", err);
      return mermaidMod.render(`${id}-retry`, cleanChart, container);
    }).then((r) => {
      if (r && commit()) setSvg(applyRtlToSvgText(r.svg));
    }).catch((err) => {
      console.error("[Mermaid] retry also failed, showing fallback:", err);
      if (commit()) setFailed(true);
    }).finally(cleanup);
  };
  useEffect17(() => {
    if (!visible) return;
    const t = setTimeout(() => void renderDiagram(), 400);
    return () => clearTimeout(t);
  }, [chart, visible]);
  if (failed2) {
    return /* @__PURE__ */ jsxs18(Fragment11, { children: [
      /* @__PURE__ */ jsx20(
        "pre",
        {
          className: "mermaid-fallback",
          dir: "auto",
          style: embedded ? void 0 : { cursor: "zoom-in" },
          title: embedded ? void 0 : "Click to expand",
          onClick: embedded ? void 0 : () => openFs(myKey),
          children: chart
        }
      ),
      !embedded && /* @__PURE__ */ jsx20(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx20("div", { className: "mermaid-fullscreen", children: /* @__PURE__ */ jsx20("pre", { className: "mermaid-fallback", dir: "auto", children: chart }) }) })
    ] });
  }
  const safeSvg = useMemo6(() => hardenSvg(svg), [svg]);
  if (!safeSvg) {
    return /* @__PURE__ */ jsxs18("div", { className: "mermaid-block mermaid-loading", ref: blockRef, "data-visible": String(visible), dir: "auto", children: [
      /* @__PURE__ */ jsx20("span", { className: "spinner" }),
      /* @__PURE__ */ jsx20("span", { children: "Diagram\u2026" })
    ] });
  }
  const diagram = /* @__PURE__ */ jsx20(
    "div",
    {
      className: "mermaid-block",
      ref: blockRef,
      dir: "auto",
      "data-visible": String(visible),
      style: embedded ? void 0 : { cursor: "zoom-in" },
      title: embedded ? void 0 : "Click to expand",
      onClick: embedded ? void 0 : () => openFs(myKey),
      dangerouslySetInnerHTML: { __html: safeSvg }
    }
  );
  if (embedded) return diagram;
  return /* @__PURE__ */ jsxs18(Fragment11, { children: [
    diagram,
    /* @__PURE__ */ jsx20(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx20("div", { className: "mermaid-fullscreen", children: safeSvg ? /* @__PURE__ */ jsx20("div", { className: "mermaid-block", dir: "auto", dangerouslySetInnerHTML: { __html: safeSvg } }) : /* @__PURE__ */ jsx20(Mermaid, { chart, embedded: true }) }) })
  ] });
}
var mermaidApi, mermaidInit, BIDI_CONTROL_RE;
var init_Mermaid = __esm({
  "src/components/Mermaid.tsx"() {
    "use strict";
    init_FullscreenModal();
    init_fullscreen();
    init_bidi();
    init_useVisible();
    mermaidApi = null;
    mermaidInit = false;
    BIDI_CONTROL_RE = /[\u200B\u200E\u200F\u2066-\u2069\u061C]/g;
  }
});

// src/components/message/doccard.tsx
import { memo as memo6, useMemo as useMemo7, useRef as useRef12, useState as useState18 } from "react";
import { jsx as jsx21, jsxs as jsxs19 } from "react/jsx-runtime";
function PlanDocCard({
  planDoc,
  messageId
}) {
  const [copied, setCopied] = useState18(false);
  const appDir = detectDir(planDoc.body);
  const preview = useMemo7(() => {
    const text = planDoc.body.replace(/```[\s\S]*?```/g, "\n[\u2026]\n").replace(/^#{1,6}\s+/gm, "").replace(/[*`>]/g, "").replace(/^plan\s*:?[ \t]*\n/i, "").trim();
    const clipped = text.length > 600 ? `${text.slice(0, 600).trimEnd()}\u2026` : text;
    return prepareContent(clipped);
  }, [planDoc.body]);
  const openFullPlan = () => {
    const st = useStore.getState();
    const owner = messageId ? st.chats.find((c2) => c2.messages.some((m) => m.id === messageId)) : void 0;
    if (owner && st.activeChatId !== owner.id) st.focusWindow(owner.id);
    useViewerTabs.getState().openPlan(owner?.id);
  };
  return /* @__PURE__ */ jsxs19("div", { className: "plan-doc-card", dir: appDir, children: [
    /* @__PURE__ */ jsxs19("div", { className: "plan-doc-head", children: [
      /* @__PURE__ */ jsx21("span", { className: "plan-doc-icon", "aria-hidden": "true", children: /* @__PURE__ */ jsxs19(
        "svg",
        {
          width: "13",
          height: "13",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: [
            /* @__PURE__ */ jsx21("rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }),
            /* @__PURE__ */ jsx21("path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" })
          ]
        }
      ) }),
      /* @__PURE__ */ jsx21("span", { className: "plan-doc-label", children: "Plan" }),
      planDoc.title ? /* @__PURE__ */ jsx21("span", { className: "plan-doc-title", children: planDoc.title }) : null,
      /* @__PURE__ */ jsx21("span", { className: "plan-doc-spacer" }),
      /* @__PURE__ */ jsx21(
        "button",
        {
          type: "button",
          className: `plan-doc-copy${copied ? " copied" : ""}`,
          title: "Copy plan",
          "aria-label": "Copy plan",
          onClick: () => {
            void copyToClipboard(planDoc.body);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          children: copied ? /* @__PURE__ */ jsx21(
            "svg",
            {
              width: "12",
              height: "12",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2.2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              children: /* @__PURE__ */ jsx21("path", { d: "M20 6L9 17l-5-5" })
            }
          ) : /* @__PURE__ */ jsxs19(
            "svg",
            {
              width: "12",
              height: "12",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              children: [
                /* @__PURE__ */ jsx21("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                /* @__PURE__ */ jsx21("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
              ]
            }
          )
        }
      )
    ] }),
    /* @__PURE__ */ jsx21("div", { className: "plan-doc-preview", children: preview }),
    /* @__PURE__ */ jsxs19(
      "button",
      {
        type: "button",
        className: "plan-doc-open",
        onClick: openFullPlan,
        children: [
          "View full plan",
          /* @__PURE__ */ jsx21(
            "svg",
            {
              width: "12",
              height: "12",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2.4",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              children: /* @__PURE__ */ jsx21("path", { d: "M5 12h14M13 6l6 6-6 6" })
            }
          )
        ]
      }
    )
  ] });
}
function textFromChildren(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromChildren).join("");
  if (typeof node === "object" && "props" in node) {
    return textFromChildren(
      node.props.children
    );
  }
  return "";
}
function openExternalPreferred(url) {
  const coder = window.coder;
  if (coder && typeof coder.openExternalChrome === "function") {
    void coder.openExternalChrome(url);
    return;
  }
  void coder?.openExternal?.(url);
}
function codeLang(children) {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = k?.props;
    const m = props?.className ? /language-([\w-]+)/.exec(String(props.className)) : null;
    if (m) return m[1];
  }
  return "";
}
function codeStartLine(children) {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = k?.props;
    const meta = (props?.["data-meta"] ?? "").replace(/[۰-۹]/g, (d) => String("\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9".indexOf(d)));
    const m = (
      // form 1: "19-20:path" — start before "-"
      /(\d+)(?=-\d+:)/.exec(meta) ?? // form 2: ":19-20:path" — start after ":" and before "-"
      /:(\d+)(?=-)/.exec(meta) ?? // form 3: "32:path" (single line) — digits right after ":" before next ":" or end
      /:(\d+)(?=[:\b]|$)/.exec(meta) ?? (props?.className ? /language-[\w-]+:(\d+)(?:-\d+)?/.exec(String(props.className)) : null)
    );
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) return n;
    }
    const raw = typeof props?.children === "string" ? props.children : "";
    if (raw) {
      const fallback = /\(\s*(?:خط|Line|line)\s*([\d۰-۹]+)\s*\)/.exec(raw);
      if (fallback) {
        const n = parseInt(fallback[1].replace(/[۰-۹]/g, (d) => String("\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9".indexOf(d))), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
  }
  return 0;
}
function codeFilePath(children) {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = k?.props;
    const meta = props?.["data-meta"] ?? "";
    const m = /\d+(?:-\d+)?:((?:[\w\/\\-]+\/)*[\w\/\\-]*[\w.-]+\.\w+)$/.exec(meta);
    if (m) return m[1];
  }
  return "";
}
function _ytId(u) {
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1);
    return id || null;
  }
  if (!u.hostname.includes("youtube.com")) return null;
  const v = u.searchParams.get("v");
  if (v) return v;
  const shorts = /\/shorts\/([\w-]+)/.exec(u.pathname);
  if (shorts) return shorts[1];
  const embed = /\/embed\/([\w-]+)/.exec(u.pathname);
  return embed ? embed[1] : null;
}
function _vimeoId(u) {
  if (u.hostname !== "vimeo.com" && u.hostname !== "player.vimeo.com") return null;
  return /\/video\/(\d+)/.exec(u.pathname)?.[1] ?? /^\/(\d+)/.exec(u.pathname)?.[1] ?? null;
}
function extractVideoEmbed(href) {
  try {
    const u = new URL(href);
    const ytId = _ytId(u);
    if (ytId) {
      return {
        platform: "youtube",
        videoUrl: `https://www.youtube.com/watch?v=${ytId}`,
        // maxresdefault falls back to hqdefault automatically
        thumbnailUrl: `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`,
        title: "YouTube video"
      };
    }
    const vmId = _vimeoId(u);
    if (vmId) {
      return {
        platform: "vimeo",
        videoUrl: `https://vimeo.com/${vmId}`,
        // Vimeo thumbnail via oEmbed isn't available client-side, use placeholder
        thumbnailUrl: `https://vumbnail.com/${vmId}.jpg`,
        title: "Vimeo video"
      };
    }
  } catch {
  }
  return null;
}
function MarkdownImage({
  src,
  alt,
  ...props
}) {
  const [errored, setErrored] = useState18(false);
  const [retryTick, setRetryTick] = useState18(0);
  const retriesLeft = useRef12(3);
  const resolved = useMemo7(
    () => resolveLocalMedia(src, peekSidecarUrl()),
    // retryTick forces the re-resolve after ensureSidecar() succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the tick IS the signal
    [src, retryTick]
  );
  const retryOrError = () => {
    const isLocalMedia = Boolean(resolveLocalMedia(src, "http://retry-probe.invalid"));
    if (isLocalMedia && retriesLeft.current > 0) {
      retriesLeft.current -= 1;
      void ensureSidecar().then((url) => {
        if (url) setRetryTick((t) => t + 1);
        else setErrored(true);
      });
      return;
    }
    setErrored(true);
  };
  if (resolved?.video) {
    if (errored) {
      return /* @__PURE__ */ jsx21("span", { className: "md-image-wrap md-image-errored", children: /* @__PURE__ */ jsxs19("span", { className: "md-image-fallback", children: [
        "\u{1F3AC} ",
        alt || "Video unavailable"
      ] }) });
    }
    return /* @__PURE__ */ jsxs19("span", { className: "md-image-wrap md-media-wrap", children: [
      /* @__PURE__ */ jsx21(
        "video",
        {
          className: "md-video-inline",
          src: resolved.url,
          controls: true,
          preload: "metadata",
          onError: retryOrError
        }
      ),
      /* @__PURE__ */ jsx21(
        "button",
        {
          type: "button",
          className: "md-media-edit",
          title: "Open in the Media editor",
          onClick: () => useViewerTabs.getState().openMedia(resolved.path),
          children: EDIT_ICON
        }
      )
    ] });
  }
  const effectiveSrc = resolved?.url ?? src;
  if (!effectiveSrc || errored) {
    return /* @__PURE__ */ jsx21("span", { className: "md-image-wrap md-image-errored", children: /* @__PURE__ */ jsxs19("span", { className: "md-image-fallback", children: [
      "\u{1F5BC}\uFE0F ",
      alt || "Image unavailable"
    ] }) });
  }
  return /* @__PURE__ */ jsxs19("span", { className: `md-image-wrap${resolved ? " md-media-wrap" : ""}`, children: [
    /* @__PURE__ */ jsx21(
      "img",
      {
        src: effectiveSrc,
        alt: alt ?? "",
        loading: "lazy",
        onClick: resolved ? () => useViewerTabs.getState().openMedia(resolved.path) : void 0,
        style: resolved ? { cursor: "pointer" } : void 0,
        onError: retryOrError,
        ...props
      }
    ),
    resolved && /* @__PURE__ */ jsx21(
      "button",
      {
        type: "button",
        className: "md-media-edit",
        title: "Open in the Media editor",
        onClick: (e) => {
          e.stopPropagation();
          useViewerTabs.getState().openMedia(resolved.path);
        },
        children: EDIT_ICON
      }
    ),
    alt ? /* @__PURE__ */ jsx21("span", { className: "md-image-caption", children: alt }) : null
  ] });
}
function VideoThumbnailCard({
  video,
  href,
  children
}) {
  const [thumbErr, setThumbErr] = useState18(false);
  const label = children?.toString().trim() || video.title;
  const openVideo = () => void window.coder.openExternal(video.videoUrl);
  return /* @__PURE__ */ jsxs19(
    "span",
    {
      className: "md-video-card",
      onClick: openVideo,
      role: "button",
      tabIndex: 0,
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") openVideo();
      },
      children: [
        !thumbErr ? /* @__PURE__ */ jsx21(
          "img",
          {
            className: "md-video-thumb",
            src: video.thumbnailUrl,
            alt: label,
            loading: "lazy",
            onError: () => setThumbErr(true)
          }
        ) : /* @__PURE__ */ jsx21("span", { className: "md-video-thumb md-video-thumb-fallback", children: "\u{1F3AC}" }),
        /* @__PURE__ */ jsx21("span", { className: "md-video-play", children: "\u25B6" }),
        /* @__PURE__ */ jsx21("span", { className: "md-video-label", children: label })
      ]
    }
  );
}
var CodeBlock, EDIT_ICON;
var init_doccard = __esm({
  "src/components/message/doccard.tsx"() {
    "use strict";
    init_api();
    init_bidi();
    init_clipboard();
    init_highlight();
    init_mediaUrl();
    init_store();
    init_viewerTabs();
    init_ChartBlock();
    init_FileIcon();
    init_Mermaid();
    CodeBlock = memo6(function CodeBlock2(props) {
      const [copied, setCopied] = useState18(false);
      const chipProps = (() => {
        const kid = Array.isArray(props.children) ? props.children[0] : props.children;
        const p = kid && typeof kid === "object" && "props" in kid ? kid.props : void 0;
        return p && typeof p.path === "string" ? p : void 0;
      })();
      const code = (textFromChildren(props.children) || (chipProps ? String(chipProps.display ?? chipProps.path) : "")).replace(/^\n+|\n+$/g, "");
      const lang = codeLang(props.children);
      const startLine = codeStartLine(props.children);
      const filePath = codeFilePath(props.children);
      const codeLines = code.split("\n");
      const copy = async () => {
        try {
          await copyToClipboard(codeLines.join("\n"));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (err) {
          console.warn("copy failed", err);
        }
      };
      const highlightedLines = useMemo7(
        () => getHighlightedLines(codeLines.join("\n"), lang),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [code, lang]
      );
      if ((!lang || lang === "text") && isMostlyRtlText(code)) {
        return /* @__PURE__ */ jsx21("pre", { dir: "auto", className: "plain-fence", children: code });
      }
      if (lang === "mermaid") {
        return /* @__PURE__ */ jsx21(Mermaid, { chart: code });
      }
      if (lang === "chart") {
        return /* @__PURE__ */ jsx21(ChartBlock, { spec: code });
      }
      const lines = codeLines.map((_line, i) => {
        const num = startLine > 0 ? startLine + i : i + 1;
        const html = highlightedLines[i] ?? "";
        return /* @__PURE__ */ jsxs19("span", { className: "code-line", children: [
          /* @__PURE__ */ jsx21("span", { className: "code-gutter", "aria-hidden": "true", children: num }),
          /* @__PURE__ */ jsx21(
            "span",
            {
              className: "code-text",
              dangerouslySetInnerHTML: { __html: html === "" ? "\n" : html }
            }
          ),
          "\n"
        ] }, i);
      });
      return /* @__PURE__ */ jsxs19("div", { className: "code-block", children: [
        /* @__PURE__ */ jsxs19("div", { className: "code-block-head", children: [
          filePath && /* @__PURE__ */ jsxs19(
            "span",
            {
              className: "code-block-path code-block-path-open",
              title: `Open ${filePath}`,
              onPointerDown: () => openWorkspaceFile(filePath),
              children: [
                /* @__PURE__ */ jsx21(FileIcon, { path: filePath, size: 20 }),
                filePath
              ]
            }
          ),
          /* @__PURE__ */ jsx21("span", { className: "code-block-lang", children: lang || "code" }),
          /* @__PURE__ */ jsx21("button", { className: "copy-btn", onClick: copy, children: copied ? "Copied \u2713" : "Copy" })
        ] }),
        /* @__PURE__ */ jsx21("pre", { ...props, dir: "ltr", className: "code-lines hljs", children: lines })
      ] });
    });
    EDIT_ICON = /* @__PURE__ */ jsx21("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx21("path", { d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" }) });
  }
});

// src/lib/arrowDir.ts
function operandRange(text, from, to, dir) {
  let start;
  let end;
  if (dir < 0) {
    end = from;
    while (end > 0 && SPACE.test(text[end - 1])) end--;
    start = end;
    while (start > 0 && !SPACE.test(text[start - 1]) && !isArrowChar(text[start - 1])) start--;
  } else {
    start = to;
    while (start < text.length && SPACE.test(text[start])) start++;
    end = start;
    while (end < text.length && !SPACE.test(text[end]) && !isArrowChar(text[end])) end++;
  }
  while (start < end && OPEN_PUNCT.test(text[start])) start++;
  while (end > start && CLOSE_PUNCT.test(text[end - 1])) end--;
  return end > start ? [start, end] : null;
}
function splitText(text) {
  const pieces = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (start, end, kind) => {
    const key = `${kind}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    pieces.push({ start, end, kind });
  };
  for (const m of text.matchAll(ARROW_GLOBAL)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    const left = operandRange(text, from, to, -1);
    const right = operandRange(text, from, to, 1);
    if (left) push(left[0], left[1], "operand");
    push(from, to, "arrow");
    if (right) push(right[0], right[1], "operand");
  }
  pieces.sort((x, y) => x.start - y.start);
  const out = [];
  let last = 0;
  for (const piece of pieces) {
    if (piece.start < last) continue;
    if (piece.start > last) out.push({ type: "text", value: text.slice(last, piece.start) });
    const value = text.slice(piece.start, piece.end);
    out.push({
      type: "element",
      tagName: "span",
      properties: piece.kind === "arrow" ? { className: ["md-arrow"] } : { className: ["md-op"], dir: "ltr" },
      children: [{ type: "text", value }]
    });
    last = piece.end;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
function wrapArrows(node) {
  if (!node.children) return;
  if (node.type === "element" && node.tagName && SKIP_TAGS2.has(node.tagName)) return;
  const out = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && HAS_ARROW.test(child.value)) {
      out.push(...splitText(child.value));
    } else {
      wrapArrows(child);
      out.push(child);
    }
  }
  node.children = out;
}
function rehypeArrows() {
  return (tree) => wrapArrows(tree);
}
function flowRunsLeft(prev, next) {
  const h = Math.min(prev.bottom - prev.top, next.bottom - next.top);
  const dy = Math.abs((prev.top + prev.bottom) / 2 - (next.top + next.bottom) / 2);
  if (!(h > 0) || dy > h * 0.6) return null;
  const dx = (next.left + next.right) / 2 - (prev.left + prev.right) / 2;
  if (Math.abs(dx) < 1) return null;
  return dx < 0;
}
function neighbourBox(arrow, dir) {
  const block = arrow.closest(BLOCK_SELECTOR) ?? arrow.parentElement;
  const own = arrow.firstChild;
  if (!block || !own) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  walker.currentNode = own;
  for (let node = dir < 0 ? walker.previousNode() : walker.nextNode(); node; node = dir < 0 ? walker.previousNode() : walker.nextNode()) {
    const text = node.nodeValue ?? "";
    let i = dir < 0 ? text.length - 1 : 0;
    while (i >= 0 && i < text.length && SPACE.test(text[i])) i += dir;
    if (i < 0 || i >= text.length) continue;
    let start = i;
    let end = i + 1;
    const code = text.charCodeAt(i);
    if (code >= 56320 && code <= 57343 && i > 0) start = i - 1;
    else if (code >= 55296 && code <= 56319 && i + 1 < text.length) end = i + 2;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0);
    if (rect) return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    return null;
  }
  return null;
}
function setMirrored(el, on) {
  if (on) {
    el.style.display = "inline-block";
    el.style.transform = "scaleX(-1)";
  } else {
    el.style.removeProperty("display");
    el.style.removeProperty("transform");
  }
}
function fixArrowDirections(root) {
  root.querySelectorAll(".md-arrow").forEach((el) => {
    let left = null;
    try {
      const prev = neighbourBox(el, -1);
      const next = neighbourBox(el, 1);
      if (prev && next) left = flowRunsLeft(prev, next);
    } catch {
      left = null;
    }
    setMirrored(el, left === true);
  });
}
var ARROW_CHARS, ARROW_RE_SRC, ARROW_GLOBAL, HAS_ARROW, SPACE, OPEN_PUNCT, CLOSE_PUNCT, SKIP_TAGS2, isArrowChar, BLOCK_SELECTOR;
var init_arrowDir = __esm({
  "src/lib/arrowDir.ts"() {
    "use strict";
    ARROW_CHARS = "\u2192\u27F6\u21D2\u27F9\u2794\u279C\u279E\u21A6";
    ARROW_RE_SRC = `[${ARROW_CHARS}][\\uFE0E\\uFE0F]?`;
    ARROW_GLOBAL = new RegExp(ARROW_RE_SRC, "g");
    HAS_ARROW = new RegExp(`[${ARROW_CHARS}]`);
    SPACE = /\s/;
    OPEN_PUNCT = /[(\[{«"'“‘<]/;
    CLOSE_PUNCT = /[)\]}»"'”’>.,:;!?،؛؟…]/;
    SKIP_TAGS2 = /* @__PURE__ */ new Set(["code", "pre", "a"]);
    isArrowChar = (c2) => c2 !== void 0 && (ARROW_CHARS.includes(c2) || c2 === "\uFE0E" || c2 === "\uFE0F");
    BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div";
  }
});

// src/components/message/markdown.tsx
import { memo as memo7, useLayoutEffect as useLayoutEffect3, useRef as useRef13 } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Fragment as Fragment12, jsx as jsx22 } from "react/jsx-runtime";
function keepFileUrls(url) {
  return /^(file|codifa-media):/i.test(url) ? url : defaultUrlTransform(url);
}
var mdComponents, PROSE_REMARK_PLUGINS, PROSE_REHYPE_PLUGINS, MarkdownProse;
var init_markdown = __esm({
  "src/components/message/markdown.tsx"() {
    "use strict";
    init_arrowDir();
    init_bidi();
    init_fileTypes();
    init_link();
    init_ltrIslands();
    init_FileIcon();
    init_doccard();
    mdComponents = {
      // react-markdown only puts the language in `className` and DROPS the rest of
      // the info string (e.g. `go:19-20:Plan.go` -> className `language-go`). We
      // stash the full meta (`19-20:Plan.go`) on `data-meta` so CodeBlock can read
      // the real line range and file name that foldLineCaptions injected.
      code: (props) => {
        const node = props.node;
        let meta = node?.data?.meta ?? "";
        if (!meta) {
          const cn = String(node?.properties?.className ?? props.className ?? "");
          const m = /^language-[\w-]+:(.+)/.exec(cn);
          if (m) meta = m[1];
        }
        if (!meta) {
          const text = textFromChildren(props.children);
          if (!text.includes("\n")) {
            const urlParts = splitTextByUrls(text);
            if (urlParts.some((p) => typeof p !== "string")) {
              if (urlParts.length === 1 && typeof urlParts[0] !== "string") {
                const url = urlParts[0].url;
                return /* @__PURE__ */ jsx22(
                  "a",
                  {
                    href: url,
                    target: "_blank",
                    rel: "noreferrer",
                    onClick: (e) => {
                      handleLinkClick(e, url, openExternalPreferred);
                    },
                    children: url
                  }
                );
              }
              return (
                // One LTR island around the WHOLE split (chip pieces + links): as
                // separate siblings each piece is an isolated unit and the RTL
                // line orders them right-to-left, turning "/plugin install URL"
                // into "URL … install". Inside a single dir=ltr isolate the
                // pieces keep their left-to-right command order in both message
                // directions.
                /* @__PURE__ */ jsx22("span", { dir: "ltr", className: "ltr-island", children: urlParts.map(
                  (p, i) => typeof p === "string" ? /* @__PURE__ */ jsx22("code", { "data-meta": meta, children: p }, i) : /* @__PURE__ */ jsx22(
                    "a",
                    {
                      href: p.url,
                      target: "_blank",
                      rel: "noreferrer",
                      onClick: (e) => {
                        handleLinkClick(e, p.url, openExternalPreferred);
                      },
                      children: p.url
                    },
                    i
                  )
                ) })
              );
            }
          }
          if (looksLikeFilePath(text)) {
            const { path, line } = splitPathLine(text);
            return /* @__PURE__ */ jsx22(FileChip, { path, line, display: text });
          }
          const parts = extractInlinePathParts(text);
          if (parts.some((p) => typeof p !== "string")) {
            return /* @__PURE__ */ jsx22("code", { ...props, "data-meta": meta, children: parts.map(
              (p, i) => typeof p === "string" ? p : /* @__PURE__ */ jsx22(FileChip, { path: p.path, line: p.line, display: p.display }, i)
            ) });
          }
        }
        return /* @__PURE__ */ jsx22("code", { ...props, "data-meta": meta, children: props.children });
      },
      img: (props) => /* @__PURE__ */ jsx22(MarkdownImage, { ...props }),
      a: (props) => {
        const href = props.href ?? "";
        const video = extractVideoEmbed(href);
        if (video) {
          return /* @__PURE__ */ jsx22(
            VideoThumbnailCard,
            {
              video,
              href,
              children: props.children
            }
          );
        }
        const fileRef = filePathFromHref(href);
        if (fileRef) {
          const label = typeof props.children === "string" && props.children ? props.children : href;
          return /* @__PURE__ */ jsx22(
            FileChip,
            {
              path: fileRef.path,
              line: fileRef.line,
              display: String(label)
            }
          );
        }
        if (!href) {
          return /* @__PURE__ */ jsx22(Fragment12, { children: props.children });
        }
        return /* @__PURE__ */ jsx22(
          "a",
          {
            ...props,
            target: "_blank",
            rel: "noreferrer",
            onClick: (e) => {
              handleLinkClick(e, props.href, openExternalPreferred);
            }
          }
        );
      },
      pre: (props) => /* @__PURE__ */ jsx22(CodeBlock, { ...props }),
      table: ({
        node: _node,
        ...props
      }) => /* @__PURE__ */ jsx22("div", { className: "markdown-table-scroll", children: /* @__PURE__ */ jsx22("table", { ...props }) })
    };
    PROSE_REMARK_PLUGINS = [remarkGfm];
    PROSE_REHYPE_PLUGINS = [rehypeArrows, rehypeLtrIslands];
    MarkdownProse = memo7(function MarkdownProse2({ text }) {
      const ref = useRef13(null);
      useLayoutEffect3(() => {
        if (ref.current) fixArrowDirections(ref.current);
      }, [text]);
      return (
        // dir from the WHOLE text (any Persian char → rtl), not dir="auto": a
        // mostly-Persian message that opens with a Latin word or heading
        // ("## EUR/USD تحلیل…") must not flip the whole block to LTR.
        /* @__PURE__ */ jsx22("div", { ref, className: "chat-message markdown-body", dir: detectDir(text), children: /* @__PURE__ */ jsx22(
          ReactMarkdown,
          {
            remarkPlugins: PROSE_REMARK_PLUGINS,
            rehypePlugins: PROSE_REHYPE_PLUGINS,
            urlTransform: keepFileUrls,
            components: mdComponents,
            children: text
          }
        ) })
      );
    });
  }
});

// src/lib/errorText.ts
function unescapeJson(s) {
  return s.replace(/\\(["\\/bfnrt])/g, (_m, c2) => {
    switch (c2) {
      case "n":
      case "b":
      case "f":
      case "r":
      case "t":
        return " ";
      default:
        return c2 === "/" ? "/" : c2;
    }
  });
}
function deepestMessage(s) {
  const re = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const all = [...s.matchAll(re)];
  if (!all.length) return null;
  return unescapeJson(all[all.length - 1][1]).trim() || null;
}
function humanizeError(raw, max = 140) {
  if (!raw) return "";
  let s = raw.replace(INVISIBLE2, "");
  const decoded = unescapeJson(s);
  const inner = deepestMessage(decoded);
  if (inner) {
    const blob = /\{[\s\S]*\}/;
    s = blob.test(s) && blob.test(s) && /"message"/.test(decoded) ? s.replace(/\{[\s\S]*\}/, inner) : decoded;
  }
  s = s.replace(/\{\s*\}/g, "").replace(/\[\s*\]/g, "").replace(/\s*[:;,]\s*(?=[—–-]|$)/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}
function fallbackReason(raw, max = 120) {
  const s = raw.replace(INVISIBLE2, "").replace(/^\s*[^:]{1,40}?\bfailed\s*:\s*/i, "").replace(/\s*[—–-]\s*trying the next model\s*$/i, "");
  return humanizeError(s, max);
}
var INVISIBLE2;
var init_errorText = __esm({
  "src/lib/errorText.ts"() {
    "use strict";
    INVISIBLE2 = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
  }
});

// src/components/ExploreCard.tsx
function exploreToolCounts(activity) {
  const counts = /* @__PURE__ */ new Map();
  const walk = (list) => {
    for (const a of list ?? []) {
      if (a.tool === "batch") {
        const ops = batchOpTools(a);
        if (ops.length > 0) {
          for (const tool of ops) {
            const label2 = toolLabel(tool);
            const cur2 = counts.get(label2);
            if (cur2) {
              cur2.count += 1;
            } else {
              counts.set(label2, { tool, label: label2, count: 1 });
            }
          }
          continue;
        }
      }
      const label = toolLabel(a.tool);
      const cur = counts.get(label);
      if (cur) {
        cur.count += 1;
      } else {
        counts.set(label, { tool: a.tool, label, count: 1 });
      }
      walk(a.children);
    }
  };
  walk(activity.children);
  return [...counts.values()];
}
var init_ExploreCard = __esm({
  "src/components/ExploreCard.tsx"() {
    "use strict";
    init_ToolCallView();
    init_naming();
  }
});

// src/components/message/thinking.tsx
import { useEffect as useEffect18, useRef as useRef14, useState as useState19 } from "react";
import { Fragment as Fragment13, jsx as jsx23, jsxs as jsxs20 } from "react/jsx-runtime";
function ThinkingBlock({ text }) {
  const [open, setOpen] = useState19(false);
  const [height, setHeight] = useState19(THINKING_DEFAULT_H);
  const textRef = useRef14(null);
  const stickToBottom = useRef14(true);
  const drag = useRef14(null);
  const resizeCleanupRef = useRef14(null);
  const empty = text.trim().length === 0;
  const lastLine = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const label = empty ? "Thinking\u2026" : open ? "Hide thinking" : lastLine ? `Thinking \u2014 ${lastLine}` : "Thinking\u2026";
  useEffect18(() => {
    const el = textRef.current;
    if (!el || !open || empty || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open, empty]);
  useEffect18(() => () => resizeCleanupRef.current?.(), []);
  const startResize = (e) => {
    e.preventDefault();
    drag.current = { startY: e.clientY, startH: height };
    const onMove = (ev) => {
      if (!drag.current) return;
      const next = drag.current.startH + (ev.clientY - drag.current.startY);
      setHeight(Math.max(THINKING_MIN_H, Math.min(THINKING_MAX_H, next)));
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    resizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };
  return /* @__PURE__ */ jsxs20(
    "div",
    {
      className: `thinking-block ${open ? "open" : ""}${empty ? " busy" : ""}`,
      children: [
        /* @__PURE__ */ jsxs20("button", { className: "thinking-head", onClick: () => setOpen((o) => !o), children: [
          /* @__PURE__ */ jsx23("span", { className: `thinking-dot${empty ? " busy" : ""}`, children: empty ? /* @__PURE__ */ jsx23("span", { className: "spinner" }) : "\u2726" }),
          /* @__PURE__ */ jsx23("span", { className: "thinking-label", children: label }),
          !empty && /* @__PURE__ */ jsx23("span", { className: `chev ${open ? "open" : ""}`, children: "\u25BE" })
        ] }),
        open && !empty && /* @__PURE__ */ jsxs20(Fragment13, { children: [
          /* @__PURE__ */ jsx23(
            "div",
            {
              className: "thinking-text",
              ref: textRef,
              style: { height },
              dir: detectDir(text),
              onScroll: (e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              },
              children: cachedPrepareText(text)
            }
          ),
          /* @__PURE__ */ jsx23(
            "div",
            {
              className: "thinking-resizer",
              role: "separator",
              "aria-orientation": "horizontal",
              "aria-label": "Resize thinking panel",
              onPointerDown: startResize,
              children: /* @__PURE__ */ jsx23("span", { className: "thinking-resizer-grip" })
            }
          )
        ] })
      ]
    }
  );
}
function computeLeft(delay, startedAt) {
  if (delay <= 0) return 0;
  if (!startedAt) return Math.ceil(delay);
  const deadline = startedAt + delay * 1e3;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1e3));
}
function InlineRetryLine({
  retry,
  sub,
  onManualRetry
}) {
  const [left, setLeft] = useState19(() => computeLeft(retry.delay, retry.startedAt));
  useEffect18(() => {
    const tick = () => setLeft(computeLeft(retry.delay, retry.startedAt));
    tick();
    if (retry.delay <= 0 || retry.gaveUp) return;
    const t = setInterval(tick, 250);
    const sync = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [retry.delay, retry.startedAt, retry.attempt, retry.gaveUp]);
  const gaveUp = retry.gaveUp === true;
  const subLive = sub && !gaveUp ? sub : null;
  const isStatus = retry.status === true;
  const progressPct = isStatus && typeof retry.percent === "number" ? Math.max(0, Math.min(100, Math.round(retry.percent))) : null;
  const detail = retry.fallback ? fallbackReason(retry.reason ?? "") : humanizeError(retry.reason ?? "");
  const fullDetail = retry.fallback ? fallbackReason(retry.reason ?? "", 1e5) : humanizeError(retry.reason ?? "", 1e5);
  const subagentRows = useStore((s) => s.customSubagents);
  const toolName = retry.tool ? subagentDisplayName(retry.tool, subagentRows) : "";
  const agentLabel = retry.agent ?? "";
  const namedByAgent = !!retry.tool && !!agentLabel && (agentLabel.toLowerCase().includes(retry.tool.toLowerCase()) || !!toolName && agentLabel.toLowerCase().includes(toolName.toLowerCase()));
  const who = [
    agentLabel,
    retry.tool && agentLabel && !namedByAgent ? `tool: ${toolName}` : ""
  ].filter(Boolean).join(", ");
  const counting = !gaveUp && retry.delay > 0;
  const countdown = counting && left > 0 ? `${left}s` : "";
  const cap = retry.maxAttempts > 1 ? `${retry.attempt}/${retry.maxAttempts}` : `${retry.attempt}`;
  const label = retry.fallback ? gaveUp ? "sub-agent failed" : "switched model" : isStatus ? retry.reason ?? "" : gaveUp ? retry.maxAttempts > 1 ? `failed after ${retry.attempt} tries` : "failed" : `retry ${cap}`;
  const shownLabel = subLive ? subLive.model || label : label;
  const tone = progressPct !== null ? "progress" : gaveUp ? "error" : subLive ? (
    // A live sub-agent line reads as status (accent), never as the
    // warn/error the word "switched model" + red body used to paint.
    "info"
  ) : retry.fallback ? "warn" : isStatus ? "info" : "retry";
  return (
    // NO `dir` on this span: it is the ABSOLUTELY POSITIONED element, and a
    // `dir` here would make `inset-inline-end` resolve against THAT direction
    // instead of the footer's — in RTL the line then stayed pinned right.
    // The LTR pin belongs on the inner wrapper, which is what keeps the
    // "↻ retry 7/10 — reason — in 7s" order stable.
    /* @__PURE__ */ jsxs20(
      "span",
      {
        className: "msg-retry-inline",
        "data-state": tone,
        "data-full-error": fullDetail || retry.reason || void 0,
        children: [
          /* @__PURE__ */ jsxs20("span", { className: "msg-retry-inline-row", dir: "ltr", children: [
            /* @__PURE__ */ jsxs20("span", { className: "msg-retry-inline-head", dir: "ltr", children: [
              who && /* @__PURE__ */ jsx23("span", { className: "msg-retry-inline-who", children: who }),
              /* @__PURE__ */ jsx23(
                "span",
                {
                  className: `msg-retry-inline-count${subLive ? " msg-retry-inline-model" : ""}`,
                  title: subLive?.model || void 0,
                  children: shownLabel
                }
              ),
              progressPct !== null && // The number sits in the head; the determinate bar is drawn as the
              // chip's own bottom edge (below), so it adds height, not width, and
              // cannot crowd the clock/timer beside the footer.
              /* @__PURE__ */ jsxs20("span", { className: "msg-retry-inline-pct", children: [
                progressPct,
                "%"
              ] })
            ] }),
            counting && // Dots + countdown are their own group placed right after the counter.
            // They used to live at the END of the line, which put them after the
            // ellipsized reason ("…reached…  • • •") where they read as part of
            // the sentence instead of as activity.
            /* @__PURE__ */ jsxs20("span", { className: "msg-retry-inline-wait", dir: "ltr", children: [
              /* @__PURE__ */ jsxs20("span", { className: "msg-retry-inline-dots", "aria-hidden": true, children: [
                /* @__PURE__ */ jsx23("i", {}),
                /* @__PURE__ */ jsx23("i", {}),
                /* @__PURE__ */ jsx23("i", {})
              ] }),
              countdown && /* @__PURE__ */ jsx23("span", { className: "msg-retry-inline-wait-label", children: countdown })
            ] }),
            subLive ? subLive.tools.length > 0 && /* @__PURE__ */ jsx23("span", { className: "msg-retry-inline-tools", dir: "ltr", children: subLive.tools.join(" \xB7 ") }) : detail && !isStatus && /* @__PURE__ */ jsx23(
              "span",
              {
                className: "msg-retry-inline-reason",
                dir: "ltr",
                "data-full-error": fullDetail || detail,
                children: detail
              }
            ),
            gaveUp && onManualRetry && /* @__PURE__ */ jsxs20(
              "button",
              {
                className: "msg-retry-inline-btn",
                onClick: onManualRetry,
                "aria-label": "Retry \u2014 resumes where it stopped without redoing completed work",
                dir: "ltr",
                children: [
                  /* @__PURE__ */ jsx23("span", { className: "msg-retry-inline-btn-icon", "aria-hidden": true, children: "\u21BB" }),
                  "Retry"
                ]
              }
            )
          ] }),
          progressPct !== null && /* @__PURE__ */ jsx23(
            "span",
            {
              className: "msg-retry-inline-bar",
              role: "progressbar",
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": progressPct,
              children: /* @__PURE__ */ jsx23(
                "span",
                {
                  className: "msg-retry-inline-bar-fill",
                  style: { width: `${progressPct}%` }
                }
              )
            }
          )
        ]
      }
    )
  );
}
function subRetryInfo(retry, toolActivity) {
  if (!retry.tool || retry.status) return void 0;
  const runs = (toolActivity ?? []).filter((a) => a.tool === retry.tool);
  const run = runs.find((a) => a.status === "running") ?? runs[runs.length - 1];
  if (!run && !retry.model) return void 0;
  return {
    model: retry.model || run?.model || "",
    tools: run ? exploreToolCounts(run).map((c2) => `${c2.label} \xD7${c2.count}`) : []
  };
}
function localWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
function ThinkingIndicator({
  startedAt,
  label = "Thinking",
  thinking = false
}) {
  const [elapsed, setElapsed] = useState19(() => {
    const base2 = startedAt ?? Date.now();
    return Date.now() - base2;
  });
  useEffect18(() => {
    const base2 = startedAt ?? Date.now();
    setElapsed(Date.now() - base2);
    const id = setInterval(() => setElapsed(Date.now() - base2), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return /* @__PURE__ */ jsx23("span", { className: "msg-thinking", "aria-label": label, children: /* @__PURE__ */ jsxs20("span", { className: "msg-thinking-inner", dir: "ltr", children: [
    thinking && // Brain glyph (lucide-style, stroke-based): reads as "reasoning"
    // where the old four-point spark read as generic sparkle.
    /* @__PURE__ */ jsxs20(
      "svg",
      {
        className: "msg-thinking-icon",
        width: "12",
        height: "12",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: [
          /* @__PURE__ */ jsx23("path", { d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" }),
          /* @__PURE__ */ jsx23("path", { d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" }),
          /* @__PURE__ */ jsx23("path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" }),
          /* @__PURE__ */ jsx23("path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375" }),
          /* @__PURE__ */ jsx23("path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5" }),
          /* @__PURE__ */ jsx23("path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396" }),
          /* @__PURE__ */ jsx23("path", { d: "M19.938 10.5a4 4 0 0 1 .585.396" }),
          /* @__PURE__ */ jsx23("path", { d: "M6 18a4 4 0 0 1-1.967-.516" }),
          /* @__PURE__ */ jsx23("path", { d: "M19.967 17.484A4 4 0 0 1 18 18" })
        ]
      }
    ),
    /* @__PURE__ */ jsx23("span", { className: "msg-thinking-text", children: label }),
    /* @__PURE__ */ jsxs20(
      "span",
      {
        className: `msg-thinking-dots${thinking ? " busy" : ""}`,
        "aria-hidden": "true",
        children: [
          /* @__PURE__ */ jsx23("span", { className: "dot" }),
          /* @__PURE__ */ jsx23("span", { className: "dot" }),
          /* @__PURE__ */ jsx23("span", { className: "dot" })
        ]
      }
    ),
    /* @__PURE__ */ jsx23("span", { className: "msg-thinking-elapsed", children: fmtElapsed(elapsed) })
  ] }) });
}
function isCollapsibleText(text) {
  return text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES;
}
function textTabTitle(text, fallback) {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}\u2026` : firstLine;
}
function EditIcon() {
  return /* @__PURE__ */ jsxs20(
    "svg",
    {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx23("path", { d: "M12 20h9" }),
        /* @__PURE__ */ jsx23("path", { d: "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" })
      ]
    }
  );
}
var fmtTokens2, THINKING_MIN_H, THINKING_MAX_H, THINKING_DEFAULT_H, ALWAYS_VISIBLE_TOOLS, USER_COLLAPSE_CHARS, USER_COLLAPSE_LINES;
var init_thinking2 = __esm({
  "src/components/message/thinking.tsx"() {
    "use strict";
    init_bidi();
    init_errorText();
    init_time();
    init_ExploreCard();
    init_store();
    init_ToolCallView();
    init_shared();
    fmtTokens2 = (n) => {
      if (!n) return "0";
      return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
    };
    THINKING_MIN_H = 56;
    THINKING_MAX_H = 320;
    THINKING_DEFAULT_H = 84;
    ALWAYS_VISIBLE_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file", "ask_user"]);
    USER_COLLAPSE_CHARS = 600;
    USER_COLLAPSE_LINES = 10;
  }
});

// src/components/message/bubbles.tsx
import { memo as memo8, useEffect as useEffect19, useMemo as useMemo8, useRef as useRef15, useState as useState20 } from "react";
import { Fragment as Fragment14, jsx as jsx24, jsxs as jsxs21 } from "react/jsx-runtime";
function UserMessageBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
  className
}) {
  const [copied, setCopied] = useState20(false);
  const [isEditing, setIsEditing] = useState20(false);
  const [draft, setDraft] = useState20("");
  const editInputRef = useRef15(null);
  useEffect19(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const content = message.content || "";
  const isLong = isCollapsibleText(content);
  const body = isLong ? content.slice(0, USER_COLLAPSE_CHARS) : content;
  const clamped = isLong;
  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(content);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === content) {
      setIsEditing(false);
      return;
    }
    onEdit?.(message.id, next);
    setIsEditing(false);
  };
  return /* @__PURE__ */ jsxs21(Fragment14, { children: [
    /* @__PURE__ */ jsxs21("div", { className: `msg-bubble${className ? ` ${className}` : ""}${isEditing ? " editing" : ""}`, children: [
      isEditing ? /* @__PURE__ */ jsxs21("div", { className: "msg-edit-wrap", children: [
        /* @__PURE__ */ jsx24(
          "textarea",
          {
            ref: editInputRef,
            className: "msg-edit-input",
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Escape") cancelEdit();
              else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveEdit();
              }
            },
            dir: "auto",
            rows: 4,
            autoFocus: true
          }
        ),
        /* @__PURE__ */ jsxs21("div", { className: "msg-edit-actions", children: [
          /* @__PURE__ */ jsx24(
            "span",
            {
              className: "msg-edit-hint",
              title: "Escape cancels, Enter sends",
              "aria-hidden": "true",
              children: "i"
            }
          ),
          /* @__PURE__ */ jsx24("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
        ] })
      ] }) : /* @__PURE__ */ jsx24(
        "div",
        {
          className: `chat-message user-text${clamped ? " clamped" : ""}`,
          dir: detectDir(body),
          children: perLineDir(cachedPrepare(message.id, body) || "(empty)")
        }
      ),
      !isEditing && isLong && /* @__PURE__ */ jsx24(
        "button",
        {
          className: "msg-expand",
          onClick: () => useViewerTabs.getState().openText(textTabTitle(content, "Message"), content),
          title: "Open the full text in the side panel",
          children: "Show more"
        }
      ),
      message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx24("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs21(
        "span",
        {
          className: "attachment-chip attachment-chip-open",
          role: "button",
          tabIndex: 0,
          title: `${a} \u2014 open in the side panel`,
          onPointerDown: () => openWorkspaceFile(a),
          onClick: () => openWorkspaceFile(a),
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openWorkspaceFile(a);
            }
          },
          children: [
            /* @__PURE__ */ jsx24(FileIcon, { path: a, size: 20 }),
            attachmentBasename(a)
          ]
        },
        a
      )) }),
      message.images && message.images.length > 0 && /* @__PURE__ */ jsx24(MessageImages, { images: message.images })
    ] }),
    message.content && !isEditing && /* Order (LTR visual): Copy — Edit — Regenerate. No fork under the
       user bubble (user request). The row is direction:ltr (fixed footer
       geometry), so DOM order == visual order. */
    /* @__PURE__ */ jsxs21("div", { className: "msg-actions", children: [
      /* @__PURE__ */ jsx24(
        "button",
        {
          className: `msg-copy ${copied ? "copied" : ""}`,
          onClick: copy,
          title: "Copy message",
          "aria-label": "Copy message",
          children: copied ? /* @__PURE__ */ jsx24(
            "svg",
            {
              width: "16",
              height: "16",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2.5",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              children: /* @__PURE__ */ jsx24("path", { d: "M20 6 9 17l-5-5" })
            }
          ) : /* @__PURE__ */ jsxs21(
            "svg",
            {
              width: "16",
              height: "16",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              children: [
                /* @__PURE__ */ jsx24("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                /* @__PURE__ */ jsx24("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
              ]
            }
          )
        }
      ),
      onEdit && !isEditing && /* @__PURE__ */ jsx24(
        "button",
        {
          className: "msg-copy msg-edit",
          onClick: startEdit,
          disabled: editingDisabled,
          title: "Edit message",
          "aria-label": "Edit message",
          children: /* @__PURE__ */ jsx24(EditIcon, {})
        }
      ),
      onRetry && /* @__PURE__ */ jsx24(
        "button",
        {
          className: "msg-copy msg-retry",
          onClick: () => onRetry(message.id),
          title: "Regenerate",
          "aria-label": "Regenerate \u2014 delete this turn and generate it again from scratch",
          children: /* @__PURE__ */ jsxs21(
            "svg",
            {
              width: "16",
              height: "16",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              children: [
                /* @__PURE__ */ jsx24("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
                /* @__PURE__ */ jsx24("path", { d: "M3 3v5h5" })
              ]
            }
          )
        }
      )
    ] })
  ] });
}
function editQueuedText(items, id, newText) {
  const text = newText.trim();
  if (!text) return null;
  let found = false;
  const next = items.map((q) => {
    if (q.id !== id) return q;
    found = true;
    return { ...q, text };
  });
  return found ? next : null;
}
function QueuedCollapsibleText({
  id,
  text,
  onEdit,
  editingDisabled
}) {
  const isLong = isCollapsibleText(text);
  const [isEditing, setIsEditing] = useState20(false);
  const [draft, setDraft] = useState20("");
  const editInputRef = useRef15(null);
  useEffect19(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(text);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === text) {
      setIsEditing(false);
      return;
    }
    onEdit?.(id, next);
    setIsEditing(false);
  };
  return /* @__PURE__ */ jsxs21(Fragment14, { children: [
    isEditing ? /* @__PURE__ */ jsxs21("div", { className: "msg-edit-wrap", children: [
      /* @__PURE__ */ jsx24(
        "textarea",
        {
          ref: editInputRef,
          className: "msg-edit-input",
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Escape") cancelEdit();
            else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              saveEdit();
            }
          },
          dir: "auto",
          rows: 4,
          autoFocus: true
        }
      ),
      /* @__PURE__ */ jsxs21("div", { className: "msg-edit-actions", children: [
        /* @__PURE__ */ jsx24(
          "span",
          {
            className: "msg-edit-hint",
            title: "Escape cancels, Enter sends",
            "aria-hidden": "true",
            children: "i"
          }
        ),
        /* @__PURE__ */ jsx24("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
      ] })
    ] }) : /* @__PURE__ */ jsxs21(Fragment14, { children: [
      /* @__PURE__ */ jsx24(
        "div",
        {
          className: `queued-bubble-text${isLong ? " clamped" : ""}`,
          dir: detectDir(text),
          children: cachedPrepare(id, text) || "(empty)"
        }
      ),
      isLong && /* @__PURE__ */ jsx24(
        "button",
        {
          className: "msg-expand queued-expand",
          onClick: () => useViewerTabs.getState().openText(textTabTitle(text, "Queued text"), text),
          title: "Open the full text in the side panel",
          children: "Show more"
        }
      )
    ] }),
    onEdit && !isEditing && /* @__PURE__ */ jsx24("div", { className: "msg-actions", children: /* @__PURE__ */ jsx24(
      "button",
      {
        className: "msg-copy msg-edit",
        onClick: startEdit,
        disabled: editingDisabled,
        title: "Edit message",
        "aria-label": "Edit message",
        children: /* @__PURE__ */ jsx24(EditIcon, {})
      }
    ) })
  ] });
}
function SegSteerBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled
}) {
  return /* @__PURE__ */ jsxs21("div", { className: "msg user seg-steer", children: [
    /* @__PURE__ */ jsxs21("div", { className: "msg-role", children: [
      /* @__PURE__ */ jsx24("span", { className: "msg-role-avatar", "aria-hidden": "true", children: /* @__PURE__ */ jsxs21(
        "svg",
        {
          width: "10",
          height: "10",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2.2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: [
            /* @__PURE__ */ jsx24("circle", { cx: "12", cy: "8", r: "4" }),
            /* @__PURE__ */ jsx24("path", { d: "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" })
          ]
        }
      ) }),
      "You"
    ] }),
    /* @__PURE__ */ jsx24(UserMessageBubble, { message, onRetry, onEdit, editingDisabled })
  ] });
}
function summaryPreviewText(content) {
  const lines = content.slice(0, 6e3).replace(/<\/?[a-zA-Z_][\w-]*>/g, "\n").split("\n").map(
    (l) => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").replace(/[*_`]+/g, "").trim()
  ).filter(Boolean);
  const body = lines.filter((l) => !(l.endsWith(":") && l.length <= 60));
  return (body.length > 0 ? body : lines).join(" \xB7 ").slice(0, 320);
}
function isCaptionCandidate(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("```")) return false;
  if (t.length > CAPTION_MAX_CHARS) return false;
  if (t.split("\n").length > CAPTION_MAX_LINES) return false;
  return true;
}
var SummaryBlock, CAPTION_MAX_CHARS, CAPTION_MAX_LINES;
var init_bubbles = __esm({
  "src/components/message/bubbles.tsx"() {
    "use strict";
    init_bidi();
    init_clipboard();
    init_viewerTabs();
    init_FileIcon();
    init_MessageImages();
    init_thinking2();
    init_shared();
    SummaryBlock = memo8(function SummaryBlock2({ message }) {
      const content = message.content || "";
      const preview = useMemo8(() => summaryPreviewText(content), [content]);
      const words = useMemo8(() => content.trim() ? content.trim().split(/\s+/).length : 0, [content]);
      const isFork = content.startsWith("[Forked from");
      const open = () => useViewerTabs.getState().openText(isFork ? "Forked context" : "Context summary", content);
      const hint = isFork ? "Original messages were not copied \u2014 this is the compacted seed the fork runs on. Click to open it in the side panel." : "Earlier turns were folded into this summary. Click to open it in the side panel.";
      return /* @__PURE__ */ jsx24("div", { className: "summary-block collapsed", children: /* @__PURE__ */ jsxs21(
        "div",
        {
          className: "summary-head",
          onClick: open,
          role: "button",
          tabIndex: 0,
          title: hint,
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          },
          children: [
            /* @__PURE__ */ jsx24("span", { className: "summary-icon", "aria-hidden": "true", children: isFork ? /* @__PURE__ */ jsxs21("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
              /* @__PURE__ */ jsx24("circle", { cx: "6", cy: "5", r: "2.2" }),
              /* @__PURE__ */ jsx24("circle", { cx: "6", cy: "19", r: "2.2" }),
              /* @__PURE__ */ jsx24("circle", { cx: "18", cy: "8", r: "2.2" }),
              /* @__PURE__ */ jsx24("path", { d: "M6 7.2v9.6M18 10.2c0 4-6 3.2-12 7" })
            ] }) : /* @__PURE__ */ jsxs21("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
              /* @__PURE__ */ jsx24("path", { d: "M12 3 3 7.5 12 12l9-4.5L12 3z" }),
              /* @__PURE__ */ jsx24("path", { d: "m3 12 9 4.5 9-4.5" }),
              /* @__PURE__ */ jsx24("path", { d: "m3 16.5 9 4.5 9-4.5" })
            ] }) }),
            /* @__PURE__ */ jsxs21("span", { className: "summary-main", children: [
              /* @__PURE__ */ jsxs21("span", { className: "summary-title-row", children: [
                /* @__PURE__ */ jsx24("span", { className: "summary-label", children: isFork ? "Forked context" : "Context summary" }),
                words > 0 && /* @__PURE__ */ jsxs21("span", { className: "summary-meta", children: [
                  words.toLocaleString(),
                  " words"
                ] })
              ] }),
              preview && /* @__PURE__ */ jsx24("span", { className: "summary-preview", dir: "auto", children: cachedPrepare(`${message.id}:sum`, preview) })
            ] }),
            /* @__PURE__ */ jsxs21("span", { className: "summary-open", children: [
              "Open",
              /* @__PURE__ */ jsx24("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.4", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx24("path", { d: "M9 6l6 6-6 6" }) })
            ] })
          ]
        }
      ) });
    });
    CAPTION_MAX_CHARS = 260;
    CAPTION_MAX_LINES = 2;
  }
});

// src/components/ChatBubble.tsx
import { jsx as jsx25, jsxs as jsxs22 } from "react/jsx-runtime";
function ChatBubble({
  id,
  content,
  usage,
  createdAt,
  turnElapsedMs,
  className,
  fork,
  onFork,
  read,
  onRead,
  children
}) {
  const { status: ttsStatus, speak } = useSpeakText(useStore.getState);
  const dir = detectDir(content);
  const onSpeak = async () => {
    const err = await speak(content);
    if (err) console.warn("speak failed:", err);
  };
  return /* @__PURE__ */ jsx25("div", { className: `msg chat-bubble${className ? ` ${className}` : ""}`, dir, children: /* @__PURE__ */ jsxs22("div", { className: "msg-bubble", children: [
    /* @__PURE__ */ jsx25(MarkdownProse, { text: cachedPrepare(`bubble:${id}`, content) }),
    /* @__PURE__ */ jsxs22(
      MessageActionsBar,
      {
        text: content,
        usage: usage ?? null,
        ttsStatus: content.trim() ? ttsStatus : void 0,
        onSpeak: content.trim() ? onSpeak : void 0,
        fork,
        onFork: onFork ?? (fork ? () => forkChatWithConfirm(id) : void 0),
        read,
        onRead,
        children: [
          /* @__PURE__ */ jsx25(MsgClocks, { createdAt, turnElapsedMs }),
          children
        ]
      }
    )
  ] }) });
}
var init_ChatBubble = __esm({
  "src/components/ChatBubble.tsx"() {
    "use strict";
    init_bidi();
    init_tts();
    init_store();
    init_ChatMessage();
    init_MessageActionsBar();
  }
});

// src/components/ReadingMode.tsx
var ReadingMode_exports = {};
__export(ReadingMode_exports, {
  ReadingMode: () => ReadingMode
});
import { useEffect as useEffect20, useMemo as useMemo9, useRef as useRef16, useState as useState21 } from "react";
import { createPortal as createPortal6 } from "react-dom";
import "highlight.js/styles/github-dark.min.css";
import { jsx as jsx26, jsxs as jsxs23 } from "react/jsx-runtime";
function ReadingMode({
  message,
  onClose
}) {
  const dir = APP_DIR;
  const sections = useMemo9(() => splitSections(message.content), [message.content]);
  const [active, setActive] = useState21(0);
  const [progress, setProgress] = useState21(0);
  const [width, setWidth] = useState21(() => {
    if (typeof window === "undefined" || typeof window.innerWidth !== "number") return 720;
    const max = window.innerWidth - 24;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:readingWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const n = Number.isFinite(saved) ? saved : Math.round(window.innerWidth / 2) - 12;
    return Math.max(320, Math.min(max, n));
  });
  useEffect20(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const contentRef = useRef16(null);
  useEffect20(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown" || (e.ctrlKey || e.metaKey) && physicalKey(e) === "j")
        setActive((a) => Math.min(a + 1, sections.length - 1));
      else if (e.key === "ArrowUp" || (e.ctrlKey || e.metaKey) && physicalKey(e) === "k")
        setActive((a) => Math.max(a - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sections.length]);
  useEffect20(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [active]);
  useEffect20(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [active]);
  const section = sections[active];
  if (!section) return null;
  const dragCleanup = useRef16(null);
  useEffect20(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const w = Math.max(320, Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)));
      setWidth(w);
      try {
        localStorage.setItem("coder:readingWidth", String(w));
      } catch {
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragCleanup.current = onUp;
  };
  const panel = /* @__PURE__ */ jsxs23(
    "div",
    {
      className: "reading-mode",
      dir,
      style: { "--reading-w": `${width}px` },
      onClick: (e) => e.stopPropagation(),
      children: [
        /* @__PURE__ */ jsx26("div", { className: "reading-mode-scrim", "aria-hidden": "true" }),
        /* @__PURE__ */ jsxs23(
          "div",
          {
            className: "reading-mode-panel",
            role: "dialog",
            "aria-modal": "false",
            "aria-label": "Reading mode",
            children: [
              /* @__PURE__ */ jsx26(
                "div",
                {
                  className: "reading-mode-resize-handle",
                  title: "Drag to resize",
                  onMouseDown: startResize
                }
              ),
              /* @__PURE__ */ jsxs23("div", { className: "reading-mode-head", children: [
                /* @__PURE__ */ jsxs23("div", { className: "reading-mode-title", children: [
                  /* @__PURE__ */ jsx26("h2", { children: "Reading Mode" }),
                  /* @__PURE__ */ jsxs23("span", { className: "reading-mode-tab", children: [
                    "Section ",
                    active + 1,
                    " of ",
                    sections.length
                  ] })
                ] }),
                /* @__PURE__ */ jsxs23("div", { className: "reading-mode-head-actions", children: [
                  /* @__PURE__ */ jsx26(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.max(a - 1, 0)),
                      disabled: active === 0,
                      title: "Previous section (\u2191)",
                      "aria-label": "Previous section",
                      children: /* @__PURE__ */ jsx26(ChevronUpIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx26(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.min(a + 1, sections.length - 1)),
                      disabled: active === sections.length - 1,
                      title: "Next section (\u2193)",
                      "aria-label": "Next section",
                      children: /* @__PURE__ */ jsx26(ChevronDownIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx26(
                    "button",
                    {
                      className: "modal-close",
                      onClick: onClose,
                      title: "Close (Esc)",
                      "aria-label": "Close",
                      children: "\u2715"
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsx26("div", { className: "reading-mode-progress", "aria-hidden": "true", children: /* @__PURE__ */ jsx26("span", { style: { width: `${progress * 100}%` } }) }),
              /* @__PURE__ */ jsxs23("div", { className: "reading-mode-body", children: [
                /* @__PURE__ */ jsxs23("div", { className: "reading-mode-list", children: [
                  /* @__PURE__ */ jsxs23("div", { className: "reading-mode-list-label", children: [
                    "Contents",
                    /* @__PURE__ */ jsx26("span", { className: "reading-mode-list-count", children: sections.length })
                  ] }),
                  sections.map((s, i) => /* @__PURE__ */ jsxs23(
                    "div",
                    {
                      className: `reading-mode-item${i === active ? " active" : ""}`,
                      style: { "--i": i },
                      "aria-current": i === active ? "true" : void 0,
                      children: [
                        /* @__PURE__ */ jsx26("span", { className: "reading-mode-item-num", children: i + 1 }),
                        /* @__PURE__ */ jsx26(
                          "button",
                          {
                            className: "reading-mode-item-title",
                            onClick: () => setActive(i),
                            title: s.title,
                            dir: detectDir(s.title),
                            children: /* @__PURE__ */ jsx26(
                              "span",
                              {
                                className: "reading-mode-item-level",
                                style: { paddingInlineStart: (s.level - 1) * 12 },
                                children: s.title
                              }
                            )
                          }
                        )
                      ]
                    },
                    s.id
                  ))
                ] }),
                /* @__PURE__ */ jsxs23("div", { className: "reading-mode-content", ref: contentRef, children: [
                  /* @__PURE__ */ jsx26("div", { className: "reading-mode-content-head", children: /* @__PURE__ */ jsxs23("div", { className: "reading-mode-content-title", children: [
                    /* @__PURE__ */ jsx26("span", { className: "reading-mode-content-num", children: active + 1 }),
                    /* @__PURE__ */ jsx26("h3", { dir: detectDir(section.title), children: section.title })
                  ] }) }),
                  /* @__PURE__ */ jsx26("div", { className: "reading-mode-content-inner", children: /* @__PURE__ */ jsx26(
                    ChatBubble,
                    {
                      id: `${message.id}:sec:${active}`,
                      content: section.content,
                      className: "reading-mode-bubble"
                    }
                  ) }, active)
                ] })
              ] }),
              /* @__PURE__ */ jsxs23("div", { className: "reading-mode-foot", children: [
                /* @__PURE__ */ jsxs23("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx26("kbd", { children: "\u2191" }),
                  " ",
                  /* @__PURE__ */ jsx26("kbd", { children: "\u2193" }),
                  " navigate sections"
                ] }),
                /* @__PURE__ */ jsxs23("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx26("kbd", { children: "Esc" }),
                  " close"
                ] })
              ] })
            ]
          }
        )
      ]
    }
  );
  if (typeof document === "undefined") return panel;
  return createPortal6(panel, document.body);
}
var ChevronUpIcon, ChevronDownIcon;
var init_ReadingMode = __esm({
  "src/components/ReadingMode.tsx"() {
    "use strict";
    init_ChatBubble();
    init_sections();
    init_store();
    init_bidi();
    init_shortcuts();
    ChevronUpIcon = () => /* @__PURE__ */ jsx26(
      "svg",
      {
        width: "15",
        height: "15",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2.2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: /* @__PURE__ */ jsx26("path", { d: "m18 15-6-6-6 6" })
      }
    );
    ChevronDownIcon = () => /* @__PURE__ */ jsx26(
      "svg",
      {
        width: "15",
        height: "15",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2.2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: /* @__PURE__ */ jsx26("path", { d: "m6 9 6 6 6-6" })
      }
    );
  }
});

// src/components/ChatMessage.tsx
var ChatMessage_exports = {};
__export(ChatMessage_exports, {
  ALWAYS_VISIBLE_TOOLS: () => ALWAYS_VISIBLE_TOOLS,
  CAPTION_MAX_CHARS: () => CAPTION_MAX_CHARS,
  CAPTION_MAX_LINES: () => CAPTION_MAX_LINES,
  ChatMessageView: () => ChatMessageView,
  CodeBlock: () => CodeBlock,
  EDIT_ICON: () => EDIT_ICON,
  EditIcon: () => EditIcon,
  InlineRetryLine: () => InlineRetryLine,
  MarkdownImage: () => MarkdownImage,
  MarkdownProse: () => MarkdownProse,
  PREPARED_CACHE_MAX: () => PREPARED_CACHE_MAX,
  PROSE_REHYPE_PLUGINS: () => PROSE_REHYPE_PLUGINS,
  PROSE_REMARK_PLUGINS: () => PROSE_REMARK_PLUGINS,
  PlanDocCard: () => PlanDocCard,
  QueuedCollapsibleText: () => QueuedCollapsibleText,
  SegSteerBubble: () => SegSteerBubble,
  SummaryBlock: () => SummaryBlock,
  THINKING_DEFAULT_H: () => THINKING_DEFAULT_H,
  THINKING_MAX_H: () => THINKING_MAX_H,
  THINKING_MIN_H: () => THINKING_MIN_H,
  ThinkingBlock: () => ThinkingBlock,
  ThinkingIndicator: () => ThinkingIndicator,
  USER_COLLAPSE_CHARS: () => USER_COLLAPSE_CHARS,
  USER_COLLAPSE_LINES: () => USER_COLLAPSE_LINES,
  UserMessageBubble: () => UserMessageBubble,
  VideoThumbnailCard: () => VideoThumbnailCard,
  _vimeoId: () => _vimeoId,
  _ytId: () => _ytId,
  cachedPrepare: () => cachedPrepare,
  cachedPrepareText: () => cachedPrepareText,
  codeFilePath: () => codeFilePath,
  codeLang: () => codeLang,
  codeStartLine: () => codeStartLine,
  computeLeft: () => computeLeft,
  editQueuedText: () => editQueuedText,
  extractVideoEmbed: () => extractVideoEmbed,
  fmtTokens: () => fmtTokens2,
  forkChatWithConfirm: () => forkChatWithConfirm,
  isCaptionCandidate: () => isCaptionCandidate,
  isCollapsibleText: () => isCollapsibleText,
  keepFileUrls: () => keepFileUrls,
  localWords: () => localWords,
  mdComponents: () => mdComponents,
  openExternalPreferred: () => openExternalPreferred,
  perLineDir: () => perLineDir,
  renderSegments: () => renderSegments,
  subRetryInfo: () => subRetryInfo,
  summaryPreviewText: () => summaryPreviewText,
  textFromChildren: () => textFromChildren,
  textTabTitle: () => textTabTitle
});
import {
  Suspense,
  lazy as lazy2,
  memo as memo9,
  useEffect as useEffect21,
  useMemo as useMemo10,
  useState as useState22
} from "react";
import "highlight.js/styles/github-dark.min.css";
import { Fragment as Fragment15, jsx as jsx27, jsxs as jsxs24 } from "react/jsx-runtime";
function postTtsError(chatId, msg) {
  useStore.getState().setChatTtsError(chatId, msg);
}
function forkChatWithConfirm(messageId) {
  const s = useStore.getState();
  const src = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
  if (!src) return;
  const label = (src.title || "").trim() || "\u0627\u06CC\u0646 \u0686\u062A";
  if (!window.confirm(
    `\u0627\u0632 \xAB${label}\xBB \u06CC\u06A9 \u0686\u062A \u062C\u062F\u06CC\u062F (\u0641\u0648\u0631\u06A9) \u0633\u0627\u062E\u062A\u0647 \u0634\u0648\u062F\u061F

\u0641\u0648\u0631\u06A9 \u0641\u0642\u0637 \u062A\u0627 \u0647\u0645\u06CC\u0646 \u0646\u0642\u0637\u0647 \u0631\u0627 \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u062E\u0644\u0627\u0635\u0647 \u0628\u0647 \u0647\u0645\u0631\u0627\u0647 \u0645\u06CC\u200C\u0628\u0631\u062F \u0648 \u0686\u062A \u0641\u0639\u0644\u06CC \u062F\u0633\u062A\u200C\u0646\u062E\u0648\u0631\u062F\u0647 \u0645\u06CC\u200C\u0645\u0627\u0646\u062F.`
  )) {
    return;
  }
  s.forkChatFromMessage(messageId);
}
function renderSegments(message, onRetry, onEdit, editingDisabled) {
  const nodes = [];
  let pending = [];
  let trace = [];
  let pendingCaption = null;
  const captions = [];
  let orphanCap = 0;
  let traceAnchor = null;
  let pendingEdit = [];
  const flushEdits = () => {
    if (pendingEdit.length === 0) return;
    if (pendingEdit.length === 1) {
      const entry = pendingEdit[0];
      const { activity } = entry;
      const entryIndex = entry.index;
      nodes.push(
        /* @__PURE__ */ jsx27(
          ToolCallView,
          {
            activity,
            messageId: message.id,
            onReverted: () => useStore.getState().markToolReverted(message.id, entryIndex)
          },
          `edit-${entryIndex}`
        )
      );
    } else {
      const key = `edit-grp-${pendingEdit[0].index}`;
      nodes.push(
        /* @__PURE__ */ jsx27(
          ToolEditGroupView,
          {
            activities: pendingEdit,
            messageId: message.id,
            onReverted: (idx) => useStore.getState().markToolReverted(message.id, idx)
          },
          key
        )
      );
    }
    pendingEdit = [];
  };
  const wrapTrace = () => {
    if (trace.length === 0) return;
    nodes.push(
      /* @__PURE__ */ jsx27("div", { className: "tool-trace", children: trace }, `trace-${traceAnchor}`)
    );
    trace = [];
    traceAnchor = null;
  };
  const flush = () => {
    if (pending.length === 0) {
      if (pendingCaption) {
        wrapTrace();
        renderProse(`cap-${orphanCap}`, pendingCaption);
        orphanCap++;
        pendingCaption = null;
      }
      return;
    }
    const key = `grp-${pending[0].index}`;
    if (pending.length === 1 && !isSubagentCard(pending[0].activity)) {
      if (captions[0]) {
        trace.push(
          /* @__PURE__ */ jsx27(TraceNarration, { text: captions[0] }, `nar-${key}`)
        );
      }
      const { activity } = pending[0];
      trace.push(
        /* @__PURE__ */ jsx27(ToolSingleRow, { activity, messageId: message.id }, key)
      );
    } else {
      trace.push(
        /* @__PURE__ */ jsx27(
          ToolGroupView,
          {
            activities: pending,
            captions: captions.slice()
          },
          key
        )
      );
    }
    pending = [];
    captions.length = 0;
    pendingCaption = null;
  };
  const renderProse = (key, text) => {
    nodes.push(
      /* @__PURE__ */ jsx27(
        MarkdownProse,
        {
          text: cachedPrepare(`${message.id}:seg:${key}`, text)
        },
        key
      )
    );
  };
  const segs = message.segments ?? [];
  segs.forEach((seg, i) => {
    if (seg.kind === "user") {
      flush();
      wrapTrace();
      flushEdits();
      const steerMsg = useStore.getState().chats.flatMap((c2) => c2.messages).find((m) => m.id === seg.id);
      if (steerMsg) {
        nodes.push(
          /* @__PURE__ */ jsx27(SegSteerBubble, { message: steerMsg, onRetry, onEdit, editingDisabled }, i)
        );
      }
      return;
    }
    if (seg.kind === "compact") {
      flush();
      wrapTrace();
      flushEdits();
      const summaryMsg = useStore.getState().chats.flatMap((c2) => c2.messages).find((m) => m.id === seg.id);
      if (summaryMsg) {
        nodes.push(/* @__PURE__ */ jsx27(SummaryBlock, { message: summaryMsg }, i));
      }
      return;
    }
    if (seg.kind === "artifact") {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(/* @__PURE__ */ jsx27(ArtifactCard, { segment: seg, messageId: message.id }, i));
      return;
    }
    if (seg.kind === "text") {
      if (!seg.text.trim()) return;
      const next = segs[i + 1];
      const nextActivity = next && next.kind === "tool" ? message.toolActivity?.[next.index] : void 0;
      const nextIsGroupable = nextActivity && !ALWAYS_VISIBLE_TOOLS.has(nextActivity.tool) && !isSubagentCard(nextActivity);
      if (nextIsGroupable && isCaptionCandidate(seg.text)) {
        pendingCaption = seg.text;
        return;
      }
      flush();
      wrapTrace();
      flushEdits();
      renderProse(String(i), seg.text);
      return;
    }
    const activity = message.toolActivity?.[seg.index];
    if (!activity) return;
    if (isEditActivity(activity) && !isSubagentCard(activity)) {
      flush();
      wrapTrace();
      pendingEdit.push({ activity, index: seg.index });
      return;
    }
    if (isSubagentCard(activity)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        /* @__PURE__ */ jsx27("div", { className: "tool-trace", children: /* @__PURE__ */ jsx27(
          ToolGroupView,
          {
            subagent: activity,
            activities: (activity.children ?? []).map((child, ci) => ({
              activity: child,
              index: ci
            }))
          }
        ) }, `exp-${seg.index}`)
      );
      return;
    }
    if (activity.tool === "ask_user") {
      flush();
      wrapTrace();
      flushEdits();
      const ownerChat = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id));
      const liveReq = ownerChat?.pendingAsk ?? null;
      nodes.push(
        /* @__PURE__ */ jsx27(
          AskUserCard,
          {
            req: liveReq,
            activity,
            messageId: message.id,
            inline: true,
            live: !!liveReq
          },
          `ask-${seg.index}`
        )
      );
      return;
    }
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        /* @__PURE__ */ jsx27(
          ToolCallView,
          {
            activity,
            messageId: message.id,
            onReverted: () => useStore.getState().markToolReverted(message.id, seg.index)
          },
          i
        )
      );
    } else {
      flushEdits();
      captions.push(pendingCaption);
      pendingCaption = null;
      pending.push({ activity, index: seg.index });
      if (traceAnchor === null) traceAnchor = seg.index;
    }
  });
  flush();
  wrapTrace();
  flushEdits();
  return nodes;
}
var ReadingMode2, ChatMessageView;
var init_ChatMessage = __esm({
  "src/components/ChatMessage.tsx"() {
    "use strict";
    init_bidi();
    init_fileTypes();
    init_FileIcon();
    init_renderCap();
    init_api();
    init_messageViewEqual();
    init_tts();
    init_store();
    init_modes();
    init_sections();
    init_ArtifactCard();
    init_ToolCallView();
    init_AskUserCard();
    init_MessageImages();
    init_viewerTabs();
    init_planDoc();
    init_MessageActionsBar();
    init_shared();
    init_shared();
    init_shared();
    init_shared();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_doccard();
    init_markdown();
    init_markdown();
    init_markdown();
    init_markdown();
    init_markdown();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_thinking2();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_bubbles();
    init_doccard();
    init_markdown();
    init_thinking2();
    init_shared();
    init_shared();
    init_shared();
    init_shared();
    init_shared();
    ReadingMode2 = lazy2(
      () => Promise.resolve().then(() => (init_ReadingMode(), ReadingMode_exports)).then((m) => ({ default: m.ReadingMode }))
    );
    ChatMessageView = memo9(
      function ChatMessageView2({
        message,
        onRetry,
        onResume,
        onCompactRetry,
        onEdit,
        editingDisabled
      }) {
        const isUser = message.role === "user";
        const modeLabelStr = useStore(
          (s) => message.mode ? getMode(s.settings, message.mode).label : ""
        );
        const { status: ttsStatus, toggle: ttsToggle, stop: ttsStop } = useTtsPlayback();
        const modeLabel = (_id) => modeLabelStr;
        const toggleSpeak = async () => {
          try {
            const prevChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (prevChatId) useStore.getState().setChatTtsError(prevChatId, null);
          } catch {
          }
          const st = useStore.getState();
          const liveVoice = st.liveVoiceState;
          if (liveVoice === "live" || liveVoice === "speaking" || liveVoice === "connecting") {
            const liveChatId = st.chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (liveChatId) postTtsError(liveChatId, "\u0648\u06CC\u0633 \u0644\u0627\u06CC\u0648 \u0641\u0639\u0627\u0644 \u0627\u0633\u062A \u2014 \u0627\u0628\u062A\u062F\u0627 \u0622\u0646 \u0631\u0627 \u0645\u062A\u0648\u0642\u0641 \u06A9\u0646\u06CC\u062F");
            return;
          }
          const providers = st.settings.providers ?? [];
          const toSpeakOpts = (provider, model, voice) => ({
            kind: provider.kind,
            baseUrl: provider.baseUrl ?? "",
            apiKeys: [...provider.apiKeys ?? (provider.apiKey ? [provider.apiKey] : [])],
            model,
            voice
          });
          const chain = [];
          const primary = providers.find((p) => p.id === st.ttsProviderId);
          if (primary) chain.push(toSpeakOpts(primary, st.ttsModel, st.ttsVoice));
          for (const fb of st.ttsFallbacks ?? []) {
            const p = providers.find((x) => x.id === fb.providerId);
            if (!p) continue;
            chain.push(toSpeakOpts(p, fb.model, fb.voice));
          }
          if (chain.length === 0) {
            const msg = "\u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0635\u062F\u0627 \u0627\u0628\u062A\u062F\u0627 \u06CC\u06A9 \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 TTS \u062F\u0631 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u2190 \u0645\u062F\u0644\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F";
            const bannerChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (bannerChatId) postTtsError(bannerChatId, msg);
            return;
          }
          const speakable = stripBidiMarks(fixZwsp(speakableMessageText(message)));
          if (!speakable.trim()) {
            const msg = "\u0645\u062A\u0646 \u0642\u0627\u0628\u0644 \u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0646\u06CC\u0633\u062A";
            const bannerChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (bannerChatId) postTtsError(bannerChatId, msg);
            return;
          }
          try {
            await ttsToggle(speakable, chain);
          } catch (err) {
            const friendly = friendlyTtsError(err);
            if (!friendly) return;
            console.warn("speak failed", err);
            const bannerChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (bannerChatId) postTtsError(bannerChatId, friendly);
          }
        };
        useEffect21(() => {
          if (message.streaming) ttsStop();
        }, [message.streaming, ttsStop]);
        useEffect21(() => () => ttsStop(), [ttsStop]);
        const isSummary = message.role === "system" && !message.modeSwitch;
        const isModeSwitch = message.modeSwitch === true;
        const display = planDisplay(message);
        const planDoc = !isUser && !isSummary ? display.planDoc : void 0;
        const displayContent = display.content;
        const displaySegments = display.segments;
        const docPaths = useMemo10(() => {
          const docs = docPathsFromActivities(message.toolActivity);
          return dedupDocPaths(docs, message.attachments ?? []);
        }, [message.toolActivity, message.attachments]);
        const cap = useCapped(message.id, displayContent ?? "", !!message.streaming);
        const replyText = displayContent ?? message.content ?? "";
        const replyBody = cap.shown;
        const [reading, setReading] = useState22(false);
        const sections = useMemo10(
          () => !isUser && !isSummary ? splitSections(message.content) : [],
          [message.content, isUser, isSummary]
        );
        if (isModeSwitch) return null;
        if (isUser && message.steerInterleaved) {
          const referenced = useStore.getState().chats.some(
            (c2) => c2.messages.some(
              (m) => (m.segments ?? []).some(
                (s) => s.kind === "user" && s.id === message.id
              )
            )
          );
          if (referenced) return null;
        }
        const hasFooterNotice = !!(message.retry || message.error && !message.streaming || message.interrupted || message.footerStatus);
        const roleLabel = message.role === "tool" ? "Tools" : message.mode ? modeLabel(message.mode) : "Assistant";
        return /* @__PURE__ */ jsxs24(
          "div",
          {
            className: `msg ${isUser ? "user" : ""} ${message.error ? "error" : ""}`,
            "data-msg-id": message.id,
            "data-is-summary": isSummary ? "true" : void 0,
            children: [
              !isSummary && !isUser && /* @__PURE__ */ jsx27("div", { className: "msg-role", children: roleLabel }),
              !isUser && message.plan && message.plan.length > 0 && /* @__PURE__ */ jsxs24(
                "div",
                {
                  className: "plan-block",
                  dir: detectDir(message.plan.map((p) => p.content).join(" ")),
                  children: [
                    /* @__PURE__ */ jsxs24("div", { className: "plan-head", children: [
                      /* @__PURE__ */ jsx27("span", { className: "plan-dot", children: "\u25CE" }),
                      /* @__PURE__ */ jsx27("span", { className: "plan-label", children: "Plan" })
                    ] }),
                    /* @__PURE__ */ jsx27("ul", { className: "plan-list", children: message.plan.map((item, i) => /* @__PURE__ */ jsxs24(
                      "li",
                      {
                        className: `plan-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : ""}`,
                        children: [
                          /* @__PURE__ */ jsx27("span", { className: "plan-item-mark", children: item.status === "completed" ? "\u2713" : item.status === "in_progress" ? "\u25CF" : "\u25CB" }),
                          /* @__PURE__ */ jsx27("span", { className: "plan-item-content", dir: "auto", children: cachedPrepare(`${message.id}:plan:${i}`, item.content) }),
                          typeof item.progress === "number" && item.status !== "completed" && /* Optional per-item progress (0-100) the agent may report
                             alongside update_plan; the backend stores items verbatim. */
                          /* @__PURE__ */ jsx27("span", { className: "plan-item-progress", dir: "ltr", "aria-label": `${Math.round(item.progress)}%`, children: /* @__PURE__ */ jsx27(
                            "span",
                            {
                              className: "plan-item-progress-fill",
                              style: { width: `${Math.max(0, Math.min(100, item.progress))}%` }
                            }
                          ) })
                        ]
                      },
                      item.id ?? item.content
                    )) })
                  ]
                }
              ),
              !isUser && message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx27("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs24(
                "span",
                {
                  className: "attachment-chip attachment-chip-open",
                  role: "button",
                  tabIndex: 0,
                  title: `${a} \u2014 open in the side panel`,
                  onPointerDown: () => openWorkspaceFile(a),
                  onClick: () => openWorkspaceFile(a),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openWorkspaceFile(a);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsx27(FileIcon, { path: a, size: 20 }),
                    attachmentBasename(a)
                  ]
                },
                a
              )) }),
              (isSummary || displayContent || displaySegments && displaySegments.length > 0) && (isModeSwitch ? /* @__PURE__ */ jsx27("div", { className: "mode-switch-note", dir: "ltr", children: cachedPrepare(message.id, message.content, "ltr") }) : isSummary ? /* @__PURE__ */ jsx27(SummaryBlock, { message }) : displaySegments && displaySegments.length > 0 ? (
                /* Claude-style interleaved rendering: text slices and tool cards follow
                   each other in the exact order the agent produced them, with runs of
                   2+ read-only tool calls collapsed into one summary (see renderSegments). */
                /* @__PURE__ */ jsx27("div", { className: "msg-bubble segmented", children: renderSegments(
                  { ...message, segments: displaySegments },
                  onRetry,
                  onEdit,
                  editingDisabled
                ) })
              ) : isUser && message.steerPending ? /* @__PURE__ */ jsxs24("div", { className: "queued-bubble steer", dir: detectDir(message.content), children: [
                /* @__PURE__ */ jsxs24("div", { className: "queued-bubble-head", children: [
                  /* @__PURE__ */ jsx27("span", { className: "queued-bubble-icon", children: /* @__PURE__ */ jsxs24(
                    "svg",
                    {
                      width: "12",
                      height: "12",
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: "2.2",
                      strokeLinecap: "round",
                      strokeLinejoin: "round",
                      children: [
                        /* @__PURE__ */ jsx27("path", { d: "M9 14L4 9l5-5" }),
                        /* @__PURE__ */ jsx27("path", { d: "M4 9h10a5 5 0 015 5v6" })
                      ]
                    }
                  ) }),
                  /* @__PURE__ */ jsx27("span", { className: "queued-bubble-label", children: "Steering the running agent\u2026" }),
                  /* @__PURE__ */ jsx27("span", { className: "queued-bubble-pulse" }),
                  /* @__PURE__ */ jsx27(
                    "button",
                    {
                      className: "chip-x queued-bubble-x",
                      onClick: () => {
                        const s = useStore.getState();
                        const chat = s.chats.find(
                          (c2) => c2.messages.some((m) => m.id === message.id)
                        );
                        if (!chat) return;
                        s.removeMessage(chat.id, message.id);
                        void cancelSteer(chat.id, message.id);
                      },
                      title: "Cancel steer \u2014 remove this message",
                      children: "\xD7"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx27(
                  QueuedCollapsibleText,
                  {
                    id: message.id,
                    text: message.content,
                    onEdit,
                    editingDisabled
                  }
                ),
                message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx27("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs24(
                  "span",
                  {
                    className: "attachment-chip attachment-chip-open",
                    role: "button",
                    tabIndex: 0,
                    title: `${a} \u2014 open in the side panel`,
                    onPointerDown: () => openWorkspaceFile(a),
                    onClick: () => openWorkspaceFile(a),
                    onKeyDown: (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWorkspaceFile(a);
                      }
                    },
                    children: [
                      /* @__PURE__ */ jsx27(FileIcon, { path: a, size: 20 }),
                      attachmentBasename(a)
                    ]
                  },
                  a
                )) }),
                message.images && message.images.length > 0 && /* @__PURE__ */ jsx27(MessageImages, { images: message.images })
              ] }) : isUser ? (
                /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
                   from the first strong char only, so a user message starting with
                   a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
                   72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
                   the rendered bubble identical to what the user typed. */
                /* @__PURE__ */ jsx27(UserMessageBubble, { message, onRetry, onEdit, editingDisabled })
              ) : /* @__PURE__ */ jsxs24(Fragment15, { children: [
                /* @__PURE__ */ jsx27("div", { className: "msg-bubble", children: /* @__PURE__ */ jsx27(MarkdownProse, { text: cachedPrepare(message.id, replyBody) }) }),
                cap.over && /* @__PURE__ */ jsx27(
                  "button",
                  {
                    className: "msg-expand",
                    onClick: () => useViewerTabs.getState().openText(textTabTitle(replyText, "Reply"), replyText),
                    title: `Full reply is ${fmtSize(replyText.length)} \u2014 opens in the side panel`,
                    children: `Show all (${fmtSize(cap.cut)} more)`
                  }
                )
              ] })),
              !isUser && docPaths.length > 0 && /* @__PURE__ */ jsx27(DocFileChips, { paths: docPaths }),
              !isUser && planDoc && /* @__PURE__ */ jsx27(PlanDocCard, { planDoc, messageId: message.id }),
              !isUser && (message.content || message.usage || message.streaming || message.turnElapsedMs != null || message.retry || message.error && !message.streaming || message.interrupted || message.footerStatus) && /* @__PURE__ */ jsxs24(
                MessageActionsBar,
                {
                  text: message.content,
                  usage: message.usage ?? null,
                  ttsStatus: message.content && !message.streaming ? ttsStatus : void 0,
                  onSpeak: message.content && !message.streaming ? () => {
                    void toggleSpeak();
                  } : void 0,
                  onStopTts: ttsStop,
                  fork: Boolean(message.content),
                  onFork: () => forkChatWithConfirm(message.id),
                  read: !isSummary && !message.streaming && sections.length >= 2,
                  onRead: () => setReading(true),
                  children: [
                    message.retry || message.error && !message.streaming || message.interrupted || message.footerStatus ? /* @__PURE__ */ jsx27(
                      InlineRetryLine,
                      {
                        sub: message.retry ? subRetryInfo(message.retry, message.toolActivity) : void 0,
                        retry: message.retry ?? (message.error && !message.streaming ? {
                          // A FAILED turn that never entered a retry ladder
                          // (deterministic 4xx, exhausted quota, user Stop) still has
                          // an error to report — and it reports it HERE, in the footer.
                          attempt: 1,
                          maxAttempts: 1,
                          delay: 0,
                          reason: message.errorReason ?? "The turn failed.",
                          gaveUp: true,
                          inline: true
                        } : message.interrupted ? {
                          attempt: 1,
                          maxAttempts: 1,
                          delay: 0,
                          reason: "Interrupted \u2014 this reply was cut off. Send \u201Ccontinue\u201D to resume.",
                          gaveUp: true,
                          inline: true
                        } : {
                          attempt: message.footerStatus.attempt ?? 1,
                          maxAttempts: 1,
                          delay: 0,
                          reason: message.footerStatus.text,
                          gaveUp: message.footerStatus.kind === "error",
                          inline: true,
                          status: message.footerStatus.kind !== "error",
                          // Progress field rides through so the row can render a
                          // determinate bar instead of parsing the text back.
                          percent: message.footerStatus.percent
                        }),
                        onManualRetry: message.retry || message.error || message.interrupted ? onResume ? () => onResume(message.id) : void 0 : message.footerStatus?.action === "compact-retry" ? onCompactRetry : void 0
                      }
                    ) : message.streaming && // ONE indicator instance for every phase, so the timer never resets:
                    // it always counts from the turn's workingStartedAt. The label is the
                    // live status when there is one (LSP / tool status) and "Working"
                    // otherwise; while the model reasons, an animated icon in front of the
                    // label replaces the old "Thinking" pill and its own stopwatch.
                    /* @__PURE__ */ jsx27(
                      ThinkingIndicator,
                      {
                        thinking: !!message.thinkingActive,
                        label: lspStatusLabel(message.lspStatus) || message.statusText || "Working",
                        startedAt: message.workingStartedAt
                      }
                    ),
                    /* @__PURE__ */ jsx27(
                      MsgClocks,
                      {
                        createdAt: message.createdAt,
                        turnElapsedMs: message.turnElapsedMs,
                        hide: message.streaming || hasFooterNotice
                      }
                    )
                  ]
                }
              ),
              reading && /* @__PURE__ */ jsx27(Suspense, { fallback: null, children: /* @__PURE__ */ jsx27(ReadingMode2, { message, onClose: () => setReading(false) }) })
            ]
          }
        );
      },
      // Custom comparator (see src/lib/messageViewEqual.ts). The percent/attempt/
      // action fields are part of the equality check: Chat.tsx rebuilds
      // `footerStatus` once a second during compaction, and without them the tick
      // compared EQUAL and the progress bar froze at its opening 0%.
      chatMessageViewPropsEqual
    );
  }
});

// tests/exploreHeader.ssr.test.tsx
import { jsx as jsx28 } from "react/jsx-runtime";
globalThis.window = {
  addEventListener: () => {
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => {
        };
      }
    }
  )
};
var { renderToString } = await import("react-dom/server");
var { ChatMessageView: ChatMessageView3 } = await Promise.resolve().then(() => (init_ChatMessage(), ChatMessage_exports));
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
function makeMessage(toolActivity) {
  return {
    id: "m-explore",
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    segments: toolActivity.map((_, index) => ({ kind: "tool", index })),
    toolActivity
  };
}
console.log("1) \u062F\u0648 explore \u0645\u0648\u0627\u0632\u06CC \u2192 \u062F\u0648 \u06A9\u0627\u0631\u062A \u0645\u0633\u062A\u0642\u0644 \u0645\u062B\u0644 tool group\u060C \u0647\u0631 \u06A9\u062F\u0627\u0645 \u0628\u0627 pill \u0646\u0627\u0645 \u062E\u0648\u062F\u0634:");
{
  const msg = makeMessage([
    {
      tool: "explore",
      status: "running",
      args: { description: "Find the auth flow", prompt: "where is login handled" },
      narration: "Reading src/auth.ts\nNow tracing the login handler"
    },
    {
      tool: "explore",
      status: "done",
      args: { description: "Map the settings store", prompt: "how are settings persisted" },
      summary: "4 files"
    }
  ]);
  const html = renderToString(/* @__PURE__ */ jsx28(ChatMessageView3, { message: msg }));
  const plain = html.replace(/<!--.*?-->/g, "");
  const text = plain.replace(/<[^>]*>/g, "");
  check("\u067E\u06CC\u0644 \u0633\u0627\u0628\u200C\u0627\u06CC\u062C\u0646\u062A \u0631\u0646\u062F\u0631 \u0634\u062F", html.includes("trace-pill-sub"));
  check(
    "\u0647\u0631 explore \u06A9\u0627\u0631\u062A \u0645\u0633\u062A\u0642\u0644 \u062E\u0648\u062F\u0634 \u0631\u0627 \u062F\u0627\u0631\u062F (\u06CC\u06A9 \u06AF\u0631\u0648\u0647 \u062F\u0631 \u06CC\u06A9 \u0642\u0627\u0628 tool-trace)",
    (html.match(/tool-group/g) || []).length === 2 && (html.match(/tool-trace/g) || []).length === 2,
    [html.match(/tool-group/g)?.length, html.match(/tool-trace/g)?.length]
  );
  check(
    "\u06A9\u0627\u0631\u062A explore \u0642\u062F\u06CC\u0645\u06CC (tool-card explore) \u0631\u0646\u062F\u0631 \u0646\u0634\u062F",
    !html.includes("tool-card explore") && !html.includes("explore-card-open")
  );
  check(
    "\u062A\u0648\u0636\u06CC\u062D \u06A9\u0627\u0631\u062A \u0627\u0648\u0644 tooltip \u067E\u06CC\u0644 \u0646\u0627\u0645 \u0627\u0633\u062A",
    html.includes("Find the auth flow"),
    html.slice(0, 300)
  );
  check(
    "\u0647\u062F\u0631 \u06A9\u0627\u0631\u062A \u062F\u0648\u0645 \u062A\u0648\u0636\u06CC\u062D \u062E\u0648\u062F\u0634 \u0631\u0627 \u062F\u0627\u0631\u062F (caption \u0648\u0642\u062A\u06CC narration \u0646\u06CC\u0633\u062A)",
    text.includes("Map the settings store"),
    text.slice(0, 300)
  );
  check(
    "\u0622\u062E\u0631\u06CC\u0646 \u062C\u0645\u0644\u0647\u0654 \u0633\u0627\u0628\u200C\u0627\u06CC\u062C\u0646\u062A caption \u0647\u062F\u0631 \u0627\u0633\u062A",
    text.includes("Now tracing the login handler"),
    text.slice(0, 400)
  );
  check(
    "\u062C\u0645\u0644\u0647\u0654 \u0627\u0648\u0644 narration \u062F\u0631 \u0647\u062F\u0631 \u0646\u06CC\u0633\u062A (\u0641\u0642\u0637 \u0622\u062E\u0631\u06CC\u0646 \u06A9\u067E\u0634\u0646)",
    !text.includes("Reading src/auth.ts"),
    text.slice(0, 400)
  );
  check(
    "\u062F\u0648 \u067E\u06CC\u0644 \u062C\u062F\u0627 (\u0646\u0647 \u06CC\u06A9 \xD72)",
    (html.match(/trace-pill-sub/g) || []).length === 2,
    (html.match(/trace-pill-sub/g) || []).length
  );
  check("\u0634\u0645\u0627\u0631\u0646\u062F\u0647 \xD72 \u0628\u0631\u0627\u06CC explore \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F", !html.includes("Explore \xD72"));
}
console.log("2) \u0627\u0628\u0632\u0627\u0631\u0647\u0627\u06CC \u0645\u0639\u0645\u0648\u0644\u06CC \u0647\u0645\u0686\u0646\u0627\u0646 \u0634\u0645\u0627\u0631\u0646\u062F\u0647\u200C\u0627\u06CC \u062C\u0645\u0639 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F:");
{
  const msg = makeMessage([
    { tool: "read", status: "done", args: { filePath: "a.ts" } },
    { tool: "read", status: "done", args: { filePath: "b.ts" } },
    { tool: "grep", status: "done", args: { pattern: "x" } }
  ]);
  const html = renderToString(/* @__PURE__ */ jsx28(ChatMessageView3, { message: msg }));
  const plain = html.replace(/<!--.*?-->/g, "");
  const badge = plain.match(/trace-pill-count[^>]*>([^<]*)</);
  check(
    "\u0634\u0645\u0627\u0631\u0646\u062F\u0647\u0654 \u062A\u0639\u062F\u0627\u062F \u0628\u0631\u0627\u06CC \u0627\u0628\u0632\u0627\u0631\u0647\u0627\u06CC \u0645\u0639\u0645\u0648\u0644\u06CC \u0631\u0646\u062F\u0631 \u0634\u062F",
    !!badge && badge[1].includes("2"),
    badge?.[1]
  );
  check("\u067E\u06CC\u0644 \u0633\u0627\u0628\u200C\u0627\u06CC\u062C\u0646\u062A \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F", !html.includes("trace-pill-sub"));
}
console.log("3) \u0628\u0631\u0686\u0633\u0628 \u0627\u0628\u0632\u0627\u0631 MCP \u0646\u0627\u0645 \u0633\u0631\u0648\u0631 \u0648 \u0627\u0628\u0632\u0627\u0631 \u0631\u0627 \u0646\u0634\u0627\u0646 \u0645\u06CC\u200C\u062F\u0647\u062F:");
{
  const msg = makeMessage([
    {
      tool: "mcp__playwright__browser_navigate",
      status: "done",
      args: { url: "https://example.com" }
    }
  ]);
  const html = renderToString(/* @__PURE__ */ jsx28(ChatMessageView3, { message: msg }));
  check("\u0646\u0627\u0645 \u0627\u0628\u0632\u0627\u0631 MCP \u062E\u0648\u0627\u0646\u0627 \u0634\u062F", html.includes("browser_navigate"), html.slice(0, 400));
  check("\u0646\u0627\u0645 \u0633\u0631\u0648\u0631 MCP \u062F\u0631 \u0628\u0631\u0686\u0633\u0628 \u0647\u0633\u062A", html.includes("playwright"));
  check("\u067E\u06CC\u0634\u0648\u0646\u062F \u062E\u0627\u0645 mcp__ \u0646\u0645\u0627\u06CC\u0634 \u062F\u0627\u062F\u0647 \u0646\u0634\u062F", !html.includes("mcp__playwright__"));
}
if (failed > 0) {
  console.error(`
${failed} check(s) failed`);
  process.exit(1);
} else {
  console.log("\n\u0647\u0645\u0647 \u0628\u0631\u0631\u0633\u06CC\u200C\u0647\u0627\u06CC \u0647\u062F\u0631 explore \u0645\u0648\u0641\u0642 \u0628\u0648\u062F");
}
