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

// src/lib/fs.ts
async function workspaceFiles(root) {
  const hit = workspaceCache.get(root);
  if (hit && Date.now() - hit.at < WORKSPACE_CACHE_TTL_MS) return hit.files;
  const walked = await api.fsWalk(root).catch(() => null);
  const files = Array.isArray(walked) ? walked : await fallbackWalk(root);
  workspaceCache.set(root, { at: Date.now(), files });
  if (workspaceCache.size > 20) {
    const oldest = workspaceCache.keys().next().value;
    if (oldest !== void 0) workspaceCache.delete(oldest);
  }
  return files;
}
async function fallbackWalk(root) {
  const out = [];
  const stack = [""];
  while (stack.length > 0 && out.length < MAX_INDEXED) {
    const rel = stack.pop();
    const entries = await api.fsList(root, rel).catch(() => []) ?? [];
    for (const e of entries) {
      if (e.kind === "dir") {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(e.path);
      } else {
        out.push({ rel: e.path, name: e.name });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}
function normPath(p) {
  return p.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}
function resolveWorkspacePath(target, files) {
  const clean = normPath(target);
  const base = clean.split("/").pop() ?? clean;
  if (!base) return null;
  if (!Array.isArray(files)) return null;
  const exact = files.find((f) => f.name === base);
  if (exact) return exact;
  return suggestSimilarFiles(clean, files, 1)[0] ?? null;
}
function suggestSimilarFiles(targetRel, files, limit = 8) {
  const norm = normPath;
  const target = norm(targetRel);
  if (!target) return [];
  if (!Array.isArray(files)) return [];
  const base = target.split("/").pop() ?? target;
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  const scored = [];
  for (const f of files) {
    const rel = norm(f.rel);
    if (!rel || rel === target) continue;
    const fb = rel.split("/").pop() ?? rel;
    const fdot = fb.lastIndexOf(".");
    const fstem = (fdot > 0 ? fb.slice(0, fdot) : fb).toLowerCase();
    const fext = fdot > 0 ? fb.slice(fdot).toLowerCase() : "";
    const fdir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    let score = 0;
    if (fb.toLowerCase() === base.toLowerCase()) score = 100;
    else if (fdir === dir) score = 60;
    else if (ext && fext === ext && stem.length >= 3 && (fstem.startsWith(stem.slice(0, 3)) || stem.startsWith(fstem.slice(0, 3))))
      score = 40;
    if (score > 0) scored.push({ file: { rel, name: f.name }, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
  return scored.slice(0, limit).map((s) => s.file);
}
var api, SKIP_DIRS, MAX_INDEXED, WORKSPACE_CACHE_TTL_MS, workspaceCache;
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
      captureRegion: () => window.coder.captureRegion(),
      getPathForFile: (file) => window.coder.getPathForFile(file),
      storeGet: (key) => window.coder.storeGet(key),
      storeSet: (key, value) => window.coder.storeSet(key, value),
      chatGet: (id) => window.coder.chatGet(id),
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
    SKIP_DIRS = /* @__PURE__ */ new Set([
      "node_modules",
      ".git",
      ".venv",
      "venv",
      "__pycache__",
      "dist",
      "release",
      "build",
      "coverage",
      ".idea",
      ".vscode",
      ".next",
      "out",
      "target",
      "node_modules/.cache",
      "vendor",
      ".ruff_cache",
      ".github",
      ".playwright",
      ".playwright-mcp"
    ]);
    MAX_INDEXED = 800;
    WORKSPACE_CACHE_TTL_MS = 1e4;
    workspaceCache = /* @__PURE__ */ new Map();
  }
});

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

// src/lib/historyWindow.ts
var init_historyWindow = __esm({
  "src/lib/historyWindow.ts"() {
    "use strict";
  }
});

// src/lib/context.ts
function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
function modelReasoning(provider, model) {
  if (!provider) return null;
  const manual = provider.manualReasoningMap ?? {};
  const directManual = manual[model];
  if (typeof directManual === "boolean") return directManual;
  const prefixedManual = manual[`${provider.id ?? ""}/${model}`];
  if (typeof prefixedManual === "boolean") return prefixedManual;
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
    let timer;
    try {
      const url = await Promise.race([
        api.getSidecarUrl(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), SIDECAR_RESOLVE_TIMEOUT_MS);
        })
      ]);
      if (url) sidecarUrl = url;
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
async function fetchPlan(root, chatId) {
  const url = await ensureSidecar();
  if (!url) return null;
  try {
    const res = await fetch(
      `${url}/plan?root=${encodeURIComponent(root)}&chat_id=${encodeURIComponent(chatId)}`,
      { signal: AbortSignal.timeout(5e3) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
async function readDocumentText(root, absPath, format = "text", opts) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not running" };
  try {
    const res = await fetch(`${url}/doc/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root,
        path: absPath,
        format,
        sheet: opts?.sheet ?? "",
        pages: opts?.pages ?? ""
      })
    });
    if (!res.ok) return { error: `document read failed (${res.status})` };
    return await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
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
async function readApiError(res, fallback) {
  const text = await res.text().catch(() => "");
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.detail || parsed?.error;
    if (msg) return msg;
  } catch {
  }
  return text;
}
async function sidecarGet(path) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) {
      return { error: await readApiError(res, `request failed (${res.status})`) };
    }
    return await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function gitStatus(root) {
  return sidecarGet(`/git/status?root=${encodeURIComponent(root)}`);
}
async function gitDiff(root, path = "", staged = false) {
  const q = new URLSearchParams({ root, path, staged: String(staged) });
  return sidecarGet(`/git/diff?${q.toString()}`);
}
async function gitLog(root, limit = 20) {
  const q = new URLSearchParams({ root, limit: String(limit) });
  return sidecarGet(`/git/log?${q.toString()}`);
}
async function gitShow(root, rev = "HEAD", path = "") {
  const q = new URLSearchParams({ root, rev, path });
  return sidecarGet(`/git/show?${q.toString()}`);
}
async function listSchedules() {
  const out = await sidecarGet("/schedules");
  if ("error" in out) return out;
  return out.schedules ?? [];
}
async function listScheduleRuns(id, limit = 20) {
  const out = await sidecarGet(
    `/schedules/${encodeURIComponent(id)}/runs?limit=${limit}`
  );
  if ("error" in out) return out;
  return out.runs ?? [];
}
async function clearScheduleRuns(id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}/runs`, { method: "DELETE" });
    if (!res.ok) {
      const body2 = await res.json().catch(() => ({}));
      return { error: body2.detail || `clear failed (${res.status})` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, removed: typeof body.removed === "number" ? body.removed : 0 };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function clearOrphanScheduleRuns() {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}/schedule-runs/orphans`, { method: "DELETE" });
    if (!res.ok) {
      const body2 = await res.json().catch(() => ({}));
      return { error: body2.detail || `clear failed (${res.status})` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, removed: typeof body.removed === "number" ? body.removed : 0 };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function getChatTraces(chatId, kind, taskId, page) {
  if (!chatId) return { traces: [], total: 0, counts: { all: 0, llm: 0, prompt: 0, tool: 0, fold: 0 } };
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (taskId) params.set("task_id", taskId);
  if (page?.limit != null) params.set("limit", String(page.limit));
  if (page?.before != null) params.set("before", String(page.before));
  if (page?.sub) params.set("sub", "true");
  const qs = params.toString();
  const out = await sidecarGet(`/chats/${encodeURIComponent(chatId)}/traces${qs ? `?${qs}` : ""}`);
  if ("error" in out) return out;
  const traces = out.traces ?? [];
  return {
    traces,
    // An older backend (or a cached response) omits the totals: fall back to
    // what this page can prove, so "load older" still works honestly.
    total: typeof out.total === "number" ? out.total : traces.length,
    counts: {
      all: out.counts?.all ?? traces.length,
      llm: out.counts?.llm ?? 0,
      prompt: out.counts?.prompt ?? 0,
      tool: out.counts?.tool ?? 0,
      fold: out.counts?.fold ?? 0
    }
  };
}
async function clearChatTraces(chatId) {
  const url = await ensureSidecar();
  if (!url || !chatId) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}/chats/${encodeURIComponent(chatId)}/traces`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.detail || `clear failed (${res.status})` };
    }
    return await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function listAllScheduleRuns(limit = 50) {
  const out = await sidecarGet(
    `/schedule-runs?limit=${limit}`
  );
  if ("error" in out) return out;
  return out.runs ?? [];
}
var sidecarUrl, sidecarInFlight, SIDECAR_RESOLVE_TIMEOUT_MS;
var init_api = __esm({
  "src/lib/api.ts"() {
    "use strict";
    init_fs();
    init_context();
    sidecarUrl = null;
    sidecarInFlight = null;
    SIDECAR_RESOLVE_TIMEOUT_MS = 1e4;
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
    DEFAULT_THEME = "rose-pine";
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

// src/lib/toolActivity.ts
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
function aggregateTurnStats(activities) {
  let adds = 0;
  let dels = 0;
  const walk = (list) => {
    for (const a of list) {
      if ((a.tool === "edit_file" || a.tool === "write_file") && a.diff) {
        const s = a.diffStats ?? diffStatsFromUnified(a.diff);
        adds += s.adds;
        dels += s.dels;
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  return { adds, dels };
}
function normalizeToolName(tool) {
  const t = tool ?? "tool";
  return t === "task" || t === "subagent" ? "explore" : t;
}
function normalizeToolActivity(acts) {
  return acts.map((a) => {
    const out = a.tool === "explore" ? a : { ...a, tool: normalizeToolName(a.tool) };
    if (Array.isArray(out.children)) out.children = normalizeToolActivity(out.children);
    return out;
  });
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
function pathOnlyItems(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((row) => {
    if (!row || typeof row !== "object") return false;
    const r = row;
    const body = r.content ?? r.snippet ?? r.text ?? r.title ?? r.url ?? r.path;
    return body === void 0 || body === null || String(body) === "";
  });
}
function toolCallBody(activity) {
  const parts = [];
  const items = activity.items ?? activity.results;
  if (!(activity.resultText && pathOnlyItems(items))) {
    const out = terminalOutputText(items);
    if (out) parts.push(out);
  }
  if (activity.diff) parts.push(activity.diff);
  if (activity.resultText) parts.push(activity.resultText);
  return parts.join("\n\n");
}
var init_toolActivity = __esm({
  "src/lib/toolActivity.ts"() {
    "use strict";
    init_mcpTools();
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
  const base = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root;
  if (!base) return makeLeaf(dragChatId, dragSize);
  const target = findLeafByChat(base, targetChatId);
  if (!target) return appendChat(base, dragChatId, dirNeeded);
  const fresh = makeLeaf(dragChatId, dragSize);
  const parent = findParent(base, target.id);
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c2) => c2.id === target.id);
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
var store_exports = {};
__export(store_exports, {
  DEFAULT_TERMINAL_HEIGHT: () => DEFAULT_TERMINAL_HEIGHT,
  MAX_COMPACTED_PER_CHAT: () => MAX_COMPACTED_PER_CHAT,
  MAX_PINNED_RECENT_MODELS: () => MAX_PINNED_RECENT_MODELS,
  MAX_SCHEDULE_RUNS_SEEN: () => MAX_SCHEDULE_RUNS_SEEN,
  MIN_PANE_CONTENT_HEIGHT: () => MIN_PANE_CONTENT_HEIGHT,
  MIN_TERMINAL_HEIGHT: () => MIN_TERMINAL_HEIGHT,
  PROVIDER_NAMES: () => PROVIDER_NAMES,
  TITLE_MAX_WORDS: () => TITLE_MAX_WORDS,
  capCompactedMessages: () => capCompactedMessages,
  capTitleWords: () => capTitleWords,
  clampTerminalHeight: () => clampTerminalHeight,
  dedupeChats: () => dedupeChats,
  ensureChatHydrated: () => ensureChatHydrated,
  flushStateNow: () => flushStateNow,
  getActiveChat: () => getActiveChat,
  getActiveMode: () => getActiveMode,
  getActiveProvider: () => getActiveProvider,
  getChatProvider: () => getChatProvider,
  isChatBodyReady: () => isChatBodyReady,
  lspStatusFromEvent: () => lspStatusFromEvent,
  lspStatusLabel: () => lspStatusLabel,
  normalizeChatLayout: () => normalizeChatLayout,
  normalizeScheduleRunsSeen: () => normalizeScheduleRunsSeen,
  normalizeVisibleChats: () => normalizeVisibleChats,
  providerApiKeys: () => providerApiKeys,
  pruneQueued: () => pruneQueued,
  registerChatDeleteHook: () => registerChatDeleteHook,
  resolveTerminalDockHeight: () => resolveTerminalDockHeight,
  resolveTerminalPlacement: () => resolveTerminalPlacement,
  sanitizeChats: () => sanitizeChats,
  sanitizeImageDataUrl: () => sanitizeImageDataUrl,
  selectLoadedChats: () => selectLoadedChats,
  sortRecentModels: () => sortRecentModels,
  useStore: () => useStore,
  workspaceKey: () => workspaceKey
});
import { create } from "zustand";
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
function lspStatusFromEvent(ev) {
  const stage = (ev.stage ?? "").trim().toLowerCase();
  const tool = (ev.tool ?? "").trim().toLowerCase();
  const isLsp = stage === "lsp" || tool === "lsp" || tool.startsWith("lsp_");
  if (!isLsp) return null;
  const text = `${ev.summary ?? ""} ${ev.content ?? ""} ${ev.status ?? ""}`.toLowerCase();
  const updating = text.includes("updat") || text.includes("\u0622\u067E\u062F\u06CC\u062A") || text.includes("\u0628\u0647\u200C\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC") || text.includes("\u0628\u0631\u0648\u0632");
  const done = text.includes("done") || text.includes("complete") || ev.status === "done";
  const failed2 = text.includes("fail") || text.includes("error") || ev.status === "error";
  if (failed2) return { phase: "error", language: ev.language };
  if (done) return { phase: "done", language: ev.language };
  return { phase: updating ? "updating" : "installing", language: ev.language };
}
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
    if (c2.hydrated === false) {
      const { messages: _omitted, hydrated: _h, ...meta } = c2;
      out.push(meta);
      continue;
    }
    if (!hasBody) continue;
    const clean = { ...c2 };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
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
function sanitizeImageDataUrl(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s.startsWith("data:")) return null;
  if (s.includes("\u2026")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const head = s.slice(0, comma);
  let payload = s.slice(comma + 1).replace(/\s+/g, "");
  if (!payload) return null;
  if (!/;base64/i.test(head)) {
    return head.startsWith("data:image/") ? null : s;
  }
  if (/[^A-Za-z0-9+/=]/.test(payload)) return null;
  if (payload.length % 4 === 1) return null;
  payload += "=".repeat((4 - payload.length % 4) % 4);
  try {
    atob(payload);
  } catch {
    return null;
  }
  return `${head},${payload}`;
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
function normalizeToolFallbackRows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r;
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    if (!providerId !== !model) continue;
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
function loadTerminalPlacement() {
  try {
    return localStorage.getItem(TERMINAL_PLACEMENT_KEY) === "right" ? "right" : "bottom";
  } catch {
    return "bottom";
  }
}
function persistTerminalPlacement(p) {
  try {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, p);
  } catch {
  }
}
function resolveTerminalPlacement(requested, paneOpen, chatFull) {
  return requested === "right" && paneOpen && !chatFull ? "right" : "bottom";
}
function resolveTerminalDockHeight(height, paneHeight) {
  const wanted = clampTerminalHeight(height);
  if (!Number.isFinite(paneHeight) || paneHeight <= 0) return wanted;
  const room = Math.max(MIN_TERMINAL_HEIGHT, Math.round(paneHeight) - MIN_PANE_CONTENT_HEIGHT);
  return Math.min(wanted, room);
}
function persistPanelsSoon() {
  clearTimeout(panelPersistTimer);
  panelPersistTimer = setTimeout(() => {
    panelPersistTimer = void 0;
    void writeSettingsNow(useStore.getState());
  }, PERSIST_DEBOUNCE_MS);
}
function writeChatsNow(s) {
  const streaming = s.chats.filter(
    (c2) => c2.hydrated !== false && c2.messages.some((m) => m.streaming)
  );
  const subset = streaming.length > 0 ? streaming : s.chats.filter((c2) => c2.id === s.activeChatId && c2.hydrated !== false);
  if (subset.length === 0) return;
  void api.storeSet("chats", sanitizeChats(subset));
}
function writeSettingsNow(s) {
  if (!s.settingsHydrated) return Promise.resolve();
  const seq = ++persistSeq;
  return (async () => {
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse } = s;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse });
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
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse } = s;
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
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse });
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
function providerApiKeys(p) {
  const raw = Array.isArray(p.apiKeys) ? p.apiKeys : [];
  const out = raw.map((k) => typeof k === "string" ? k : "").filter((k) => k.trim() !== "");
  if (out.length === 0 && typeof p.apiKey === "string" && p.apiKey.trim() !== "") out.push(p.apiKey);
  return out;
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
function applyChatBody(body) {
  const src = body;
  const messages = Array.isArray(src.messages) ? src.messages : [];
  bodyBytes.set(body.id, approxBytes(messages));
  useStore.setState((s) => {
    let changed = false;
    const chats = s.chats.map((c2) => {
      if (c2.id !== body.id) return c2;
      changed = true;
      return {
        ...body,
        mode: src.mode ? normalizeMode(src.mode) : c2.mode,
        messages,
        messageCount: messages.length,
        hydrated: true,
        pendingAsk: c2.pendingAsk ?? null,
        pendingPermission: c2.pendingPermission ?? null,
        draft: c2.draft,
        scrollPos: c2.scrollPos ?? body.scrollPos ?? null,
        updatedAt: Math.max(c2.updatedAt ?? 0, body.updatedAt ?? 0)
      };
    });
    return changed ? { chats } : {};
  });
}
function evictChatBodies() {
  const s = useStore.getState();
  if (persistTimer) return;
  const keep = /* @__PURE__ */ new Set([s.activeChatId, ...s.openChatIds, ...s.visibleChatIds]);
  const candidates = s.chats.filter((c2) => c2.hydrated === true && !keep.has(c2.id)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
        hydrated: false
      } : c2
    )
  }));
}
function isChatBodyReady(id) {
  const c2 = useStore.getState().chats.find((x) => x.id === id);
  return !!c2 && c2.hydrated !== false;
}
function ensureChatHydrated(id) {
  const chat = useStore.getState().chats.find((c2) => c2.id === id);
  if (!chat) return Promise.resolve();
  if (chat.hydrated !== false) {
    evictChatBodies();
    return Promise.resolve();
  }
  const inflight = hydratePromises.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const body = await api.chatGet(id);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        applyChatBody(body);
      } else {
        useStore.setState((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? { ...c2, messages: [], hydrated: true, messageCount: 0 } : c2
          )
        }));
      }
    } catch {
    } finally {
      hydratePromises.delete(id);
      evictChatBodies();
    }
  })();
  hydratePromises.set(id, p);
  return p;
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
function flushStateNow() {
  clearTimeout(persistTimer);
  return writeStateNow(useStore.getState());
}
function getActiveChat() {
  const s = useStore.getState();
  return s.chats.find((c2) => c2.id === s.activeChatId) ?? null;
}
function getActiveMode() {
  return getActiveChat()?.mode ?? "ask";
}
function getActiveProvider() {
  const s = useStore.getState();
  return s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
}
function getChatProvider(chatId) {
  const s = useStore.getState();
  const ch = chatId ? s.chats.find((c2) => c2.id === chatId) ?? null : null;
  const overrideId = ch?.providerId;
  const p = s.settings.providers.find((x) => x.id === (overrideId ?? s.settings.activeProviderId)) ?? s.settings.providers[0];
  return ch?.model ? { ...p, model: ch.model } : p;
}
var MAX_SCHEDULE_RUNS_SEEN, TITLE_MAX_WORDS, uid, MAX_COMPACTED_PER_CHAT, QUEUED_SENT_GRACE_MS, MID_STREAM_MS, lastMidStreamPersist, MAX_TOOL_TEXT, MAX_TOOL_ARG, MAX_PERSIST_IMAGE_CHARS, MODE_LABELS, SEARCH_PLUGIN_LABELS, persistTimer, PERSIST_DEBOUNCE_MS, OPEN_CHATS_KEY, ACTIVE_CHAT_KEY, VISIBLE_CHATS_KEY, WINDOW_SIZES_KEY, CHAT_LAYOUT_KEY, CHAT_FULL_KEY, WINDOW_FULL_KEY, TERMINAL_PANEL_KEY, TERMINAL_FULL_KEY, TERMINAL_HEIGHT_KEY, MIN_TERMINAL_HEIGHT, DEFAULT_TERMINAL_HEIGHT, TERMINAL_PLACEMENT_KEY, MIN_PANE_CONTENT_HEIGHT, panelPersistTimer, persistSeq, MAX_REDO_EXCHANGES, historyStacks, chatDeleteHooks, PROVIDER_NAMES, MAX_PINNED_RECENT_MODELS, HYDRATED_CHAT_CAP, HYDRATED_BYTE_BUDGET, bodyBytes, hydratePromises, useStore;
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
    init_context();
    init_thinking();
    init_toolSlots();
    init_toolActivity();
    init_chatTree();
    MAX_SCHEDULE_RUNS_SEEN = 500;
    TITLE_MAX_WORDS = 4;
    uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    MAX_COMPACTED_PER_CHAT = 50;
    QUEUED_SENT_GRACE_MS = 10 * 60 * 1e3;
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
    TERMINAL_HEIGHT_KEY = "coder:terminalHeight";
    MIN_TERMINAL_HEIGHT = 140;
    DEFAULT_TERMINAL_HEIGHT = 300;
    TERMINAL_PLACEMENT_KEY = "coder:terminalPlacement";
    MIN_PANE_CONTENT_HEIGHT = 160;
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
    MAX_REDO_EXCHANGES = 20;
    historyStacks = /* @__PURE__ */ new Map();
    chatDeleteHooks = [];
    PROVIDER_NAMES = Object.fromEntries(
      Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
    );
    MAX_PINNED_RECENT_MODELS = 3;
    HYDRATED_CHAT_CAP = 10;
    HYDRATED_BYTE_BUDGET = 24 * 1024 * 1024;
    bodyBytes = /* @__PURE__ */ new Map();
    hydratePromises = /* @__PURE__ */ new Map();
    useStore = create((set, get) => ({
      loaded: false,
      settingsHydrated: false,
      settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80, disableTextSuggestions: true },
      builtinMcp: [],
      root: "",
      theme: DEFAULT_THEME,
      dir: "rtl",
      fontSize: 14,
      webSearchAutoFetch: 5,
      sttProviderId: "",
      sttModel: "whisper-1",
      sttFallbacks: [],
      sttLanguage: "fa",
      sttPrompt: "",
      ttsProviderId: "",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsFallbacks: [],
      liveProviderId: "",
      liveModel: "",
      liveVoice: "",
      recentModels: [],
      subagentModels: {},
      subagentThinking: {},
      toolFallbacks: {},
      cacheTtlMinutes: 60,
      historyLimit: 0,
      searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
      sidebarOpen: true,
      rightPanelOpen: false,
      terminalPanelOpen: typeof window !== "undefined" ? loadTerminalPanel() : false,
      terminalFullscreen: typeof window !== "undefined" ? loadTerminalFullscreen() : false,
      terminalPlacement: typeof window !== "undefined" ? loadTerminalPlacement() : "bottom",
      terminalHeight: typeof window !== "undefined" ? loadTerminalHeight() : DEFAULT_TERMINAL_HEIGHT,
      dataPath: "",
      workspaceColors: {},
      pinnedWorkspaces: [],
      pinnedChats: [],
      workspaces: [],
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
          delete clean.compactNotice;
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
            const messages = next.messages.map((m) => {
              const acts = m.toolActivity;
              if (!Array.isArray(acts) || acts.length === 0) return m;
              const ren = acts.some((a) => a && (a.tool === "task" || a.tool === "subagent"));
              if (!ren) return m;
              touched = true;
              return { ...m, toolActivity: normalizeToolActivity(acts) };
            });
            if (touched) next.messages = messages;
          }
          if (next.goal?.active && !next.goal.paused) {
            next.goal = { ...next.goal, stopped: true };
          }
          const withMode = next.mode ? { ...next, mode: normalizeMode(next.mode) } : next;
          const queued = pruneQueued(withMode.queued);
          const base = queued === withMode.queued ? withMode : { ...withMode, queued };
          if (Array.isArray(next.messages)) bodyBytes.set(base.id, approxBytes(next.messages));
          return {
            ...base,
            messages: Array.isArray(base.messages) ? base.messages : [],
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
          disableTextSuggestions: typeof raw.disableTextSuggestions === "boolean" ? raw.disableTextSuggestions : true
        };
        const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 24 ? raw.fontSize : 14;
        document.documentElement.style.setProperty("--chat-font-size", `${fontSize}px`);
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
          root,
          dir: raw.dir === "ltr" ? "ltr" : "rtl",
          fontSize,
          dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
          // No on-device STT anymore: an empty id means "not selected", never a
          // magic 'local' row (the legacy value is migrated away here).
          sttProviderId: typeof raw.sttProviderId === "string" && raw.sttProviderId.trim() && raw.sttProviderId !== "local" ? raw.sttProviderId : "",
          sttModel: typeof raw.sttModel === "string" && raw.sttModel.trim() ? raw.sttModel : "whisper-1",
          sttFallbacks: normalizeSttFallbacks(raw.sttFallbacks),
          // Per-tool fallback lists live in the SETTINGS document (they belong to
          // the UI), so they are read from `raw`, not from a store-level key.
          toolFallbacks: normalizeToolFallbacks(raw.toolFallbacks),
          // Empty means "auto": resolveSttLanguage() then follows the UI direction.
          sttLanguage: typeof raw.sttLanguage === "string" ? raw.sttLanguage.trim().toLowerCase() : "fa",
          sttPrompt: typeof raw.sttPrompt === "string" ? raw.sttPrompt : "",
          ttsProviderId: typeof raw.ttsProviderId === "string" && raw.ttsProviderId.trim() !== "local" ? raw.ttsProviderId.trim() : "",
          // خالی مجاز است (پروایدرهای 9router بدون مدل/ویس): فقط وقتی فیلد اصلاً
          // رشته نیست (settings قدیمی) پیش‌فرض می‌گذاریم، نه وقتی کاربر پاکش کرده.
          ttsModel: typeof raw.ttsModel === "string" ? raw.ttsModel.trim() : "tts-1",
          ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim() : "alloy",
          ttsFallbacks: normalizeTtsFallbacks(raw.ttsFallbacks),
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
          for (const id of wanted) void ensureChatHydrated(id);
        }
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
      setDataPath: (dataPath) => {
        set({ dataPath: (dataPath ?? "").trim() });
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
      setSttPrompt: (p) => {
        set({ sttPrompt: p ?? "" });
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
      setTerminalPlacement: (terminalPlacement) => {
        if (terminalPlacement === "right" && get().terminalFullscreen) {
          get().setTerminalFullscreen(false);
        }
        persistTerminalPlacement(terminalPlacement);
        set({ terminalPlacement });
      },
      toggleTerminalPlacement: () => {
        get().setTerminalPlacement(get().terminalPlacement === "right" ? "bottom" : "right");
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
        const prevRoot = s.chats.find((c2) => c2.id === s.activeChatId)?.root;
        const lastRoot = [...s.chats].reverse().find((c2) => c2.root)?.root;
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
          return {
            chats,
            activeChatId,
            openChatIds: finalOpen,
            visibleChatIds,
            chatWindowSizes,
            chatTree,
            chatAborts,
            chatBusy,
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
          const activeChatId = s.chats.some((c2) => c2.id === s.activeChatId && workspaceKey(c2.root ?? "") !== key) ? s.activeChatId : chats[chats.length - 1]?.id ?? "";
          const openChatIds = s.openChatIds.filter((cid) => !doomedIds.has(cid));
          if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(chats.map((c2) => c2.id));
          const baseTreeWs = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          let pruned = baseTreeWs;
          for (const dead of doomedIds) pruned = removeChat(pruned, dead);
          const normalizedWs = normalizeTree(pruned, validIds);
          const fallbackWs = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId);
          const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsWs = persistTreeMirrors(chatTreeWs, s.chatLayout);
          const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs;
          const chatAborts = { ...s.chatAborts };
          for (const id of doomed) delete chatAborts[id];
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
            chatAborts,
            unreadChats: s.unreadChats.filter((cid) => !doomedIds.has(cid)),
            deletedChatIds: [
              ...s.deletedChatIds,
              ...s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.id)
            ],
            deletedWorkspaceRoots: [
              ...s.deletedWorkspaceRoots,
              ...s.chats.filter((c2) => workspaceKey(c2.root ?? "") === key).map((c2) => c2.root ?? "")
            ]
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
          return {
            workspaces,
            chats: s.chats.map(
              (c2) => workspaceKey(c2.root ?? "") === key ? { ...c2, root: nextRoot || void 0, updatedAt: Date.now() } : c2
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
        set((s) => {
          if (!s.chats.some((c2) => c2.id === id)) return {};
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
            const isFlat = base.kind !== "split" || base.children.every((c2) => c2.kind === "leaf");
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
          if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
          if (!s.chats.some((c2) => c2.id === targetChatId)) return {};
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
          if (!s.chats.some((c2) => c2.id === dragChatId)) return {};
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
        set((s) => ({
          root: s.activeChatId === id ? root : s.root,
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, root, updatedAt: Date.now() } : c2)
        }));
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
        const cut = src.messages.slice(0, idx + 1).map((m) => ({ ...m }));
        set((st) => ({
          chats: st.chats.map(
            (c2) => c2.id === chatId ? {
              ...c2,
              messages: cut,
              title: `${src.title} (fork)`.slice(0, 80),
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
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c2.updatedAt,
              title: c2.messages.length === 0 && message.role === "user" ? autoTitle : c2.title
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
      setChatCompactNotice: (id, compactNotice) => {
        set((s) => ({
          chats: s.chats.map((c2) => c2.id === id ? { ...c2, compactNotice } : c2)
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
        if (!isChatBodyReady(id)) return;
        abortChatStream(get().chatAborts[id]);
        historyStacks.delete(id);
        set((s) => ({
          chats: s.chats.map(
            (c2) => c2.id === id ? { ...c2, messages: [], usage: void 0, updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
      },
      truncateTo: (messageId) => {
        const s = get();
        const target = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
        if (!target) return false;
        const idx = target.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return false;
        const targetId = target.id;
        set((st) => ({
          chats: st.chats.map(
            (c2) => c2.id === targetId ? { ...c2, messages: c2.messages.slice(0, idx), updatedAt: Date.now() } : c2
          )
        }));
        get().persist();
        return true;
      },
      compactChat: (id, summary, keep = 0) => {
        if (!isChatBodyReady(id)) return;
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
      }
    }));
    api.onSidecarChanged(() => {
      void useStore.getState().load();
    });
  }
});

// src/lib/tabBar.ts
function measure(axis, client, box) {
  return axis === "y" ? { pos: client - (box.top ?? 0), size: box.height ?? 0 } : { pos: client - (box.left ?? 0), size: box.width ?? 0 };
}
function dropSide(client, box, axis = "x", threshold = 0.5) {
  const { pos, size } = measure(axis, client, box);
  return pos <= size * threshold ? "before" : "after";
}
function tabMove(ids, id, key, altKey, axis = "x") {
  if (!altKey) return null;
  const [back, forward] = axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const delta = key === back ? -1 : key === forward ? 1 : 0;
  if (delta === 0) return null;
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return null;
  return { toId: ids[j], after: delta > 0 };
}
function edgeScroll(client, bar, axis = "x", edge = 64, speed = 14) {
  const { pos, size } = measure(axis, client, bar);
  const x = Math.min(Math.max(pos, 0), size);
  if (x < edge) return -Math.round(speed * (1 - x / edge));
  if (x > size - edge) return Math.round(speed * ((x - (size - edge)) / edge));
  return 0;
}
function menuLeft(anchorLeft, width, viewportWidth, placement = "bottom") {
  const left = placement === "left" ? anchorLeft - width : anchorLeft;
  return Math.max(12, Math.min(left, viewportWidth - width));
}
function menuTop(anchorTop, height, viewportHeight, margin = 12) {
  const max = Math.max(margin, viewportHeight - height - margin);
  return Math.round(Math.min(Math.max(anchorTop, margin), max));
}
var init_tabBar = __esm({
  "src/lib/tabBar.ts"() {
    "use strict";
  }
});

// src/lib/tabOrder.ts
function previewOrder(ids, fromId, toId, after) {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  const dest = next.indexOf(toId) + (after ? 1 : 0);
  next.splice(Math.max(0, Math.min(next.length, dest)), 0, moved);
  return next;
}
function previewSlot(ids, fromId, toId, after) {
  const slot = /* @__PURE__ */ new Map();
  previewOrder(ids, fromId, toId, after).forEach((id, i) => slot.set(id, i));
  return slot;
}
var init_tabOrder = __esm({
  "src/lib/tabOrder.ts"() {
    "use strict";
  }
});

// src/lib/viewerTabs.ts
var viewerTabs_exports = {};
__export(viewerTabs_exports, {
  RAIL_PAGE_KINDS: () => RAIL_PAGE_KINDS,
  clampSplitWidth: () => clampSplitWidth,
  hasViewerTabListEntries: () => hasViewerTabListEntries,
  isRailRow: () => isRailRow,
  loadSplitWidth: () => loadSplitWidth,
  persistSplitWidth: () => persistSplitWidth,
  resolveViewerForChat: () => resolveViewerForChat,
  shownViewerTabId: () => shownViewerTabId,
  syncViewerToChat: () => syncViewerToChat,
  useViewerTabs: () => useViewerTabs,
  viewerTabId: () => viewerTabId,
  viewerTabRows: () => viewerTabRows,
  viewerTabTitle: () => viewerTabTitle,
  visibleTabs: () => visibleTabs
});
import { create as create2 } from "zustand";
function viewerTabId(kind, chatId, path) {
  if (kind === "file") {
    const clean = (path ?? "").trim();
    return clean ? `file:${chatId}:${clean}` : `file:${chatId}`;
  }
  return CHAT_SCOPED_KINDS.has(kind) ? `${kind}:${chatId}` : kind;
}
function viewerTabTitle(t) {
  if (t.kind === "file" || t.kind === "text" || t.kind === "explore") return t.title;
  if (t.kind === "artifact") return t.title || VIEWER_KIND_LABEL.artifact;
  if (t.kind === "trace" && (t.traceTaskId ?? "").trim()) return t.title;
  return VIEWER_KIND_LABEL[t.kind] ?? t.title;
}
function visibleTabs(tabs, chatId) {
  return tabs.filter((t) => {
    if (t.kind === "file" && !t.chatId) return true;
    return !CHAT_SCOPED_KINDS.has(t.kind) || t.chatId === chatId;
  });
}
function shownViewerTabId(tabs, activeId, panelMode, chatId) {
  if (panelMode) return null;
  const visible = visibleTabs(tabs, chatId);
  const active = visible.find((t) => t.id === activeId) ?? visible[0] ?? null;
  return active?.id ?? null;
}
function isRailRow(t) {
  if (t.kind === "trace" && (t.traceTaskId ?? "").trim()) return true;
  return !RAIL_PAGE_KINDS.has(t.kind);
}
function viewerTabRows(tabs, chatId) {
  return visibleTabs(tabs, chatId).filter(isRailRow);
}
function hasViewerTabListEntries(tabs, closedTabs, chatId) {
  if (closedTabs.length > 0) return true;
  return visibleTabs(tabs, chatId).length > 0;
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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null, closed: [] };
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed.tabs) ? parsed.tabs.filter((t) => t && typeof t.id === "string" && VALID_KINDS.has(t.kind)) : [];
    const seen = /* @__PURE__ */ new Set();
    const tabs = [];
    for (const t of valid) {
      if (CHAT_SCOPED_KINDS.has(t.kind) && !t.chatId && t.kind !== "file") continue;
      const legacyId = viewerTabId(t.kind, t.chatId ?? "");
      const id = (
        // Artifact tabs carry the artifact id in their own id
        // (`artifact:<chatId>:<artifactId>`), exactly like file tabs carry the
        // path: recomputing via `viewerTabId` collapses every artifact of one
        // chat into a single `artifact:<chatId>` tab and silently drops the
        // rest on reload.
        t.kind === "file" || t.kind === "artifact" ? t.id : t.kind === "trace" && typeof t.traceTaskId === "string" && t.traceTaskId ? t.id.startsWith("trace:") ? t.id : `trace:${t.chatId}:${t.traceTaskId}` : legacyId
      );
      if (seen.has(id)) continue;
      seen.add(id);
      tabs.push({
        ...t,
        id,
        // Tabs persisted before `artifactId` existed carry the id only inside
        // their tab id (`artifact:<chatId>:<artifactId>`) — recover it so the
        // restored panel can still re-read its body instead of showing the
        // "no longer in memory" notice forever.
        ...t.kind === "artifact" && !t.artifactId ? { artifactId: id.split(":").slice(2).join(":") || void 0 } : {},
        title: t.kind === "review" ? "Git" : t.title
      });
    }
    const capped = capTabs(tabs);
    const activeId = typeof parsed.activeId === "string" && capped.some((t) => t.id === parsed.activeId) ? parsed.activeId : capped[0]?.id ?? null;
    const closed = Array.isArray(parsed.closed) ? parsed.closed.filter((c2) => c2 && typeof c2.closedAt === "number" && c2.tab && typeof c2.tab.id === "string" && VALID_KINDS.has(c2.tab.kind)).slice(0, CLOSED_CAP) : [];
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
        closed: closed.map((c2) => ({ tab: slimTab(c2.tab), closedAt: c2.closedAt }))
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
function resolveViewerForChat(visible, lastActiveByChat, chatId) {
  if (visible.length === 0) return null;
  const remembered = lastActiveByChat[chatId];
  if (remembered && visible.some((t) => t.id === remembered)) return remembered;
  return visible[0].id;
}
function syncViewerToChat(chatId) {
  const vt = useViewerTabs.getState();
  const visible = visibleTabs(vt.tabs, chatId);
  if (visible.length === 0) return;
  const target = resolveViewerForChat(visible, vt.lastActiveByChat, chatId);
  if (target && vt.activeId !== target) {
    const tab = vt.tabs.find((t) => t.id === target);
    const lastActiveByChat = tab?.chatId ? { ...vt.lastActiveByChat, [tab.chatId]: target } : vt.lastActiveByChat;
    const focusedViewerId = vt.viewerTree && leafCount(vt.viewerTree) > 1 ? vt.focusedViewerId : target;
    persist(vt.tabs, target, vt.closedTabs);
    useViewerTabs.setState({ activeId: target, lastActiveByChat, focusedViewerId });
  }
}
function loadSplitWidth(fallbackRatio = 0.5) {
  if (typeof window === "undefined" || typeof window.innerWidth !== "number") return 720;
  const vw = window.innerWidth;
  const saved = (() => {
    try {
      return parseInt(localStorage.getItem("coder:splitWidth") ?? "", 10);
    } catch {
      return NaN;
    }
  })();
  const fallback = Math.round(vw * fallbackRatio);
  const n = Number.isFinite(saved) ? saved : fallback;
  return clampSplitWidth(n, vw);
}
function persistSplitWidth(w) {
  try {
    localStorage.setItem("coder:splitWidth", String(w));
  } catch {
  }
}
function clampSplitWidth(w, vw) {
  const width = typeof vw === "number" && Number.isFinite(vw) ? vw : typeof window !== "undefined" ? window.innerWidth : 1024;
  const max = Math.min(width / 2, width - 320);
  return Math.max(320, Math.min(max, w));
}
var CHAT_SCOPED_KINDS, RAIL_PAGE_KINDS, VALID_KINDS, VIEWER_KIND_LABEL, STORAGE_KEY, CLOSED_CAP, TOTAL_TAB_CAP, FILE_TAB_CAP, initial, FULLSCREEN_KEY, PANE_KEY, PANEL_MODE_KEY, VIEWER_TREE_KEY, VIEWER_WINDOW_MAX, initialViewerTree, useViewerTabs;
var init_viewerTabs = __esm({
  "src/lib/viewerTabs.ts"() {
    "use strict";
    init_store();
    init_chatTree();
    CHAT_SCOPED_KINDS = /* @__PURE__ */ new Set(["review", "trace", "plan", "browser", "text", "file", "explore", "files"]);
    RAIL_PAGE_KINDS = /* @__PURE__ */ new Set([
      "files",
      "artifacts",
      "schedule",
      "inbox",
      "review",
      "trace",
      "browser"
    ]);
    VALID_KINDS = /* @__PURE__ */ new Set([
      "review",
      "trace",
      "inbox",
      "schedule",
      "plan",
      "browser",
      "file",
      "text",
      "explore",
      "files",
      "artifact",
      "artifacts"
    ]);
    VIEWER_KIND_LABEL = {
      review: "Git",
      trace: "Trace",
      inbox: "Inbox",
      schedule: "Schedule",
      plan: "Plan",
      browser: "Browser",
      // Unused: file tabs keep their per-path title (the file name).
      file: "File",
      text: "Text",
      // Unused: explore tabs keep their own title ("Explore · <description>").
      explore: "Explore",
      files: "Files",
      artifacts: "Artifacts",
      // Fallback only: artifact tabs keep their own document title (see
      // viewerTabTitle), otherwise every artifact tab reads "Artifact".
      artifact: "Artifact"
    };
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
      openSchedule: () => set((s) => {
        const id = "schedule";
        const entry = {
          id,
          kind: "schedule",
          title: "Schedule",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false };
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
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false };
        persist(next.tabs, next.activeId);
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
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
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
      openExplore: (messageId, index, title, chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("explore", cid);
        const label = (title ?? "").trim();
        const entry = {
          id,
          kind: "explore",
          chatId: cid,
          title: label ? `Explore \xB7 ${label.slice(0, 60)}` : "Explore",
          exploreMessageId: messageId,
          exploreIndex: index,
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => t.id === id ? { ...t, ...entry } : t) : [...s.tabs, entry]);
        const lastActiveByChat = cid ? { ...s.lastActiveByChat, [cid]: id } : s.lastActiveByChat;
        const next = { tabs, activeId: id, paneOpen: true, panelMode: false, lastActiveByChat };
        persist(next.tabs, next.activeId);
        return next;
      }),
      openFiles: (chatId) => set((s) => {
        const cid = chatId ?? currentChatId();
        const id = viewerTabId("files", cid);
        const entry = {
          id,
          kind: "files",
          chatId: cid,
          title: "Files",
          createdAt: Date.now()
        };
        const tabs = capTabs(s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, entry]);
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
        const toClose = chatId ? visibleTabs(s.tabs, chatId) : s.tabs;
        if (toClose.length === 0) return {};
        const closeIds = new Set(toClose.map((t) => t.id));
        const tabs = s.tabs.filter((t) => !closeIds.has(t.id));
        const activeId = s.activeId && closeIds.has(s.activeId) ? tabs[0]?.id ?? null : s.activeId;
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
      setActiveViewer: (id) => set((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return {};
        persist(s.tabs, id, s.closedTabs);
        const lastActiveByChat = tab.chatId ? { ...s.lastActiveByChat, [tab.chatId]: id } : s.lastActiveByChat;
        const focusedViewerId = s.viewerTree && leafCount(s.viewerTree) > 1 ? s.focusedViewerId : id;
        return { activeId: id, panelMode: false, lastActiveByChat, focusedViewerId };
      }),
      reopenClosedViewerTab: (id) => set((s) => {
        const entry = s.closedTabs.find((c2) => c2.tab.id === id);
        if (!entry) return {};
        const closedTabs = s.closedTabs.filter((c2) => c2.tab.id !== id);
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
    registerChatDeleteHook((chatId) => {
      useViewerTabs.getState().closeAllViewers(chatId);
    });
  }
});

// src/lib/schedule-notify.ts
function scheduleRunTokenTotal(run) {
  let total = 0;
  for (const u of run.usage?.entries ?? []) {
    total += (u.input || 0) + (u.output || 0);
  }
  return total;
}
function findFinishedScheduleRuns(prev, runs) {
  if (!prev) return [];
  return (runs ?? []).filter((r) => {
    if (!r) return false;
    if (r.status !== "done" && r.status !== "error") return false;
    const before = prev.get(r.id);
    return before === void 0 || before === "running";
  });
}
async function ensureScheduleNotificationPermission() {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission !== "denied") {
      const p = await Notification.requestPermission();
      return p === "granted";
    }
    return false;
  } catch {
    return false;
  }
}
function notifyScheduleRun(run, taskName, onOpen) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const name = (taskName ?? "").trim() || "Scheduled task";
    const status = run.status === "error" ? "Failed" : run.status === "running" ? "Running" : "Done";
    const tokens = scheduleRunTokenTotal(run);
    const body = tokens > 0 ? `${status} \xB7 ${tokens} tokens` : status;
    const n = new Notification(name, { body });
    if (onOpen) n.onclick = () => onOpen();
  } catch {
  }
}
function notifyScheduleRunBatch(count, onOpen) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification("Scheduled tasks", {
      body: `${count} new schedule runs`
    });
    if (onOpen) n.onclick = () => onOpen();
  } catch {
  }
}
var init_schedule_notify = __esm({
  "src/lib/schedule-notify.ts"() {
    "use strict";
  }
});

// src/components/SchedulePanel.tsx
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function formatNextRunFa(nextRun, nowRef) {
  if (!nextRun) return "No next run";
  const d = new Date(nextRun * 1e3);
  const now = nowRef ?? /* @__PURE__ */ new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today ${hm}`;
  if (isTomorrow) return `Tomorrow ${hm}`;
  return `${d.toLocaleDateString("en-US")} ${hm}`;
}
function runStatusFa(status) {
  if (status === "done") return "Done";
  if (status === "error") return "Failed";
  return "Running";
}
var CRON_PRESETS, CRON_PRESET_VALUES;
var init_SchedulePanel = __esm({
  "src/components/SchedulePanel.tsx"() {
    "use strict";
    init_store();
    init_fs();
    init_api();
    init_context();
    init_schedule_notify();
    CRON_PRESETS = [
      { value: "", label: "Once" },
      { value: "*/15 * * * *", label: "Every 15 minutes" },
      { value: "0 * * * *", label: "Hourly" },
      { value: "0 9 * * *", label: "Daily (9 AM)" },
      { value: "0 9 * * 1", label: "Weekly (Mon 9 AM)" }
    ];
    CRON_PRESET_VALUES = new Set(CRON_PRESETS.map((p) => p.value));
  }
});

// src/components/TodosPanel.tsx
import { useEffect as useEffect2, useRef, useState as useState2 } from "react";
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var init_TodosPanel = __esm({
  "src/components/TodosPanel.tsx"() {
    "use strict";
    init_store();
    init_viewerTabs();
    init_bidi();
  }
});

// src/lib/plugins.ts
var init_plugins = __esm({
  "src/lib/plugins.ts"() {
    "use strict";
    init_api();
  }
});

// src/lib/skills.ts
var init_skills = __esm({
  "src/lib/skills.ts"() {
    "use strict";
  }
});

// src/lib/turnUsage.ts
var init_turnUsage = __esm({
  "src/lib/turnUsage.ts"() {
    "use strict";
  }
});

// src/components/TurnUsagePanel.tsx
import { useEffect as useEffect3, useState as useState3 } from "react";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var init_TurnUsagePanel = __esm({
  "src/components/TurnUsagePanel.tsx"() {
    "use strict";
    init_api();
    init_plugins();
    init_skills();
    init_turnUsage();
  }
});

// src/components/ViewerPages.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var init_ViewerPages = __esm({
  "src/components/ViewerPages.tsx"() {
    "use strict";
    init_SchedulePanel();
    init_TodosPanel();
    init_TurnUsagePanel();
    init_store();
  }
});

// src/lib/reviewTurn.ts
function reviewPathOf(a) {
  const p = a.args?.path ?? a.args?.filePath;
  return typeof p === "string" ? p : "";
}
function buildReviewTurn(messageId, activities) {
  const byPath = /* @__PURE__ */ new Map();
  const walk = (list) => {
    for (const a of list) {
      if ((a.tool === "edit_file" || a.tool === "write_file") && a.diff) {
        const path = reviewPathOf(a);
        if (path) {
          const s = a.diffStats ?? diffStatsFromUnified(a.diff);
          const cur = byPath.get(path);
          if (cur) {
            cur.adds += s.adds;
            cur.dels += s.dels;
            cur.diffs.push(a.diff);
          } else {
            byPath.set(path, { adds: s.adds, dels: s.dels, diffs: [a.diff] });
          }
        }
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  if (byPath.size === 0) return null;
  const files = [...byPath.entries()].map(([path, v]) => ({
    path,
    adds: v.adds,
    dels: v.dels,
    diff: v.diffs.join("\n")
  }));
  const totals = aggregateTurnStats(activities);
  return { id: messageId, files, adds: totals.adds, dels: totals.dels };
}
var init_reviewTurn = __esm({
  "src/lib/reviewTurn.ts"() {
    "use strict";
    init_toolActivity();
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
function mergeFileDiffs(groups) {
  const order = [];
  const byPath = /* @__PURE__ */ new Map();
  for (const group of groups) {
    for (const f of group) {
      if (!f.path) continue;
      const cur = byPath.get(f.path);
      if (cur) cur.push(f.diff);
      else {
        byPath.set(f.path, [f.diff]);
        order.push(f.path);
      }
    }
  }
  return order.map((path) => ({
    path,
    diff: (byPath.get(path) ?? []).join("\n")
  }));
}
function splitUnifiedDiffByFile(diff2) {
  const out = [];
  let cur = null;
  let curPath = "";
  for (const line of diff2.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push({ path: curPath, diff: cur.join("\n") });
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      curPath = m ? m[2] : line.slice("diff --git ".length);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push({ path: curPath, diff: cur.join("\n") });
  return out.filter((f) => f.path.length > 0);
}
var HUNK_RE;
var init_reviewDiff = __esm({
  "src/lib/reviewDiff.ts"() {
    "use strict";
    HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  }
});

// src/lib/uncommitted.ts
function buildUncommittedFiles(statusPaths, unstagedDiff, stagedDiff) {
  const parts = mergeFileDiffs([
    splitUnifiedDiffByFile(unstagedDiff),
    splitUnifiedDiffByFile(stagedDiff)
  ]);
  const byPath = new Map(parts.map((p) => [p.path, p.diff]));
  const paths = [...byPath.keys()];
  for (const p of statusPaths) {
    if (!byPath.has(p)) {
      byPath.set(p, "");
      paths.push(p);
    }
  }
  return paths.map((p) => {
    const diff2 = byPath.get(p) ?? "";
    const s = diff2 ? diffStatsFromUnified(diff2) : { adds: 0, dels: 0 };
    return { path: p, diff: diff2, adds: s.adds, dels: s.dels };
  });
}
var init_uncommitted = __esm({
  "src/lib/uncommitted.ts"() {
    "use strict";
    init_toolActivity();
    init_reviewDiff();
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
function fileMatchesQuery(file, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return file.path.toLowerCase().includes(q) || file.diff.toLowerCase().includes(q);
}
function stepHitIndex(current, total, dir) {
  if (total <= 0) return -1;
  const c2 = Number.isFinite(current) && current >= 0 ? current : dir === 1 ? -1 : 0;
  return ((c2 + dir) % total + total) % total;
}
function locateHit(counts, globalIndex) {
  const total = counts.reduce((n, c2) => n + c2, 0);
  if (total <= 0) return null;
  let g = (globalIndex % total + total) % total;
  for (let i = 0; i < counts.length; i++) {
    const c2 = counts[i] ?? 0;
    if (g < c2) return { fileIndex: i, localIndex: g };
    g -= c2;
  }
  return null;
}
function countDiffHits(rows, query) {
  const q = query.trim();
  if (!q) return 0;
  let n = 0;
  for (const row of rows) {
    if ("text" in row) continue;
    if (row.type === "same" || row.type === "add") {
      n += countOccurrences(row.after, q);
    } else if (row.type === "del") {
      n += countOccurrences(row.before, q);
    } else {
      n += countOccurrences(row.before, q) + countOccurrences(row.after, q);
    }
  }
  return n;
}
function filterFilesByQuery(files, query) {
  if (!query.trim()) return files;
  return files.filter((f) => fileMatchesQuery(f, query));
}
function countTraceEntryHits(entry, query) {
  const q = query.trim();
  if (!q) return 0;
  return countOccurrences(entry.title || "", q) + countOccurrences(entry.prompt || "", q) + countOccurrences(entry.result || "", q) + countOccurrences(entry.detailJson || "", q);
}
var init_diffSearch = __esm({
  "src/lib/diffSearch.ts"() {
    "use strict";
  }
});

// src/lib/reviewPanel.ts
import { create as create3 } from "zustand";
var useReviewPanel;
var init_reviewPanel = __esm({
  "src/lib/reviewPanel.ts"() {
    "use strict";
    useReviewPanel = create3((set) => ({
      open: false,
      messageId: null,
      selectedPath: "",
      source: "turn",
      openReview: (messageId, path) => set((s) => ({
        open: true,
        messageId,
        source: "turn",
        // اگر مسیر فایل داده شده باشد همیشه همان باز می‌شود (کلیک Review روی
        // هر کارت، همان فایل را نشان می‌دهد)؛ وگرنه انتخاب قبلی همان پیام حفظ
        // می‌شود و برای پیام جدید خالی است.
        selectedPath: path ?? (s.messageId === messageId ? s.selectedPath : "")
      })),
      openGitDiff: () => set({ open: true, source: "uncommitted" }),
      close: () => set({ open: false }),
      toggle: () => set((s) => ({ open: !s.open })),
      selectPath: (selectedPath) => set({ selectedPath }),
      setSource: (source) => set({ source })
    }));
  }
});

// src/components/ViewerFullscreenButton.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ExpandIcon() {
  return /* @__PURE__ */ jsxs5("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx5("polyline", { points: "15 3 21 3 21 9" }),
    /* @__PURE__ */ jsx5("polyline", { points: "9 21 3 21 3 15" }),
    /* @__PURE__ */ jsx5("line", { x1: "21", y1: "3", x2: "14", y2: "10" }),
    /* @__PURE__ */ jsx5("line", { x1: "3", y1: "21", x2: "10", y2: "14" })
  ] });
}
function CompressIcon() {
  return /* @__PURE__ */ jsxs5("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx5("polyline", { points: "4 14 10 14 10 20" }),
    /* @__PURE__ */ jsx5("polyline", { points: "20 10 14 10 14 4" }),
    /* @__PURE__ */ jsx5("line", { x1: "10", y1: "14", x2: "21", y2: "3" }),
    /* @__PURE__ */ jsx5("line", { x1: "14", y1: "10", x2: "3", y2: "21" })
  ] });
}
function ViewerFullscreenButton({
  docked,
  fullscreen,
  onToggleFullscreen
}) {
  if (docked) return null;
  const active = fullscreen;
  return /* @__PURE__ */ jsx5(
    "button",
    {
      className: "review-header-btn viewer-fullscreen-btn",
      title: active ? "Exit fullscreen" : "Fullscreen",
      "aria-label": active ? "Exit fullscreen" : "Fullscreen",
      "aria-pressed": active,
      onClick: onToggleFullscreen,
      children: active ? /* @__PURE__ */ jsx5(CompressIcon, {}) : /* @__PURE__ */ jsx5(ExpandIcon, {})
    }
  );
}
var init_ViewerFullscreenButton = __esm({
  "src/components/ViewerFullscreenButton.tsx"() {
    "use strict";
  }
});

// src/lib/diffComments.ts
function commentSyntax(path) {
  if (!path) return NO_COMMENT_SYNTAX;
  const clean = path.split("?")[0].toLowerCase();
  const base = clean.split(/[\\/]/).pop() ?? "";
  const ext = base.split(".").pop() ?? "";
  if (!base.includes(".") && HASH_EXT.has(base)) return { line: ["#"] };
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
function defaultAppForExt(ext) {
  const e = ext.toLowerCase();
  if (e === "pdf") return { label: "Default PDF app", icon: "PDF" };
  if (e === "doc" || e === "docx") return { label: "Word", icon: "W" };
  if (e === "xls" || e === "xlsx" || e === "xlsm" || e === "csv")
    return { label: "Excel", icon: "X" };
  return null;
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
  const base = (clean.split(/[\\/]/).pop() ?? "").toLowerCase();
  return base;
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

// src/lib/useDragScroll.tsx
import { useRef as useRef2 } from "react";
import { jsx as jsx6 } from "react/jsx-runtime";
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

// src/components/FileIcon.tsx
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
function Tile({
  size,
  fill,
  children
}) {
  return /* @__PURE__ */ jsxs6(
    "svg",
    {
      className: "file-icon-svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx7(
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
        /* @__PURE__ */ jsx7(
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
        /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsxs6("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxs6("g", { fill: "none", stroke: "#61dafb", strokeWidth: "1.5", children: [
      /* @__PURE__ */ jsx7("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7" }),
      /* @__PURE__ */ jsx7("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7", transform: "rotate(60 12 12)" }),
      /* @__PURE__ */ jsx7("ellipse", { cx: "12", cy: "12", rx: "9.4", ry: "3.7", transform: "rotate(-60 12 12)" })
    ] }),
    /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "12", r: "1.9", fill: "#61dafb" })
  ] });
}
function PythonIcon({ size }) {
  return /* @__PURE__ */ jsxs6("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 128 128", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx7("path", { d: PYTHON_BLUE, fill: "#3776ab" }),
    /* @__PURE__ */ jsx7("path", { d: PYTHON_YELLOW, fill: "#ffd43b" })
  ] });
}
function MarkdownIcon({ size }) {
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#083fa1", children: /* @__PURE__ */ jsxs6("g", { stroke: "#ffffff", strokeWidth: "1.7", fill: "none", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx7("path", { d: "M5.4 15.8V8.2l3 3.5 3-3.5v7.6" }),
    /* @__PURE__ */ jsx7("path", { d: "M17 8.2v7.4M14.5 13.4l2.5 2.6 2.5-2.6" })
  ] }) });
}
function ShieldMonogram({ size, fill, numeral, textColor }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill, children: [
    /* @__PURE__ */ jsx7("path", { d: "M6.4 5.4h11.2l-1 11.6L12 18.8l-4.6-1.8z", fill: "#ffffff", opacity: "0.96" }),
    /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#89e051", children: /* @__PURE__ */ jsxs6("g", { stroke: "#1e3b0d", strokeWidth: "2", fill: "none", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx7("path", { d: "M7.2 8.4l3.6 3.6-3.6 3.6" }),
    /* @__PURE__ */ jsx7("path", { d: "M12.6 15.6h4.2" })
  ] }) });
}
function JsonIcon({ size }) {
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#cbcb41", children: /* @__PURE__ */ jsxs6("g", { stroke: "#3b3106", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx7("path", { d: "M11.2 6.8c-1.6 0-2.4.8-2.4 2.2v1.2c0 1-.6 1.6-1.7 1.8 1.1.2 1.7.8 1.7 1.8v1.2c0 1.4.8 2.2 2.4 2.2" }),
    /* @__PURE__ */ jsx7("path", { d: "M12.8 6.8c1.6 0 2.4.8 2.4 2.2v1.2c0 1 .6 1.6 1.7 1.8-1.1.2-1.7.8-1.7 1.8v1.2c0 1.4-.8 2.2-2.4 2.2" })
  ] }) });
}
function SqlIcon({ size }) {
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#e38c00", children: /* @__PURE__ */ jsxs6("g", { stroke: "#ffffff", strokeWidth: "1.6", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx7("ellipse", { cx: "12", cy: "7.6", rx: "6", ry: "2.4" }),
    /* @__PURE__ */ jsx7("path", { d: "M6 7.6v8.8c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V7.6" }),
    /* @__PURE__ */ jsx7("path", { d: "M6 12c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4", opacity: "0.65" })
  ] }) });
}
function RubyIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#9b1111", children: [
    /* @__PURE__ */ jsx7("path", { d: "M7.2 8h9.6l3 4-7.8 7.4L4.2 12z", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsxs6("g", { stroke: "#9b1111", strokeWidth: "1.1", fill: "none", strokeLinejoin: "round", children: [
      /* @__PURE__ */ jsx7("path", { d: "M4.2 12h15.6" }),
      /* @__PURE__ */ jsx7("path", { d: "M7.2 8l2.3 4 2.5-4 2.5 4 2.3-4" }),
      /* @__PURE__ */ jsx7("path", { d: "M9.5 12L12 19.4l2.5-7.4" })
    ] })
  ] });
}
function PhpIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#4f5d95", children: [
    /* @__PURE__ */ jsx7("ellipse", { cx: "12", cy: "12", rx: "8.4", ry: "4.7", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#5382a1", children: [
    /* @__PURE__ */ jsx7(
      "path",
      {
        d: "M6.8 10.2h8.4v3.4a3.5 3.5 0 0 1-3.5 3.5h-1.4a3.5 3.5 0 0 1-3.5-3.5z",
        fill: "#ffffff",
        opacity: "0.95"
      }
    ),
    /* @__PURE__ */ jsx7(
      "path",
      {
        d: "M15.4 11h1.2a2 2 0 0 1 0 4h-1.6",
        fill: "none",
        stroke: "#ffffff",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ jsxs6("g", { fill: "none", stroke: "#ffffff", strokeWidth: "1.4", strokeLinecap: "round", children: [
      /* @__PURE__ */ jsx7("path", { d: "M9.4 5.2c0 1.1.9 1.3.9 2.4" }),
      /* @__PURE__ */ jsx7("path", { d: "M12.6 5.2c0 1.1.9 1.3.9 2.4" })
    ] })
  ] });
}
function KotlinIcon({ size }) {
  return /* @__PURE__ */ jsxs6("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx7("path", { d: "M3.4 3.4h17.2v17.2H3.4z", fill: "#a855f7" }),
    /* @__PURE__ */ jsx7("path", { d: "M20.6 3.4L3.4 20.6h17.2z", fill: "#f97316" })
  ] });
}
function LuaIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#000080", children: [
    /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "12.2", r: "6.6", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx7("circle", { cx: "14.1", cy: "10.1", r: "6.6", fill: "#000080" }),
    /* @__PURE__ */ jsx7("circle", { cx: "17.4", cy: "6.6", r: "1.5", fill: "#ffffff" })
  ] });
}
function GearGlyph({ size, fill, letter, letterColor }) {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315];
  return /* @__PURE__ */ jsxs6(Tile, { size, fill, children: [
    /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "12", r: "6.4", fill: "none", stroke: "#ffffff", strokeWidth: "1.7", opacity: "0.95" }),
    teeth.map((deg) => /* @__PURE__ */ jsx7(
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
    letter ? /* @__PURE__ */ jsx7(Monogram, { label: letter, color: letterColor ?? "#57330f" }) : null
  ] });
}
function VueIcon({ size }) {
  return /* @__PURE__ */ jsxs6("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx7("path", { d: "M2.4 4.4h4.9L12 12.2l4.7-7.8h4.9L12 21.2z", fill: "#41b883" }),
    /* @__PURE__ */ jsx7("path", { d: "M7.3 4.4h2.6L12 8l2.1-3.6h2.6L12 13.1z", fill: "#35495e" })
  ] });
}
function GraphqlIcon({ size }) {
  return /* @__PURE__ */ jsxs6("svg", { className: "file-icon-svg", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx7(
      "path",
      {
        d: "M12 5.2l5.9 3.4v6.8L12 18.8l-5.9-3.4V8.6z",
        fill: "none",
        stroke: "#e10098",
        strokeWidth: "1.4"
      }
    ),
    /* @__PURE__ */ jsxs6("g", { fill: "#e10098", children: [
      /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "5.2", r: "1.5" }),
      /* @__PURE__ */ jsx7("circle", { cx: "17.9", cy: "8.6", r: "1.5" }),
      /* @__PURE__ */ jsx7("circle", { cx: "17.9", cy: "15.4", r: "1.5" }),
      /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "18.8", r: "1.5" }),
      /* @__PURE__ */ jsx7("circle", { cx: "6.1", cy: "15.4", r: "1.5" }),
      /* @__PURE__ */ jsx7("circle", { cx: "6.1", cy: "8.6", r: "1.5" })
    ] })
  ] });
}
function ElixirIcon({ size }) {
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#6e4a7e", children: /* @__PURE__ */ jsx7(
    "path",
    {
      d: "M12 3.8c2.5 3.2 5 6.1 5 9.3a5 5 0 0 1-10 0c0-3.2 2.5-6.1 5-9.3z",
      fill: "#c79fe0"
    }
  ) });
}
function CsvIcon({ size }) {
  return /* @__PURE__ */ jsx7(Tile, { size, fill: "#0f9d58", children: /* @__PURE__ */ jsxs6("g", { stroke: "#ffffff", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", children: [
    /* @__PURE__ */ jsx7("rect", { x: "5", y: "6", width: "14", height: "12", rx: "1.6" }),
    /* @__PURE__ */ jsx7("path", { d: "M5 10.1h14M10.3 6v12", opacity: "0.9" })
  ] }) });
}
function ZipIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#b98a3f", children: [
    /* @__PURE__ */ jsx7("rect", { x: "6.6", y: "4.2", width: "10.8", height: "15.6", rx: "1.8", fill: "none", stroke: "#ffffff", strokeWidth: "1.5", opacity: "0.95" }),
    /* @__PURE__ */ jsx7("path", { d: "M12 5.6v12.8", stroke: "#ffffff", strokeWidth: "1.6", strokeDasharray: "2.1 1.9", strokeLinecap: "round" })
  ] });
}
function AndroidIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#3ddc84", children: [
    /* @__PURE__ */ jsx7("path", { d: "M5.9 14.6a6.1 6.1 0 0 1 12.2 0z", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsxs6("g", { stroke: "#ffffff", strokeWidth: "1.4", strokeLinecap: "round", children: [
      /* @__PURE__ */ jsx7("path", { d: "M8.3 6.4L7 4.4" }),
      /* @__PURE__ */ jsx7("path", { d: "M15.7 6.4L17 4.4" })
    ] }),
    /* @__PURE__ */ jsx7("circle", { cx: "9.6", cy: "12", r: "0.85", fill: "#3ddc84" }),
    /* @__PURE__ */ jsx7("circle", { cx: "14.4", cy: "12", r: "0.85", fill: "#3ddc84" })
  ] });
}
function PictureIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#a074c4", children: [
    /* @__PURE__ */ jsx7("circle", { cx: "9.3", cy: "9.6", r: "1.7", fill: "#ffffff", opacity: "0.95" }),
    /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#2aa895", children: [
    /* @__PURE__ */ jsx7(
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
    /* @__PURE__ */ jsx7("circle", { cx: "7.8", cy: "16.8", r: "2.1", fill: "#ffffff" }),
    /* @__PURE__ */ jsx7("circle", { cx: "15.3", cy: "14.8", r: "2.1", fill: "#ffffff" })
  ] });
}
function VideoIcon({ size }) {
  return /* @__PURE__ */ jsxs6(Tile, { size, fill: "#9b4ab8", children: [
    /* @__PURE__ */ jsx7(
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
    /* @__PURE__ */ jsx7("path", { d: "M8.4 10.3l3.8 2.2-3.8 2.2z", fill: "#ffffff" }),
    /* @__PURE__ */ jsx7("path", { d: "M14.8 10.5l4.2-2.5v8l-4.2-2.5z", fill: "#ffffff", opacity: "0.95" })
  ] });
}
function Html5Icon({ size }) {
  return /* @__PURE__ */ jsx7(ShieldMonogram, { size, fill: "#e34f26", numeral: "5", textColor: "#e34f26" });
}
function GenericIcon({ size }) {
  return /* @__PURE__ */ jsxs6(
    "svg",
    {
      className: "file-icon-svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx7(
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
        /* @__PURE__ */ jsx7(
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
        /* @__PURE__ */ jsx7(
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
  return /* @__PURE__ */ jsx7(Tile, { size, fill: bg, children: /* @__PURE__ */ jsx7(Monogram, { label, color: fg }) });
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
  if (ext === "tsx" || ext === "jsx") return /* @__PURE__ */ jsx7(ReactIcon, { size });
  if (ext === "py" || ext === "pyi") return /* @__PURE__ */ jsx7(PythonIcon, { size });
  if (ext === "md" || ext === "markdown" || ext === "mdx") return /* @__PURE__ */ jsx7(MarkdownIcon, { size });
  if (ext === "css") return /* @__PURE__ */ jsx7(ShieldMonogram, { size, fill: "#264de4", numeral: "3", textColor: "#264de4" });
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return /* @__PURE__ */ jsx7(ShellIcon, { size });
  if (ext === "json" || ext === "jsonc") return /* @__PURE__ */ jsx7(JsonIcon, { size });
  if (ext === "sql") return /* @__PURE__ */ jsx7(SqlIcon, { size });
  if (ext === "rb") return /* @__PURE__ */ jsx7(RubyIcon, { size });
  if (ext === "php") return /* @__PURE__ */ jsx7(PhpIcon, { size });
  if (ext === "java" || ext === "jar" || ext === "war") return /* @__PURE__ */ jsx7(JavaIcon, { size });
  if (ext === "kt") return /* @__PURE__ */ jsx7(KotlinIcon, { size });
  if (ext === "lua") return /* @__PURE__ */ jsx7(LuaIcon, { size });
  if (ext === "rs") return /* @__PURE__ */ jsx7(GearGlyph, { size, fill: "#dea584", letter: "R" });
  if (ext === "vue") return /* @__PURE__ */ jsx7(VueIcon, { size });
  if (ext === "graphql" || ext === "gql") return /* @__PURE__ */ jsx7(GraphqlIcon, { size });
  if (ext === "ex" || ext === "exs") return /* @__PURE__ */ jsx7(ElixirIcon, { size });
  if (ext === "csv" || ext === "tsv") return /* @__PURE__ */ jsx7(CsvIcon, { size });
  if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "bz2" || ext === "xz" || ext === "7z" || ext === "rar") return /* @__PURE__ */ jsx7(ZipIcon, { size });
  if (ext === "apk" || ext === "aab") return /* @__PURE__ */ jsx7(AndroidIcon, { size });
  if (ext === "dylib" || ext === "so" || ext === "dll" || ext === "exe" || ext === "bin") return /* @__PURE__ */ jsx7(GearGlyph, { size, fill: "#6b7280" });
  if (ext === "wasm") return /* @__PURE__ */ jsx7(GearGlyph, { size, fill: "#654ff0", letter: "W", letterColor: "#ffffff" });
  if (ext === "html" || ext === "htm") return /* @__PURE__ */ jsx7(Html5Icon, { size });
  if (IMAGE_EXTS.has(ext)) return /* @__PURE__ */ jsx7(PictureIcon, { size });
  if (AUDIO_EXTS.has(ext)) return /* @__PURE__ */ jsx7(AudioIcon, { size });
  if (VIDEO_EXTS.has(ext)) return /* @__PURE__ */ jsx7(VideoIcon, { size });
  if (badge) {
    return /* @__PURE__ */ jsx7(BadgeIcon, { label: badge.label, bg: badge.bg, fg: badge.fg, size });
  }
  return /* @__PURE__ */ jsx7(GenericIcon, { size });
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
  return /* @__PURE__ */ jsxs6(
    "button",
    {
      type: "button",
      className: `file-chip${className ? ` ${className}` : ""}`,
      dir: "ltr",
      title: `${path}${line ? `:${line}` : ""} \u2014 click to open`,
      onClick: handle,
      children: [
        /* @__PURE__ */ jsx7(FileIcon, { path, size: 20 }),
        /* @__PURE__ */ jsx7("span", { className: "file-chip-name", dir: "ltr", children: label })
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

// src/lib/fileTree.ts
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "dir";
    const bDir = b.kind === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
}
function mergeChildren(cache, dir, entries) {
  return { ...cache, [dir]: sortEntries(entries ?? []) };
}
function toggleExpanded(expanded, dir) {
  const next = new Set(expanded);
  if (next.has(dir)) next.delete(dir);
  else next.add(dir);
  return next;
}
function isLoaded(cache, dir) {
  return Object.prototype.hasOwnProperty.call(cache, dir);
}
function isExpandable(cache, entry) {
  if (entry.kind !== "dir") return false;
  const kids = cache[entry.path];
  return !(kids && kids.length === 0);
}
function flattenTree(cache, expanded, dir = "", depth = 0) {
  const children = cache[dir];
  if (!children) return [];
  const rows = [];
  for (const entry of children) {
    const isDir = entry.kind === "dir";
    const open = isDir && expanded.has(entry.path);
    rows.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      depth,
      expanded: open,
      expandable: isExpandable(cache, entry)
    });
    if (open) rows.push(...flattenTree(cache, expanded, entry.path, depth + 1));
  }
  return rows;
}
function pruneSubtree(cache, dir) {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const next = {};
  for (const key of Object.keys(cache)) {
    if (key === dir || key.startsWith(prefix)) continue;
    next[key] = cache[key];
  }
  return next;
}
function parentPath(path) {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}
function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
function isInside(dir, path) {
  if (!dir) return false;
  return path === dir || path.startsWith(`${dir}/`);
}
function moveTarget(from, ontoDir) {
  if (isInside(from, ontoDir)) return null;
  if (ontoDir === parentPath(from)) return null;
  return ontoDir;
}
function copyName(name, taken) {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  let candidate = `${base} copy${ext}`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base} copy ${i}${ext}`;
  return candidate;
}
function rootPrefix(root) {
  return root.replace(/\/+$/, "");
}
function toWorkspacePath(root, path) {
  if (!root || !path.startsWith("/")) return path;
  const dir = rootPrefix(root);
  if (!dir || !path.startsWith(`${dir}/`)) return path;
  return path.slice(dir.length + 1);
}
function isInWorkspace(root, path) {
  if (!path) return false;
  if (!path.startsWith("/") && !path.startsWith("~/")) return true;
  if (!root) return true;
  if (path.startsWith("~/")) return false;
  const dir = rootPrefix(root);
  return path === dir || path.startsWith(`${dir}/`);
}
function splitWorkspaceFiles(files, root) {
  const inside = [];
  const outside = [];
  for (const f of files) {
    if (isInWorkspace(root, f.path)) inside.push(f);
    else outside.push(f);
  }
  return { inside, outside };
}
var init_fileTree = __esm({
  "src/lib/fileTree.ts"() {
    "use strict";
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

// src/lib/hoverCardPos.ts
function diffPopupPos(rect, vw, vh, width = DIFF_POP_W, gap = 8) {
  const viewW = vw || 1200;
  const viewH = vh || 800;
  const w = Math.max(240, Math.min(width, viewW - 16));
  const left = Math.min(Math.max(rect.left, 8), Math.max(viewW - w - 8, 8));
  const below = viewH - rect.bottom - gap - 8;
  const above = rect.top - gap - 8;
  if (below < DIFF_POP_MIN_H && above > below) {
    const maxHeight2 = Math.max(DIFF_POP_MIN_H, Math.min(DIFF_POP_H, above));
    return { top: Math.max(8, rect.top - gap - maxHeight2), left, width: w, maxHeight: maxHeight2 };
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

// src/components/ToolCallView.tsx
import {
  Fragment as Fragment2,
  memo,
  useEffect as useEffect4,
  useLayoutEffect,
  useRef as useRef3,
  useState as useState4,
  useMemo,
  useCallback as useCallback2
} from "react";
import { createPortal } from "react-dom";
import { Fragment as Fragment3, jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
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
  const [now, setNow] = useState4(() => Date.now());
  useEffect4(() => {
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
  return /* @__PURE__ */ jsx8(
    "svg",
    {
      className,
      width: "14",
      height: "14",
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx8("path", { d: "M12 1L14.5 9.5L23 12L14.5 14.5L12 23L9.5 14.5L1 12L9.5 9.5Z" })
    }
  );
}
function IconChevron({
  open,
  className
}) {
  return /* @__PURE__ */ jsx8(
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
      children: /* @__PURE__ */ jsx8("path", { d: "M9 18l6-6-6-6" })
    }
  );
}
function IconCheck({ className }) {
  return /* @__PURE__ */ jsx8(
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
      children: /* @__PURE__ */ jsx8("path", { d: "M20 6L9 17l-5-5" })
    }
  );
}
function IconX({ className }) {
  return /* @__PURE__ */ jsx8(
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
      children: /* @__PURE__ */ jsx8("path", { d: "M18 6L6 18M6 6l12 12" })
    }
  );
}
function StatusIcon({ status }) {
  if (status === "running") return /* @__PURE__ */ jsx8("span", { className: "spinner" });
  if (status === "error") return /* @__PURE__ */ jsx8(IconX, { className: "status-err" });
  if (status === "denied") return /* @__PURE__ */ jsx8("span", { className: "status-denied", children: "\u23F9" });
  return /* @__PURE__ */ jsx8(IconCheck, { className: "status-ok" });
}
function TerminalRowIcon() {
  return /* @__PURE__ */ jsxs7(
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
        /* @__PURE__ */ jsx8("path", { d: "M5 7l5 5-5 5" }),
        /* @__PURE__ */ jsx8("path", { d: "M13 17h6" })
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
  const entries = Object.entries(args).filter(
    ([k]) => !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k) && !skip?.has(k)
  );
  if (entries.length === 0) return null;
  return /* @__PURE__ */ jsx8("span", { className: "tool-args", dir: "ltr", children: entries.map(([k, v]) => /* @__PURE__ */ jsxs7("span", { className: "tool-arg", children: [
    /* @__PURE__ */ jsx8("span", { className: "tool-arg-key", children: k }),
    /* @__PURE__ */ jsx8("span", { className: "tool-arg-val", children: fmtArgValue(v) })
  ] }, k)) });
}
function argsTextFor(activity) {
  const args = activity.args;
  if (!args) return "";
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(activity.tool)];
  return Object.entries(args).filter(([k]) => !skip?.has(k)).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
}
function rowDetail(activity) {
  if (canonicalTool(activity.tool) === "load_skill") {
    const name = String(activity.args?.name ?? activity.args?.file ?? "");
    if (name) return shortArg(name, 60);
  }
  return activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
}
function TomlLine({ text }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#")) return /* @__PURE__ */ jsx8("span", { className: "toml-comment", children: text });
  const eq = text.indexOf("=");
  if (eq < 0) return /* @__PURE__ */ jsx8(Fragment3, { children: text });
  const key = text.slice(0, eq).trimEnd();
  const rest = text.slice(eq);
  const value = rest.slice(1).trimStart();
  const isString = value.startsWith('"') || value.startsWith("'");
  return /* @__PURE__ */ jsxs7(Fragment3, { children: [
    /* @__PURE__ */ jsx8("span", { className: "toml-key", children: key }),
    /* @__PURE__ */ jsx8("span", { className: "toml-eq", children: " = " }),
    /* @__PURE__ */ jsx8("span", { className: isString ? "toml-string" : "toml-value", children: rest.slice(1).trimStart() })
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
    return /* @__PURE__ */ jsx8(Fragment3, { children: highlightParts(text, q, hitBase, activeHit, activeRef) });
  if (path && path.split("?")[0].toLowerCase().endsWith(".toml")) {
    return /* @__PURE__ */ jsx8(TomlLine, { text });
  }
  if (html != null) {
    return /* @__PURE__ */ jsx8(
      "span",
      {
        className: "diff-code",
        dir: "auto",
        dangerouslySetInnerHTML: { __html: html === "" ? "\n" : html }
      }
    );
  }
  const segments = splitCommentSegments(text, commentSpans);
  if (segments.length === 1 && !segments[0].comment) return /* @__PURE__ */ jsx8(Fragment3, { children: text });
  return /* @__PURE__ */ jsx8(Fragment3, { children: segments.map(
    (seg, i) => seg.comment ? /* @__PURE__ */ jsx8("span", { className: "diff-comment", children: seg.text }, i) : /* @__PURE__ */ jsx8("span", { children: seg.text }, i)
  ) });
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
      if (i < text.length) out.push(/* @__PURE__ */ jsx8("span", { children: text.slice(i) }, k++));
      break;
    }
    if (j > i) out.push(/* @__PURE__ */ jsx8("span", { children: text.slice(i, j) }, k++));
    const idx = base + ordinal;
    ordinal++;
    const isActive = idx === active;
    out.push(
      /* @__PURE__ */ jsx8(
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
  const openedAt = useRef3(0);
  const open = useCallback2((el, diff2, path) => {
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
  const close = useCallback2(() => setSnap(null), []);
  const keep = useCallback2(() => {
    openedAt.current = Date.now();
  }, []);
  useEffect4(() => {
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
  const measureRef = useRef3(null);
  const [measuredWidth, setMeasuredWidth] = useState4(0);
  useEffect4(() => {
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
  const lang = languageOfPath(path);
  const { beforeHtml, afterHtml, beforeSpans, afterSpans } = useMemo(() => {
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
  const activeRef = useRef3(null);
  useEffect4(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff2]);
  const chatId = useStore((s) => s.activeChatId);
  const [box, setBox] = useState4(null);
  const [selBar, setSelBar] = useState4(null);
  const [note, setNote] = useState4("");
  const commentInputRef = useRef3(null);
  useEffect4(() => {
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
  useEffect4(() => {
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
  const renderRow = (key, cls, gutter, lineNo, text, side) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q) hitCursor += countOccurrences(text, q);
    return /* @__PURE__ */ jsxs7("div", { className: `diff-u-row ${cls}`, children: [
      /* @__PURE__ */ jsx8("span", { className: "diff-u-gutter", children: gutter }),
      /* @__PURE__ */ jsx8("span", { className: "diff-u-num", children: lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx8("span", { className: "diff-u-text", children: /* @__PURE__ */ jsx8(
        DiffLineText,
        {
          text,
          path,
          html: side === "before" ? beforeHtml.get(lineNo) : side === "after" ? afterHtml.get(lineNo) : afterHtml.get(lineNo) ?? beforeHtml.get(lineNo),
          commentSpans: side === "before" ? beforeSpans.get(lineNo) : side === "after" ? afterSpans.get(lineNo) : afterSpans.get(lineNo) ?? beforeSpans.get(lineNo),
          query,
          hitBase: base,
          activeHit,
          activeRef
        }
      ) })
    ] }, key);
  };
  const renderSideCell = (key, cls, lineNo, text, empty, side) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    const marker = cls === "diff-line-del" ? "-" : cls === "diff-line-add" ? "+" : " ";
    return /* @__PURE__ */ jsxs7("span", { className: `diff-line ${cls}`, children: [
      /* @__PURE__ */ jsx8("span", { className: "diff-u-gutter", children: empty ? "" : marker }),
      /* @__PURE__ */ jsx8("span", { className: "diff-u-num", children: !empty && lineNo >= 0 ? lineNo : "" }),
      /* @__PURE__ */ jsx8("span", { className: "diff-u-text", children: !empty ? /* @__PURE__ */ jsx8(
        DiffLineText,
        {
          text,
          path,
          html: side === "before" ? beforeHtml.get(lineNo) : afterHtml.get(lineNo),
          commentSpans: side === "before" ? beforeSpans.get(lineNo) : afterSpans.get(lineNo),
          query,
          hitBase: base,
          activeHit,
          activeRef
        }
      ) : "\xA0" })
    ] }, key);
  };
  const renderSide = () => /* @__PURE__ */ jsxs7("div", { className: "diff-columns", dir: "ltr", ...drag, children: [
    /* @__PURE__ */ jsxs7("div", { className: "diff-columns-head", children: [
      /* @__PURE__ */ jsx8("div", { className: "diff-col-header diff-col-before", children: "Before" }),
      /* @__PURE__ */ jsx8("div", { className: "diff-col-header diff-col-after", children: "After" })
    ] }),
    sideItems.map((item) => {
      if (item.kind === "gap") {
        return /* @__PURE__ */ jsxs7("div", { className: "diff-gap", children: [
          item.count,
          " unmodified lines"
        ] }, item.key);
      }
      const metas = item.rows.filter((r) => "text" in r);
      const contents = item.rows.filter((r) => !("text" in r));
      return /* @__PURE__ */ jsxs7("div", { className: "diff-hunk-pair", children: [
        metas.map((m, mi) => /* @__PURE__ */ jsx8("div", { className: `diff-u-meta ${m.type}`, children: "text" in m ? m.text : "" }, `${item.key}-m${mi}`)),
        /* @__PURE__ */ jsx8("div", { className: "diff-col diff-col-before", children: /* @__PURE__ */ jsx8("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
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
        /* @__PURE__ */ jsx8("div", { className: "diff-col diff-col-after", children: /* @__PURE__ */ jsx8("pre", { className: "diff-col-code", children: contents.map((r, ri) => {
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
  const renderUnified = () => /* @__PURE__ */ jsx8("div", { className: "diff-unified", dir: "ltr", ...drag, children: rows.flatMap((row, i) => {
    if ("text" in row) {
      return /* @__PURE__ */ jsx8("div", { className: `diff-u-meta ${row.type}`, children: row.text }, i);
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
  return /* @__PURE__ */ jsxs7(
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
          /* @__PURE__ */ jsxs7(
            "div",
            {
              className: "fv-sel-bar",
              style: { position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 },
              onMouseUp: (e) => e.stopPropagation(),
              onKeyUp: (e) => e.stopPropagation(),
              children: [
                /* @__PURE__ */ jsx8(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Copy",
                    "aria-label": "Copy selection",
                    onClick: copySelection,
                    children: /* @__PURE__ */ jsxs7("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx8("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
                      /* @__PURE__ */ jsx8("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                    ] })
                  }
                ),
                /* @__PURE__ */ jsx8(
                  "button",
                  {
                    type: "button",
                    className: "fv-sel-btn",
                    title: "Reply",
                    "aria-label": "Reply to selection",
                    onClick: openBox,
                    children: /* @__PURE__ */ jsxs7("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                      /* @__PURE__ */ jsx8("polyline", { points: "9 17 4 12 9 7" }),
                      /* @__PURE__ */ jsx8("path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" })
                    ] })
                  }
                )
              ]
            }
          ),
          document.body
        ) : null,
        commentable && box && typeof document !== "undefined" ? createPortal(
          /* @__PURE__ */ jsx8(
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
              children: /* @__PURE__ */ jsx8(
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
function shortArg(s, max) {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}\u2026`;
}
function subArgSummary(activity) {
  const args = activity.args;
  if (!args) return "";
  const parts = [];
  if (canonicalTool(activity.tool) === "load_skill") {
    const skill = String(args.name ?? args.file ?? "");
    if (skill) return shortArg(skill, 60);
    const q = String(args.query ?? "");
    return q ? shortArg(q, 48) : "";
  }
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
function ToolPathSpan({ path }) {
  const open = (e) => {
    e.stopPropagation();
    openWorkspaceFile(path);
  };
  return /* @__PURE__ */ jsxs7(
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
        /* @__PURE__ */ jsx8(FileIcon, { path, size: 20 }),
        fileBasename(path)
      ]
    }
  );
}
var TICK_MS, sharedTickId, tickListeners, TOOL_LABEL, TOOL_ALIAS, TOOL_ICON, isSubagentCard, EDIT_TOOLS, isEditActivity, ToolEditGroupView, InlineWebResults, WEB_RESULTS_VISIBLE, WebResultLinks, TerminalResultText, FileResultLinks, HEADER_SHOWN_KEYS, HIDDEN_KEYS, REDUNDANT_ARG_KEYS, DIFF_SIDE_BY_SIDE_THRESHOLD, DiffPreview, ToolGroupView, ToolSubRow, TraceRow, ToolTimelineRow, PREVIEW_COUNT, ToolCascade, TraceNarration, ToolSingleRow, ToolCallView;
var init_ToolCallView = __esm({
  "src/components/ToolCallView.tsx"() {
    "use strict";
    init_store();
    init_toolActivity();
    init_reviewTurn();
    init_reviewDiff();
    init_diffSearch();
    init_diffComments();
    init_highlight();
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
    init_fileTree();
    init_selectionBar();
    init_mcpTools();
    init_hoverCardPos();
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
    isSubagentCard = (a) => a.tool === "explore";
    EDIT_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
    isEditActivity = (a) => EDIT_TOOLS.has(a.tool);
    ToolEditGroupView = memo(function ToolEditGroupView2({
      activities,
      messageId,
      chatId,
      onReverted
    }) {
      const [open, setOpen] = useState4(true);
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const [reverting, setReverting] = useState4(null);
      const preview = useDiffPreview();
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
          const { content: current } = await api.fsRead(root, path) ?? {};
          const oldContent = applyReverseDiff(entry.activity.diff, current ?? "");
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
          const base = path.split("/").pop() || path;
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
                  title: path ? toWorkspacePath(root, path) : void 0,
                  onClick: () => messageId && openReview(messageId, path),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (messageId) openReview(messageId, path);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsx8(StatusIcon, { status: entry.activity.status }),
                    /* @__PURE__ */ jsx8(FileIcon, { path, size: 20 }),
                    /* @__PURE__ */ jsx8("span", { className: "edit-group-file", dir: "auto", children: base }),
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
        preview.snap && typeof document !== "undefined" && createPortal(
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
    InlineWebResults = memo(function InlineWebResults2({
      activity
    }) {
      const rows = activity.items ?? activity.results;
      if (!isWebRow(activity) || !rows || rows.length === 0) return null;
      return /* @__PURE__ */ jsx8("div", { className: "trace-row-inline-results", children: /* @__PURE__ */ jsx8(WebResultLinks, { items: rows }) });
    });
    WEB_RESULTS_VISIBLE = 3;
    WebResultLinks = memo(function WebResultLinks2({
      items
    }) {
      const [showAll, setShowAll] = useState4(false);
      if (!items || items.length === 0) return null;
      const fetchInfo = items.filter((it) => typeof it.fetched === "boolean");
      const fetchedCount = fetchInfo.filter((it) => it.fetched).length;
      const visible = showAll ? items : items.slice(0, WEB_RESULTS_VISIBLE);
      const hidden = items.length - visible.length;
      return /* @__PURE__ */ jsxs7(Fragment3, { children: [
        fetchInfo.length > 0 && /* @__PURE__ */ jsxs7("div", { className: "web-results-head", dir: "auto", children: [
          /* @__PURE__ */ jsx8("span", { className: "web-results-count", children: `${items.length} result${items.length === 1 ? "" : "s"}` }),
          /* @__PURE__ */ jsx8("span", { className: "web-results-sep", "aria-hidden": "true", children: "\xB7" }),
          /* @__PURE__ */ jsx8(
            "span",
            {
              className: `web-results-fetched${fetchedCount === 0 ? " none" : ""}`,
              title: "Results whose real page content was fetched. The rest reached the model as a short snippet only.",
              children: `${fetchedCount} fetched`
            }
          )
        ] }),
        /* @__PURE__ */ jsx8("ul", { className: "web-results", dir: "auto", children: visible.map((it, i) => {
          const host = hostOf(it.url);
          return /* @__PURE__ */ jsx8("li", { className: "web-result", children: /* @__PURE__ */ jsxs7(
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
                /* @__PURE__ */ jsx8("span", { className: "web-result-favicon", "aria-hidden": "true", children: host ? /* @__PURE__ */ jsx8(
                  "img",
                  {
                    src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
                    alt: "",
                    loading: "lazy",
                    width: 16,
                    height: 16
                  }
                ) : /* @__PURE__ */ jsx8("span", { className: "web-result-glyph", children: "\u{1F517}" }) }),
                /* @__PURE__ */ jsxs7("span", { className: "web-result-text", children: [
                  /* @__PURE__ */ jsx8("span", { className: "web-result-title", children: it.title || it.url }),
                  it.snippet && /* @__PURE__ */ jsx8("span", { className: "web-result-snippet", children: it.snippet })
                ] }),
                it.fetched === false && /* @__PURE__ */ jsx8(
                  "span",
                  {
                    className: "web-result-fetched",
                    title: "This page could not be fetched \u2014 only the short search snippet reached the model.",
                    children: "snippet"
                  }
                ),
                /* @__PURE__ */ jsx8("span", { className: "web-result-host", children: host }),
                /* @__PURE__ */ jsx8("span", { className: "web-result-arrow", "aria-hidden": "true", children: "\u2197" })
              ]
            }
          ) }, i);
        }) }),
        hidden > 0 && /* @__PURE__ */ jsx8(
          "button",
          {
            type: "button",
            className: "web-result-more-btn",
            onClick: () => setShowAll(true),
            title: "Show every result",
            children: `+${hidden} more`
          }
        ),
        showAll && items.length > WEB_RESULTS_VISIBLE && /* @__PURE__ */ jsx8(
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
      return /* @__PURE__ */ jsx8(
        "pre",
        {
          className: "trace-expand-val trace-expand-pre trace-terminal-output",
          dir: "ltr",
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
      return /* @__PURE__ */ jsx8("ul", { className: "file-results", dir: "ltr", "aria-label": `${tool} results`, children: deduped.map((it, i) => {
        const file = String(it.file ?? it.path ?? "");
        if (!file) return null;
        const line = it.line !== void 0 && it.line !== null ? String(it.line) : "";
        const text = String(it.text ?? "");
        return /* @__PURE__ */ jsxs7("li", { className: "file-result", children: [
          /* @__PURE__ */ jsx8(
            FileChip,
            {
              path: file,
              line: line ? Number(line) : void 0,
              display: `${fileBasename(file)}${line ? `:${line}` : ""}`
            }
          ),
          text && /* @__PURE__ */ jsx8("span", { className: "file-result-text", children: text })
        ] }, i);
      }) });
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
      load_skill: /* @__PURE__ */ new Set(["name", "file", "query"])
    };
    DIFF_SIDE_BY_SIDE_THRESHOLD = 768;
    DiffPreview = memo(function DiffPreview2({
      diff: diff2,
      path,
      pos,
      onClose,
      onPress
    }) {
      const basename = path ? path.split("/").pop() ?? path : "";
      return /* @__PURE__ */ jsxs7(
        "div",
        {
          className: "diff-preview-card",
          style: {
            position: "fixed",
            top: pos.top,
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
            /* @__PURE__ */ jsxs7("div", { className: "diff-preview-head", children: [
              path && /* @__PURE__ */ jsx8(FileIcon, { path, size: 16 }),
              /* @__PURE__ */ jsx8("span", { className: "diff-preview-path", dir: "auto", title: path, children: basename }),
              /* @__PURE__ */ jsx8(
                "button",
                {
                  type: "button",
                  className: "diff-preview-close",
                  title: "Close preview",
                  "aria-label": "Close diff preview",
                  onClick: onClose,
                  children: /* @__PURE__ */ jsxs7("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx8("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                    /* @__PURE__ */ jsx8("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
                  ] })
                }
              )
            ] }),
            /* @__PURE__ */ jsx8("div", { className: "diff-preview-body", children: /* @__PURE__ */ jsx8(DiffView, { diff: diff2, path, layout: "unified" }) })
          ]
        }
      );
    });
    ToolGroupView = memo(function ToolGroupView2({
      activities,
      captions
    }) {
      const [open, setOpen] = useState4(
        () => activities.some(({ activity }) => isWebRow(activity))
      );
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
      return /* @__PURE__ */ jsxs7(
        "div",
        {
          className: `tool-group ${open ? "open" : ""} ${running ? "running" : "done"}`,
          children: [
            /* @__PURE__ */ jsxs7(
              "button",
              {
                className: `trace-head ${open ? "open" : ""}`,
                onClick: () => setOpen((o) => !o),
                children: [
                  /* @__PURE__ */ jsx8(IconSparkle, { className: "trace-sparkle" }),
                  /* @__PURE__ */ jsxs7("span", { className: "trace-head-pills", children: [
                    Object.entries(toolCounts).map(([label, n]) => /* @__PURE__ */ jsxs7("span", { className: "trace-pill", children: [
                      label,
                      n > 1 && /* @__PURE__ */ jsxs7("span", { className: "trace-pill-count", children: [
                        "\xD7",
                        n
                      ] })
                    ] }, label)),
                    subagentPills.map(({ key, label, desc, running: running2 }) => /* @__PURE__ */ jsxs7(
                      "span",
                      {
                        className: `trace-pill trace-pill-sub${running2 ? " running" : ""}`,
                        title: desc || label,
                        children: [
                          label,
                          desc && /* @__PURE__ */ jsx8("span", { className: "trace-pill-desc", children: desc })
                        ]
                      },
                      `sub-${key}`
                    ))
                  ] }),
                  searchEngines.map((engine) => /* @__PURE__ */ jsx8(
                    "span",
                    {
                      className: "trace-row-engine",
                      title: "Web search provider",
                      children: webProviderLabel(engine)
                    },
                    engine
                  )),
                  headCaption && /* @__PURE__ */ jsx8("span", { className: "trace-head-caption", dir: "auto", title: prepareContent(headCaption), children: prepareContent(headCaption) }),
                  /* @__PURE__ */ jsxs7("span", { className: "trace-head-right", children: [
                    totalMs > 0 && /* @__PURE__ */ jsx8("span", { className: "trace-time", children: fmtTime(totalMs) }),
                    /* @__PURE__ */ jsx8(IconChevron, { open, className: "trace-chev" })
                  ] })
                ]
              }
            ),
            open && /* @__PURE__ */ jsx8("div", { className: "trace-list", children: activities.map(({ activity, index }, i) => /* @__PURE__ */ jsxs7(Fragment2, { children: [
              captions?.[i] && /* @__PURE__ */ jsx8("div", { className: "trace-narration", dir: "auto", children: prepareContent(captions[i]) }),
              /* @__PURE__ */ jsx8(TraceRow, { activity })
            ] }, index)) })
          ]
        }
      );
    });
    ToolSubRow = memo(function ToolSubRow2({
      activity,
      hideResult
    }) {
      const [now, setNow] = useState4(() => Date.now());
      const running = activity.status === "running";
      useEffect4(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const subSummary = subArgSummary(activity);
      return /* @__PURE__ */ jsxs7(Fragment3, { children: [
        /* @__PURE__ */ jsxs7(
          "div",
          {
            className: `tool-sub-row ${activity.status}${running ? " running" : ""}`,
            children: [
              /* @__PURE__ */ jsx8(StatusIcon, { status: activity.status }),
              /* @__PURE__ */ jsx8("span", { className: "tool-sub-name", children: toolLabel(activity.tool) }),
              /* @__PURE__ */ jsx8("span", { className: "tool-sub-args", title: subSummary, children: subSummary }),
              activity.summary && canonicalTool(activity.tool) !== "load_skill" && /* @__PURE__ */ jsx8("span", { className: "tool-sub-summary", children: fixZwsp(activity.summary) }),
              /* @__PURE__ */ jsx8("span", { className: "tool-ms", children: fmtTime(ms) })
            ]
          }
        ),
        activity.resultText && !hideResult && /* @__PURE__ */ jsx8("pre", { className: "tool-sub-result", dir: "auto", children: activity.resultText })
      ] });
    });
    TraceRow = memo(function TraceRow2({
      activity
    }) {
      const [now, setNow] = useState4(() => Date.now());
      const [expanded, setExpanded] = useState4(
        () => activity.tool === "edit_file" || activity.tool === "write_file" || isWebRow(activity)
      );
      const running = activity.status === "running";
      useEffect4(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const label = toolLabel(activity.tool);
      const detail = rowDetail(activity);
      const argsText2 = argsTextFor(activity);
      const isEdit = activity.tool === "edit_file" || activity.tool === "write_file";
      const onHeadClick = () => setExpanded((e) => !e);
      return /* @__PURE__ */ jsxs7(
        "div",
        {
          className: `trace-row ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs7(
              "button",
              {
                className: "trace-row-head",
                onClick: onHeadClick,
                children: [
                  /* @__PURE__ */ jsx8("span", { className: "trace-row-bullet", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx8("span", { className: "spinner" }) : activity.tool === "run_terminal" ? /* @__PURE__ */ jsx8(TerminalRowIcon, {}) : "\u2022" }),
                  /* @__PURE__ */ jsx8("span", { className: "trace-pill", children: label }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx8("span", { className: "trace-row-engine", title: "Web search provider", children: webProviderLabel(activity.engine) }),
                  /* @__PURE__ */ jsx8("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  /* @__PURE__ */ jsxs7("span", { className: "trace-row-end", children: [
                    ms ? /* @__PURE__ */ jsx8("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx8(StatusIcon, { status: activity.status }),
                    /* @__PURE__ */ jsx8(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded && /* @__PURE__ */ jsxs7("div", { className: "trace-row-expand", children: [
              ms ? /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Duration" }),
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-val", children: fmtTime(ms) })
              ] }) : null,
              activity.summary && canonicalTool(activity.tool) !== "load_skill" && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Summary" }),
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-val", dir: "auto", children: fixZwsp(activity.summary) })
              ] }),
              argsText2 && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Args" }),
                /* @__PURE__ */ jsx8("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: argsText2 })
              ] }),
              activity.diff && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Diff" }),
                /* @__PURE__ */ jsx8(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre trace-expand-diff",
                    dir: "auto",
                    children: activity.diff
                  }
                )
              ] }),
              activity.resultText && activity.tool !== "run_terminal" && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Result" }),
                /* @__PURE__ */ jsx8("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: activity.resultText })
              ] }),
              isWebRow(activity) && /* @__PURE__ */ jsx8(InlineWebResults, { activity }),
              !isWebRow(activity) && (((activity.items ?? activity.results)?.length ?? 0) > 0 || activity.tool === "run_terminal" && Boolean(activity.resultText)) && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Results" }),
                activity.tool === "run_terminal" ? /* @__PURE__ */ jsx8(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                ) : /* @__PURE__ */ jsx8(
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
      const [now, setNow] = useState4(() => Date.now());
      const running = activity.status === "running";
      useEffect4(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const detail = subArgSummary(activity);
      return /* @__PURE__ */ jsxs7("div", { className: `tool-timeline-item ${activity.status}`, children: [
        /* @__PURE__ */ jsx8("span", { className: "tool-timeline-icon", "aria-hidden": "true", children: running ? /* @__PURE__ */ jsx8("span", { className: "spinner" }) : toolIcon(activity.tool) }),
        /* @__PURE__ */ jsx8("span", { className: "tool-timeline-label", children: toolLabel(activity.tool) }),
        detail && /* @__PURE__ */ jsx8("span", { className: "tool-timeline-detail", title: detail, children: detail }),
        /* @__PURE__ */ jsx8(StatusIcon, { status: activity.status }),
        /* @__PURE__ */ jsx8("span", { className: "tool-ms", children: fmtTime(ms) }),
        (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && (activity.tool === "web_search" || activity.tool === "fetch_url" ? /* @__PURE__ */ jsx8(WebResultLinks, { items: activity.items ?? activity.results }) : /* @__PURE__ */ jsx8(
          FileResultLinks,
          {
            tool: activity.tool,
            items: activity.items ?? activity.results
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
      return /* @__PURE__ */ jsx8("div", { className: "tool-cascade", ref: listRef, children: last.map((a, i) => /* @__PURE__ */ jsx8(
        "div",
        {
          "data-key": a.callId ?? `${a.tool}-${i}`,
          className: "tool-cascade-item",
          style: { zIndex: i + 1 },
          children: /* @__PURE__ */ jsx8(ToolSubRow, { activity: a, hideResult: true })
        },
        a.callId ?? `${a.tool}-${i}`
      )) });
    });
    TraceNarration = memo(function TraceNarration2({
      text
    }) {
      return /* @__PURE__ */ jsx8("div", { className: "trace-narration", dir: "auto", children: prepareContent(text) });
    });
    ToolSingleRow = memo(function ToolSingleRow2({
      activity,
      messageId
    }) {
      const [now, setNow] = useState4(() => Date.now());
      const [expanded, setExpanded] = useState4(() => isWebRow(activity));
      const preview = useDiffPreview();
      const running = activity.status === "running";
      useEffect4(() => {
        if (!running) return;
        const t = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(t);
      }, [running]);
      const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const label = toolLabel(activity.tool);
      const detail = rowDetail(activity);
      const argsText2 = argsTextFor(activity);
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
      return /* @__PURE__ */ jsxs7(
        "div",
        {
          className: `trace-row single ${activity.status}${running ? " running" : ""}${expanded ? " expanded" : ""}${isEdit ? " edit-file" : ""}`,
          children: [
            /* @__PURE__ */ jsxs7(
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
                  /* @__PURE__ */ jsx8(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx8("span", { className: "trace-pill", children: label }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx8("span", { className: "trace-row-engine", title: "Web search provider", children: webProviderLabel(activity.engine) }),
                  isEdit ? /* @__PURE__ */ jsx8(
                    "span",
                    {
                      className: "trace-row-detail",
                      dir: "auto",
                      title: reviewPathOf(activity),
                      children: reviewPathOf(activity).split("/").pop()
                    }
                  ) : /* @__PURE__ */ jsx8("span", { className: "trace-row-detail", dir: "auto", title: detail ?? "", children: detail }),
                  /* @__PURE__ */ jsxs7("span", { className: "trace-row-end", children: [
                    isEdit && diffStats && /* @__PURE__ */ jsx8("span", { className: "trace-row-diff-stats", children: diffStats }),
                    isEdit && activity.diff && /* @__PURE__ */ jsx8(
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
                    ms ? /* @__PURE__ */ jsx8("span", { className: "trace-row-ms", children: fmtTime(ms) }) : null,
                    /* @__PURE__ */ jsx8(IconChevron, { open: expanded, className: "trace-row-chev" })
                  ] })
                ]
              }
            ),
            expanded ? /* @__PURE__ */ jsxs7("div", { className: "trace-row-expand", children: [
              ms ? /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Duration" }),
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-val", children: fmtTime(ms) })
              ] }) : null,
              activity.summary && canonicalTool(activity.tool) !== "load_skill" && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Summary" }),
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-val", dir: "auto", children: fixZwsp(activity.summary) })
              ] }),
              argsText2 && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Args" }),
                /* @__PURE__ */ jsx8("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: argsText2 })
              ] }),
              activity.diff && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Diff" }),
                /* @__PURE__ */ jsx8(
                  "pre",
                  {
                    className: "trace-expand-val trace-expand-pre trace-expand-diff",
                    dir: "auto",
                    children: activity.diff
                  }
                )
              ] }),
              activity.resultText && activity.tool !== "run_terminal" && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Result" }),
                /* @__PURE__ */ jsx8("pre", { className: "trace-expand-val trace-expand-pre", dir: "auto", children: activity.resultText })
              ] }),
              isWebRow(activity) && /* @__PURE__ */ jsx8(InlineWebResults, { activity }),
              !isWebRow(activity) && (((activity.items ?? activity.results)?.length ?? 0) > 0 || activity.tool === "run_terminal" && Boolean(activity.resultText)) && /* @__PURE__ */ jsxs7("div", { className: "trace-expand-section", children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Results" }),
                activity.tool === "run_terminal" ? /* @__PURE__ */ jsx8(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                ) : /* @__PURE__ */ jsx8(
                  FileResultLinks,
                  {
                    tool: activity.tool,
                    items: activity.items ?? activity.results
                  }
                )
              ] })
            ] }) : null,
            preview.snap && typeof document !== "undefined" && createPortal(
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
      const [reverting, setReverting] = useState4(false);
      const preview = useDiffPreview();
      const openReview = useViewerTabs((s) => s.openReview);
      const root = useStore((s) => s.root);
      const activeChatId = useStore((s) => s.activeChatId);
      const [collapsed, setCollapsed] = useState4(isSubagentCard(activity));
      const collapsible = activity.tool === "explore" && ((activity.children?.length ?? 0) > 0 || Boolean(activity.summary)) || activity.tool === "run_terminal";
      const toolRunning = activity.status === "running" || (activity.children?.some((c2) => c2.status === "running") ?? false);
      const now = useRunningClock(toolRunning);
      const ms = activity.status === "running" && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
      const isWrite = activity.tool === "write_file" || activity.tool === "edit_file";
      const writePath = reviewPathOf(activity);
      const readPaths = Array.isArray(activity.args?.paths) ? activity.args.paths : [];
      const fetchSummary = activity.tool === "fetch_url" ? activity.summary : "";
      const skillName = canonicalTool(activity.tool) === "load_skill" ? String(
        activity.args?.name ?? activity.args?.file ?? activity.args?.query ?? ""
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
          const path = String(activity.args?.path ?? activity.args?.filePath ?? "");
          const { content: current } = await api.fsRead(root, path) ?? {};
          const oldContent = applyReverseDiff(activity.diff, current ?? "");
          const ok = await api.fsWrite(root, path, oldContent);
          if (ok) onReverted?.();
        } finally {
          setReverting(false);
        }
      };
      return /* @__PURE__ */ jsxs7(
        "div",
        {
          className: `tool-card ${activity.status}${activity.tool === "explore" ? " explore" : ""}`,
          children: [
            /* @__PURE__ */ jsxs7(
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
                  /* @__PURE__ */ jsx8(StatusIcon, { status: activity.status }),
                  /* @__PURE__ */ jsx8("span", { className: "tool-name", children: isWrite ? /* @__PURE__ */ jsxs7(Fragment3, { children: [
                    /* @__PURE__ */ jsx8("span", { className: "tool-verb", children: activity.tool === "write_file" ? "Wrote" : "Edited" }),
                    /* @__PURE__ */ jsxs7("span", { className: "tool-file", title: writePath, children: [
                      /* @__PURE__ */ jsx8(FileIcon, { path: writePath, size: 20 }),
                      /* @__PURE__ */ jsx8("span", { className: "tool-file-name", dir: "ltr", children: writePath.split("/").pop() ?? writePath })
                    ] })
                  ] }) : toolLabel(activity.tool) }),
                  skillName && /* @__PURE__ */ jsx8("span", { className: "tool-skill", title: `Skill: ${skillName}`, dir: "ltr", children: skillName }),
                  activity.tool === "web_search" && activity.engine && /* @__PURE__ */ jsx8("span", { className: "tool-badge tool-engine-badge", children: activity.engine }),
                  activity.args && activity.args.command !== void 0 && /* @__PURE__ */ jsx8("span", { className: "tool-cmd", children: String(activity.args.command) }),
                  activity.args && activity.args.path !== void 0 && !isWrite && /* @__PURE__ */ jsx8(ToolPathSpan, { path: String(activity.args.path) }),
                  activity.args && activity.args.filePath !== void 0 && !isWrite && /* @__PURE__ */ jsx8(ToolPathSpan, { path: String(activity.args.filePath) }),
                  activity.args && activity.args.filePath !== void 0 && (String(activity.args.offset ?? 1) !== "1" || Number(activity.args.limit ?? 2e3) < 2e3) && /* @__PURE__ */ jsx8("span", { className: "tool-path", children: `${activity.args.offset ?? 1}\u2013${Number(activity.args.offset ?? 1) + Number(activity.args.limit ?? 2e3) - 1}` }),
                  activity.args && activity.args.start !== void 0 && /* @__PURE__ */ jsxs7("span", { className: "tool-path", children: [
                    String(activity.args.start),
                    activity.args.end !== void 0 && activity.args.end !== -1 ? `\u2013${String(activity.args.end)}` : "+"
                  ] }),
                  activity.args && activity.args.query !== void 0 && /* @__PURE__ */ jsx8("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.query)) }),
                  activity.args && activity.args.pattern !== void 0 && /* @__PURE__ */ jsx8("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.pattern)) }),
                  activity.args && activity.args.description !== void 0 && /* @__PURE__ */ jsx8(
                    "span",
                    {
                      className: "tool-cmd tool-task",
                      title: String(activity.args.description),
                      children: fixZwsp(
                        String(activity.args.description).length > 120 ? `${String(activity.args.description).slice(0, 120)}\u2026` : String(activity.args.description)
                      )
                    }
                  ),
                  activity.tool === "explore" && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsxs7("span", { className: "tool-badge tool-sub-count", children: [
                    activity.children.length,
                    " call",
                    activity.children.length === 1 ? "" : "s"
                  ] }),
                  activity.tool === "memory" && activity.args && /* @__PURE__ */ jsx8("span", { className: "tool-cmd", children: fixZwsp(String(activity.args.text || activity.args.subject || "")) }),
                  readPaths.length > 0 && /* @__PURE__ */ jsxs7(Fragment3, { children: [
                    readPaths.slice(0, 2).map((p, i) => /* @__PURE__ */ jsx8(ToolPathSpan, { path: p }, i)),
                    readPaths.length > 2 && /* @__PURE__ */ jsxs7("span", { className: "tool-path tool-more", children: [
                      "+",
                      readPaths.length - 2,
                      " more"
                    ] })
                  ] }),
                  fetchSummary && /* @__PURE__ */ jsx8("span", { className: "tool-cmd", children: fixZwsp(fetchSummary) }),
                  activity.args && !isSubagentCard(activity) && /* @__PURE__ */ jsx8(ToolArgs, { args: activity.args, tool: activity.tool }),
                  /* @__PURE__ */ jsxs7("span", { className: "tool-card-head-end", children: [
                    ms ? /* @__PURE__ */ jsx8("span", { className: "tool-ms", children: fmtTime(ms) }) : null,
                    isWrite && activity.diff && (() => {
                      const adds = (activity.diff.match(/^\+[^+]/gm) || []).length;
                      const dels = (activity.diff.match(/^-[^-]/gm) || []).length;
                      return adds + dels > 0 ? /* @__PURE__ */ jsxs7("span", { className: "tool-diff-stats", children: [
                        /* @__PURE__ */ jsxs7("span", { className: "review-count-add", children: [
                          "+",
                          adds
                        ] }),
                        " ",
                        /* @__PURE__ */ jsxs7("span", { className: "review-count-del", children: [
                          "-",
                          dels
                        ] })
                      ] }) : null;
                    })(),
                    isWrite && activity.diff && /* @__PURE__ */ jsx8(
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
                    isWrite && activity.reverted && /* @__PURE__ */ jsx8("span", { className: "reverted-tag", children: "reverted" }),
                    collapsible && /* @__PURE__ */ jsx8("span", { className: `chev${collapsed ? "" : " open"}`, children: "\u25BE" })
                  ] })
                ]
              }
            ),
            collapsed && activity.tool === "explore" && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx8(ToolCascade, { activities: activity.children }),
            !collapsed && !isWrite && /* @__PURE__ */ jsxs7("div", { className: "tool-card-body", children: [
              activity.summary && !isWrite && canonicalTool(activity.tool) !== "load_skill" && /* @__PURE__ */ jsx8("div", { className: "tool-summary", children: fixZwsp(activity.summary) }),
              activity.tool === "read" && activity.resultText && /* @__PURE__ */ jsx8(
                "pre",
                {
                  className: "trace-expand-val trace-expand-pre trace-terminal-output",
                  dir: "ltr",
                  children: activity.resultText
                }
              ),
              activity.tool === "explore" && activity.children && activity.children.length > 0 && /* @__PURE__ */ jsx8("div", { className: "tool-sub-list", children: activity.children.map((child, i) => /* @__PURE__ */ jsx8(
                ToolSubRow,
                {
                  activity: child,
                  hideResult: child.tool === "read"
                },
                `${child.tool}-${i}-${child.callId ?? i}`
              )) }),
              (activity.tool === "web_search" || activity.tool === "fetch_url") && (activity.items ?? activity.results) && (activity.items ?? activity.results).length > 0 && /* @__PURE__ */ jsx8(WebResultLinks, { items: activity.items ?? activity.results }),
              activity.tool === "run_terminal" && (((activity.items ?? activity.results)?.length ?? 0) > 0 || Boolean(activity.resultText)) && /* @__PURE__ */ jsxs7(Fragment3, { children: [
                /* @__PURE__ */ jsx8("span", { className: "trace-expand-key", children: "Output" }),
                /* @__PURE__ */ jsx8(
                  TerminalResultText,
                  {
                    items: activity.items ?? activity.results,
                    fallbackText: activity.resultText
                  }
                )
              ] }),
              activity.diff && /* @__PURE__ */ jsx8(
                DiffView,
                {
                  diff: activity.diff,
                  path: reviewPathOf(activity)
                }
              )
            ] }),
            preview.snap && typeof document !== "undefined" && createPortal(
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
          ]
        }
      );
    });
  }
});

// src/components/ReviewPanel.tsx
var ReviewPanel_exports = {};
__export(ReviewPanel_exports, {
  REVIEW_SIDE_BY_SIDE_THRESHOLD: () => REVIEW_SIDE_BY_SIDE_THRESHOLD,
  ReviewFileAccordion: () => ReviewFileAccordion,
  ReviewPanel: () => ReviewPanel
});
import { useEffect as useEffect5, useMemo as useMemo2, useRef as useRef4, useState as useState5 } from "react";
import { createPortal as createPortal2 } from "react-dom";
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
function openSourcePreview(path, diff2, root) {
  const hm = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff2);
  const line = hm ? parseInt(hm[1], 10) : void 0;
  useViewerTabs.getState().openFile(path, Number.isFinite(line) ? line : void 0, root);
}
function ReviewFileBody({
  file,
  query,
  activeHit,
  wide,
  root
}) {
  return /* @__PURE__ */ jsxs8("div", { className: "review-file-body", children: [
    /* @__PURE__ */ jsx9("div", { className: "review-file-toolbar", children: /* @__PURE__ */ jsxs8(
      "button",
      {
        type: "button",
        className: "review-source-preview-btn",
        title: "Open the full file in its own tab",
        "aria-label": `Source preview \u2014 open ${file.path} in a new tab`,
        onClick: () => openSourcePreview(file.path, file.diff, root),
        children: [
          /* @__PURE__ */ jsxs8("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
            /* @__PURE__ */ jsx9("polyline", { points: "16 18 22 12 16 6" }),
            /* @__PURE__ */ jsx9("polyline", { points: "8 6 2 12 8 18" })
          ] }),
          "Source preview"
        ]
      }
    ) }),
    file.diff ? /* @__PURE__ */ jsx9(
      DiffView,
      {
        diff: file.diff,
        path: file.path,
        query,
        activeHit,
        layout: wide ? "side-by-side" : "auto",
        commentable: true
      }
    ) : /* @__PURE__ */ jsx9("div", { className: "review-empty", children: "New file \u2014 no diff available yet." })
  ] });
}
function ReviewFileAccordion({
  files,
  selectedPath,
  onSelect,
  query = "",
  activeHit = -1,
  wide = false,
  root
}) {
  return /* @__PURE__ */ jsx9("div", { className: "review-files", children: files.map((f) => {
    const isOpen = f.path === selectedPath;
    return /* @__PURE__ */ jsxs8(
      "div",
      {
        className: `review-file-block${isOpen ? " open" : ""}`,
        children: [
          /* @__PURE__ */ jsxs8(
            "button",
            {
              className: `review-file-row${isOpen ? " selected" : ""}`,
              "aria-expanded": isOpen,
              onClick: () => onSelect(isOpen ? "" : f.path),
              children: [
                /* @__PURE__ */ jsx9("span", { className: "review-file-ext", children: /* @__PURE__ */ jsx9(FileIcon, { path: f.path, size: 20 }) }),
                /* @__PURE__ */ jsx9("span", { className: "review-file-path", title: f.path, children: toWorkspacePath(root, f.path) }),
                /* @__PURE__ */ jsxs8("span", { className: "review-file-counts", children: [
                  /* @__PURE__ */ jsxs8("span", { className: "review-count-add", children: [
                    "+",
                    f.adds
                  ] }),
                  /* @__PURE__ */ jsxs8("span", { className: "review-count-del", children: [
                    "-",
                    f.dels
                  ] })
                ] }),
                /* @__PURE__ */ jsx9("span", { className: "review-file-open", "aria-hidden": "true", children: isOpen ? "\u25BE" : "\u25B8" })
              ]
            }
          ),
          isOpen && /* @__PURE__ */ jsx9("div", { className: "review-diff", children: /* @__PURE__ */ jsx9(
            ReviewFileBody,
            {
              file: f,
              query,
              activeHit,
              wide,
              root
            }
          ) })
        ]
      },
      f.path
    );
  }) });
}
function ReviewPanel(props) {
  const docked = props?.docked ?? false;
  const store = useReviewPanel();
  const storeMessageId = store.messageId;
  const storeSelectedPath = store.selectedPath;
  const storeSelectPath = store.selectPath;
  const storeClose = store.close;
  const storeSource = store.source;
  const storeSetSource = store.setSource;
  const messageId = props?.messageId !== void 0 ? props.messageId : storeMessageId;
  const close = props?.onClose ?? storeClose;
  const [dockedSource, setDockedSource] = useState5(props?.initialSource ?? "turn");
  const [dockedPath, setDockedPath] = useState5(props?.initialPath ?? "");
  useEffect5(() => {
    if (props?.initialSource) setDockedSource(props.initialSource);
  }, [props?.initialSource]);
  useEffect5(() => {
    if (props?.initialPath !== void 0) setDockedPath(props.initialPath);
  }, [props?.initialPath]);
  const source = docked ? dockedSource : storeSource;
  const setSource = docked ? setDockedSource : storeSetSource;
  const selectedPath = docked ? dockedPath : storeSelectedPath;
  const selectPath = docked ? setDockedPath : storeSelectPath;
  const [fullscreen, setFullscreen] = useState5(false);
  const [width, setWidth] = useState5(() => {
    if (typeof window === "undefined") return 720;
    const vw = typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:reviewWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const fallback = Math.round(vw / 2) - 12;
    const n = Number.isFinite(saved) ? saved : fallback;
    return Math.max(320, Math.min(vw - 24, n));
  });
  const dragCleanup = useRef4(null);
  useEffect5(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect5(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect5(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (docked && useViewerTabs.getState().fullscreen) {
          useViewerTabs.getState().setFullscreen(false);
          return;
        }
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, docked]);
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const w = Math.max(
        320,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX))
      );
      setWidth(w);
      try {
        localStorage.setItem("coder:reviewWidth", String(w));
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
  const activities = useStore(
    (s) => s.chats.find((c2) => c2.messages.some((m) => m.id === messageId))?.messages.find((m) => m.id === messageId)?.toolActivity
  );
  const turn = useMemo2(
    () => messageId && activities ? buildReviewTurn(messageId, activities) : null,
    [messageId, activities]
  );
  const ownerChatId = props?.chatId;
  const root = useStore(
    (s) => s.chats.find((c2) => c2.id === (ownerChatId ?? s.activeChatId))?.root ?? s.root
  );
  const [gitFiles, setGitFiles] = useState5([]);
  const [gitLoading, setGitLoading] = useState5(false);
  const [gitError, setGitError] = useState5(null);
  const [commits, setCommits] = useState5([]);
  const [rev, setRev] = useState5(props?.initialRev ?? "HEAD");
  useEffect5(() => {
    if (props?.initialRev !== void 0) setRev(props.initialRev);
  }, [props?.initialRev]);
  const [query, setQuery] = useState5("");
  useEffect5(() => {
    if (source !== "uncommitted" || !root) return;
    let cancelled = false;
    void (async () => {
      setGitLoading(true);
      setGitError(null);
      try {
        const [st, unstaged, staged] = await Promise.all([
          gitStatus(root),
          gitDiff(root),
          gitDiff(root, "", true)
        ]);
        if (cancelled) return;
        if ("error" in unstaged) {
          setGitFiles([]);
          setGitError(unstaged.error ?? "git diff failed");
          return;
        }
        const statusPaths = "error" in st ? [] : st.entries.map((e) => e.path);
        const stagedDiff = "error" in staged ? "" : staged.diff;
        setGitFiles(
          buildUncommittedFiles(statusPaths, unstaged.diff, stagedDiff)
        );
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root]);
  useEffect5(() => {
    if (source !== "committed" || !root) return;
    let cancelled = false;
    void (async () => {
      const log = await gitLog(root, 10);
      if (!cancelled && !("error" in log)) setCommits(log.commits);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root]);
  useEffect5(() => {
    if (source !== "committed" || !root) return;
    let cancelled = false;
    void (async () => {
      setGitLoading(true);
      setGitError(null);
      try {
        const d = await gitShow(root, rev);
        if (cancelled) return;
        if ("error" in d) {
          setGitFiles([]);
          setGitError(d.error ?? "git show failed");
          return;
        }
        setGitFiles(
          splitUnifiedDiffByFile(d.diff).map((p) => {
            const s = diffStatsFromUnified(p.diff);
            return { path: p.path, diff: p.diff, adds: s.adds, dels: s.dels };
          })
        );
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, root, rev]);
  const turnFiles = useMemo2(
    () => turn?.files.map((f) => ({
      path: f.path,
      diff: f.diff,
      adds: f.adds,
      dels: f.dels
    })) ?? [],
    [turn]
  );
  const { inside: files, outside: outsideFiles } = useMemo2(
    () => splitWorkspaceFiles(source === "turn" ? turnFiles : gitFiles, root),
    [source, turnFiles, gitFiles, root]
  );
  const visibleFiles = filterFilesByQuery(files, query);
  const hitCounts = useMemo2(
    () => query.trim() ? visibleFiles.map((f) => countDiffHits(parseDiffRows(f.diff), query)) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, source, turn?.files, gitFiles]
  );
  const matchCount = hitCounts.reduce((n, c2) => n + c2, 0);
  const [activeIndex, setActiveIndex] = useState5(-1);
  useEffect5(() => {
    setActiveIndex(matchCount > 0 ? 0 : -1);
  }, [query, source, turn?.files, gitFiles]);
  const activeLoc = activeIndex >= 0 ? locateHit(hitCounts, activeIndex) : null;
  const stepSearch = (dir) => {
    setActiveIndex((cur) => {
      const next = stepHitIndex(cur, matchCount, dir);
      const loc = next >= 0 ? locateHit(hitCounts, next) : null;
      if (loc) {
        const target = visibleFiles[loc.fileIndex]?.path;
        if (target && target !== selectedPath) selectPath(target);
      }
      return next;
    });
  };
  const totals = source === "turn" ? turn ? { adds: turn.adds, dels: turn.dels } : null : {
    adds: files.reduce((n, f) => n + f.adds, 0),
    dels: files.reduce((n, f) => n + f.dels, 0)
  };
  const dockedWant = docked ? props?.initialPath ?? "" : "";
  useEffect5(() => {
    if (files.length === 0) return;
    if (dockedWant && files.some((f) => f.path === dockedWant)) {
      if (selectedPath !== dockedWant) selectPath(dockedWant);
      return;
    }
    const has = files.some((f) => f.path === selectedPath);
    if (!selectedPath || !has) selectPath(files[0]?.path ?? "");
  }, [source, turn?.files, gitFiles, dockedWant]);
  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const switchSource = (next) => {
    setSource(next);
    setGitError(null);
    setQuery("");
    setActiveIndex(-1);
  };
  const wide = docked ? false : fullscreen || width >= REVIEW_SIDE_BY_SIDE_THRESHOLD;
  const renderFileList = (list) => {
    const openIdx = list.findIndex((f) => f.path === (selected?.path ?? ""));
    const openLocal = activeLoc && activeLoc.fileIndex === openIdx ? activeLoc.localIndex : -1;
    return /* @__PURE__ */ jsx9(
      ReviewFileAccordion,
      {
        files: list,
        selectedPath: selected?.path ?? "",
        onSelect: selectPath,
        query,
        activeHit: openLocal,
        wide,
        root
      }
    );
  };
  const panel = /* @__PURE__ */ jsxs8(
    "div",
    {
      className: docked ? "review-docked-wrap" : `review-overlay${fullscreen ? " fullscreen" : ""}`,
      dir: "ltr",
      style: docked ? void 0 : { "--review-w": `${width}px` },
      onClick: (e) => e.stopPropagation(),
      children: [
        !docked && /* @__PURE__ */ jsx9("div", { className: "review-scrim", "aria-hidden": "true", onClick: close }),
        !docked && !fullscreen && /* @__PURE__ */ jsx9(
          "div",
          {
            className: "review-overlay-resize-handle",
            title: "Drag to resize",
            onMouseDown: startResize
          }
        ),
        /* @__PURE__ */ jsxs8("aside", { className: docked ? "review-panel review-docked-panel" : "review-panel review-floating-panel", dir: "ltr", children: [
          /* @__PURE__ */ jsxs8("div", { className: "review-header", children: [
            /* @__PURE__ */ jsx9("span", { className: "review-source", role: "tablist", "aria-label": "Diff source", children: [
              ["turn", "Last Turn"],
              ["uncommitted", "Uncommitted"],
              ["committed", "Committed"]
            ].map(([key, label]) => /* @__PURE__ */ jsx9(
              "button",
              {
                role: "tab",
                "aria-selected": source === key,
                className: `review-source-btn${source === key ? " active" : ""}`,
                onClick: () => switchSource(key),
                children: label
              },
              key
            )) }),
            totals && /* @__PURE__ */ jsxs8("span", { className: "review-counts", children: [
              /* @__PURE__ */ jsxs8("span", { className: "review-count-add", children: [
                "+",
                totals.adds
              ] }),
              /* @__PURE__ */ jsxs8("span", { className: "review-count-del", children: [
                "-",
                totals.dels
              ] })
            ] }),
            /* @__PURE__ */ jsxs8("span", { className: "review-header-actions", children: [
              !docked && /* @__PURE__ */ jsx9(ViewerFullscreenButton, { docked, fullscreen, onToggleFullscreen: () => setFullscreen((v) => !v) }),
              !docked && /* @__PURE__ */ jsx9(
                "button",
                {
                  className: "review-header-btn",
                  title: "Close",
                  "aria-label": "Close",
                  onClick: close,
                  children: /* @__PURE__ */ jsxs8("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx9("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                    /* @__PURE__ */ jsx9("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
                  ] })
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsx9("div", { className: "review-search-row", children: /* @__PURE__ */ jsxs8("label", { className: "review-search", dir: "ltr", children: [
            /* @__PURE__ */ jsx9("span", { "aria-hidden": "true", children: "\u{1F50D}" }),
            /* @__PURE__ */ jsx9(
              "input",
              {
                className: "review-search-input",
                type: "search",
                placeholder: "Search in diffs\u2026",
                value: query,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter" && matchCount > 0) {
                    e.preventDefault();
                    stepSearch(e.shiftKey ? -1 : 1);
                  }
                }
              }
            ),
            query.trim() ? matchCount > 0 ? /* @__PURE__ */ jsxs8("span", { className: "review-search-nav", children: [
              /* @__PURE__ */ jsxs8("span", { className: "review-search-count", children: [
                activeIndex + 1,
                "/",
                matchCount
              ] }),
              /* @__PURE__ */ jsx9(
                "button",
                {
                  type: "button",
                  className: "review-search-btn",
                  title: "Previous match (Shift+Enter)",
                  "aria-label": "Previous match",
                  onClick: () => stepSearch(-1),
                  children: "\u2191"
                }
              ),
              /* @__PURE__ */ jsx9(
                "button",
                {
                  type: "button",
                  className: "review-search-btn",
                  title: "Next match (Enter)",
                  "aria-label": "Next match",
                  onClick: () => stepSearch(1),
                  children: "\u2193"
                }
              )
            ] }) : /* @__PURE__ */ jsx9("span", { className: "review-search-count", children: "0 hits" }) : null
          ] }) }),
          source === "committed" && /* @__PURE__ */ jsxs8("div", { className: "review-rev-row", children: [
            /* @__PURE__ */ jsx9("label", { className: "review-rev-label", htmlFor: "review-rev", children: "Commit" }),
            /* @__PURE__ */ jsxs8(
              "select",
              {
                id: "review-rev",
                className: "review-rev-select",
                value: rev,
                onChange: (e) => setRev(e.target.value),
                children: [
                  /* @__PURE__ */ jsx9("option", { value: "HEAD", children: "HEAD (latest)" }),
                  commits.map((c2) => /* @__PURE__ */ jsxs8("option", { value: c2.hash, children: [
                    c2.hash,
                    " \u2014 ",
                    c2.subject
                  ] }, c2.hash))
                ]
              }
            )
          ] }),
          source === "turn" ? !turn ? /* @__PURE__ */ jsx9("div", { className: "review-empty", children: "No changes in this turn." }) : visibleFiles.length === 0 ? /* @__PURE__ */ jsx9("div", { className: "review-empty", children: query.trim() ? `No files match \u201C${query.trim()}\u201D.` : "No files from this turn are inside the workspace." }) : renderFileList(visibleFiles) : gitLoading ? /* @__PURE__ */ jsx9("div", { className: "review-empty", children: "loading\u2026" }) : gitError ? /* @__PURE__ */ jsx9("div", { className: "review-empty", children: gitError }) : files.length === 0 ? /* @__PURE__ */ jsx9("div", { className: "review-empty", children: source === "uncommitted" ? "Working tree clean \u2014 no uncommitted changes." : "No files changed in this commit." }) : visibleFiles.length === 0 ? /* @__PURE__ */ jsxs8("div", { className: "review-empty", children: [
            "No files match \u201C",
            query.trim(),
            "\u201D."
          ] }) : renderFileList(visibleFiles),
          outsideFiles.length > 0 && /* @__PURE__ */ jsxs8("div", { className: "review-note", dir: "auto", children: [
            outsideFiles.length,
            " file",
            outsideFiles.length === 1 ? "" : "s",
            " outside this workspace ",
            outsideFiles.length === 1 ? "is" : "are",
            " hidden \u2014",
            " ",
            outsideFiles.slice(0, 3).map((f) => toWorkspacePath(root, f.path)).join(", "),
            outsideFiles.length > 3 ? " \u2026" : ""
          ] })
        ] })
      ]
    }
  );
  if (docked || typeof document === "undefined") return panel;
  return createPortal2(panel, document.body);
}
var REVIEW_SIDE_BY_SIDE_THRESHOLD;
var init_ReviewPanel = __esm({
  "src/components/ReviewPanel.tsx"() {
    "use strict";
    init_reviewTurn();
    init_uncommitted();
    init_diffSearch();
    init_reviewDiff();
    init_reviewDiff();
    init_toolActivity();
    init_store();
    init_reviewPanel();
    init_viewerTabs();
    init_ViewerFullscreenButton();
    init_api();
    init_ToolCallView();
    init_FileIcon();
    init_fileTree();
    REVIEW_SIDE_BY_SIDE_THRESHOLD = 900;
  }
});

// src/lib/tracePanel.ts
import { create as create4 } from "zustand";
var useTracePanel;
var init_tracePanel = __esm({
  "src/lib/tracePanel.ts"() {
    "use strict";
    useTracePanel = create4((set) => ({
      open: false,
      tab: "all",
      openTraces: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
      close: () => set({ open: false }),
      toggle: () => set((s) => ({ open: !s.open })),
      setTab: (tab) => set({ tab })
    }));
  }
});

// src/components/TracePanel.tsx
var TracePanel_exports = {};
__export(TracePanel_exports, {
  TracePanel: () => TracePanel,
  TraceRow: () => TraceRow3,
  TraceTurnGroup: () => TraceTurnGroup,
  filterTraces: () => filterTraces,
  formatTraceEntryAsText: () => formatTraceEntryAsText,
  formatTracesAsText: () => formatTracesAsText,
  formatTurnAsText: () => formatTurnAsText,
  getTraceTabCounts: () => getTraceTabCounts,
  groupTracesByTurn: () => groupTracesByTurn,
  isSubToolTrace: () => isSubToolTrace,
  isToolTraceKind: () => isToolTraceKind,
  traceEntrySearchParts: () => traceEntrySearchParts,
  traceRowTitle: () => traceRowTitle,
  traceStep: () => traceStep,
  traceTurn: () => traceTurn,
  turnUserPreview: () => turnUserPreview
});
import { useCallback as useCallback3, useEffect as useEffect6, useLayoutEffect as useLayoutEffect2, useMemo as useMemo3, useRef as useRef5, useState as useState6 } from "react";
import { createPortal as createPortal3 } from "react-dom";
import { Fragment as Fragment4, jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function isToolTraceKind(kind) {
  return kind === "tool";
}
function isSubToolTrace(entry) {
  return Boolean(entry.detail?.sub);
}
function getTraceTabCounts(entries, includeSub = false) {
  const c2 = { all: entries.length, llm: 0, prompt: 0, tool: 0, fold: 0 };
  for (const e of entries) {
    const raw = e.kind;
    if (raw === "tool") {
      if (!includeSub && isSubToolTrace(e)) continue;
      c2.tool += 1;
    } else if (raw in c2) {
      c2[raw] += 1;
    }
  }
  return c2;
}
function traceRowTitle(entry) {
  if ((entry.summary || "").trim()) return entry.summary;
  if (entry.kind === "llm") return `${entry.model || "llm"} \xB7 ${entry.tokens?.total ?? 0} tokens`;
  if (entry.kind === "prompt") return `prompt \xB7 ${(entry.prompt || "").length} chars`;
  if (entry.kind === "fold") {
    const d = entry.detail || {};
    return `fold \xB7 ${d.folded ?? "?"} result(s), ${d.removed_chars ?? 0} chars out`;
  }
  if (entry.kind === "tool" || entry.kind === "tool_result") {
    const name = String(entry.detail?.name || entry.model || "tool");
    return name;
  }
  return "trace entry";
}
function filterTraces(entries, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const hay = `${e.summary || ""}
${e.prompt || ""}
${e.result || ""}
${e.model || ""}
${e.error || ""}
${JSON.stringify(e.detail ?? {})}`.toLowerCase();
    return hay.includes(q);
  });
}
function formatTraceEntryAsText(entry) {
  const detail = entry.detail ?? {};
  const lines = [`[${timeLabel(entry.at)}] ${entry.kind.toUpperCase()} ${traceRowTitle(entry)}`];
  const meta = [];
  if (typeof entry.turn === "number" && Number.isFinite(entry.turn) && Number(entry.turn) > 0)
    meta.push(`turn=${Number(entry.turn)}`);
  if (entry.model) meta.push(`model=${entry.model}`);
  if (entry.tokens?.total) meta.push(`tokens=${entry.tokens.total}`);
  if (typeof detail.step === "number") meta.push(`step=${Number(detail.step)}`);
  const status = String(detail.status || (entry.error ? "error" : "") || "");
  if (status) meta.push(`status=${status}`);
  if (meta.length > 0) lines.push(`  ${meta.join(" \xB7 ")}`);
  if (entry.error) lines.push(`  error: ${entry.error}`);
  if (entry.prompt) lines.push(`  prompt:
${entry.prompt}`);
  const result = String(entry.result || "");
  if (result) lines.push(`  result:
${result}`);
  const detailKeys = Object.keys(entry.detail ?? {});
  if (!entry.prompt && !result && detailKeys.length > 0) lines.push(`  detail: ${JSON.stringify(entry.detail)}`);
  return lines.join("\n");
}
function formatTracesAsText(entries) {
  return entries.map(formatTraceEntryAsText).join("\n\n");
}
function formatTurnAsText(turn, inferred, entries) {
  const label = turn !== null ? `Turn ${turn}` : `Turn ${inferred}`;
  const preview = turnUserPreview(entries);
  const head = preview ? `${label}: ${preview}` : label;
  const body = formatTracesAsText(entries);
  return body ? `${head}
${body}` : head;
}
function timeLabel(at) {
  try {
    const d = new Date((at || 0) * 1e3);
    return d.toLocaleTimeString();
  } catch {
    return "";
  }
}
function highlightHits(text, query, base = -1, active = -1, activeRef) {
  const q = (query || "").trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let i = 0;
  let key = 0;
  let ordinal = 0;
  const navigable = base >= 0 && active >= 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    const idx = navigable ? base + ordinal : -1;
    ordinal++;
    const isActive = navigable && idx === active;
    parts.push(
      /* @__PURE__ */ jsx10(
        "mark",
        {
          className: isActive ? "trace-hit trace-hit-active" : "trace-hit",
          ...isActive ? { "aria-current": "true" } : {},
          ref: isActive && activeRef ? (el) => {
            activeRef.current = el;
          } : void 0,
          children: text.slice(hit, hit + q.length)
        },
        key++
      )
    );
    i = hit + q.length;
    if (parts.length > 200) {
      parts.push(text.slice(i));
      break;
    }
  }
  return /* @__PURE__ */ jsx10(Fragment4, { children: parts });
}
function CopyButton({ text, label, title }) {
  const [copied, setCopied] = useState6(false);
  const timer = useRef5(null);
  useEffect6(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const hint = title ?? (typeof label === "string" ? label : "Copy");
  return /* @__PURE__ */ jsx10(
    "button",
    {
      type: "button",
      className: "trace-copy-btn",
      title: hint,
      "aria-label": hint,
      onClick: (e) => {
        e.stopPropagation();
        void (async () => {
          const ok = await copyToClipboard(text);
          if (ok) {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          }
        })();
      },
      children: copied ? "Copied \u2713" : label
    }
  );
}
function CopyTracesButton({ entries, query, tab }) {
  const [copied, setCopied] = useState6(false);
  const timer = useRef5(null);
  useEffect6(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const filtered = query.trim() !== "" || tab !== "all";
  const title = entries.length === 0 ? "Nothing to copy" : filtered ? `Copy filtered traces (${entries.length})` : `Copy all traces (${entries.length})`;
  return /* @__PURE__ */ jsx10(
    "button",
    {
      type: "button",
      className: "review-header-btn",
      title,
      "aria-label": title,
      disabled: entries.length === 0,
      onClick: () => {
        void (async () => {
          const ok = await copyToClipboard(formatTracesAsText(entries));
          if (ok) {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          }
        })();
      },
      children: copied ? /* @__PURE__ */ jsx10("span", { "aria-hidden": "true", children: "\u2713" }) : /* @__PURE__ */ jsxs9("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
        /* @__PURE__ */ jsx10("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
        /* @__PURE__ */ jsx10("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
      ] })
    }
  );
}
function TextBlock({
  label,
  text,
  query,
  kind,
  hitBase = -1,
  activeHit = -1,
  activeRef
}) {
  if (!text) return null;
  return /* @__PURE__ */ jsxs9("div", { className: "trace-prompt-block", dir: "ltr", children: [
    /* @__PURE__ */ jsxs9("div", { className: "trace-prompt-actions", children: [
      /* @__PURE__ */ jsx10("span", { className: "trace-block-label", children: label }),
      /* @__PURE__ */ jsx10(CopyButton, { text, label: "Copy" })
    ] }),
    /* @__PURE__ */ jsx10("pre", { className: kind === "json" ? "trace-detail-json" : "trace-prompt-text", children: query?.trim() ? highlightHits(text, query, hitBase, activeHit, activeRef) : text })
  ] });
}
function traceStep(entry) {
  const s = entry.detail?.step;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}
function traceTurn(entry) {
  const t = entry.turn;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
}
function groupTracesByTurn(entries) {
  const groups = [];
  let inferred = 0;
  for (const e of entries) {
    const t = traceTurn(e);
    const last = groups[groups.length - 1];
    if (t !== null) {
      if (last && last.turn === t) last.entries.push(e);
      else {
        inferred += 1;
        groups.push({ turn: t, inferred, entries: [e] });
      }
    } else {
      if (last && last.turn === null && e.kind !== "prompt") last.entries.push(e);
      else {
        inferred += 1;
        groups.push({ turn: null, inferred, entries: [e] });
      }
    }
  }
  return groups;
}
function turnUserPreview(entries) {
  const p = entries.find((e) => e.kind === "prompt");
  const full = (p?.prompt || "").trim();
  if (!full) {
    const first = (entries[0]?.summary || "").trim();
    return first.slice(0, 100);
  }
  const marker = "[user]";
  const idx = full.lastIndexOf(marker);
  const userText = (idx >= 0 ? full.slice(idx + marker.length) : full).trim().replace(/\s+/g, " ");
  return userText.slice(0, 120);
}
function traceEntrySearchParts(entry) {
  const title = traceRowTitle(entry);
  const prompt = entry.prompt || "";
  const result = String(entry.result || "");
  const detailJson = !prompt && !result && Object.keys(entry.detail ?? {}).length > 0 ? JSON.stringify(entry.detail, null, 2) : "";
  return { title, prompt, result, detailJson };
}
function TraceRow3({
  entry,
  query,
  defaultOpen,
  hitBase = -1,
  activeHit = -1,
  activeRef
}) {
  const [open, setOpen] = useState6(Boolean(defaultOpen));
  const detail = entry.detail ?? {};
  const prompt = entry.prompt || "";
  const result = String(entry.result || "");
  const status = String(detail.status || (entry.error ? "error" : "") || "").toLowerCase();
  useEffect6(() => {
    if (query?.trim()) setOpen(true);
    else setOpen(Boolean(defaultOpen));
  }, [query, defaultOpen]);
  const tokens = entry.tokens;
  const tokenTotal = tokens?.total ?? 0;
  const step = traceStep(entry);
  const title = traceRowTitle(entry);
  const q = (query || "").trim();
  const titleCount = q ? countOccurrences(title, q) : 0;
  const promptBase = hitBase >= 0 ? hitBase + titleCount : -1;
  const promptCount = q ? countOccurrences(prompt, q) : 0;
  const resultBase = promptBase >= 0 ? promptBase + promptCount : -1;
  const resultCount = q ? countOccurrences(result, q) : 0;
  const detailText = !prompt && !result && Object.keys(detail).length > 0 ? JSON.stringify(detail, null, 2) : "";
  const detailBase = resultBase >= 0 ? resultBase + resultCount : -1;
  return /* @__PURE__ */ jsxs9("div", { className: `trace-panel-item${open ? " open" : ""}`, children: [
    /* @__PURE__ */ jsxs9(
      "button",
      {
        className: `trace-panel-row${open ? " selected" : ""}`,
        "aria-expanded": open,
        onClick: () => setOpen((v) => !v),
        children: [
          /* @__PURE__ */ jsx10("span", { className: `trace-panel-dot kind-${entry.kind}`, "aria-hidden": "true" }),
          /* @__PURE__ */ jsx10("span", { className: `trace-kind-badge kind-${entry.kind}`, children: entry.kind }),
          /* @__PURE__ */ jsx10("span", { className: "trace-panel-title", title, children: query?.trim() ? highlightHits(title, query, hitBase, activeHit, activeRef) : title }),
          tokenTotal > 0 ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip trace-panel-chip", children: [
            tokenTotal,
            " tok"
          ] }) : null,
          step !== null ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip trace-panel-chip", children: [
            "step ",
            step
          ] }) : null,
          status ? /* @__PURE__ */ jsx10("span", { className: `trace-status-chip status-${status}`, children: status }) : null,
          /* @__PURE__ */ jsx10("span", { className: "trace-panel-time", children: timeLabel(entry.at) }),
          /* @__PURE__ */ jsx10("span", { className: "trace-panel-chev", "aria-hidden": "true", children: open ? "\u25BE" : "\u25B8" })
        ]
      }
    ),
    open && /* @__PURE__ */ jsxs9("div", { className: "trace-row-body trace-panel-body", children: [
      entry.kind === "llm" && /* @__PURE__ */ jsxs9("div", { className: "trace-llm-meta", children: [
        entry.model ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: entry.model }) : null,
        tokens ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          "in ",
          tokens.input ?? 0,
          " \xB7 out ",
          tokens.output ?? 0,
          " \xB7 total ",
          tokens.total ?? 0
        ] }) : null,
        detail.provider || detail.provider_id ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: String(detail.provider_id || detail.provider || "") }) : null,
        typeof detail.step === "number" ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          "step ",
          Number(detail.step),
          typeof detail.steps_max === "number" ? `/${Number(detail.steps_max)}` : ""
        ] }) : null,
        typeof detail.finish_reason === "string" && detail.finish_reason ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: String(detail.finish_reason) }) : null,
        typeof detail.prompt_messages === "number" ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          Number(detail.prompt_messages),
          " msgs in"
        ] }) : null,
        typeof detail.wire_tokens_est === "number" ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          "~",
          Number(detail.wire_tokens_est),
          " prompt tok"
        ] }) : null,
        typeof detail.reply_chars === "number" && Number(detail.reply_chars) > 0 ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          Number(detail.reply_chars),
          " chars out"
        ] }) : null,
        typeof detail.reasoning_chars === "number" && Number(detail.reasoning_chars) > 0 ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          Number(detail.reasoning_chars),
          " B thinking"
        ] }) : null,
        Array.isArray(detail.tool_calls) && detail.tool_calls.length > 0 ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          "\u2192 ",
          detail.tool_calls.map(String).join(", ")
        ] }) : null,
        entry.error ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-error", children: entry.error }) : null
      ] }),
      entry.kind === "tool" && /* @__PURE__ */ jsxs9("div", { className: "trace-llm-meta", children: [
        detail.name ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: String(detail.name) }) : null,
        entry.model ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: entry.model }) : null,
        typeof detail.step === "number" && Number(detail.step) > 0 ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          "step ",
          Number(detail.step)
        ] }) : null,
        typeof detail.result_chars === "number" ? /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          Number(detail.result_chars),
          " chars out"
        ] }) : null,
        entry.error ? /* @__PURE__ */ jsx10("span", { className: "trace-meta-error", children: entry.error }) : null
      ] }),
      entry.kind === "prompt" && detail.mode ? /* @__PURE__ */ jsxs9("div", { className: "trace-llm-meta", children: [
        /* @__PURE__ */ jsx10("span", { className: "trace-meta-chip", children: String(detail.mode) }),
        /* @__PURE__ */ jsxs9("span", { className: "trace-meta-chip", children: [
          (prompt || "").length,
          " chars"
        ] })
      ] }) : null,
      prompt ? /* @__PURE__ */ jsx10(
        TextBlock,
        {
          label: entry.kind === "tool" ? "Args (prompt)" : entry.kind === "llm" ? "Prompt (sent to model)" : "Prompt",
          text: prompt,
          query,
          kind: "prompt",
          hitBase: promptBase,
          activeHit,
          activeRef
        }
      ) : null,
      result ? /* @__PURE__ */ jsx10(
        TextBlock,
        {
          label: entry.kind === "tool" ? "Result" : "Response",
          text: result,
          query,
          kind: "prompt",
          hitBase: resultBase,
          activeHit,
          activeRef
        }
      ) : null,
      !prompt && !result && detailText ? /* @__PURE__ */ jsx10("pre", { className: "trace-detail-json", dir: "ltr", children: query?.trim() ? highlightHits(detailText, query, detailBase, activeHit, activeRef) : detailText }) : null,
      !prompt && !result && !detailText ? /* @__PURE__ */ jsx10("div", { className: "trace-empty-body", children: "No prompt/response recorded for this entry." }) : null
    ] })
  ] });
}
function TraceTurnGroup({
  turn,
  inferred,
  entries,
  query,
  hitBases,
  activeHit = -1,
  activeRef,
  defaultOpen = true
}) {
  const [open, setOpen] = useState6(Boolean(defaultOpen));
  useEffect6(() => {
    if (query?.trim()) setOpen(true);
    else setOpen(Boolean(defaultOpen));
  }, [query, defaultOpen]);
  const tokens = entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
  const label = turn !== null ? `Turn ${turn}` : `Turn ${inferred}`;
  const copyText = useMemo3(
    () => formatTurnAsText(turn, inferred, entries),
    [turn, inferred, entries]
  );
  return /* @__PURE__ */ jsxs9("section", { className: "trace-panel-step", "aria-label": label, children: [
    /* @__PURE__ */ jsxs9("div", { className: "trace-panel-step-head", children: [
      /* @__PURE__ */ jsxs9(
        "button",
        {
          type: "button",
          className: "trace-panel-step-toggle",
          "aria-expanded": open,
          "aria-label": `${label} \u2014 toggle traces`,
          onClick: () => setOpen((v) => !v),
          children: [
            /* @__PURE__ */ jsx10("span", { className: "trace-panel-step-chev", "aria-hidden": "true", children: open ? "\u25BE" : "\u25B8" }),
            /* @__PURE__ */ jsx10("span", { className: "trace-panel-step-title", children: label }),
            /* @__PURE__ */ jsxs9("span", { className: "trace-panel-step-meta", children: [
              entries.length,
              " events",
              tokens > 0 ? ` \xB7 ${tokens} tok` : ""
            ] })
          ]
        }
      ),
      /* @__PURE__ */ jsx10(CopyButton, { text: copyText, label: "Copy", title: `Copy ${label} traces (${entries.length})` })
    ] }),
    open && /* @__PURE__ */ jsx10("div", { className: "trace-panel-step-rows", children: entries.map((entry, i) => /* @__PURE__ */ jsx10(
      TraceRow3,
      {
        entry,
        query,
        defaultOpen: false,
        hitBase: hitBases?.[i] ?? -1,
        activeHit,
        activeRef
      },
      entry.id
    )) })
  ] });
}
function TracePanel(props) {
  const docked = props?.docked ?? false;
  const store = useTracePanel();
  const storeTab = store.tab;
  const storeSetTab = store.setTab;
  const storeClose = store.close;
  const [dockedTab, setDockedTab] = useState6(props?.initialTab ?? "all");
  const tab = docked ? dockedTab : storeTab;
  const setTab = docked ? setDockedTab : storeSetTab;
  const close = props?.onClose ?? storeClose;
  const storeActiveChatId = useStore((s) => s.activeChatId);
  const activeChatId = props?.chatId ?? storeActiveChatId;
  const taskId = (props?.taskId ?? "").trim();
  const traceTitle = (props?.traceTitle ?? "").trim();
  const [fullscreen, setFullscreen] = useState6(false);
  const [width, setWidth] = useState6(() => {
    if (typeof window === "undefined") return 720;
    const vw = typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:traceWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const fallback = Math.round(vw / 2) - 12;
    const n = Number.isFinite(saved) ? saved : fallback;
    return Math.max(320, Math.min(vw - 24, n));
  });
  const [entries, setEntries] = useState6([]);
  const [loading, setLoading] = useState6(false);
  const [error, setError] = useState6(null);
  const [query, setQuery] = useState6("");
  const [olderLoading, setOlderLoading] = useState6(false);
  const [serverCounts, setServerCounts] = useState6(null);
  const [serverTotal, setServerTotal] = useState6(0);
  const [reachedStart, setReachedStart] = useState6(false);
  const dragCleanup = useRef5(null);
  useEffect6(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect6(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect6(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (docked && useViewerTabs.getState().fullscreen) {
          useViewerTabs.getState().setFullscreen(false);
          return;
        }
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, docked]);
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const w = Math.max(320, Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)));
      setWidth(w);
      try {
        localStorage.setItem("coder:traceWidth", String(w));
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
  const fetchSeqRef = useRef5(0);
  const fetchAll = useCallback3(
    async (silent) => {
      if (!activeChatId) {
        setEntries([]);
        setServerCounts(null);
        setServerTotal(0);
        setReachedStart(false);
        return;
      }
      const mySeq = ++fetchSeqRef.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const out = await getChatTraces(activeChatId, void 0, taskId || void 0, {
          limit: TRACE_PAGE,
          before: 0,
          sub: Boolean(taskId)
        });
        if (mySeq !== fetchSeqRef.current) return;
        if ("traces" in out) {
          const page = out.traces;
          setServerCounts(out.counts);
          setServerTotal(out.total);
          setEntries((prev) => {
            if (prev.length === 0) return page;
            const have = new Set(prev.map((e) => e.id));
            const fresh = page.filter((e) => !have.has(e.id));
            if (fresh.length === 0) return prev;
            const merged = [...prev, ...fresh];
            const cap = TRACE_PAGE * 2;
            return merged.length > cap ? merged.slice(merged.length - cap) : merged;
          });
          if (!silent) setError(null);
        } else if (!silent) {
          setEntries([]);
          setServerCounts(null);
          setServerTotal(0);
          setError(out?.error ?? "trace request failed");
        }
      } catch (e) {
        if (mySeq !== fetchSeqRef.current) return;
        if (!silent) {
          setEntries([]);
          setServerCounts(null);
          setServerTotal(0);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (mySeq !== fetchSeqRef.current) return;
        if (!silent) setLoading(false);
      }
    },
    [activeChatId, taskId]
  );
  const loadingOlderRef = useRef5(false);
  const loadOlder = useCallback3(async () => {
    if (!activeChatId || loadingOlderRef.current || reachedStart) return;
    loadingOlderRef.current = true;
    setOlderLoading(true);
    try {
      const activeFilter = taskId ? void 0 : tab === "all" ? void 0 : tab;
      const before = visibleCountRef.current;
      const out = await getChatTraces(activeChatId, activeFilter, taskId || void 0, {
        limit: TRACE_PAGE,
        before,
        sub: Boolean(taskId)
      });
      if ("traces" in out && Array.isArray(out.traces)) {
        const older = out.traces;
        setServerCounts(out.counts);
        setServerTotal(out.total);
        if (older.length === 0) {
          setReachedStart(true);
        } else {
          setEntries((prev) => {
            const have = new Set(prev.map((e) => e.id));
            const fresh = older.filter((e) => !have.has(e.id));
            if (fresh.length === 0) {
              setReachedStart(true);
              return prev;
            }
            return [...fresh, ...prev];
          });
        }
      }
    } catch {
    } finally {
      loadingOlderRef.current = false;
      setOlderLoading(false);
    }
  }, [activeChatId, taskId, tab, reachedStart]);
  useEffect6(() => {
    if (!activeChatId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void fetchAll(false).catch(() => {
    });
    const timer = window.setInterval(() => {
      if (!cancelled) void fetchAll(true).catch(() => {
      });
    }, 2e3);
    return () => {
      cancelled = true;
      fetchSeqRef.current++;
      window.clearInterval(timer);
    };
  }, [activeChatId, fetchAll]);
  const counts = useMemo3(() => getTraceTabCounts(entries, Boolean(taskId)), [entries, taskId]);
  const badges = useMemo3(
    () => serverCounts ? serverCounts : counts,
    [serverCounts, counts]
  );
  const visible = useMemo3(() => {
    const subView = Boolean(taskId);
    const byTab = tab === "all" ? entries : tab === "tool" ? entries.filter((e) => isToolTraceKind(e.kind) && (subView || !isSubToolTrace(e))) : entries.filter((e) => e.kind === tab);
    return filterTraces(byTab, query);
  }, [entries, tab, query, taskId]);
  const visibleCountRef = useRef5(0);
  useEffect6(() => {
    visibleCountRef.current = visible.length;
  }, [visible.length]);
  const turnGroups = useMemo3(() => groupTracesByTurn(visible), [visible]);
  const totalTokens = useMemo3(
    () => entries.reduce((n, e) => n + (e.tokens?.total ?? 0), 0),
    [entries]
  );
  const searchParts = useMemo3(
    () => query.trim() ? visible.map((e) => traceEntrySearchParts(e)) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, tab, entries]
  );
  const hitCounts = useMemo3(
    () => query.trim() ? searchParts.map((p) => countTraceEntryHits(p, query)) : [],
    [searchParts, query]
  );
  const matchCount = hitCounts.reduce((n, c2) => n + c2, 0);
  const [activeIndex, setActiveIndex] = useState6(-1);
  useEffect6(() => {
    setActiveIndex(matchCount > 0 ? 0 : -1);
  }, [query, tab, entries.length]);
  const activeRef = useRef5(null);
  useEffect6(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);
  const stepSearch = (dir) => {
    setActiveIndex((cur) => stepHitIndex(cur, matchCount, dir));
  };
  const baseById = useMemo3(() => {
    const m = /* @__PURE__ */ new Map();
    let acc = 0;
    for (let i = 0; i < visible.length; i++) {
      m.set(visible[i].id, acc);
      acc += hitCounts[i] ?? 0;
    }
    return m;
  }, [visible, hitCounts]);
  const listRef = useRef5(null);
  const stickRef = useRef5(true);
  const [stuck, setStuck] = useState6(true);
  const prependAnchorRef = useRef5(null);
  const onListScroll = useCallback3(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = nearBottom;
    setStuck(nearBottom);
    if (el.scrollTop < 160) {
      if (prependAnchorRef.current == null) {
        prependAnchorRef.current = el.scrollHeight;
      }
      void loadOlder();
    }
  }, [loadOlder]);
  useLayoutEffect2(() => {
    const el = listRef.current;
    const prev = prependAnchorRef.current;
    if (!el || prev == null) return;
    if (el.scrollHeight !== prev) {
      el.scrollTop += el.scrollHeight - prev;
      prependAnchorRef.current = null;
    }
  }, [entries.length]);
  useEffect6(() => {
    if (stickRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [visible.length, tab, activeChatId]);
  const jumpToLatest = useCallback3(() => {
    stickRef.current = true;
    setStuck(true);
    listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0, behavior: "smooth" });
  }, []);
  useEffect6(() => {
    setReachedStart(false);
    prependAnchorRef.current = null;
  }, [activeChatId, tab, taskId]);
  const panel = /* @__PURE__ */ jsxs9(
    "div",
    {
      className: docked ? "review-docked-wrap" : `review-overlay${fullscreen ? " fullscreen" : ""}`,
      dir: "ltr",
      style: docked ? void 0 : { "--review-w": `${width}px` },
      onClick: (e) => e.stopPropagation(),
      children: [
        !docked && /* @__PURE__ */ jsx10("div", { className: "review-scrim", "aria-hidden": "true", onClick: close }),
        !docked && !fullscreen && /* @__PURE__ */ jsx10(
          "div",
          {
            className: "review-overlay-resize-handle",
            title: "Drag to resize",
            onMouseDown: startResize
          }
        ),
        /* @__PURE__ */ jsxs9("aside", { className: docked ? "review-panel review-docked-panel" : "review-panel review-floating-panel", dir: "ltr", "aria-label": "Chat traces", children: [
          /* @__PURE__ */ jsxs9("div", { className: "review-header", children: [
            /* @__PURE__ */ jsx10("span", { className: "review-source", role: "tablist", "aria-label": "Trace filter", children: TABS.map(([key, label]) => /* @__PURE__ */ jsxs9(
              "button",
              {
                role: "tab",
                "aria-selected": tab === key,
                className: `review-source-btn${tab === key ? " active" : ""}`,
                onClick: () => setTab(key),
                title: key === "all" ? "Show everything" : `Filter: ${label}`,
                "aria-label": `${label}, ${badges[key] ?? 0} items`,
                children: [
                  /* @__PURE__ */ jsx10("span", { className: "trace-tab-label", children: label }),
                  /* @__PURE__ */ jsx10("span", { className: "trace-tab-count", children: badges[key] ?? 0 })
                ]
              },
              key
            )) }),
            /* @__PURE__ */ jsxs9("span", { className: "review-header-actions", children: [
              /* @__PURE__ */ jsx10(CopyTracesButton, { entries: visible, query, tab }),
              /* @__PURE__ */ jsx10(
                "button",
                {
                  className: "review-header-btn",
                  title: "Clear traces",
                  "aria-label": "Clear traces",
                  onClick: () => {
                    if (!activeChatId) return;
                    void (async () => {
                      await clearChatTraces(activeChatId);
                      setEntries([]);
                      setServerCounts(null);
                      setServerTotal(0);
                      setReachedStart(false);
                    })();
                  },
                  children: /* @__PURE__ */ jsxs9("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx10("path", { d: "M3 6h18" }),
                    /* @__PURE__ */ jsx10("path", { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" }),
                    /* @__PURE__ */ jsx10("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" })
                  ] })
                }
              ),
              !docked && /* @__PURE__ */ jsx10(ViewerFullscreenButton, { docked, fullscreen, onToggleFullscreen: () => setFullscreen((v) => !v) }),
              !docked && /* @__PURE__ */ jsx10(
                "button",
                {
                  className: "review-header-btn",
                  title: "Close",
                  "aria-label": "Close",
                  onClick: close,
                  children: /* @__PURE__ */ jsxs9("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx10("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                    /* @__PURE__ */ jsx10("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
                  ] })
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsx10("div", { className: "trace-subheader", children: /* @__PURE__ */ jsxs9("span", { className: "trace-subheader-text", children: [
            taskId ? `Sub-agent ${traceTitle || taskId.slice(0, 8)} \xB7 ` : "",
            serverCounts ? `${entries.length} of ${serverTotal} events` : `${entries.length} events`,
            totalTokens > 0 ? ` \xB7 ${totalTokens} tokens` : ""
          ] }) }),
          /* @__PURE__ */ jsx10("div", { className: "review-search-row", children: /* @__PURE__ */ jsxs9("label", { className: "review-search", dir: "ltr", children: [
            /* @__PURE__ */ jsx10("span", { "aria-hidden": "true", children: "\u{1F50D}" }),
            /* @__PURE__ */ jsx10(
              "input",
              {
                className: "review-search-input",
                type: "search",
                placeholder: "Search prompts, responses, args\u2026",
                value: query,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter" && matchCount > 0) {
                    e.preventDefault();
                    stepSearch(e.shiftKey ? -1 : 1);
                  }
                }
              }
            ),
            query.trim() ? matchCount > 0 ? /* @__PURE__ */ jsxs9("span", { className: "review-search-nav", children: [
              /* @__PURE__ */ jsxs9("span", { className: "review-search-count", children: [
                activeIndex + 1,
                "/",
                matchCount
              ] }),
              /* @__PURE__ */ jsx10(
                "button",
                {
                  type: "button",
                  className: "review-search-btn",
                  title: "Previous match (Shift+Enter)",
                  "aria-label": "Previous match",
                  onClick: () => stepSearch(-1),
                  children: "\u2191"
                }
              ),
              /* @__PURE__ */ jsx10(
                "button",
                {
                  type: "button",
                  className: "review-search-btn",
                  title: "Next match (Enter)",
                  "aria-label": "Next match",
                  onClick: () => stepSearch(1),
                  children: "\u2193"
                }
              )
            ] }) : /* @__PURE__ */ jsx10("span", { className: "review-search-count", children: "0 hits" }) : null
          ] }) }),
          loading ? /* @__PURE__ */ jsx10("div", { className: "review-empty", children: "loading\u2026" }) : error ? /* @__PURE__ */ jsx10("div", { className: "review-empty", children: error }) : visible.length === 0 ? /* @__PURE__ */ jsx10("div", { className: "review-empty", children: query.trim() ? `No traces match \u201C${query.trim()}\u201D.` : "No traces yet for this chat." }) : /* @__PURE__ */ jsxs9("div", { className: "trace-panel-list", ref: listRef, onScroll: onListScroll, children: [
            (olderLoading || !reachedStart && serverTotal > visible.length) && /* @__PURE__ */ jsx10("div", { className: "trace-load-older", children: olderLoading ? "loading older\u2026" : "scroll up for older events" }),
            turnGroups.map((g) => /* @__PURE__ */ jsx10(
              TraceTurnGroup,
              {
                turn: g.turn,
                inferred: g.inferred,
                entries: g.entries,
                query,
                hitBases: g.entries.map((e) => baseById.get(e.id) ?? 0),
                activeHit: activeIndex,
                activeRef
              },
              g.turn !== null ? `turn-${g.turn}` : `turn-inferred-${g.inferred}`
            ))
          ] }),
          !stuck && visible.length > 0 && /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              className: "trace-jump-latest",
              onClick: jumpToLatest,
              title: "Jump to latest traces",
              children: "\u2193 Latest"
            }
          )
        ] })
      ]
    }
  );
  if (docked || typeof document === "undefined") return panel;
  return createPortal3(panel, document.body);
}
var TABS, TRACE_PAGE;
var init_TracePanel = __esm({
  "src/components/TracePanel.tsx"() {
    "use strict";
    init_store();
    init_tracePanel();
    init_viewerTabs();
    init_ViewerFullscreenButton();
    init_api();
    init_clipboard();
    init_diffSearch();
    TABS = [
      ["all", "All"],
      ["llm", "LLM"],
      ["prompt", "Prompts"],
      ["tool", "Tools"],
      ["fold", "Folds"]
    ];
    TRACE_PAGE = 200;
  }
});

// sounds/alert.mp3
var alert_default;
var init_alert = __esm({
  "sounds/alert.mp3"() {
    alert_default = "./alert-HKTBWUCH.mp3";
  }
});

// sounds/error.mp3
var error_default;
var init_error = __esm({
  "sounds/error.mp3"() {
    error_default = "./error-DIY5N2ML.mp3";
  }
});

// src/lib/alarm.ts
function playAlarm(kind) {
  try {
    const audio = new Audio(ALARM_URLS[kind]);
    audio.preload = "auto";
    ACTIVE.add(audio);
    audio.addEventListener("ended", () => ACTIVE.delete(audio), { once: true });
    audio.play().catch((err) => {
      console.warn(`[alarm] '${kind}' playback failed:`, err);
      ACTIVE.delete(audio);
    });
  } catch (err) {
    console.warn("[alarm] could not start playback:", err);
  }
}
var ALARM_URLS, ACTIVE;
var init_alarm = __esm({
  "src/lib/alarm.ts"() {
    "use strict";
    init_alert();
    init_error();
    ALARM_URLS = {
      alert: alert_default,
      error: error_default
    };
    ACTIVE = /* @__PURE__ */ new Set();
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
  if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) return;
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
var ARROW_CHARS, ARROW_RE_SRC, ARROW_GLOBAL, HAS_ARROW, SPACE, OPEN_PUNCT, CLOSE_PUNCT, SKIP_TAGS, isArrowChar, BLOCK_SELECTOR;
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
    SKIP_TAGS = /* @__PURE__ */ new Set(["code", "pre", "a"]);
    isArrowChar = (c2) => c2 !== void 0 && (ARROW_CHARS.includes(c2) || c2 === "\uFE0E" || c2 === "\uFE0F");
    BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div";
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
function fmtAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1e3));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
var init_time = __esm({
  "src/lib/time.ts"() {
    "use strict";
  }
});

// src/lib/errorText.ts
var init_errorText = __esm({
  "src/lib/errorText.ts"() {
    "use strict";
  }
});

// src/lib/planDoc.ts
function planDisplay(message) {
  const planDoc = message.planDoc;
  if (!planDoc) return { content: message.content, segments: message.segments };
  let segments = message.segments;
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
  let content = message.content;
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
function latestPlanDoc(chats, activeChatId) {
  const chat = chats.find((c2) => c2.id === activeChatId);
  if (!chat) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const doc = chat.messages[i]?.planDoc;
    if (doc?.body) return doc;
  }
  return null;
}
var init_planDoc = __esm({
  "src/lib/planDoc.ts"() {
    "use strict";
  }
});

// src/lib/tts.ts
import { useCallback as useCallback4, useEffect as useEffect7, useRef as useRef6, useState as useState7 } from "react";
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
  const idRef = useRef6(-1);
  if (idRef.current === -1) idRef.current = nextOwnerId++;
  const myId = idRef.current;
  const [status, setStatus] = useState7(
    () => activeOwner === myId || activeOwner === -1 ? activeStatus : "idle"
  );
  useEffect7(() => {
    const listener = (s, owner) => {
      setStatus(owner === myId ? s : "idle");
    };
    const unsubscribe = subscribeTts(listener);
    listener(activeStatus, activeOwner);
    return unsubscribe;
  }, [myId]);
  const stop = useCallback4(() => {
    stopTts(myId);
    setStatus((prev) => activeOwner === myId ? prev : "idle");
  }, [myId]);
  const play = useCallback4(
    async (text, opts) => {
      await playTts(text, opts, myId);
    },
    [myId]
  );
  const toggle = useCallback4(
    async (text, opts) => {
      await toggleTts(text, opts, myId);
    },
    [myId]
  );
  const pause = useCallback4(() => {
    pauseTts(myId);
  }, [myId]);
  const resume = useCallback4(async () => {
    await resumeTts(myId);
  }, [myId]);
  useEffect7(() => () => stopTts(idRef.current), []);
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
var activeAudio, activeUrl, activeOwner, activeStatus, nextOwnerId, activeSeq, seqCounter, activeAbort, listeners, SENTENCE_FETCH_TIMEOUT_MS, TTS_RETRY_ATTEMPTS, TTS_RETRY_DELAY_MS, PLAYBACK_WATCHDOG_MIN_MS, PLAYBACK_WATCHDOG_PER_BYTE_MS, PLAYBACK_WATCHDOG_MAX_MS, INTER_SENTENCE_GAP_MS;
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

// src/components/ArtifactCard.tsx
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
function ArtifactCard({ segment }) {
  const chatId = useStore((s) => s.activeChatId);
  const open = () => {
    useViewerTabs.getState().openArtifact(chatId ?? "", {
      id: segment.id,
      title: segment.title,
      kind: segment.artifactKind,
      body: segment.content
    });
  };
  return /* @__PURE__ */ jsx11("div", { className: "artifact-card", children: /* @__PURE__ */ jsxs10("div", { className: "artifact-card-head", children: [
    /* @__PURE__ */ jsx11("span", { className: "artifact-card-icon", "aria-hidden": "true", children: segment.artifactKind === "md" ? "\xB6" : "</>" }),
    /* @__PURE__ */ jsx11("span", { className: "artifact-card-title", title: segment.title || segment.id, children: segment.title || segment.id }),
    /* @__PURE__ */ jsxs10("span", { className: "artifact-card-meta", children: [
      segment.artifactKind,
      " \xB7 v",
      segment.version
    ] }),
    /* @__PURE__ */ jsx11("button", { className: "btn secondary artifact-card-open", onClick: open, children: "Open" })
  ] }) });
}
var init_ArtifactCard = __esm({
  "src/components/ArtifactCard.tsx"() {
    "use strict";
    init_store();
    init_viewerTabs();
  }
});

// src/components/ExploreCard.tsx
import { useState as useState8 } from "react";
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
function exploreTitle(activity) {
  const args = activity.args ?? {};
  const desc = typeof args.description === "string" ? args.description.trim() : "";
  const summary = typeof activity.summary === "string" ? activity.summary.trim() : "";
  const first = (desc || summary).split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}\u2026` : first || "Explore";
}
function exploreToolCounts(activity) {
  const counts = /* @__PURE__ */ new Map();
  const walk = (list) => {
    for (const a of list ?? []) {
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
function exploreCallTotal(activity) {
  return exploreToolCounts(activity).reduce((n, c2) => n + c2.count, 0);
}
function fmtMs(ms) {
  if (!ms) return "";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1e3;
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}
function statusLabel(status) {
  if (status === "running") return "Working\u2026";
  if (status === "error") return "Failed";
  if (status === "denied") return "Blocked";
  return "Done";
}
function ExploreCard({
  activity
}) {
  const [open, setOpen] = useState8(false);
  const running = activity.status === "running";
  const now = useRunningClock(running);
  const ms = running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
  const title = exploreTitle(activity);
  const counts = exploreToolCounts(activity);
  const total = exploreCallTotal(activity);
  const state = statusLabel(activity.status);
  const children = activity.children ?? [];
  const report = (activity.resultText ?? "").trim();
  return /* @__PURE__ */ jsx12("div", { className: `tool-card explore ${activity.status}${running ? " running" : ""}`, children: /* @__PURE__ */ jsxs11("div", { className: "tool-group explore", children: [
    /* @__PURE__ */ jsxs11(
      "button",
      {
        type: "button",
        className: "trace-head explore-card-open",
        title: open ? "Fold this run" : "Show this run's tool calls",
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        children: [
          /* @__PURE__ */ jsx12(
            "span",
            {
              className: `explore-card-status ${activity.status}`,
              role: "img",
              title: state,
              "aria-label": state,
              children: /* @__PURE__ */ jsx12(StatusIcon, { status: activity.status })
            }
          ),
          /* @__PURE__ */ jsx12("span", { className: "trace-pill trace-pill-sub", children: "Explore" }),
          /* @__PURE__ */ jsx12("span", { className: "trace-head-desc", dir: "auto", title, children: title }),
          /* @__PURE__ */ jsxs11("span", { className: "trace-head-right", children: [
            total > 0 && /* @__PURE__ */ jsx12("span", { className: "explore-card-count", children: `${total} calls` }),
            ms ? /* @__PURE__ */ jsx12("span", { className: "trace-time", children: fmtMs(ms) }) : null,
            /* @__PURE__ */ jsx12("span", { className: "explore-card-arrow", "aria-hidden": "true", children: /* @__PURE__ */ jsx12(IconChevron, { open }) })
          ] })
        ]
      }
    ),
    running && /* @__PURE__ */ jsx12("div", { className: "explore-card-progress", "aria-hidden": "true" }),
    counts.length > 0 && /* @__PURE__ */ jsx12("div", { className: "explore-tool-chips", children: counts.map((c2) => /* @__PURE__ */ jsxs11("span", { className: "explore-tool-chip", title: c2.label, children: [
      /* @__PURE__ */ jsx12("span", { className: "explore-tool-name", children: c2.label }),
      /* @__PURE__ */ jsx12("span", { className: "explore-tool-n", children: `\xD7${c2.count}` })
    ] }, c2.label)) }),
    open && /* @__PURE__ */ jsxs11("div", { className: "tool-sub-list", children: [
      children.map((child, i) => /* @__PURE__ */ jsx12(
        ToolSubRow,
        {
          activity: child,
          hideResult: child.tool === "read"
        },
        `${child.tool}-${i}-${child.callId ?? i}`
      )),
      report && /* @__PURE__ */ jsx12("pre", { className: "tool-sub-result explore-report", dir: "auto", children: report })
    ] })
  ] }) });
}
var init_ExploreCard = __esm({
  "src/components/ExploreCard.tsx"() {
    "use strict";
    init_ToolCallView();
  }
});

// src/components/FullscreenModal.tsx
import { useEffect as useEffect8, useRef as useRef7, useState as useState9 } from "react";
import { createPortal as createPortal4 } from "react-dom";
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
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
  const [zoom, setZoom] = useState9(1);
  const [pan, setPan] = useState9({ x: 0, y: 0 });
  const [sel, setSel] = useState9(null);
  const [cursor, setCursor] = useState9("grab");
  const dragRef = useRef7(null);
  const selRef = useRef7(null);
  const viewportRef = useRef7(null);
  const zoomRef = useRef7(zoom);
  const panRef = useRef7(pan);
  useEffect8(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect8(() => {
    if (open) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setSel(null);
    }
  }, [open]);
  useEffect8(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);
  useEffect8(() => {
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
  return createPortal4(
    /* @__PURE__ */ jsx13("div", { className: "fullscreen-modal-scrim", onClick: onClose, role: "presentation", children: /* @__PURE__ */ jsxs12(
      "div",
      {
        className: "fullscreen-modal-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title ?? "Full screen",
        onClick: (e) => e.stopPropagation(),
        children: [
          /* @__PURE__ */ jsxs12("div", { className: "fullscreen-modal-head", children: [
            /* @__PURE__ */ jsx13("span", { className: "fullscreen-modal-title", children: title }),
            /* @__PURE__ */ jsx13(
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
          /* @__PURE__ */ jsxs12("div", { className: `fullscreen-modal-body ${bodyClass ?? ""}`, children: [
            /* @__PURE__ */ jsxs12(
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
                  /* @__PURE__ */ jsx13(
                    "div",
                    {
                      className: "fullscreen-pan-content",
                      style: scrollable ? void 0 : { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` },
                      children
                    }
                  ),
                  !scrollable && sel && /* @__PURE__ */ jsx13(
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
            !scrollable && /* @__PURE__ */ jsx13("div", { className: "fullscreen-zoom-bar", children: /* @__PURE__ */ jsx13("button", { onClick: reset, "aria-label": "Reset zoom", title: "Reset zoom (100%)", children: "\u27F3" }) })
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
import { create as create5 } from "zustand";
var useFullscreen;
var init_fullscreen = __esm({
  "src/lib/fullscreen.ts"() {
    "use strict";
    useFullscreen = create5((set) => ({
      activeKey: null,
      open: (key) => set({ activeKey: key }),
      close: () => set({ activeKey: null })
    }));
  }
});

// src/components/MessageImages.tsx
import { useId, useState as useState10 } from "react";
import { Fragment as Fragment5, jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function MessageImages({
  images,
  modalTitle
}) {
  const fsKey = useId();
  const activeKey = useFullscreen((s) => s.activeKey);
  const openFs = useFullscreen((s) => s.open);
  const closeFs = useFullscreen((s) => s.close);
  const [selected, setSelected] = useState10(null);
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
  return /* @__PURE__ */ jsxs13(Fragment5, { children: [
    /* @__PURE__ */ jsx14("div", { className: "msg-images", dir: "ltr", children: images.map((img, idx) => /* @__PURE__ */ jsx14(
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
        children: usable(img.dataUrl) ? /* @__PURE__ */ jsx14(
          "img",
          {
            src: img.dataUrl,
            alt: img.name,
            loading: "lazy",
            decoding: "async"
          }
        ) : /* @__PURE__ */ jsx14("span", { className: "msg-image-ph", children: img.name })
      },
      img.path
    )) }),
    current && usable(current.dataUrl) && /* @__PURE__ */ jsx14(
      FullscreenModal,
      {
        open: expanded,
        onClose: close,
        title: modalTitle ?? current.name,
        children: /* @__PURE__ */ jsx14("div", { className: "image-fullscreen", children: /* @__PURE__ */ jsx14("img", { src: current.dataUrl, alt: current.name, decoding: "async" }) })
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

// src/lib/useVisible.ts
import { useEffect as useEffect9, useState as useState11 } from "react";
function useVisible(ref, enabled = true) {
  const [visible, setVisible] = useState11(false);
  useEffect9(() => {
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
import { useEffect as useEffect10, useId as useId2, useMemo as useMemo4, useRef as useRef8, useState as useState12 } from "react";
import { Fragment as Fragment6, jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
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
  const [svg, setSvg] = useState12(null);
  const [failed2, setFailed] = useState12(false);
  const renderTokenRef = useRef8(0);
  const mountedRef = useRef8(false);
  useEffect10(() => {
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
  const blockRef = useRef8(null);
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
  useEffect10(() => {
    if (!visible) return;
    const t = setTimeout(() => void renderDiagram(), 400);
    return () => clearTimeout(t);
  }, [chart, visible]);
  if (failed2) {
    return /* @__PURE__ */ jsxs14(Fragment6, { children: [
      /* @__PURE__ */ jsx15(
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
      !embedded && /* @__PURE__ */ jsx15(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx15("div", { className: "mermaid-fullscreen", children: /* @__PURE__ */ jsx15("pre", { className: "mermaid-fallback", dir: "auto", children: chart }) }) })
    ] });
  }
  const safeSvg = useMemo4(() => hardenSvg(svg), [svg]);
  if (!safeSvg) {
    return /* @__PURE__ */ jsxs14("div", { className: "mermaid-block mermaid-loading", ref: blockRef, "data-visible": String(visible), dir: "auto", children: [
      /* @__PURE__ */ jsx15("span", { className: "spinner" }),
      /* @__PURE__ */ jsx15("span", { children: "Diagram\u2026" })
    ] });
  }
  const diagram = /* @__PURE__ */ jsx15(
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
  return /* @__PURE__ */ jsxs14(Fragment6, { children: [
    diagram,
    /* @__PURE__ */ jsx15(FullscreenModal, { open: expanded, onClose: closeFs, title: "Diagram", children: /* @__PURE__ */ jsx15("div", { className: "mermaid-fullscreen", children: safeSvg ? /* @__PURE__ */ jsx15("div", { className: "mermaid-block", dir: "auto", dangerouslySetInnerHTML: { __html: safeSvg } }) : /* @__PURE__ */ jsx15(Mermaid, { chart, embedded: true }) }) })
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

// src/lib/shortcuts.ts
function physicalKey(e) {
  const c2 = e.code || "";
  if (c2.startsWith("Key")) return c2.slice(3).toLowerCase();
  if (c2 === "Comma") return ",";
  if (c2 === "Slash") return "/";
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
import { useEffect as useEffect11, useMemo as useMemo5, useRef as useRef9, useState as useState13 } from "react";
import { createPortal as createPortal5 } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Fragment as Fragment7, jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
function ReadingMode({
  message,
  onClose
}) {
  const dir = useStore((s) => s.dir);
  const sections = useMemo5(() => splitSections(message.content), [message.content]);
  const [active, setActive] = useState13(0);
  const [copied, setCopied] = useState13(false);
  const [progress, setProgress] = useState13(0);
  const [width, setWidth] = useState13(() => {
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
  useEffect11(() => {
    const onResize = () => {
      setWidth((w) => Math.max(320, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const contentRef = useRef9(null);
  useEffect11(() => {
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
  useEffect11(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [active]);
  useEffect11(() => {
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
  const dragCleanup = useRef9(null);
  useEffect11(() => {
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
  const panel = /* @__PURE__ */ jsxs15(
    "div",
    {
      className: "reading-mode",
      dir,
      style: { "--reading-w": `${width}px` },
      onClick: (e) => e.stopPropagation(),
      children: [
        /* @__PURE__ */ jsx16("div", { className: "reading-mode-scrim", "aria-hidden": "true", onClick: onClose }),
        /* @__PURE__ */ jsxs15(
          "div",
          {
            className: "reading-mode-panel",
            role: "dialog",
            "aria-modal": "false",
            "aria-label": "Reading mode",
            children: [
              /* @__PURE__ */ jsx16(
                "div",
                {
                  className: "reading-mode-resize-handle",
                  title: "Drag to resize",
                  onMouseDown: startResize
                }
              ),
              /* @__PURE__ */ jsxs15("div", { className: "reading-mode-head", children: [
                /* @__PURE__ */ jsxs15("div", { className: "reading-mode-title", children: [
                  /* @__PURE__ */ jsx16("h2", { children: "Reading Mode" }),
                  /* @__PURE__ */ jsxs15("span", { className: "reading-mode-tab", children: [
                    "Section ",
                    active + 1,
                    " of ",
                    sections.length
                  ] })
                ] }),
                /* @__PURE__ */ jsxs15("div", { className: "reading-mode-head-actions", children: [
                  /* @__PURE__ */ jsx16(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.max(a - 1, 0)),
                      disabled: active === 0,
                      title: "Previous section (\u2191)",
                      "aria-label": "Previous section",
                      children: /* @__PURE__ */ jsx16(ChevronUpIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx16(
                    "button",
                    {
                      className: "reading-mode-nav",
                      onClick: () => setActive((a) => Math.min(a + 1, sections.length - 1)),
                      disabled: active === sections.length - 1,
                      title: "Next section (\u2193)",
                      "aria-label": "Next section",
                      children: /* @__PURE__ */ jsx16(ChevronDownIcon, {})
                    }
                  ),
                  /* @__PURE__ */ jsx16(
                    "button",
                    {
                      className: `reading-mode-copy${copied ? " copied" : ""}`,
                      onClick: copy,
                      title: "Copy section text",
                      children: copied ? /* @__PURE__ */ jsxs15(Fragment7, { children: [
                        /* @__PURE__ */ jsx16(
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
                            children: /* @__PURE__ */ jsx16("path", { d: "M20 6 9 17l-5-5" })
                          }
                        ),
                        "Copied"
                      ] }) : /* @__PURE__ */ jsxs15(Fragment7, { children: [
                        /* @__PURE__ */ jsxs15(
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
                              /* @__PURE__ */ jsx16("rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }),
                              /* @__PURE__ */ jsx16("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" })
                            ]
                          }
                        ),
                        "Copy"
                      ] })
                    }
                  ),
                  /* @__PURE__ */ jsx16(
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
              /* @__PURE__ */ jsx16("div", { className: "reading-mode-progress", "aria-hidden": "true", children: /* @__PURE__ */ jsx16("span", { style: { width: `${progress * 100}%` } }) }),
              /* @__PURE__ */ jsxs15("div", { className: "reading-mode-body", children: [
                /* @__PURE__ */ jsxs15("div", { className: "reading-mode-list", children: [
                  /* @__PURE__ */ jsxs15("div", { className: "reading-mode-list-label", children: [
                    "Contents",
                    /* @__PURE__ */ jsx16("span", { className: "reading-mode-list-count", children: sections.length })
                  ] }),
                  sections.map((s, i) => /* @__PURE__ */ jsxs15(
                    "div",
                    {
                      className: `reading-mode-item${i === active ? " active" : ""}`,
                      style: { "--i": i },
                      "aria-current": i === active ? "true" : void 0,
                      children: [
                        /* @__PURE__ */ jsx16("span", { className: "reading-mode-item-num", children: i + 1 }),
                        /* @__PURE__ */ jsx16(
                          "button",
                          {
                            className: "reading-mode-item-title",
                            onClick: () => setActive(i),
                            title: s.title,
                            dir,
                            children: /* @__PURE__ */ jsx16(
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
                /* @__PURE__ */ jsxs15("div", { className: "reading-mode-content", ref: contentRef, children: [
                  /* @__PURE__ */ jsx16("div", { className: "reading-mode-content-head", children: /* @__PURE__ */ jsxs15("div", { className: "reading-mode-content-title", children: [
                    /* @__PURE__ */ jsx16("span", { className: "reading-mode-content-num", children: active + 1 }),
                    /* @__PURE__ */ jsx16("h3", { dir, children: section.title })
                  ] }) }),
                  /* @__PURE__ */ jsx16("div", { className: "reading-mode-content-inner", children: /* @__PURE__ */ jsx16("div", { className: "chat-message markdown-body", dir, children: /* @__PURE__ */ jsx16(
                    ReactMarkdown,
                    {
                      remarkPlugins: [remarkGfm],
                      components: mdComponents,
                      children: prepareContent(section.content, dir)
                    }
                  ) }) }, active)
                ] })
              ] }),
              /* @__PURE__ */ jsxs15("div", { className: "reading-mode-foot", children: [
                /* @__PURE__ */ jsxs15("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx16("kbd", { children: "\u2191" }),
                  " ",
                  /* @__PURE__ */ jsx16("kbd", { children: "\u2193" }),
                  " navigate sections"
                ] }),
                /* @__PURE__ */ jsxs15("span", { className: "reading-mode-foot-hint", children: [
                  /* @__PURE__ */ jsx16("kbd", { children: "Esc" }),
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
  return createPortal5(panel, document.body);
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
    ChevronUpIcon = () => /* @__PURE__ */ jsx16(
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
        children: /* @__PURE__ */ jsx16("path", { d: "m18 15-6-6-6 6" })
      }
    );
    ChevronDownIcon = () => /* @__PURE__ */ jsx16(
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
        children: /* @__PURE__ */ jsx16("path", { d: "m6 9 6 6 6-6" })
      }
    );
  }
});

// src/components/ChatMessage.tsx
import {
  Suspense,
  lazy,
  memo as memo2,
  useEffect as useEffect12,
  useLayoutEffect as useLayoutEffect3,
  useMemo as useMemo6,
  useRef as useRef10,
  useState as useState14
} from "react";
import ReactMarkdown2, { defaultUrlTransform } from "react-markdown";
import remarkGfm2 from "remark-gfm";
import { Fragment as Fragment8, jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsx17("div", { className: "msg-attachments", dir: "ltr", children: paths.map((p) => /* @__PURE__ */ jsx17(FileChip, { path: p, display: attachmentBasename(p) }, p)) });
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
function useCapped(id, text, live) {
  const over = !live && text.length > RENDER_CAP;
  const [showAll, setShowAll] = useState14(false);
  useEffect12(() => {
    setShowAll(false);
  }, [id]);
  const shown = over && !showAll ? text.slice(0, RENDER_CAP) : text;
  return { shown, over, cut: text.length - shown.length, showAll, setShowAll };
}
function PlanDocCard({
  planDoc
}) {
  const [copied, setCopied] = useState14(false);
  const appDir = useStore((s) => s.dir);
  const preview = useMemo6(() => {
    const text = planDoc.body.replace(/```[\s\S]*?```/g, "\n[\u2026]\n").replace(/^#{1,6}\s+/gm, "").replace(/[*`>]/g, "").replace(/^plan\s*:?[ \t]*\n/i, "").trim();
    const clipped = text.length > 600 ? `${text.slice(0, 600).trimEnd()}\u2026` : text;
    return prepareContent(clipped, appDir);
  }, [planDoc.body, appDir]);
  return /* @__PURE__ */ jsxs16("div", { className: "plan-doc-card", dir: appDir, children: [
    /* @__PURE__ */ jsxs16("div", { className: "plan-doc-head", children: [
      /* @__PURE__ */ jsx17("span", { className: "plan-doc-icon", "aria-hidden": "true", children: /* @__PURE__ */ jsxs16(
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
            /* @__PURE__ */ jsx17("rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }),
            /* @__PURE__ */ jsx17("path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" })
          ]
        }
      ) }),
      /* @__PURE__ */ jsx17("span", { className: "plan-doc-label", children: "Plan" }),
      planDoc.title ? /* @__PURE__ */ jsx17("span", { className: "plan-doc-title", children: planDoc.title }) : null,
      /* @__PURE__ */ jsx17("span", { className: "plan-doc-spacer" }),
      /* @__PURE__ */ jsx17(
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
          children: copied ? /* @__PURE__ */ jsx17(
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
              children: /* @__PURE__ */ jsx17("path", { d: "M20 6L9 17l-5-5" })
            }
          ) : /* @__PURE__ */ jsxs16(
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
                /* @__PURE__ */ jsx17("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
                /* @__PURE__ */ jsx17("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
              ]
            }
          )
        }
      )
    ] }),
    /* @__PURE__ */ jsx17("div", { className: "plan-doc-preview", children: preview }),
    /* @__PURE__ */ jsxs16(
      "button",
      {
        type: "button",
        className: "plan-doc-open",
        onClick: () => useViewerTabs.getState().openPlan(),
        children: [
          "View full plan",
          /* @__PURE__ */ jsx17(
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
              children: /* @__PURE__ */ jsx17("path", { d: "M5 12h14M13 6l6 6-6 6" })
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
  const [errored, setErrored] = useState14(false);
  if (!src || errored) {
    return /* @__PURE__ */ jsx17("span", { className: "md-image-wrap md-image-errored", children: /* @__PURE__ */ jsxs16("span", { className: "md-image-fallback", children: [
      "\u{1F5BC}\uFE0F ",
      alt || "Image unavailable"
    ] }) });
  }
  return /* @__PURE__ */ jsxs16("span", { className: "md-image-wrap", children: [
    /* @__PURE__ */ jsx17(
      "img",
      {
        src,
        alt: alt ?? "",
        loading: "lazy",
        onError: () => setErrored(true),
        ...props
      }
    ),
    alt ? /* @__PURE__ */ jsx17("span", { className: "md-image-caption", children: alt }) : null
  ] });
}
function VideoThumbnailCard({
  video,
  href,
  children
}) {
  const [thumbErr, setThumbErr] = useState14(false);
  const label = children?.toString().trim() || video.title;
  const openVideo = () => void window.coder.openExternal(video.videoUrl);
  return /* @__PURE__ */ jsxs16(
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
        !thumbErr ? /* @__PURE__ */ jsx17(
          "img",
          {
            className: "md-video-thumb",
            src: video.thumbnailUrl,
            alt: label,
            loading: "lazy",
            onError: () => setThumbErr(true)
          }
        ) : /* @__PURE__ */ jsx17("span", { className: "md-video-thumb md-video-thumb-fallback", children: "\u{1F3AC}" }),
        /* @__PURE__ */ jsx17("span", { className: "md-video-play", children: "\u25B6" }),
        /* @__PURE__ */ jsx17("span", { className: "md-video-label", children: label })
      ]
    }
  );
}
function keepFileUrls(url) {
  return /^file:/i.test(url) ? url : defaultUrlTransform(url);
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
function ThinkingIndicator({
  startedAt,
  label = "Thinking"
}) {
  const [elapsed, setElapsed] = useState14(() => {
    const base = startedAt ?? Date.now();
    return Date.now() - base;
  });
  useEffect12(() => {
    const base = startedAt ?? Date.now();
    setElapsed(Date.now() - base);
    const id = setInterval(() => setElapsed(Date.now() - base), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return /* @__PURE__ */ jsx17("span", { className: "msg-thinking", "aria-label": label, children: /* @__PURE__ */ jsxs16("span", { className: "msg-thinking-inner", dir: "ltr", children: [
    /* @__PURE__ */ jsx17("span", { className: "msg-thinking-text", children: label }),
    /* @__PURE__ */ jsxs16("span", { className: "msg-thinking-dots", "aria-hidden": "true", children: [
      /* @__PURE__ */ jsx17("span", { className: "dot" }),
      /* @__PURE__ */ jsx17("span", { className: "dot" }),
      /* @__PURE__ */ jsx17("span", { className: "dot" })
    ] }),
    /* @__PURE__ */ jsx17("span", { className: "msg-thinking-elapsed", children: fmtElapsed(elapsed) })
  ] }) });
}
function isCollapsibleText(text) {
  return text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES;
}
function opensInPanel(text) {
  return text.length > USER_PANEL_CHARS || text.split("\n").length > USER_PANEL_LINES;
}
function textTabTitle(text, fallback) {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}\u2026` : firstLine;
}
function EditIcon() {
  return /* @__PURE__ */ jsxs16(
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
        /* @__PURE__ */ jsx17("path", { d: "M12 20h9" }),
        /* @__PURE__ */ jsx17("path", { d: "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" })
      ]
    }
  );
}
function UserMessageBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
  className
}) {
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState14(false);
  const [isEditing, setIsEditing] = useState14(false);
  const [draft, setDraft] = useState14("");
  const editInputRef = useRef10(null);
  useEffect12(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const content = message.content || "";
  const folded = isCollapsibleText(content);
  const inPanel = folded && opensInPanel(content);
  const [expanded, setExpanded] = useState14(false);
  useEffect12(() => setExpanded(false), [message.id]);
  const showFull = folded && !inPanel && expanded;
  const body = folded && !showFull ? content.slice(0, USER_COLLAPSE_CHARS) : content;
  const clamped = folded && !showFull;
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
  return /* @__PURE__ */ jsxs16(Fragment8, { children: [
    /* @__PURE__ */ jsxs16("div", { className: `msg-bubble${className ? ` ${className}` : ""}${isEditing ? " editing" : ""}`, children: [
      isEditing ? /* @__PURE__ */ jsxs16("div", { className: "msg-edit-wrap", children: [
        /* @__PURE__ */ jsx17(
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
        /* @__PURE__ */ jsxs16("div", { className: "msg-edit-actions", children: [
          /* @__PURE__ */ jsx17(
            "span",
            {
              className: "msg-edit-hint",
              title: "Escape cancels, Enter sends",
              "aria-hidden": "true",
              children: "i"
            }
          ),
          /* @__PURE__ */ jsx17("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
        ] })
      ] }) : /* @__PURE__ */ jsx17(
        "div",
        {
          className: `chat-message user-text${clamped ? " clamped" : ""}`,
          dir,
          children: cachedPrepare(message.id, body, dir) || "(empty)"
        }
      ),
      !isEditing && folded && /* @__PURE__ */ jsx17(
        "button",
        {
          className: "msg-expand",
          onClick: () => {
            if (!inPanel) {
              setExpanded((v) => !v);
              return;
            }
            useViewerTabs.getState().openText(textTabTitle(content, "Message"), content);
          },
          title: inPanel ? "Open the full text in the side panel" : void 0,
          children: inPanel ? "Show more" : expanded ? "Show less" : "Show more"
        }
      ),
      message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx17("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs16(
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
            /* @__PURE__ */ jsx17(FileIcon, { path: a, size: 20 }),
            attachmentBasename(a)
          ]
        },
        a
      )) }),
      message.images && message.images.length > 0 && /* @__PURE__ */ jsx17(MessageImages, { images: message.images })
    ] }),
    message.content && !isEditing && /* @__PURE__ */ jsxs16("div", { className: "msg-actions", children: [
      onRetry && /* @__PURE__ */ jsx17(
        "button",
        {
          className: "msg-copy msg-retry",
          onClick: () => onRetry(message.id),
          title: "Retry",
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
                /* @__PURE__ */ jsx17("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
                /* @__PURE__ */ jsx17("path", { d: "M3 3v5h5" })
              ]
            }
          )
        }
      ),
      onEdit && !isEditing && /* @__PURE__ */ jsx17(
        "button",
        {
          className: "msg-copy msg-edit",
          onClick: startEdit,
          disabled: editingDisabled,
          title: "Edit message",
          "aria-label": "Edit message",
          children: /* @__PURE__ */ jsx17(EditIcon, {})
        }
      ),
      /* @__PURE__ */ jsx17(
        "button",
        {
          className: `msg-copy ${copied ? "copied" : ""}`,
          onClick: copy,
          title: "Copy message",
          "aria-label": "Copy message",
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
      /* @__PURE__ */ jsx17(
        "button",
        {
          className: "msg-copy msg-fork",
          onClick: () => useStore.getState().forkChatFromMessage(message.id),
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
  const folded = isCollapsibleText(text);
  const inPanel = folded && opensInPanel(text);
  const [expanded, setExpanded] = useState14(false);
  useEffect12(() => setExpanded(false), [id]);
  const [isEditing, setIsEditing] = useState14(false);
  const [draft, setDraft] = useState14("");
  const editInputRef = useRef10(null);
  useEffect12(() => {
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
  return /* @__PURE__ */ jsxs16(Fragment8, { children: [
    isEditing ? /* @__PURE__ */ jsxs16("div", { className: "msg-edit-wrap", children: [
      /* @__PURE__ */ jsx17(
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
      /* @__PURE__ */ jsxs16("div", { className: "msg-edit-actions", children: [
        /* @__PURE__ */ jsx17(
          "span",
          {
            className: "msg-edit-hint",
            title: "Escape cancels, Enter sends",
            "aria-hidden": "true",
            children: "i"
          }
        ),
        /* @__PURE__ */ jsx17("button", { className: "msg-edit-cancel", onClick: cancelEdit, children: "Cancel" })
      ] })
    ] }) : /* @__PURE__ */ jsxs16(Fragment8, { children: [
      /* @__PURE__ */ jsx17(
        "div",
        {
          className: `queued-bubble-text${folded && !expanded ? " clamped" : ""}`,
          dir: detectDir(text),
          children: cachedPrepare(id, text, dir) || "(empty)"
        }
      ),
      folded && /* @__PURE__ */ jsx17(
        "button",
        {
          className: "msg-expand queued-expand",
          onClick: () => {
            if (!inPanel) {
              setExpanded((v) => !v);
              return;
            }
            useViewerTabs.getState().openText(textTabTitle(text, "Queued text"), text);
          },
          title: inPanel ? "Open the full text in the side panel" : void 0,
          children: inPanel ? "Show more" : expanded ? "Show less" : "Show more"
        }
      )
    ] }),
    onEdit && !isEditing && /* @__PURE__ */ jsx17("div", { className: "msg-actions", children: /* @__PURE__ */ jsx17(
      "button",
      {
        className: "msg-copy msg-edit",
        onClick: startEdit,
        disabled: editingDisabled,
        title: "Edit message",
        "aria-label": "Edit message",
        children: /* @__PURE__ */ jsx17(EditIcon, {})
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
  return /* @__PURE__ */ jsxs16("div", { className: "msg user seg-steer", children: [
    /* @__PURE__ */ jsxs16("div", { className: "msg-role", children: [
      /* @__PURE__ */ jsx17("span", { className: "msg-role-avatar", "aria-hidden": "true", children: /* @__PURE__ */ jsxs16(
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
            /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "8", r: "4" }),
            /* @__PURE__ */ jsx17("path", { d: "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" })
          ]
        }
      ) }),
      "You"
    ] }),
    /* @__PURE__ */ jsx17(UserMessageBubble, { message, onRetry, onEdit, editingDisabled })
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
        /* @__PURE__ */ jsx17(
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
        /* @__PURE__ */ jsx17(
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
      /* @__PURE__ */ jsx17("div", { className: "tool-trace", children: trace }, `trace-${traceAnchor}`)
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
          /* @__PURE__ */ jsx17(TraceNarration, { text: captions[0] }, `nar-${key}`)
        );
      }
      const { activity } = pending[0];
      trace.push(
        /* @__PURE__ */ jsx17(ToolSingleRow, { activity, messageId: message.id }, key)
      );
    } else {
      trace.push(
        /* @__PURE__ */ jsx17(
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
      /* @__PURE__ */ jsx17(
        MarkdownProse,
        {
          text: cachedPrepare(
            `${message.id}:seg:${key}`,
            text,
            useStore.getState().dir
          )
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
          /* @__PURE__ */ jsx17(SegSteerBubble, { message: steerMsg, onRetry, onEdit, editingDisabled }, i)
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
        nodes.push(/* @__PURE__ */ jsx17(SummaryBlock, { message: summaryMsg }, i));
      }
      return;
    }
    if (seg.kind === "artifact") {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(/* @__PURE__ */ jsx17(ArtifactCard, { segment: seg }, i));
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
        /* @__PURE__ */ jsx17(
          ExploreCard,
          {
            activity,
            messageId: message.id,
            index: seg.index
          },
          `exp-${seg.index}`
        )
      );
      return;
    }
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        /* @__PURE__ */ jsx17(
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
var ReadingMode2, preparedCache, PREPARED_CACHE_MAX, PREPARED_CACHE_MAX_CHARS, PREPARED_CACHE_SKIP_CHARS, preparedCacheChars, CodeBlock, mdComponents, PROSE_REMARK_PLUGINS, PROSE_REHYPE_PLUGINS, MarkdownProse, fmtTokens, ALWAYS_VISIBLE_TOOLS, USER_COLLAPSE_CHARS, USER_COLLAPSE_LINES, USER_PANEL_CHARS, USER_PANEL_LINES, SummaryBlock, CAPTION_MAX_CHARS, CAPTION_MAX_LINES, ChatMessageView;
var init_ChatMessage = __esm({
  "src/components/ChatMessage.tsx"() {
    "use strict";
    init_bidi();
    init_arrowDir();
    init_clipboard();
    init_fileTypes();
    init_FileIcon();
    init_renderCap();
    init_time();
    init_api();
    init_errorText();
    init_tts();
    init_store();
    init_modes();
    init_sections();
    init_link();
    init_ArtifactCard();
    init_highlight();
    init_ToolCallView();
    init_ExploreCard();
    init_MessageImages();
    init_css_stub();
    init_viewerTabs();
    init_planDoc();
    init_Mermaid();
    ReadingMode2 = lazy(
      () => Promise.resolve().then(() => (init_ReadingMode(), ReadingMode_exports)).then((m) => ({ default: m.ReadingMode }))
    );
    preparedCache = /* @__PURE__ */ new Map();
    PREPARED_CACHE_MAX = 400;
    PREPARED_CACHE_MAX_CHARS = 2e6;
    PREPARED_CACHE_SKIP_CHARS = 4e4;
    preparedCacheChars = 0;
    CodeBlock = memo2(function CodeBlock2(props) {
      const [copied, setCopied] = useState14(false);
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
        return /* @__PURE__ */ jsx17(Mermaid, { chart: code });
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
      const highlightedLines = useMemo6(
        () => getHighlightedLines(codeLines.join("\n"), lang),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [code, lang]
      );
      const lines = codeLines.map((_line, i) => {
        const num = startLine > 0 ? startLine + i : i + 1;
        const html = highlightedLines[i] ?? "";
        return /* @__PURE__ */ jsxs16("span", { className: "code-line", children: [
          /* @__PURE__ */ jsx17("span", { className: "code-gutter", "aria-hidden": "true", children: num }),
          /* @__PURE__ */ jsx17(
            "span",
            {
              className: "code-text",
              dangerouslySetInnerHTML: { __html: html === "" ? "\n" : html }
            }
          ),
          "\n"
        ] }, i);
      });
      return /* @__PURE__ */ jsxs16("div", { className: "code-block", children: [
        /* @__PURE__ */ jsxs16("div", { className: "code-block-head", children: [
          filePath && /* @__PURE__ */ jsxs16(
            "span",
            {
              className: "code-block-path code-block-path-open",
              title: `Open ${filePath}`,
              onClick: () => openWorkspaceFile(filePath),
              children: [
                /* @__PURE__ */ jsx17(FileIcon, { path: filePath, size: 20 }),
                filePath
              ]
            }
          ),
          /* @__PURE__ */ jsx17("span", { className: "code-block-lang", children: lang || "code" }),
          /* @__PURE__ */ jsx17("button", { className: "copy-btn", onClick: copy, children: copied ? "Copied \u2713" : "Copy" })
        ] }),
        /* @__PURE__ */ jsx17("pre", { ...props, dir: "ltr", className: "code-lines hljs", children: lines })
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
                return /* @__PURE__ */ jsx17(
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
              return /* @__PURE__ */ jsx17(Fragment8, { children: urlParts.map(
                (p, i) => typeof p === "string" ? /* @__PURE__ */ jsx17("code", { "data-meta": meta, children: p }, i) : /* @__PURE__ */ jsx17(
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
            return /* @__PURE__ */ jsx17(FileChip, { path, line, display: text });
          }
          const parts = extractInlinePathParts(text);
          if (parts.some((p) => typeof p !== "string")) {
            return /* @__PURE__ */ jsx17("code", { ...props, "data-meta": meta, children: parts.map(
              (p, i) => typeof p === "string" ? p : /* @__PURE__ */ jsx17(FileChip, { path: p.path, line: p.line, display: p.display }, i)
            ) });
          }
        }
        return /* @__PURE__ */ jsx17("code", { ...props, "data-meta": meta, children: props.children });
      },
      img: (props) => /* @__PURE__ */ jsx17(MarkdownImage, { ...props }),
      a: (props) => {
        const href = props.href ?? "";
        const video = extractVideoEmbed(href);
        if (video) {
          return /* @__PURE__ */ jsx17(
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
          return /* @__PURE__ */ jsx17(
            FileChip,
            {
              path: fileRef.path,
              line: fileRef.line,
              display: String(label)
            }
          );
        }
        if (!href) {
          return /* @__PURE__ */ jsx17(Fragment8, { children: props.children });
        }
        return /* @__PURE__ */ jsx17(
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
      pre: (props) => /* @__PURE__ */ jsx17(CodeBlock, { ...props }),
      table: ({
        node: _node,
        ...props
      }) => /* @__PURE__ */ jsx17("div", { className: "markdown-table-scroll", children: /* @__PURE__ */ jsx17("table", { ...props }) })
    };
    PROSE_REMARK_PLUGINS = [remarkGfm2];
    PROSE_REHYPE_PLUGINS = [rehypeArrows];
    MarkdownProse = memo2(function MarkdownProse2({ text }) {
      const ref = useRef10(null);
      useLayoutEffect3(() => {
        if (ref.current) fixArrowDirections(ref.current);
      }, [text]);
      return /* @__PURE__ */ jsx17("div", { ref, className: "chat-message markdown-body", dir: "auto", children: /* @__PURE__ */ jsx17(
        ReactMarkdown2,
        {
          remarkPlugins: PROSE_REMARK_PLUGINS,
          rehypePlugins: PROSE_REHYPE_PLUGINS,
          urlTransform: keepFileUrls,
          components: mdComponents,
          children: text
        }
      ) });
    });
    fmtTokens = (n) => {
      if (!n) return "0";
      return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
    };
    ALWAYS_VISIBLE_TOOLS = /* @__PURE__ */ new Set(["edit_file", "write_file"]);
    USER_COLLAPSE_CHARS = 600;
    USER_COLLAPSE_LINES = 10;
    USER_PANEL_CHARS = 4e3;
    USER_PANEL_LINES = 100;
    SummaryBlock = memo2(function SummaryBlock2({ message }) {
      const dir = useStore((s) => s.dir);
      const content = message.content || "";
      const open = () => useViewerTabs.getState().openText("Context summary", content);
      return /* @__PURE__ */ jsx17("div", { className: "summary-block collapsed", children: /* @__PURE__ */ jsxs16(
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
            /* @__PURE__ */ jsx17("span", { className: "summary-chevron", children: "\u25B6" }),
            /* @__PURE__ */ jsx17("span", { className: "summary-icon", children: "\u{1F4CE}" }),
            /* @__PURE__ */ jsx17("span", { className: "summary-label", children: "Context summary" }),
            content && /* @__PURE__ */ jsx17("span", { className: "summary-preview", dir: "auto", children: cachedPrepare(message.id, content, dir) }),
            /* @__PURE__ */ jsx17("span", { className: "summary-hint", children: "earlier turns folded into this summary \u2014 click to open it" })
          ]
        }
      ) });
    });
    CAPTION_MAX_CHARS = 260;
    CAPTION_MAX_LINES = 2;
    ChatMessageView = memo2(
      function ChatMessageView2({
        message,
        onRetry,
        onEdit,
        editingDisabled
      }) {
        const isUser = message.role === "user";
        const dir = useStore((s) => s.dir);
        const modeLabelStr = useStore(
          (s) => message.mode ? getMode(s.settings, message.mode).label : ""
        );
        const [copied, setCopied] = useState14(false);
        const { status: ttsStatus, toggle: ttsToggle, stop: ttsStop } = useTtsPlayback();
        const modeLabel = (_id) => modeLabelStr;
        const copyMessage = async () => {
          try {
            await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (err) {
            console.warn("copy failed", err);
          }
        };
        const toggleSpeak = async () => {
          try {
            const prevChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
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
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
            return;
          }
          const speakable = stripBidiMarks(fixZwsp(speakableMessageText(message)));
          if (!speakable.trim()) {
            const msg = "\u0645\u062A\u0646 \u0642\u0627\u0628\u0644 \u062E\u0648\u0627\u0646\u062F\u0646\u06CC \u0628\u0631\u0627\u06CC \u067E\u062E\u0634 \u0646\u06CC\u0633\u062A";
            const bannerChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
            return;
          }
          try {
            await ttsToggle(speakable, chain);
          } catch (err) {
            const friendly = friendlyTtsError(err);
            if (!friendly) return;
            console.warn("speak failed", err);
            const bannerChatId = useStore.getState().chats.find((c2) => c2.messages.some((m) => m.id === message.id))?.id;
            if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, friendly);
          }
        };
        useEffect12(() => {
          if (message.streaming) ttsStop();
        }, [message.streaming, ttsStop]);
        useEffect12(() => () => ttsStop(), [ttsStop]);
        const isSummary = message.role === "system" && !message.modeSwitch;
        const isModeSwitch = message.modeSwitch === true;
        const planDoc = !isUser && !isSummary ? message.planDoc : void 0;
        const display = planDisplay(message);
        const displayContent = display.content;
        const displaySegments = display.segments;
        const docPaths = useMemo6(() => {
          const docs = docPathsFromActivities(message.toolActivity);
          return dedupDocPaths(docs, message.attachments ?? []);
        }, [message.toolActivity, message.attachments]);
        const cap = useCapped(message.id, displayContent ?? "", !!message.streaming);
        const replyText = displayContent ?? message.content ?? "";
        const replyInPanel = !message.streaming && opensInPanel(replyText);
        const replyBody = replyInPanel ? replyText.slice(0, USER_COLLAPSE_CHARS) : cap.shown;
        const [reading, setReading] = useState14(false);
        const sections = useMemo6(
          () => !isUser && !isSummary ? splitSections(message.content) : [],
          [message.content, isUser, isSummary]
        );
        if (isModeSwitch) return null;
        if (message.compacted) return null;
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
        if (message.retry && !message.content && !(message.segments && message.segments.length > 0)) {
          return null;
        }
        const roleLabel = isUser ? "You" : isSummary ? "Context summary" : message.role === "tool" ? "Tools" : message.mode ? modeLabel(message.mode) : "Assistant";
        return /* @__PURE__ */ jsxs16(
          "div",
          {
            className: `msg ${isUser ? "user" : ""} ${message.error ? "error" : ""}`,
            "data-msg-id": message.id,
            "data-is-summary": isSummary ? "true" : void 0,
            children: [
              /* @__PURE__ */ jsxs16("div", { className: "msg-role", children: [
                isUser && /* @__PURE__ */ jsx17("span", { className: "msg-role-avatar", "aria-hidden": "true", children: /* @__PURE__ */ jsxs16(
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
                      /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "8", r: "4" }),
                      /* @__PURE__ */ jsx17("path", { d: "M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" })
                    ]
                  }
                ) }),
                roleLabel
              ] }),
              !isUser && message.plan && message.plan.length > 0 && /* @__PURE__ */ jsxs16("div", { className: "plan-block", dir, children: [
                /* @__PURE__ */ jsxs16("div", { className: "plan-head", children: [
                  /* @__PURE__ */ jsx17("span", { className: "plan-dot", children: "\u25CE" }),
                  /* @__PURE__ */ jsx17("span", { className: "plan-label", children: "Plan" })
                ] }),
                /* @__PURE__ */ jsx17("ul", { className: "plan-list", children: message.plan.map((item, i) => /* @__PURE__ */ jsxs16(
                  "li",
                  {
                    className: `plan-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : ""}`,
                    children: [
                      /* @__PURE__ */ jsx17("span", { className: "plan-item-mark", children: item.status === "completed" ? "\u2713" : item.status === "in_progress" ? "\u25CF" : "\u25CB" }),
                      /* @__PURE__ */ jsx17("span", { className: "plan-item-content", dir: "auto", children: cachedPrepare(`${message.id}:plan:${i}`, item.content, dir) })
                    ]
                  },
                  item.id ?? item.content
                )) })
              ] }),
              !isUser && message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx17("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs16(
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
                    /* @__PURE__ */ jsx17(FileIcon, { path: a, size: 20 }),
                    attachmentBasename(a)
                  ]
                },
                a
              )) }),
              (isSummary || displayContent || displaySegments && displaySegments.length > 0) && (isModeSwitch ? /* @__PURE__ */ jsx17("div", { className: "mode-switch-note", dir: "ltr", children: cachedPrepare(message.id, message.content, "ltr") }) : isSummary ? /* @__PURE__ */ jsx17(SummaryBlock, { message }) : displaySegments && displaySegments.length > 0 ? (
                /* Claude-style interleaved rendering: text slices and tool cards follow
                   each other in the exact order the agent produced them, with runs of
                   2+ read-only tool calls collapsed into one summary (see renderSegments). */
                /* @__PURE__ */ jsx17("div", { className: "msg-bubble segmented", children: renderSegments(
                  { ...message, segments: displaySegments },
                  onRetry,
                  onEdit,
                  editingDisabled
                ) })
              ) : isUser && message.steerPending ? /* @__PURE__ */ jsxs16("div", { className: "queued-bubble steer", dir, children: [
                /* @__PURE__ */ jsxs16("div", { className: "queued-bubble-head", children: [
                  /* @__PURE__ */ jsx17("span", { className: "queued-bubble-icon", children: /* @__PURE__ */ jsxs16(
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
                        /* @__PURE__ */ jsx17("path", { d: "M9 14L4 9l5-5" }),
                        /* @__PURE__ */ jsx17("path", { d: "M4 9h10a5 5 0 015 5v6" })
                      ]
                    }
                  ) }),
                  /* @__PURE__ */ jsx17("span", { className: "queued-bubble-label", children: "Steering the running agent\u2026" }),
                  /* @__PURE__ */ jsx17("span", { className: "queued-bubble-pulse" }),
                  /* @__PURE__ */ jsx17(
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
                /* @__PURE__ */ jsx17(
                  QueuedCollapsibleText,
                  {
                    id: message.id,
                    text: message.content,
                    onEdit,
                    editingDisabled
                  }
                ),
                message.attachments && message.attachments.length > 0 && /* @__PURE__ */ jsx17("div", { className: "msg-attachments", dir: "ltr", children: message.attachments.map((a) => /* @__PURE__ */ jsxs16(
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
                      /* @__PURE__ */ jsx17(FileIcon, { path: a, size: 20 }),
                      attachmentBasename(a)
                    ]
                  },
                  a
                )) }),
                message.images && message.images.length > 0 && /* @__PURE__ */ jsx17(MessageImages, { images: message.images })
              ] }) : isUser ? (
                /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
                   from the first strong char only, so a user message starting with
                   a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
                   72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
                   the rendered bubble identical to what the user typed. */
                /* @__PURE__ */ jsx17(UserMessageBubble, { message, onRetry, onEdit, editingDisabled })
              ) : /* @__PURE__ */ jsxs16(Fragment8, { children: [
                /* @__PURE__ */ jsx17("div", { className: "msg-bubble", children: /* @__PURE__ */ jsx17(MarkdownProse, { text: cachedPrepare(message.id, replyBody, dir) }) }),
                replyInPanel && /* @__PURE__ */ jsx17(
                  "button",
                  {
                    className: "msg-expand",
                    onClick: () => useViewerTabs.getState().openText(textTabTitle(replyText, "Reply"), replyText),
                    title: `Full reply is ${fmtSize(replyText.length)} \u2014 opens in the side panel`,
                    children: `Show all (${fmtSize(replyText.length)})`
                  }
                )
              ] })),
              !isUser && docPaths.length > 0 && /* @__PURE__ */ jsx17(DocFileChips, { paths: docPaths }),
              !isUser && planDoc && /* @__PURE__ */ jsx17(PlanDocCard, { planDoc }),
              !isUser && message.interrupted && /* @__PURE__ */ jsx17("div", { className: "msg-interrupted", dir: "auto", children: "\u26A0\uFE0F Interrupted \u2014 this reply was cut off (e.g. power loss). Send \u201Ccontinue\u201D to resume." }),
              !isUser && (message.content || message.usage || message.streaming || message.turnElapsedMs != null) && /* @__PURE__ */ jsxs16("div", { className: "msg-actions", children: [
                message.usage && /* @__PURE__ */ jsx17(
                  UsageBadge,
                  {
                    input: message.usage.inputTokens,
                    output: message.usage.outputTokens,
                    total: message.usage.totalTokens
                  }
                ),
                message.content && /* @__PURE__ */ jsxs16(Fragment8, { children: [
                  /* @__PURE__ */ jsx17(
                    "button",
                    {
                      className: `msg-copy ${copied ? "copied" : ""}`,
                      onClick: copyMessage,
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
                  /* @__PURE__ */ jsx17(
                    "button",
                    {
                      className: "msg-copy msg-fork",
                      onClick: () => useStore.getState().forkChatFromMessage(message.id),
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
                  !isUser && !message.streaming && /* @__PURE__ */ jsx17(
                    "button",
                    {
                      className: `msg-copy msg-speak ${ttsStatus === "speaking" ? "speaking" : ""} ${ttsStatus === "loading" ? "loading" : ""} ${ttsStatus === "paused" ? "paused" : ""}`,
                      onClick: toggleSpeak,
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
                      ) : ttsStatus === "paused" ? /* @__PURE__ */ jsx17(
                        "svg",
                        {
                          width: "16",
                          height: "16",
                          viewBox: "0 0 24 24",
                          fill: "currentColor",
                          children: /* @__PURE__ */ jsx17("path", { d: "M8 5v14l11-7z" })
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
                            /* @__PURE__ */ jsx17("polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }),
                            /* @__PURE__ */ jsx17("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" })
                          ]
                        }
                      )
                    }
                  ),
                  !isUser && !isSummary && !message.streaming && sections.length >= 2 && /* @__PURE__ */ jsx17(
                    "button",
                    {
                      className: "msg-copy",
                      onClick: () => setReading(true),
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
                message.streaming && (message.thinkingActive ? /* @__PURE__ */ jsx17(ThinkingIndicator, { startedAt: message.thinkingStartedAt }) : /* @__PURE__ */ jsx17(
                  ThinkingIndicator,
                  {
                    label: (() => {
                      const lsp = lspStatusLabel(message.lspStatus);
                      if (lsp) return lsp;
                      return message.statusText ? `Working \xB7 ${message.statusText}` : "Working";
                    })(),
                    startedAt: message.workingStartedAt
                  }
                )),
                !message.streaming && message.turnElapsedMs != null && /* @__PURE__ */ jsxs16(
                  "span",
                  {
                    className: "msg-elapsed msg-elapsed-far",
                    title: `Working time for this turn: ${fmtElapsed(message.turnElapsedMs)}`,
                    children: [
                      /* @__PURE__ */ jsx17("span", { dir: "ltr", children: fmtElapsed(message.turnElapsedMs) }),
                      /* @__PURE__ */ jsxs16(
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
                            /* @__PURE__ */ jsx17("line", { x1: "10", x2: "14", y1: "2", y2: "2" }),
                            /* @__PURE__ */ jsx17("line", { x1: "12", x2: "15", y1: "14", y2: "11" }),
                            /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "14", r: "8" })
                          ]
                        }
                      )
                    ]
                  }
                ),
                !message.streaming && /* @__PURE__ */ jsxs16(
                  "span",
                  {
                    className: `msg-time${message.turnElapsedMs == null ? " msg-time-far" : ""}`,
                    title: fmtClockFull(message.createdAt),
                    children: [
                      /* @__PURE__ */ jsx17("span", { dir: "ltr", children: fmtClock(message.createdAt) }),
                      /* @__PURE__ */ jsxs16(
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
                            /* @__PURE__ */ jsx17("circle", { cx: "12", cy: "12", r: "10" }),
                            /* @__PURE__ */ jsx17("polyline", { points: "12 6 12 12 16 14" })
                          ]
                        }
                      )
                    ]
                  }
                )
              ] }),
              reading && /* @__PURE__ */ jsx17(Suspense, { fallback: null, children: /* @__PURE__ */ jsx17(ReadingMode2, { message, onClose: () => setReading(false) }) })
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

// src/components/ScheduleInbox.tsx
var ScheduleInbox_exports = {};
__export(ScheduleInbox_exports, {
  ScheduleInbox: () => ScheduleInbox,
  ScheduleInboxButton: () => ScheduleInboxButton,
  ScheduleInboxDocked: () => ScheduleInboxDocked,
  pickInboxTask: () => pickInboxTask,
  scheduleRunTokens: () => scheduleRunTokens,
  unseenRunCount: () => unseenRunCount,
  unseenRunCountForTask: () => unseenRunCountForTask
});
import { useCallback as useCallback6, useEffect as useEffect13, useMemo as useMemo7, useRef as useRef11, useState as useState15 } from "react";
import ReactMarkdown3 from "react-markdown";
import remarkGfm3 from "remark-gfm";
import { Fragment as Fragment9, jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
function scheduleRunTokens(run) {
  let total = 0;
  for (const u of run.usage?.entries ?? []) {
    total += (u.input || 0) + (u.output || 0);
  }
  return total;
}
function unseenRunCount(runs, seen) {
  const seenSet = new Set(seen);
  return runs.filter((r) => !seenSet.has(r.id)).length;
}
function unseenRunCountForTask(runs, seen, scheduleId) {
  const seenSet = new Set(seen);
  return runs.filter((r) => r.schedule_id === scheduleId && !seenSet.has(r.id)).length;
}
function pickInboxTask(schedules, runs, selected) {
  if (schedules.length === 0) return null;
  if (selected) {
    const kept = schedules.find((t) => t.id === selected);
    if (kept) return kept;
  }
  for (const r of runs) {
    const owner = schedules.find((t) => t.id === r.schedule_id);
    if (owner) return owner;
  }
  return schedules[0] ?? null;
}
function InboxMarkdown({ text }) {
  const dir = useStore((s) => s.dir);
  const prepared = useMemo7(() => prepareContent(text, dir), [text, dir]);
  return /* @__PURE__ */ jsx18("div", { className: "chat-message markdown-body schedule-inbox-markdown", dir, children: /* @__PURE__ */ jsx18(ReactMarkdown3, { remarkPlugins: [remarkGfm3], components: mdComponents, children: prepared }) });
}
function InboxRunCard({ run }) {
  const tokens = scheduleRunTokens(run);
  return /* @__PURE__ */ jsxs17("div", { className: `schedule-inbox-run ${run.status}`, children: [
    /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-run-head", children: [
      /* @__PURE__ */ jsx18("span", { className: `schedule-inbox-status ${run.status}`, children: runStatusFa(run.status) }),
      /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-time", children: new Date(run.started_at * 1e3).toLocaleString("en-US") }),
      tokens > 0 && /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-tokens", title: `${tokens} tokens`, children: formatTokens(tokens) })
    ] }),
    run.error && /* @__PURE__ */ jsx18("div", { className: "schedule-run-error", children: run.error }),
    run.output ? /* @__PURE__ */ jsx18(InboxMarkdown, { text: run.output.slice(0, 8e3) }) : !run.error && /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "No output" })
  ] });
}
function ScheduleInbox() {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  const schedules = useStore((s) => s.schedules);
  const setSchedules = useStore((s) => s.setSchedules);
  const selected = useStore((s) => s.scheduleInboxSelected);
  const setSelected = useStore((s) => s.setScheduleInboxSelected);
  const seen = useStore((s) => s.scheduleRunsSeen);
  const markSeen = useStore((s) => s.markScheduleRunsSeen);
  const dir = useStore((s) => s.dir);
  const [runs, setRuns] = useState15([]);
  const [taskRuns, setTaskRuns] = useState15(null);
  const [loading, setLoading] = useState15(false);
  const [clearing, setClearing] = useState15(false);
  const [confirmClear, setConfirmClear] = useState15(false);
  const [clearError, setClearError] = useState15(null);
  const [orphanOpen, setOrphanOpen] = useState15(false);
  const [clearingOrphans, setClearingOrphans] = useState15(false);
  const [confirmClearOrphans, setConfirmClearOrphans] = useState15(false);
  const [orphanError, setOrphanError] = useState15(null);
  const [width, setWidth] = useState15(() => {
    if (typeof window === "undefined") return 720;
    const vw = typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
    let saved = NaN;
    try {
      saved = parseInt(localStorage.getItem("coder:scheduleInboxWidth") ?? "", 10);
    } catch {
      saved = NaN;
    }
    const fallback = Math.round(vw * 0.55);
    return Math.max(360, Math.min(vw - 24, Number.isFinite(saved) ? saved : fallback));
  });
  const dragCleanup = useRef11(null);
  useEffect13(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect13(() => {
    const onResize = () => {
      setWidth((w) => Math.max(360, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect13(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const w = Math.max(
        360,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX))
      );
      setWidth(w);
      try {
        localStorage.setItem("coder:scheduleInboxWidth", String(w));
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
  const selectedTask = useMemo7(
    () => pickInboxTask(schedules, runs, selected),
    [schedules, runs, selected]
  );
  const orphanRuns = useMemo7(
    () => runs.filter((r) => !schedules.some((t) => t.id === r.schedule_id)),
    [runs, schedules]
  );
  const orderedSchedules = useMemo7(() => {
    const latest = /* @__PURE__ */ new Map();
    for (const r of runs) {
      const t = typeof r.started_at === "number" ? r.started_at : 0;
      if (!latest.has(r.schedule_id) || (latest.get(r.schedule_id) ?? 0) < t) {
        latest.set(r.schedule_id, t);
      }
    }
    return [...schedules].sort(
      (a, b) => (latest.get(b.id) ?? -1) - (latest.get(a.id) ?? -1)
    );
  }, [schedules, runs]);
  const refresh = useCallback6(async () => {
    const out = await listSchedules();
    if (!("error" in out)) {
      const prev = useStore.getState().schedules;
      if (JSON.stringify(prev) !== JSON.stringify(out)) setSchedules(out);
    }
    const all = await listAllScheduleRuns(50);
    if (!("error" in all)) {
      setRuns((prev) => JSON.stringify(prev) === JSON.stringify(all) ? prev : all);
    }
  }, [setSchedules]);
  const selectedTaskId = selectedTask?.id ?? null;
  const refreshTaskRuns = useCallback6(async () => {
    if (!selectedTaskId) return;
    const one = await listScheduleRuns(selectedTaskId, 20);
    if (!("error" in one)) setTaskRuns(one);
  }, [selectedTaskId]);
  useEffect13(() => {
    if (open) void refresh();
  }, [open, refresh]);
  useEffect13(() => {
    if (!open) return;
    const t = setInterval(() => void refresh(), 15e3);
    return () => clearInterval(t);
  }, [open, refresh]);
  useEffect13(() => {
    if (!open || !selectedTask) {
      setTaskRuns(null);
      return;
    }
    setConfirmClear(false);
    setClearError(null);
    setTaskRuns(null);
    void (async () => {
      const out = await listScheduleRuns(selectedTask.id, 20);
      if (!("error" in out)) {
        setTaskRuns(out);
        markSeen(out.map((r) => r.id));
      }
    })();
  }, [open, selectedTask, markSeen]);
  useEffect13(() => {
    if (open && runs.length > 0) markSeen(runs.map((r) => r.id));
  }, [open, runs, markSeen]);
  const displayedRuns = useMemo7(() => {
    if (!selectedTask) return taskRuns;
    const fromAll = runs.filter((r) => r.schedule_id === selectedTask.id);
    if (!taskRuns) return fromAll.length > 0 ? fromAll : null;
    const merged = /* @__PURE__ */ new Map();
    for (const r of [...taskRuns, ...fromAll]) merged.set(r.id, r);
    return [...merged.values()].sort(
      (a, b) => (b.started_at || 0) - (a.started_at || 0)
    );
  }, [taskRuns, runs, selectedTask]);
  const newestUnseenTaskId = useMemo7(() => {
    const seenSet = new Set(seen);
    for (const r of runs) {
      if (!seenSet.has(r.id) && schedules.some((t) => t.id === r.schedule_id)) {
        return r.schedule_id;
      }
    }
    return null;
  }, [runs, seen, schedules]);
  if (!open) return null;
  const unseen = unseenRunCount(runs, seen);
  return /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-overlay", dir, children: [
    /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-backdrop", onClick: () => setOpen(false) }),
    /* @__PURE__ */ jsxs17(
      "div",
      {
        className: "schedule-inbox",
        role: "dialog",
        "aria-label": "Schedule inbox",
        style: { width: `${width}px` },
        children: [
          /* @__PURE__ */ jsx18(
            "div",
            {
              className: "schedule-inbox-resize-handle",
              title: "Drag to resize",
              onMouseDown: startResize
            }
          ),
          /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-head", dir: "ltr", children: [
            unseen > 0 && /* @__PURE__ */ jsxs17("span", { className: "schedule-inbox-badge", children: [
              unseen,
              " new"
            ] }),
            /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-head-spacer" }),
            /* @__PURE__ */ jsxs17("span", { className: "review-header-actions", children: [
              /* @__PURE__ */ jsx18(
                "button",
                {
                  className: "review-header-btn",
                  title: "Refresh",
                  "aria-label": "Refresh",
                  onClick: () => {
                    setLoading(true);
                    void Promise.all([refresh(), refreshTaskRuns()]).finally(() => setLoading(false));
                  },
                  children: /* @__PURE__ */ jsxs17("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx18("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
                    /* @__PURE__ */ jsx18("path", { d: "M3 3v5h5" })
                  ] })
                }
              ),
              /* @__PURE__ */ jsx18(
                "button",
                {
                  className: "review-header-btn schedule-inbox-close",
                  title: "Close inbox",
                  "aria-label": "Close inbox",
                  onClick: () => setOpen(false),
                  children: /* @__PURE__ */ jsxs17("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx18("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                    /* @__PURE__ */ jsx18("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
                  ] })
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-body", children: [
            /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-list", children: [
              orderedSchedules.length === 0 ? /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "No scheduled tasks yet" }) : orderedSchedules.map((t) => {
                const taskUnseen = unseenRunCountForTask(runs, seen, t.id);
                return /* @__PURE__ */ jsxs17(
                  "button",
                  {
                    className: `schedule-inbox-item${selectedTask?.id === t.id ? " active" : ""}`,
                    onClick: () => setSelected(t.id),
                    children: [
                      /* @__PURE__ */ jsx18("span", { className: "schedule-item-name", children: t.name }),
                      taskUnseen > 0 && /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-badge", children: taskUnseen }),
                      /* @__PURE__ */ jsx18("span", { className: "schedule-item-sub", children: formatNextRunFa(t.next_run) })
                    ]
                  },
                  t.id
                );
              }),
              orphanRuns.length > 0 && /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-orphan-toggle", children: /* @__PURE__ */ jsxs17(
                "button",
                {
                  className: "schedule-btn",
                  title: "Show runs from deleted tasks",
                  "aria-label": "Show runs from deleted tasks",
                  "aria-expanded": orphanOpen,
                  onClick: () => setOrphanOpen((v) => !v),
                  children: [
                    orphanOpen ? "Hide" : "Show",
                    " ",
                    orphanRuns.length,
                    " run",
                    orphanRuns.length > 1 ? "s" : "",
                    " from deleted task",
                    orphanRuns.length > 1 ? "s" : ""
                  ]
                }
              ) })
            ] }),
            /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-chat", children: !selectedTask ? orphanRuns.length > 0 ? /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-runs", children: [
              /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-chat-head", children: [
                /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-prompt-label", children: "Runs from deleted tasks" }),
                /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-head-spacer" }),
                !confirmClearOrphans ? /* @__PURE__ */ jsx18(
                  "button",
                  {
                    className: "schedule-btn danger",
                    title: "Delete runs from deleted tasks",
                    "aria-label": "Delete runs from deleted tasks",
                    disabled: clearingOrphans,
                    onClick: () => {
                      setOrphanError(null);
                      setConfirmClearOrphans(true);
                    },
                    children: "Clear"
                  }
                ) : /* @__PURE__ */ jsxs17("span", { className: "schedule-clear-confirm", children: [
                  /* @__PURE__ */ jsx18("span", { className: "schedule-clear-text", children: "Delete all?" }),
                  /* @__PURE__ */ jsx18(
                    "button",
                    {
                      className: "schedule-btn danger",
                      title: "Confirm delete",
                      "aria-label": "Confirm delete",
                      disabled: clearingOrphans,
                      onClick: () => {
                        setClearingOrphans(true);
                        setOrphanError(null);
                        void clearOrphanScheduleRuns().then((out) => {
                          if ("error" in out) {
                            setOrphanError(out.error);
                            return;
                          }
                          setRuns(
                            (prev) => prev.filter((r) => schedules.some((t) => t.id === r.schedule_id))
                          );
                          setConfirmClearOrphans(false);
                          setOrphanOpen(false);
                          void refresh();
                        }).catch((err) => {
                          setOrphanError(err instanceof Error ? err.message : String(err));
                        }).finally(() => setClearingOrphans(false));
                      },
                      children: clearingOrphans ? "Clearing\u2026" : "Yes"
                    }
                  ),
                  /* @__PURE__ */ jsx18(
                    "button",
                    {
                      className: "schedule-btn",
                      title: "Cancel",
                      "aria-label": "Cancel",
                      disabled: clearingOrphans,
                      onClick: () => {
                        setConfirmClearOrphans(false);
                        setOrphanError(null);
                      },
                      children: "No"
                    }
                  )
                ] })
              ] }),
              orphanError && /* @__PURE__ */ jsx18("div", { className: "schedule-error", children: orphanError }),
              orphanRuns.slice(0, 20).map((r) => /* @__PURE__ */ jsx18(InboxRunCard, { run: r }, r.id))
            ] }) : /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "Select a task to see its runs" }) : /* @__PURE__ */ jsxs17(Fragment9, { children: [
              /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-chat-head", children: [
                /* @__PURE__ */ jsx18("strong", { children: selectedTask.name }),
                /* @__PURE__ */ jsx18("span", { className: "schedule-item-cron", children: selectedTask.cron_label || selectedTask.cron || "Once" }),
                /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-head-spacer" }),
                !confirmClear ? /* @__PURE__ */ jsx18(
                  "button",
                  {
                    className: "schedule-btn danger",
                    title: "Clear this task's inbox",
                    "aria-label": "Clear this task's inbox",
                    disabled: clearing || !taskRuns || taskRuns.length === 0,
                    onClick: () => {
                      setClearError(null);
                      setConfirmClear(true);
                    },
                    children: "Clear"
                  }
                ) : /* @__PURE__ */ jsxs17("span", { className: "schedule-clear-confirm", children: [
                  /* @__PURE__ */ jsx18("span", { className: "schedule-clear-text", children: "Clear inbox?" }),
                  /* @__PURE__ */ jsx18(
                    "button",
                    {
                      className: "schedule-btn danger",
                      title: "Confirm clear",
                      "aria-label": "Confirm clear",
                      disabled: clearing,
                      onClick: () => {
                        if (!selectedTask) return;
                        setClearing(true);
                        setClearError(null);
                        void clearScheduleRuns(selectedTask.id).then((out) => {
                          if ("error" in out) {
                            setClearError(out.error);
                            return;
                          }
                          setTaskRuns([]);
                          setRuns(
                            (prev) => prev.filter((r) => r.schedule_id !== selectedTask.id)
                          );
                          setConfirmClear(false);
                          void refresh();
                        }).catch((err) => {
                          setClearError(err instanceof Error ? err.message : String(err));
                        }).finally(() => setClearing(false));
                      },
                      children: clearing ? "Clearing\u2026" : "Yes"
                    }
                  ),
                  /* @__PURE__ */ jsx18(
                    "button",
                    {
                      className: "schedule-btn",
                      title: "Cancel",
                      "aria-label": "Cancel",
                      disabled: clearing,
                      onClick: () => {
                        setConfirmClear(false);
                        setClearError(null);
                      },
                      children: "No"
                    }
                  )
                ] })
              ] }),
              clearError && /* @__PURE__ */ jsx18("div", { className: "schedule-error", children: clearError }),
              /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-prompt", children: [
                /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-prompt-label", children: "Task" }),
                /* @__PURE__ */ jsx18(InboxMarkdown, { text: selectedTask.prompt })
              ] }),
              loading && /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "Loading\u2026" }),
              !displayedRuns ? /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "Loading\u2026" }) : displayedRuns.length === 0 ? /* @__PURE__ */ jsxs17(Fragment9, { children: [
                /* @__PURE__ */ jsx18("div", { className: "schedule-runs-empty", children: "No runs yet" }),
                newestUnseenTaskId && newestUnseenTaskId !== selectedTask.id && /* @__PURE__ */ jsx18(
                  "button",
                  {
                    className: "schedule-btn",
                    onClick: () => setSelected(newestUnseenTaskId),
                    children: "Show latest run"
                  }
                ),
                orphanRuns.length > 0 && /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-orphan-section", children: [
                  /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-orphan-head", children: [
                    /* @__PURE__ */ jsxs17(
                      "button",
                      {
                        className: "schedule-btn",
                        title: "Show runs from deleted tasks",
                        "aria-label": "Show runs from deleted tasks",
                        "aria-expanded": orphanOpen,
                        onClick: () => setOrphanOpen((v) => !v),
                        children: [
                          orphanOpen ? "Hide" : "Show",
                          " ",
                          orphanRuns.length,
                          " run",
                          orphanRuns.length > 1 ? "s" : "",
                          " from deleted task",
                          orphanRuns.length > 1 ? "s" : ""
                        ]
                      }
                    ),
                    /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-head-spacer" }),
                    /* @__PURE__ */ jsx18(
                      "button",
                      {
                        className: "review-header-btn",
                        title: "Refresh deleted runs",
                        "aria-label": "Refresh deleted runs",
                        onClick: () => {
                          setLoading(true);
                          void refresh().finally(() => setLoading(false));
                        },
                        children: /* @__PURE__ */ jsxs17("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                          /* @__PURE__ */ jsx18("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
                          /* @__PURE__ */ jsx18("path", { d: "M3 3v5h5" })
                        ] })
                      }
                    ),
                    !confirmClearOrphans ? /* @__PURE__ */ jsx18(
                      "button",
                      {
                        className: "schedule-btn danger",
                        title: "Delete runs from deleted tasks",
                        "aria-label": "Delete runs from deleted tasks",
                        disabled: clearingOrphans,
                        onClick: () => {
                          setOrphanError(null);
                          setConfirmClearOrphans(true);
                        },
                        children: "Clear"
                      }
                    ) : /* @__PURE__ */ jsxs17("span", { className: "schedule-clear-confirm", children: [
                      /* @__PURE__ */ jsx18("span", { className: "schedule-clear-text", children: "Delete all?" }),
                      /* @__PURE__ */ jsx18(
                        "button",
                        {
                          className: "schedule-btn danger",
                          title: "Confirm delete",
                          "aria-label": "Confirm delete",
                          disabled: clearingOrphans,
                          onClick: () => {
                            setClearingOrphans(true);
                            setOrphanError(null);
                            void clearOrphanScheduleRuns().then((out) => {
                              if ("error" in out) {
                                setOrphanError(out.error);
                                return;
                              }
                              setRuns(
                                (prev) => prev.filter((r) => schedules.some((t) => t.id === r.schedule_id))
                              );
                              setConfirmClearOrphans(false);
                              setOrphanOpen(false);
                              void refresh();
                            }).catch((err) => {
                              setOrphanError(err instanceof Error ? err.message : String(err));
                            }).finally(() => setClearingOrphans(false));
                          },
                          children: clearingOrphans ? "Clearing\u2026" : "Yes"
                        }
                      ),
                      /* @__PURE__ */ jsx18(
                        "button",
                        {
                          className: "schedule-btn",
                          title: "Cancel",
                          "aria-label": "Cancel",
                          disabled: clearingOrphans,
                          onClick: () => {
                            setConfirmClearOrphans(false);
                            setOrphanError(null);
                          },
                          children: "No"
                        }
                      )
                    ] })
                  ] }),
                  orphanError && /* @__PURE__ */ jsx18("div", { className: "schedule-error", children: orphanError }),
                  orphanOpen && /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-runs", children: orphanRuns.slice(0, 20).map((r) => /* @__PURE__ */ jsx18(InboxRunCard, { run: r }, r.id)) })
                ] })
              ] }) : /* @__PURE__ */ jsxs17(Fragment9, { children: [
                /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-runs", children: displayedRuns.map((r) => /* @__PURE__ */ jsx18(InboxRunCard, { run: r }, r.id)) }),
                orphanRuns.length > 0 && /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-orphan-section", children: [
                  /* @__PURE__ */ jsxs17("div", { className: "schedule-inbox-orphan-head", children: [
                    /* @__PURE__ */ jsxs17(
                      "button",
                      {
                        className: "schedule-btn",
                        title: "Show runs from deleted tasks",
                        "aria-label": "Show runs from deleted tasks",
                        "aria-expanded": orphanOpen,
                        onClick: () => setOrphanOpen((v) => !v),
                        children: [
                          orphanOpen ? "Hide" : "Show",
                          " ",
                          orphanRuns.length,
                          " run",
                          orphanRuns.length > 1 ? "s" : "",
                          " from deleted task",
                          orphanRuns.length > 1 ? "s" : ""
                        ]
                      }
                    ),
                    /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-head-spacer" }),
                    !confirmClearOrphans ? /* @__PURE__ */ jsx18(
                      "button",
                      {
                        className: "schedule-btn danger",
                        title: "Delete runs from deleted tasks",
                        "aria-label": "Delete runs from deleted tasks",
                        disabled: clearingOrphans,
                        onClick: () => {
                          setOrphanError(null);
                          setConfirmClearOrphans(true);
                        },
                        children: "Clear"
                      }
                    ) : /* @__PURE__ */ jsxs17("span", { className: "schedule-clear-confirm", children: [
                      /* @__PURE__ */ jsx18("span", { className: "schedule-clear-text", children: "Delete all?" }),
                      /* @__PURE__ */ jsx18(
                        "button",
                        {
                          className: "schedule-btn danger",
                          title: "Confirm delete",
                          "aria-label": "Confirm delete",
                          disabled: clearingOrphans,
                          onClick: () => {
                            setClearingOrphans(true);
                            setOrphanError(null);
                            void clearOrphanScheduleRuns().then((out) => {
                              if ("error" in out) {
                                setOrphanError(out.error);
                                return;
                              }
                              setRuns(
                                (prev) => prev.filter((r) => schedules.some((t) => t.id === r.schedule_id))
                              );
                              setConfirmClearOrphans(false);
                              setOrphanOpen(false);
                              void refresh();
                            }).catch((err) => {
                              setOrphanError(err instanceof Error ? err.message : String(err));
                            }).finally(() => setClearingOrphans(false));
                          },
                          children: clearingOrphans ? "Clearing\u2026" : "Yes"
                        }
                      ),
                      /* @__PURE__ */ jsx18(
                        "button",
                        {
                          className: "schedule-btn",
                          title: "Cancel",
                          "aria-label": "Cancel",
                          disabled: clearingOrphans,
                          onClick: () => {
                            setConfirmClearOrphans(false);
                            setOrphanError(null);
                          },
                          children: "No"
                        }
                      )
                    ] })
                  ] }),
                  orphanError && /* @__PURE__ */ jsx18("div", { className: "schedule-error", children: orphanError }),
                  orphanOpen && /* @__PURE__ */ jsx18("div", { className: "schedule-inbox-runs", children: orphanRuns.slice(0, 20).map((r) => /* @__PURE__ */ jsx18(InboxRunCard, { run: r }, r.id)) })
                ] })
              ] })
            ] }) })
          ] })
        ]
      }
    )
  ] });
}
function ScheduleInboxButton() {
  const seen = useStore((s) => s.scheduleRunsSeen);
  const [runs, setRuns] = useState15([]);
  const prevStatusesRef = useRef11(null);
  useEffect13(() => {
    let cancelled = false;
    const tick = async () => {
      const out = await listAllScheduleRuns(50);
      if (cancelled || "error" in out) return;
      setRuns(out);
      const prev = prevStatusesRef.current;
      if (prev !== null) {
        const finished = findFinishedScheduleRuns(prev, out);
        for (const r of finished) {
          playAlarm(r.status === "error" ? "error" : "alert");
        }
        if (finished.length > 0) {
          const openInbox = () => {
            void Promise.resolve().then(() => (init_viewerTabs(), viewerTabs_exports)).then(({ useViewerTabs: useViewerTabs3 }) => {
              useViewerTabs3.getState().openInbox();
            });
            useStore.getState().setScheduleInboxOpen(true);
          };
          if (await ensureScheduleNotificationPermission()) {
            if (finished.length === 1) {
              const r = finished[0];
              const name = useStore.getState().schedules.find((t2) => t2.id === r.schedule_id)?.name;
              notifyScheduleRun(r, name, openInbox);
            } else {
              notifyScheduleRunBatch(finished.length, openInbox);
            }
          }
        }
      }
      prevStatusesRef.current = new Map(out.map((r) => [r.id, r.status]));
    };
    void tick();
    const t = setInterval(() => void tick(), 3e4);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  const unseen = unseenRunCount(runs, seen);
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const panelMode = useViewerTabs((s) => s.panelMode);
  const activeChatId = useStore((s) => s.activeChatId);
  const shown = shownViewerTabId(tabs, activeId, panelMode, activeChatId) === "inbox";
  return /* @__PURE__ */ jsxs17(
    "button",
    {
      className: "titlebar-icon-btn schedule-inbox-btn",
      title: unseen > 0 ? `${unseen} new schedule runs` : "Schedule inbox",
      "aria-label": "Schedule inbox",
      "aria-pressed": shown,
      onClick: () => {
        const vt = useViewerTabs.getState();
        if (shown) {
          vt.closeViewer("inbox");
          useStore.getState().setScheduleInboxOpen(false);
        } else {
          vt.openInbox();
          useStore.getState().setScheduleInboxOpen(true);
        }
      },
      children: [
        /* @__PURE__ */ jsxs17(
          "svg",
          {
            width: "17",
            height: "17",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "1.8",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            children: [
              /* @__PURE__ */ jsx18("polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }),
              /* @__PURE__ */ jsx18("path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" })
            ]
          }
        ),
        unseen > 0 && /* @__PURE__ */ jsx18("span", { className: "schedule-inbox-badge", children: unseen })
      ]
    }
  );
}
function ScheduleInboxDocked({ onClose }) {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  const prevOpenRef = useRef11(null);
  useEffect13(() => {
    setOpen(true);
  }, [setOpen]);
  useEffect13(() => {
    if (prevOpenRef.current === null) {
      prevOpenRef.current = open;
      return;
    }
    if (prevOpenRef.current && !open) onClose();
    prevOpenRef.current = open;
  }, [open, onClose]);
  return /* @__PURE__ */ jsx18("div", { className: "viewer-inbox-wrap", children: /* @__PURE__ */ jsx18(ScheduleInbox, {}) });
}
var init_ScheduleInbox = __esm({
  "src/components/ScheduleInbox.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_schedule_notify();
    init_alarm();
    init_bidi();
    init_context();
    init_ChatMessage();
    init_viewerTabs();
    init_SchedulePanel();
  }
});

// src/components/PlanPanel.tsx
var PlanPanel_exports = {};
__export(PlanPanel_exports, {
  PlanPanel: () => PlanPanel
});
import { useMemo as useMemo8, useEffect as useEffect14, useState as useState16 } from "react";
import ReactMarkdown4 from "react-markdown";
import remarkGfm4 from "remark-gfm";
import { jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
function PlanPanel({ chatId } = {}) {
  const storeActiveChatId = useStore((s) => s.activeChatId);
  const activeChatId = chatId ?? storeActiveChatId;
  const chat = useStore((s) => s.chats.find((c2) => c2.id === activeChatId) ?? null);
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState16(false);
  const planDoc = useMemo8(
    () => latestPlanDoc(chat ? [chat] : [], activeChatId),
    [chat, activeChatId]
  );
  const [diskPlan, setDiskPlan] = useState16(null);
  useEffect14(() => {
    let alive = true;
    setDiskPlan(null);
    if (planDoc || !chat?.root) return;
    fetchPlan(chat.root, chat.id).then((p) => {
      if (alive && p?.content) setDiskPlan({ title: p.title || "", body: p.content });
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [planDoc, chat?.root, chat?.id]);
  const shown = planDoc ?? diskPlan;
  return /* @__PURE__ */ jsxs18(
    "aside",
    {
      className: "review-panel review-docked-panel plan-panel",
      dir: "ltr",
      "aria-label": "Implementation plan",
      children: [
        shown && /* @__PURE__ */ jsx19(
          "button",
          {
            type: "button",
            className: `review-header-btn plan-panel-float-copy${copied ? " copied" : ""}`,
            title: "Copy plan",
            "aria-label": "Copy plan",
            onClick: () => {
              void copyToClipboard(shown.body);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            },
            children: copied ? /* @__PURE__ */ jsx19("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx19("path", { d: "M20 6L9 17l-5-5" }) }) : /* @__PURE__ */ jsxs18("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx19("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
              /* @__PURE__ */ jsx19("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
            ] })
          }
        ),
        shown ? (
          // The markdown body carries its own headings (## Plan …) — no extra
          // title node, or every plan would render its heading twice. Bidi +
          // block direction follow the app setting (dir="auto" would resolve
          // LTR for every plan: the document always opens with "## Plan").
          /* @__PURE__ */ jsx19("div", { className: "plan-panel-body", dir: "ltr", children: /* @__PURE__ */ jsx19("div", { className: "plan-panel-content", dir, children: /* @__PURE__ */ jsx19("div", { className: "chat-message markdown-body", children: /* @__PURE__ */ jsx19(ReactMarkdown4, { remarkPlugins: [remarkGfm4], components: mdComponents, children: prepareContent(shown.body, dir) }) }) }) })
        ) : /* @__PURE__ */ jsx19("div", { className: "plan-panel-empty", children: "No plan yet \u2014 switch to Plan mode and describe what you want built." })
      ]
    }
  );
}
var init_PlanPanel = __esm({
  "src/components/PlanPanel.tsx"() {
    "use strict";
    init_store();
    init_clipboard();
    init_planDoc();
    init_api();
    init_bidi();
    init_ChatMessage();
  }
});

// src/lib/browserViewport.ts
function widthRulerTicks(min = WIDTH_SLIDER_MIN, max = WIDTH_SLIDER_MAX) {
  return WIDTH_RULER_TICKS.filter((w) => w >= min && w <= max);
}
function rulerPctForWidth(width, min = WIDTH_SLIDER_MIN, max = WIDTH_SLIDER_MAX) {
  if (!(max > min)) return 0;
  const pct = (width - min) / (max - min) * 100;
  return Math.min(100, Math.max(0, pct));
}
function rulerWidthForPct(pct, min = WIDTH_SLIDER_MIN, max = WIDTH_SLIDER_MAX, step = WIDTH_RULER_STEP) {
  const clamped = Math.min(100, Math.max(0, pct));
  const raw = min + clamped / 100 * (max - min);
  return clampViewportSize(Math.round(raw / step) * step, 800).width;
}
function rulerLabelForWidth(width) {
  if (width <= 360) return "Mobile S";
  if (width <= 400) return "Mobile M";
  if (width <= 480) return "Mobile L";
  if (width <= 800) return "Tablet";
  if (width <= 1100) return "Laptop";
  if (width <= 1500) return "Laptop L";
  return "Desktop";
}
function fitWidthTarget(paneW, capW, minW = VIEWPORT_LIMITS.minWidth) {
  if (!Number.isFinite(paneW) || paneW <= 0) return capW;
  return Math.max(minW, Math.min(capW, Math.round(paneW)));
}
function capAfterPoll(own, w, h, capW) {
  if (own && own.w === w && own.h === h) return capW;
  return w;
}
function frameZoom(paneW, paneH, vw, vh) {
  if (!Number.isFinite(paneW) || !Number.isFinite(paneH) || paneW <= 0 || paneH <= 0) return 1;
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return 1;
  return Math.min(1, paneW / vw, paneH / vh);
}
function shouldSyncViewportDrafts(prevW, prevH, nextW, nextH, editing) {
  if (editing) return false;
  return prevW !== nextW || prevH !== nextH;
}
function toFinite(n, fallback) {
  return Number.isFinite(n) ? n : fallback;
}
function clampViewportSize(width, height) {
  const w = toFinite(Math.round(width), DEFAULT_VIEWPORT_SIZE.width);
  const h = toFinite(Math.round(height), DEFAULT_VIEWPORT_SIZE.height);
  return {
    width: Math.max(VIEWPORT_LIMITS.minWidth, Math.min(VIEWPORT_LIMITS.maxWidth, w)),
    height: Math.max(VIEWPORT_LIMITS.minHeight, Math.min(VIEWPORT_LIMITS.maxHeight, h))
  };
}
var VIEWPORT_LIMITS, DEFAULT_VIEWPORT_SIZE, WIDTH_SLIDER_MIN, WIDTH_SLIDER_MAX, WIDTH_RULER_STEP, WIDTH_RULER_TICKS;
var init_browserViewport = __esm({
  "src/lib/browserViewport.ts"() {
    "use strict";
    VIEWPORT_LIMITS = {
      minWidth: 200,
      maxWidth: 7680,
      minHeight: 200,
      maxHeight: 4320
    };
    DEFAULT_VIEWPORT_SIZE = { width: 1280, height: 800 };
    WIDTH_SLIDER_MIN = 320;
    WIDTH_SLIDER_MAX = 1920;
    WIDTH_RULER_STEP = 10;
    WIDTH_RULER_TICKS = [320, 375, 425, 768, 1024, 1440, 1920];
  }
});

// src/components/BrowserPanel.tsx
var BrowserPanel_exports = {};
__export(BrowserPanel_exports, {
  BrowserPanel: () => BrowserPanel,
  backendError: () => backendError,
  isProbablyUrl: () => isProbablyUrl,
  pctInBox: () => pctInBox
});
import { useEffect as useEffect15, useRef as useRef12, useState as useState17 } from "react";
import { jsx as jsx20, jsxs as jsxs19 } from "react/jsx-runtime";
function pctInBox(box, clientX, clientY) {
  return {
    x: box.width ? (clientX - box.left) / box.width * 100 : 0,
    y: box.height ? (clientY - box.top) / box.height * 100 : 0
  };
}
function backendError(body) {
  if (typeof body !== "object" || body === null) return null;
  const b = body;
  return b.ok === false ? String(b.error || "request failed") : null;
}
function BrowserPanel({
  chatId = "",
  initialUrl = ""
}) {
  const [image, setImage] = useState17("");
  const [pageUrl, setPageUrl] = useState17("");
  const [address, setAddress] = useState17("");
  const initialUrlRef = useRef12(initialUrl);
  const [active, setActive] = useState17(false);
  const [loading, setLoading] = useState17(true);
  const [busy, setBusy] = useState17(false);
  const [error, setError] = useState17("");
  const [available, setAvailable] = useState17(true);
  const [installing, setInstalling] = useState17(false);
  const [installPct, setInstallPct] = useState17(0);
  const [installPhase, setInstallPhase] = useState17("");
  const [viewport, setViewport] = useState17({ w: DEFAULT_VIEWPORT_SIZE.width, h: DEFAULT_VIEWPORT_SIZE.height });
  const timer = useRef12(null);
  const [cursor, setCursor] = useState17(null);
  const lastMoveAt = useRef12(0);
  const lastHoverShotAt = useRef12(0);
  const installTimer = useRef12(null);
  const keyShotTimer = useRef12(null);
  const [draftW, setDraftW] = useState17(String(DEFAULT_VIEWPORT_SIZE.width));
  const [draftH, setDraftH] = useState17(String(DEFAULT_VIEWPORT_SIZE.height));
  const [fitToPane, setFitToPane] = useState17(true);
  const [pane, setPane] = useState17({ w: 0, h: 0 });
  const [menuOpen, setMenuOpen] = useState17(false);
  const capWRef = useRef12(DEFAULT_VIEWPORT_SIZE.width);
  const appliedRef = useRef12(null);
  const stageRef = useRef12(null);
  const fitTimer = useRef12(null);
  const sizeRef = useRef12(viewport);
  const addressRef = useRef12(address);
  addressRef.current = address;
  const imageRef = useRef12(image);
  imageRef.current = image;
  const [rulerHover, setRulerHover] = useState17(null);
  const rulerDragRef = useRef12(false);
  const rulerPendingRef = useRef12(null);
  const rulerTimerRef = useRef12(null);
  function syncDrafts(w, h) {
    setDraftW(String(w));
    setDraftH(String(h));
  }
  function isEditingDims() {
    if (typeof document === "undefined") return false;
    const el = document.activeElement;
    return el instanceof HTMLInputElement && el.classList.contains("browser-dims-input");
  }
  async function sidecarFetch(path, init, strict = true) {
    const base = await ensureSidecar();
    if (!base) throw new Error("the app's local backend is not ready yet");
    let url = `${base}${path}`;
    let bodyInit = init;
    if (path.startsWith("/browser/")) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (chatId) url += (path.includes("?") ? "&" : "?") + `chat_id=${encodeURIComponent(chatId)}`;
      } else {
        try {
          const raw = typeof init?.body === "string" ? init.body : "{}";
          const parsed = raw ? JSON.parse(raw) : {};
          if (typeof parsed === "object" && parsed !== null && chatId && !parsed.chat_id) {
            parsed.chat_id = chatId;
            bodyInit = { ...init, body: JSON.stringify(parsed) };
          }
        } catch {
        }
      }
    }
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...bodyInit
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(body.detail || `request failed (${res.status})`));
    const bizErr = strict ? backendError(body) : null;
    if (bizErr) throw new Error(bizErr);
    return body;
  }
  async function refreshStatus() {
    try {
      const st = await sidecarFetch("/browser/status");
      const isActive = st.active === true;
      setActive(isActive);
      if (typeof st.available === "boolean") setAvailable(st.available);
      if (typeof st.url === "string") {
        const clean = st.url === "about:blank" ? "" : st.url;
        setPageUrl(clean);
        if (!addressRef.current && clean) setAddress(clean);
        if (!clean && addressRef.current === "about:blank") setAddress("");
      }
      if (st.viewport && typeof st.viewport.width === "number") {
        const w = st.viewport.width;
        const h = st.viewport.height;
        const prev = sizeRef.current;
        if (w !== prev.w || h !== prev.h) {
          capWRef.current = capAfterPoll(appliedRef.current, w, h, capWRef.current);
          setViewport({ w, h });
          if (shouldSyncViewportDrafts(prev.w, prev.h, w, h, isEditingDims())) syncDrafts(w, h);
        }
      }
      return isActive;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
  async function refreshShot() {
    try {
      const shot = await sidecarFetch("/browser/screenshot", void 0, false);
      if (typeof shot.image === "string" && shot.image) {
        if (shot.image !== imageRef.current) setImage(shot.image);
        if (typeof shot.width === "number") {
          const prev = sizeRef.current;
          if (shot.width !== prev.w || shot.height !== prev.h) {
            setViewport({ w: shot.width, h: shot.height });
            if (shouldSyncViewportDrafts(prev.w, prev.h, shot.width, shot.height, isEditingDims())) {
              syncDrafts(shot.width, shot.height);
            }
          }
        }
        setError("");
      }
    } catch (err) {
      if (!imageRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect15(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const isActive = await refreshStatus();
      if (cancelled) return;
      if (isActive) {
        if (initialUrl.trim()) {
          await sidecarFetch("/browser/navigate", {
            method: "POST",
            body: JSON.stringify({ url: initialUrl.trim() })
          }).catch(() => {
          });
        }
        if (!cancelled) await refreshShot();
      }
      if (!cancelled) setLoading(false);
    })();
    timer.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshStatus().then((isActive) => {
        if (isActive) void refreshShot();
      });
    }, 1200);
    const onVisible = () => {
      if (document.hidden) return;
      void refreshStatus().then((isActive) => {
        if (isActive) void refreshShot();
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      if (keyShotTimer.current) window.clearTimeout(keyShotTimer.current);
      keyShotTimer.current = null;
      if (installTimer.current) window.clearInterval(installTimer.current);
      installTimer.current = null;
      if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
      rulerTimerRef.current = null;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
      cancelled = true;
    };
  }, []);
  useEffect15(() => {
    if (initialUrlRef.current === initialUrl) return;
    initialUrlRef.current = initialUrl;
    const target = initialUrl.trim();
    if (!target || target === "about:blank") return;
    void sidecarFetch("/browser/navigate", {
      method: "POST",
      body: JSON.stringify({ url: target })
    }).catch(() => {
    });
  }, [initialUrl]);
  async function go2() {
    const raw = address.trim();
    if (!raw) return;
    setError("");
    setBusy(true);
    try {
      if (isProbablyUrl(raw)) {
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
        await sidecarFetch(active ? "/browser/navigate" : "/browser/launch", {
          method: "POST",
          body: JSON.stringify({ url })
        });
      } else {
        if (!active) {
          await sidecarFetch("/browser/launch", {
            method: "POST",
            body: JSON.stringify({ url: "about:blank" })
          });
        }
        const res = await sidecarFetch("/browser/search", {
          method: "POST",
          body: JSON.stringify({ query: raw })
        });
        if (typeof res.url === "string" && res.url) setAddress(res.url);
      }
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("browser is not running")) setActive(false);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }
  async function historyAction(action) {
    if (!active) return;
    setError("");
    setBusy(true);
    try {
      await sidecarFetch("/browser/history", {
        method: "POST",
        body: JSON.stringify({ action })
      });
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("browser is not running")) setActive(false);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }
  function hostPct(img, clientX, clientY) {
    const host = img.parentElement;
    const hr = host ? host.getBoundingClientRect() : null;
    const r = hr && hr.width > 0 ? hr : img.getBoundingClientRect();
    return pctInBox(r, clientX, clientY);
  }
  async function clickAt(e) {
    if (!active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round((e.clientX - rect.left) / rect.width * viewport.w);
    const y = Math.round((e.clientY - rect.top) / rect.height * viewport.h);
    setCursor(hostPct(e.currentTarget, e.clientX, e.clientY));
    try {
      await sidecarFetch("/browser/click", {
        method: "POST",
        body: JSON.stringify({ x, y })
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function pressKey(key) {
    if (!active) return;
    try {
      await sidecarFetch("/browser/key", {
        method: "POST",
        body: JSON.stringify({ key })
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  function scheduleKeyShot() {
    if (keyShotTimer.current) return;
    keyShotTimer.current = window.setTimeout(() => {
      keyShotTimer.current = null;
      void refreshShot();
    }, 300);
  }
  function stageKeyDown(e) {
    if (!active) return;
    const k = e.key;
    const named = [
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ];
    const plain = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain) {
      e.preventDefault();
      void sidecarFetch("/browser/type", {
        method: "POST",
        body: JSON.stringify({ text: k })
      }).then(scheduleKeyShot).catch(() => {
      });
    } else if (named.includes(k)) {
      e.preventDefault();
      void pressKey(k);
    }
  }
  async function wheel(e) {
    if (!active) return;
    try {
      await sidecarFetch("/browser/scroll", {
        method: "POST",
        body: JSON.stringify({ dx: 0, dy: Math.round(e.deltaY) })
      });
      window.setTimeout(() => void refreshShot(), 350);
    } catch {
    }
  }
  useEffect15(() => {
    sizeRef.current = viewport;
  }, [viewport]);
  async function applySize(rawW, rawH, updateCap = true) {
    if (!active) return;
    const { width, height } = clampViewportSize(rawW, rawH);
    setError("");
    try {
      await sidecarFetch("/browser/viewport", {
        method: "POST",
        body: JSON.stringify({ width, height })
      });
      if (updateCap) {
        capWRef.current = width;
        if (fitTimer.current) window.clearTimeout(fitTimer.current);
        fitTimer.current = null;
      }
      appliedRef.current = { w: width, h: height };
      sizeRef.current = { w: width, h: height };
      setViewport({ w: width, h: height });
      syncDrafts(width, height);
      await refreshStatus();
      await refreshShot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect15(() => {
    const host = stageRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const measure2 = (w, h) => {
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
      setPane((prev) => prev.w === w && prev.h === h ? prev : { w, h });
    };
    const readPane = () => ({
      w: Math.round(host.clientWidth),
      h: Math.round(host.clientHeight)
    });
    const onResize = () => {
      const { w, h } = readPane();
      measure2(w, h);
      if (!fitToPane || !active) return;
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => {
        fitTimer.current = null;
        const cur = sizeRef.current;
        const target = fitWidthTarget(w, capWRef.current);
        if (target !== cur.w) void applySize(target, cur.h, false);
      }, 400);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    window.addEventListener("resize", onResize);
    onResize();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
      fitTimer.current = null;
    };
  }, [fitToPane, active]);
  useEffect15(() => {
    const up = () => {
      if (!rulerDragRef.current) return;
      rulerDragRef.current = false;
      const pending = rulerPendingRef.current;
      rulerPendingRef.current = null;
      if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
      rulerTimerRef.current = null;
      if (pending !== null) void applySize(pending, sizeRef.current.h);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [active]);
  function hoverAt(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const p = pctInBox(rect, e.clientX, e.clientY);
    setCursor(hostPct(e.currentTarget, e.clientX, e.clientY));
    if (!active) return;
    const now = Date.now();
    if (now - lastMoveAt.current < 120) return;
    lastMoveAt.current = now;
    void sidecarFetch("/browser/move", {
      method: "POST",
      body: JSON.stringify({
        x: Math.round(p.x / 100 * viewport.w),
        y: Math.round(p.y / 100 * viewport.h)
      })
    }).catch(() => {
    });
    if (now - lastHoverShotAt.current > 500) {
      lastHoverShotAt.current = now;
      window.setTimeout(() => void refreshShot(), 250);
    }
  }
  async function closeSession() {
    try {
      await sidecarFetch("/browser/close", { method: "POST" });
      setActive(false);
      setImage("");
      setError("");
      setMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function startInstall() {
    setError("");
    setInstalling(true);
    setInstallPct(0);
    setInstallPhase("downloading");
    try {
      await sidecarFetch("/browser/install", { method: "POST" });
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (installTimer.current) window.clearInterval(installTimer.current);
    installTimer.current = window.setInterval(async () => {
      try {
        const st = await sidecarFetch("/browser/install/status");
        if (typeof st.percent === "number") setInstallPct(st.percent);
        if (typeof st.phase === "string") setInstallPhase(st.phase);
        if (st.available === true) setAvailable(true);
        if (st.installing) return;
        if (installTimer.current) window.clearInterval(installTimer.current);
        installTimer.current = null;
        setInstalling(false);
        if (st.phase === "failed" && st.error) {
          setError(String(st.error));
        } else {
          await refreshStatus();
        }
      } catch (err) {
        if (installTimer.current) window.clearInterval(installTimer.current);
        installTimer.current = null;
        setInstalling(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 700);
  }
  useEffect15(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      const t = e.target;
      if (t?.closest?.(".browser-menu-wrap")) return;
      setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  async function openInDefaultBrowser() {
    setMenuOpen(false);
    const url = pageUrl || address.trim();
    if (!url) return;
    setError("");
    try {
      const opener = window.coder?.openExternal;
      if (typeof opener === "function") await opener.call(window.coder, url);
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function openDevTools() {
    setMenuOpen(false);
    if (!active) return;
    setError("");
    try {
      const res = await sidecarFetch("/browser/devtools-url");
      const url = typeof res.url === "string" ? res.url : "";
      if (!url) throw new Error(String(res.error || "DevTools URL unavailable"));
      const bridge = window.coder;
      if (typeof bridge?.openExternalChrome === "function") await bridge.openExternalChrome(url);
      else if (typeof bridge?.openExternal === "function") await bridge.openExternal(url);
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  const zoom = frameZoom(pane.w, pane.h, viewport.w, viewport.h);
  const frameW = Math.max(1, Math.round(viewport.w * zoom));
  const frameH = Math.max(1, Math.round(viewport.h * zoom));
  return /* @__PURE__ */ jsxs19("div", { className: "browser-panel", children: [
    /* @__PURE__ */ jsxs19("div", { className: "browser-toolbar", children: [
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "browser-tool-btn",
          title: "Back",
          "aria-label": "Back",
          disabled: !active,
          onClick: () => void historyAction("back"),
          children: /* @__PURE__ */ jsx20(BackIcon, {})
        }
      ),
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "browser-tool-btn",
          title: "Forward",
          "aria-label": "Forward",
          disabled: !active,
          onClick: () => void historyAction("forward"),
          children: /* @__PURE__ */ jsx20(ForwardIcon, {})
        }
      ),
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "browser-tool-btn" + (busy ? " browser-tool-btn--spin" : ""),
          title: "Reload",
          "aria-label": "Reload",
          disabled: !active,
          onClick: () => void historyAction("reload"),
          children: /* @__PURE__ */ jsx20(ReloadIcon, {})
        }
      ),
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "browser-tool-btn" + (fitToPane ? " browser-tool-btn--on" : ""),
          title: fitToPane ? "Following the panel width \u2014 click to keep a fixed size" : "Fixed size \u2014 click to fit the panel width",
          "aria-label": "Fit to panel",
          "aria-pressed": fitToPane,
          disabled: !active,
          onClick: () => setFitToPane((v) => !v),
          children: /* @__PURE__ */ jsx20(FitIcon, {})
        }
      ),
      /* @__PURE__ */ jsxs19("div", { className: "browser-omnibox-wrap", children: [
        /* @__PURE__ */ jsx20("span", { className: "browser-omnibox-icon", "aria-hidden": "true", children: !address.trim() ? /* @__PURE__ */ jsx20(GlobeIcon, {}) : isProbablyUrl(address) ? /* @__PURE__ */ jsx20(LockIcon, {}) : /* @__PURE__ */ jsx20(SearchIcon, {}) }),
        /* @__PURE__ */ jsx20(
          "input",
          {
            className: "browser-omnibox",
            value: address,
            onChange: (e) => setAddress(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void go2();
            },
            placeholder: "Search or type a URL",
            spellCheck: false,
            "aria-label": "Address",
            onFocus: (e) => e.currentTarget.select()
          }
        )
      ] }),
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "browser-tool-btn",
          title: "Stop the virtual browser",
          "aria-label": "Stop browser",
          disabled: !active,
          onClick: () => void closeSession(),
          children: /* @__PURE__ */ jsx20(StopIcon, {})
        }
      ),
      /* @__PURE__ */ jsxs19("div", { className: "browser-menu-wrap", children: [
        /* @__PURE__ */ jsx20(
          "button",
          {
            type: "button",
            className: "browser-tool-btn",
            title: "More actions",
            "aria-label": "More actions",
            "aria-haspopup": "menu",
            "aria-expanded": menuOpen,
            onClick: () => setMenuOpen((v) => !v),
            children: /* @__PURE__ */ jsx20(KebabIcon, {})
          }
        ),
        /* @__PURE__ */ jsxs19("div", { className: "browser-menu", role: "menu", hidden: !menuOpen, children: [
          /* @__PURE__ */ jsxs19(
            "button",
            {
              type: "button",
              className: "browser-menu-item",
              role: "menuitem",
              "aria-label": "Open in default browser",
              disabled: !active,
              onClick: () => void openInDefaultBrowser(),
              children: [
                /* @__PURE__ */ jsx20("span", { className: "browser-menu-item-icon", "aria-hidden": "true", children: "\u2197" }),
                "Open in default browser"
              ]
            }
          ),
          /* @__PURE__ */ jsxs19(
            "button",
            {
              type: "button",
              className: "browser-menu-item",
              role: "menuitem",
              "aria-label": "Open DevTools",
              disabled: !active,
              onClick: () => void openDevTools(),
              children: [
                /* @__PURE__ */ jsx20("span", { className: "browser-menu-item-icon", "aria-hidden": "true", children: "\u{1F41E}" }),
                "Open DevTools"
              ]
            }
          )
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsx20(
      "div",
      {
        className: "browser-progress" + (busy ? " browser-progress--on" : ""),
        "aria-hidden": "true"
      }
    ),
    /* @__PURE__ */ jsxs19(
      "div",
      {
        className: "browser-width-ruler browser-width-ruler--full",
        role: "slider",
        "aria-label": "Viewport width ruler",
        "aria-valuemin": WIDTH_SLIDER_MIN,
        "aria-valuemax": WIDTH_SLIDER_MAX,
        "aria-valuenow": viewport.w,
        "aria-valuetext": `${rulerLabelForWidth(viewport.w)} - ${viewport.w}px`,
        tabIndex: active ? 0 : -1,
        "data-disabled": !active,
        title: `${rulerLabelForWidth(viewport.w)} - ${viewport.w}px`,
        onMouseDown: (e) => {
          if (!active) return;
          const t = e.target;
          if (t?.closest?.(".browser-ruler-tick")) return;
          rulerDragRef.current = true;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = rect.width ? (e.clientX - rect.left) / rect.width * 100 : 0;
          const v = rulerWidthForPct(pct);
          rulerPendingRef.current = v;
          setDraftW(String(v));
          setRulerHover(v);
        },
        onMouseMove: (e) => {
          if (!active) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = rect.width ? (e.clientX - rect.left) / rect.width * 100 : 0;
          const v = rulerWidthForPct(pct);
          const target = e.target;
          const onTick = !!target?.closest?.(".browser-ruler-tick");
          if (!onTick || rulerDragRef.current) setRulerHover(v);
          if (!rulerDragRef.current) return;
          rulerPendingRef.current = v;
          setDraftW(String(v));
          if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
          rulerTimerRef.current = window.setTimeout(() => {
            rulerTimerRef.current = null;
            const pending = rulerPendingRef.current;
            rulerPendingRef.current = null;
            if (pending !== null) void applySize(pending, sizeRef.current.h);
          }, 250);
        },
        onMouseUp: () => {
          if (!rulerDragRef.current) return;
          rulerDragRef.current = false;
          const pending = rulerPendingRef.current;
          rulerPendingRef.current = null;
          if (rulerTimerRef.current) window.clearTimeout(rulerTimerRef.current);
          rulerTimerRef.current = null;
          if (pending !== null) void applySize(pending, sizeRef.current.h);
        },
        onMouseLeave: () => {
          if (!rulerDragRef.current) setRulerHover(null);
        },
        onKeyDown: (e) => {
          if (!active) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const delta = e.key === "ArrowLeft" ? -WIDTH_RULER_STEP : WIDTH_RULER_STEP;
            void applySize(viewport.w + delta, sizeRef.current.h);
          }
        },
        children: [
          widthRulerTicks().map((w) => /* @__PURE__ */ jsx20(
            "span",
            {
              className: "browser-ruler-tick",
              style: { left: `${rulerPctForWidth(w)}%` },
              title: `${rulerLabelForWidth(w)} - ${w}px`,
              onMouseEnter: () => setRulerHover(w),
              onFocus: () => setRulerHover(w),
              onClick: () => {
                if (active) void applySize(w, sizeRef.current.h);
              },
              children: /* @__PURE__ */ jsx20("span", { className: "browser-ruler-tick-label", "aria-hidden": "true", children: w })
            },
            w
          )),
          /* @__PURE__ */ jsx20(
            "div",
            {
              className: "browser-ruler-thumb",
              style: { left: `${rulerPctForWidth(viewport.w)}%` },
              "aria-hidden": "true"
            }
          ),
          rulerHover !== null && /* @__PURE__ */ jsx20(
            "span",
            {
              className: "browser-ruler-tip",
              style: { left: `${rulerPctForWidth(rulerHover)}%` },
              "aria-hidden": "true",
              children: `${rulerLabelForWidth(rulerHover)} - ${rulerHover}px`
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ jsx20(
      "div",
      {
        ref: stageRef,
        className: "browser-stage",
        tabIndex: 0,
        title: "Click the page, then type \u2014 keystrokes go to the virtual browser",
        onKeyDown: stageKeyDown,
        onMouseDown: (e) => e.currentTarget.focus(),
        children: !available ? (
          // No automation browser installed. This used to be invisible: the
          // stage sat on "Connecting…" forever, and the only way out was the
          // user's own Chrome being used as the driver.
          /* @__PURE__ */ jsxs19("div", { className: "browser-install", children: [
            /* @__PURE__ */ jsx20("div", { className: "browser-install-title", children: "Automation browser not installed" }),
            /* @__PURE__ */ jsx20("p", { className: "browser-install-body", children: "Codifa drives its own headless browser, so your everyday browser is never touched. Download it once (~90 MB) and the agent can browse." }),
            /* @__PURE__ */ jsx20(
              "button",
              {
                type: "button",
                className: "browser-install-btn",
                onClick: () => void startInstall(),
                disabled: installing,
                children: installing ? installPhase === "extracting" ? `Unpacking\u2026 ${installPct}%` : `Downloading\u2026 ${installPct}%` : "Install browser"
              }
            ),
            installing && /* @__PURE__ */ jsx20("div", { className: "browser-install-bar", "aria-hidden": "true", children: /* @__PURE__ */ jsx20(
              "div",
              {
                className: "browser-install-fill",
                style: { width: `${Math.max(2, installPct)}%` }
              }
            ) }),
            error && /* @__PURE__ */ jsx20("div", { className: "browser-install-error", children: error })
          ] })
        ) : loading ? /* @__PURE__ */ jsx20("div", { className: "viewer-empty", children: "Connecting to the virtual browser\u2026" }) : image ? /* @__PURE__ */ jsxs19("div", { className: "browser-stage-inner", style: { width: frameW, height: frameH }, children: [
          /* @__PURE__ */ jsx20(
            "img",
            {
              src: image,
              alt: "Virtual browser",
              className: "browser-stage-img",
              onClick: (e) => void clickAt(e),
              onWheel: (e) => void wheel(e),
              onMouseMove: (e) => hoverAt(e),
              onMouseLeave: () => setCursor(null),
              draggable: false
            }
          ),
          cursor && /* @__PURE__ */ jsx20(
            "svg",
            {
              width: "18",
              height: "18",
              viewBox: "0 0 24 24",
              style: {
                position: "absolute",
                left: `${cursor.x}%`,
                top: `${cursor.y}%`,
                transform: "translate(-2px, -2px)",
                pointerEvents: "none",
                filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))"
              },
              "aria-hidden": "true",
              children: /* @__PURE__ */ jsx20(
                "path",
                {
                  d: "M5 3l14 8-6.2 1.6L10 19z",
                  fill: "#fff",
                  stroke: "#111",
                  strokeWidth: "1.2",
                  strokeLinejoin: "round"
                }
              )
            }
          )
        ] }) : /* @__PURE__ */ jsx20("div", { className: "viewer-empty", children: active ? "No frame yet \u2014 press reload." : "Browser is stopped \u2014 type a URL above and press Enter." })
      }
    ),
    /* @__PURE__ */ jsx20(
      "div",
      {
        className: "browser-status" + (error ? " browser-status--error" : ""),
        title: error || pageUrl,
        children: error || pageUrl || (active ? "running" : "stopped")
      }
    )
  ] });
}
function isProbablyUrl(raw) {
  const s = raw.trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s);
}
function SvgIcon({ children, size = 16 }) {
  return /* @__PURE__ */ jsx20(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children
    }
  );
}
function FitIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { children: [
    /* @__PURE__ */ jsx20("path", { d: "M4 9V4h5" }),
    /* @__PURE__ */ jsx20("path", { d: "M20 15v5h-5" }),
    /* @__PURE__ */ jsx20("path", { d: "M15 4h5v5" }),
    /* @__PURE__ */ jsx20("path", { d: "M9 20H4v-5" })
  ] });
}
function BackIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { children: [
    /* @__PURE__ */ jsx20("path", { d: "M19 12H5" }),
    /* @__PURE__ */ jsx20("path", { d: "M12 19l-7-7 7-7" })
  ] });
}
function ForwardIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { children: [
    /* @__PURE__ */ jsx20("path", { d: "M5 12h14" }),
    /* @__PURE__ */ jsx20("path", { d: "M12 5l7 7-7 7" })
  ] });
}
function ReloadIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { children: [
    /* @__PURE__ */ jsx20("polyline", { points: "23 4 23 10 17 10" }),
    /* @__PURE__ */ jsx20("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" })
  ] });
}
function StopIcon() {
  return /* @__PURE__ */ jsx20(SvgIcon, { children: /* @__PURE__ */ jsx20("rect", { x: "6.5", y: "6.5", width: "11", height: "11", rx: "2.5", fill: "currentColor", stroke: "none" }) });
}
function KebabIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { children: [
    /* @__PURE__ */ jsx20("circle", { cx: "12", cy: "5", r: "1.7", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ jsx20("circle", { cx: "12", cy: "12", r: "1.7", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ jsx20("circle", { cx: "12", cy: "19", r: "1.7", fill: "currentColor", stroke: "none" })
  ] });
}
function LockIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { size: 13, children: [
    /* @__PURE__ */ jsx20("rect", { x: "4", y: "11", width: "16", height: "10", rx: "2" }),
    /* @__PURE__ */ jsx20("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" })
  ] });
}
function SearchIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { size: 13, children: [
    /* @__PURE__ */ jsx20("circle", { cx: "11", cy: "11", r: "7" }),
    /* @__PURE__ */ jsx20("path", { d: "M21 21l-4.35-4.35" })
  ] });
}
function GlobeIcon() {
  return /* @__PURE__ */ jsxs19(SvgIcon, { size: 13, children: [
    /* @__PURE__ */ jsx20("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx20("path", { d: "M3 12h18" }),
    /* @__PURE__ */ jsx20("path", { d: "M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z" })
  ] });
}
var init_BrowserPanel = __esm({
  "src/components/BrowserPanel.tsx"() {
    "use strict";
    init_api();
    init_browserViewport();
  }
});

// src/components/FileViewerPanel.tsx
var FileViewerPanel_exports = {};
__export(FileViewerPanel_exports, {
  FileViewerPanel: () => FileViewerPanel
});
import { memo as memo3, useEffect as useEffect16, useMemo as useMemo9, useRef as useRef13, useState as useState18 } from "react";
import { createPortal as createPortal6 } from "react-dom";
import { jsx as jsx21, jsxs as jsxs20 } from "react/jsx-runtime";
function PdfViewer({ base64, title }) {
  const [url, setUrl] = useState18(null);
  useEffect16(() => {
    let bin;
    try {
      bin = atob(base64);
    } catch {
      setUrl(null);
      return;
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const objectUrl = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" })
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [base64]);
  if (!url) return /* @__PURE__ */ jsx21("div", { className: "file-viewer-note", children: "Preparing PDF\u2026" });
  return /* @__PURE__ */ jsx21(
    "iframe",
    {
      className: "file-viewer-pdf",
      src: url,
      title: title ? `${title} (PDF)` : "PDF"
    }
  );
}
function stripSheetTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function markQueryHtml(html, query) {
  const q = query.trim();
  if (!q) return html;
  let re;
  try {
    re = new RegExp(escapeRegExp(q), "gi");
  } catch {
    return html;
  }
  const parts = html.split(/(<[^>]+>)/g);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.startsWith("<")) continue;
    parts[i] = p.replace(re, (m) => `<mark class="fv-mark">${m}</mark>`);
  }
  return parts.join("");
}
function colToLetters(n) {
  let s = "";
  let v = n;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}
function VirtualSheetTable({ name, rows, query, activeRow }) {
  const CAP_ROWS = 2e3;
  const total = rows.length;
  const shown = Math.min(total, CAP_ROWS);
  const q = (query ?? "").trim().toLowerCase();
  const visibleHtml = useMemo9(() => {
    return rows.slice(0, shown).map((r, idx) => {
      let out = r;
      if (idx === 0) {
        out = out.replace(/<td([^>]*)>/g, '<th$1 style="background:#f2f2f2;font-weight:600;position:sticky;top:0;z-index:1;border:1px solid #d0d0d0;padding:6px 10px;">');
      }
      const isCurrent = activeRow != null && idx === activeRow;
      if (isCurrent && q.length > 0) {
        out = markQueryHtml(out, query ?? "");
        out = out.replace(
          /<tr(?=[\s>])/,
          '<tr data-search-current="1" style="background:color-mix(in srgb, var(--accent) 20%, transparent);"'
        );
      }
      return out;
    }).join("");
  }, [rows, shown, q, query, activeRow]);
  const gridRef = useRef13(null);
  useEffect16(() => {
    if (activeRow != null && activeRow >= 0 && activeRow < shown) {
      gridRef.current?.querySelector(`[data-search-current="1"]`)?.scrollIntoView({ block: "center" });
    }
  }, [activeRow, shown]);
  return /* @__PURE__ */ jsxs20("div", { className: "fv-sheet-wrap", "data-sheet": name, dir: "ltr", style: { direction: "ltr", textAlign: "left", width: "100%" }, children: [
    /* @__PURE__ */ jsx21("div", { ref: gridRef, children: /* @__PURE__ */ jsx21("table", { border: 1, cellPadding: 6, cellSpacing: 0, style: { borderCollapse: "collapse", whiteSpace: "pre", width: "max-content", minWidth: "100%", direction: "ltr", margin: 0, background: "#ffffff", color: "#111111", fontSize: 13, lineHeight: "20px" }, children: /* @__PURE__ */ jsx21("tbody", { dangerouslySetInnerHTML: { __html: visibleHtml } }) }) }),
    total > shown && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-note", dir: "auto", children: [
      "Showing first ",
      shown.toLocaleString(),
      " of ",
      total.toLocaleString(),
      " rows \u2014 refine search or sheet to narrow."
    ] })
  ] });
}
function parseCommentRange(loc) {
  const m = /(\d+)(?:\s*-\s*(\d+))?/.exec(loc);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}
function FileViewerPanel({
  filePath,
  fileLine,
  fileRoot,
  chatId
}) {
  const storeRoot = useStore(
    (s) => s.chats.find((c2) => c2.id === s.activeChatId)?.root ?? s.root
  );
  const root = fileRoot || storeRoot;
  const cleanFilePath = normPath(filePath);
  const absPath = cleanFilePath.startsWith("/") ? cleanFilePath : `${(root || "").replace(/\/+$/, "")}/${cleanFilePath}`;
  const ext = extOf(filePath);
  const isImage = IMAGE_EXTS.has(ext);
  const defaultApp = defaultAppForExt(ext);
  const isOfficeDoc = defaultApp !== null;
  const defaultAppLabel = defaultApp?.label ?? "Default app";
  const defaultTargetIcon = defaultApp?.icon ?? "DOC";
  const visibleTargets = isOfficeDoc ? [
    {
      id: "default",
      icon: defaultTargetIcon,
      iconClass: "fv-open-icon-default",
      label: `Open in ${defaultAppLabel}`,
      hint: "System default app",
      title: `Open in ${defaultAppLabel}`
    }
  ] : OPEN_TARGETS;
  const docRev = useStore((s) => s.docRev[absPath] ?? 0);
  const appDir = useStore((s) => s.dir);
  const activeChatId = useStore((s) => s.activeChatId);
  const ownerChatId = chatId ?? activeChatId;
  const [state, setState] = useState18({ loading: true });
  const [copied, setCopied] = useState18(false);
  const [extNote, setExtNote] = useState18(null);
  const [similar, setSimilar] = useState18([]);
  const [openMenu, setOpenMenu] = useState18(false);
  const [opening, setOpening] = useState18(null);
  const openMenuRef = useRef13(null);
  const bodyRef = useRef13(null);
  const [sheet, setSheet] = useState18("");
  const [sheetInput, setSheetInput] = useState18("");
  const [searchOpen, setSearchOpen] = useState18(false);
  const [query, setQuery] = useState18("");
  const [matchIdx, setMatchIdx] = useState18(0);
  const [gridActiveRow, setGridActiveRow] = useState18(void 0);
  const searchInputRef = useRef13(null);
  const commentInputRef = useRef13(null);
  const savedRangeRef = useRef13(null);
  const [commentText, setCommentText] = useState18("");
  useEffect16(() => {
    setSheet("");
    setSheetInput("");
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
    setSelBar(null);
    savedRangeRef.current = null;
  }, [absPath]);
  const rootRef = useRef13(null);
  const [selection, setSelection] = useState18("");
  const [anchorPos, setAnchorPos] = useState18(null);
  const [selBar, setSelBar] = useState18(null);
  const [commentOpen, setCommentOpen] = useState18(false);
  const [commentQuote, setCommentQuote] = useState18("");
  const [commentLoc, setCommentLoc] = useState18("");
  const locateSelection = (sel) => {
    try {
      if (!sel || sel.rangeCount === 0) return "";
      const nodeToEl = (n) => n instanceof Element ? n : n?.parentElement ?? null;
      const aEl = nodeToEl(sel.anchorNode);
      const fEl = nodeToEl(sel.focusNode);
      const aLine = aEl?.closest?.("[data-line]")?.getAttribute("data-line");
      const fLine = fEl?.closest?.("[data-line]")?.getAttribute("data-line");
      const aNum = aLine ? parseInt(aLine, 10) : NaN;
      const fNum = fLine ? parseInt(fLine, 10) : NaN;
      if (Number.isFinite(aNum) || Number.isFinite(fNum)) {
        const a = Number.isFinite(aNum) ? aNum : fNum;
        const f = Number.isFinite(fNum) ? fNum : aNum;
        const lo = Math.min(a, f);
        const hi = Math.max(a, f);
        return lo === hi ? `line ${lo}` : `lines ${lo}-${hi}`;
      }
      const aRow = aEl?.closest?.("tr");
      if (aRow?.parentElement) {
        const rows = Array.from(aRow.parentElement.children);
        const i = rows.indexOf(aRow) + 1;
        const fRow = fEl?.closest?.("tr");
        const cellOf = (el) => el?.closest?.("td, th") ?? null;
        const colOf = (cell) => {
          if (!cell?.parentElement) return NaN;
          return Array.from(cell.parentElement.children).indexOf(cell) + 1;
        };
        const aCol = colOf(cellOf(aEl));
        const fCol = colOf(cellOf(fEl));
        const fmtRowsCols = (r1, r2, c1, c2) => {
          const rowsPart = r2 != null && r2 !== r1 ? `rows ${Math.min(r1, r2)}-${Math.max(r1, r2)}` : `row ${r1}`;
          const cKnown = (v) => Number.isFinite(v) && v > 0;
          if (!cKnown(c1) && (c2 == null || !cKnown(c2))) return rowsPart;
          const lo = cKnown(c1) && c2 != null && cKnown(c2) ? Math.min(c1, c2) : cKnown(c1) ? c1 : c2;
          const hi = cKnown(c1) && c2 != null && cKnown(c2) ? Math.max(c1, c2) : lo;
          const colsPart = hi !== lo ? `cols ${colToLetters(lo)}-${colToLetters(hi)}` : `col ${colToLetters(lo)}`;
          return `${rowsPart}, ${colsPart}`;
        };
        if (fRow && fRow !== aRow && fRow.parentElement === aRow.parentElement) {
          const j = rows.indexOf(fRow) + 1;
          return fmtRowsCols(i, j, aCol, fCol);
        }
        if (i > 0) {
          const sameRowMultiCol = fRow === aRow && Number.isFinite(aCol) && Number.isFinite(fCol) && aCol !== fCol;
          if (sameRowMultiCol) return fmtRowsCols(i, i, aCol, fCol);
          return fmtRowsCols(i, null, aCol, NaN);
        }
      }
    } catch {
    }
    return "";
  };
  const refreshSelection = (target) => {
    const el = target;
    if (el && typeof el.closest === "function" && el.closest("input, textarea, .fv-comment-float, .fv-comment-input, .fv-search-bar, .fv-sheet-form, .fv-open-menu")) return;
    if (commentOpen) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return;
    const anchorInside = !!rootRef.current?.contains(sel.anchorNode);
    const focusInside = !!rootRef.current?.contains(sel.focusNode);
    if (!anchorInside && !focusInside) {
      return;
    }
    const text = sel.toString().trim() ?? "";
    if (text.length === 0 || text.length > 2e3) return;
    if (text === selection) return;
    let savedRect;
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range) {
        savedRangeRef.current = range.cloneRange();
        savedRect = range.getBoundingClientRect();
      }
    } catch {
      savedRangeRef.current = null;
    }
    setSelection(text);
    const loc = locateSelection(sel);
    setCommentLoc(loc);
    setCommentQuote(text);
    try {
      const rect = savedRect;
      if (rect && (rect.width > 0 || rect.height > 0) && typeof window !== "undefined") {
        setSelBar(
          selectionBarPos(rect, window.innerWidth, window.innerHeight)
        );
      } else {
        setSelBar((prev) => prev ?? { x: 16, y: 96 });
      }
    } catch {
      setSelBar((prev) => prev ?? { x: 16, y: 96 });
    }
  };
  const openCommentBox = () => {
    setAnchorPos(selBar ?? { x: 16, y: 96 });
    setSelBar(null);
    setCommentOpen(true);
    requestAnimationFrame(() => {
      try {
        commentInputRef.current?.focus?.({ preventScroll: true });
      } catch {
        commentInputRef.current?.focus?.();
      }
    });
  };
  const copySelection = () => {
    let live = "";
    try {
      live = window.getSelection()?.toString().trim() ?? "";
    } catch {
      live = "";
    }
    void copyToClipboard(live || commentQuote || selection);
    cancelComment();
  };
  useEffect16(() => {
    const defer = (t) => {
      requestAnimationFrame(() => requestAnimationFrame(() => refreshSelection(t)));
    };
    const onUp = (e) => defer(e.target);
    const onDbl = (e) => defer(e.target);
    const onKey = (e) => refreshSelection(e.target);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("dblclick", onDbl);
    document.addEventListener("keyup", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("dblclick", onDbl);
      document.removeEventListener("keyup", onKey);
    };
  }, [commentOpen, selection, commentText]);
  const sendComment = (queued) => {
    const base = commentQuote || selection;
    if (!base || !ownerChatId) return;
    const note = commentText.trim();
    let locSuffix = "";
    const rowsMatch = commentLoc.match(/rows?\s+(\d+)(?:\s*-\s*(\d+))?/i);
    const colsMatch = commentLoc.match(/cols?\s+([A-Z]+)(?:\s*-\s*([A-Z]+))?/i);
    if (rowsMatch) {
      const r1 = parseInt(rowsMatch[1], 10);
      const r2 = rowsMatch[2] ? parseInt(rowsMatch[2], 10) : r1;
      const loR = Math.min(r1, r2);
      const hiR = Math.max(r1, r2);
      const c1 = colsMatch?.[1]?.toUpperCase();
      const c2 = (colsMatch?.[2] ?? c1)?.toUpperCase();
      if (c1) {
        let sheetName = "";
        try {
          const sc = savedRangeRef.current?.startContainer ?? null;
          const scEl = sc instanceof Element ? sc : sc?.parentElement ?? null;
          sheetName = scEl?.closest?.("[data-sheet]")?.getAttribute("data-sheet") ?? "";
        } catch {
          sheetName = "";
        }
        if (!sheetName) sheetName = sheet.trim();
        const a1 = hiR !== loR || c2 !== c1 ? `${c1}${loR}:${c2}${hiR}` : `${c1}${loR}`;
        const safeSheet = sheetName.includes(" ") || sheetName.includes("'") ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
        locSuffix = sheetName ? `:${safeSheet}!${a1}` : `:${a1}`;
      } else {
        locSuffix = hiR !== loR ? `:rows ${loR}-${hiR}` : `:row ${loR}`;
      }
    } else {
      const locMatch = commentLoc.match(/(\d+)(?:\s*-\s*(\d+))?/);
      locSuffix = locMatch ? locMatch[2] ? `:${locMatch[1]}-${locMatch[2]}` : `:${locMatch[1]}` : "";
    }
    const body = note ? `${base}

Note: ${note}` : base;
    commentFileSelection(ownerChatId, `${filePath}${locSuffix}`, body, { queue: queued });
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
    savedRangeRef.current = null;
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
  };
  const cancelComment = () => {
    savedRangeRef.current = null;
    setSelection("");
    setCommentQuote("");
    setCommentLoc("");
    setCommentText("");
    setCommentOpen(false);
    setAnchorPos(null);
    setSelBar(null);
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
  };
  useEffect16(() => {
    if (!commentOpen && !selBar) return;
    const onDown = (e) => {
      const t = e.target;
      if (t && typeof t.closest === "function" && t.closest(".fv-comment-float, .fv-sel-bar")) return;
      cancelComment();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [commentOpen, selBar]);
  useEffect16(() => {
    const onKey = (ev) => {
      const key = ev.key.toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && key === "f") {
        ev.preventDefault();
        ev.stopPropagation();
        setSearchOpen(true);
      } else if (ev.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [searchOpen]);
  useEffect16(() => {
    if (searchOpen) searchInputRef.current?.focus?.();
  }, [searchOpen]);
  useEffect16(() => {
    setMatchIdx(0);
    setGridActiveRow(void 0);
  }, [query, absPath, state.content, state.html]);
  useEffect16(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: void 0 }));
    (async () => {
      try {
        if (isImage) {
          const dataUrl = await api.readImage(absPath);
          if (!alive) return;
          setState(
            dataUrl ? { loading: false, imageData: dataUrl } : { loading: false, error: "Image could not be loaded." }
          );
          return;
        }
        if (DOC_EXTS2.has(ext)) {
          if (ext === "pdf") {
            const b64 = await api.readPdfBase64(absPath);
            if (!alive) return;
            setState(
              b64 ? { loading: false, pdfBase64: b64 } : {
                loading: false,
                error: `Could not load this PDF (missing, or larger than 64 MB): ${absPath}`
              }
            );
            return;
          }
          const doc = await readDocumentText(root || "", absPath, DOC_TEXT_EXTS.has(ext) ? "text" : "html", SHEET_EXTS.has(ext) && sheet.trim() ? { sheet: sheet.trim() } : void 0);
          if (!alive) return;
          if (doc.error && ext === "csv") {
            const fallback = await readDocumentText(root || "", absPath, "text");
            if (!alive) return;
            if (fallback.content != null) {
              setState({ loading: false, content: fallback.content });
            } else {
              setState({ loading: false, error: doc.error });
            }
          } else if (doc.error) {
            setState({ loading: false, error: doc.error });
          } else if (doc.pages) {
            setState({ loading: false, pages: doc.pages });
          } else if (doc.html != null) {
            setState({ loading: false, html: doc.html });
          } else if (doc.content != null) {
            setState({ loading: false, content: doc.content });
          } else {
            setState({ loading: false, error: "Empty document." });
          }
          return;
        }
        const cleanPath = normPath(filePath.replace(/:\d+(?:-\d+)?$/, ""));
        const readPath = (rel) => cleanPath.startsWith("/") ? api.fsRead(
          cleanPath.slice(0, cleanPath.lastIndexOf("/")) || "/",
          cleanPath.slice(cleanPath.lastIndexOf("/") + 1)
        ) : api.fsRead(root, rel);
        let res = await readPath(cleanPath);
        if (res?.content == null) {
          const hit = resolveWorkspacePath(cleanPath, await workspaceFiles(root));
          if (hit) res = await api.fsRead(root, hit.rel);
        }
        if (!alive) return;
        setState(
          res?.content != null ? { loading: false, content: res.content } : {
            loading: false,
            // Name the attempted path and root: a bare "not found" made
            // this undebuggable when the chip carried a stale path.
            error: `No file exists at this path: ${cleanPath}${root ? ` (workspace: ${root})` : ""} \u2014 it may be planned but never created, or it has moved.`
          }
        );
      } catch (err) {
        if (!alive) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [filePath, root, isImage, ext, absPath, docRev, sheet]);
  useEffect16(() => {
    setSimilar([]);
    if (!state.error || !root) return;
    let alive = true;
    (async () => {
      const files = await api.fsWalk(root).catch(() => []);
      if (!alive) return;
      setSimilar(suggestSimilarFiles(filePath, files));
    })();
    return () => {
      alive = false;
    };
  }, [state.error, filePath, root]);
  const content = state.content ?? "";
  const binary = content.includes("\0");
  const capped = content.length > FILE_RENDER_CAP;
  const shown = capped ? content.slice(0, FILE_RENDER_CAP) : content;
  const lines = useMemo9(() => binary ? [] : shown.split("\n"), [shown, binary]);
  const highlighted = useMemo9(
    () => binary ? [] : getHighlightedLines(shown, ext),
    [shown, ext, binary]
  );
  const ROW_H = 20;
  const WINDOW_ROWS = 250;
  const [viewTop, setViewTop] = useState18(0);
  useEffect16(() => {
    setViewTop(0);
    bodyRef.current?.scrollTo?.(0, 0);
  }, [absPath]);
  const totalRows = lines.length;
  const useVirtual = totalRows > 1e3;
  const startRow = useVirtual ? Math.max(0, Math.floor(viewTop / ROW_H) - 20) : 0;
  const endRow = useVirtual ? Math.min(totalRows, startRow + WINDOW_ROWS) : totalRows;
  const topPad = useVirtual ? startRow * ROW_H : 0;
  const bottomPad = useVirtual ? Math.max(0, (totalRows - endRow) * ROW_H) : 0;
  useEffect16(() => {
    if (fileLine && fileLine > 0 && totalRows > 0) {
      const targetTop = Math.max(0, (fileLine - 60) * ROW_H);
      setViewTop((prev) => Math.abs(prev - targetTop) > ROW_H ? targetTop : prev);
    }
  }, [fileLine, totalRows]);
  useEffect16(() => {
    if (!fileLine || state.loading || binary) return;
    const el = bodyRef.current?.querySelector(
      `[data-line="${fileLine}"]`
    );
    el?.scrollIntoView({ block: "center" });
  }, [fileLine, state.loading, state.content, binary]);
  const copy = async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  const isGridDoc = GRID_EXTS.has(ext);
  const sheetTables = useMemo9(() => {
    if (!isGridDoc) return [];
    const tables = [];
    try {
      const html = state.html;
      if (html != null) {
        const re = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          const name = m[1].replace(/<[^>]+>/g, "").trim() || "Sheet";
          const body = m[2];
          const rows = [];
          const rre = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
          let rm;
          while ((rm = rre.exec(body)) !== null) rows.push(rm[0]);
          if (rows.length > 0) tables.push({ name, rows });
        }
        if (tables.length === 0) {
          const rre = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
          const rows = [];
          let rm;
          while ((rm = rre.exec(html)) !== null) rows.push(rm[0]);
          if (rows.length > 0) tables.push({ name: sheet.trim() || "Sheet", rows });
        }
      }
      if (tables.length === 0 && ext === "csv" && state.content != null) {
        const escapeCell = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const splitCsvLine = (line) => {
          const out = [];
          let cur = "";
          let quoted = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (quoted && line[i + 1] === '"') {
                cur += '"';
                i++;
              } else {
                quoted = !quoted;
              }
            } else if (ch === "," && !quoted) {
              out.push(cur);
              cur = "";
            } else {
              cur += ch;
            }
          }
          out.push(cur);
          return out.map((c2) => c2.trim());
        };
        const rawLines = state.content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const rows = rawLines.map((line, idx) => {
          const cells = splitCsvLine(line);
          const tag = idx === 0 ? "th" : "td";
          const tds = cells.map((c2) => `<${tag} dir="auto" style="border:1px solid #d0d0d0;padding:6px 10px;${idx === 0 ? "background:#f0f0f0;font-weight:600;" : "background:#ffffff;"}">${escapeCell(c2)}</${tag}>`).join("");
          return `<tr>${tds}</tr>`;
        });
        if (rows.length > 0) tables.push({ name: fileBasename(filePath), rows });
      }
    } catch {
      return [];
    }
    return tables;
  }, [isGridDoc, state.html, state.content, sheet, ext, filePath]);
  const gridRows0 = sheetTables.length > 0 ? sheetTables[0].rows : [];
  const qlow = query.trim().toLowerCase();
  const gridMatches = useMemo9(() => {
    if (!qlow || gridRows0.length === 0) return [];
    const out = [];
    for (let i = 0; i < gridRows0.length; i++) {
      if (stripSheetTags(gridRows0[i]).toLowerCase().includes(qlow)) out.push(i);
      if (out.length > 2e3) break;
    }
    return out;
  }, [gridRows0, qlow]);
  const textMatches = useMemo9(() => {
    if (!qlow || binary || lines.length === 0) return [];
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(qlow)) out.push(i + 1);
      if (out.length > 2e3) break;
    }
    return out;
  }, [lines, qlow, binary]);
  const isGridSearch = isGridDoc && sheetTables.length > 0;
  const totalMatches = isGridSearch ? gridMatches.length : textMatches.length;
  const safeMatchIdx = totalMatches > 0 ? matchIdx % totalMatches : 0;
  const activeTextLine = !isGridSearch && totalMatches > 0 ? textMatches[safeMatchIdx] : void 0;
  useEffect16(() => {
    if (isGridSearch) setGridActiveRow(totalMatches > 0 ? gridMatches[safeMatchIdx] : void 0);
  }, [isGridSearch, gridMatches, safeMatchIdx, totalMatches]);
  useEffect16(() => {
    if (!isGridSearch && activeTextLine != null) {
      const el = bodyRef.current?.querySelector(`[data-line="${activeTextLine}"]`);
      if (!el) setViewTop(Math.max(0, (activeTextLine - 60) * ROW_H));
      else el.scrollIntoView({ block: "center" });
    }
  }, [activeTextLine, isGridSearch]);
  const stepMatch = (dir) => {
    if (totalMatches === 0) return;
    setMatchIdx((i) => (i + dir + totalMatches) % totalMatches);
  };
  const openExternalFile = async (editor) => {
    setExtNote(null);
    setOpening(editor);
    try {
      const res = await api.openFileExternal(absPath, editor);
      if (res.ok) {
        setOpenMenu(false);
      } else {
        setExtNote(res.error || `Could not open in ${editor}.`);
      }
    } catch (err) {
      setExtNote(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  };
  useEffect16(() => {
    if (!openMenu) return;
    const onPointerDown = (ev) => {
      if (ev.target instanceof Node && openMenuRef.current?.contains(ev.target)) return;
      setOpenMenu(false);
    };
    const onKeyDown = (ev) => {
      if (ev.key === "Escape") setOpenMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);
  return /* @__PURE__ */ jsxs20("div", { ref: rootRef, className: `file-viewer${commentOpen ? " has-comment-open" : ""}`, dir: appDir, onMouseUp: (e) => {
    const t = e.target;
    requestAnimationFrame(() => requestAnimationFrame(() => refreshSelection(t)));
  }, onKeyUp: (e) => refreshSelection(e.target), children: [
    /* @__PURE__ */ jsxs20("div", { className: "file-viewer-head", dir: "ltr", style: { direction: "ltr" }, children: [
      /* @__PURE__ */ jsx21(FileIcon, { path: filePath, size: 20 }),
      /* @__PURE__ */ jsx21("span", { className: "file-viewer-name", title: filePath, children: fileBasename(filePath) }),
      fileLine ? /* @__PURE__ */ jsxs20("span", { className: "file-viewer-line", children: [
        ":",
        fileLine
      ] }) : null,
      /* @__PURE__ */ jsx21("span", { className: "file-viewer-spacer" }),
      /* @__PURE__ */ jsxs20("div", { className: "fv-icon-actions", style: { display: "flex", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ jsxs20("div", { className: "fv-open-wrap", ref: openMenuRef, children: [
          /* @__PURE__ */ jsx21(
            "button",
            {
              type: "button",
              className: "fv-icon-btn",
              title: "Open this file in an external editor",
              "aria-haspopup": "menu",
              "aria-expanded": openMenu,
              "aria-label": "Open in external editor",
              onClick: () => setOpenMenu((o) => !o),
              children: /* @__PURE__ */ jsxs20("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                /* @__PURE__ */ jsx21("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }),
                /* @__PURE__ */ jsx21("path", { d: "M15 3h6v6" }),
                /* @__PURE__ */ jsx21("path", { d: "M10 14 21 3" })
              ] })
            }
          ),
          openMenu && /* @__PURE__ */ jsx21("div", { className: "fv-open-menu", role: "menu", dir: "ltr", style: { direction: "ltr" }, children: visibleTargets.map((t) => /* @__PURE__ */ jsxs20(
            "button",
            {
              type: "button",
              className: "fv-open-item",
              role: "menuitem",
              disabled: opening !== null,
              title: t.title,
              onClick: () => void openExternalFile(t.id),
              children: [
                /* @__PURE__ */ jsx21("span", { className: `fv-open-icon ${t.iconClass}`, "aria-hidden": "true", children: t.icon }),
                /* @__PURE__ */ jsxs20("span", { className: "fv-open-text", children: [
                  /* @__PURE__ */ jsxs20("span", { className: "fv-open-label", children: [
                    t.label,
                    opening === t.id ? " \u2014 opening\u2026" : ""
                  ] }),
                  /* @__PURE__ */ jsx21("span", { className: "fv-open-hint", children: t.hint })
                ] })
              ]
            },
            t.id
          )) })
        ] }),
        state.content != null && !binary && /* @__PURE__ */ jsx21(
          "button",
          {
            type: "button",
            className: `fv-icon-btn${copied ? " copied" : ""}`,
            title: copied ? "Copied" : "Copy file text",
            "aria-label": "Copy file text",
            onClick: copy,
            children: copied ? /* @__PURE__ */ jsx21("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx21("path", { d: "M20 6 9 17l-5-5" }) }) : /* @__PURE__ */ jsxs20("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx21("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
              /* @__PURE__ */ jsx21("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
            ] })
          }
        ),
        SHEET_EXTS.has(ext) && /* @__PURE__ */ jsxs20(
          "form",
          {
            className: "fv-sheet-form",
            style: { display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "nowrap", whiteSpace: "nowrap", flex: "0 0 auto", minWidth: 0 },
            onSubmit: (e) => {
              e.preventDefault();
              setSheet(sheetInput.trim());
            },
            children: [
              /* @__PURE__ */ jsx21(
                "input",
                {
                  className: "fv-sheet-input",
                  style: { width: 92, flex: "0 0 auto" },
                  value: sheetInput,
                  onChange: (e) => setSheetInput(e.target.value),
                  placeholder: "Sheet name",
                  title: "Excel sheet name \u2014 only this sheet is parsed (cheap for large workbooks)",
                  "aria-label": "Excel sheet name"
                }
              ),
              /* @__PURE__ */ jsx21(
                "button",
                {
                  type: "submit",
                  className: "fv-sheet-btn",
                  style: { flex: "0 0 auto" },
                  title: "Load this sheet only",
                  "aria-label": "Load sheet",
                  children: /* @__PURE__ */ jsxs20("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                    /* @__PURE__ */ jsx21("path", { d: "M5 12h14" }),
                    /* @__PURE__ */ jsx21("path", { d: "m13 6 6 6-6 6" })
                  ] })
                }
              ),
              sheet && /* @__PURE__ */ jsx21(
                "button",
                {
                  type: "button",
                  className: "fv-sheet-btn",
                  style: { flex: "0 0 auto" },
                  title: "Back to all sheets",
                  "aria-label": "Clear sheet filter",
                  onClick: () => {
                    setSheet("");
                    setSheetInput("");
                  },
                  children: "\u2715"
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsx21(
          "button",
          {
            type: "button",
            className: "fv-icon-btn",
            title: "Search in this file (Ctrl+F)",
            "aria-label": "Search in this file",
            "aria-expanded": searchOpen,
            onClick: () => setSearchOpen((o) => !o),
            children: /* @__PURE__ */ jsxs20("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx21("circle", { cx: "11", cy: "11", r: "8" }),
              /* @__PURE__ */ jsx21("path", { d: "m21 21-4.3-4.3" })
            ] })
          }
        )
      ] })
    ] }),
    searchOpen && /* @__PURE__ */ jsxs20(
      "form",
      {
        className: "fv-search-bar",
        dir: "ltr",
        onSubmit: (e) => {
          e.preventDefault();
          stepMatch(1);
        },
        children: [
          /* @__PURE__ */ jsx21(
            "input",
            {
              ref: searchInputRef,
              className: "fv-search-input",
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: "Search in file\u2026 (Ctrl+F)",
              "aria-label": "Search in file"
            }
          ),
          /* @__PURE__ */ jsx21("span", { className: "fv-search-count", children: query.trim() ? `${totalMatches} match${totalMatches === 1 ? "" : "es"}${totalMatches > 0 ? ` \xB7 ${safeMatchIdx + 1}/${totalMatches}` : ""}` : "Type to search" }),
          /* @__PURE__ */ jsxs20("span", { className: "fv-search-nav", children: [
            /* @__PURE__ */ jsx21("button", { type: "button", className: "fv-sheet-btn", title: "Previous match (Shift+Enter)", onClick: () => stepMatch(-1), children: "\u2191" }),
            /* @__PURE__ */ jsx21("button", { type: "submit", className: "fv-sheet-btn", title: "Next match (Enter)", children: "\u2193" }),
            /* @__PURE__ */ jsx21("button", { type: "button", className: "fv-sheet-btn", title: "Close search (Esc)", onClick: () => {
              setSearchOpen(false);
              setQuery("");
            }, children: "\u2715" })
          ] })
        ]
      }
    ),
    selBar && !commentOpen && (commentQuote || selection) && typeof document !== "undefined" ? createPortal6(
      /* @__PURE__ */ jsxs20(
        "div",
        {
          className: "fv-sel-bar",
          style: { position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 },
          onMouseUp: (e) => e.stopPropagation(),
          onKeyUp: (e) => e.stopPropagation(),
          children: [
            /* @__PURE__ */ jsx21(
              "button",
              {
                type: "button",
                className: "fv-sel-btn",
                title: "Copy",
                "aria-label": "Copy selection",
                onClick: copySelection,
                children: /* @__PURE__ */ jsxs20("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                  /* @__PURE__ */ jsx21("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
                  /* @__PURE__ */ jsx21("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
                ] })
              }
            ),
            /* @__PURE__ */ jsx21(
              "button",
              {
                type: "button",
                className: "fv-sel-btn",
                title: "Reply",
                "aria-label": "Reply to selection",
                onClick: openCommentBox,
                children: /* @__PURE__ */ jsxs20("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
                  /* @__PURE__ */ jsx21("polyline", { points: "9 17 4 12 9 7" }),
                  /* @__PURE__ */ jsx21("path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" })
                ] })
              }
            )
          ]
        }
      ),
      document.body
    ) : null,
    commentOpen && (commentQuote || selection) && typeof document !== "undefined" ? createPortal6(
      /* @__PURE__ */ jsx21(
        "div",
        {
          className: "fv-comment-float",
          style: anchorPos ? { position: "fixed", top: anchorPos.y, left: anchorPos.x, zIndex: 9999 } : { position: "fixed", top: 96, left: 16, zIndex: 9999 },
          onMouseUp: (e) => e.stopPropagation(),
          onKeyUp: (e) => e.stopPropagation(),
          children: /* @__PURE__ */ jsx21(
            "textarea",
            {
              ref: commentInputRef,
              className: "fv-comment-input",
              dir: "auto",
              value: commentText,
              onChange: (e) => setCommentText(e.target.value),
              onKeyDown: (e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelComment();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  sendComment(true);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendComment(false);
                }
              },
              placeholder: "Write a comment\u2026 Enter to send, Esc to cancel",
              "aria-label": "Comment on highlight",
              rows: 2
            }
          )
        }
      ),
      document.body
    ) : null,
    state.loading && state.content == null && state.html == null && state.pages == null && state.imageData == null && state.pdfBase64 == null && !state.error && /* @__PURE__ */ jsx21("div", { className: "file-viewer-note", children: "Loading\u2026" }),
    state.error && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-note", children: [
      "\u26A0 ",
      state.error
    ] }),
    state.error && similar.length > 0 && /* @__PURE__ */ jsxs20("div", { className: "fv-suggest", children: [
      /* @__PURE__ */ jsx21("span", { className: "fv-suggest-label", children: "Closest files in this workspace:" }),
      /* @__PURE__ */ jsx21("div", { className: "fv-suggest-list", children: similar.map((f) => /* @__PURE__ */ jsx21(FileChip, { path: f.rel, display: f.rel }, f.rel)) })
    ] }),
    extNote && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-note", children: [
      "\u26A0 ",
      extNote
    ] }),
    binary && /* @__PURE__ */ jsx21("div", { className: "file-viewer-note", children: "Binary file \u2014 no text preview." }),
    capped && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-note", children: [
      "Showing the first ",
      FILE_RENDER_CAP.toLocaleString(),
      " characters \u2014 the full file is ",
      content.length.toLocaleString(),
      " characters."
    ] }),
    state.imageData && /* @__PURE__ */ jsx21("div", { className: "file-viewer-image", children: /* @__PURE__ */ jsx21("img", { src: state.imageData, alt: fileBasename(filePath) }) }),
    state.pdfBase64 && /* @__PURE__ */ jsx21(PdfViewer, { base64: state.pdfBase64, title: fileBasename(filePath) }),
    state.pages && /* @__PURE__ */ jsx21("div", { className: "file-viewer-pages", children: state.pages.map((src, i) => /* @__PURE__ */ jsx21("img", { src, alt: `Page ${i + 1}` }, i)) }),
    isGridDoc && sheetTables.length > 0 ? /* @__PURE__ */ jsx21("div", { className: "file-viewer-doc fv-grid-doc", dir: "ltr", style: { direction: "ltr", width: "100%", flex: 1, minHeight: 0 }, children: sheetTables.map((t) => /* @__PURE__ */ jsx21(VirtualSheetTable, { name: t.name, rows: t.rows, query, activeRow: gridActiveRow }, t.name)) }) : state.html != null && // Server-generated HTML: every text node is escaped backend-side and
    // the style attributes are strictly constructed (no user HTML passes
    // through), so this is trusted at the same level as any other
    // sidecar response. sanitizeHtml would strip the font styles that
    // make the preview look like the real document.
    /* @__PURE__ */ jsx21(
      "div",
      {
        className: "file-viewer-doc",
        dir: "auto",
        dangerouslySetInnerHTML: { __html: state.html }
      }
    ),
    state.content != null && !binary && !isImage && !(isGridDoc && sheetTables.length > 0) && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-body", ref: bodyRef, dir: "ltr", style: { direction: "ltr" }, onScroll: (e) => setViewTop(e.currentTarget.scrollTop), children: [
      /* @__PURE__ */ jsxs20("pre", { className: "file-viewer-pre hljs", children: [
        topPad > 0 && /* @__PURE__ */ jsx21("span", { className: "fv-pad", "aria-hidden": "true", style: { height: topPad } }),
        lines.slice(startRow, endRow).map((_, k) => {
          const i = startRow + k;
          const n = i + 1;
          const isSearchCurrent = activeTextLine === n;
          const cmRange = commentOpen ? parseCommentRange(commentLoc) : null;
          const isCommentTarget = !!cmRange && n >= cmRange[0] && n <= cmRange[1];
          const html = (() => {
            const base = highlighted[i] === "" ? "\n" : highlighted[i];
            if (!qlow || !isSearchCurrent) return base;
            return markQueryHtml(base, query);
          })();
          return /* @__PURE__ */ jsxs20(
            "span",
            {
              "data-line": n,
              className: `fv-line${n === fileLine ? " target" : ""}${isSearchCurrent ? " search-current" : ""}${isCommentTarget ? " comment-target" : ""}`,
              children: [
                /* @__PURE__ */ jsx21("span", { className: "fv-gutter", "aria-hidden": "true", children: n }),
                /* @__PURE__ */ jsx21(CodeText, { html })
              ]
            },
            i
          );
        }),
        bottomPad > 0 && /* @__PURE__ */ jsx21("span", { className: "fv-pad", "aria-hidden": "true", style: { height: bottomPad } })
      ] }),
      totalRows > WINDOW_ROWS && /* @__PURE__ */ jsxs20("div", { className: "file-viewer-note", children: [
        "Virtualized: showing rows ",
        startRow + 1,
        "\u2013",
        endRow,
        " of ",
        totalRows,
        " \u2014 scroll to load more."
      ] })
    ] })
  ] });
}
var FILE_RENDER_CAP, OPEN_TARGETS, DOC_EXTS2, SHEET_EXTS, GRID_EXTS, DOC_TEXT_EXTS, CodeText;
var init_FileViewerPanel = __esm({
  "src/components/FileViewerPanel.tsx"() {
    "use strict";
    init_fs();
    init_api();
    init_fileComments();
    init_selectionBar();
    init_store();
    init_clipboard();
    init_fileTypes();
    init_FileIcon();
    init_highlight();
    FILE_RENDER_CAP = 4e5;
    OPEN_TARGETS = [
      {
        id: "nvim",
        icon: "NV",
        iconClass: "fv-open-icon-nvim",
        label: "Neovim",
        hint: "Running instance, else new terminal",
        title: "Open in the running Neovim instance (or a new terminal)"
      },
      {
        id: "cmux",
        icon: "CM",
        iconClass: "fv-open-icon-cmux",
        label: "Neovim in cmux",
        hint: "New cmux workspace running nvim",
        title: "Open nvim in a new cmux workspace (opens just the folder in cmux when its CLI refuses external apps)"
      },
      {
        id: "ghostty",
        icon: "GH",
        iconClass: "fv-open-icon-ghostty",
        label: "Neovim in Ghostty",
        hint: "New Ghostty window running nvim",
        title: "Open nvim in a new Ghostty window (requires Ghostty)"
      },
      {
        id: "warp",
        icon: "WP",
        iconClass: "fv-open-icon-warp",
        label: "Neovim in Warp",
        hint: "New Warp tab at the file's folder",
        title: "Open a new Warp tab at the file's folder (Warp cannot be told to run nvim)"
      },
      {
        id: "vscode",
        icon: "VS",
        iconClass: "fv-open-icon-vscode",
        label: "VS Code",
        hint: "code CLI, app bundle, or vscode:// handler",
        title: "Open in VS Code"
      }
    ];
    DOC_EXTS2 = /* @__PURE__ */ new Set(["pdf", "docx", "doc", "xlsx", "xlsm", "xls", "csv", "md"]);
    SHEET_EXTS = /* @__PURE__ */ new Set(["xlsx", "xlsm", "xls"]);
    GRID_EXTS = /* @__PURE__ */ new Set(["xlsx", "xlsm", "xls", "csv"]);
    DOC_TEXT_EXTS = /* @__PURE__ */ new Set(["doc", "md"]);
    CodeText = memo3(function CodeText2({ html }) {
      return /* @__PURE__ */ jsx21(
        "span",
        {
          className: "fv-text",
          dir: "auto",
          dangerouslySetInnerHTML: { __html: html === "" ? "\n" : html }
        }
      );
    });
  }
});

// src/components/TextViewerPanel.tsx
var TextViewerPanel_exports = {};
__export(TextViewerPanel_exports, {
  TextViewerPanel: () => TextViewerPanel
});
import { useEffect as useEffect17, useMemo as useMemo10, useState as useState19 } from "react";
import ReactMarkdown5 from "react-markdown";
import remarkGfm5 from "remark-gfm";
import { jsx as jsx22, jsxs as jsxs21 } from "react/jsx-runtime";
function TextViewerPanel({
  title,
  body,
  format
}) {
  const [copied, setCopied] = useState19(false);
  const [view, setView] = useState19(format ?? "md");
  useEffect17(() => setView(format ?? "md"), [format]);
  const capped = body.length > TEXT_RENDER_CAP;
  const shown = useMemo10(
    () => capped ? body.slice(0, TEXT_RENDER_CAP) : body,
    [body, capped]
  );
  const copy = async () => {
    try {
      await copyToClipboard(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  return /* @__PURE__ */ jsxs21("div", { className: "file-viewer text-viewer", dir: "ltr", children: [
    /* @__PURE__ */ jsxs21("div", { className: "file-viewer-head", children: [
      /* @__PURE__ */ jsx22("span", { className: "text-viewer-icon", "aria-hidden": "true", children: "\u{1F4DD}" }),
      /* @__PURE__ */ jsx22("span", { className: "file-viewer-name", title, children: title }),
      /* @__PURE__ */ jsx22("span", { className: "file-viewer-spacer" }),
      /* @__PURE__ */ jsxs21("div", { className: "tv-view-toggle", role: "group", "aria-label": "Render mode", children: [
        /* @__PURE__ */ jsx22(
          "button",
          {
            type: "button",
            className: view === "md" ? "active" : "",
            title: "Render as markdown (file paths become clickable)",
            "aria-pressed": view === "md",
            onClick: () => setView("md"),
            children: "MD"
          }
        ),
        /* @__PURE__ */ jsx22(
          "button",
          {
            type: "button",
            className: view === "text" ? "active" : "",
            title: "Raw text",
            "aria-pressed": view === "text",
            onClick: () => setView("text"),
            children: "Raw"
          }
        )
      ] }),
      /* @__PURE__ */ jsx22(
        "button",
        {
          type: "button",
          className: `fv-copy${copied ? " copied" : ""}`,
          onClick: copy,
          children: copied ? "Copied \u2713" : "Copy"
        }
      )
    ] }),
    capped && /* @__PURE__ */ jsxs21("div", { className: "file-viewer-note", children: [
      "Showing the first ",
      fmtSize(TEXT_RENDER_CAP),
      " \u2014 the full text is",
      " ",
      fmtSize(body.length),
      ". Copy carries the full text."
    ] }),
    view === "md" ? /* @__PURE__ */ jsx22("div", { className: "file-viewer-body text-viewer-md", children: /* @__PURE__ */ jsx22("div", { className: "chat-message markdown-body", dir: "ltr", children: /* @__PURE__ */ jsx22(ReactMarkdown5, { remarkPlugins: [remarkGfm5], components: mdComponents, children: shown }) }) }) : /* @__PURE__ */ jsx22("div", { className: "file-viewer-body", children: /* @__PURE__ */ jsx22("pre", { className: "text-viewer-pre", children: shown }) })
  ] });
}
var TEXT_RENDER_CAP;
var init_TextViewerPanel = __esm({
  "src/components/TextViewerPanel.tsx"() {
    "use strict";
    init_clipboard();
    init_renderCap();
    init_ChatMessage();
    TEXT_RENDER_CAP = 4e5;
  }
});

// src/components/MacAppIcons.tsx
import { jsx as jsx23, jsxs as jsxs22 } from "react/jsx-runtime";
function FolderIcon() {
  return /* @__PURE__ */ jsxs22("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx23("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }),
    /* @__PURE__ */ jsx23("path", { d: "M3 13h18", opacity: "0.6" })
  ] });
}
var init_MacAppIcons = __esm({
  "src/components/MacAppIcons.tsx"() {
    "use strict";
  }
});

// src/components/ChatRenameInput.tsx
import { useEffect as useEffect18, useRef as useRef14, useState as useState20 } from "react";
import { jsx as jsx24 } from "react/jsx-runtime";
function ChatRenameInput({
  initialValue,
  dir,
  className,
  ariaLabel,
  onCommit,
  onCancel
}) {
  const [value, setValue] = useState20(initialValue);
  const inputRef = useRef14(null);
  const settledRef = useRef14(false);
  useEffect18(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);
  const commit = (v) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(v);
  };
  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };
  return /* @__PURE__ */ jsx24(
    "input",
    {
      ref: inputRef,
      className: className ?? "chat-rename-input",
      dir,
      value,
      "aria-label": ariaLabel ?? "Rename chat",
      onChange: (e) => setValue(e.target.value),
      onBlur: () => commit(value),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(value);
        else if (e.key === "Escape") cancel();
      },
      onClick: (e) => e.stopPropagation(),
      onAuxClick: (e) => e.stopPropagation(),
      onDoubleClick: (e) => e.stopPropagation(),
      onMouseDown: (e) => e.stopPropagation(),
      onDragStart: (e) => e.preventDefault(),
      draggable: false
    }
  );
}
var init_ChatRenameInput = __esm({
  "src/components/ChatRenameInput.tsx"() {
    "use strict";
  }
});

// src/components/FilesPanel.tsx
var FilesPanel_exports = {};
__export(FilesPanel_exports, {
  FilesPanel: () => FilesPanel
});
import { useCallback as useCallback7, useEffect as useEffect19, useRef as useRef15, useState as useState21 } from "react";
import { createPortal as createPortal7 } from "react-dom";
import { Fragment as Fragment10, jsx as jsx25, jsxs as jsxs23 } from "react/jsx-runtime";
function TreeChevron({ open }) {
  return /* @__PURE__ */ jsx25("span", { className: "files-chevron" + (open ? " open" : ""), "aria-hidden": "true", children: /* @__PURE__ */ jsx25("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.4", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx25("path", { d: "M9 6l6 6-6 6" }) }) });
}
function CopyIcon() {
  return /* @__PURE__ */ jsxs23("svg", { ...MENU_ICON, children: [
    /* @__PURE__ */ jsx25("rect", { x: "9", y: "9", width: "11", height: "11", rx: "2" }),
    /* @__PURE__ */ jsx25("path", { d: "M5 15V6a2 2 0 0 1 2-2h8" })
  ] });
}
function RenameIcon() {
  return /* @__PURE__ */ jsxs23("svg", { ...MENU_ICON, children: [
    /* @__PURE__ */ jsx25("path", { d: "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" }),
    /* @__PURE__ */ jsx25("path", { d: "M14.5 6.5l3 3" })
  ] });
}
function TrashIcon() {
  return /* @__PURE__ */ jsxs23("svg", { ...MENU_ICON, children: [
    /* @__PURE__ */ jsx25("path", { d: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" }),
    /* @__PURE__ */ jsx25("path", { d: "M10 11v6M14 11v6" })
  ] });
}
function errText(err) {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
function FilesPanel({ chatId }) {
  const ownerChatId = chatId;
  const root = useStore(
    (s) => s.chats.find((c2) => c2.id === (ownerChatId ?? s.activeChatId))?.root ?? s.root
  );
  const [cache, setCache] = useState21({});
  const [expanded, setExpanded] = useState21(() => /* @__PURE__ */ new Set());
  const [loading, setLoading] = useState21(() => /* @__PURE__ */ new Set());
  const [error, setError] = useState21(null);
  const [actionError, setActionError] = useState21(null);
  const genRef = useRef15(0);
  const [menu, setMenu] = useState21(null);
  const menuRef = useRef15(null);
  const [renaming, setRenaming] = useState21(null);
  const [dragPath, setDragPath] = useState21(null);
  const [dropDir, setDropDir] = useState21(null);
  const cacheRef = useRef15(cache);
  cacheRef.current = cache;
  const loadDir = useCallback7(
    async (dir, gen, quiet = false) => {
      if (!root) return;
      setLoading((prev) => new Set(prev).add(dir));
      try {
        const entries = await api.fsList(root, dir);
        if (gen !== genRef.current) return;
        setCache((prev) => mergeChildren(prev, dir, entries));
        if (!quiet) setError(null);
      } catch {
        if (gen !== genRef.current) return;
        if (!quiet) setError(dir ? `Could not read ${dir}` : "Could not read the workspace folder");
      } finally {
        if (gen === genRef.current) {
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [root]
  );
  useEffect19(() => {
    genRef.current += 1;
    const gen = genRef.current;
    setCache({});
    setExpanded(/* @__PURE__ */ new Set());
    setLoading(/* @__PURE__ */ new Set());
    setError(null);
    setActionError(null);
    setMenu(null);
    setDragPath(null);
    setDropDir(null);
    if (root) void loadDir("", gen);
  }, [root, loadDir]);
  const toggleDir = useCallback7(
    (dir) => {
      const opening = !expanded.has(dir);
      setExpanded((prev) => toggleExpanded(prev, dir));
      if (opening && !isLoaded(cache, dir)) void loadDir(dir, genRef.current);
      if (!opening) setCache((prev) => pruneSubtree(prev, dir));
    },
    [cache, expanded, loadDir]
  );
  const refreshTree = useCallback7(() => {
    genRef.current += 1;
    const gen = genRef.current;
    const dirs = Object.keys(cacheRef.current);
    setCache({});
    setError(null);
    void Promise.all(dirs.map((d) => loadDir(d, gen, true)));
  }, [loadDir]);
  const mutate = useCallback7(
    async (op, label) => {
      setMenu(null);
      try {
        const ok = await op();
        setActionError(ok ? null : label);
      } catch (err) {
        setActionError(`${label}: ${errText(err)}`);
      } finally {
        refreshTree();
      }
    },
    [refreshTree]
  );
  useEffect19(() => {
    if (!menu) return;
    const onDown = (e) => {
      const t = e.target;
      if (!t.closest(".files-ctx-menu")) setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);
  useEffect19(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const left = menuLeft(menu.x, r.width, window.innerWidth);
    const top = menuTop(menu.y, r.height, window.innerHeight, 8);
    if (left !== menu.x || top !== menu.y) setMenu((m) => m ? { ...m, x: left, y: top } : m);
  }, [menu]);
  const copyRow = useCallback7(
    async (path) => {
      const dir = parentPath(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const taken = new Set((cacheRef.current[dir] ?? []).map((e) => e.name));
      await mutate(
        () => api.fsCopy(root, path, joinPath(dir, copyName(name, taken))),
        "Could not copy"
      );
    },
    [root, mutate]
  );
  const renameRow = useCallback7(
    async (path, nextName) => {
      setRenaming(null);
      const name = nextName.trim();
      if (!name || name === path.slice(path.lastIndexOf("/") + 1)) return;
      await mutate(() => api.fsRename(root, path, joinPath(parentPath(path), name)), "Could not rename");
    },
    [root, mutate]
  );
  const deleteRow = useCallback7(
    async (path) => {
      await mutate(() => api.fsDelete(root, path), "Could not delete");
    },
    [root, mutate]
  );
  const moveRow = useCallback7(
    async (from, ontoDir) => {
      setDropDir(null);
      const dir = moveTarget(from, ontoDir);
      if (dir === null) return;
      const name = from.slice(from.lastIndexOf("/") + 1);
      await mutate(() => api.fsRename(root, from, joinPath(dir, name)), "Could not move");
      if (dir) {
        setExpanded((prev) => prev.has(dir) ? prev : toggleExpanded(prev, dir));
        void loadDir(dir, genRef.current, true);
      }
    },
    [root, mutate, loadDir]
  );
  const rows = flattenTree(cache, expanded);
  const rootLoaded = isLoaded(cache, "");
  const busy = loading.has("");
  return /* @__PURE__ */ jsxs23("div", { className: "files-panel", dir: "ltr", children: [
    /* @__PURE__ */ jsxs23("div", { className: "files-panel-head", children: [
      /* @__PURE__ */ jsx25("span", { className: "files-panel-title", children: "Files" }),
      /* @__PURE__ */ jsx25(
        "button",
        {
          className: "files-panel-action",
          title: "Refresh",
          "aria-label": "Refresh the file tree",
          disabled: !root,
          onClick: refreshTree,
          children: /* @__PURE__ */ jsx25("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.9", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx25("path", { d: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" }) })
        }
      )
    ] }),
    actionError ? /* @__PURE__ */ jsx25("div", { className: "files-panel-error", role: "alert", children: actionError }) : null,
    !root ? /* @__PURE__ */ jsx25("div", { className: "viewer-empty", children: "No workspace folder is open for this chat. Open one from the chat header to browse its files here." }) : error ? /* @__PURE__ */ jsx25("div", { className: "viewer-empty", children: error }) : rows.length === 0 ? /* @__PURE__ */ jsx25("div", { className: "viewer-empty", children: rootLoaded && !busy ? "This folder is empty." : "Reading the workspace\u2026" }) : /* @__PURE__ */ jsx25(
      "div",
      {
        className: "files-list",
        onDragOver: (e) => {
          if (!dragPath || moveTarget(dragPath, "") === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropDir("");
        },
        onDragLeave: (e) => {
          if (e.target === e.currentTarget) setDropDir((prev) => prev === "" ? null : prev);
        },
        onDrop: (e) => {
          if (!dragPath) return;
          e.preventDefault();
          const from = e.dataTransfer.getData("text/plain") || dragPath;
          void moveRow(from, "");
          setDragPath(null);
        },
        children: rows.map((row) => {
          const isDir = row.kind === "dir";
          const indent = { paddingLeft: 6 + row.depth * 13 };
          if (renaming === row.path) {
            return /* @__PURE__ */ jsxs23("div", { className: "files-row files-row-renaming", style: indent, children: [
              /* @__PURE__ */ jsx25("span", { className: "files-row-caret" }),
              /* @__PURE__ */ jsx25("span", { className: "files-row-icon", children: isDir ? /* @__PURE__ */ jsx25(FolderIcon, {}) : /* @__PURE__ */ jsx25(FileIcon, { path: row.path, size: 16 }) }),
              /* @__PURE__ */ jsx25(
                ChatRenameInput,
                {
                  initialValue: row.name,
                  className: "files-rename-input",
                  ariaLabel: `Rename ${row.name}`,
                  onCommit: (value) => void renameRow(row.path, value),
                  onCancel: () => setRenaming(null)
                }
              )
            ] }, row.path);
          }
          return /* @__PURE__ */ jsxs23(
            "button",
            {
              className: "files-row" + (isDir ? " files-row-dir" : "") + (dropDir === row.path ? " files-row-drop" : "") + (dragPath === row.path ? " files-row-dragging" : ""),
              style: indent,
              title: row.path,
              "aria-expanded": isDir ? row.expanded : void 0,
              draggable: true,
              onContextMenu: (e) => {
                e.preventDefault();
                setMenu({
                  path: row.path,
                  kind: row.kind,
                  x: e.clientX,
                  y: e.clientY,
                  confirming: false
                });
              },
              onClick: () => {
                if (isDir) {
                  toggleDir(row.path);
                  return;
                }
                useViewerTabs.getState().openFile(row.path, void 0, root, ownerChatId);
              },
              onDragStart: (e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", row.path);
                setDragPath(row.path);
                setMenu(null);
              },
              onDragEnd: () => {
                setDragPath(null);
                setDropDir(null);
              },
              onDragOver: (e) => {
                if (!isDir || !dragPath) return;
                if (moveTarget(dragPath, row.path) === null) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setDropDir(row.path);
              },
              onDragLeave: () => {
                setDropDir((prev) => prev === row.path ? null : prev);
              },
              onDrop: (e) => {
                e.preventDefault();
                e.stopPropagation();
                const from = e.dataTransfer.getData("text/plain") || dragPath || "";
                if (from) void moveRow(from, row.path);
                setDragPath(null);
              },
              children: [
                /* @__PURE__ */ jsx25("span", { className: "files-row-caret", children: isDir && row.expandable ? /* @__PURE__ */ jsx25(TreeChevron, { open: row.expanded }) : null }),
                /* @__PURE__ */ jsx25("span", { className: "files-row-icon", children: isDir ? /* @__PURE__ */ jsx25(FolderIcon, {}) : /* @__PURE__ */ jsx25(FileIcon, { path: row.path, size: 16 }) }),
                /* @__PURE__ */ jsx25("span", { className: "files-row-name", children: row.name })
              ]
            },
            row.path
          );
        })
      }
    ),
    menu ? createPortal7(
      /* @__PURE__ */ jsx25(
        "div",
        {
          ref: menuRef,
          className: "ws-menu files-ctx-menu",
          role: "menu",
          style: { position: "fixed", top: menu.y, left: menu.x },
          onMouseDown: (e) => e.stopPropagation(),
          onContextMenu: (e) => e.preventDefault(),
          children: menu.confirming ? /* @__PURE__ */ jsxs23(Fragment10, { children: [
            /* @__PURE__ */ jsxs23("div", { className: "files-ctx-confirm", children: [
              "Delete ",
              menu.kind === "dir" ? "this folder" : "this file",
              "?",
              /* @__PURE__ */ jsx25("span", { className: "files-ctx-path", children: menu.path })
            ] }),
            /* @__PURE__ */ jsxs23("div", { className: "files-ctx-actions", children: [
              /* @__PURE__ */ jsx25(
                "button",
                {
                  type: "button",
                  className: "ws-menu-btn danger",
                  onClick: () => void deleteRow(menu.path),
                  children: "Delete"
                }
              ),
              /* @__PURE__ */ jsx25("button", { type: "button", className: "ws-menu-btn", onClick: () => setMenu(null), children: "Cancel" })
            ] })
          ] }) : /* @__PURE__ */ jsxs23(Fragment10, { children: [
            /* @__PURE__ */ jsxs23(
              "button",
              {
                type: "button",
                className: "ws-menu-btn",
                role: "menuitem",
                onClick: () => void copyRow(menu.path),
                children: [
                  /* @__PURE__ */ jsx25(CopyIcon, {}),
                  "Copy"
                ]
              }
            ),
            /* @__PURE__ */ jsxs23(
              "button",
              {
                type: "button",
                className: "ws-menu-btn",
                role: "menuitem",
                onClick: () => {
                  setRenaming(menu.path);
                  setMenu(null);
                },
                children: [
                  /* @__PURE__ */ jsx25(RenameIcon, {}),
                  "Rename"
                ]
              }
            ),
            /* @__PURE__ */ jsxs23(
              "button",
              {
                type: "button",
                className: "ws-menu-btn danger",
                role: "menuitem",
                onClick: () => setMenu((m) => m ? { ...m, confirming: true } : m),
                children: [
                  /* @__PURE__ */ jsx25(TrashIcon, {}),
                  "Delete"
                ]
              }
            )
          ] })
        }
      ),
      document.body
    ) : null
  ] });
}
var MENU_ICON;
var init_FilesPanel = __esm({
  "src/components/FilesPanel.tsx"() {
    "use strict";
    init_store();
    init_fs();
    init_MacAppIcons();
    init_FileIcon();
    init_viewerTabs();
    init_ChatRenameInput();
    init_tabBar();
    init_fileTree();
    MENU_ICON = {
      width: 13,
      height: 13,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.9,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true
    };
  }
});

// src/components/ExplorePanel.tsx
var ExplorePanel_exports = {};
__export(ExplorePanel_exports, {
  ExplorePanel: () => ExplorePanel
});
import { useState as useState22 } from "react";
import { jsx as jsx26, jsxs as jsxs24 } from "react/jsx-runtime";
function argsText(activity) {
  const args = activity.args ?? {};
  return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
}
function callDetail(activity) {
  const args = activity.args ?? {};
  const pick = (k) => typeof args[k] === "string" ? args[k] : "";
  return (pick("path") || pick("filePath") || pick("command") || pick("pattern") || pick("query") || pick("description") || "").split("\n")[0];
}
function callBody(activity) {
  return toolCallBody(activity);
}
function ExploreCallRow({ activity }) {
  const [open, setOpen] = useState22(false);
  const detail = callDetail(activity);
  const body = callBody(activity);
  const args = argsText(activity);
  const hasBody = Boolean(body || args);
  return /* @__PURE__ */ jsxs24("div", { className: `explore-call ${activity.status}`, children: [
    /* @__PURE__ */ jsxs24(
      "button",
      {
        type: "button",
        className: "explore-call-head",
        disabled: !hasBody,
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        children: [
          /* @__PURE__ */ jsx26("span", { className: `explore-call-dot ${activity.status}`, "aria-hidden": "true" }),
          /* @__PURE__ */ jsx26("span", { className: "explore-call-tool", children: activity.tool }),
          detail && /* @__PURE__ */ jsx26("span", { className: "explore-call-detail", dir: "auto", title: detail, children: detail }),
          /* @__PURE__ */ jsx26("span", { className: "explore-call-chev", "aria-hidden": "true", children: hasBody ? open ? "\u25BE" : "\u25B8" : "" })
        ]
      }
    ),
    open && hasBody && /* @__PURE__ */ jsxs24("div", { className: "explore-call-body", children: [
      args && /* @__PURE__ */ jsx26("pre", { className: "trace-expand-pre", dir: "auto", children: args }),
      body && /* @__PURE__ */ jsx26("pre", { className: "trace-expand-pre explore-call-out", dir: "auto", children: body })
    ] })
  ] });
}
function ExplorePanel({
  chatId,
  messageId,
  index
}) {
  const activity = useStore((s) => {
    const chat = s.chats.find((c2) => c2.id === chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    return msg?.toolActivity?.[index] ?? null;
  });
  if (!activity) {
    return /* @__PURE__ */ jsx26("div", { className: "viewer-empty", children: "This explore run is no longer in memory (e.g. after a restart)." });
  }
  const counts = exploreToolCounts(activity);
  const total = counts.reduce((n, c2) => n + c2.count, 0);
  const kids = activity.children ?? [];
  return /* @__PURE__ */ jsxs24("div", { className: "explore-panel", children: [
    /* @__PURE__ */ jsxs24("div", { className: "explore-panel-head", children: [
      /* @__PURE__ */ jsx26(
        "span",
        {
          className: `explore-card-status ${activity.status}`,
          role: "img",
          "aria-label": `Explore run: ${activity.status}`,
          children: /* @__PURE__ */ jsx26(StatusIcon, { status: activity.status })
        }
      ),
      /* @__PURE__ */ jsx26("span", { className: "trace-pill trace-pill-sub", children: "Explore" }),
      /* @__PURE__ */ jsx26("span", { className: "explore-panel-title", dir: "auto", children: exploreTitle(activity) }),
      total > 0 && /* @__PURE__ */ jsx26("span", { className: "explore-panel-count", children: `${total} tool calls` })
    ] }),
    counts.length > 0 && /* @__PURE__ */ jsx26("div", { className: "explore-tool-chips", children: counts.map((c2) => (
      // Keyed by LABEL (`exploreToolCounts` tallies by label), not the raw
      // tool name: `read` and an alias like `read_client` share one label,
      // so a name-based key emitted two identical chips ("Read File ×4"
      // next to "read_client ×2") instead of one merged tally.
      /* @__PURE__ */ jsxs24("span", { className: "explore-tool-chip", children: [
        /* @__PURE__ */ jsx26("span", { className: "explore-tool-name", children: c2.label }),
        /* @__PURE__ */ jsx26("span", { className: "explore-tool-n", children: `\xD7${c2.count}` })
      ] }, c2.label)
    )) }),
    activity.status === "running" && /* @__PURE__ */ jsx26("div", { className: "explore-card-progress", "aria-hidden": "true" }),
    activity.status === "running" && /* @__PURE__ */ jsxs24("div", { className: "explore-panel-running", children: [
      /* @__PURE__ */ jsx26("span", { className: "spinner" }),
      " Working\u2026"
    ] }),
    kids.length === 0 ? /* @__PURE__ */ jsx26("div", { className: "viewer-empty", children: "No tool calls recorded for this run yet." }) : /* @__PURE__ */ jsx26("div", { className: "explore-call-list", children: kids.map((call, i) => /* @__PURE__ */ jsx26(ExploreCallRow, { activity: call }, call.callId ?? `${call.tool}-${i}`)) })
  ] });
}
var init_ExplorePanel = __esm({
  "src/components/ExplorePanel.tsx"() {
    "use strict";
    init_store();
    init_toolActivity();
    init_ExploreCard();
    init_ToolCallView();
  }
});

// src/lib/artifacts.ts
async function getArtifact(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString();
    const res = await fetch(`${url}/artifacts/get?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` };
    if (!data.content) return { error: `artifact not found: ${id}` };
    return data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function deleteArtifact(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString();
    const res = await fetch(`${url}/artifacts?${qs}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: data.detail || `delete failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function listArtifacts(chatId) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = chatId ? `?${new URLSearchParams({ chat_id: chatId }).toString()}` : "";
    const res = await fetch(`${url}/artifacts/list${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `list failed (${res.status})` };
    return (data.artifacts ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      version: a.version,
      updatedAt: a.updated_at ?? 0,
      chatId: a.chat_id ?? ""
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
var init_artifacts = __esm({
  "src/lib/artifacts.ts"() {
    "use strict";
    init_api();
  }
});

// src/components/ArtifactsPanel.tsx
var ArtifactsPanel_exports = {};
__export(ArtifactsPanel_exports, {
  ArtifactsPanel: () => ArtifactsPanel
});
import { useCallback as useCallback8, useEffect as useEffect20, useMemo as useMemo11, useState as useState23 } from "react";
import { Fragment as Fragment11, jsx as jsx27, jsxs as jsxs25 } from "react/jsx-runtime";
function ArtifactsPanel() {
  const [items, setItems] = useState23(null);
  const [error, setError] = useState23(null);
  const [query, setQuery] = useState23("");
  const [confirming, setConfirming] = useState23(null);
  const [busy, setBusy] = useState23(null);
  const [gen, setGen] = useState23(0);
  const load = useCallback8(async () => {
    setError(null);
    const out = await listArtifacts();
    if ("error" in out) {
      setError(out.error);
      setItems([]);
      return;
    }
    setItems(out);
  }, []);
  useEffect20(() => {
    void load();
  }, [load, gen]);
  const shown = useMemo11(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.title} ${it.kind ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);
  const open = async (item) => {
    const doc = await getArtifact(item.chatId, item.id);
    if ("error" in doc) {
      setError(doc.error);
      return;
    }
    useViewerTabs.getState().openArtifact(item.chatId, {
      id: doc.id,
      title: doc.title,
      kind: doc.kind ?? "html",
      body: doc.content,
      version: doc.version
    });
  };
  const remove = async (item) => {
    const key = rowKey(item);
    setBusy(key);
    const out = await deleteArtifact(item.chatId, item.id);
    setBusy(null);
    setConfirming(null);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    setError(null);
    useViewerTabs.getState().closeViewer(`artifact:${item.chatId}:${item.id}`);
    setItems((cur) => (cur ?? []).filter((x) => rowKey(x) !== key));
  };
  const searchable = items !== null && items.length > 0;
  return /* @__PURE__ */ jsxs25("div", { className: "artifacts-panel", children: [
    /* @__PURE__ */ jsxs25("div", { className: "artifacts-panel-head", children: [
      /* @__PURE__ */ jsx27("span", { className: "artifacts-panel-title", children: "Artifacts" }),
      /* @__PURE__ */ jsx27("span", { className: "artifacts-panel-count", children: items === null ? "" : `${items.length}` }),
      /* @__PURE__ */ jsx27(
        "button",
        {
          type: "button",
          className: "artifacts-refresh",
          title: "Refresh the artifact list",
          "aria-label": "Refresh the artifact list",
          onClick: () => setGen((g) => g + 1),
          children: /* @__PURE__ */ jsxs25("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
            /* @__PURE__ */ jsx27("path", { d: "M20 11a8 8 0 1 0-2.3 5.7" }),
            /* @__PURE__ */ jsx27("path", { d: "M20 5v6h-6" })
          ] })
        }
      )
    ] }),
    searchable && /* @__PURE__ */ jsx27("div", { className: "review-search-row", children: /* @__PURE__ */ jsxs25("label", { className: "review-search", dir: "ltr", children: [
      /* @__PURE__ */ jsx27("span", { "aria-hidden": "true", children: "\u{1F50D}" }),
      /* @__PURE__ */ jsx27(
        "input",
        {
          className: "review-search-input",
          type: "search",
          placeholder: "Search artifacts\u2026",
          value: query,
          onChange: (e) => setQuery(e.target.value)
        }
      ),
      query.trim() ? /* @__PURE__ */ jsxs25(Fragment11, { children: [
        /* @__PURE__ */ jsxs25("span", { className: "review-search-count", children: [
          shown?.length ?? 0,
          "/",
          items?.length ?? 0
        ] }),
        /* @__PURE__ */ jsx27(
          "button",
          {
            type: "button",
            className: "review-search-btn",
            title: "Clear search",
            "aria-label": "Clear search",
            onClick: () => setQuery(""),
            children: "\u2715"
          }
        )
      ] }) : null
    ] }) }),
    error && /* @__PURE__ */ jsx27("div", { className: "artifacts-error", role: "alert", children: error }),
    items === null ? /* @__PURE__ */ jsx27("div", { className: "artifacts-loading", children: "Loading artifacts\u2026" }) : items.length === 0 ? error ? null : /* @__PURE__ */ jsxs25("div", { className: "viewer-empty", children: [
      "No artifacts yet. Build one from the chat with",
      " ",
      /* @__PURE__ */ jsx27("code", { children: "/artifact <description>" }),
      "."
    ] }) : shown !== null && shown.length === 0 ? /* @__PURE__ */ jsxs25("div", { className: "viewer-empty", children: [
      "No artifact matches \u201C",
      query.trim(),
      "\u201D."
    ] }) : /* @__PURE__ */ jsx27("div", { className: "artifacts-list", children: (shown ?? []).map((it) => /* @__PURE__ */ jsxs25("div", { className: "artifacts-row", children: [
      /* @__PURE__ */ jsxs25(
        "button",
        {
          type: "button",
          className: "artifacts-open",
          title: `Open ${it.title}`,
          onClick: () => void open(it),
          children: [
            /* @__PURE__ */ jsx27("span", { className: "artifacts-icon", "aria-hidden": "true", children: it.kind === "md" ? "\xB6" : "</>" }),
            /* @__PURE__ */ jsx27("span", { className: "artifacts-title", children: it.title }),
            /* @__PURE__ */ jsxs25("span", { className: "artifacts-meta", children: [
              it.kind ?? "html",
              it.version ? ` \xB7 v${it.version}` : ""
            ] }),
            /* @__PURE__ */ jsx27("span", { className: "artifacts-time", children: ago(it.updatedAt) })
          ]
        }
      ),
      confirming === rowKey(it) ? /* @__PURE__ */ jsx27(
        "button",
        {
          type: "button",
          className: "artifacts-delete danger active",
          title: `Delete ${it.title} for good`,
          "aria-label": `Confirm deleting ${it.title}`,
          disabled: busy === rowKey(it),
          onClick: () => void remove(it),
          children: "Delete"
        }
      ) : /* @__PURE__ */ jsx27(
        "button",
        {
          type: "button",
          className: "artifacts-delete",
          title: `Delete ${it.title}`,
          "aria-label": `Delete ${it.title}`,
          onClick: () => setConfirming(rowKey(it)),
          children: /* @__PURE__ */ jsxs25("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
            /* @__PURE__ */ jsx27("path", { d: "M4 7h16" }),
            /* @__PURE__ */ jsx27("path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }),
            /* @__PURE__ */ jsx27("path", { d: "M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" })
          ] })
        }
      )
    ] }, rowKey(it))) })
  ] });
}
function rowKey(it) {
  return `${it.chatId}:${it.id}`;
}
function ago(updatedAt) {
  if (!updatedAt) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1e3) - updatedAt);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
var init_ArtifactsPanel = __esm({
  "src/components/ArtifactsPanel.tsx"() {
    "use strict";
    init_viewerTabs();
    init_artifacts();
  }
});

// src/components/ArtifactPanel.tsx
var ArtifactPanel_exports = {};
__export(ArtifactPanel_exports, {
  ArtifactPanel: () => ArtifactPanel,
  artifactSourceLines: () => artifactSourceLines
});
import { useEffect as useEffect21, useState as useState24 } from "react";
import ReactMarkdown6 from "react-markdown";
import remarkGfm6 from "remark-gfm";
import { jsx as jsx28, jsxs as jsxs26 } from "react/jsx-runtime";
function ArtifactPanel({
  title,
  kind,
  body,
  chatId,
  id
}) {
  const missing = !body.trim();
  const [fetched, setFetched] = useState24("");
  const [error, setError] = useState24("");
  useEffect21(() => {
    if (!missing) {
      setFetched("");
      setError("");
      return;
    }
    if (!chatId || !id) return;
    let cancelled = false;
    void getArtifact(chatId, id).then((out) => {
      if (cancelled) return;
      if ("error" in out) setError(out.error);
      else setFetched(out.content);
    });
    return () => {
      cancelled = true;
    };
  }, [missing, chatId, id]);
  const doc = body.trim() ? body : fetched;
  if (!doc.trim()) {
    return /* @__PURE__ */ jsxs26("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ jsx28("div", { className: "artifact-panel-head", children: /* @__PURE__ */ jsx28("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ jsx28("div", { className: "viewer-empty", children: error ? `Could not load this artifact's content: ${error}` : missing && chatId && id ? "Loading artifact\u2026" : "This artifact's content is no longer in memory \u2014 reopen it from its card in the chat." })
    ] });
  }
  if (kind === "md") {
    return /* @__PURE__ */ jsxs26("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ jsx28("div", { className: "artifact-panel-head", children: /* @__PURE__ */ jsx28("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ jsx28("div", { className: "artifact-panel-md markdown-body", dir: "auto", children: /* @__PURE__ */ jsx28(ReactMarkdown6, { remarkPlugins: [remarkGfm6], children: doc }) })
    ] });
  }
  return /* @__PURE__ */ jsxs26("div", { className: "artifact-panel", children: [
    /* @__PURE__ */ jsx28("div", { className: "artifact-panel-head", children: /* @__PURE__ */ jsx28("span", { className: "artifact-panel-title", children: title }) }),
    /* @__PURE__ */ jsx28(
      "iframe",
      {
        className: "artifact-panel-frame",
        title,
        sandbox: "allow-scripts",
        srcDoc: doc
      }
    )
  ] });
}
function artifactSourceLines(body, lang) {
  return getHighlightedLines(body, lang);
}
var init_ArtifactPanel = __esm({
  "src/components/ArtifactPanel.tsx"() {
    "use strict";
    init_highlight();
    init_artifacts();
  }
});

// src/components/ViewerContent.tsx
import { Suspense as Suspense2, lazy as lazy2 } from "react";
import { jsx as jsx29 } from "react/jsx-runtime";
var ReviewPanel2, TracePanel2, ScheduleInboxDocked2, PlanPanel2, BrowserPanel2, FileViewerPanel2, TextViewerPanel2, FilesPanel2, ExplorePanel2, ArtifactsPanel2, ArtifactPanel2;
var init_ViewerContent = __esm({
  "src/components/ViewerContent.tsx"() {
    "use strict";
    init_viewerTabs();
    init_store();
    init_ViewerPages();
    ReviewPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_ReviewPanel(), ReviewPanel_exports)).then((m) => ({ default: m.ReviewPanel }))
    );
    TracePanel2 = lazy2(() => Promise.resolve().then(() => (init_TracePanel(), TracePanel_exports)).then((m) => ({ default: m.TracePanel })));
    ScheduleInboxDocked2 = lazy2(
      () => Promise.resolve().then(() => (init_ScheduleInbox(), ScheduleInbox_exports)).then((m) => ({ default: m.ScheduleInboxDocked }))
    );
    PlanPanel2 = lazy2(() => Promise.resolve().then(() => (init_PlanPanel(), PlanPanel_exports)).then((m) => ({ default: m.PlanPanel })));
    BrowserPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_BrowserPanel(), BrowserPanel_exports)).then((m) => ({ default: m.BrowserPanel }))
    );
    FileViewerPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_FileViewerPanel(), FileViewerPanel_exports)).then((m) => ({ default: m.FileViewerPanel }))
    );
    TextViewerPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_TextViewerPanel(), TextViewerPanel_exports)).then((m) => ({ default: m.TextViewerPanel }))
    );
    FilesPanel2 = lazy2(() => Promise.resolve().then(() => (init_FilesPanel(), FilesPanel_exports)).then((m) => ({ default: m.FilesPanel })));
    ExplorePanel2 = lazy2(
      () => Promise.resolve().then(() => (init_ExplorePanel(), ExplorePanel_exports)).then((m) => ({ default: m.ExplorePanel }))
    );
    ArtifactsPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_ArtifactsPanel(), ArtifactsPanel_exports)).then((m) => ({ default: m.ArtifactsPanel }))
    );
    ArtifactPanel2 = lazy2(
      () => Promise.resolve().then(() => (init_ArtifactPanel(), ArtifactPanel_exports)).then((m) => ({ default: m.ArtifactPanel }))
    );
  }
});

// src/components/ViewerWindows.tsx
import { Suspense as Suspense3, lazy as lazy3, useCallback as useCallback9, useEffect as useEffect22, useRef as useRef16, useState as useState25 } from "react";
import { jsx as jsx30, jsxs as jsxs27 } from "react/jsx-runtime";
function setViewerDragData(e, tabId) {
  try {
    e.dataTransfer.setData(VIEWER_DRAG_MIME, tabId);
    e.dataTransfer.setData("text/plain", tabId);
    e.dataTransfer.effectAllowed = "move";
  } catch {
  }
}
var ReviewPanel3, TracePanel3, ScheduleInboxDocked3, PlanPanel3, BrowserPanel3, FileViewerPanel3, TextViewerPanel3, ArtifactsPanel3, ArtifactPanel3, FilesPanel3, ExplorePanel3, VIEWER_DRAG_MIME;
var init_ViewerWindows = __esm({
  "src/components/ViewerWindows.tsx"() {
    "use strict";
    init_store();
    init_viewerTabs();
    init_chatTree();
    init_ViewerPages();
    init_ViewerContent();
    ReviewPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_ReviewPanel(), ReviewPanel_exports)).then((m) => ({ default: m.ReviewPanel }))
    );
    TracePanel3 = lazy3(() => Promise.resolve().then(() => (init_TracePanel(), TracePanel_exports)).then((m) => ({ default: m.TracePanel })));
    ScheduleInboxDocked3 = lazy3(
      () => Promise.resolve().then(() => (init_ScheduleInbox(), ScheduleInbox_exports)).then((m) => ({ default: m.ScheduleInboxDocked }))
    );
    PlanPanel3 = lazy3(() => Promise.resolve().then(() => (init_PlanPanel(), PlanPanel_exports)).then((m) => ({ default: m.PlanPanel })));
    BrowserPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_BrowserPanel(), BrowserPanel_exports)).then((m) => ({ default: m.BrowserPanel }))
    );
    FileViewerPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_FileViewerPanel(), FileViewerPanel_exports)).then((m) => ({ default: m.FileViewerPanel }))
    );
    TextViewerPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_TextViewerPanel(), TextViewerPanel_exports)).then((m) => ({ default: m.TextViewerPanel }))
    );
    ArtifactsPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_ArtifactsPanel(), ArtifactsPanel_exports)).then((m) => ({ default: m.ArtifactsPanel }))
    );
    ArtifactPanel3 = lazy3(
      () => Promise.resolve().then(() => (init_ArtifactPanel(), ArtifactPanel_exports)).then((m) => ({ default: m.ArtifactPanel }))
    );
    FilesPanel3 = lazy3(() => Promise.resolve().then(() => (init_FilesPanel(), FilesPanel_exports)).then((m) => ({ default: m.FilesPanel })));
    ExplorePanel3 = lazy3(
      () => Promise.resolve().then(() => (init_ExplorePanel(), ExplorePanel_exports)).then((m) => ({ default: m.ExplorePanel }))
    );
    VIEWER_DRAG_MIME = "application/x-coder-viewer-id";
  }
});

// src/components/TabListMenu.tsx
import { useEffect as useEffect23, useRef as useRef17, useState as useState26 } from "react";
import { createPortal as createPortal8 } from "react-dom";
import { jsx as jsx31, jsxs as jsxs28 } from "react/jsx-runtime";
function TabListButton({
  sections,
  label,
  footer,
  placement = "bottom",
  menuWidth
}) {
  const [open, setOpen] = useState26(false);
  const [pos, setPos] = useState26(null);
  const [query, setQuery] = useState26("");
  const wrapRef = useRef17(null);
  const inputRef = useRef17(null);
  const menuRef = useRef17(null);
  useEffect23(() => {
    if (!open) return;
    const onDocClick = (e) => {
      const t = e.target;
      if (!t.closest(".tab-list-wrap") && !t.closest(".tab-list-menu")) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect23(() => {
    if (!open || !pos) return;
    const h = menuRef.current?.offsetHeight;
    if (!h) return;
    const top = menuTop(pos.top, h, window.innerHeight);
    if (top !== pos.top) setPos({ ...pos, top });
  }, [open, pos]);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      setPos({ top: r.bottom + 6, left: menuLeft(r.left, menuWidth ?? MENU_WIDTH, window.innerWidth, placement) });
    }
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const q = query.trim().toLowerCase();
  const visible = sections.map((s) => ({
    ...s,
    entries: q ? s.entries.filter((e) => e.title.toLowerCase().includes(q)) : s.entries
  })).filter((s) => s.entries.length > 0);
  return /* @__PURE__ */ jsxs28("span", { className: "tab-list-wrap", ref: wrapRef, children: [
    /* @__PURE__ */ jsx31(
      "button",
      {
        type: "button",
        className: "tab-list-btn",
        title: label,
        "aria-label": label,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: toggle,
        children: /* @__PURE__ */ jsx31(
          "svg",
          {
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            children: /* @__PURE__ */ jsx31("path", { d: "M6 9.5l6 6 6-6" })
          }
        )
      }
    ),
    open && pos && createPortal8(
      /* @__PURE__ */ jsxs28(
        "div",
        {
          ref: menuRef,
          className: `tab-list-menu open-${placement}`,
          role: "menu",
          style: { position: "fixed", top: pos.top, left: pos.left },
          onMouseDown: (e) => e.stopPropagation(),
          children: [
            /* @__PURE__ */ jsxs28("label", { className: "tab-list-search", children: [
              /* @__PURE__ */ jsxs28(
                "svg",
                {
                  width: "13",
                  height: "13",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  "aria-hidden": "true",
                  children: [
                    /* @__PURE__ */ jsx31("circle", { cx: "11", cy: "11", r: "7" }),
                    /* @__PURE__ */ jsx31("path", { d: "m20 20-3.5-3.5" })
                  ]
                }
              ),
              /* @__PURE__ */ jsx31(
                "input",
                {
                  ref: inputRef,
                  type: "text",
                  placeholder: "Search tabs\u2026",
                  value: query,
                  onChange: (e) => setQuery(e.target.value)
                }
              )
            ] }),
            visible.length === 0 && /* @__PURE__ */ jsx31("div", { className: "tab-list-empty", children: "No tabs match." }),
            visible.map((s) => /* @__PURE__ */ jsxs28("div", { className: "tab-list-section", children: [
              /* @__PURE__ */ jsx31("div", { className: "tab-list-section-label", children: s.label }),
              s.entries.map((e) => /* @__PURE__ */ jsxs28(
                "div",
                {
                  className: `tab-list-item${e.active ? " active" : ""}`,
                  children: [
                    /* @__PURE__ */ jsxs28(
                      "button",
                      {
                        type: "button",
                        className: "tab-list-open",
                        role: "menuitem",
                        onClick: () => {
                          setOpen(false);
                          e.onOpen();
                        },
                        children: [
                          e.icon && /* @__PURE__ */ jsx31("span", { className: "tab-list-icon", children: e.icon }),
                          /* @__PURE__ */ jsx31("span", { className: "tab-list-title", children: e.title })
                        ]
                      }
                    ),
                    e.age !== void 0 && /* @__PURE__ */ jsx31("span", { className: "tab-list-age", children: fmtAgo(e.age) }),
                    e.onClose && /* @__PURE__ */ jsx31(
                      "button",
                      {
                        type: "button",
                        className: "tab-list-close",
                        title: "Close tab",
                        "aria-label": `Close ${e.title}`,
                        onClick: (ev) => {
                          ev.stopPropagation();
                          e.onClose?.();
                        },
                        children: /* @__PURE__ */ jsx31(
                          "svg",
                          {
                            width: "10",
                            height: "10",
                            viewBox: "0 0 12 12",
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: "1.8",
                            strokeLinecap: "round",
                            "aria-hidden": "true",
                            children: /* @__PURE__ */ jsx31("path", { d: "M2.5 2.5l7 7M9.5 2.5l-7 7" })
                          }
                        )
                      }
                    )
                  ]
                },
                e.key
              ))
            ] }, s.label)),
            footer && /* @__PURE__ */ jsx31(
              "button",
              {
                type: "button",
                className: "tab-list-footer",
                title: footer.title,
                disabled: footer.disabled,
                onClick: () => {
                  setOpen(false);
                  footer.onPress();
                },
                children: footer.label
              }
            )
          ]
        }
      ),
      document.body
    )
  ] });
}
var MENU_WIDTH;
var init_TabListMenu = __esm({
  "src/components/TabListMenu.tsx"() {
    "use strict";
    init_tabBar();
    init_time();
    MENU_WIDTH = 410;
  }
});

// src/components/ViewerTabBar.tsx
var ViewerTabBar_exports = {};
__export(ViewerTabBar_exports, {
  ViewerArtifactsButton: () => ViewerArtifactsButton,
  ViewerBrowserButton: () => ViewerBrowserButton,
  ViewerFilesButton: () => ViewerFilesButton,
  ViewerInboxButton: () => ViewerInboxButton,
  ViewerPaneFullscreenButton: () => ViewerPaneFullscreenButton,
  ViewerReviewButton: () => ViewerReviewButton,
  ViewerScheduleButton: () => ViewerScheduleButton,
  ViewerTabBar: () => ViewerTabBar,
  ViewerTabListButton: () => ViewerTabListButton,
  ViewerTabListInline: () => ViewerTabListInline,
  ViewerTerminalButton: () => ViewerTerminalButton,
  ViewerTodosButton: () => ViewerTodosButton,
  ViewerTraceButton: () => ViewerTraceButton,
  buildViewerTabListSections: () => buildViewerTabListSections,
  toggleTerminalInSidePane: () => toggleTerminalInSidePane,
  viewerTabIcon: () => viewerTabIcon
});
import { useEffect as useEffect24, useRef as useRef18, useState as useState27 } from "react";
import { jsx as jsx32, jsxs as jsxs29 } from "react/jsx-runtime";
function ReviewIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("circle", { cx: "6", cy: "6", r: "2.4" }),
    /* @__PURE__ */ jsx32("circle", { cx: "6", cy: "18", r: "2.4" }),
    /* @__PURE__ */ jsx32("circle", { cx: "18", cy: "8", r: "2.4" }),
    /* @__PURE__ */ jsx32("path", { d: "M6 8.4v7.2M18 10.4c0 4.2-4.5 3.6-8.6 3.6" })
  ] });
}
function TraceIcon() {
  return /* @__PURE__ */ jsx32("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx32("path", { d: "M4 6h16M4 12h10M4 18h7" }) });
}
function InboxIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }),
    /* @__PURE__ */ jsx32("path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" })
  ] });
}
function PlanIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }),
    /* @__PURE__ */ jsx32("path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }),
    /* @__PURE__ */ jsx32("path", { d: "M9 12h6M9 16h4" })
  ] });
}
function BrowserIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx32("path", { d: "M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" })
  ] });
}
function ScheduleIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx32("path", { d: "M12 7v5.2l3.4 2" })
  ] });
}
function ExploreIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("circle", { cx: "11", cy: "11", r: "7" }),
    /* @__PURE__ */ jsx32("path", { d: "m20 20-3.6-3.6" })
  ] });
}
function ArtifactsIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("path", { d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" }),
    /* @__PURE__ */ jsx32("path", { d: "M3.3 7 12 12l8.7-5" }),
    /* @__PURE__ */ jsx32("path", { d: "M12 22V12" })
  ] });
}
function ArtifactIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2.5" }),
    /* @__PURE__ */ jsx32("path", { d: "M3 9h18" }),
    /* @__PURE__ */ jsx32("path", { d: "m8 13 2 2-2 2" }),
    /* @__PURE__ */ jsx32("path", { d: "M13 17h3" })
  ] });
}
function TerminalPaneIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2.5" }),
    /* @__PURE__ */ jsx32("path", { d: "M7 9.4l2.7 2.6L7 14.6" }),
    /* @__PURE__ */ jsx32("path", { d: "M12.4 14.6h4.6" })
  ] });
}
function CloseIcon() {
  return /* @__PURE__ */ jsx32("svg", { width: "10", height: "10", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx32("path", { d: "M2.5 2.5l7 7M9.5 2.5l-7 7" }) });
}
function viewerTabIcon(t) {
  if (t.kind === "file") {
    return /* @__PURE__ */ jsx32(FileIcon, { path: t.filePath ?? t.title, size: 20 });
  }
  const Icon = KIND_ICON[t.kind];
  return /* @__PURE__ */ jsx32(Icon, {});
}
function buildViewerTabListSections(tabs, closed, activeId, activeChatId) {
  return [
    {
      label: "Open tabs",
      entries: visibleTabs(tabs, activeChatId).map((t) => ({
        key: t.id,
        title: viewerTabTitle(t),
        icon: viewerTabIcon(t),
        age: t.createdAt,
        active: t.id === activeId,
        onOpen: () => useViewerTabs.getState().setActiveViewer(t.id),
        onClose: () => useViewerTabs.getState().closeViewer(t.id)
      }))
    },
    {
      label: "Recently closed tabs",
      entries: closed.map((c2) => ({
        key: `closed-${c2.tab.id}`,
        title: viewerTabTitle(c2.tab),
        icon: viewerTabIcon(c2.tab),
        age: c2.closedAt,
        onOpen: () => useViewerTabs.getState().reopenClosedViewerTab(c2.tab.id)
      }))
    }
  ];
}
function ViewerTabListInline({ sections }) {
  const visible = sections.filter((s) => s.entries.length > 0);
  if (visible.length === 0) return null;
  return /* @__PURE__ */ jsx32("div", { className: "viewer-tablist-inline", children: visible.map((s) => /* @__PURE__ */ jsxs29("div", { className: "tab-list-section", children: [
    /* @__PURE__ */ jsx32("div", { className: "tab-list-section-label", children: s.label }),
    s.entries.map((e) => /* @__PURE__ */ jsxs29("div", { className: `tab-list-item${e.active ? " active" : ""}`, children: [
      /* @__PURE__ */ jsxs29("button", { type: "button", className: "tab-list-open", onClick: e.onOpen, children: [
        e.icon && /* @__PURE__ */ jsx32("span", { className: "tab-list-icon", children: e.icon }),
        /* @__PURE__ */ jsx32("span", { className: "tab-list-title", children: e.title })
      ] }),
      e.age !== void 0 && /* @__PURE__ */ jsx32("span", { className: "tab-list-age", children: fmtAgo(e.age) }),
      e.onClose && /* @__PURE__ */ jsx32(
        "button",
        {
          type: "button",
          className: "tab-list-close",
          title: "Close tab",
          "aria-label": `Close ${e.title}`,
          onClick: (ev) => {
            ev.stopPropagation();
            e.onClose?.();
          },
          children: /* @__PURE__ */ jsx32("svg", { width: "10", height: "10", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx32("path", { d: "M2.5 2.5l7 7M9.5 2.5l-7 7" }) })
        }
      )
    ] }, e.key))
  ] }, s.label)) });
}
function ViewerTabListButton() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const closed = useViewerTabs((s) => s.closedTabs);
  const activeChatId = useStore((s) => s.activeChatId);
  const sections = buildViewerTabListSections(tabs, closed, activeId, activeChatId);
  const visibleCount = visibleTabs(tabs, activeChatId).length;
  return /* @__PURE__ */ jsx32(
    TabListButton,
    {
      sections,
      label: "Tab list",
      placement: "left",
      menuWidth: TAB_LIST_MENU_WIDTH,
      footer: {
        label: visibleCount > 0 ? `Close all tabs (${visibleCount})` : "No open tabs",
        title: "Close all tabs of the active chat (kept in Recently closed)",
        disabled: visibleCount === 0,
        onPress: () => useViewerTabs.getState().closeAllViewers(activeChatId)
      }
    }
  );
}
function toggleTerminalInSidePane() {
  const view = useViewerTabs.getState();
  const app = useStore.getState();
  if (app.terminalPanelOpen && app.terminalPlacement === "right") {
    app.setTerminalPanelOpen(false);
    return;
  }
  view.setPaneOpen(true);
  app.setTerminalPlacement("right");
  app.setTerminalPanelOpen(true);
}
function ViewerTerminalButton() {
  const panelOpen = useStore((s) => s.terminalPanelOpen);
  const placement = useStore((s) => s.terminalPlacement);
  const paneOpen = useViewerTabs((s) => s.paneOpen);
  const chatFull = useStore((s) => s.chatFullscreen);
  const docked = panelOpen && resolveTerminalPlacement(placement, paneOpen, chatFull) === "right";
  return /* @__PURE__ */ jsx32(
    "button",
    {
      type: "button",
      className: "titlebar-icon-btn viewer-terminal-btn",
      title: docked ? "Close the terminal" : "Open the terminal in the side pane",
      "aria-label": docked ? "Close the terminal" : "Open the terminal in the side pane",
      "aria-pressed": docked,
      onClick: toggleTerminalInSidePane,
      children: /* @__PURE__ */ jsx32(TerminalPaneIcon, {})
    }
  );
}
function publishHintAnchor(row) {
  const rect = row.getBoundingClientRect();
  row.style.setProperty("--viewer-tab-hint-top", `${Math.round(rect.top + rect.height / 2)}px`);
  row.style.setProperty(
    "--viewer-tab-hint-right",
    `${Math.round(window.innerWidth - rect.right)}px`
  );
}
function ViewerTabBar() {
  const allTabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const activeChatId = useStore((s) => s.activeChatId);
  const tabs = viewerTabRows(allTabs, activeChatId);
  const shownActiveId = tabs.find((t) => t.id === activeId)?.id ?? tabs[0]?.id ?? null;
  const [dragId, setDragId] = useState27(null);
  const [dropTarget, setDropTarget] = useState27(null);
  const barRef = useRef18(null);
  useEffect24(() => {
    barRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [shownActiveId]);
  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };
  const dragPreview = (() => {
    if (!dragId || !dropTarget) return null;
    const slot = previewSlot(
      tabs.map((t) => t.id),
      dragId,
      dropTarget.id,
      dropTarget.after
    );
    let tailId2 = null;
    let tailMax = -1;
    slot.forEach((index, id) => {
      if (index > tailMax) {
        tailMax = index;
        tailId2 = id;
      }
    });
    return { slot, tailId: tailId2 };
  })();
  const tailId = dragPreview?.tailId ?? tabs[tabs.length - 1]?.id ?? null;
  return /* @__PURE__ */ jsx32(
    "div",
    {
      ref: barRef,
      className: "tab-bar viewer-tabs viewer-tabs-rail",
      role: "tablist",
      "aria-label": "Viewers",
      "aria-orientation": "vertical",
      onDragOver: (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const bar = barRef.current;
        if (!bar) return;
        const delta = edgeScroll(e.clientY, bar.getBoundingClientRect(), "y");
        if (delta) bar.scrollTop += delta;
        if (!tailId || tailId === dragId) return;
        const tailEl = bar.querySelector(`[data-tab-id="${tailId}"]`);
        if (!tailEl || e.clientY <= tailEl.getBoundingClientRect().bottom) return;
        setDropTarget(
          (prev) => prev?.id === tailId && prev.after ? prev : { id: tailId, after: true }
        );
      },
      onDragLeave: (e) => {
        if (e.target !== e.currentTarget) return;
        setDropTarget(null);
      },
      onDrop: (e) => {
        if (e.target !== e.currentTarget || !dragId) return;
        const tailEl = tailId ? barRef.current?.querySelector(`[data-tab-id="${tailId}"]`) : null;
        if (!tailId || !tailEl || e.clientY <= tailEl.getBoundingClientRect().bottom) return;
        const from = e.dataTransfer.getData("text/plain") || dragId;
        if (!from || from === tailId) return;
        e.preventDefault();
        useViewerTabs.getState().moveViewerTab(from, tailId, true);
        clearDrag();
      },
      children: tabs.map((t) => {
        const active = t.id === shownActiveId;
        const title = prepareContent(viewerTabTitle(t), "ltr");
        const dropCls = dropTarget?.id === t.id ? dropTarget.after ? " drop-after" : " drop-before" : "";
        const Icon = KIND_ICON[t.kind];
        const order = dragPreview?.slot.get(t.id);
        return /* @__PURE__ */ jsxs29(
          "div",
          {
            "data-tab-id": t.id,
            role: "tab",
            "aria-selected": active,
            tabIndex: 0,
            draggable: true,
            className: `editor-tab viewer-tab kind-${t.kind}${active ? " active" : ""}${dragId === t.id ? " dragging drop-preview" : ""}${dropCls}`,
            style: order === void 0 ? void 0 : { order },
            "aria-label": title,
            onMouseEnter: (e) => publishHintAnchor(e.currentTarget),
            onFocus: (e) => publishHintAnchor(e.currentTarget),
            onClick: () => useViewerTabs.getState().setActiveViewer(t.id),
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useViewerTabs.getState().setActiveViewer(t.id);
                return;
              }
              const target = tabMove(tabs.map((x) => x.id), t.id, e.key, e.altKey, "y");
              if (!target) return;
              e.preventDefault();
              useViewerTabs.getState().moveViewerTab(t.id, target.toId, target.after);
            },
            onAuxClick: (e) => {
              if (e.button === 1) useViewerTabs.getState().closeViewer(t.id);
            },
            onDragStart: (e) => {
              setViewerDragData(e, t.id);
              setDragId(t.id);
            },
            onDragOver: (e) => {
              if (!dragId || dragId === t.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const after = dropSide(e.clientY, rect, "y") === "after";
              setDropTarget(
                (prev) => prev?.id === t.id && prev.after === after ? prev : { id: t.id, after }
              );
            },
            onDragLeave: () => {
              setDropTarget((prev) => prev?.id === t.id ? null : prev);
            },
            onDrop: (e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain") || dragId;
              if (from && from !== t.id) {
                const rect = e.currentTarget.getBoundingClientRect();
                const after = dropSide(e.clientY, rect, "y") === "after";
                useViewerTabs.getState().moveViewerTab(from, t.id, after);
              }
              clearDrag();
            },
            onDragEnd: clearDrag,
            children: [
              /* @__PURE__ */ jsx32("span", { className: "viewer-tab-icon", "aria-hidden": "true", children: t.kind === "file" ? /* @__PURE__ */ jsx32(FileIcon, { path: t.filePath ?? t.title, size: 20 }) : /* @__PURE__ */ jsx32(Icon, {}) }),
              /* @__PURE__ */ jsxs29("span", { className: "editor-tab-label", dir: "ltr", children: [
                /* @__PURE__ */ jsx32("span", { className: "viewer-tab-name", children: title }),
                /* @__PURE__ */ jsx32(
                  "button",
                  {
                    type: "button",
                    className: "editor-tab-close",
                    title: "Close viewer",
                    "aria-label": `Close ${title}`,
                    draggable: false,
                    onClick: (e) => {
                      e.stopPropagation();
                      useViewerTabs.getState().closeViewer(t.id);
                    },
                    children: /* @__PURE__ */ jsx32(CloseIcon, {})
                  }
                )
              ] })
            ]
          },
          t.id
        );
      })
    }
  );
}
function ViewerScheduleButton() {
  const shown = usePageShown("schedule");
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-schedule-btn",
      shown,
      open: () => useViewerTabs.getState().openSchedule(),
      close: () => useViewerTabs.getState().closeViewer("schedule"),
      openTitle: "Open the schedule page",
      closeTitle: "Close the schedule page",
      children: /* @__PURE__ */ jsx32(ScheduleIcon, {})
    }
  );
}
function ViewerInboxButton() {
  const shown = usePageShown("inbox");
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-inbox-btn",
      shown,
      open: () => useViewerTabs.getState().openInbox(),
      close: () => {
        useViewerTabs.getState().closeViewer("inbox");
        useStore.getState().setScheduleInboxOpen(false);
      },
      openTitle: "Open the inbox \u2014 schedule run history",
      closeTitle: "Close the inbox",
      children: /* @__PURE__ */ jsx32(InboxIcon, {})
    }
  );
}
function ViewerPaneFullscreenButton() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeChatId = useStore((s) => s.activeChatId);
  const viewerFull = useViewerTabs((s) => s.fullscreen);
  if (visibleTabs(tabs, activeChatId).length === 0) return null;
  return /* @__PURE__ */ jsx32(
    "button",
    {
      type: "button",
      className: "editor-tab-full viewer-pane-full",
      title: viewerFull ? "Exit fullscreen" : "Fullscreen viewer",
      "aria-label": viewerFull ? "Exit viewer fullscreen" : "Fullscreen viewer",
      "aria-pressed": viewerFull,
      onClick: () => {
        const vt = useViewerTabs.getState();
        const next = !vt.fullscreen;
        vt.setFullscreen(next);
        if (next) useStore.getState().setChatFullscreen(false);
      },
      children: viewerFull ? /* @__PURE__ */ jsx32(CompressIcon, {}) : /* @__PURE__ */ jsx32(ExpandIcon, {})
    }
  );
}
function TodosIcon() {
  return /* @__PURE__ */ jsxs29("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx32("path", { d: "M4 6.4l1.5 1.5L8.4 5" }),
    /* @__PURE__ */ jsx32("path", { d: "M4 12.4l1.5 1.5L8.4 11" }),
    /* @__PURE__ */ jsx32("path", { d: "M4 18.4l1.5 1.5L8.4 17" }),
    /* @__PURE__ */ jsx32("path", { d: "M12 7h8M12 13h8M12 19h8" })
  ] });
}
function usePageShown(id) {
  const activeChatId = useStore((s) => s.activeChatId);
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const panelMode = useViewerTabs((s) => s.panelMode);
  return id !== null && shownViewerTabId(tabs, activeId, panelMode, activeChatId) === id;
}
function PageRailButton({
  className,
  shown,
  open,
  close,
  openTitle,
  closeTitle,
  children
}) {
  const title = shown ? closeTitle : openTitle;
  return /* @__PURE__ */ jsx32(
    "button",
    {
      type: "button",
      className: `titlebar-icon-btn ${className}`,
      title,
      "aria-label": title,
      "aria-pressed": shown,
      onClick: () => shown ? close() : open(),
      children
    }
  );
}
function ViewerArtifactsButton() {
  const shown = usePageShown("artifacts");
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-artifacts-btn",
      shown,
      open: () => useViewerTabs.getState().openArtifacts(),
      close: () => useViewerTabs.getState().closeViewer("artifacts"),
      openTitle: "Open the artifacts page",
      closeTitle: "Close the artifacts page",
      children: /* @__PURE__ */ jsx32(ArtifactsIcon, {})
    }
  );
}
function ViewerFilesButton() {
  const activeChatId = useStore((s) => s.activeChatId);
  const id = viewerTabId("files", activeChatId);
  const shown = usePageShown(id);
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-files-btn",
      shown,
      open: () => useViewerTabs.getState().openFiles(activeChatId),
      close: () => useViewerTabs.getState().closeViewer(id),
      openTitle: "Open the file explorer",
      closeTitle: "Close the file explorer",
      children: /* @__PURE__ */ jsx32(FilesIcon, {})
    }
  );
}
function ViewerTodosButton() {
  const panelMode = useViewerTabs((s) => s.panelMode);
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const activeChatId = useStore((s) => s.activeChatId);
  const showing = shownViewerTabId(tabs, activeId, panelMode, activeChatId) === null;
  return /* @__PURE__ */ jsx32(
    "button",
    {
      type: "button",
      className: "titlebar-icon-btn panel-toggle",
      title: showing ? "Show viewer tabs" : "Show the todos page",
      "aria-label": showing ? "Show viewer tabs" : "Show the todos page",
      "aria-pressed": showing,
      onClick: () => useViewerTabs.getState().togglePanelMode(),
      children: /* @__PURE__ */ jsx32(TodosIcon, {})
    }
  );
}
function ViewerReviewButton() {
  const activeChatId = useStore((s) => s.activeChatId);
  const id = viewerTabId("review", activeChatId);
  const shown = usePageShown(id);
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-review-btn",
      shown,
      open: () => useViewerTabs.getState().openGitDiff(activeChatId),
      close: () => useViewerTabs.getState().closeViewer(id),
      openTitle: "Open the git diff",
      closeTitle: "Close the git diff",
      children: /* @__PURE__ */ jsx32(ReviewIcon, {})
    }
  );
}
function ViewerTraceButton() {
  const activeChatId = useStore((s) => s.activeChatId);
  const id = viewerTabId("trace", activeChatId);
  const shown = usePageShown(id);
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-trace-btn",
      shown,
      open: () => useViewerTabs.getState().openTraces(activeChatId),
      close: () => useViewerTabs.getState().closeViewer(id),
      openTitle: "Open the trace",
      closeTitle: "Close the trace",
      children: /* @__PURE__ */ jsx32(TraceIcon, {})
    }
  );
}
function ViewerBrowserButton() {
  const activeChatId = useStore((s) => s.activeChatId);
  const id = viewerTabId("browser", activeChatId);
  const shown = usePageShown(id);
  return /* @__PURE__ */ jsx32(
    PageRailButton,
    {
      className: "viewer-browser-btn",
      shown,
      open: () => useViewerTabs.getState().openBrowser(activeChatId),
      close: () => useViewerTabs.getState().closeViewer(id),
      openTitle: "Open the browser",
      closeTitle: "Close the browser",
      children: /* @__PURE__ */ jsx32(BrowserIcon, {})
    }
  );
}
var TAB_LIST_MENU_WIDTH, FilesIcon, KIND_ICON;
var init_ViewerTabBar = __esm({
  "src/components/ViewerTabBar.tsx"() {
    "use strict";
    init_store();
    init_bidi();
    init_tabBar();
    init_tabOrder();
    init_viewerTabs();
    init_ViewerWindows();
    init_ViewerFullscreenButton();
    init_TabListMenu();
    init_FileIcon();
    init_time();
    TAB_LIST_MENU_WIDTH = 410;
    FilesIcon = () => /* @__PURE__ */ jsxs29("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
      /* @__PURE__ */ jsx32("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }),
      /* @__PURE__ */ jsx32("path", { d: "M3 13h18", opacity: "0.6" })
    ] });
    KIND_ICON = {
      review: ReviewIcon,
      trace: TraceIcon,
      inbox: InboxIcon,
      schedule: ScheduleIcon,
      plan: PlanIcon,
      browser: BrowserIcon,
      // File tabs render their own per-path icon (see the map below); this
      // placeholder only satisfies the Record type.
      file: () => /* @__PURE__ */ jsx32(ReviewIcon, {}),
      text: PlanIcon,
      explore: ExploreIcon,
      files: FilesIcon,
      artifact: ArtifactIcon,
      artifacts: ArtifactsIcon
    };
  }
});

// tests/viewerTabRail.ssr.test.tsx
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {},
    getItem(k) {
      return this._d[k] ?? null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    }
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return void 0;
        return async () => ({ ok: true, data: null });
      }
    }
  )
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.openExternal = async () => {
};
globalThis.localStorage.setItem(
  "coder:viewerTabs",
  JSON.stringify({
    tabs: [
      { id: "inbox", kind: "inbox", title: "Inbox", createdAt: 1 },
      // Legacy global file tab (no chatId): visible in every chat.
      { id: "file:src/App.tsx", kind: "file", title: "App.tsx", filePath: "src/App.tsx", createdAt: 2 }
    ],
    activeId: "inbox",
    closed: []
  })
);
var React = await import("react");
var { renderToStaticMarkup } = await import("react-dom/server");
var { readFileSync } = await import("node:fs");
var { ViewerTabBar: ViewerTabBar2, ViewerFilesButton: ViewerFilesButton2, ViewerInboxButton: ViewerInboxButton2, ViewerTerminalButton: ViewerTerminalButton2, toggleTerminalInSidePane: toggleTerminalInSidePane2 } = await Promise.resolve().then(() => (init_ViewerTabBar(), ViewerTabBar_exports));
var { resolveTerminalPlacement: resolveTerminalPlacement2, useStore: useStore2 } = await Promise.resolve().then(() => (init_store(), store_exports));
var { useViewerTabs: useViewerTabs2 } = await Promise.resolve().then(() => (init_viewerTabs(), viewerTabs_exports));
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}
console.log("1) ViewerTabBar renders as a vertical icon rail:");
{
  const html = renderToStaticMarkup(React.createElement(ViewerTabBar2));
  const tabCount = (html.match(/role="tab"/g) ?? []).length;
  check("rail-owned pages get no row, plain tabs do", tabCount === 1, html);
  check("the inbox tab is not drawn as a row", !html.includes("kind-inbox"), html);
  check("bar carries the rail class", html.includes("viewer-tabs-rail"), html.slice(0, 160));
  check("bar announces a vertical tablist", html.includes('aria-orientation="vertical"'));
  check("every tab shows an icon", (html.match(/viewer-tab-icon/g) ?? []).length === tabCount);
  check(
    "every tab keeps its name in the markup (shown beside the row on hover)",
    (html.match(/editor-tab-label/g) ?? []).length === tabCount
  );
  const railStart = html.indexOf("viewer-tabs-rail");
  check("the rail wraps the tabs, not the other way round", railStart !== -1 && railStart < html.indexOf('role="tab"'));
}
console.log("2) markup + CSS keep the rail fixed on the pane's right edge:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8");
  const bodyAt = appSrc.indexOf('className="viewer-pane-body"');
  const headAt = appSrc.indexOf('className="viewer-pane-head"');
  check("the pane body wraps the header", bodyAt !== -1 && headAt > bodyAt);
  check(
    "the header (rail) comes after the content in the body",
    bodyAt !== -1 && headAt > appSrc.indexOf('className="viewer-content"')
  );
  const css2 = readFileSync("src/styles/global.css", "utf8");
  const railCss = css2.slice(css2.indexOf("--- vertical viewer tab rail"));
  check("the rail block exists in the stylesheet", railCss.length > 0);
  const rail = railCss.match(/\.viewer-tabs-rail\s*\{[^}]*\}/);
  check("rail stacks its tabs vertically", /flex-direction:\s*column/.test(rail?.[0] ?? ""), rail?.[0]);
  check(
    "many tabs scroll inside the rail instead of spilling over the icons",
    /overflow-y:\s*auto/.test(rail?.[0] ?? "") && /overflow-x:\s*hidden/.test(rail?.[0] ?? ""),
    rail?.[0]
  );
  check(
    "the rail is visually parted from the page icons above it",
    /border-top:\s*1px solid/.test(rail?.[0] ?? ""),
    rail?.[0]
  );
  const head = railCss.match(/\.viewer-pane-body \.viewer-pane-head\s*\{[^}]*\}/);
  check(
    "rail is pinned to the pane's right edge at a fixed width",
    /right:\s*0/.test(head?.[0] ?? "") && /width:\s*var\(--viewer-rail-width/.test(head?.[0] ?? ""),
    head?.[0]
  );
  check(
    "the rail is never a window drag region",
    /-webkit-app-region:\s*no-drag/.test(head?.[0] ?? ""),
    head?.[0]
  );
  const hoverHeadRules = railCss.match(/\.viewer-pane-body[^{}]*:hover[^{}]*\{[^}]*\}/g) ?? [];
  const containerHoverRules = hoverHeadRules.filter(
    (r) => !/\.editor-tab/.test(r) && !/viewer-tab-hint/.test(r)
  );
  check(
    "hovering never widens the rail or repaints it",
    containerHoverRules.length === 0,
    containerHoverRules
  );
  check(
    "the collapsed width is never overridden",
    !/--viewer-rail-width:\s*var\(--viewer-rail-open-width\)/.test(railCss)
  );
  check(
    "viewer content keeps a constant rail gutter",
    /\.viewer-pane-body > \.viewer-content\s*\{[^}]*padding-right:\s*var\(--viewer-rail-width\)/.test(railCss)
  );
  check(
    "no rail row is painted translucent",
    !/\.viewer-tabs-rail \.editor-tab[^{}]*\{[^}]*opacity:\s*0?\.\d/.test(railCss)
  );
  const label = railCss.match(/\.viewer-tabs-rail \.editor-tab-label\s*\{[^}]*\}/);
  check("tab labels stay icon-only at rest", /display:\s*none/.test(label?.[0] ?? ""), label?.[0]);
  const hint = railCss.match(
    /\.viewer-pane-body \.viewer-tabs-rail \.editor-tab:hover \.editor-tab-label[^{]*\{[^}]*\}/
  );
  check("a hovered row shows its name", hint !== null, hint?.[0]);
  check(
    "the name floats outside the rail's box",
    /position:\s*fixed/.test(hint?.[0] ?? "") && /right:\s*var\(--viewer-tab-hint-right/.test(hint?.[0] ?? ""),
    hint?.[0]
  );
  check(
    "the name stays reachable (it never vanishes mid-move)",
    /pointer-events:\s*auto/.test(hint?.[0] ?? ""),
    hint?.[0]
  );
  check(
    "the name card lands on the row and holds the \u2715",
    /height:\s*30px/.test(hint?.[0] ?? "") && /border-radius:\s*6px/.test(hint?.[0] ?? "") && /display:\s*flex/.test(hint?.[0] ?? ""),
    hint?.[0]
  );
  const closeHoverBox = railCss.match(
    /\.viewer-pane-body \.viewer-tabs-rail \.editor-tab \.editor-tab-close:hover[^{]*\{[^}]*\}/
  );
  check(
    "a hovered \u2715 only recolors its glyph",
    /background:\s*none/.test(closeHoverBox?.[0] ?? ""),
    closeHoverBox?.[0]
  );
  const closeBox = railCss.match(/\.editor-tab \.editor-tab-close\s*\{[^}]*\}/);
  check(
    "the \u2715 sits inside the card instead of covering the row",
    /position:\s*static/.test(closeBox?.[0] ?? "") && /width:\s*26px/.test(closeBox?.[0] ?? ""),
    closeBox?.[0]
  );
  check(
    "the \u2715 swaps with the tab's kind icon on hover",
    /\.editor-tab:hover \.viewer-tab-icon[^{]*\{[^}]*opacity:\s*0/.test(railCss)
  );
  check(
    "the rail keeps its one-icon width",
    /--viewer-rail-width:\s*42px/.test(railCss)
  );
  const barSrc = readFileSync("src/components/ViewerTabBar.tsx", "utf8");
  check(
    "the markup nests the \u2715 in the name card",
    /<span className="editor-tab-label"[\s\S]{0,400}?className="editor-tab-close"/.test(barSrc)
  );
  check(
    "the row publishes its own center and right edge for the card",
    /--viewer-tab-hint-top/.test(barSrc) && /--viewer-tab-hint-right/.test(barSrc) && /onMouseEnter=/.test(barSrc)
  );
  check(
    "drag/keyboard reordering runs on the vertical axis",
    /dropSide\(e\.clientY, rect, "y"\)/.test(barSrc) && /tabMove\(.*"y"\)/.test(barSrc)
  );
}
console.log("3) panel icons lead the rail, tabs follow below them:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8");
  const headAt = appSrc.indexOf('className="viewer-pane-head"');
  const head = appSrc.slice(headAt, appSrc.indexOf("</section>", headAt));
  const actionsAt = head.indexOf('className="viewer-pane-actions"');
  const listAt = head.indexOf("<ViewerTabListButton");
  const barAt = head.indexOf("<ViewerTabBar");
  const spacerAt = head.indexOf("viewer-pane-spacer");
  check("the panel action icons render inside the rail", actionsAt !== -1);
  check("panel icons come before the tab-list chevron", actionsAt !== -1 && actionsAt < listAt);
  check("panel icons come before the tabs", actionsAt !== -1 && actionsAt < barAt);
  check("nothing is stacked above the panel icons", !head.slice(headAt === -1 ? 0 : 0, actionsAt).includes("<button"));
  check("the spacer drops below the tabs", spacerAt > barAt);
  check('no "+" add button is left in the rail', !head.includes("ViewerAddButton"));
  check("the add button component is gone from the app", !appSrc.includes("ViewerAddButton"));
  const css2 = readFileSync("src/styles/global.css", "utf8");
  const actions = css2.match(/\.viewer-pane-body \.viewer-pane-actions\s*\{[^}]*\}/);
  check("the rail action container fills the rail width", /width:\s*100%/.test(actions?.[0] ?? ""), actions?.[0]);
  check("rail icon buttons share one width", /\.viewer-pane-head \.titlebar-icon-btn/.test(css2));
}
console.log("4) every page owns one rail icon, in a fixed order:");
{
  const appSrc = readFileSync("src/App.tsx", "utf8");
  const headAt = appSrc.indexOf('className="viewer-pane-head"');
  const head = appSrc.slice(headAt, appSrc.indexOf("</section>", headAt));
  const listAt = head.indexOf("<ViewerTabListButton");
  const fullAt = head.indexOf("<ViewerPaneFullscreenButton");
  const filesAt = head.indexOf("<ViewerFilesButton");
  const todosAt = head.indexOf("<ViewerTodosButton");
  const artifactsAt = head.indexOf("<ViewerArtifactsButton");
  const termAt = head.indexOf("<ViewerTerminalButton");
  const schedAt = head.indexOf("<ViewerScheduleButton");
  const inboxAt = head.indexOf("<ViewerInboxButton");
  const reviewAt = head.indexOf("<ViewerReviewButton");
  const traceAt = head.indexOf("<ViewerTraceButton");
  const browserAt = head.indexOf("<ViewerBrowserButton");
  const barAt = head.indexOf("<ViewerTabBar");
  const spacerAt = head.indexOf("viewer-pane-spacer");
  check("the terminal toggle renders in the rail", termAt !== -1, head.slice(0, 1200));
  check("fill every page icon", [fullAt, filesAt, todosAt, artifactsAt, schedAt, inboxAt, reviewAt, traceAt, browserAt].every((i) => i !== -1), head);
  check("fullscreen sits directly below the tab-list chevron", listAt !== -1 && fullAt > listAt);
  check("files leads the rest of the page icons", filesAt > fullAt && filesAt < todosAt);
  check("todos sits below files and above artifacts", todosAt > filesAt && todosAt < artifactsAt);
  check("artifacts follows todos and sits above the terminal", artifactsAt > todosAt && artifactsAt < termAt);
  check("the terminal follows artifacts", termAt > artifactsAt);
  check("schedule follows the terminal, inbox follows schedule", schedAt > termAt && inboxAt > schedAt);
  check("review, trace and browser close the icon list", reviewAt > inboxAt && traceAt > reviewAt && browserAt > traceAt);
  check("the rail rows and the tabs come last", barAt > browserAt && spacerAt > barAt);
  check(
    "the todos page owns a rail icon (not raw markup in App)",
    !head.includes('className="titlebar-icon-btn panel-toggle"')
  );
  const html = renderToStaticMarkup(React.createElement(ViewerTerminalButton2));
  check(
    "the rail button is a plain titlebar icon button",
    html.includes('class="titlebar-icon-btn viewer-terminal-btn"'),
    html
  );
  check("it starts unpressed", html.includes('aria-pressed="false"'), html);
  check(
    "its label offers to open the terminal here",
    html.includes("Open the terminal in the side pane"),
    html
  );
  check(
    "the tooltip and the label agree",
    (html.match(/Open the terminal in the side pane/g) ?? []).length === 2,
    html
  );
  check(
    "it paints a stroke glyph instead of a filled app badge",
    html.includes('stroke="currentColor"') && !html.includes("mac-app-badge"),
    html
  );
  useViewerTabs2.getState().setPaneOpen(false);
  useStore2.getState().setTerminalPanelOpen(false);
  useStore2.getState().setTerminalPlacement("bottom");
  toggleTerminalInSidePane2();
  const v1 = useViewerTabs2.getState();
  const a1 = useStore2.getState();
  check("the first press reveals the side pane", v1.paneOpen === true);
  check("it requests the side dock", a1.terminalPlacement === "right", a1.terminalPlacement);
  check("it opens the terminal", a1.terminalPanelOpen === true);
  check(
    "the effective dock really is the pane",
    resolveTerminalPlacement2(a1.terminalPlacement, v1.paneOpen, a1.chatFullscreen) === "right"
  );
  toggleTerminalInSidePane2();
  check("pressing it again closes the terminal", useStore2.getState().terminalPanelOpen === false);
  useStore2.getState().setTerminalPlacement("right");
  useStore2.getState().setTerminalPanelOpen(false);
  toggleTerminalInSidePane2();
  check("a stale side request still opens the terminal", useStore2.getState().terminalPanelOpen === true);
  check(
    "a hidden pane degrades the dock (so the icon reads unpressed)",
    resolveTerminalPlacement2("right", false, false) === "bottom"
  );
}
console.log("5) a page icon is pressed only while its page is ON SCREEN:");
{
  const inboxHtml = renderToStaticMarkup(React.createElement(ViewerInboxButton2));
  check(
    "the icon of the shown page is pressed",
    inboxHtml.includes('aria-pressed="true"'),
    inboxHtml
  );
  check("\u2026and offers to close it", inboxHtml.includes("Close the inbox"), inboxHtml);
  const filesHtml = renderToStaticMarkup(React.createElement(ViewerFilesButton2));
  check(
    "the icon of an open-but-hidden page is not pressed",
    filesHtml.includes('aria-pressed="false"'),
    filesHtml
  );
  check(
    "\u2026and still offers to open it",
    filesHtml.includes("Open the file explorer") && !filesHtml.includes("Close the file explorer"),
    filesHtml
  );
}
if (failed) process.exit(1);
console.log("\nAll viewer tab rail checks passed");
