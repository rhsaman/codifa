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
    if (i % 2 === 1) return fixCodeBlock(p);
    return p.split("\n").map((line) => {
      if (REF_DEF_RE.test(line)) return line;
      return fixZwsp(line);
    }).join("\n");
  });
  return fixed.join("```");
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
var PERSIAN_RANGE, RTL_CHAR_RE, BIDI_MARKS, INVISIBLE_SEP, LEFT_WORDISH, RIGHT_WORDISH, FA_DIGITS, DIGITS_RE, LINE_RANGE_RE, LINE_RANGE_CONN_RE, PATH_RE, BARE_RANGE_FENCE_RE, COMMENT_PREFIX_RE, MIXED_WORD_RE, LRM, SCRIPT_BOUNDARY_RE;
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

// src/lib/fileTypes.ts
function isDocPath(raw) {
  if (!raw) return false;
  const s = raw.replace(INVISIBLE, "").trim();
  if (!s) return false;
  const { path } = splitPathLine(s);
  return DOC_EXTS.has(extOf(path));
}
function extOf(path) {
  const base = path.replace(INVISIBLE, "").trim().replace(/[.,;:)\]}'"`]+$/, "");
  const name = base.split(/[\\/]/).pop() ?? base;
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
    const base = fileBasename(p).toLowerCase();
    if (attached.has(base)) continue;
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    out.push(p);
  }
  return out;
}
var INVISIBLE, FILE_BADGES, IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS, DOC_EXTS, WHITELIST_EXTRA, BARE_NAME_RE, DIR_TOKEN_RE;
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
      selectFile: () => window.coder.selectFile(),
      importFile: (absPath) => window.coder.importFile(absPath),
      fsList: (root, rel) => window.coder.fsList(root, rel),
      fsWalk: (root) => window.coder.fsWalk(root),
      fsRead: (root, rel) => window.coder.fsRead(root, rel),
      fsWrite: (root, rel, content) => window.coder.fsWrite(root, rel, content),
      fsDelete: (root, rel) => window.coder.fsDelete(root, rel),
      coderList: (rel) => window.coder.coderList(rel),
      coderRead: (rel) => window.coder.coderRead(rel),
      coderWrite: (rel, content) => window.coder.coderWrite(rel, content),
      coderDelete: (rel) => window.coder.coderDelete(rel),
      searchContent: (root, query) => window.coder.searchContent(root, query),
      readImage: (absPath) => window.coder.readImage(absPath),
      normalizeImage: (absPath) => window.coder.normalizeImage(absPath),
      captureScreen: () => window.coder.captureScreen(),
      captureRegion: () => window.coder.captureRegion(),
      getPathForFile: (file) => window.coder.getPathForFile(file),
      storeGet: (key) => window.coder.storeGet(key),
      storeSet: (key, value) => window.coder.storeSet(key, value),
      getDataPath: () => window.coder.getDataPath(),
      hasSettingsFile: () => window.coder.hasSettingsFile(),
      moveDataPath: (p) => window.coder.moveDataPath(p),
      onSidecarChanged: (cb) => window.coder.onSidecarChanged(cb),
      onSidecarDead: (cb) => window.coder.onSidecarDead(cb),
      onFlushPersist: (cb) => window.coder.onFlushPersist(cb),
      flushPersistDone: () => window.coder.flushPersistDone(),
      onMigrateProgress: (cb) => window.coder.onMigrateProgress(cb),
      openFileExternal: async (absPath, editor) => {
        try {
          const fn = window.coder?.openFileExternal;
          if (typeof fn !== "function") {
            return { ok: false, error: "External open is unavailable (preload outdated \u2014 rebuild the app)." };
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
            return { ok: false, error: "Reveal in file manager is unavailable (preload outdated \u2014 rebuild the app)." };
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
            return { ok: false, error: "Terminal open is unavailable (preload outdated \u2014 rebuild the app)." };
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

// src/lib/context.ts
var PERSIAN_CHAR;
var init_context = __esm({
  "src/lib/context.ts"() {
    "use strict";
    init_bidi();
    PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
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
async function ensureSidecar() {
  if (sidecarInFlight) return sidecarInFlight;
  const p = (async () => {
    if (sidecarUrl) {
      if (await isSidecarAlive(sidecarUrl)) return sidecarUrl;
      sidecarUrl = null;
    }
    const url = await api.getSidecarUrl();
    if (url) sidecarUrl = url;
    return sidecarUrl;
  })();
  sidecarInFlight = p;
  p.finally(() => {
    sidecarInFlight = null;
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
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const isLocalTts = opts.kind === "local";
  const body = {
    text,
    provider: isLocalTts ? "local" : opts.kind
  };
  if (isLocalTts) {
    body.model = (opts.model ?? "").trim() || "default";
    if ((opts.baseUrl ?? "").trim()) body.base_url = (opts.baseUrl ?? "").trim();
    if ((opts.voice ?? "").trim()) body.voice = (opts.voice ?? "").trim();
  } else {
    body.base_url = opts.baseUrl;
    if ((opts.model ?? "").trim()) body.model = (opts.model ?? "").trim();
    if ((opts.voice ?? "").trim()) body.voice = (opts.voice ?? "").trim();
    const speakKeys = (opts.apiKeys ?? []).filter((k) => typeof k === "string" && k);
    if (speakKeys.length > 0) body.api_keys = JSON.stringify(speakKeys);
  }
  const timeoutSignal = AbortSignal.timeout(12e4);
  const anyFn = AbortSignal.any;
  const signal = callerSignal && typeof anyFn === "function" ? anyFn([callerSignal, timeoutSignal]) : callerSignal ?? timeoutSignal;
  const post = async (base) => {
    const chunks = [];
    let first = true;
    await postTtsChunks(base, body, signal, (chunk) => {
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
async function postTtsChunks(base, body, signal, onChunk) {
  const res = await fetch(`${base}/tts`, {
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
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…؟!])/u).map((s) => s.trim()).filter(Boolean);
  const sentences = parts.length > 0 ? parts : [clean];
  const out = [];
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    const words = s.split(" ");
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > maxLen && cur) {
        out.push(cur);
        cur = w;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
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
        providers: params.providers ?? {},
        text: params.text,
        chat_id: params.chatId ?? ""
      }),
      // Long budget so the backend fallback chain (title, compact, main)
      // fits inside one request; fire-and-forget so it never blocks the turn.
      signal: AbortSignal.timeout(9e4)
    });
    if (!res.ok) {
      console.warn(`[title] sidecar answered ${res.status} \u2014 keeping default chat title`);
      return none;
    }
    const data = await res.json().catch(() => ({}));
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) console.warn("[title] empty title reply \u2014 keeping default chat title");
    else console.info("[title] got title:", title, (params.chatId ?? "").slice(-6));
    return { title: title || null, usage: data.usage ?? null };
  } catch (err) {
    console.warn("[title] request failed \u2014 keeping default chat title", err);
    return none;
  }
}
async function listMcp() {
  const url = await ensureSidecar();
  if (!url) return { mcpServers: {}, builtins: [] };
  try {
    const res = await fetch(`${url}/mcp`);
    if (!res.ok) return { mcpServers: {}, builtins: [] };
    const data = await res.json();
    return {
      mcpServers: data.mcpServers ?? {},
      builtins: Array.isArray(data.builtins) ? data.builtins : []
    };
  } catch {
    return { mcpServers: {}, builtins: [] };
  }
}
async function saveMcp(name, cfg) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/mcp`, {
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
    await fetch(`${url}/mcp/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
  } catch {
  }
}
async function restoreCheckpoint(chatId, seq, root) {
  const url = await ensureSidecar();
  if (!url) return { ok: false, error: "Python agent not ready" };
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
var sidecarUrl, sidecarInFlight;
var init_api = __esm({
  "src/lib/api.ts"() {
    "use strict";
    init_fs();
    init_context();
    sidecarUrl = null;
    sidecarInFlight = null;
    api.onSidecarChanged(() => {
      sidecarUrl = null;
      sidecarInFlight = null;
    });
    api.onSidecarDead(() => {
      sidecarUrl = null;
      sidecarInFlight = null;
    });
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
        description: "Mentor mode: answers your questions and teaches you step by step \u2014 which file, which line, what to change. Read-only, never modifies anything.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: false, web: true }
      },
      {
        id: "plan",
        label: "Plan",
        icon: "list",
        description: "Plans the work: scouts the code and lays out concrete steps and changes for Build mode. Read-only files and terminal, never writes.",
        capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
      },
      {
        id: "build",
        label: "Build",
        icon: "code",
        description: "Write and edit code, run commands. Full access to your project.",
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
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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
        baseUrlHint: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1",
        baseUrlDesc: "Workers AI.",
        extraHint: "Also requires CLOUDFLARE_ACCOUNT_ID in your environment.",
        defaultBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1"
      },
      tokenrouter: {
        kind: "tokenrouter",
        label: "TokenRouter",
        name: "TokenRouter",
        requiresKey: true,
        builtin: true,
        baseUrlHint: "https://api.tokenrouter.com/v1",
        baseUrlDesc: "Unified AI model hub.",
        defaultBaseUrl: "https://api.tokenrouter.com/v1"
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
    DEFAULT_THEME = "catppuccin";
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
  for (const c of node.children) out.push(...collectChatIds(c));
  return out;
}
function leafCount(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.children.reduce((n, c) => n + leafCount(c), 0);
}
function containsChat(node, chatId) {
  if (!node) return false;
  if (node.kind === "leaf") return node.chatId === chatId;
  return node.children.some((c) => containsChat(c, chatId));
}
function findLeafByChat(node, chatId) {
  if (!node) return null;
  if (node.kind === "leaf") return node.chatId === chatId ? node : null;
  for (const c of node.children) {
    const hit = findLeafByChat(c, chatId);
    if (hit) return hit;
  }
  return null;
}
function findParent(node, childId) {
  if (!node || node.kind !== "split") return null;
  for (const c of node.children) {
    if (c.id === childId) return node;
    if (c.kind === "split") {
      const hit = findParent(c, childId);
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
  for (const c of node.children) {
    const next = removeChat(c, chatId);
    if (next) children.push(next);
    if (next !== c) changed = true;
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
  const children = node.children.map((c) => {
    const next = swapChats(c, a, b) ?? c;
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}
function replaceChat(node, targetChatId, nextChatId) {
  if (node.kind === "leaf") {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node;
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = replaceChat(c, targetChatId, nextChatId);
    if (next !== c) changed = true;
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
  for (const c of node.children) {
    const next = normalizeTree(c, validIds, seen);
    if (next) children.push(next);
    if (next !== c) changed = true;
  }
  if (children.length === 0) return null;
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
    const idx = parent.children.findIndex((c) => c.id === target.id);
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
      const rest = pTarget.children.filter((c) => c.id !== dragLeaf.id);
      let dest = rest.findIndex((c) => c.id === targetLeaf.id) + (before ? 0 : 1);
      dest = Math.max(0, Math.min(rest.length, dest));
      const reordered = rest.slice();
      reordered.splice(dest, 0, dragLeaf);
      return replaceNode(root, pTarget.id, { ...pTarget, children: reordered });
    }
  }
  const dragSize = dragLeaf?.size ?? 1;
  const base = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root;
  if (!base) return makeLeaf(dragChatId, dragSize);
  const target = findLeafByChat(base, targetChatId);
  if (!target) return appendChat(base, dragChatId, dirNeeded);
  const fresh = makeLeaf(dragChatId, dragSize);
  const parent = findParent(base, target.id);
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c) => c.id === target.id);
    const children = parent.children.slice();
    children.splice(before ? idx : idx + 1, 0, fresh);
    return replaceNode(base, parent.id, { ...parent, children });
  }
  const split = makeSplit(
    dirNeeded,
    before ? [fresh, { ...target }] : [{ ...target }, fresh],
    target.size
  );
  split.children[0].size = 1;
  split.children[1].size = 1;
  return replaceNode(base, target.id, split);
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
    const base = removeChat(root, dragChatId);
    if (!base) return makeLeaf(dragChatId, dragSize);
    const fresh2 = makeLeaf(dragChatId, dragSize);
    if (base.kind === "split" && base.dir === dirNeeded) {
      const children = before ? [fresh2, ...base.children] : [...base.children, fresh2];
      return { ...base, children };
    }
    return makeSplit(dirNeeded, before ? [fresh2, base] : [base, fresh2]);
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
  const children = node.children.map((c) => {
    const r = replaceNode(c, id, next);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}
function setNodeSize(node, id, size) {
  if (!node) return null;
  if (node.id === id) return { ...node, size: clampSize(size) };
  if (node.kind === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = setNodeSize(c, id, size);
    if (next && next !== c) changed = true;
    return next ?? c;
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
function toggleFullscreenId(current, target) {
  if (!target) return current;
  return current === target ? null : target;
}
var TREE_KEY, CHAT_WINDOW_MAX;
var init_chatTree = __esm({
  "src/lib/chatTree.ts"() {
    "use strict";
    TREE_KEY = "coder:chatTree";
    CHAT_WINDOW_MAX = 6;
  }
});

// src/lib/store.ts
import { create } from "zustand";
function normalizeScheduleRunsSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN);
}
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
function lspStatusLabel(status) {
  if (!status) return null;
  if (status.phase === "done" || status.phase === "error") return null;
  const lang = (status.language ?? "").trim();
  const suffix = lang ? ` ${lang}` : "";
  if (status.phase === "updating") return `\u062F\u0631 \u062D\u0627\u0644 \u0622\u067E\u062F\u06CC\u062A LSP${suffix}...`;
  return `\u062F\u0631 \u062D\u0627\u0644 \u0646\u0635\u0628 LSP${suffix}...`;
}
function sanitizeChats(chats) {
  return chats.filter((c) => (c.messages?.length ?? 0) > 0).map((c) => {
    const clean = { ...c };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
    return {
      ...clean,
      messages: capCompactedMessages(c.messages.map((m) => {
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
    };
  });
}
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
function persistTreeMirrors(tree, fallbackLayout) {
  persistChatTree(tree);
  if (!tree) return { visibleChatIds: [], chatWindowSizes: {}, chatLayout: fallbackLayout };
  const visibleChatIds = collectChatIds(tree);
  const chatWindowSizes = sizesByChat(tree);
  const chatLayout = tree.kind === "split" ? tree.dir === "row" ? "horizontal" : "vertical" : fallbackLayout;
  persistVisibleChats(visibleChatIds);
  persistWindowSizes(chatWindowSizes);
  persistChatLayout(chatLayout);
  return { visibleChatIds, chatWindowSizes, chatLayout };
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
function persistPanelsSoon() {
  clearTimeout(panelPersistTimer);
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = void 0;
    void writeSettingsNow(useStore.getState());
  }, PERSIST_DEBOUNCE_MS);
}
function writeChatsNow(s) {
  const streaming = s.chats.filter((c) => c.messages.some((m) => m.streaming));
  const subset = streaming.length > 0 ? streaming : s.chats.filter((c) => c.id === s.activeChatId);
  if (subset.length === 0) return;
  void api.storeSet("chats", sanitizeChats(subset));
}
function writeSettingsNow(s) {
  if (!s.settingsHydrated) return Promise.resolve();
  const seq = ++persistSeq;
  return (async () => {
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
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
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s;
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
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
        if (seq !== persistSeq) return;
        await api.storeSet("settings", payload);
      })()
    );
  }
  const del = s.deletedChatIds;
  if (del.length) writes.push(api.storeSet("deleted_chats", del));
  const delW = s.deletedWorkspaceRoots;
  if (delW.length) writes.push(api.storeSet("deleted_workspaces", delW));
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
    row("cloudflare"),
    row("tokenrouter")
  ];
}
function normalizeProvider(p) {
  const rawKind = p.kind || "";
  const kind = rawKind === "opencode" ? "custom" : p.kind || "custom";
  const meta = PROVIDER_META[kind];
  const raw = p;
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
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl: p.baseUrl || meta?.defaultBaseUrl || "",
    model: p.model || "",
    contextMap: p.contextMap,
    manualContextMap: p.manualContextMap,
    manualReasoningMap: p.manualReasoningMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
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
function dedupeChats(chats) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = chats.length - 1; i >= 0; i--) {
    const c = chats[i];
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
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
function makeChat(mode = "ask") {
  const now = Date.now();
  const s = useStore.getState();
  const activeProvider = s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
  const recent = sortRecentModels(s.recentModels)[0];
  const recentProvider = recent ? s.settings.providers.find((p) => p.id === recent.providerId) : void 0;
  const providerId = recentProvider?.id ?? activeProvider?.id;
  const model = recentProvider && recent ? recent.model : activeProvider?.model;
  let id = uid();
  while (s.chats.some((c) => c.id === id)) id = uid();
  return {
    id,
    title: "New chat",
    mode,
    thinkingLevel: "medium",
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
var MAX_SCHEDULE_RUNS_SEEN, uid, MAX_COMPACTED_PER_CHAT, MID_STREAM_MS, lastMidStreamPersist, MAX_TOOL_TEXT, MAX_TOOL_ARG, MAX_PERSIST_IMAGE_CHARS, MODE_LABELS, SEARCH_PLUGIN_LABELS, persistTimer, PERSIST_DEBOUNCE_MS, OPEN_CHATS_KEY, ACTIVE_CHAT_KEY, VISIBLE_CHATS_KEY, WINDOW_SIZES_KEY, CHAT_LAYOUT_KEY, CHAT_FULL_KEY, WINDOW_FULL_KEY, TERMINAL_PANEL_KEY, TERMINAL_FULL_KEY, panelPersistTimer, persistSeq, historyStacks, PROVIDER_NAMES, MAX_PINNED_RECENT_MODELS, useStore;
var init_store = __esm({
  "src/lib/store.ts"() {
    "use strict";
    init_fs();
    init_api();
    init_modes();
    init_secrets();
    init_provider_meta();
    init_themes();
    init_usage();
    init_chatTree();
    MAX_SCHEDULE_RUNS_SEEN = 500;
    uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    MAX_COMPACTED_PER_CHAT = 50;
    MID_STREAM_MS = 2e3;
    lastMidStreamPersist = 0;
    MAX_TOOL_TEXT = 4e3;
    MAX_TOOL_ARG = 2e3;
    MAX_PERSIST_IMAGE_CHARS = 1e5;
    MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build" };
    SEARCH_PLUGIN_LABELS = {
      duckduckgo: "DuckDuckGo",
      tavily: "Tavily"
    };
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
    historyStacks = /* @__PURE__ */ new Map();
    PROVIDER_NAMES = Object.fromEntries(
      Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
    );
    MAX_PINNED_RECENT_MODELS = 3;
    useStore = create((set, get) => ({
      loaded: false,
      settingsHydrated: false,
      settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80 },
      builtinMcp: [],
      root: "",
      theme: DEFAULT_THEME,
      dir: "rtl",
      fontSize: 14,
      vectorDbPath: "",
      webSearchAutoFetch: 3,
      ragWebTtlDays: 90,
      whisperModel: "Systran/faster-whisper-medium",
      whisperBaseUrl: "",
      sttProviderId: "local",
      sttModel: "whisper-1",
      sttFallbacks: [],
      ttsProviderId: "",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFallbacks: [],
      embeddingModel: "intfloat/multilingual-e5-base",
      embeddingBaseUrl: "",
      recentModels: [],
      subagentModels: {},
      cacheTtlMinutes: 60,
      historyLimit: 0,
      searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
      sidebarOpen: true,
      rightPanelOpen: false,
      terminalPanelOpen: typeof window !== "undefined" ? loadTerminalPanel() : false,
      terminalFullscreen: typeof window !== "undefined" ? loadTerminalFullscreen() : false,
      dataPath: "",
      workspaceColors: {},
      pinnedWorkspaces: [],
      pinnedChats: [],
      workspaces: [],
      chats: [],
      deletedChatIds: [],
      deletedWorkspaceRoots: [],
      activeChatId: typeof window !== "undefined" ? loadActiveChat() : "",
      openChatIds: typeof window !== "undefined" ? loadOpenChats() : [],
      visibleChatIds: typeof window !== "undefined" ? loadVisibleChats() : [],
      chatWindowSizes: typeof window !== "undefined" ? loadWindowSizes() : {},
      chatLayout: typeof window !== "undefined" ? loadChatLayout() : "vertical",
      chatTree: typeof window !== "undefined" ? loadChatTree() : null,
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
      chatAborts: {},
      setChatAbort: (chatId, abort) => set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),
      load: async () => {
        const [settings, chats] = await Promise.all([
          api.storeGet("settings"),
          api.storeGet("chats")
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
        const loadedChats = dedupedChats.map((c) => {
          const clean = { ...c };
          delete clean.compacting;
          delete clean.compactNotice;
          delete clean.compactError;
          delete clean.cmdError;
          delete clean.skillNotice;
          delete clean.stalled;
          const migrated = normalizeUsageEntry(
            clean.usage,
            c.providerId ?? settings?.activeProviderId ?? "",
            providerIds
          );
          const next = migrated ? { ...clean, usage: migrated } : clean;
          if (next.goal?.active && !next.goal.paused) {
            next.goal = { ...next.goal, stopped: true };
          }
          return next.mode ? { ...next, mode: normalizeMode(next.mode) } : next;
        });
        const prevActiveId = get().activeChatId;
        const memOpen = get().openChatIds;
        const memVisible = get().visibleChatIds ?? [];
        const fallbackActive = keptChats && prevChats.some((c) => c.id === prevActiveId) ? prevActiveId : loadedChats[loadedChats.length - 1]?.id ?? "";
        const validIds = new Set(loadedChats.map((c) => c.id));
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
        if (Array.isArray(raw.providers) && raw.providers.length > 0) {
          providers = raw.providers.map(normalizeProvider);
          const present = new Set(providers.map((p) => p.id));
          for (const def of defaultProviders()) {
            if (!present.has(def.id)) providers.push(def);
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
          compactAtPercent: typeof raw.compactAtPercent === "number" && raw.compactAtPercent >= 1 && raw.compactAtPercent <= 99 ? Math.round(raw.compactAtPercent) : 80
        };
        const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14;
        document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
        let workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map((w) => ({
          key: String(w?.key ?? workspaceKey(String(w?.root ?? ""))),
          root: typeof w?.root === "string" ? w.root : null,
          label: String(w?.label ?? "").trim() || workspaceLabel(String(w?.root ?? ""))
        })) : [];
        const chatRoots = [...new Set(loadedChats.map((c) => c.root ?? ""))];
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
        const root = typeof raw.root === "string" ? raw.root : "";
        const dbMcp = await listMcp();
        const mergedMcp = { ...loadedSettings.mcpServers ?? {}, ...dbMcp.mcpServers ?? {} };
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
          root,
          dir: raw.dir === "ltr" ? "ltr" : "rtl",
          fontSize,
          vectorDbPath: typeof raw.vectorDbPath === "string" ? raw.vectorDbPath : "",
          dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
          whisperModel: typeof raw.whisperModel === "string" && raw.whisperModel.trim() ? raw.whisperModel : "Systran/faster-whisper-medium",
          whisperBaseUrl: typeof raw.whisperBaseUrl === "string" ? raw.whisperBaseUrl : "",
          sttProviderId: typeof raw.sttProviderId === "string" && raw.sttProviderId.trim() ? raw.sttProviderId : "local",
          sttModel: typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel : "whisper-1",
          sttFallbacks: normalizeSttFallbacks(raw.sttFallbacks),
          ttsProviderId: typeof raw.ttsProviderId === "string" ? raw.ttsProviderId.trim() : "",
          // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
          // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
          ttsModel: typeof raw.ttsModel === "string" ? raw.ttsModel.trim() : "tts-1",
          ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim() : "alloy",
          ttsFallbacks: normalizeTtsFallbacks(raw.ttsFallbacks),
          embeddingModel: typeof raw.embeddingModel === "string" && raw.embeddingModel.trim() ? raw.embeddingModel : "intfloat/multilingual-e5-base",
          embeddingBaseUrl: typeof raw.embeddingBaseUrl === "string" ? raw.embeddingBaseUrl : "",
          subagentModels: (() => {
            if (typeof raw.subagentModels !== "object" || raw.subagentModels === null) return {};
            const m = { ...raw.subagentModels };
            const legacy = (m.subagent ?? "").trim();
            if (legacy) {
              m.explore = legacy;
              delete m.subagent;
            }
            return m;
          })(),
          // Coerce numbers defensively: settings.json may round-trip numbers
          // through JSON safely, but the IPC layer or an older settings file
          // can hand us string-shaped digits ("30") or null. Accept anything that
          // coerces to a valid value rather than silently falling back to the
          // default — the user did set it, so don't erase their choice.
          cacheTtlMinutes: coercePositiveInt(raw.cacheTtlMinutes, 60),
          historyLimit: coerceNonNegInt(raw.historyLimit, 0),
          // Migration: اگه settings قدیمی webSearchTtlDays داشت ولی ragWebTtlDays نداشت،
          // مقدار webSearchTtlDays → ragWebTtlDays منتقل بشه.
          ragWebTtlDays: coercePositiveInt(raw.ragWebTtlDays, 0) || coercePositiveInt(raw.webSearchTtlDays, 0) || 90,
          // 0 is a valid, deliberate value (auto-fetch disabled) — keep it.
          webSearchAutoFetch: coerceBoundedInt(raw.webSearchAutoFetch, 3, 0, 10),
          // Hard desktop-control switch: absent/false in old settings files = OFF.
          computerUse: raw.computerUse === true,
          // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
          // are dropped here so they disappear from Settings → Plugins on reload.
          searchPlugins: searchPlugins.length > 0 ? searchPlugins : [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
          searchConsole: migratedSc,
          recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
          sidebarOpen: raw.sidebarOpen !== false,
          rightPanelOpen: raw.rightPanelOpen === true,
          workspaceColors: raw.workspaceColors ?? {},
          pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
          pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
          scheduleRunsSeen: normalizeScheduleRunsSeen(raw.scheduleRunsSeen),
          workspaces,
          chats: loadedChats,
          activeChatId: activeId,
          openChatIds,
          visibleChatIds,
          chatTree,
          // Self-clean pre-existing empty chats left on disk by older builds (a
          // fresh tab used to persist immediately). They stay usable in-memory
          // but are queued for file deletion on the next persist; live chats that
          // already have messages are untouched. In-memory-only empty tabs can
          // never appear here (they are filtered from disk writes), so this only
          // ever matches stale files.
          deletedChatIds: [
            .../* @__PURE__ */ new Set([
              ...get().deletedChatIds,
              ...loadedChats.filter((c) => (c.messages?.length ?? 0) === 0).map((c) => c.id)
            ])
          ]
        });
      },
      persist: () => {
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
          name: "New provider",
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
          return { settings: { ...s.settings, providers: out, activeProviderId: active } };
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
          chats: s.chats.map((c) => {
            const owner = c.providerId ?? s.settings.activeProviderId;
            if (owner !== providerId || !c.model || valid.has(bare(c.model))) return c;
            return { ...c, model: fallback };
          }),
          recentModels: s.recentModels.filter(
            (r) => r.providerId !== providerId || valid.has(bare(r.model))
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
      setDir: (dir) => {
        set({ dir });
        get().persist();
      },
      toggleDir: () => {
        const next = get().dir === "rtl" ? "ltr" : "rtl";
        get().setDir(next);
      },
      setFontSize: (fontSize) => {
        const n = Math.min(24, Math.max(10, Math.round(fontSize)));
        document.documentElement.style.setProperty("--chat-font-size", `${n}px`);
        set({ fontSize: n });
        get().persist();
      },
      setVectorDbPath: (vectorDbPath) => {
        set({ vectorDbPath: (vectorDbPath ?? "").trim() });
        get().persist();
      },
      setDataPath: (dataPath) => {
        set({ dataPath: (dataPath ?? "").trim() });
        get().persist();
      },
      setWhisperModel: (m) => {
        set({ whisperModel: (m ?? "").trim() || "Systran/faster-whisper-medium" });
        get().persist();
      },
      setWhisperBaseUrl: (u) => {
        set({ whisperBaseUrl: (u ?? "").trim() });
        get().persist();
      },
      setSttProviderId: (id) => {
        set({ sttProviderId: (id ?? "").trim() || "local" });
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
      setEmbeddingModel: (m) => {
        set({ embeddingModel: (m ?? "").trim() || "intfloat/multilingual-e5-base" });
        get().persist();
      },
      setEmbeddingBaseUrl: (u) => {
        set({ embeddingBaseUrl: (u ?? "").trim() });
        get().persist();
      },
      setWebSearchAutoFetch: (n) => {
        const r = Math.round(n);
        set({ webSearchAutoFetch: Number.isFinite(r) ? Math.max(0, Math.min(10, r)) : 3 });
        get().persist();
      },
      setRagWebTtlDays: (d) => {
        set({ ragWebTtlDays: Math.max(1, Math.round(d) || 90) });
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
      },
      setMemoryTtlConfig: (c) => {
        set({
          cacheTtlMinutes: typeof c.cache === "number" && c.cache > 0 ? Math.round(c.cache) : get().cacheTtlMinutes
        });
        get().persist();
      },
      setHistoryLimit: (n) => {
        set({ historyLimit: Math.max(0, Math.round(n) || 0) });
        get().persist();
      },
      setSearchPlugins: (searchPlugins) => {
        set({ searchPlugins });
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
      setRecentModels: (recentModels) => {
        set({ recentModels });
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
        const prevRoot = s.chats.find((c) => c.id === s.activeChatId)?.root;
        const lastRoot = [...s.chats].reverse().find((c) => c.root)?.root;
        chat.root = prevRoot ?? lastRoot ?? s.root;
        const activeChatId = chat.id;
        set((st) => {
          const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
          persistOpenState(openChatIds, activeChatId);
          const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
          if (single) {
            persistVisibleChats([activeChatId]);
            persistChatTree(null);
            return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false };
          }
          const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
          const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
          return { chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false };
        });
        get().persist();
        return activeChatId;
      },
      newChatInRoot: (root, mode) => {
        const key = workspaceKey(root ?? "");
        const chat = makeChat(mode ?? "ask");
        chat.root = root || void 0;
        const activeChatId = chat.id;
        set((st) => {
          let workspaces = st.workspaces;
          if (!workspaces.some((w) => w.key === key)) {
            workspaces = [...workspaces, makeWorkspace(root ?? "")];
          }
          const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
          persistOpenState(openChatIds, activeChatId);
          const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
          if (single) {
            persistVisibleChats([activeChatId]);
            persistChatTree(null);
            return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false };
          }
          const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
          const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
          return { workspaces, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false };
        });
        get().persist();
        return activeChatId;
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
        set((s) => {
          const chats = s.chats.filter((c) => c.id !== id);
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
          const validIds = new Set(chats.map((c) => c.id));
          const baseTree = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const normalized = normalizeTree(removeChat(baseTree, id), validIds);
          const fallbackVisible = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          const chatWindowSizes = mirrors.chatWindowSizes;
          return {
            chats,
            activeChatId,
            openChatIds: finalOpen,
            visibleChatIds,
            chatWindowSizes,
            chatTree,
            deletedChatIds: [...s.deletedChatIds, id],
            pinnedChats: s.pinnedChats.filter((k) => k !== id),
            unreadChats: s.unreadChats.filter((cid) => cid !== id)
          };
        });
        get().persist();
      },
      deleteWorkspace: (key) => {
        set((s) => {
          const chats = s.chats.filter((c) => workspaceKey(c.root ?? "") !== key);
          const workspaces = s.workspaces.filter((w) => w.key !== key);
          const doomedIds = new Set(
            s.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.id)
          );
          const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key);
          const pinnedChats = s.pinnedChats.filter((k) => !doomedIds.has(k));
          const activeChatId = s.chats.some((c) => c.id === s.activeChatId && workspaceKey(c.root ?? "") !== key) ? s.activeChatId : chats[chats.length - 1]?.id ?? "";
          const openChatIds = s.openChatIds.filter((cid) => !doomedIds.has(cid));
          if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(chats.map((c) => c.id));
          const baseTreeWs = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          let pruned = baseTreeWs;
          for (const dead of doomedIds) pruned = removeChat(pruned, dead);
          const normalizedWs = normalizeTree(pruned, validIds);
          const fallbackWs = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId);
          const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsWs = persistTreeMirrors(chatTreeWs, s.chatLayout);
          const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs;
          return {
            chats,
            workspaces,
            pinnedWorkspaces,
            pinnedChats,
            activeChatId,
            openChatIds,
            visibleChatIds,
            chatTree: chatTreeWs,
            chatWindowSizes: mirrorsWs.chatWindowSizes,
            chatLayout: mirrorsWs.chatLayout,
            unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
            deletedChatIds: [
              ...s.deletedChatIds,
              ...s.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.id)
            ],
            deletedWorkspaceRoots: [
              ...s.deletedWorkspaceRoots,
              ...s.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.root ?? "")
            ]
          };
        });
        get().persist();
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
        const prevRoot = prev?.root ?? get().chats.find((c) => workspaceKey(c.root ?? "") === key)?.root ?? "";
        if (nextKey === key) {
          set((s) => ({
            workspaces: s.workspaces.map(
              (w) => w.key === key ? { ...w, root: nextRoot || null } : w
            ),
            chats: s.chats.map(
              (c) => workspaceKey(c.root ?? "") === key ? { ...c, root: nextRoot || void 0, updatedAt: Date.now() } : c
            ),
            root: s.root === prevRoot ? nextRoot : s.root
          }));
          get().persist();
          return key;
        }
        if (!prev && get().chats.every((c) => workspaceKey(c.root ?? "") !== key)) {
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
          return {
            workspaces,
            chats: s.chats.map(
              (c) => workspaceKey(c.root ?? "") === key ? { ...c, root: nextRoot || void 0, updatedAt: Date.now() } : c
            ),
            workspaceColors,
            pinnedWorkspaces: s.pinnedWorkspaces.map((k) => k === key ? nextKey : k),
            root: s.root === prevRoot ? nextRoot : s.root,
            deletedWorkspaceRoots: prevRoot ? [...s.deletedWorkspaceRoots, prevRoot] : s.deletedWorkspaceRoots
          };
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
            const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
            chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
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
        set((s) => {
          if (!s.chats.some((c) => c.id === id)) return {};
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
            const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
            chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
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
          const validIds = new Set(s.chats.map((c) => c.id));
          const baseTreeCt = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const normalizedCt = normalizeTree(removeChat(baseTreeCt, id), validIds);
          const fallbackCt = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTreeCt = normalizedCt ?? (fallbackCt.length > 0 ? buildFromList(fallbackCt, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsCt = persistTreeMirrors(chatTreeCt, s.chatLayout);
          const visibleChatIds = mirrorsCt.visibleChatIds.length > 0 ? mirrorsCt.visibleChatIds : fallbackCt;
          const recentlyClosedChatTabs = s.chats.some((c) => c.id === id) ? [{ id, at: Date.now() }, ...s.recentlyClosedChatTabs.filter((r) => r.id !== id)].slice(0, 8) : s.recentlyClosedChatTabs;
          return { openChatIds, activeChatId, visibleChatIds, chatTree: chatTreeCt, chatWindowSizes: mirrorsCt.chatWindowSizes, chatLayout: mirrorsCt.chatLayout, recentlyClosedChatTabs };
        });
        persistSoon();
      },
      closeInactiveChatTabs: () => {
        let closed = [];
        set((s) => {
          const streaming = new Set(
            s.chats.filter((c) => c.messages.some((m) => m.streaming || m.retry?.reconnecting === true)).map((c) => c.id)
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
          const validIds = new Set(s.chats.map((c) => c.id));
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
          const kept = toClose.filter((id) => s.chats.some((c) => c.id === id));
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
        set((s) => {
          if (!s.chats.some((c) => c.id === id)) return {};
          const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [s.activeChatId], s.chatLayout);
          const openChatIds = s.openChatIds.includes(id) ? s.openChatIds : [...s.openChatIds, id];
          persistOpenState(openChatIds, id);
          const chatTree = containsChat(base, id) ? base : openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
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
      closeWindow: (id) => {
        set((s) => {
          const treeIds = s.chatTree ? collectChatIds(s.chatTree) : [];
          const ids = treeIds.length > 0 ? treeIds : s.visibleChatIds;
          if (!ids.includes(id) && !s.visibleChatIds.includes(id)) return {};
          if ((/* @__PURE__ */ new Set([...treeIds, ...s.visibleChatIds])).size <= 1 && ids.length <= 1) return {};
          const idx = ids.indexOf(id);
          const base = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const pruned = removeChat(base, id);
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
        set((s) => {
          if (!s.chats.some((c) => c.id === id)) return {};
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
              const base = ensureTree(chatTree, visibleChatIds, s.chatLayout);
              chatTree = openBeside(base, id, s.activeChatId, smartAppendDir(s.chatLayout));
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
            const base = ensureTree(s.chatTree, s.visibleChatIds, s.chatLayout);
            if (!base) return {};
            const flatDir = base.kind === "split" ? base.dir : treeDirFromLayout(s.chatLayout);
            const isFlat = base.kind !== "split" || base.children.every((c) => c.kind === "leaf");
            const root = isFlat && base.kind === "split" ? base : buildFromList(collectChatIds(base), flatDir);
            if (!root || root.kind !== "split") return {};
            const ids = collectChatIds(root);
            if (!ids.includes(fromId) || !ids.includes(toId) || fromId === toId) return {};
            const rest2 = ids.filter((cid) => cid !== fromId);
            let dest2 = rest2.indexOf(toId) + (after ? 1 : 0);
            dest2 = Math.max(0, Math.min(rest2.length, dest2));
            const ordered = rest2.slice();
            ordered.splice(dest2, 0, fromId);
            const sizes = sizesByChat(base);
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
          if (!s.chats.some((c) => c.id === dragChatId)) return {};
          if (!s.chats.some((c) => c.id === targetChatId)) return {};
          const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [targetChatId], s.chatLayout);
          if (base && !containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX && pos !== "center") {
            const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOnto(base, dragChatId, targetChatId, pos);
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
          if (!s.chats.some((c) => c.id === dragChatId)) return {};
          const base = ensureTree(s.chatTree, s.visibleChatIds.length > 0 ? s.visibleChatIds : [dragChatId], s.chatLayout);
          if (!base) return {};
          if (!containsChat(base, dragChatId) && leafCount(base) >= CHAT_WINDOW_MAX) {
            const openChatIds2 = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
            persistOpenState(openChatIds2, s.activeChatId);
            return { openChatIds: openChatIds2 };
          }
          const openChatIds = s.openChatIds.includes(dragChatId) ? s.openChatIds : [...s.openChatIds, dragChatId];
          persistOpenState(openChatIds, dragChatId);
          const chatTree = dropOntoRoot(base, dragChatId, pos);
          if (!chatTree || chatTree === base) return { openChatIds };
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
        set((s) => ({
          chats: s.chats.map((c) => {
            if (c.id !== id) return c;
            const label = MODE_LABELS[mode] ?? mode;
            const modeMsg = {
              id: uid(),
              role: "system",
              content: `[Mode switched to ${label} \u2014 the next user message runs in ${label} mode.]`,
              modeSwitch: true,
              createdAt: Date.now()
            };
            return { ...c, mode, messages: [...c.messages, modeMsg], updatedAt: Date.now() };
          })
        }));
        get().persist();
      },
      setChatModeQuiet: (id, mode) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, mode, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setGoal: (id, condition) => {
        const text = (condition ?? "").trim();
        if (!text) return;
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id ? { ...c, goal: { condition: text, active: true, paused: false, stopped: false, startedAt: Date.now(), turns: 0 }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      clearGoal: (id) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, goal: null, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      pauseGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: true, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      resumeGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id && c.goal?.active ? { ...c, goal: { ...c.goal, paused: false, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      stopGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id && c.goal?.active && !c.goal.paused ? { ...c, goal: { ...c.goal, stopped: true }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      rearmGoal: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id && c.goal?.active && c.goal.stopped ? { ...c, goal: { ...c.goal, stopped: false }, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      incrementGoalTurn: (id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id && c.goal?.active && !c.goal.paused ? { ...c, goal: { ...c.goal, turns: (c.goal.turns ?? 0) + 1 } } : c
          )
        }));
        get().persist();
      },
      setChatRoot: (id, root) => {
        set((s) => ({
          root: s.activeChatId === id ? root : s.root,
          chats: s.chats.map((c) => c.id === id ? { ...c, root, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setChatDraft: (id, patch) => {
        set((s) => {
          const idx = s.chats.findIndex((c) => c.id === id);
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
          chats: s.chats.map((c) => c.id === id ? { ...c, thinkingLevel: level, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      setChatProvider: (id, providerId, model) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, providerId, model, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      renameChat: (id, title) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, title, updatedAt: Date.now() } : c)
        }));
        get().persist();
      },
      forkSection: (messageId, sectionTitle, sectionContent) => {
        const s = useStore.getState();
        const src = s.chats.find((c) => c.messages.some((m) => m.id === messageId));
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
        const src = get().chats.find((c) => c.messages.some((m) => m.id === messageId));
        if (!src) return null;
        const idx = src.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return null;
        const chatId = get().newChatInRoot(src.root ?? "", src.mode);
        if (src.providerId) {
          get().setChatProvider(chatId, src.providerId, src.model ?? "");
        }
        const cut = src.messages.slice(0, idx + 1).map((m) => ({ ...m }));
        set((st) => ({
          chats: st.chats.map(
            (c) => c.id === chatId ? {
              ...c,
              messages: cut,
              title: `${src.title} (fork)`.slice(0, 80),
              thinkingLevel: src.thinkingLevel,
              updatedAt: Date.now()
            } : c
          ),
          activeChatId: chatId
        }));
        get().persist();
        get().setFocusComposer(true);
        return chatId;
      },
      addMessage: (chatId, message2) => {
        const id = uid();
        const full = { ...message2, id, createdAt: Date.now() };
        const prev = get().chats.find((c) => c.id === chatId);
        const autoTitle = message2.content.slice(0, 48);
        const hasPriorUser = !!prev?.messages.some((m) => m.role === "user");
        const shouldTitle = message2.role === "user" && !!prev && !hasPriorUser && prev.title === "New chat" && message2.content.trim() !== "";
        set((s) => {
          if (message2.role === "user") {
            const st = stackFor(chatId);
            st.redo = [];
          }
          const chats = s.chats.map(
            (c) => c.id === chatId ? {
              ...c,
              messages: [...c.messages, full],
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt: !message2.streaming && (message2.role === "user" || message2.role === "assistant") ? Date.now() : c.updatedAt,
              title: c.messages.length === 0 && message2.role === "user" ? message2.content.slice(0, 48) : c.title
            } : c
          );
          return { chats };
        });
        get().persist();
        if (shouldTitle) {
          console.info("[title] generating title for new chat", chatId.slice(-6));
          void (async () => {
            try {
              const st = get();
              const chat = st.chats.find((c) => c.id === chatId);
              const provider = st.settings.providers.find(
                (p) => p.id === (chat?.providerId ?? st.settings.activeProviderId)
              ) ?? st.settings.providers[0];
              if (!provider) return;
              const res = await requestChatTitle({
                provider,
                subagentModels: st.subagentModels ?? {},
                providers: Object.fromEntries(
                  (st.settings.providers ?? []).map((p) => [p.id, p])
                ),
                text: message2.content.slice(0, 1e3),
                chatId
              });
              const title = typeof res?.title === "string" ? res.title.trim() : "";
              if (title) {
                try {
                  const cur = get().chats.find((c) => c.id === chatId);
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
        } else if (message2.role === "user" && !!prev && !hasPriorUser && message2.content.trim() !== "") {
          if (prev.title !== autoTitle) {
            console.info("[title] trigger skipped \u2014 current title:", prev.title, chatId.slice(-6));
          } else {
            console.debug("[title] trigger skipped \u2014 title already matches first message", chatId.slice(-6));
          }
        }
        return full;
      },
      removeMessage: (chatId, id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === chatId ? { ...c, messages: c.messages.filter((m) => m.id !== id) } : c
          )
        }));
        get().persist();
      },
      queueMessage: (chatId, msg) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === chatId ? { ...c, queued: [...c.queued ?? [], { ...msg, createdAt: Date.now() }] } : c
          )
        }));
        get().persist();
      },
      removeQueuedMessage: (chatId, id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === chatId ? { ...c, queued: (c.queued ?? []).filter((q) => q.id !== id) } : c
          )
        }));
        get().persist();
      },
      clearQueue: (chatId) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === chatId ? { ...c, queued: [] } : c)
        }));
        get().persist();
      },
      markQueuedSent: (chatId, id) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === chatId ? { ...c, queued: (c.queued ?? []).map((q) => q.id === id ? { ...q, sent: true } : q) } : c
          )
        }));
        get().persist();
      },
      updateMessage: (id, patch) => {
        set((s) => {
          const targetChat = s.chats.find((c) => c.messages.some((m) => m.id === id));
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
            chats: s.chats.map((c) => c.id === targetChat.id ? updatedChat : c),
            unreadChats
          };
        });
        maybePersistMidStream();
      },
      appendMessageSegments: (id, segments) => {
        if (!segments || segments.length === 0) return false;
        let added = false;
        set((s) => {
          const targetChat = s.chats.find((c) => c.messages.some((m) => m.id === id));
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
              (c) => c.id === targetChat.id ? {
                ...c,
                messages: c.messages.map(
                  (m) => m.id === id ? { ...m, segments: next } : m
                )
              } : c
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
          chats: s.chats.map((c) => {
            if (c.id !== chatId) return c;
            const entries = [...c.usage?.entries ?? []];
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
            const working = c.messages.some((m) => m.streaming);
            return { ...c, usage: { entries }, updatedAt: working ? c.updatedAt : Date.now() };
          })
        }));
        persistSoon();
      },
      resetChatUsage: (chatId) => {
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === chatId ? { ...c, usage: void 0, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      setChatPendingAsk: (chatId, req) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === chatId ? { ...c, pendingAsk: req } : c)
        }));
      },
      setChatPendingPermission: (chatId, req) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === chatId ? { ...c, pendingPermission: req } : c)
        }));
      },
      setChatCompacting: (id, compacting) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, compacting } : c)
        }));
      },
      setChatCompactNotice: (id, compactNotice) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, compactNotice } : c)
        }));
      },
      setChatCompactError: (id, compactError) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, compactError } : c)
        }));
      },
      setChatCmdError: (id, cmdError) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, cmdError } : c)
        }));
      },
      setChatLiveError: (id, liveError) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, liveError } : c)
        }));
      },
      setChatTtsError: (id, ttsError) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, ttsError } : c)
        }));
      },
      setChatSkillNotice: (id, skillNotice) => {
        set((s) => ({
          chats: s.chats.map((c) => c.id === id ? { ...c, skillNotice } : c)
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
          chats: s.chats.map((c) => c.id === id ? { ...c, scrollPos: pos } : c)
        }));
        get().persist();
      },
      // In-memory-only variant: updates the store WITHOUT persisting. Used by the
      // `coder:flush-ui` handler so a chat panel can push its ref-held scroll
      // position into the store right before a flush writes the snapshot — no
      // redundant write, no recursion into persist().
      setChatScrollPosMem: (id, pos) => {
        set((s) => {
          const cur = s.chats.find((c) => c.id === id)?.scrollPos ?? null;
          const same = cur === null && pos === null || cur !== null && pos !== null && cur.id === pos.id && cur.offset === pos.offset && cur.atBottom === pos.atBottom;
          if (same) return {};
          return {
            chats: s.chats.map((c) => c.id === id ? { ...c, scrollPos: pos } : c)
          };
        });
      },
      setPrefixNotice: (prefixNotice) => {
        set({ prefixNotice });
      },
      markToolReverted: (messageId, index) => {
        set((s) => ({
          chats: s.chats.map((c) => {
            const has = c.messages.some((m) => m.id === messageId);
            if (!has) return c;
            return {
              ...c,
              messages: c.messages.map(
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
        set((s) => ({
          chats: s.chats.map(
            (c) => c.id === id ? { ...c, messages: [], usage: void 0, updatedAt: Date.now() } : c
          )
        }));
        get().persist();
      },
      truncateTo: (messageId) => {
        const s = get();
        const target = s.chats.find((c) => c.messages.some((m) => m.id === messageId));
        if (!target) return false;
        const idx = target.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return false;
        const targetId = target.id;
        set((st) => ({
          chats: st.chats.map(
            (c) => c.id === targetId ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c
          )
        }));
        get().persist();
        return true;
      },
      compactChat: (id, summary, keep = 0) => {
        set((s) => ({
          chats: s.chats.map((c) => {
            if (c.id !== id) return c;
            const nonSys = c.messages.filter((m) => m.role !== "system");
            const recentStart = Math.max(nonSys.length - keep, 0);
            const compactedIds = new Set(
              nonSys.slice(0, recentStart).map((m) => m.id)
            );
            for (const m of c.messages) {
              if (m.streaming) compactedIds.delete(m.id);
            }
            for (const m of c.messages) {
              if (m.role === "system") compactedIds.add(m.id);
            }
            const messages = c.messages.map(
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
              ...c,
              messages: withSeg,
              updatedAt: Date.now()
            };
          })
        }));
        get().persist();
      },
      undoMessage: () => {
        const s = get();
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        if (!chat || chat.messages.length === 0) return false;
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
        st.undo.push(removed);
        st.redo = [];
        set((stt) => ({
          chats: stt.chats.map(
            (c) => c.id === chat.id ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c
          )
        }));
        get().persist();
        return true;
      },
      redoMessage: () => {
        const s = get();
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        if (!chat) return false;
        const st = stackFor(chat.id);
        const exchange = st.undo.pop();
        if (!exchange) return false;
        st.redo.push(exchange);
        set((stt) => ({
          chats: stt.chats.map(
            (c) => c.id === chat.id ? { ...c, messages: [...c.messages, ...exchange], updatedAt: Date.now() } : c
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
      anyStreaming: () => get().chats.some((c) => c.messages.some((m) => m.streaming)),
      setCompactAtPercent: (percent) => {
        set((s) => ({ settings: { ...s.settings, compactAtPercent: percent } }));
        get().persist();
      }
    }));
    api.onSidecarChanged(() => {
      void useStore.getState().load();
    });
  }
});

// src/lib/viewerTabs.ts
import { create as create2 } from "zustand";
function viewerTabId(kind, chatId, path) {
  if (kind === "file") {
    const clean = (path ?? "").trim();
    return clean ? `file:${chatId}:${clean}` : `file:${chatId}`;
  }
  return CHAT_SCOPED_KINDS.has(kind) ? `${kind}:${chatId}` : kind;
}
function visibleTabs(tabs, chatId) {
  return tabs.filter((t) => {
    if (t.kind === "file" && !t.chatId) return true;
    return !CHAT_SCOPED_KINDS.has(t.kind) || t.chatId === chatId;
  });
}
function currentChatId() {
  return useStore.getState().activeChatId;
}
function capTabs(tabs) {
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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null, closed: [] };
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => t && typeof t.id === "string" && (t.kind === "review" || t.kind === "trace" || t.kind === "inbox" || t.kind === "plan" || t.kind === "browser" || t.kind === "file" || t.kind === "text")) : [];
    const seen = /* @__PURE__ */ new Set();
    const tabs = [];
    for (const t of valid) {
      if (CHAT_SCOPED_KINDS.has(t.kind) && !t.chatId && t.kind !== "file") continue;
      const legacyId = viewerTabId(t.kind, t.chatId ?? "");
      const id = t.kind === "file" ? t.id : t.kind === "trace" && typeof t.traceTaskId === "string" && t.traceTaskId ? t.id.startsWith("trace:") ? t.id : `trace:${t.chatId}:${t.traceTaskId}` : legacyId;
      if (seen.has(id)) continue;
      seen.add(id);
      tabs.push({ ...t, id, title: t.kind === "review" ? "Git" : t.title });
    }
    const capped = capTabs(tabs);
    const activeId = typeof parsed.activeId === "string" && capped.some((t) => t.id === parsed.activeId) ? parsed.activeId : capped[0]?.id ?? null;
    const closed = Array.isArray(parsed.closed) ? parsed.closed.filter((c) => c && typeof c.closedAt === "number" && c.tab && typeof c.tab.id === "string" && (c.tab.kind === "review" || c.tab.kind === "trace" || c.tab.kind === "inbox" || c.tab.kind === "plan" || c.tab.kind === "browser" || c.tab.kind === "file" || c.tab.kind === "text")).slice(0, CLOSED_CAP) : [];
    return { tabs: capped, activeId, closed };
  } catch {
    return { tabs: [], activeId: null, closed: [] };
  }
}
function persist(tabs, activeId, closed = []) {
  try {
    const slim = tabs.map((t) => slimTab(t));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: slim,
        activeId,
        closed: closed.map((c) => ({ tab: slimTab(c.tab), closedAt: c.closedAt }))
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
function loadPanelMode() {
  try {
    return localStorage.getItem(PANEL_MODE_KEY) === "1";
  } catch {
    return false;
  }
}
function persistPanelMode(v) {
  try {
    localStorage.setItem(PANEL_MODE_KEY, v ? "1" : "0");
  } catch {
  }
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
var CHAT_SCOPED_KINDS, STORAGE_KEY, CLOSED_CAP, TOTAL_TAB_CAP, FILE_TAB_CAP, initial, FULLSCREEN_KEY, PANE_KEY, PANEL_MODE_KEY, VIEWER_TREE_KEY, VIEWER_WINDOW_MAX, initialViewerTree, useViewerTabs;
var init_viewerTabs = __esm({
  "src/lib/viewerTabs.ts"() {
    "use strict";
    init_store();
    init_chatTree();
    CHAT_SCOPED_KINDS = /* @__PURE__ */ new Set(["review", "trace", "plan", "browser", "text", "file"]);
    STORAGE_KEY = "coder:viewerTabs";
    CLOSED_CAP = 8;
    TOTAL_TAB_CAP = 30;
    FILE_TAB_CAP = 20;
    initial = typeof window !== "undefined" ? loadPersisted() : { tabs: [], activeId: null, closed: [] };
    FULLSCREEN_KEY = "coder:viewerFull";
    PANE_KEY = "coder:viewerPane";
    PANEL_MODE_KEY = "coder:panelMode";
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
    useViewerTabs = create2((set) => ({
      tabs: initial.tabs,
      activeId: initial.activeId,
      viewerTree: initialViewerTree,
      focusedViewerId: initial.activeId,
      lastActiveByChat: {},
      closedTabs: initial.closed,
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
      panelMode: typeof window !== "undefined" ? loadPanelMode() : false,
      setPanelMode: (v) => set(() => {
        persistPanelMode(v);
        return { panelMode: v };
      }),
      togglePanelMode: () => set((s) => {
        persistPanelMode(!s.panelMode);
        return { panelMode: !s.panelMode };
      }),
      openViewer: (tab) => set((s) => {
        const normalized = tab.kind === "review" ? { ...tab, title: "Git" } : tab;
        const exists = s.tabs.some((t) => t.id === normalized.id);
        const tabs = capTabs(exists ? s.tabs.map((t) => t.id === normalized.id ? { ...t, ...normalized } : t) : [...s.tabs, { ...normalized, createdAt: Date.now() }]);
        const lastActiveByChat = normalized.chatId ? { ...s.lastActiveByChat, [normalized.chatId]: normalized.id } : s.lastActiveByChat;
        const next = { tabs, activeId: tab.id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openReview: (messageId, path, chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("review", cid);
        const tab = {
          id,
          kind: "review",
          chatId: cid,
          title: "Git",
          reviewMessageId: messageId,
          reviewPath: path,
          reviewSource: "turn",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? tab : t) : [...s.tabs, tab]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openGitDiff: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("review", cid);
        const tab = {
          id,
          kind: "review",
          chatId: cid,
          title: "Git",
          reviewMessageId: null,
          reviewSource: "uncommitted",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? tab : t) : [...s.tabs, tab]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
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
          title: tid ? `Trace \xB7 ${label ? label.slice(0, 28) : short}` : "Trace",
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
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
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
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false };
        persist(next.tabs, next.activeId);
        useStore.getState().setScheduleInboxOpen(true);
        return next;
      }),
      openPlan: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("plan", cid);
        const entry = {
          id,
          kind: "plan",
          chatId: cid,
          title: "Plan",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openBrowser: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("browser", cid);
        const entry = {
          id,
          kind: "browser",
          chatId: cid,
          title: "Browser",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openFile: (path, line, root, chatId) => set((s) => {
        const clean = path.trim();
        if (!clean) return {};
        const cid = (chatId ?? currentChatId()).trim();
        const id = cid ? viewerTabId("file", cid, clean) : `file:${clean}`;
        const entry = {
          id,
          kind: "file",
          ...cid ? { chatId: cid } : {},
          title: clean.split(/[\\/]/).pop() || clean,
          filePath: clean,
          fileLine: line,
          fileRoot: root,
          createdAt: Date.now()
        };
        const raw = s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, fileLine: line, fileRoot: root ?? t.fileRoot } : t) : [...s.tabs, entry];
        const tabs = capTabs(raw);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openText: (title, body, format) => set((s) => {
        if (!body) return {};
        const cid = currentChatId();
        const id = viewerTabId("text", cid);
        const entry = {
          id,
          kind: "text",
          chatId: cid,
          title: title.trim() || "Text",
          textBody: body,
          textFormat: format,
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? entry : t) : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      closeViewer: (id) => set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return {};
        const removed = s.tabs[idx];
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeId = s.activeId;
        if (s.activeId === id) {
          activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
        }
        const closedTabs = [
          { tab: removed, closedAt: Date.now() },
          ...s.closedTabs.filter((c) => c.tab.id !== id)
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
        const toClose = chatId ? visibleTabs(s.tabs, chatId) : s.tabs;
        if (toClose.length === 0) return {};
        const closeIds = new Set(toClose.map((t) => t.id));
        const tabs = s.tabs.filter((t) => !closeIds.has(t.id));
        const activeId = s.activeId && closeIds.has(s.activeId) ? tabs[0]?.id ?? null : s.activeId;
        const closedTabs = [
          ...toClose.map((tab) => ({ tab, closedAt: Date.now() })),
          ...s.closedTabs.filter((c) => !closeIds.has(c.tab.id))
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
      setActiveViewer: (id) => set((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return {};
        persist(s.tabs, id, s.closedTabs);
        const lastActiveByChat = tab.chatId ? { ...s.lastActiveByChat, [tab.chatId]: id } : s.lastActiveByChat;
        const focusedViewerId = s.viewerTree && leafCount(s.viewerTree) > 1 ? s.focusedViewerId : id;
        return { activeId: id, panelMode: false, lastActiveByChat, focusedViewerId };
      }),
      reopenClosedViewerTab: (id) => set((s) => {
        const entry = s.closedTabs.find((c) => c.tab.id === id);
        if (!entry) return {};
        const closedTabs = s.closedTabs.filter((c) => c.tab.id !== id);
        const exists = s.tabs.some((t) => t.id === id);
        const tabs = capTabs(exists ? s.tabs : [...s.tabs, entry.tab]);
        const lastActiveByChat = entry.tab.chatId ? { ...s.lastActiveByChat, [entry.tab.chatId]: id } : s.lastActiveByChat;
        const next = { closedTabs, tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
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
        persistViewerTree(tree);
        const ids = collectChatIds(tree);
        const focusedViewerId = s.focusedViewerId && ids.includes(s.focusedViewerId) ? s.focusedViewerId : s.activeId && ids.includes(s.activeId) ? s.activeId : ids[0] ?? null;
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
        return { viewerTree: tree, activeId: id, focusedViewerId: id, paneOpen: true, panelMode: false };
      }),
      dropViewerOnto: (dragId, targetId, pos) => set((s) => {
        if (!dragId || !targetId || dragId === targetId) return {};
        if (!s.tabs.some((t) => t.id === dragId) || !s.tabs.some((t) => t.id === targetId)) return {};
        const base = s.viewerTree ?? buildFromList([targetId], "row");
        if (!base) return {};
        if (!containsChat(base, dragId) && leafCount(base) >= VIEWER_WINDOW_MAX) {
          persist(s.tabs, s.activeId, s.closedTabs);
          return { activeId: targetId, focusedViewerId: targetId };
        }
        const tree = dropOnto(base, dragId, targetId, pos);
        if (!tree) return {};
        persistViewerTree(tree);
        persist(s.tabs, dragId, s.closedTabs);
        return { viewerTree: tree, activeId: dragId, focusedViewerId: dragId, paneOpen: true, panelMode: false };
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
        return { activeId: id, focusedViewerId: id, panelMode: false, lastActiveByChat };
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
  const base = fileBasename(path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 || base.startsWith(".") ? base.slice(dot + 1).toLowerCase() : "";
  const lowerBase = base.toLowerCase();
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
  const root = st.chats.find((c) => c.id === st.activeChatId)?.root ?? st.root;
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
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      className: `file-chip${className ? ` ${className}` : ""}`,
      dir: "ltr",
      title: `${path}${line ? `:${line}` : ""} \u2014 click to open`,
      onClick: handle,
      children: [
        /* @__PURE__ */ jsx(FileIcon, { path, size: 20 }),
        /* @__PURE__ */ jsx("span", { className: "file-chip-name", dir: "ltr", children: label })
      ]
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

// src/lib/time.ts
function fmtClock(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  if (d.toDateString() === (/* @__PURE__ */ new Date()).toDateString()) return time;
  const date = d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric"
  });
  return `${date} ${time}`;
}
function fmtClockFull(ts) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
var init_time = __esm({
  "src/lib/time.ts"() {
    "use strict";
  }
});

// src/lib/planDoc.ts
function planDisplay(message2) {
  const planDoc = message2.planDoc;
  if (!planDoc) return { content: message2.content, segments: message2.segments };
  let segments = message2.segments;
  if (segments && segments.length > 0) {
    const planStart = (text) => {
      const idx = planDoc.body ? text.lastIndexOf(planDoc.body) : -1;
      if (idx >= 0) return idx;
      const m = text.match(/^#{1,3}\s*(plan|پلن)\b/im);
      return m && m.index != null ? m.index : -1;
    };
    const kept = [];
    let planStarted = false;
    for (const seg of segments) {
      if (seg.kind !== "text") {
        kept.push(seg);
        continue;
      }
      if (planStarted) continue;
      const start = planStart(seg.text);
      if (start >= 0) {
        planStarted = true;
        const before = seg.text.slice(0, start).trimEnd();
        if (before) kept.push({ kind: "text", text: before });
      } else {
        kept.push(seg);
      }
    }
    if (!planStarted) {
      let lastTool = -1;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].kind !== "text") lastTool = i;
      }
      segments = lastTool >= 0 ? kept.slice(0, lastTool + 1) : [];
    } else {
      segments = kept;
    }
    segments = planDoc.preamble && !segments.some((s) => s.kind === "text") ? [{ kind: "text", text: planDoc.preamble }, ...segments] : segments;
  }
  let content = message2.content;
  if (content) {
    const bodyIdx = planDoc.body ? content.lastIndexOf(planDoc.body) : -1;
    if (bodyIdx >= 0) {
      content = content.slice(0, bodyIdx).trimEnd();
    } else {
      const m = content.match(/^#{1,3}\s*(plan|پلن)\b[^\n]*$/im);
      if (m && m.index != null) {
        content = content.slice(0, m.index).trimEnd();
      }
    }
  }
  return { content, segments };
}
var init_planDoc = __esm({
  "src/lib/planDoc.ts"() {
    "use strict";
  }
});

// src/lib/tts.ts
import { useCallback, useEffect, useRef, useState } from "react";
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
  if (lower.includes("aborted") || lower.includes("aborterror")) return "";
  if (msg.includes("Python agent not ready")) return "\u0633\u0631\u0648\u06CC\u0633 \u0635\u0648\u062A\u06CC \u0622\u0645\u0627\u062F\u0647 \u0646\u06CC\u0633\u062A \u2014 \u0628\u0631\u0646\u0627\u0645\u0647 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC \u06A9\u0646\u06CC\u062F";
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
function toTtsChain(opts) {
  return Array.isArray(opts) ? opts : [opts];
}
async function fetchSentenceWithLocalFallback(sentence, cfg, fallback, signal) {
  const remote = toTtsChain(fallback);
  if (cfg.ttsProviderId !== "local") return fetchSentenceRobust(sentence, remote, signal);
  const rawModel = (cfg.ttsModel ?? "").trim();
  const rawVoice = (cfg.ttsVoice ?? "").trim();
  const isLocalVoiceId = (v) => {
    if (!v) return false;
    if (v.toLowerCase() === "local") return false;
    if (v.includes("/") || v.includes("\\")) return false;
    if (v === "tts-1" || v === "tts-1-hd") return false;
    if (v.endsWith(".onnx") || v.endsWith(".onnx.json")) return false;
    return true;
  };
  const resolvedVoice = [rawModel, rawVoice].find(isLocalVoiceId) ?? LOCAL_TTS_DEFAULT_MODEL;
  const localOpts = {
    kind: "local",
    baseUrl: (cfg.ttsBaseUrl ?? "").trim(),
    model: resolvedVoice
  };
  try {
    return await speakTextStream(sentence, localOpts, void 0, signal);
  } catch (err) {
    throw err;
  }
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
    const rounds = Math.max(1, TTS_RETRY_ATTEMPTS);
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
      if (round < rounds - 1) {
        await sleepAbortAware(TTS_RETRY_DELAY_MS, signal);
      }
    }
    throw lastErr;
  };
  return run();
}
async function playTts(text, opts, owner, local) {
  stopTtsGlobal();
  const controller = new AbortController();
  activeAbort = controller;
  const seq = ++seqCounter;
  activeSeq = seq;
  activeOwner = owner;
  activeStatus = "loading";
  notifyTts();
  const chain = toTtsChain(opts);
  const fetchOne = (sentence, signal) => local && local.ttsProviderId === "local" ? fetchSentenceWithLocalFallback(sentence, local, chain, signal) : fetchSentenceRobust(sentence, chain, signal);
  const sentences = splitTtsSentences(text);
  const queue = sentences.length > 1 ? sentences : [text];
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
      ensureFetch(i + 2);
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
      await playBlobChunk(blob, seq, controller);
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
function playBlobChunk(blob, seq, controller) {
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
async function toggleTts(text, opts, owner, local) {
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
  await playTts(text, opts, owner, local);
}
function useTtsPlayback() {
  const idRef = useRef(-1);
  if (idRef.current === -1) idRef.current = nextOwnerId++;
  const myId = idRef.current;
  const [status, setStatus] = useState(
    () => activeOwner === myId || activeOwner === -1 ? activeStatus : "idle"
  );
  useEffect(() => {
    const listener = (s, owner) => {
      setStatus(owner === myId ? s : "idle");
    };
    const unsubscribe = subscribeTts(listener);
    listener(activeStatus, activeOwner);
    return unsubscribe;
  }, [myId]);
  const stop = useCallback(() => {
    stopTts(myId);
    setStatus((prev) => activeOwner === myId ? prev : "idle");
  }, [myId]);
  const play = useCallback(
    async (text, opts, local) => {
      await playTts(text, opts, myId, local);
    },
    [myId]
  );
  const toggle = useCallback(
    async (text, opts, local) => {
      await toggleTts(text, opts, myId, local);
    },
    [myId]
  );
  const pause = useCallback(() => {
    pauseTts(myId);
  }, [myId]);
  const resume = useCallback(async () => {
    await resumeTts(myId);
  }, [myId]);
  useEffect(() => () => stopTts(idRef.current), []);
  return { status, play, stop, toggle, pause, resume };
}
function speakableMessageText(message2) {
  const display = planDisplay(message2);
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
function stripMarkdownForTts(text) {
  let out = text ?? "";
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => ` ${code} `);
  out = out.replace(/`([^`]*)`/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  out = out.replace(/^\s{0,3}(?:-[-*]|\*[*-]|_[*_])\s*$/gm, "");
  out = out.replace(/\|/g, " ");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/(\*\*|__)/g, "");
  out = out.replace(/~~/g, "");
  out = out.replace(/https?:\/\/\S+/g, "link");
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
var activeAudio, activeUrl, activeOwner, activeStatus, nextOwnerId, activeSeq, seqCounter, activeAbort, listeners, SENTENCE_FETCH_TIMEOUT_MS, TTS_RETRY_ATTEMPTS, TTS_RETRY_DELAY_MS, LOCAL_TTS_DEFAULT_MODEL, PLAYBACK_WATCHDOG_MIN_MS, PLAYBACK_WATCHDOG_PER_BYTE_MS, PLAYBACK_WATCHDOG_MAX_MS, INTER_SENTENCE_GAP_MS;
var init_tts = __esm({
  "src/lib/tts.ts"() {
    "use strict";
    init_api();
    init_planDoc();
    activeAudio = null;
    activeUrl = null;
    activeOwner = -1;
    activeStatus = "idle";
    nextOwnerId = 0;
    activeSeq = 0;
    seqCounter = 0;
    activeAbort = null;
    listeners = /* @__PURE__ */ new Set();
    SENTENCE_FETCH_TIMEOUT_MS = 2e4;
    TTS_RETRY_ATTEMPTS = 2;
    TTS_RETRY_DELAY_MS = 1e3;
    LOCAL_TTS_DEFAULT_MODEL = "default";
    PLAYBACK_WATCHDOG_MIN_MS = 2e4;
    PLAYBACK_WATCHDOG_PER_BYTE_MS = 0.25;
    PLAYBACK_WATCHDOG_MAX_MS = 18e4;
    INTER_SENTENCE_GAP_MS = 350;
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
function splitSections(markdown) {
  if (!markdown) return [];
  const lines = markdown.split("\n");
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
var URL_SPLIT_RE, URL_TRAIL_RE;
var init_link = __esm({
  "src/lib/link.ts"() {
    "use strict";
    URL_SPLIT_RE = /https?:\/\/[^\s<>"'`]+/gi;
    URL_TRAIL_RE = /[.,;:!?)\]}'"`]+$/;
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
function sanitizeHtml(html2) {
  if (!html2 || !html2.trim()) return "";
  if (typeof DOMParser === "undefined") return html2;
  const doc = parser().parseFromString(
    `<!doctype html><html><body>${html2}</body></html>`,
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

// src/lib/toolActivity.ts
function diffStatsFromUnified(diff) {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
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
var init_toolActivity = __esm({
  "src/lib/toolActivity.ts"() {
    "use strict";
  }
});

// src/lib/reviewTurn.ts
function reviewPathOf(a) {
  const p = a.args?.path ?? a.args?.filePath;
  return typeof p === "string" ? p : "";
}
var init_reviewTurn = __esm({
  "src/lib/reviewTurn.ts"() {
    "use strict";
    init_toolActivity();
  }
});

// src/lib/reviewDiff.ts
function parseHunks(diff) {
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
  for (const line of diff.split("\n")) {
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
function parseDiffRows(diff) {
  const out = [];
  for (const h of parseHunks(diff)) {
    out.push({ type: "hunk", text: h.header });
    out.push(...h.rows);
  }
  return out;
}
function parseSideBySide(diff) {
  const hunks = parseHunks(diff);
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

// src/lib/useDragScroll.tsx
import { useRef as useRef2 } from "react";
import { jsx as jsx2 } from "react/jsx-runtime";
function useDragScroll() {
  const ref = useRef2(null);
  const drag = useRef2(null);
  const onMouseDown = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    drag.current = {
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
    const el = ref.current;
    if (!d || !el) return;
    el.scrollLeft = d.scrollX - (e.clientX - d.sx);
    el.scrollTop = d.scrollY - (e.clientY - d.sy);
  };
  const end = () => {
    const el = ref.current;
    if (el) {
      el.style.cursor = "";
      el.style.userSelect = "";
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

// src/lib/chatSends.ts
function sendQueuedNext(chatId) {
  const store = useStore.getState();
  const chat = store.chats.find((c) => c.id === chatId);
  const queued = chat?.queued?.filter((q) => !q.sent);
  if (!chat || !queued || queued.length === 0) return false;
  const fn = registry.get(chatId);
  if (!fn) return false;
  const next = queued[0];
  store.markQueuedSent(chatId, next.id);
  fn(next.text, next.attachments ?? [], next.images ?? [], void 0, void 0, void 0, void 0, {
    mcpServers: next.mcpServers,
    skills: next.skills
  });
  return true;
}
var registry;
var init_chatSends = __esm({
  "src/lib/chatSends.ts"() {
    "use strict";
    init_store();
    registry = /* @__PURE__ */ new Map();
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
  const base = cleanFile.split("/").pop() ?? cleanFile;
  let body = quote;
  for (; ; ) {
    const lead = body.match(/^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]*/);
    const rest = lead ? body.slice(lead[0].length) : body;
    const m = rest.match(/^\[([^\]]*)\]\s*/);
    if (!m) return body;
    const inner = stripInvisible(m[1]).trim();
    const loc = inner.match(/^(.*?)\s+lines?\s+\d+(?:-\d+)?$/);
    const innerPath = (loc ? loc[1] : inner).trim();
    const sameFile = innerPath === cleanFile || innerPath === base || innerPath.endsWith(`/${base}`);
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
  const chat = store.chats.find((c) => c.id === chatId);
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
    MAX_COMMENTS_PER_CHAT = 100;
    MAX_QUOTE_CHARS = 500;
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

// src/components/ToolCallView.tsx
import {
  Fragment,
  memo,
  useEffect as useEffect2,
  useLayoutEffect,
  useRef as useRef3,
  useState as useState2
} from "react";
import { createPortal } from "react-dom";
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
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
  const [now, setNow] = useState2(() => Date.now());
  useEffect2(() => {
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
function toolIcon(tool) {
  return TOOL_ICON[tool] ?? "\u2022";
}
function toolLabel(tool) {
  const server = mcpServerOf(tool);
  if (server) return `${bareToolName(tool)} \xB7 ${server}`;
  return TOOL_LABEL[tool] ?? tool;
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
function IconSparkle({ className }) {
  return /* @__PURE__ */ jsx3(
    "svg",
    {
      className,
      width: "14",
      height: "14",
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx3("path", { d: "M12 1L14.5 9.5L23 12L14.5 14.5L12 23L9.5 14.5L1 12L9.5 9.5Z" })
    }
  );
}
function IconChevron({
  open,
  className
}) {
  return /* @__PURE__ */ jsx3(
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
      children: /* @__PURE__ */ jsx3("path", { d: "M9 18l6-6-6-6" })
    }
  );
}
function IconCheck({ className }) {
  return /* @__PURE__ */ jsx3(
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
      children: /* @__PURE__ */ jsx3("path", { d: "M20 6L9 17l-5-5" })
    }
  );
}
function IconX({ className }) {
  return /* @__PURE__ */ jsx3(
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
      children: /* @__PURE__ */ jsx3("path", { d: "M18 6L6 18M6 6l12 12" })
    }
  );
}
function StatusIcon({ status }) {
  if (status === "running") return /* @__PURE__ */ jsx3("span", { className: "spinner" });
  if (status === "error") return /* @__PURE__ */ jsx3(IconX, { className: "status-err" });
  if (status === "denied") return /* @__PURE__ */ jsx3("span", { className: "status-denied", children: "\u23F9" });
  return /* @__PURE__ */ jsx3(IconCheck, { className: "status-ok" });
}
function TerminalRowIcon() {
  return /* @__PURE__ */ jsxs2(
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
        /* @__PURE__ */ jsx3("path", { d: "M5 7l5 5-5 5" }),
        /* @__PURE__ */ jsx3("path", { d: "M13 17h6" })
      ]
    }
  );
}
function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function fmtArgValue(v) {
  if (typeof v === "string") return fixZwsp(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(fmtArgValue).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function ToolArgs({ args }) {
  const entries = Object.entries(args).filter(
    ([k]) => !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k)
  );
  if (entries.length === 0) return null;
  return /* @__PURE__ */ jsx3("span", { className: "tool-args", dir: "ltr", children: entries.map(([k, v]) => /* @__PURE__ */ jsxs2("span", { className: "tool-arg", children: [
    /* @__PURE__ */ jsx3("span", { className: "tool-arg-key", children: k }),
    /* @__PURE__ */ jsx3("span", { className: "tool-arg-val", children: fmtArgValue(v) })
  ] }, k)) });
}
function TomlLine({ text }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#")) return /* @__PURE__ */ jsx3("span", { className: "toml-comment", children: text });
  const eq = text.indexOf("=");
  if (eq < 0) return /* @__PURE__ */ jsx3(Fragment2, { children: text });
  const key = text.slice(0, eq).trimEnd();
  const rest = text.slice(eq);
  const value = rest.slice(1).trimStart();
  const isString = value.startsWith('"') || value.startsWith("'");
  return /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("span", { className: "toml-key", children: key }),
    /* @__PURE__ */ jsx3("span", { className: "toml-eq", children: " = " }),
    /* @__PURE__ */ jsx3("span", { className: isString ? "toml-string" : "toml-value", children: rest.slice(1).trimStart() })
  ] });
}
function DiffLineText({
  text,
  path,
  query,
  hitBase = 0,
  activeHit = -1,
  activeRef
}) {
  const q = (query ?? "").trim();
  if (q)
    return /* @__PURE__ */ jsx3(Fragment2, { children: highlightParts(text, q, hitBase, activeHit, activeRef) });
  if (path && path.split("?")[0].toLowerCase().endsWith(".toml")) {
    return /* @__PURE__ */ jsx3(TomlLine, { text });
  }
  return /* @__PURE__ */ jsx3(Fragment2, { children: text });
}
function highlightParts(text, query, base, active, activeRef) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  let ordinal = 0;
  for (; ; ) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      if (i < text.length) out.push(/* @__PURE__ */ jsx3("span", { children: text.slice(i) }, k++));
      break;
    }
    if (j > i) out.push(/* @__PURE__ */ jsx3("span", { children: text.slice(i, j) }, k++));
    const idx = base + ordinal;
    ordinal++;
    const isActive = idx === active;
    out.push(
      /* @__PURE__ */ jsx3(
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
function DiffView({
  diff,
  path,
  query,
  activeHit = -1,
  layout = "auto",
  threshold = DIFF_SIDE_BY_SIDE_THRESHOLD,
  commentable = true
}) {
  const rows = parseDiffRows(diff);
  const sideItems = parseSideBySide(diff);
  const drag = useDragScroll();
  const measureRef = useRef3(null);
  const [measuredWidth, setMeasuredWidth] = useState2(0);
  useEffect2(() => {
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
  }, [diff]);
  const showSide = layout === "unified" ? false : layout === "side-by-side" ? measuredWidth > 0 ? shouldShowSideBySide(measuredWidth, threshold) : true : shouldShowSideBySide(measuredWidth, threshold);
  const activeRef = useRef3(null);
  useEffect2(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff]);
  const chatId = useStore((s) => s.activeChatId);
  const [box, setBox] = useState2(null);
  const [selBar, setSelBar] = useState2(null);
  const [note, setNote] = useState2("");
  const commentInputRef = useRef3(null);
  useEffect2(() => {
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
  useEffect2(() => {
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
    const base = diffQuoteForSelection(container, sel, filePath, text.slice(0, 500));
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (rect && typeof window !== "undefined") {
        setSelBar({
          base,
          ...selectionBarPos(rect, window.innerWidth, window.innerHeight)
        });
        return;
      }
    } catch {
    }
    setSelBar({ base, x: 16, y: 96 });
  };
  let hitCursor = 0;
  const renderRow = (key, cls, gutter, lineNo, text) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q) hitCursor += countOccurrences(text, q);
    return /* @__PURE__ */ jsxs2("div", { className: `diff-u-row ${cls}`, children: [
      /* @__PURE__ */ jsx3("span", { className: "diff-u-gutter", children: gutter }),
      /* @__PURE__ */ jsx3("span", { className: "diff-u-num", children: lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx3("span", { className: "diff-u-text", children: /* @__PURE__ */ jsx3(
        DiffLineText,
        {
          text,
          path,
          query,
          hitBase: base,
          activeHit,
          activeRef
        }
      ) })
    ] }, key);
  };
  const renderSideCell = (key, cls, lineNo, text, empty) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    return /* @__PURE__ */ jsxs2("span", { className: `diff-line ${cls}`, children: [
      /* @__PURE__ */ jsx3("span", { className: "diff-u-num", children: !empty && lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx3("span", { className: "diff-u-text", children: !empty ? /* @__PURE__ */ jsx3(
        DiffLineText,
        {
          text,
          path,
          query,
          hitBase: base,
          activeHit,
          activeRef
        }
      ) : "\xA0" })
    ] }, key);
  };
  const renderSide = () => /* @__PURE__ */ jsxs2("div", { className: "diff-columns", dir: "ltr", ...drag, children: [
    /* @__PURE__ */ jsxs2("div", { className: "diff-columns-head", children: [
      /* @__PURE__ */ jsx3("div", { className: "diff-col-header diff-col-before", children: "Before" }),
      /* @__PURE__ */ jsx3("div", { className: "diff-col-header diff-col-after", children: "After" })
    ] }),
    sideItems.map((item) => {
      if (item.kind === "gap") {
        return /* @__PURE__ */ jsxs2("div", { className: "diff-gap", children: [
          item.count,
          " unmodified lines"
        ] }, item.key);
      }
      const metas = item.rows.filter((r) => "text" in r);
      const contents = item.rows.filter((r) => !("text" in r));
      return /* @__PURE__ */ jsxs2("div", { className: "diff-hunk-pair", children: [
        metas.map((m, mi) => /* @__PURE__ */ jsx3("div", { className: `diff-u-meta ${m.type}`, children: "text" in m ? m.text : "" }, `${item.key}-m${mi}`)),
        /* @__PURE__ */ jsx3("div", { className: "diff-col diff-col-before", children: /* @__PURE__ */ jsx3("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
          if ("text" in r) return null;
          if (r.type === "same")
            return renderSideCell(`${ri}-b`, "", r.bLine, r.before, false);
          if (r.type === "del" || r.type === "mod")
            return renderSideCell(
              `${ri}-b`,
              "diff-line-del",
              r.bLine,
              r.before,
              false
            );
          return renderSideCell(`${ri}-b`, "diff-line-empty", -1, "", true);
        }) }) }),
        /* @__PURE__ */ jsx3("div", { className: "diff-col diff-col-after", children: /* @__PURE__ */ jsx3("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
          if ("text" in r) return null;
          if (r.type === "same")
            return renderSideCell(`${ri}-a`, "", r.aLine, r.after, false);
          if (r.type === "add" || r.type === "mod")
            return renderSideCell(
              `${ri}-a`,
              "diff-line-add",
              r.aLine,
              r.after,
              false
            );
          return renderSideCell(`${ri}-a`, "diff-line-empty", -1, "", true);
        }) }) })
      ] }, item.key);
    })
  ] });
  const renderUnified = () => /* @__PURE__ */ jsx3("div", { className: "diff-unified", dir: "ltr", ...drag, children: rows.flatMap((row, i) => {
    if ("text" in row) {
      return /* @__PURE__ */ jsx3("div", { className: `diff-u-meta ${row.type}`, children: row.text }, i);
    }
    if (row.type === "same")
      return renderRow(i, "diff-u-ctx", " ", row.aLine, row.after);
    if (row.type === "del")
      return renderRow(i, "diff-u-del", "-", row.bLine, row.before);
    if (row.type === "add")
      return renderRow(i, "diff-u-add", "+", row.aLine, row.after);
    return [
      renderRow(`${i}-d`, "diff-u-del", "-", row.bLine, row.before),
      renderRow(`${i}-a`, "diff-u-add", "+", row.aLine, row.after)
    ];
  }) });
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      ref: measureRef,
      className: "diff-responsive",
      "data-layout": showSide ? "side-by-side" : "unified",
      onMouseUp: refreshHighlight,
      onKeyUp: refreshHighlight,
      children: [
        showSide ? renderSide() : renderUnified(),
        commentable && selBar && !box && typeof document !== "undefined" ? createPortal(
          /* @__PURE__ */ jsxs2(
            "div",
            {
              className: "fv-sel-bar",
              style: { position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 },
              onMouseUp: (e) => e.stopPropagation(),
              onKeyUp: (e) => e.stopPropagation(),
              children: [
                /* @__PURE__ */ jsx3(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Copy",
                    "aria-label": "Copy selection",
                    onClick: copySelection,
                    children: /* @__PURE__ */ jsxs2("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx3("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
                      /* @__PURE__ */ jsx3("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                    ] })
                  }
                ),
                /* @__PURE__ */ jsx3(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Reply",
                    "aria-label": "Reply to selection",
                    onClick: openBox,
                    children: /* @__PURE__ */ jsxs2("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx3("polyline", { points: "9 17 4 12 9 7" }),
                      /* @__PURE__ */ jsx3("path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" })
                    ] })
                  }
                )
              ]
            }
          ),
          document.body
        ) : null,
        commentable && box && typeof document !== "undefined" ? createPortal(
          /* @__PURE__ */ jsx3(
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
              children: /* @__PURE__ */ jsx3(
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
function parseHunks2(diff) {
  const hunks = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let cur = null;
  const lines = diff.split("\n");
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
function applyReverseDiff(diff, current) {
  const cur = current.split("\n");
  if (current.endsWith("\n")) cur.pop();
  const hunks = parseHunks2(diff);
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
function shortArg(s, max) {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}\u2026`;
}
function subArgSummary(activity) {
  const args = activity.args;
  if (!args) return "";
  const parts = [];
  if (args.command !== void 0 && args.command !== "") {
    parts.push(shortArg(String(args.command), 80));
  }
  const path = String(args.filePath ?? args.path ?? "");
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
    const rs = rangesRaw.map((r) => String(r)).filter(Boolean);
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
function fenceFor(s) {
  let max = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}
function traceRowOutputText(activity, argsText) {
  const parts = [];
  if (activity.summary) parts.push(`**Summary**

${fixZwsp(activity.summary)}`);
  if (argsText) {
    const f = fenceFor(argsText);
    parts.push(`**Args**

${f}
${argsText}
${f}`);
  }
  if (activity.diff) {
    const f = fenceFor(activity.diff);
    parts.push(`**Diff**

${f}diff
${activity.diff}
${f}`);
  }
  if (activity.tool === "run_terminal") {
    const out = terminalOutputText(activity.items ?? activity.results);
    if (out) {
      const f = fenceFor(out);
      parts.push(`**Output**

${f}
${out}
${f}`);
    }
  }
  if (activity.resultText) {
    const f = fenceFor(activity.resultText);
    parts.push(`**Result**

${f}
${activity.resultText}
${f}`);
  }
  return parts.join("\n\n");
}
function ToolPathSpan({ path }) {
  const open = (e) => {
    e.stopPropagation();
    openWorkspaceFile(path);
  };
  return /* @__PURE__ */ jsxs2(
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
      children: [
        /* @__PURE__ */ jsx3(FileIcon, { path, size: 20 }),
        fileBasename(path)
      ]
    }
  );
}
var TICK_MS, sharedTickId, tickListeners, TOOL_LABEL, TOOL_ICON, isSubagentCard, EDIT_TOOLS, isEditActivity, ToolEditGroupView, WebResultLinks, TerminalResultText, FileResultLinks, HEADER_SHOWN_KEYS, HIDDEN_KEYS, DIFF_SIDE_BY_SIDE_THRESHOLD, ToolGroupView, ToolSubRow, TRACE_TEXT_PANEL_MIN, TraceRow, ToolTimelineRow, PREVIEW_COUNT, ToolCascade, TraceNarration, ToolSingleRow, ToolCallView;
var init_ToolCallView = __esm({
  "src/components/ToolCallView.tsx"() {
    "use strict";
    init_store();
    init_toolActivity();
    init_reviewTurn();
    init_reviewDiff();
    init_diffSearch();
    init_clipboard();
    init_viewerTabs();
    init_fs();
    init_api();
    init_bidi();
    init_fileTypes();
    init_link();
    init_useDragScroll();
    init_FileIcon();
    init_fileComments();
    init_selectionBar();
    init_mcpTools();
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
      task: "Task",
      explore: "Explore",
      vision: "Vision",
      create_skill: "Create Skill",
      create_mcp: "Create MCP",
      update_plan: "Update Plan",
      git_status: "Git Status",
      git_diff: "Git Diff",
      git_commit: "Git Commit",
      git_log: "Git Log",
      current_time: "Current Time",
      system_stats: "System Stats",
      computer: "Computer",
      search_console: "Search Console"
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
      task: "\u{1F9E9}",
      explore: "\u{1F50D}",
      vision: "\u{1F5BC}",
      create_skill: "\u2699",
      create_mcp: "\u{1F50C}",
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
    isSubagentCard = (a) => a.tool === "task" && (a.args?.subagent_type === "subagent" || a.args?.subagent_type === "general") || a.tool === "explore";
    EDIT_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
    isEditActivity = (a) => EDIT_TOOLS.has(a.tool);
    ToolEditGroupView = memo(function ToolEditGroupView2({
      activities,
      messageId,
      chatId,
      onReverted
    }) {
      const [open, setOpen] = useState2(true);
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const [reverting, setReverting] = useState2(null);
      const running = activities.some((a) => a.activity.status === "running");
      const { adds, dels } = editGroupStats(activities);
      const now = useRunningClock(running);
      const totalMs = activities.reduce((sum, a) => {
        const act = a.activity;
        if (act.status === "running" && act.startedAt) return sum + Math.max(0, now - act.startedAt);
        return sum + (act.elapsedMs || 0);
      }, 0);
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
          const { content: current } = await api.fsRead(root, path);
          const oldContent = applyReverseDiff(entry.activity.diff, current ?? "");
          const ok = await api.fsWrite(root, path, oldContent);
          if (ok) onReverted?.(entry.index);
        } finally {
          setReverting(null);
        }
      };
      return /* @__PURE__ */ jsxs2("div", { className: `tool-edit-group ${open ? "open" : ""} ${running ? "running" : "done"}`, children: [
        /* @__PURE__ */ jsxs2("button", { className: "trace-head edit-group-head", onClick: () => setOpen((o) => !o), children: [
          /* @__PURE__ */ jsx3("span", { className: "edit-group-icon", "aria-hidden": "true", children: "\u270E" }),
          /* @__PURE__ */ jsx3("span", { className: "trace-head-pills", children: /* @__PURE__ */ jsxs2("span", { className: "trace-pill edit-group-pill", children: [
            activities.length,
            " file",
            activities.length === 1 ? "" : "s",
            " edited"
          ] }) }),
          /* @__PURE__ */ jsxs2("span", { className: "trace-head-right", children: [
            (adds > 0 || dels > 0) && /* @__PURE__ */ jsxs2("span", { className: "edit-group-stats", dir: "ltr", children: [
              /* @__PURE__ */ jsx3("span", { className: "review-count-add", children: `+${adds}` }),
              " ",
              /* @__PURE__ */ jsx3("span", { className: "review-count-del", children: `-${dels}` })
            ] }),
            totalMs > 0 && /* @__PURE__ */ jsx3("span", { className: "trace-time", children: fmtTime(totalMs) }),
            /* @__PURE__ */ jsx3(IconChevron, { open, className: "trace-chev" })
          ] })
        ] }),
        open && /* @__PURE__ */ jsx3("div", { className: "edit-group-list", children: activities.map((entry) => {
          const path = reviewPathOf(entry.activity);
          const base = path.split("/").pop() || path;
          const st = entry.activity.diff ? entry.activity.diffStats ?? diffStatsFromUnified(entry.activity.diff) : null;
          const stats = st && (st.adds || st.dels) ? `+${st.adds} -${st.dels}` : null;
          return /* @__PURE__ */ jsx3(
            "div",
            {
              className: `edit-group-row ${entry.activity.status}${entry.activity.reverted ? " reverted" : ""}`,
              children: /* @__PURE__ */ jsxs2(
                "button",
                {
                  className: "edit-group-row-main",
                  title: path || void 0,
                  onClick: () => messageId && openReview(messageId, path),
                  children: [
                    /* @__PURE__ */ jsx3(StatusIcon, { status: entry.activity.status }),
                    /* @__PURE__ */ jsx3(FileIcon, { path, size: 20 }),
                    /* @__PURE__ */ jsx3("span", { className: "edit-group-file", dir: "auto", children: base }),
                    /* @__PURE__ */ jsxs2("span", { className: "edit-group-row-end", children: [
                      stats && /* @__PURE__ */ jsx3("span", { className: "trace-row-diff-stats", dir: "ltr", children: stats }),
                      entry.activity.reverted && /* @__PURE__ */ jsx3("span", { className: "reverted-tag", children: "reverted" }),
                      (() => {
                        const act = entry.activity;
                        const ms = act.status === "running" && act.startedAt ? Math.max(0, now - act.startedAt) : act.elapsedMs;
                        return ms ? /* @__PURE__ */ jsx3("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null;
                      })(),
                      messageId && entry.activity.diff && /* @__PURE__ */ jsx3("span", { className: "trace-row-review", "aria-hidden": "true", children: "Review \u2197" })
                    ] })
                  ]
                }
              )
            },
            entry.index
          );
        }) })
      ] });
    });
    WebResultLinks = memo(function WebResultLinks2({
      items
    }) {
      if (!items || items.length === 0) return null;
      return /* @__PURE__ */ jsx3("ul", { className: "web-results", dir: "auto", children: items.map((it, i) => {
        const host = hostOf(it.url);
        return /* @__PURE__ */ jsx3("li", { className: "web-result", children: /* @__PURE__ */ jsxs2(
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
              /* @__PURE__ */ jsx3("span", { className: "web-result-favicon", "aria-hidden": "true", children: host ? /* @__PURE__ */ jsx3(
                "img",
                {
                  src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
                  alt: "",
                  loading: "lazy",
                  width: 16,
                  height: 16
                }
              ) : /* @__PURE__ */ jsx3("span", { className: "web-result-glyph", children: "\u{1F517}" }) }),
              /* @__PURE__ */ jsxs2("span", { className: "web-result-text", children: [
                /* @__PURE__ */ jsx3("span", { className: "web-result-title", children: it.title || it.url }),
                it.snippet && /* @__PURE__ */ jsx3("span", { className: "web-result-snippet", children: it.snippet })
              ] }),
              /* @__PURE__ */ jsx3("span", { className: "web-result-host", children: host }),
              /* @__PURE__ */ jsx3("span", { className: "web-result-arrow", "aria-hidden": "true", children: "\u2197" })
            ]
          }
        ) }, i);
      }) });
    });
    TerminalResultText = function TerminalResultText2({
      items
    }) {
      const text = terminalOutputText(items);
      if (!text) return null;
      const long = text.length > 600;
      return /* @__PURE__ */ jsx3(
        "pre",
        {
          className: `trace-expand-val trace-expand-pre trace-terminal-output${long ? " clickable" : ""}`,
          dir: "ltr",
          title: long ? "Open the full output in the side panel" : void 0,
          onClick: long ? () => useViewerTabs.getState().openText("Terminal output", text, "text") : void 0,
          children: text
        }
      );
    };
    FileResultLinks = memo(function FileResultLinks2({
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
      const VISIBLE = 3;
      const visible = deduped.slice(0, VISIBLE);
      const extra = deduped.length - visible.length;
      return /* @__PURE__ */ jsxs2("ul", { className: "file-results", dir: "ltr", children: [
        visible.map((it, i) => {
          const file = String(it.file ?? it.path ?? "");
          if (!file) return null;
          const line = it.line !== void 0 && it.line !== null ? String(it.line) : "";
          const text = String(it.text ?? "");
          return /* @__PURE__ */ jsxs2("li", { className: "file-result", children: [
            /* @__PURE__ */ jsx3(
              FileChip,
              {
                path: file,
                line: line ? Number(line) : void 0,
                display: `${fileBasename(file)}${line ? `:${line}` : ""}`
              }
            ),
            text && /* @__PURE__ */ jsx3("span", { className: "file-result-text", children: text })
          ] }, i);
        }),
        extra > 0 && /* @__PURE__ */ jsx3("li", { className: "file-result-more", children: /* @__PURE__ */ jsxs2(
          "button",
          {
            type: "button",
            className: "file-result-more-btn",
            title: "Open all results in the side panel",
            onClick: () => useViewerTabs.getState().openText(
              `${tool} results`,
              // Markdown list so the side panel renders every path as a
              // clickable file chip (inline `code` -> FileChip) instead of
              // a wall of raw text.
              deduped.map((it) => {
                const f = String(it.file ?? it.path ?? "");
                const ln = it.line != null ? `:${String(it.line)}` : "";
                const tx = String(it.text ?? "").replace(/`/g, "'").slice(0, 300);
                return `- \`${f}${ln}\`${tx ? ` \u2014 ${tx}` : ""}`;
              }).join("\n"),
              "md"
            ),
            children: [
              "+",
              extra,
              " more"
            ]
          }
        ) }, "more")
      ] });
    });
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
      "task",
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
    DIFF_SIDE_BY_SIDE_THRESHOLD = 768;
    ToolGroupView = memo(function ToolGroupView2({
      activities,
      captions
    }) {
      const [open, setOpen] = useState2(false);
      const running = activities.some((a) => a.activity.status === "running");
      const now = useRunningClock(running);
      const totalMs = activities.reduce((sum, a) => {
        const act = a.activity;
        if (act.status === "running" && act.startedAt) return sum + Math.max(0, now - act.startedAt);
        return sum + (act.elapsedMs || 0);
      }, 0);
      const subagentPills = activities.filter(({ activity }) => isSubagentCard(activity)).map(({ activity, index }) => ({
        key: index,
        label: toolLabel(activity.tool),
        desc: shortArg(String(activity.args?.description ?? ""), 70),
        running: activity.status === "running"
      }));
      const toolCounts = activities.reduce((acc, a) => {
        if (isSubagentCard(a.activity)) return acc;
        const label = toolLabel(a.activity.tool);
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {});
      const searchEngines = [
        ...new Set(
          activities.filter(({ activity }) => activity.tool === "web_search" && activity.engine).map(({ activity }) => activity.engine)
        )
      ];
      const headCaption = (() => {
        if (!captions) return void 0;
        for (let i = captions.length - 1; i >= 0; i--) {
          if (captions[i]) return captions[i];
        }
        return void 0;
      })();
      return /* @__PURE__ */ jsxs2(
        "div",
        {
          className: `tool-group ${open ? "open" : ""} ${running ? "running" : "done"}`,
          children: [
            /* @__PURE__ */ jsxs2(
              "button",
              {
                className: `trace-head ${open ? "open" : ""}`,
                onClick: () => setOpen((o) => !o),
                children: [
                  /* @__PURE__ */ jsx3(IconSparkle, { className: "trace-sparkle" }),
                  /* @__PURE__ */ jsxs2("span", { className: "trace-head-pills", children: [
                    Object.entries(toolCounts).map(([label, n]) => /* @__PURE__ */ jsxs2("span", { className: "trace-pill", children: [
                      label,
                      n > 1 && /* @__PURE__ */ jsxs2("span", { className: "trace-pill-count", children: [
                        "\xD7",
                        n
                      ] })
                    ] }, label)),
                    subagentPills.map(({ key, label, desc, running: running2 }) => /* @__PURE__ */ jsxs2(
                      "span",
                      {
                        className: `trace-pill trace-pill-sub${running2 ? " running" : ""}`,
                        title: desc || label,
                        children: [
                          label,
                          desc && /* @__PURE__ */ jsx3("span", { className: "trace-pill-desc", children: desc })
                        ]
                      },
                      `sub-${key}`
                    ))
                  ] }),
                  searchEngines.map((engine) => /* @__PURE__ */ jsx3("span", { className: "trace-row-engine", children: engine }, engine)),
                  headCaption && /* @__PURE__ */ jsx3("span", { className: "trace-head-caption", dir: "auto", title: prepareContent(headCaption), children: prepareContent(headCaption) }),
                  /* @__PURE__ */ jsxs2("span", { className: "trace-head-right", children: [
                    totalMs > 0 && /* @__PURE__ */ jsx3("span", { className: "trace-time", children: fmtTime(totalMs) }),
                    /* @__PURE__ */ jsx3(IconChevron, { open, className: "trace-chev" })
                  ] })
                ]
              }
            ),
            open && /* @__PURE__ */ jsx3("div", { className: "trace-list", children: activities.map(({ activity, index }, i) => /* @__PURE__ */ jsxs2(Fragment, { children: [
              captions?.[i] && /* @__PURE__ */ jsx3("div", { className: "trace-narration", dir: "auto", children: prepareContent(captions[i]) }),
              /* @__PURE__ */ jsx3(TraceRow, { activity })
            ] }, index)) })
          ]
        }
      );
    });
    ToolSubRow = memo(function ToolSubRow2({
      activity
    }) {
      const [now, setNow] = useState2(() => Date.now());
      const running = activity.status === "running";
      useEffect2(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const subSummary = subArgSummary(activity);
      return /* @__PURE__ */ jsxs2(Fragment2, { children: [
        /* @__PURE__ */ jsxs2(
          "div",
          {
            className: `tool-sub-row ${activity.status}${running ? " running" : ""}`,
            children: [
              /* @__PURE__ */ jsx3(StatusIcon, { status: activity.status }),
              /* @__PURE__ */ jsx3("span", { className: "tool-sub-name", children: toolLabel(activity.tool) }),
              /* @__PURE__ */ jsx3("span", { className: "tool-sub-args", title: subSummary, children: subSummary }),
              activity.summary && /* @__PURE__ */ jsx3("span", { className: "tool-sub-summary", children: activity.summary }),
              /* @__PURE__ */ jsx3("span", { className: "tool-ms", children: fmtTime(ms) })
            ]
          }
        ),
        activity.resultText && /* @__PURE__ */ jsx3("pre", { className: "tool-sub-result", dir: "auto", children: activity.resultText })
      ] });
    });
    TRACE_TEXT_PANEL_MIN = 600;
    TraceRow = memo(function TraceRow2({
      activity
    }) {
      const [now, setNow] = useState2(() => Date.now());
      const [expanded, setExpanded] = useState2(
        () => activity.tool === "edit_file" || activity.tool === "write_file"
      );
      const running = activity.status === "running";
      useEffect2(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const label = toolLabel(activity.tool);
      const detail = activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
      const argsText = activity.args ? Object.entries(activity.args).map(
        ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
      ).join("\n") : "";
      const isEdit = activity.tool === "edit_file" || activity.tool === "write_file";
      const outputText = traceRowOutputText(activity, argsText);
      const sideTitle = `${label} \u2014 ${detail.slice(0, 40)}`;
      const onHeadClick = () => {
        if (!isEdit && outputText.length > TRACE_TEXT_PANEL_MIN) {
          useViewerTabs.getState().openText(sideTitle, outputText, "md");
          return;
        }
        setExpanded((e) => !e);
      };
      return /* @__PURE__ */ jsxs2(
        "div",
        {
          className: `trace-row ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs2(
              "button",
              {
                className: "trace-row-head",
                onClick: onHeadClick,
                children: [
                  /* @__PURE__ */ jsx3("span", { className: "trace-row-bullet", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx3("span", { className: "spinner" }) : activity.tool === "run_terminal" ? /* @__PURE__ */ jsx3(TerminalRowIcon, {}) : "\u2022" }),
                  /* @__PURE__ */ jsx3("span", { className: "trace-pill", children: label }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx3("span", { className: "trace-row-engine", children: activity.engine }),
                  /* @__PURE__ */ jsx3("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  /* @__PURE__ */ jsxs2("span", { className: "trace-row-end", children: [
                    ms ? /* @__PURE__ */ jsx3("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx3(StatusIcon, { status: activity.status }),
                    /* @__PURE__ */ jsx3(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded && /* @__PURE__ */ jsxs2("div", { className: "trace-row-expand", children: [
              ms ? /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Duration" }),
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-val", children: fmtTime(ms) })
              ] }) : null,
              activity.summary && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Summary" }),
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-val", dir: "auto", children: fixZwsp(activity.summary) })
              ] }),
              argsText && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Args" }),
                /* @__PURE__ */ jsx3("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: argsText })
              ] }),
              activity.diff && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Diff" }),
                /* @__PURE__ */ jsx3(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre trace-expand-diff",
                    dir: "auto",
                    children: activity.diff
                  }
                )
              ] }),
              activity.resultText && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Result" }),
                /* @__PURE__ */ jsx3(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre",
                    dir: "auto",
                    children: activity.resultText
                  }
                )
              ] }),
              (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Results" }),
                activity.tool === "web_search" || activity.tool === "fetch_url" ? /* @__PURE__ */ jsx3(
                  WebResultLinks,
                  {
                    items: activity.items ?? activity.results
                  }
                ) : activity.tool === "run_terminal" ? /* @__PURE__ */ jsx3(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results
                  }
                ) : /* @__PURE__ */ jsx3(
                  FileResultLinks,
                  {
                    tool: activity.tool,
                    items: activity.items ?? activity.results
                  }
                )
              ] })
            ] })
          ]
        }
      );
    });
    ToolTimelineRow = memo(function ToolTimelineRow2({
      activity
    }) {
      const [now, setNow] = useState2(() => Date.now());
      const running = activity.status === "running";
      useEffect2(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const detail = subArgSummary(activity);
      return /* @__PURE__ */ jsxs2("div", { className: `tool-timeline-item ${activity.status}`, children: [
        /* @__PURE__ */ jsx3("span", { className: "tool-timeline-icon", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx3("span", { className: "spinner" }) : toolIcon(activity.tool) }),
        /* @__PURE__ */ jsx3("span", { className: "tool-timeline-label", children: toolLabel(activity.tool) }),
        detail && /* @__PURE__ */ jsx3("span", { className: "tool-timeline-detail", title: detail, children: detail }),
        /* @__PURE__ */ jsx3(StatusIcon, { status: activity.status }),
        /* @__PURE__ */ jsx3("span", { className: "tool-ms", children: fmtTime(ms) }),
        activity.items && activity.items.length > 0 && (activity.tool === "web_search" || activity.tool === "fetch_url" ? /* @__PURE__ */ jsx3(WebResultLinks, { items: activity.items }) : /* @__PURE__ */ jsx3(
          FileResultLinks,
          {
            tool: activity.tool,
            items: activity.items
          }
        ))
      ] });
    });
    PREVIEW_COUNT = 3;
    ToolCascade = memo(function ToolCascade2({
      activities
    }) {
      const last = activities.slice(-PREVIEW_COUNT);
      const listRef = useRef3(null);
      const prevTops = useRef3(/* @__PURE__ */ new Map());
      const firstRun = useRef3(true);
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
      return /* @__PURE__ */ jsx3("div", { className: "tool-cascade", ref: listRef, children: last.map((a, i) => /* @__PURE__ */ jsx3(
        "div",
        {
          "data-key": a.callId ?? `${a.tool}-${i}`,
          className: "tool-cascade-item",
          style: { zIndex: i + 1 },
          children: /* @__PURE__ */ jsx3(ToolSubRow, { activity: a })
        },
        a.callId ?? `${a.tool}-${i}`
      )) });
    });
    TraceNarration = memo(function TraceNarration2({
      text
    }) {
      return /* @__PURE__ */ jsx3("div", { className: "trace-narration", dir: "auto", children: prepareContent(text) });
    });
    ToolSingleRow = memo(function ToolSingleRow2({
      activity,
      messageId
    }) {
      const [now, setNow] = useState2(() => Date.now());
      const [expanded, setExpanded] = useState2(false);
      const running = activity.status === "running";
      useEffect2(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const label = toolLabel(activity.tool);
      const detail = activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
      const argsText = activity.args ? Object.entries(activity.args).map(
        ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
      ).join("\n") : "";
      const isEdit = activity.tool === "edit_file" || activity.tool === "write_file";
      const openReview = useViewerTabs((s) => s.openReview);
      const outputText = traceRowOutputText(activity, argsText);
      const sideTitle = `${label} \u2014 ${detail.slice(0, 40)}`;
      const onHeadClick = () => {
        if (isEdit) {
          if (messageId) openReview(messageId, reviewPathOf(activity));
          return;
        }
        if (isSubagentCard(activity) && outputText.trim()) {
          useViewerTabs.getState().openText(sideTitle, outputText, "md");
          return;
        }
        if (outputText.length > TRACE_TEXT_PANEL_MIN) {
          useViewerTabs.getState().openText(sideTitle, outputText, "md");
          return;
        }
        setExpanded((e) => !e);
      };
      const diffStats = (() => {
        if (!activity.diff) return null;
        const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
        return s.adds || s.dels ? `+${s.adds} -${s.dels}` : null;
      })();
      return /* @__PURE__ */ jsxs2(
        "div",
        {
          className: `trace-row single ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs2(
              "button",
              {
                className: "trace-row-head",
                onClick: onHeadClick,
                title: isEdit ? "Review changes in the side panel" : void 0,
                children: [
                  /* @__PURE__ */ jsx3(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx3("span", { className: "trace-pill", children: label }),
                  isEdit ? /* @__PURE__ */ jsx3(
                    "span",
                    {
                      className: "trace-row-detail",
                      dir: "auto",
                      title: reviewPathOf(activity),
                      children: reviewPathOf(activity).split("/").pop()
                    }
                  ) : /* @__PURE__ */ jsx3("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx3("span", { className: "trace-row-engine", children: activity.engine }),
                  /* @__PURE__ */ jsxs2("span", { className: "trace-row-end", children: [
                    isEdit && diffStats && /* @__PURE__ */ jsx3("span", { className: "trace-row-diff-stats", children: diffStats }),
                    isEdit && messageId && activity.diff && /* @__PURE__ */ jsx3("span", { className: "trace-row-review", "aria-hidden": "true", children: "Review \u2197" }),
                    ms ? /* @__PURE__ */ jsx3("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx3(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded ? /* @__PURE__ */ jsxs2("div", { className: "trace-row-expand", children: [
              ms ? /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Duration" }),
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-val", children: fmtTime(ms) })
              ] }) : null,
              activity.summary && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Summary" }),
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-val", dir: "auto", children: fixZwsp(activity.summary) })
              ] }),
              argsText && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Args" }),
                /* @__PURE__ */ jsx3("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: argsText })
              ] }),
              activity.diff && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Diff" }),
                /* @__PURE__ */ jsx3(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre trace-expand-diff",
                    dir: "auto",
                    children: activity.diff
                  }
                )
              ] }),
              activity.resultText && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Result" }),
                /* @__PURE__ */ jsx3(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre",
                    dir: "auto",
                    children: activity.resultText
                  }
                )
              ] }),
              (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsxs2("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx3("span", { className: "trace-expand-key", children: "Results" }),
                activity.tool === "web_search" || activity.tool === "fetch_url" ? /* @__PURE__ */ jsx3(
                  WebResultLinks,
                  {
                    items: activity.items ?? activity.results
                  }
                ) : activity.tool === "run_terminal" ? /* @__PURE__ */ jsx3(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results
                  }
                ) : /* @__PURE__ */ jsx3(
                  FileResultLinks,
                  {
                    tool: activity.tool,
                    items: activity.items ?? activity.results
                  }
                )
              ] })
            ] }) : null
          ]
        }
      );
    });
    ToolCallView = memo(function ToolCallView2({
      activity,
      chatId,
      messageId,
      onReverted
    }) {
      const [reverting, setReverting] = useState2(false);
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const [collapsed, setCollapsed] = useState2(isSubagentCard(activity));
      const collapsible = (activity.tool === "task" || activity.tool === "explore") && ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary));
      const toolRunning = activity.status === "running" || (activity.children?.some((c) => c.status === "running") ?? false);
      const now = useRunningClock(toolRunning);
      const ms = activity.status === "running" && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const isWrite = activity.tool === "write_file" || activity.tool === "edit_file";
      const writePath = reviewPathOf(activity);
      const readPaths = Array.isArray(activity.args?.paths) ? activity.args.paths : [];
      const fetchSummary = activity.tool === "fetch_url" ? activity.summary : "";
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
          const path = String(activity.args?.path ?? activity.args?.filePath ?? "");
          const { content: current } = await api.fsRead(root, path);
          const oldContent = applyReverseDiff(activity.diff, current ?? "");
          const ok = await api.fsWrite(root, path, oldContent);
          if (ok) onReverted?.();
        } finally {
          setReverting(false);
        }
      };
      return /* @__PURE__ */ jsxs2(
        "div",
        {
          className: `tool-card ${activity.status}${activity.tool === "explore" ? " explore" : ""}`,
          children: [
            /* @__PURE__ */ jsxs2(
              "div",
              {
                className: `tool-card-head${collapsible ? " collapsible" : ""}${isWrite ? " write-head" : ""}`,
                onClick: isWrite ? () => messageId && openReview(messageId, writePath) : collapsible ? () => setCollapsed((c) => !c) : void 0,
                role: isWrite || collapsible ? "button" : void 0,
                tabIndex: isWrite || collapsible ? 0 : void 0,
                "aria-expanded": collapsible ? !collapsed : void 0,
                title: isWrite ? "Review changes in the side panel" : void 0,
                onKeyDown: isWrite || collapsible ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isWrite) {
                      if (messageId) openReview(messageId, writePath);
                    } else {
                      setCollapsed((c) => !c);
                    }
                  }
                } : void 0,
                children: [
                  /* @__PURE__ */ jsx3(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx3("span", { className: "tool-name", children: isWrite ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
                    /* @__PURE__ */ jsx3("span", { className: "tool-verb", children: activity.tool === "write_file" ? "Wrote" : "Edited" }),
                    /* @__PURE__ */ jsxs2("span", { className: "tool-file", title: writePath, children: [
                      /* @__PURE__ */ jsx3(FileIcon, { path: writePath, size: 20 }),
                      /* @__PURE__ */ jsx3("span", { className: "tool-file-name", dir: "ltr", children: writePath.split("/").pop() ?? writePath })
                    ] })
                  ] }) : isSubagentCard(activity) ? activity.tool === "explore" ? toolLabel(activity.tool) : "sub-agent" : toolLabel(activity.tool) }),
                  activity.tool === "task" && !!activity.args?.subagent_type && /* @__PURE__ */ jsx3("span", { className: "tool-badge", children: String(activity.args.subagent_type) }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx3("span", { className: "tool-badge tool-engine-badge", children: activity.engine }),
                  activity.args && activity.args.command !== void 0 && /* @__PURE__ */ jsx3("span", { className: "tool-cmd", children: String(activity.args.command) }),
                  activity.args && activity.args.path !== void 0 && !isWrite && /* @__PURE__ */ jsx3(ToolPathSpan, { path: String(activity.args.path) }),
                  activity.args && activity.args.filePath !== void 0 && !isWrite && /* @__PURE__ */ jsx3(ToolPathSpan, { path: String(activity.args.filePath) }),
                  activity.args && activity.args.filePath !== void 0 && (String(activity.args.offset ?? 1) !== "1" || Number(activity.args.limit ?? 2e3) < 2e3) && /* @__PURE__ */ jsx3("span", { className: "tool-path", children: `${activity.args.offset ?? 1}\u2013${Number(activity.args.offset ?? 1) + Number(activity.args.limit ?? 2e3) - 1}` }),
                  activity.args && activity.args.start !== void 0 && /* @__PURE__ */ jsxs2("span", { className: "tool-path", children: [
                    String(activity.args.start),
                    activity.args.end !== void 0 && activity.args.end !== -1 ? `\u2013${String(activity.args.end)}` : "+"
                  ] }),
                  activity.args && activity.args.query !== void 0 && /* @__PURE__ */ jsx3("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.query)) }),
                  activity.args && activity.args.pattern !== void 0 && /* @__PURE__ */ jsx3("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.pattern)) }),
                  activity.args && activity.args.description !== void 0 && /* @__PURE__ */ jsx3(
                    "span",
                    {
                      className: "tool-cmd tool-task",
                      title: String(activity.args.description),
                      children: fixZwsp(
                        String(activity.args.description).length > 120 ? `${String(activity.args.description).slice(0, 120)}\u2026` : String(activity.args.description)
                      )
                    }
                  ),
                  (activity.tool === "task" || activity.tool === "explore") && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsxs2("span", { className: "tool-badge tool-sub-count", children: [
                    activity.children.length,
                    " call",
                    activity.children.length === 1 ? "" : "s"
                  ] }),
                  activity.tool === "memory" && activity.args && /* @__PURE__ */ jsx3("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.text || activity.args.subject || "")) }),
                  readPaths.length > 0 && /* @__PURE__ */ jsxs2(Fragment2, { children: [
                    readPaths.slice(0, 2).map((p, i) => /* @__PURE__ */ jsx3(ToolPathSpan, { path: p }, i)),
                    readPaths.length > 2 && /* @__PURE__ */ jsxs2("span", { className: "tool-path tool-more", children: [
                      "+",
                      readPaths.length - 2,
                      " more"
                    ] })
                  ] }),
                  fetchSummary && /* @__PURE__ */ jsx3("span", { className: "tool-cmd", children: fixZwsp(fetchSummary) }),
                  activity.args && !isSubagentCard(activity) && /* @__PURE__ */ jsx3(ToolArgs, { args: activity.args }),
                  /* @__PURE__ */ jsxs2("span", { className: "tool-card-head-end", children: [
                    ms ? /* @__PURE__ */ jsx3("span", { className: "tool-ms", children: fmtTime(ms) }) : null,
                    isWrite && activity.diff && (() => {
                      const adds = (activity.diff.match(/^\+[^+]/gm) || []).length;
                      const dels = (activity.diff.match(/^-[^-]/gm) || []).length;
                      return adds + dels > 0 ? /* @__PURE__ */ jsxs2("span", { className: "tool-diff-stats", children: [
                        /* @__PURE__ */ jsxs2("span", { className: "review-count-add", children: [
                          "+",
                          adds
                        ] }),
                        " ",
                        /* @__PURE__ */ jsxs2("span", { className: "review-count-del", children: [
                          "-",
                          dels
                        ] })
                      ] }) : null;
                    })(),
                    isWrite && activity.diff && messageId && /* @__PURE__ */ jsx3(
                      "button",
                      {
                        className: "tool-review-btn",
                        title: "Open in Review panel",
                        onClick: (e) => {
                          e.stopPropagation();
                          openReview(messageId, writePath);
                        },
                        children: "Review \u2197"
                      }
                    ),
                    isWrite && activity.reverted && /* @__PURE__ */ jsx3("span", { className: "reverted-tag", children: "reverted" }),
                    collapsible && /* @__PURE__ */ jsx3("span", { className: `chev${collapsed ? "" : " open"}`, children: "\u25BE" })
                  ] })
                ]
              }
            ),
            collapsed && (activity.tool === "task" || activity.tool === "explore") && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx3(ToolCascade, { activities: activity.children }),
            !collapsed && !isWrite && /* @__PURE__ */ jsxs2("div", { className: "tool-card-body", children: [
              activity.summary && !isWrite && /* @__PURE__ */ jsx3("div", { className: "tool-summary", children: fixZwsp(activity.summary) }),
              (activity.tool === "task" || activity.tool === "explore") && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx3("div", { className: "tool-sub-list", children: activity.children.map((child, i) => /* @__PURE__ */ jsx3(
                ToolSubRow,
                {
                  activity: child
                },
                `${child.tool}-${i}-${child.callId ?? i}`
              )) }),
              activity.tool === "web_search" && (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsx3(WebResultLinks, { items: activity.items ?? activity.results }),
              activity.tool === "run_terminal" && (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsx3(
                TerminalResultText,
                {
                  items: activity.items ?? activity.results
                }
              ),
              activity.diff && /* @__PURE__ */ jsx3(
                DiffView,
                {
                  diff: activity.diff,
                  path: reviewPathOf(activity)
                }
              )
            ] })
          ]
        }
      );
    });
  }
});

// src/components/FullscreenModal.tsx
import { useEffect as useEffect3, useRef as useRef4, useState as useState3 } from "react";
import { createPortal as createPortal2 } from "react-dom";
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}
function FullscreenModal({
  open,
  onClose,
  title,
  children,
  bodyClass,
  scrollable = false
}) {
  const [zoom, setZoom] = useState3(1);
  const [pan, setPan] = useState3({ x: 0, y: 0 });
  const [sel, setSel] = useState3(null);
  const [cursor, setCursor] = useState3("grab");
  const dragRef = useRef4(null);
  const selRef = useRef4(null);
  const viewportRef = useRef4(null);
  const zoomRef = useRef4(zoom);
  const panRef = useRef4(pan);
  useEffect3(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect3(() => {
    if (open) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setSel(null);
    }
  }, [open]);
  useEffect3(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);
  useEffect3(() => {
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
    const W = rect.width;
    const H = rect.height;
    const nz = clampZoom(zoom * Math.min(W / sw, H / sh));
    const ccx = (sx + sw / 2 - pan.x) / zoom;
    const ccy = (sy + sh / 2 - pan.y) / zoom;
    const nx = W / 2 - ccx * nz;
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
  return createPortal2(
    /* @__PURE__ */ jsx4("div", { className: "fullscreen-modal-scrim", onClick: onClose, role: "presentation", children: /* @__PURE__ */ jsxs3(
      "div",
      {
        className: "fullscreen-modal-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title ?? "Full screen",
        onClick: (e) => e.stopPropagation(),
        children: [
          /* @__PURE__ */ jsxs3("div", { className: "fullscreen-modal-head", children: [
            /* @__PURE__ */ jsx4("span", { className: "fullscreen-modal-title", children: title }),
            /* @__PURE__ */ jsx4(
              "button",
              {
                className: "fullscreen-close",
                onClick: onClose,
                "aria-label": "Close",
                title: "Close (Esc)",
                children: "\u2715"
              }
            )
          ] }),
          /* @__PURE__ */ jsxs3("div", { className: `fullscreen-modal-body ${bodyClass ?? ""}`, children: [
            /* @__PURE__ */ jsxs3(
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
                  /* @__PURE__ */ jsx4(
                    "div",
                    {
                      className: "fullscreen-pan-content",
                      style: scrollable ? void 0 : { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` },
                      children
                    }
                  ),
                  !scrollable && sel && /* @__PURE__ */ jsx4(
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
            ),
            !scrollable && /* @__PURE__ */ jsx4("div", { className: "fullscreen-zoom-bar", children: /* @__PURE__ */ jsx4("button", { onClick: reset, "aria-label": "Reset zoom", title: "Reset zoom (100%)", children: "\u27F3" }) })
          ] })
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
    MIN_ZOOM = 1;
    MAX_ZOOM = 5;
    ZOOM_STEP = 0.02;
  }
});

// src/lib/fullscreen.ts
import { create as create3 } from "zustand";
var useFullscreen;
var init_fullscreen = __esm({
  "src/lib/fullscreen.ts"() {
    "use strict";
    useFullscreen = create3((set) => ({
      activeKey: null,
      open: (key) => set({ activeKey: key }),
      close: () => set({ activeKey: null })
    }));
  }
});

// src/components/Mermaid.tsx
import { useEffect as useEffect4, useId, useState as useState4 } from "react";
import mermaid from "mermaid";
import { Fragment as Fragment3, jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
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
function ensureMermaidInit() {
  if (mermaidReady) return;
  mermaidReady = true;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: readThemeVars()
    });
  } catch {
  }
}
function sanitizeChart(text) {
  return text.replace(BIDI_CONTROL_RE, "");
}
function Mermaid({ chart, embedded = false }) {
  const [svg, setSvg] = useState4(null);
  const [failed2, setFailed] = useState4(false);
  const myKey = useId();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const expanded = activeKey === myKey;
  const renderDiagram = () => {
    setFailed(false);
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    const cleanChart = sanitizeChart(chart);
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    document.body.appendChild(container);
    ensureMermaidInit();
    const cleanup = () => {
      container.remove();
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    };
    mermaid.render(id, cleanChart, container).then((r) => {
      setSvg(applyRtlToSvgText(r.svg));
      return r;
    }).catch((err) => {
      console.error("[Mermaid] render failed, retrying with dark theme:", err);
      return mermaid.render(`${id}-retry`, cleanChart, container);
    }).then((r) => {
      if (r) setSvg(applyRtlToSvgText(r.svg));
    }).catch((err) => {
      console.error("[Mermaid] retry also failed, showing fallback:", err);
      setFailed(true);
    }).finally(cleanup);
  };
  useEffect4(() => {
    const t = setTimeout(renderDiagram, 400);
    return () => clearTimeout(t);
  }, [chart]);
  if (failed2) {
    return /* @__PURE__ */ jsxs4(Fragment3, { children: [
      /* @__PURE__ */ jsx5(
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
      !embedded && /* @__PURE__ */ jsx5(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx5("div", { className: "mermaid-fullscreen", children: /* @__PURE__ */ jsx5("pre", { className: "mermaid-fallback", dir: "auto", children: chart }) }) })
    ] });
  }
  const safeSvg = svg;
  const diagram = /* @__PURE__ */ jsx5(
    "div",
    {
      className: "mermaid-block",
      dir: "auto",
      dangerouslySetInnerHTML: safeSvg ? { __html: safeSvg } : void 0,
      style: embedded ? void 0 : { cursor: "zoom-in" },
      title: embedded ? void 0 : "Click to expand",
      onClick: embedded ? void 0 : () => openFs(myKey)
    }
  );
  if (embedded) return diagram;
  return /* @__PURE__ */ jsxs4(Fragment3, { children: [
    diagram,
    /* @__PURE__ */ jsx5(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx5("div", { className: "mermaid-fullscreen", children: safeSvg ? /* @__PURE__ */ jsx5("div", { className: "mermaid-block", dir: "auto", dangerouslySetInnerHTML: { __html: safeSvg } }) : /* @__PURE__ */ jsx5(Mermaid, { chart, embedded: true }) }) })
  ] });
}
var mermaidReady, BIDI_CONTROL_RE;
var init_Mermaid = __esm({
  "src/components/Mermaid.tsx"() {
    "use strict";
    init_FullscreenModal();
    init_fullscreen();
    init_bidi();
    mermaidReady = false;
    BIDI_CONTROL_RE = /[\u200B\u200E\u200F\u2066-\u2069\u061C]/g;
  }
});

// src/components/MessageImages.tsx
import { useId as useId2, useState as useState5 } from "react";
import { Fragment as Fragment4, jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
function MessageImages({
  images,
  modalTitle
}) {
  const fsKey = useId2();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const [selected, setSelected] = useState5(null);
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
  };
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    /* @__PURE__ */ jsx6("div", { className: "msg-images", dir: "ltr", children: images.map((img, idx) => /* @__PURE__ */ jsx6(
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
        children: usable(img.dataUrl) ? /* @__PURE__ */ jsx6(
          "img",
          {
            src: img.dataUrl,
            alt: img.name,
            loading: "lazy",
            decoding: "async"
          }
        ) : /* @__PURE__ */ jsx6("span", { className: "msg-image-ph", children: img.name })
      },
      img.path
    )) }),
    current && usable(current.dataUrl) && /* @__PURE__ */ jsx6(
      FullscreenModal,
      {
        open: expanded,
        onClose: close,
        title: modalTitle ?? current.name,
        children: /* @__PURE__ */ jsx6("div", { className: "image-fullscreen", children: /* @__PURE__ */ jsx6("img", { src: current.dataUrl, alt: current.name, decoding: "async" }) })
      }
    )
  ] });
}
var init_MessageImages = __esm({
  "src/components/MessageImages.tsx"() {
    "use strict";
    init_FullscreenModal();
    init_fullscreen();
  }
});

// tests/css-stub.js
var init_css_stub = __esm({
  "tests/css-stub.js"() {
    "use strict";
  }
});

// src/components/ChatMessage.tsx
import {
  memo as memo2,
  useEffect as useEffect5,
  useMemo,
  useRef as useRef5,
  useState as useState6
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import { Fragment as Fragment5, jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
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
      const raw = a.args?.path ?? a.args?.filePath;
      const candidates = [
        typeof raw === "string" ? raw : "",
        typeof a.summary === "string" ? a.summary : ""
      ];
      for (const c of candidates) {
        if (!c) continue;
        const token = c.trim().split(/\s+/).find((t) => isDocPath(t)) ?? "";
        const target = token || (isDocPath(c) ? c.trim() : "");
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
  return /* @__PURE__ */ jsx7("div", { className: "msg-attachments", dir: "ltr", children: paths.map((p) => /* @__PURE__ */ jsx7(FileChip, { path: p, display: attachmentBasename(p) }, p)) });
}
function computePrepared(id, text, dir) {
  const hit = preparedCache.get(id);
  if (hit && hit.text === text) return hit.out;
  const out = prepareContent(text, dir);
  if (preparedCache.size >= PREPARED_CACHE_MAX) {
    const oldest = preparedCache.keys().next().value;
    if (oldest !== void 0) preparedCache.delete(oldest);
  }
  preparedCache.set(id, { text, out });
  return out;
}
function cachedPrepare(id, text, dir) {
  if (!text) return text;
  return computePrepared(id, text, dir);
}
function useCapped(id, text, live) {
  const over = !live && text.length > RENDER_CAP;
  const [showAll, setShowAll] = useState6(false);
  const shown = over && !showAll ? text.slice(0, RENDER_CAP) : text;
  return { shown, over, cut: text.length - shown.length, showAll, setShowAll };
}
function PlanDocCard({
  planDoc
}) {
  const [copied, setCopied] = useState6(false);
  const appDir = useStore((s) => s.dir);
  const preview = useMemo(() => {
    const text = planDoc.body.replace(/```[\s\S]*?```/g, "\n[\u2026]\n").replace(/^#{1,6}\s+/gm, "").replace(/[*`>]/g, "").replace(/^plan\s*:?[ \t]*\n/i, "").trim();
    const clipped = text.length > 600 ? `${text.slice(0, 600).trimEnd()}\u2026` : text;
    return prepareContent(clipped, appDir);
  }, [planDoc.body, appDir]);
  return /* @__PURE__ */ jsxs6("div", { className: "plan-doc-card", dir: appDir, children: [
    /* @__PURE__ */ jsxs6("div", { className: "plan-doc-head", children: [
      /* @__PURE__ */ jsx7("span", { className: "plan-doc-icon", "aria-hidden": "true", children: /* @__PURE__ */ jsxs6(
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
            /* @__PURE__ */ jsx7("rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }),
            /* @__PURE__ */ jsx7("path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" })
          ]
        }
      ) }),
      /* @__PURE__ */ jsx7("span", { className: "plan-doc-label", children: "Plan" }),
      planDoc.title ? /* @__PURE__ */ jsx7("span", { className: "plan-doc-title", children: planDoc.title }) : null,
      /* @__PURE__ */ jsx7("span", { className: "plan-doc-spacer" }),
      /* @__PURE__ */ jsx7(
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
          children: copied ? /* @__PURE__ */ jsx7(
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
              children: /* @__PURE__ */ jsx7("path", { d: "M20 6L9 17l-5-5" })
            }
          ) : /* @__PURE__ */ jsxs6(
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
                /* @__PURE__ */ jsx7("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                /* @__PURE__ */ jsx7("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
              ]
            }
          )
        }
      )
    ] }),
    /* @__PURE__ */ jsx7("div", { className: "plan-doc-preview", children: preview }),
    /* @__PURE__ */ jsxs6(
      "button",
      {
        type: "button",
        className: "plan-doc-open",
        onClick: () => useViewerTabs.getState().openPlan(),
        children: [
          "View full plan",
          /* @__PURE__ */ jsx7(
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
              children: /* @__PURE__ */ jsx7("path", { d: "M5 12h14M13 6l6 6-6 6" })
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
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function splitHighlightedHtml(html2) {
  const lines = [];
  const openTags = [];
  let current = "";
  let i = 0;
  while (i < html2.length) {
    const ch = html2[i];
    if (ch === "\n") {
      current += "</span>".repeat(openTags.length);
      lines.push(current);
      current = openTags.join("");
      i++;
      continue;
    }
    if (html2.startsWith("<span", i)) {
      const end = html2.indexOf(">", i) + 1;
      const tag = html2.slice(i, end);
      openTags.push(tag);
      current += tag;
      i = end;
      continue;
    }
    if (html2.startsWith("</span>", i)) {
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
function getHighlightedLines(whole, lang) {
  const key = `${lang}
${whole}`;
  const hit = highlightCache.get(key);
  if (hit) return hit;
  let lines;
  try {
    const html2 = lang && hljs.getLanguage(lang) ? hljs.highlight(whole, { language: lang }).value : hljs.highlightAuto(whole).value;
    lines = splitHighlightedHtml(sanitizeHtml(html2));
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
  const [errored, setErrored] = useState6(false);
  if (!src || errored) {
    return /* @__PURE__ */ jsx7("span", { className: "md-image-wrap md-image-errored", children: /* @__PURE__ */ jsxs6("span", { className: "md-image-fallback", children: [
      "\u{1F5BC}\uFE0F ",
      alt || "Image unavailable"
    ] }) });
  }
  return /* @__PURE__ */ jsxs6("span", { className: "md-image-wrap", children: [
    /* @__PURE__ */ jsx7(
      "img",
      {
        src,
        alt: alt ?? "",
        loading: "lazy",
        onError: () => setErrored(true),
        ...props
      }
    ),
    alt ? /* @__PURE__ */ jsx7("span", { className: "md-image-caption", children: alt }) : null
  ] });
}
function VideoThumbnailCard({
  video,
  href,
  children
}) {
  const [thumbErr, setThumbErr] = useState6(false);
  const label = children?.toString().trim() || video.title;
  const openVideo = () => void window.coder.openExternal(video.videoUrl);
  return /* @__PURE__ */ jsxs6(
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
        !thumbErr ? /* @__PURE__ */ jsx7(
          "img",
          {
            className: "md-video-thumb",
            src: video.thumbnailUrl,
            alt: label,
            loading: "lazy",
            onError: () => setThumbErr(true)
          }
        ) : /* @__PURE__ */ jsx7("span", { className: "md-video-thumb md-video-thumb-fallback", children: "\u{1F3AC}" }),
        /* @__PURE__ */ jsx7("span", { className: "md-video-play", children: "\u25B6" }),
        /* @__PURE__ */ jsx7("span", { className: "md-video-label", children: label })
      ]
    }
  );
}
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
function UsageBadge({
  input,
  output,
  total,
  live
}) {
  const body = `\u2191 ${fmtTokens(input)} in \xB7 \u2193 ${live ? "\u2026" : fmtTokens(output)} out`;
  return /* @__PURE__ */ jsx7(
    "span",
    {
      className: `msg-usage${live ? " live" : ""}`,
      title: `${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`,
      dir: "ltr",
      children: body
    }
  );
}
function ThinkingIndicator({
  startedAt,
  label = "Thinking"
}) {
  const [elapsed, setElapsed] = useState6(() => {
    const base = startedAt ?? Date.now();
    return Date.now() - base;
  });
  useEffect5(() => {
    const base = startedAt ?? Date.now();
    setElapsed(Date.now() - base);
    const id = setInterval(() => setElapsed(Date.now() - base), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return /* @__PURE__ */ jsx7("span", { className: "msg-thinking", "aria-label": label, children: /* @__PURE__ */ jsxs6("span", { className: "msg-thinking-inner", dir: "ltr", children: [
    /* @__PURE__ */ jsx7("span", { className: "msg-thinking-text", children: label }),
    /* @__PURE__ */ jsxs6("span", { className: "msg-thinking-dots", "aria-hidden": "true", children: [
      /* @__PURE__ */ jsx7("span", { className: "dot" }),
      /* @__PURE__ */ jsx7("span", { className: "dot" }),
      /* @__PURE__ */ jsx7("span", { className: "dot" })
    ] }),
    /* @__PURE__ */ jsx7("span", { className: "msg-thinking-elapsed", children: fmtElapsed(elapsed) })
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
  return /* @__PURE__ */ jsxs6(
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
        /* @__PURE__ */ jsx7("path", { d: "M12 20h9" }),
        /* @__PURE__ */ jsx7("path", { d: "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" })
      ]
    }
  );
}
function UserMessageBubble({
  message: message2,
  onRetry,
  onEdit,
  editingDisabled,
  className
}) {
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState6(false);
  const [isEditing, setIsEditing] = useState6(false);
  const [draft, setDraft] = useState6("");
  const editInputRef = useRef5(null);
  useEffect5(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const content = message2.content || "";
  const isLong = content.length > USER_COLLAPSE_CHARS || content.split("\n").length > USER_COLLAPSE_LINES;
  const body = isLong ? content.slice(0, USER_COLLAPSE_CHARS) : content;
  const clamped = isLong;
  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message2.content)));
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
    onEdit?.(message2.id, next);
    setIsEditing(false);
  };
  return /* @__PURE__ */ jsxs6(Fragment5, { children: [
    /* @__PURE__ */ jsxs6("div", { className: `msg-bubble${className ? ` ${className}` : ""}${isEditing ? " editing" : ""}`, children: [
      isEditing ? /* @__PURE__ */ jsxs6("div", { className: "msg-edit-wrap", children: [
        /* @__PURE__ */ jsx7(
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
        /* @__PURE__ */ jsxs6("div", { className: "msg-edit-actions", children: [
          /* @__PURE__ */ jsx7(
            "span",
            {
              className: "msg-edit-hint",
              title: "Escape cancels, Enter sends",
              "aria-hidden": "true",
              children: "i"
            }
          ),
          /* @__PURE__ */ jsx7("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
        ] })
      ] }) : /* @__PURE__ */ jsx7(
        "div",
        {
          className: `chat-message user-text${clamped ? " clamped" : ""}`,
          dir,
          children: cachedPrepare(message2.id, body, dir) || "(empty)"
        }
      ),
      !isEditing && isLong && /* @__PURE__ */ jsx7(
        "button",
        {
          className: "msg-expand",
          onClick: () => useViewerTabs.getState().openText(textTabTitle(content, "Message"), content),
          title: "Open the full text in the side panel",
          children: "Show more"
        }
      ),
      message2.attachments && message2.attachments.length > 0 && /* @__PURE__ */ jsx7("div", { className: "msg-attachments", dir: "ltr", children: message2.attachments.map((a) => /* @__PURE__ */ jsxs6(
        "span",
        {
          className: "attachment-chip attachment-chip-open",
          role: "button",
          tabIndex: 0,
          title: `${a} \u2014 open in the side panel`,
          onClick: () => openWorkspaceFile(a),
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openWorkspaceFile(a);
            }
          },
          children: [
            /* @__PURE__ */ jsx7(FileIcon, { path: a, size: 20 }),
            attachmentBasename(a)
          ]
        },
        a
      )) }),
      message2.images && message2.images.length > 0 && /* @__PURE__ */ jsx7(MessageImages, { images: message2.images })
    ] }),
    message2.content && !isEditing && /* @__PURE__ */ jsxs6("div", { className: "msg-actions", children: [
      onRetry && /* @__PURE__ */ jsx7(
        "button",
        {
          className: "msg-copy msg-retry",
          onClick: () => onRetry(message2.id),
          title: "Retry",
          children: /* @__PURE__ */ jsxs6(
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
                /* @__PURE__ */ jsx7("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
                /* @__PURE__ */ jsx7("path", { d: "M3 3v5h5" })
              ]
            }
          )
        }
      ),
      onEdit && !isEditing && /* @__PURE__ */ jsx7(
        "button",
        {
          className: "msg-copy msg-edit",
          onClick: startEdit,
          disabled: editingDisabled,
          title: "Edit message",
          "aria-label": "Edit message",
          children: /* @__PURE__ */ jsx7(EditIcon, {})
        }
      ),
      /* @__PURE__ */ jsx7(
        "button",
        {
          className: `msg-copy ${copied ? "copied" : ""}`,
          onClick: copy,
          title: "Copy message",
          "aria-label": "Copy message",
          children: copied ? /* @__PURE__ */ jsx7(
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
              children: /* @__PURE__ */ jsx7("path", { d: "M20 6 9 17l-5-5" })
            }
          ) : /* @__PURE__ */ jsxs6(
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
                /* @__PURE__ */ jsx7("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                /* @__PURE__ */ jsx7("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
              ]
            }
          )
        }
      ),
      /* @__PURE__ */ jsx7(
        "button",
        {
          className: "msg-copy msg-fork",
          onClick: () => useStore.getState().forkChatFromMessage(message2.id),
          title: "Fork chat from here",
          "aria-label": "Fork chat from here",
          children: /* @__PURE__ */ jsxs6(
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
                /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "18", r: "3" }),
                /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "6", r: "3" }),
                /* @__PURE__ */ jsx7("circle", { cx: "18", cy: "6", r: "3" }),
                /* @__PURE__ */ jsx7("path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }),
                /* @__PURE__ */ jsx7("path", { d: "M12 12v3" })
              ]
            }
          )
        }
      )
    ] })
  ] });
}
function QueuedCollapsibleText({
  id,
  text,
  onEdit,
  editingDisabled
}) {
  const dir = useStore((s) => s.dir);
  const isLong = isCollapsibleText(text);
  const [isEditing, setIsEditing] = useState6(false);
  const [draft, setDraft] = useState6("");
  const editInputRef = useRef5(null);
  useEffect5(() => {
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
  return /* @__PURE__ */ jsxs6(Fragment5, { children: [
    isEditing ? /* @__PURE__ */ jsxs6("div", { className: "msg-edit-wrap", children: [
      /* @__PURE__ */ jsx7(
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
      /* @__PURE__ */ jsxs6("div", { className: "msg-edit-actions", children: [
        /* @__PURE__ */ jsx7(
          "span",
          {
            className: "msg-edit-hint",
            title: "Escape cancels, Enter sends",
            "aria-hidden": "true",
            children: "i"
          }
        ),
        /* @__PURE__ */ jsx7("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
      ] })
    ] }) : /* @__PURE__ */ jsxs6(Fragment5, { children: [
      /* @__PURE__ */ jsx7(
        "div",
        {
          className: `queued-bubble-text${isLong ? " clamped" : ""}`,
          dir: detectDir(text),
          children: cachedPrepare(id, text, dir) || "(empty)"
        }
      ),
      isLong && /* @__PURE__ */ jsx7(
        "button",
        {
          className: "msg-expand queued-expand",
          onClick: () => useViewerTabs.getState().openText(textTabTitle(text, "Queued text"), text),
          title: "Open the full text in the side panel",
          children: "Show more"
        }
      )
    ] }),
    onEdit && !isEditing && /* @__PURE__ */ jsx7("div", { className: "msg-actions", children: /* @__PURE__ */ jsx7(
      "button",
      {
        className: "msg-copy msg-edit",
        onClick: startEdit,
        disabled: editingDisabled,
        title: "Edit message",
        "aria-label": "Edit message",
        children: /* @__PURE__ */ jsx7(EditIcon, {})
      }
    ) })
  ] });
}
function SegSteerBubble({
  message: message2,
  onRetry,
  onEdit,
  editingDisabled
}) {
  return /* @__PURE__ */ jsxs6("div", { className: "msg user seg-steer", children: [
    /* @__PURE__ */ jsxs6("div", { className: "msg-role", children: [
      /* @__PURE__ */ jsx7("span", { className: "msg-role-avatar", "aria-hidden": "true", children: /* @__PURE__ */ jsxs6(
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
            /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "8", r: "4" }),
            /* @__PURE__ */ jsx7("path", { d: "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" })
          ]
        }
      ) }),
      "You"
    ] }),
    /* @__PURE__ */ jsx7(UserMessageBubble, { message: message2, onRetry, onEdit, editingDisabled })
  ] });
}
function isCaptionCandidate(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("```")) return false;
  if (t.length > CAPTION_MAX_CHARS) return false;
  if (t.split("\n").length > CAPTION_MAX_LINES) return false;
  return true;
}
function renderSegments(message2, onRetry, onEdit, editingDisabled) {
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
        /* @__PURE__ */ jsx7(
          ToolCallView,
          {
            activity,
            messageId: message2.id,
            onReverted: () => useStore.getState().markToolReverted(message2.id, entryIndex)
          },
          `edit-${entryIndex}`
        )
      );
    } else {
      const key = `edit-grp-${pendingEdit[0].index}`;
      nodes.push(
        /* @__PURE__ */ jsx7(
          ToolEditGroupView,
          {
            activities: pendingEdit,
            messageId: message2.id,
            onReverted: (idx) => useStore.getState().markToolReverted(message2.id, idx)
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
      /* @__PURE__ */ jsx7("div", { className: "tool-trace", children: trace }, `trace-${traceAnchor}`)
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
          /* @__PURE__ */ jsx7(TraceNarration, { text: captions[0] }, `nar-${key}`)
        );
      }
      const { activity } = pending[0];
      trace.push(
        /* @__PURE__ */ jsx7(ToolSingleRow, { activity, messageId: message2.id }, key)
      );
    } else {
      trace.push(
        /* @__PURE__ */ jsx7(
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
      /* @__PURE__ */ jsx7("div", { className: "chat-message markdown-body", dir: "auto", children: /* @__PURE__ */ jsx7(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm],
          components: mdComponents,
          children: cachedPrepare(
            `${message2.id}:seg:${key}`,
            text,
            useStore.getState().dir
          )
        }
      ) }, key)
    );
  };
  const segs = message2.segments ?? [];
  segs.forEach((seg, i) => {
    if (seg.kind === "user") {
      flush();
      wrapTrace();
      flushEdits();
      const steerMsg = useStore.getState().chats.flatMap((c) => c.messages).find((m) => m.id === seg.id);
      if (steerMsg) {
        nodes.push(
          /* @__PURE__ */ jsx7(SegSteerBubble, { message: steerMsg, onRetry, onEdit, editingDisabled }, i)
        );
      }
      return;
    }
    if (seg.kind === "compact") {
      flush();
      wrapTrace();
      flushEdits();
      const summaryMsg = useStore.getState().chats.flatMap((c) => c.messages).find((m) => m.id === seg.id);
      if (summaryMsg) {
        nodes.push(/* @__PURE__ */ jsx7(SummaryBlock, { message: summaryMsg }, i));
      }
      return;
    }
    if (seg.kind === "text") {
      if (!seg.text.trim()) return;
      const next = segs[i + 1];
      const nextActivity = next && next.kind === "tool" ? message2.toolActivity?.[next.index] : void 0;
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
    const activity = message2.toolActivity?.[seg.index];
    if (!activity) return;
    if (isEditActivity(activity) && !isSubagentCard(activity)) {
      flush();
      wrapTrace();
      pendingEdit.push({ activity, index: seg.index });
      return;
    }
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool) || isSubagentCard(activity) && activity.tool !== "explore") {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        /* @__PURE__ */ jsx7(
          ToolCallView,
          {
            activity,
            messageId: message2.id,
            onReverted: () => useStore.getState().markToolReverted(message2.id, seg.index)
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
var preparedCache, PREPARED_CACHE_MAX, highlightCache, HIGHLIGHT_CACHE_MAX, CodeBlock, mdComponents, fmtTokens, ALWAYS_VISIBLE_TOOLS, USER_COLLAPSE_CHARS, USER_COLLAPSE_LINES, SummaryBlock, CAPTION_MAX_CHARS, CAPTION_MAX_LINES, ChatMessageView;
var init_ChatMessage = __esm({
  "src/components/ChatMessage.tsx"() {
    "use strict";
    init_bidi();
    init_clipboard();
    init_fileTypes();
    init_FileIcon();
    init_renderCap();
    init_time();
    init_api();
    init_tts();
    init_store();
    init_modes();
    init_sections();
    init_link();
    init_sanitizeHtml();
    init_ToolCallView();
    init_ReadingMode();
    init_Mermaid();
    init_MessageImages();
    init_css_stub();
    init_viewerTabs();
    init_planDoc();
    preparedCache = /* @__PURE__ */ new Map();
    PREPARED_CACHE_MAX = 400;
    highlightCache = /* @__PURE__ */ new Map();
    HIGHLIGHT_CACHE_MAX = 150;
    CodeBlock = memo2(function CodeBlock2(props) {
      const [copied, setCopied] = useState6(false);
      const chipProps = (() => {
        const kid = Array.isArray(props.children) ? props.children[0] : props.children;
        const p = kid && typeof kid === "object" && "props" in kid ? kid.props : void 0;
        return p && typeof p.path === "string" ? p : void 0;
      })();
      const code = (textFromChildren(props.children) || (chipProps ? String(chipProps.display ?? chipProps.path) : "")).replace(/^\n+|\n+$/g, "");
      const lang = codeLang(props.children);
      const startLine = codeStartLine(props.children);
      const filePath = codeFilePath(props.children);
      if (lang === "mermaid") {
        return /* @__PURE__ */ jsx7(Mermaid, { chart: code });
      }
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
      const highlightedLines = useMemo(
        () => getHighlightedLines(codeLines.join("\n"), lang),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [code, lang]
      );
      const lines = codeLines.map((_line, i) => {
        const num = startLine > 0 ? startLine + i : i + 1;
        const html2 = highlightedLines[i] ?? "";
        return /* @__PURE__ */ jsxs6("span", { className: "code-line", children: [
          /* @__PURE__ */ jsx7("span", { className: "code-gutter", "aria-hidden": "true", children: num }),
          /* @__PURE__ */ jsx7(
            "span",
            {
              className: "code-text",
              dangerouslySetInnerHTML: { __html: html2 === "" ? "\n" : html2 }
            }
          ),
          "\n"
        ] }, i);
      });
      return /* @__PURE__ */ jsxs6("div", { className: "code-block", children: [
        /* @__PURE__ */ jsxs6("div", { className: "code-block-head", children: [
          filePath && /* @__PURE__ */ jsxs6(
            "span",
            {
              className: "code-block-path code-block-path-open",
              title: `Open ${filePath}`,
              onClick: () => openWorkspaceFile(filePath),
              children: [
                /* @__PURE__ */ jsx7(FileIcon, { path: filePath, size: 20 }),
                filePath
              ]
            }
          ),
          /* @__PURE__ */ jsx7("span", { className: "code-block-lang", children: lang || "code" }),
          /* @__PURE__ */ jsx7("button", { className: "copy-btn", onClick: copy, children: copied ? "Copied \u2713" : "Copy" })
        ] }),
        /* @__PURE__ */ jsx7("pre", { ...props, dir: "ltr", className: "code-lines hljs", children: lines })
      ] });
    });
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
                return /* @__PURE__ */ jsx7(
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
              return /* @__PURE__ */ jsx7(Fragment5, { children: urlParts.map(
                (p, i) => typeof p === "string" ? /* @__PURE__ */ jsx7("code", { "data-meta": meta, children: p }, i) : /* @__PURE__ */ jsx7(
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
              ) });
            }
          }
          if (looksLikeFilePath(text)) {
            const { path, line } = splitPathLine(text);
            return /* @__PURE__ */ jsx7(FileChip, { path, line, display: text });
          }
          const parts = extractInlinePathParts(text);
          if (parts.some((p) => typeof p !== "string")) {
            return /* @__PURE__ */ jsx7("code", { ...props, "data-meta": meta, children: parts.map(
              (p, i) => typeof p === "string" ? p : /* @__PURE__ */ jsx7(FileChip, { path: p.path, line: p.line, display: p.display }, i)
            ) });
          }
        }
        return /* @__PURE__ */ jsx7("code", { ...props, "data-meta": meta, children: props.children });
      },
      img: (props) => /* @__PURE__ */ jsx7(MarkdownImage, { ...props }),
      a: (props) => {
        const href = props.href ?? "";
        const video = extractVideoEmbed(href);
        if (video) {
          return /* @__PURE__ */ jsx7(
            VideoThumbnailCard,
            {
              video,
              href,
              children: props.children
            }
          );
        }
        if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && isDocPath(href)) {
          const { path, line } = splitPathLine(href);
          const label = typeof props.children === "string" && props.children ? props.children : href;
          return /* @__PURE__ */ jsx7(FileChip, { path, line, display: String(label) });
        }
        return /* @__PURE__ */ jsx7(
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
      pre: (props) => /* @__PURE__ */ jsx7(CodeBlock, { ...props }),
      table: ({
        node: _node,
        ...props
      }) => /* @__PURE__ */ jsx7("div", { className: "markdown-table-scroll", children: /* @__PURE__ */ jsx7("table", { ...props }) })
    };
    fmtTokens = (n) => {
      if (!n) return "0";
      return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
    };
    ALWAYS_VISIBLE_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
    USER_COLLAPSE_CHARS = 600;
    USER_COLLAPSE_LINES = 10;
    SummaryBlock = memo2(function SummaryBlock2({ message: message2 }) {
      const dir = useStore((s) => s.dir);
      const content = message2.content || "";
      const open = () => useViewerTabs.getState().openText("Context summary", content);
      return /* @__PURE__ */ jsx7("div", { className: "summary-block collapsed", children: /* @__PURE__ */ jsxs6(
        "div",
        {
          className: "summary-head",
          onClick: open,
          role: "button",
          tabIndex: 0,
          title: "Open the full summary in the side panel",
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          },
          children: [
            /* @__PURE__ */ jsx7("span", { className: "summary-chevron", children: "\u25B6" }),
            /* @__PURE__ */ jsx7("span", { className: "summary-icon", children: "\u{1F4CE}" }),
            /* @__PURE__ */ jsx7("span", { className: "summary-label", children: "Context summary" }),
            content && /* @__PURE__ */ jsx7("span", { className: "summary-preview", dir: "auto", children: cachedPrepare(message2.id, content, dir) }),
            /* @__PURE__ */ jsx7("span", { className: "summary-hint", children: "earlier turns folded into this summary \u2014 click to open it" })
          ]
        }
      ) });
    });
    CAPTION_MAX_CHARS = 260;
    CAPTION_MAX_LINES = 2;
    ChatMessageView = memo2(
      function ChatMessageView2({
        message: message2,
        onRetry,
        onEdit,
        editingDisabled
      }) {
        const isUser = message2.role === "user";
        const dir = useStore((s) => s.dir);
        const modeLabelStr = useStore(
          (s) => message2.mode ? getMode(s.settings, message2.mode).label : ""
        );
        const [copied, setCopied] = useState6(false);
        const { status: ttsStatus, toggle: ttsToggle, stop: ttsStop } = useTtsPlayback();
        const modeLabel = (_id) => modeLabelStr;
        const copyMessage = async () => {
          try {
            await copyToClipboard(stripBidiMarks(fixZwsp(message2.content)));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (err) {
            console.warn("copy failed", err);
          }
        };
        const toggleSpeak = async () => {
          try {
            const prevChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message2.id))?.id;
            if (prevChatId) useStore.getState().setChatTtsError(prevChatId, null);
          } catch {
          }
          const st = useStore.getState();
          const liveVoice = st.liveVoiceState;
          if (liveVoice === "live" || liveVoice === "speaking" || liveVoice === "connecting") return;
          const providers = st.settings.providers ?? [];
          const toSpeakOpts = (provider, model, voice) => ({
            kind: provider.kind,
            baseUrl: provider.baseUrl ?? "",
            apiKeys: [...provider.apiKeys ?? (provider.apiKey ? [provider.apiKey] : [])],
            model,
            voice
          });
          const chain = [];
          const isLocalTts = st.ttsProviderId === "local";
          const primary = isLocalTts ? void 0 : providers.find((p) => p.id === st.ttsProviderId);
          if (primary) chain.push(toSpeakOpts(primary, st.ttsModel, st.ttsVoice));
          if (!isLocalTts) {
            for (const fb of st.ttsFallbacks ?? []) {
              const p = providers.find((x) => x.id === fb.providerId);
              if (!p) continue;
              chain.push(toSpeakOpts(p, fb.model, fb.voice));
            }
          }
          if (chain.length === 0 && !isLocalTts) {
            const msg = "\u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0635\u062F\u0627 \u0627\u0628\u062A\u062F\u0627 \u06CC\u06A9 \u067E\u0631\u0648\u0627\u06CC\u062F\u0631 TTS \u062F\u0631 \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u2190 \u0645\u062F\u0644\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F";
            const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message2.id))?.id;
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
            return;
          }
          const speakable = stripBidiMarks(fixZwsp(speakableMessageText(message2)));
          if (!speakable.trim()) {
            const msg = "\u0645\u062A\u0646 \u0642\u0627\u0628\u0644 \u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0646\u06CC\u0633\u062A";
            const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message2.id))?.id;
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
            return;
          }
          try {
            await ttsToggle(speakable, chain, { ttsProviderId: st.ttsProviderId, ttsModel: st.ttsModel, ttsBaseUrl: st.settings?.ttsBaseUrl, ttsVoice: st.ttsVoice });
          } catch (err) {
            const friendly = friendlyTtsError(err);
            if (!friendly) return;
            console.warn("speak failed", err);
            const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message2.id))?.id;
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, friendly);
          }
        };
        useEffect5(() => {
          if (message2.streaming) ttsStop();
        }, [message2.streaming, ttsStop]);
        useEffect5(() => () => ttsStop(), [ttsStop]);
        const isSummary = message2.role === "system" && !message2.modeSwitch;
        const isModeSwitch = message2.modeSwitch === true;
        const planDoc = !isUser && !isSummary ? message2.planDoc : void 0;
        const display = planDisplay(message2);
        const displayContent = display.content;
        const displaySegments = display.segments;
        const docPaths = useMemo(() => {
          const docs = docPathsFromActivities(message2.toolActivity);
          return dedupDocPaths(docs, message2.attachments ?? []);
        }, [message2.toolActivity, message2.attachments]);
        const cap = useCapped(message2.id, displayContent ?? "", !!message2.streaming);
        const [reading, setReading] = useState6(false);
        const sections = useMemo(
          () => !isUser && !isSummary ? splitSections(message2.content) : [],
          [message2.content, isUser, isSummary]
        );
        if (isModeSwitch) return null;
        if (message2.compacted) return null;
        if (isUser && message2.steerInterleaved) {
          const referenced = useStore.getState().chats.some(
            (c) => c.messages.some(
              (m) => (m.segments ?? []).some(
                (s) => s.kind === "user" && s.id === message2.id
              )
            )
          );
          if (referenced) return null;
        }
        if (message2.retry && !message2.content && !(message2.segments && message2.segments.length > 0)) {
          return null;
        }
        const roleLabel = isUser ? "You" : isSummary ? "Context summary" : message2.role === "tool" ? "Tools" : message2.mode ? modeLabel(message2.mode) : "Assistant";
        return /* @__PURE__ */ jsxs6(
          "div",
          {
            className: `msg ${isUser ? "user" : ""} ${message2.error ? "error" : ""}`,
            "data-msg-id": message2.id,
            "data-is-summary": isSummary ? "true" : void 0,
            children: [
              /* @__PURE__ */ jsxs6("div", { className: "msg-role", children: [
                isUser && /* @__PURE__ */ jsx7("span", { className: "msg-role-avatar", "aria-hidden": "true", children: /* @__PURE__ */ jsxs6(
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
                      /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "8", r: "4" }),
                      /* @__PURE__ */ jsx7("path", { d: "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" })
                    ]
                  }
                ) }),
                roleLabel
              ] }),
              !isUser && message2.plan && message2.plan.length > 0 && /* @__PURE__ */ jsxs6("div", { className: "plan-block", dir, children: [
                /* @__PURE__ */ jsxs6("div", { className: "plan-head", children: [
                  /* @__PURE__ */ jsx7("span", { className: "plan-dot", children: "\u25CE" }),
                  /* @__PURE__ */ jsx7("span", { className: "plan-label", children: "Plan" })
                ] }),
                /* @__PURE__ */ jsx7("ul", { className: "plan-list", children: message2.plan.map((item, i) => /* @__PURE__ */ jsxs6(
                  "li",
                  {
                    className: `plan-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : ""}`,
                    children: [
                      /* @__PURE__ */ jsx7("span", { className: "plan-item-mark", children: item.status === "completed" ? "\u2713" : item.status === "in_progress" ? "\u25CF" : "\u25CB" }),
                      /* @__PURE__ */ jsx7("span", { className: "plan-item-content", dir: "auto", children: cachedPrepare(`${message2.id}:plan:${i}`, item.content, dir) })
                    ]
                  },
                  i
                )) })
              ] }),
              !isUser && message2.attachments && message2.attachments.length > 0 && /* @__PURE__ */ jsx7("div", { className: "msg-attachments", dir: "ltr", children: message2.attachments.map((a) => /* @__PURE__ */ jsxs6(
                "span",
                {
                  className: "attachment-chip attachment-chip-open",
                  role: "button",
                  tabIndex: 0,
                  title: `${a} \u2014 open in the side panel`,
                  onClick: () => openWorkspaceFile(a),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openWorkspaceFile(a);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsx7(FileIcon, { path: a, size: 20 }),
                    attachmentBasename(a)
                  ]
                },
                a
              )) }),
              (isSummary || displayContent || displaySegments && displaySegments.length > 0) && (isModeSwitch ? /* @__PURE__ */ jsx7("div", { className: "mode-switch-note", dir: "ltr", children: cachedPrepare(message2.id, message2.content, "ltr") }) : isSummary ? /* @__PURE__ */ jsx7(SummaryBlock, { message: message2 }) : displaySegments && displaySegments.length > 0 ? (
                /* Claude-style interleaved rendering: text slices and tool cards follow
                   each other in the exact order the agent produced them, with runs of
                   2+ read-only tool calls collapsed into one summary (see renderSegments). */
                /* @__PURE__ */ jsx7("div", { className: "msg-bubble segmented", children: renderSegments(
                  { ...message2, segments: displaySegments },
                  onRetry,
                  onEdit,
                  editingDisabled
                ) })
              ) : isUser && message2.steerPending ? /* @__PURE__ */ jsxs6("div", { className: "queued-bubble steer", dir, children: [
                /* @__PURE__ */ jsxs6("div", { className: "queued-bubble-head", children: [
                  /* @__PURE__ */ jsx7("span", { className: "queued-bubble-icon", children: /* @__PURE__ */ jsxs6(
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
                        /* @__PURE__ */ jsx7("path", { d: "M9 14L4 9l5-5" }),
                        /* @__PURE__ */ jsx7("path", { d: "M4 9h10a5 5 0 015 5v6" })
                      ]
                    }
                  ) }),
                  /* @__PURE__ */ jsx7("span", { className: "queued-bubble-label", children: "Steering the running agent\u2026" }),
                  /* @__PURE__ */ jsx7("span", { className: "queued-bubble-pulse" }),
                  /* @__PURE__ */ jsx7(
                    "button",
                    {
                      className: "chip-x queued-bubble-x",
                      onClick: () => {
                        const s = useStore.getState();
                        const chat = s.chats.find(
                          (c) => c.messages.some((m) => m.id === message2.id)
                        );
                        if (!chat) return;
                        s.removeMessage(chat.id, message2.id);
                        void cancelSteer(chat.id, message2.id);
                      },
                      title: "Cancel steer \u2014 remove this message",
                      children: "\xD7"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx7(
                  QueuedCollapsibleText,
                  {
                    id: message2.id,
                    text: message2.content,
                    onEdit,
                    editingDisabled
                  }
                ),
                message2.attachments && message2.attachments.length > 0 && /* @__PURE__ */ jsx7("div", { className: "msg-attachments", dir: "ltr", children: message2.attachments.map((a) => /* @__PURE__ */ jsxs6(
                  "span",
                  {
                    className: "attachment-chip attachment-chip-open",
                    role: "button",
                    tabIndex: 0,
                    title: `${a} \u2014 open in the side panel`,
                    onClick: () => openWorkspaceFile(a),
                    onKeyDown: (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWorkspaceFile(a);
                      }
                    },
                    children: [
                      /* @__PURE__ */ jsx7(FileIcon, { path: a, size: 20 }),
                      attachmentBasename(a)
                    ]
                  },
                  a
                )) }),
                message2.images && message2.images.length > 0 && /* @__PURE__ */ jsx7(MessageImages, { images: message2.images })
              ] }) : isUser ? (
                /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
                   from the first strong char only, so a user message starting with
                   a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
                   72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
                   the rendered bubble identical to what the user typed. */
                /* @__PURE__ */ jsx7(UserMessageBubble, { message: message2, onRetry, onEdit, editingDisabled })
              ) : /* @__PURE__ */ jsxs6(Fragment5, { children: [
                /* @__PURE__ */ jsx7("div", { className: "msg-bubble", children: /* @__PURE__ */ jsx7("div", { className: "chat-message markdown-body", dir: "auto", children: /* @__PURE__ */ jsx7(
                  ReactMarkdown,
                  {
                    remarkPlugins: [remarkGfm],
                    components: mdComponents,
                    children: cachedPrepare(message2.id, cap.shown, dir)
                  }
                ) }) }),
                cap.over && /* @__PURE__ */ jsxs6(
                  "button",
                  {
                    className: "msg-expand",
                    onClick: () => useViewerTabs.getState().openText(
                      textTabTitle(displayContent ?? message2.content, "Reply"),
                      displayContent ?? message2.content
                    ),
                    title: `Full reply is ${fmtSize((displayContent ?? "").length)} \u2014 opens in the side panel`,
                    children: [
                      "Show all (",
                      fmtSize(cap.cut),
                      " more)"
                    ]
                  }
                )
              ] })),
              !isUser && docPaths.length > 0 && /* @__PURE__ */ jsx7(DocFileChips, { paths: docPaths }),
              !isUser && planDoc && /* @__PURE__ */ jsx7(PlanDocCard, { planDoc }),
              !isUser && message2.autoSkills && message2.autoSkills.length > 0 && /* @__PURE__ */ jsx7("div", { className: "msg-attachments", dir: "ltr", children: message2.autoSkills.map((sk) => /* @__PURE__ */ jsxs6(
                "span",
                {
                  className: "attachment-chip",
                  title: "Auto-loaded skill \u2014 picked by the decision model for this turn",
                  children: [
                    "\u26A1 ",
                    sk
                  ]
                },
                `autoskill-${sk}`
              )) }),
              !isUser && message2.interrupted && /* @__PURE__ */ jsx7("div", { className: "msg-interrupted", dir: "auto", children: "\u26A0\uFE0F Interrupted \u2014 this reply was cut off (e.g. power loss). Send \u201Ccontinue\u201D to resume." }),
              !isUser && (message2.content || message2.usage || message2.streaming || message2.turnElapsedMs != null) && /* @__PURE__ */ jsxs6("div", { className: "msg-actions", children: [
                message2.usage && /* @__PURE__ */ jsx7(
                  UsageBadge,
                  {
                    input: message2.usage.inputTokens,
                    output: message2.usage.outputTokens,
                    total: message2.usage.totalTokens
                  }
                ),
                message2.content && /* @__PURE__ */ jsxs6(Fragment5, { children: [
                  /* @__PURE__ */ jsx7(
                    "button",
                    {
                      className: `msg-copy ${copied ? "copied" : ""}`,
                      onClick: copyMessage,
                      title: copied ? "Copied" : "Copy message",
                      "aria-label": copied ? "Copied" : "Copy message",
                      children: copied ? /* @__PURE__ */ jsx7(
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
                          children: /* @__PURE__ */ jsx7("path", { d: "M20 6 9 17l-5-5" })
                        }
                      ) : /* @__PURE__ */ jsxs6(
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
                            /* @__PURE__ */ jsx7("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                            /* @__PURE__ */ jsx7("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                          ]
                        }
                      )
                    }
                  ),
                  /* @__PURE__ */ jsx7(
                    "button",
                    {
                      className: "msg-copy msg-fork",
                      onClick: () => useStore.getState().forkChatFromMessage(message2.id),
                      title: "Fork chat from here",
                      "aria-label": "Fork chat from here",
                      children: /* @__PURE__ */ jsxs6(
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
                            /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "18", r: "3" }),
                            /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "6", r: "3" }),
                            /* @__PURE__ */ jsx7("circle", { cx: "18", cy: "6", r: "3" }),
                            /* @__PURE__ */ jsx7("path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }),
                            /* @__PURE__ */ jsx7("path", { d: "M12 12v3" })
                          ]
                        }
                      )
                    }
                  ),
                  !isUser && !message2.streaming && /* @__PURE__ */ jsx7(
                    "button",
                    {
                      className: `msg-copy msg-speak ${ttsStatus === "speaking" ? "speaking" : ""} ${ttsStatus === "loading" ? "loading" : ""} ${ttsStatus === "paused" ? "paused" : ""}`,
                      onClick: toggleSpeak,
                      title: ttsStatus === "speaking" ? "\u062A\u0648\u0642\u0641 \u0645\u0648\u0642\u062A" : ttsStatus === "paused" ? "\u0627\u062F\u0627\u0645\u0647 \u067E\u062E\u0634" : ttsStatus === "loading" ? "\u0644\u063A\u0648" : "\u062E\u0648\u0627\u0646\u062F\u0646 \u0628\u0627 \u0635\u062F\u0627",
                      "aria-label": ttsStatus === "speaking" ? "Pause" : ttsStatus === "paused" ? "Resume" : ttsStatus === "loading" ? "Cancel" : "Speak",
                      children: ttsStatus === "loading" ? /* @__PURE__ */ jsx7(
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
                          children: /* @__PURE__ */ jsx7("path", { d: "M21 12a9 9 0 1 1-6.2-8.56" })
                        }
                      ) : ttsStatus === "speaking" ? /* @__PURE__ */ jsx7(
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
                          children: /* @__PURE__ */ jsx7("path", { d: "M9 5v14M15 5v14" })
                        }
                      ) : ttsStatus === "paused" ? /* @__PURE__ */ jsx7(
                        "svg",
                        {
                          width: "16",
                          height: "16",
                          viewBox: "0 0 24 24",
                          fill: "currentColor",
                          children: /* @__PURE__ */ jsx7("path", { d: "M8 5v14l11-7z" })
                        }
                      ) : /* @__PURE__ */ jsxs6(
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
                            /* @__PURE__ */ jsx7("polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }),
                            /* @__PURE__ */ jsx7("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" })
                          ]
                        }
                      )
                    }
                  ),
                  !isUser && !isSummary && !message2.streaming && sections.length >= 2 && /* @__PURE__ */ jsx7(
                    "button",
                    {
                      className: "msg-copy",
                      onClick: () => setReading(true),
                      title: "Reading mode \u2014 study each section separately and ask about it",
                      "aria-label": "Read",
                      children: /* @__PURE__ */ jsxs6(
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
                            /* @__PURE__ */ jsx7("path", { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" }),
                            /* @__PURE__ */ jsx7("path", { d: "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" })
                          ]
                        }
                      )
                    }
                  )
                ] }),
                message2.streaming && (message2.thinkingActive ? /* @__PURE__ */ jsx7(ThinkingIndicator, { startedAt: message2.thinkingStartedAt }) : /* @__PURE__ */ jsx7(
                  ThinkingIndicator,
                  {
                    label: (() => {
                      const lsp = lspStatusLabel(message2.lspStatus);
                      if (lsp) return lsp;
                      return message2.statusText ? `Working \xB7 ${message2.statusText}` : "Working";
                    })(),
                    startedAt: message2.workingStartedAt
                  }
                )),
                !message2.streaming && message2.turnElapsedMs != null && /* @__PURE__ */ jsxs6(
                  "span",
                  {
                    className: "msg-elapsed msg-elapsed-far",
                    title: `Working time for this turn: ${fmtElapsed(message2.turnElapsedMs)}`,
                    children: [
                      /* @__PURE__ */ jsx7("span", { dir: "ltr", children: fmtElapsed(message2.turnElapsedMs) }),
                      /* @__PURE__ */ jsxs6(
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
                          "aria-hidden": "true",
                          children: [
                            /* @__PURE__ */ jsx7("line", { x1: "10", x2: "14", y1: "2", y2: "2" }),
                            /* @__PURE__ */ jsx7("line", { x1: "12", x2: "15", y1: "14", y2: "11" }),
                            /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "14", r: "8" })
                          ]
                        }
                      )
                    ]
                  }
                ),
                !message2.streaming && /* @__PURE__ */ jsxs6(
                  "span",
                  {
                    className: `msg-time${message2.turnElapsedMs == null ? " msg-time-far" : ""}`,
                    title: fmtClockFull(message2.createdAt),
                    children: [
                      /* @__PURE__ */ jsx7("span", { dir: "ltr", children: fmtClock(message2.createdAt) }),
                      /* @__PURE__ */ jsxs6(
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
                          "aria-hidden": "true",
                          children: [
                            /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "12", r: "10" }),
                            /* @__PURE__ */ jsx7("polyline", { points: "12 6 12 12 16 14" })
                          ]
                        }
                      )
                    ]
                  }
                )
              ] }),
              reading && /* @__PURE__ */ jsx7(ReadingMode, { message: message2, onClose: () => setReading(false) })
            ]
          }
        );
      },
      // Custom comparator: every streamed token rebuilds the active chat object,
      // so the parent re-renders with a fresh `chat.messages` array. Unchanged
      // messages keep their object identity (see updateMessage) and skip via the
      // fast path; the field-wise fallback also skips when the store recreates an
      // identical record. Only a real content/state change re-parses markdown.
      (prev, next) => {
        if (prev.onRetry !== next.onRetry) return false;
        if (prev.onEdit !== next.onEdit) return false;
        if (prev.editingDisabled !== next.editingDisabled) return false;
        const a = prev.message;
        const b = next.message;
        if (a === b) return true;
        return a.id === b.id && a.role === b.role && a.content === b.content && a.streaming === b.streaming && a.thinking === b.thinking && a.thinkingActive === b.thinkingActive && a.thinkingStartedAt === b.thinkingStartedAt && a.workingStartedAt === b.workingStartedAt && a.turnElapsedMs === b.turnElapsedMs && a.error === b.error && a.retry === b.retry && a.toolActivity === b.toolActivity && a.segments === b.segments && a.plan === b.plan && a.planDoc === b.planDoc && a.attachments === b.attachments && a.images === b.images && a.usage === b.usage && a.compacted === b.compacted && a.mode === b.mode && a.modeSwitch === b.modeSwitch && a.steerPending === b.steerPending && a.steerInterleaved === b.steerInterleaved && a.statusText === b.statusText && a.lspStatus === b.lspStatus && a.interrupted === b.interrupted;
      }
    );
  }
});

// src/lib/shortcuts.ts
function physicalKey(e) {
  const c = e.code || "";
  if (c.startsWith("Key")) return c.slice(3).toLowerCase();
  if (c === "Comma") return ",";
  if (c === "Slash") return "/";
  return (e.key || "").toLowerCase();
}
var init_shortcuts = __esm({
  "src/lib/shortcuts.ts"() {
    "use strict";
  }
});

// src/components/ReadingMode.tsx
var ReadingMode_exports = {};
__export(ReadingMode_exports, {
  ReadingMode: () => ReadingMode
});
import { useEffect as useEffect6, useMemo as useMemo2, useRef as useRef6, useState as useState7 } from "react";
import { createPortal as createPortal3 } from "react-dom";
import ReactMarkdown2 from "react-markdown";
import remarkGfm2 from "remark-gfm";
import { Fragment as Fragment6, jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
function ReadingMode({
  message: message2,
  onClose
}) {
  const dir = useStore((s) => s.dir);
  const sections = useMemo2(() => splitSections(message2.content), [message2.content]);
  const [active, setActive] = useState7(0);
  const [copied, setCopied] = useState7(false);
  const [progress, setProgress] = useState7(0);
  const [width, setWidth] = useState7(() => {
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
  useEffect6(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const contentRef = useRef6(null);
  useEffect6(() => {
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
  useEffect6(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [active]);
  useEffect6(() => {
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
  const copy = async () => {
    try {
      await copyToClipboard(section.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  const dragCleanup = useRef6(null);
  useEffect6(() => {
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
  const panel = /* @__PURE__ */ jsxs7(
    "div",
    {
      className: "reading-mode",
      dir,
      style: { "--reading-w": `${width}px` },
      onClick: (e) => e.stopPropagation(),
      children: [
        /* @__PURE__ */ jsx8("div", { className: "reading-mode-scrim", "aria-hidden": "true", onClick: onClose }),
        /* @__PURE__ */ jsxs7(
          "div",
          {
            className: "reading-mode-panel",
            role: "dialog",
            "aria-modal": "false",
            "aria-label": "Reading mode",
            children: [
              /* @__PURE__ */ jsx8(
                "div",
                {
                  className: "reading-mode-resize-handle",
                  title: "Drag to resize",
                  onMouseDown: startResize
                }
              ),
              /* @__PURE__ */ jsxs7("div", { className: "reading-mode-head", children: [
                /* @__PURE__ */ jsxs7("div", { className: "reading-mode-title", children: [
                  /* @__PURE__ */ jsx8("h2", { children: "Reading Mode" }),
                  /* @__PURE__ */ jsxs7("span", { className: "reading-mode-tab", children: [
                    "Section ",
                    active + 1,
                    " of ",
                    sections.length
                  ] })
                ] }),
                /* @__PURE__ */ jsxs7("div", { className: "reading-mode-head-actions", children: [
                  /* @__PURE__ */ jsx8(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.max(a - 1, 0)),
                      disabled: active === 0,
                      title: "Previous section (\u2191)",
                      "aria-label": "Previous section",
                      children: /* @__PURE__ */ jsx8(ChevronUpIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx8(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.min(a + 1, sections.length - 1)),
                      disabled: active === sections.length - 1,
                      title: "Next section (\u2193)",
                      "aria-label": "Next section",
                      children: /* @__PURE__ */ jsx8(ChevronDownIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx8(
                    "button",
                    {
                      className: `reading-mode-copy${copied ? " copied" : ""}`,
                      onClick: copy,
                      title: "Copy section text",
                      children: copied ? /* @__PURE__ */ jsxs7(Fragment6, { children: [
                        /* @__PURE__ */ jsx8(
                          "svg",
                          {
                            width: "13",
                            height: "13",
                            viewBox: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: "2.5",
                            strokeLinecap: "round",
                            strokeLinejoin: "round",
                            "aria-hidden": "true",
                            children: /* @__PURE__ */ jsx8("path", { d: "M20 6 9 17l-5-5" })
                          }
                        ),
                        "Copied"
                      ] }) : /* @__PURE__ */ jsxs7(Fragment6, { children: [
                        /* @__PURE__ */ jsxs7(
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
                            "aria-hidden": "true",
                            children: [
                              /* @__PURE__ */ jsx8("rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }),
                              /* @__PURE__ */ jsx8("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" })
                            ]
                          }
                        ),
                        "Copy"
                      ] })
                    }
                  ),
                  /* @__PURE__ */ jsx8(
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
              /* @__PURE__ */ jsx8("div", { className: "reading-mode-progress", "aria-hidden": "true", children: /* @__PURE__ */ jsx8("span", { style: { width: `${progress * 100}%` } }) }),
              /* @__PURE__ */ jsxs7("div", { className: "reading-mode-body", children: [
                /* @__PURE__ */ jsxs7("div", { className: "reading-mode-list", children: [
                  /* @__PURE__ */ jsxs7("div", { className: "reading-mode-list-label", children: [
                    "Contents",
                    /* @__PURE__ */ jsx8("span", { className: "reading-mode-list-count", children: sections.length })
                  ] }),
                  sections.map((s, i) => /* @__PURE__ */ jsxs7(
                    "div",
                    {
                      className: `reading-mode-item${i === active ? " active" : ""}`,
                      style: { "--i": i },
                      "aria-current": i === active ? "true" : void 0,
                      children: [
                        /* @__PURE__ */ jsx8("span", { className: "reading-mode-item-num", children: i + 1 }),
                        /* @__PURE__ */ jsx8(
                          "button",
                          {
                            className: "reading-mode-item-title",
                            onClick: () => setActive(i),
                            title: s.title,
                            dir,
                            children: /* @__PURE__ */ jsx8(
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
                /* @__PURE__ */ jsxs7("div", { className: "reading-mode-content", ref: contentRef, children: [
                  /* @__PURE__ */ jsx8("div", { className: "reading-mode-content-head", children: /* @__PURE__ */ jsxs7("div", { className: "reading-mode-content-title", children: [
                    /* @__PURE__ */ jsx8("span", { className: "reading-mode-content-num", children: active + 1 }),
                    /* @__PURE__ */ jsx8("h3", { dir, children: section.title })
                  ] }) }),
                  /* @__PURE__ */ jsx8("div", { className: "reading-mode-content-inner", children: /* @__PURE__ */ jsx8("div", { className: "chat-message markdown-body", dir, children: /* @__PURE__ */ jsx8(
                    ReactMarkdown2,
                    {
                      remarkPlugins: [remarkGfm2],
                      components: mdComponents,
                      children: prepareContent(section.content, dir)
                    }
                  ) }) }, active)
                ] })
              ] }),
              /* @__PURE__ */ jsxs7("div", { className: "reading-mode-foot", children: [
                /* @__PURE__ */ jsxs7("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx8("kbd", { children: "\u2191" }),
                  " ",
                  /* @__PURE__ */ jsx8("kbd", { children: "\u2193" }),
                  " navigate sections"
                ] }),
                /* @__PURE__ */ jsxs7("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx8("kbd", { children: "Esc" }),
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
  return createPortal3(panel, document.body);
}
var ChevronUpIcon, ChevronDownIcon;
var init_ReadingMode = __esm({
  "src/components/ReadingMode.tsx"() {
    "use strict";
    init_ChatMessage();
    init_sections();
    init_store();
    init_bidi();
    init_clipboard();
    init_shortcuts();
    init_css_stub();
    ChevronUpIcon = () => /* @__PURE__ */ jsx8(
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
        children: /* @__PURE__ */ jsx8("path", { d: "m18 15-6-6-6 6" })
      }
    );
    ChevronDownIcon = () => /* @__PURE__ */ jsx8(
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
        children: /* @__PURE__ */ jsx8("path", { d: "m6 9 6 6 6-6" })
      }
    );
  }
});

// tests/readingMode.ssr.test.tsx
import { jsx as jsx9 } from "react/jsx-runtime";
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
var { ReadingMode: ReadingMode2 } = await Promise.resolve().then(() => (init_ReadingMode(), ReadingMode_exports));
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
var message = {
  id: "m1",
  role: "assistant",
  content: "## \u0628\u062E\u0634 \u0627\u0644\u0641\n\n\u0645\u062A\u0646 \u0627\u0644\u0641\n\n## \u0628\u062E\u0634 \u0628\n\n\u0645\u062A\u0646 \u0628",
  createdAt: Date.now()
};
console.log("1) \u0631\u0646\u062F\u0631 SSR \u0628\u062F\u0648\u0646 \u062E\u0637\u0627:");
var html = "";
try {
  html = renderToString(/* @__PURE__ */ jsx9(ReadingMode2, { message, onClose: () => {
  } }));
  check("\u0631\u0646\u062F\u0631 \u0634\u062F", html.length > 0);
} catch (e) {
  check("\u0631\u0646\u062F\u0631 \u0634\u062F", false, e);
}
console.log("2) \u0645\u062D\u062A\u0648\u0627\u06CC \u0645\u0648\u062F\u0627\u0644 \u062F\u0631\u0633\u062A \u0627\u0633\u062A:");
check("\u062A\u06CC\u062A\u0631 \u0628\u062E\u0634 \u0627\u0648\u0644 \u062F\u0631 \u0641\u0647\u0631\u0633\u062A", html.includes("\u0628\u062E\u0634 \u0627\u0644\u0641"), html.slice(0, 400));
check("\u062A\u06CC\u062A\u0631 \u0628\u062E\u0634 \u062F\u0648\u0645 \u062F\u0631 \u0641\u0647\u0631\u0633\u062A", html.includes("\u0628\u062E\u0634 \u0628"));
check("\u0645\u062A\u0646 \u0628\u062E\u0634 \u0641\u0639\u0627\u0644 \u0631\u0646\u062F\u0631 \u0634\u062F\u0647", html.includes("\u0645\u062A\u0646 \u0627\u0644\u0641"));
check("\u062F\u06A9\u0645\u0647 \u0633\u0648\u0627\u0644 \u062D\u0630\u0641 \u0634\u062F\u0647", !html.includes("Ask about this section"));
check("\u06A9\u0644\u0627\u0633 \u0645\u0648\u062F\u0627\u0644", html.includes("reading-mode"));
check(
  "\u062F\u0633\u062A\u06AF\u06CC\u0631\u0647 \u062F\u0631\u06AF \u062F\u0627\u062E\u0644 \u067E\u0646\u0644 \u0627\u0633\u062A (\u0644\u0628\u0647 \u0686\u067E \u067E\u0646\u0644 \u0631\u0627\u0633\u062A\u200C\u0686\u0633\u0628\u06CC\u062F\u0647 \u0631\u0627 \u062F\u0646\u0628\u0627\u0644 \u0645\u06CC\u200C\u06A9\u0646\u062F)",
  html.indexOf("reading-mode-scrim") < html.indexOf("reading-mode-panel") && html.indexOf("reading-mode-panel") < html.indexOf("reading-mode-resize-handle"),
  html.slice(0, 600)
);
console.log("3) \u067E\u06CC\u0627\u0645 \u0628\u062F\u0648\u0646 \u0628\u062E\u0634 \u2192 null (\u0628\u062F\u0648\u0646 \u062E\u0637\u0627):");
try {
  const empty = renderToString(
    /* @__PURE__ */ jsx9(ReadingMode2, { message: { id: "m2", role: "assistant", content: "\u0628\u062F\u0648\u0646 \u062A\u06CC\u062A\u0631", createdAt: Date.now() }, onClose: () => {
    } })
  );
  check("\u062E\u0631\u0648\u062C\u06CC \u062E\u0627\u0644\u06CC \u0627\u0633\u062A", empty === "");
} catch (e) {
  check("\u062E\u0631\u0648\u062C\u06CC \u062E\u0627\u0644\u06CC \u0627\u0633\u062A", false, e);
}
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
