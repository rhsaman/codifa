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
function themeById(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
var DEFAULT_THEME, THEMES;
var init_themes = __esm({
  "src/lib/themes.ts"() {
    "use strict";
    DEFAULT_THEME = "catppuccin";
    THEMES = [
      {
        id: "claude",
        name: "Claude",
        blurb: "claude.ai dark",
        vars: {
          "--bg": "#1a1816",
          "--bg-alt": "#16140f",
          "--bg-panel": "#1f1c18",
          "--bg-input": "#2d2820",
          "--bg-hover": "#2a2620",
          "--border": "#2b2621",
          "--text": "#e8e6e3",
          "--text-dim": "#9a9287",
          "--accent": "#c15f3c",
          "--accent-dim": "#2d2820",
          "--on-accent": "#ffffff",
          "--danger": "#f85149",
          "--success": "#3fb950",
          "--link": "#d97b5a",
          "--thinking": "#d4a574",
          "--provider-openrouter": "#d4a574",
          "--provider-google": "#9fb3a6",
          "--provider-nvidia": "#7fb4a8",
          "--provider-cloudflare": "#d97b5a",
          "--provider-tokenrouter": "#c15f3c",
          "--provider-ollama": "#b1ada1",
          "--provider-custom": "#8f8878"
        },
        workspaceColors: [
          "#c15f3c",
          // crail
          "#d97b5a",
          // lighter crail
          "#d4a574",
          // tan
          "#e2c08d",
          // sand
          "#9fb3a6",
          // sage
          "#b1ada1",
          // cloudy
          "#c88a91",
          // muted rose
          "#e8e6e3"
          // pampas
        ]
      },
      {
        id: "tokyonight",
        name: "Tokyo Night",
        blurb: "tokyonight.nvim",
        vars: {
          "--bg": "#1a1b26",
          "--bg-alt": "#16161e",
          "--bg-panel": "#292e42",
          "--bg-input": "#292e42",
          "--bg-hover": "#283457",
          "--border": "#3b4261",
          "--text": "#c0caf5",
          "--text-dim": "#a9b1d6",
          "--accent": "#7aa2f7",
          "--accent-dim": "#3b4261",
          "--on-accent": "#16161e",
          "--danger": "#f7768e",
          "--success": "#9ece6a",
          "--link": "#7aa2f7",
          "--thinking": "#e0af68",
          "--provider-openrouter": "#e0af68",
          "--provider-google": "#9ece6a",
          "--provider-nvidia": "#73daca",
          "--provider-cloudflare": "#7aa2f7",
          "--provider-tokenrouter": "#bb9af7",
          "--provider-ollama": "#ff9e64",
          "--provider-custom": "#c0caf5"
        },
        workspaceColors: [
          "#f7768e",
          // red
          "#e0af68",
          // yellow
          "#9ece6a",
          // green
          "#73daca",
          // teal
          "#7aa2f7",
          // blue
          "#bb9af7",
          // purple
          "#ff9e64",
          // orange
          "#c0caf5"
          // light
        ]
      },
      {
        id: "catppuccin",
        name: "Catppuccin Mocha",
        blurb: "catppuccin/nvim mocha",
        vars: {
          "--bg": "#1e1e2e",
          "--bg-alt": "#181825",
          "--bg-panel": "#313244",
          "--bg-input": "#45475a",
          "--bg-hover": "#45475a",
          "--border": "#45475a",
          "--text": "#cdd6f4",
          "--text-dim": "#bac2de",
          "--accent": "#89b4fa",
          "--accent-dim": "#45475a",
          "--on-accent": "#11111b",
          "--danger": "#f38ba8",
          "--success": "#a6e3a1",
          "--link": "#89b4fa",
          "--thinking": "#f9e2af",
          "--provider-openrouter": "#fab387",
          "--provider-google": "#f9e2af",
          "--provider-nvidia": "#94e2d5",
          "--provider-cloudflare": "#89b4fa",
          "--provider-tokenrouter": "#cba6f7",
          "--provider-ollama": "#f5c2e7",
          "--provider-custom": "#a6adc8"
        },
        workspaceColors: [
          "#f38ba8",
          // red
          "#fab387",
          // peach
          "#f9e2af",
          // yellow
          "#a6e3a1",
          // green
          "#94e2d5",
          // teal
          "#89b4fa",
          // blue
          "#cba6f7",
          // mauve
          "#f5c2e7"
          // pink
        ]
      },
      {
        id: "catppuccin-macchiato",
        name: "Catppuccin Macchiato",
        blurb: "catppuccin/nvim macchiato",
        vars: {
          "--bg": "#24273a",
          "--bg-alt": "#1e2030",
          "--bg-panel": "#363a4f",
          "--bg-input": "#494d64",
          "--bg-hover": "#494d64",
          "--border": "#494d64",
          "--text": "#cad3f5",
          "--text-dim": "#b8c0e0",
          "--accent": "#8aadf4",
          "--accent-dim": "#494d64",
          "--on-accent": "#181926",
          "--danger": "#ed8796",
          "--success": "#a6da95",
          "--link": "#8aadf4",
          "--thinking": "#eed49f",
          "--provider-openrouter": "#f5a97f",
          "--provider-google": "#eed49f",
          "--provider-nvidia": "#8bd5ca",
          "--provider-cloudflare": "#8aadf4",
          "--provider-tokenrouter": "#c6a0f6",
          "--provider-ollama": "#f5bde6",
          "--provider-custom": "#b8c0e0"
        },
        workspaceColors: [
          "#ed8796",
          // red
          "#f5a97f",
          // peach
          "#eed49f",
          // yellow
          "#a6da95",
          // green
          "#8bd5ca",
          // teal
          "#8aadf4",
          // blue
          "#c6a0f6",
          // mauve
          "#f5bde6"
          // pink
        ]
      },
      {
        id: "catppuccin-frappe",
        name: "Catppuccin Frapp\xE9",
        blurb: "catppuccin/nvim frapp\xE9",
        vars: {
          "--bg": "#303446",
          "--bg-alt": "#292c3c",
          "--bg-panel": "#414559",
          "--bg-input": "#51576d",
          "--bg-hover": "#51576d",
          "--border": "#51576d",
          "--text": "#c6d0f5",
          "--text-dim": "#c6d0f5",
          "--accent": "#8caaee",
          "--accent-dim": "#51576d",
          "--on-accent": "#232634",
          "--danger": "#e78284",
          "--success": "#a6d189",
          "--link": "#8caaee",
          "--thinking": "#e5c890",
          "--provider-openrouter": "#ef9f76",
          "--provider-google": "#e5c890",
          "--provider-nvidia": "#81c8be",
          "--provider-cloudflare": "#8caaee",
          "--provider-tokenrouter": "#ca9ee6",
          "--provider-ollama": "#f4b8e4",
          "--provider-custom": "#c6d0f5"
        },
        workspaceColors: [
          "#e78284",
          // red
          "#ef9f76",
          // peach
          "#e5c890",
          // yellow
          "#a6d189",
          // green
          "#81c8be",
          // teal
          "#8caaee",
          // blue
          "#ca9ee6",
          // mauve
          "#f4b8e4"
          // pink
        ]
      },
      {
        id: "catppuccin-latte",
        name: "Catppuccin Latte",
        blurb: "catppuccin/nvim latte (light)",
        vars: {
          "--bg": "#eff1f5",
          "--bg-alt": "#e6e9ef",
          "--bg-panel": "#ccd0da",
          "--bg-input": "#bcc0cc",
          "--bg-hover": "#bcc0cc",
          "--border": "#bcc0cc",
          "--text": "#3d4057",
          "--text-dim": "#40435a",
          "--accent": "#1e66f5",
          "--accent-dim": "#bcc0cc",
          "--on-accent": "#f4f6fb",
          "--danger": "#d20f39",
          "--success": "#2c7d1a",
          /* Diff highlight text stays dark in the light theme (the highlight
             background is a light tint of --danger/--success over --bg). */
          "--diff-text": "#3d4057",
          "--link": "#1a5cd6",
          "--thinking": "#8f6200",
          "--provider-openrouter": "#fe640b",
          "--provider-google": "#df8e1d",
          "--provider-nvidia": "#179299",
          "--provider-cloudflare": "#1e66f5",
          "--provider-tokenrouter": "#8839ef",
          "--provider-ollama": "#ea76cb",
          "--provider-custom": "#40435a"
        },
        workspaceColors: [
          "#d20f39",
          // red
          "#fe640b",
          // peach
          "#df8e1d",
          // yellow
          "#40a02b",
          // green
          "#179299",
          // teal
          "#1e66f5",
          // blue
          "#8839ef",
          // mauve
          "#ea76cb"
          // pink
        ]
      },
      {
        id: "gruvbox",
        name: "Gruvbox",
        blurb: "gruvbox.nvim dark",
        vars: {
          "--bg": "#282828",
          "--bg-alt": "#1d2021",
          "--bg-panel": "#3c3836",
          "--bg-input": "#3c3836",
          "--bg-hover": "#504945",
          "--border": "#504945",
          "--text": "#ebdbb2",
          "--text-dim": "#d5c4a1",
          "--accent": "#fe8019",
          "--accent-dim": "#3c3836",
          "--on-accent": "#282828",
          "--danger": "#ff6a5c",
          "--success": "#b8bb26",
          "--link": "#83a598",
          "--thinking": "#fabd2f",
          "--provider-openrouter": "#fabd2f",
          "--provider-google": "#b8bb26",
          "--provider-nvidia": "#8ec07c",
          "--provider-cloudflare": "#83a598",
          "--provider-tokenrouter": "#d3869b",
          "--provider-ollama": "#fe8019",
          "--provider-custom": "#ebdbb2"
        },
        workspaceColors: [
          "#fb4934",
          // red
          "#fabd2f",
          // yellow
          "#b8bb26",
          // green
          "#8ec07c",
          // aqua
          "#83a598",
          // blue
          "#d3869b",
          // purple
          "#fe8019",
          // orange
          "#ebdbb2"
          // cream
        ]
      },
      {
        id: "dracula",
        name: "Dracula",
        blurb: "dracula/nvim",
        vars: {
          "--bg": "#282a36",
          "--bg-alt": "#21222c",
          "--bg-panel": "#282a36",
          "--bg-input": "#21222c",
          "--bg-hover": "#44475a",
          "--border": "#44475a",
          "--text": "#f8f8f2",
          "--text-dim": "#b4b9d0",
          "--accent": "#bd93f9",
          "--accent-dim": "#44475a",
          "--on-accent": "#282a36",
          "--danger": "#ff5555",
          "--success": "#50fa7b",
          "--link": "#8be9fd",
          "--thinking": "#f1fa8c",
          "--provider-openrouter": "#f1fa8c",
          "--provider-google": "#50fa7b",
          "--provider-nvidia": "#8be9fd",
          "--provider-cloudflare": "#bd93f9",
          "--provider-tokenrouter": "#ff79c6",
          "--provider-ollama": "#ffb86c",
          "--provider-custom": "#f8f8f2"
        },
        workspaceColors: [
          "#ff5555",
          // red
          "#f1fa8c",
          // yellow
          "#50fa7b",
          // green
          "#8be9fd",
          // cyan
          "#bd93f9",
          // purple
          "#ff79c6",
          // pink
          "#ffb86c",
          // orange
          "#f8f8f2"
          // white
        ]
      },
      {
        id: "nord",
        name: "Nord",
        blurb: "nordic.nvim",
        vars: {
          "--bg": "#2e3440",
          "--bg-alt": "#3b4252",
          "--bg-panel": "#3b4252",
          "--bg-input": "#434c5e",
          "--bg-hover": "#3b4252",
          "--border": "#434c5e",
          "--text": "#d8dee9",
          "--text-dim": "#b8c4d8",
          "--accent": "#88c0d0",
          "--accent-dim": "#434c5e",
          "--on-accent": "#2e3440",
          "--danger": "#e88a91",
          "--success": "#a3be8c",
          "--link": "#81a1c1",
          "--thinking": "#ebcb8b",
          "--provider-openrouter": "#ebcb8b",
          "--provider-google": "#a3be8c",
          "--provider-nvidia": "#88c0d0",
          "--provider-cloudflare": "#81a1c1",
          "--provider-tokenrouter": "#b48ead",
          "--provider-ollama": "#d08770",
          "--provider-custom": "#d8dee9"
        },
        workspaceColors: [
          "#bf616a",
          // red
          "#ebcb8b",
          // yellow
          "#a3be8c",
          // green
          "#88c0d0",
          // cyan
          "#81a1c1",
          // blue
          "#b48ead",
          // purple
          "#d08770",
          // orange
          "#d8dee9"
          // light
        ]
      },
      {
        id: "rose-pine",
        name: "Rose Pine",
        blurb: "rose-pine/nvim",
        vars: {
          "--bg": "#191724",
          "--bg-alt": "#21202e",
          "--bg-panel": "#1f1d2e",
          "--bg-input": "#26233a",
          "--bg-hover": "#403d52",
          "--border": "#524f67",
          "--text": "#e0def4",
          "--text-dim": "#b0abc8",
          "--accent": "#ebbcba",
          "--accent-dim": "#403d52",
          "--on-accent": "#191724",
          "--danger": "#eb6f92",
          "--success": "#9ccfd8",
          "--link": "#4a9bc0",
          "--thinking": "#f6c177",
          "--provider-openrouter": "#f6c177",
          "--provider-google": "#9ccfd8",
          "--provider-nvidia": "#31748f",
          "--provider-cloudflare": "#c4a7e7",
          "--provider-tokenrouter": "#ebbcba",
          "--provider-ollama": "#6e6a86",
          "--provider-custom": "#e0def4"
        },
        workspaceColors: [
          "#eb6f92",
          // red
          "#f6c177",
          // yellow
          "#9ccfd8",
          // teal
          "#31748f",
          // blue
          "#c4a7e7",
          // purple
          "#ebbcba",
          // rose
          "#6e6a86",
          // muted
          "#e0def4"
          // light
        ]
      },
      {
        id: "one-dark",
        name: "One Dark",
        blurb: "onedark.nvim",
        vars: {
          "--bg": "#282c34",
          "--bg-alt": "#21252b",
          "--bg-panel": "#2c313a",
          "--bg-input": "#3e4451",
          "--bg-hover": "#3e4451",
          "--border": "#4b5263",
          "--text": "#abb2bf",
          "--text-dim": "#b4bcc9",
          "--accent": "#61afef",
          "--accent-dim": "#4b5263",
          "--on-accent": "#282c34",
          "--danger": "#e9858e",
          "--success": "#98c379",
          "--link": "#61afef",
          "--thinking": "#e5c07b",
          "--provider-openrouter": "#e5c07b",
          "--provider-google": "#98c379",
          "--provider-nvidia": "#56b6c2",
          "--provider-cloudflare": "#61afef",
          "--provider-tokenrouter": "#c678dd",
          "--provider-ollama": "#d19a66",
          "--provider-custom": "#abb2bf"
        },
        workspaceColors: [
          "#e06c75",
          // red
          "#e5c07b",
          // yellow
          "#98c379",
          // green
          "#56b6c2",
          // cyan
          "#61afef",
          // blue
          "#c678dd",
          // purple
          "#d19a66",
          // orange
          "#abb2bf"
          // light
        ]
      },
      {
        id: "monokai",
        name: "Monokai",
        blurb: "monokai.nvim",
        vars: {
          "--bg": "#272822",
          "--bg-alt": "#272822",
          "--bg-panel": "#272822",
          "--bg-input": "#49483e",
          "--bg-hover": "#49483e",
          "--border": "#49483e",
          "--text": "#f8f8f2",
          "--text-dim": "#c0bca8",
          "--accent": "#66d9ef",
          "--accent-dim": "#49483e",
          "--on-accent": "#272822",
          "--danger": "#ff5590",
          "--success": "#a6e22e",
          "--link": "#66d9ef",
          "--thinking": "#e6db74",
          "--provider-openrouter": "#e6db74",
          "--provider-google": "#a6e22e",
          "--provider-nvidia": "#66d9ef",
          "--provider-cloudflare": "#ae81ff",
          "--provider-tokenrouter": "#fd971f",
          "--provider-ollama": "#f8f8f2",
          "--provider-custom": "#75715e"
        },
        workspaceColors: [
          "#f92672",
          // red
          "#e6db74",
          // yellow
          "#a6e22e",
          // green
          "#66d9ef",
          // cyan
          "#ae81ff",
          // purple
          "#fd971f",
          // orange
          "#f8f8f2",
          // white
          "#75715e"
          // gray
        ]
      },
      {
        id: "kanagawa",
        name: "Kanagawa",
        blurb: "kanagawa.nvim wave",
        vars: {
          "--bg": "#1f1f28",
          "--bg-alt": "#181820",
          "--bg-panel": "#2a2a37",
          "--bg-input": "#363646",
          "--bg-hover": "#363646",
          "--border": "#54546d",
          "--text": "#dcd7ba",
          "--text-dim": "#b0a9c4",
          "--accent": "#7e9cd8",
          "--accent-dim": "#363646",
          "--on-accent": "#1f1f28",
          "--danger": "#e05e5c",
          "--success": "#7fa172",
          "--link": "#7fb4ca",
          "--thinking": "#dca561",
          "--provider-openrouter": "#dca561",
          "--provider-google": "#76946a",
          "--provider-nvidia": "#6a9589",
          "--provider-cloudflare": "#7e9cd8",
          "--provider-tokenrouter": "#957fb8",
          "--provider-ollama": "#7fb4ca",
          "--provider-custom": "#dcd7ba"
        },
        workspaceColors: [
          "#c34043",
          // red
          "#dca561",
          // yellow
          "#76946a",
          // green
          "#6a9589",
          // teal
          "#7e9cd8",
          // blue
          "#957fb8",
          // purple
          "#7fb4ca",
          // cyan
          "#dcd7ba"
          // light
        ]
      },
      {
        id: "everforest",
        name: "Everforest",
        blurb: "everforest.nvim dark",
        vars: {
          "--bg": "#2d353b",
          "--bg-alt": "#272e33",
          "--bg-panel": "#343f44",
          "--bg-input": "#3d484d",
          "--bg-hover": "#475258",
          "--border": "#475258",
          "--text": "#d3c6aa",
          "--text-dim": "#b3c0b7",
          "--accent": "#83c092",
          "--accent-dim": "#475258",
          "--on-accent": "#2d353b",
          "--danger": "#e67e80",
          "--success": "#a7c080",
          "--link": "#7fbbb3",
          "--thinking": "#dbbc7f",
          "--provider-openrouter": "#dbbc7f",
          "--provider-google": "#a7c080",
          "--provider-nvidia": "#83c092",
          "--provider-cloudflare": "#7fbbb3",
          "--provider-tokenrouter": "#d699b6",
          "--provider-ollama": "#e69875",
          "--provider-custom": "#d3c6aa"
        },
        workspaceColors: [
          "#e67e80",
          // red
          "#dbbc7f",
          // yellow
          "#a7c080",
          // green
          "#83c092",
          // teal
          "#7fbbb3",
          // blue
          "#d699b6",
          // purple
          "#e69875",
          // orange
          "#d3c6aa"
          // light
        ]
      }
    ];
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
function sanitizeChats(chats2) {
  return chats2.filter((c) => (c.messages?.length ?? 0) > 0).map((c) => {
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
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces: workspaces2, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces: workspaces2, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
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
  const { settings, chats: chats2, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces: workspaces2, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse } = s;
  const seq = ++persistSeq;
  const writes = [
    (async () => {
      if (seq !== persistSeq) return;
      await api.storeSet("chats", sanitizeChats(chats2));
    })()
  ];
  if (s.settingsHydrated) {
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, sttProviderId, sttModel, sttFallbacks, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, embeddingModel, embeddingBaseUrl, subagentModels, cacheTtlMinutes, historyLimit, webSearchAutoFetch, ragWebTtlDays, workspaceColors, pinnedWorkspaces, workspaces: workspaces2, searchPlugins, searchConsole, pinnedChats, scheduleRunsSeen, computerUse });
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
function dedupeChats(chats2) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = chats2.length - 1; i >= 0; i--) {
    const c = chats2[i];
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
        const [settings, chats2] = await Promise.all([
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
        const picked = selectLoadedChats(prevChats, chats2, {
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
        let workspaces2 = Array.isArray(raw.workspaces) ? raw.workspaces.map((w) => ({
          key: String(w?.key ?? workspaceKey(String(w?.root ?? ""))),
          root: typeof w?.root === "string" ? w.root : null,
          label: String(w?.label ?? "").trim() || workspaceLabel(String(w?.root ?? ""))
        })) : [];
        const chatRoots = [...new Set(loadedChats.map((c) => c.root ?? ""))];
        if (workspaces2.length === 0 && chatRoots.length > 0) {
          workspaces2 = chatRoots.map(makeWorkspace);
        } else {
          const known = new Set(workspaces2.map((w) => w.key));
          for (const r of chatRoots) {
            if (!known.has(workspaceKey(r))) workspaces2.push(makeWorkspace(r));
          }
        }
        if (settings == null && get().workspaces.length > 0) {
          const cur = get().workspaces;
          const known = new Set(cur.map((w) => w.key));
          workspaces2 = [...cur];
          for (const r of chatRoots) {
            const k = workspaceKey(r);
            if (!known.has(k)) {
              known.add(k);
              workspaces2.push(makeWorkspace(r));
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
          workspaces: workspaces2,
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
          let workspaces2 = st.workspaces;
          if (!workspaces2.some((w) => w.key === key)) {
            workspaces2 = [...workspaces2, makeWorkspace(root ?? "")];
          }
          const openChatIds = st.openChatIds.includes(activeChatId) ? st.openChatIds : [...st.openChatIds, activeChatId];
          persistOpenState(openChatIds, activeChatId);
          const single = st.visibleChatIds.length <= 1 && leafCount(st.chatTree) <= 1;
          if (single) {
            persistVisibleChats([activeChatId]);
            persistChatTree(null);
            return { workspaces: workspaces2, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: [activeChatId], chatTree: null, rightPanelOpen: false };
          }
          const base = ensureTree(st.chatTree, st.visibleChatIds, st.chatLayout);
          const chatTree = openBeside(base, activeChatId, st.activeChatId, smartAppendDir(st.chatLayout));
          const mirrors = persistTreeMirrors(chatTree, st.chatLayout);
          return { workspaces: workspaces2, chats: [...st.chats, chat], activeChatId, openChatIds, visibleChatIds: mirrors.visibleChatIds, chatWindowSizes: mirrors.chatWindowSizes, chatLayout: mirrors.chatLayout, chatTree, rightPanelOpen: false };
        });
        get().persist();
        return activeChatId;
      },
      createWorkspace: (root) => {
        const key = workspaceKey(root ?? "");
        const ws = makeWorkspace(root ?? "");
        set((s) => {
          const workspaces2 = s.workspaces.some((w) => w.key === key) ? s.workspaces : [...s.workspaces, ws];
          return { workspaces: workspaces2 };
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
          const chats2 = s.chats.filter((c) => c.id !== id);
          const openChatIds = s.openChatIds.filter((cid) => cid !== id);
          let activeChatId = s.activeChatId;
          if (s.activeChatId === id) {
            const idx = s.openChatIds.indexOf(id);
            const remaining = openChatIds;
            activeChatId = remaining[Math.min(Math.max(idx - 1, 0), remaining.length - 1)] ?? chats2[chats2.length - 1]?.id ?? "";
            if (!remaining.includes(activeChatId) && activeChatId) remaining.push(activeChatId);
          }
          const finalOpen = openChatIds.includes(activeChatId) || !activeChatId ? openChatIds : [...openChatIds, activeChatId];
          persistOpenState(finalOpen, activeChatId);
          const validIds = new Set(chats2.map((c) => c.id));
          const baseTree = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          const normalized = normalizeTree(removeChat(baseTree, id), validIds);
          const fallbackVisible = normalizeVisibleChats(s.visibleChatIds.filter((cid) => cid !== id), validIds, activeChatId);
          const chatTree = normalized ?? (fallbackVisible.length > 0 ? buildFromList(fallbackVisible, treeDirFromLayout(s.chatLayout)) : null);
          const mirrors = persistTreeMirrors(chatTree, s.chatLayout);
          const visibleChatIds = mirrors.visibleChatIds.length > 0 ? mirrors.visibleChatIds : fallbackVisible;
          const chatWindowSizes = mirrors.chatWindowSizes;
          return {
            chats: chats2,
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
          const chats2 = s.chats.filter((c) => workspaceKey(c.root ?? "") !== key);
          const workspaces2 = s.workspaces.filter((w) => w.key !== key);
          const doomedIds = new Set(
            s.chats.filter((c) => workspaceKey(c.root ?? "") === key).map((c) => c.id)
          );
          const pinnedWorkspaces = s.pinnedWorkspaces.filter((k) => k !== key);
          const pinnedChats = s.pinnedChats.filter((k) => !doomedIds.has(k));
          const activeChatId = s.chats.some((c) => c.id === s.activeChatId && workspaceKey(c.root ?? "") !== key) ? s.activeChatId : chats2[chats2.length - 1]?.id ?? "";
          const openChatIds = s.openChatIds.filter((cid) => !doomedIds.has(cid));
          if (activeChatId && !openChatIds.includes(activeChatId)) openChatIds.push(activeChatId);
          persistOpenState(openChatIds, activeChatId);
          const validIds = new Set(chats2.map((c) => c.id));
          const baseTreeWs = s.chatTree ?? buildFromList(s.visibleChatIds, treeDirFromLayout(s.chatLayout));
          let pruned = baseTreeWs;
          for (const dead of doomedIds) pruned = removeChat(pruned, dead);
          const normalizedWs = normalizeTree(pruned, validIds);
          const fallbackWs = normalizeVisibleChats(s.visibleChatIds.filter((cid) => !doomedIds.has(cid)), validIds, activeChatId);
          const chatTreeWs = normalizedWs ?? (fallbackWs.length > 0 ? buildFromList(fallbackWs, treeDirFromLayout(s.chatLayout)) : null);
          const mirrorsWs = persistTreeMirrors(chatTreeWs, s.chatLayout);
          const visibleChatIds = mirrorsWs.visibleChatIds.length > 0 ? mirrorsWs.visibleChatIds : fallbackWs;
          return {
            chats: chats2,
            workspaces: workspaces2,
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
          let workspaces2;
          if (targetExists) {
            workspaces2 = s.workspaces.filter((w) => w.key !== key).map((w) => w.key === nextKey ? { ...w, root: nextRoot || null } : w);
          } else {
            workspaces2 = s.workspaces.map(
              (w) => w.key === key ? { ...w, key: nextKey, root: nextRoot || null, label } : w
            );
          }
          const workspaceColors = { ...s.workspaceColors };
          if (workspaceColors[key] !== void 0 && workspaceColors[nextKey] === void 0) {
            workspaceColors[nextKey] = workspaceColors[key];
          }
          delete workspaceColors[key];
          return {
            workspaces: workspaces2,
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
          const chats2 = s.chats.slice();
          chats2[idx] = { ...cur, draft: next };
          return { chats: chats2 };
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
      addMessage: (chatId, message) => {
        const id = uid();
        const full = { ...message, id, createdAt: Date.now() };
        const prev = get().chats.find((c) => c.id === chatId);
        const autoTitle = message.content.slice(0, 48);
        const hasPriorUser = !!prev?.messages.some((m) => m.role === "user");
        const shouldTitle = message.role === "user" && !!prev && !hasPriorUser && prev.title === "New chat" && message.content.trim() !== "";
        set((s) => {
          if (message.role === "user") {
            const st = stackFor(chatId);
            st.redo = [];
          }
          const chats2 = s.chats.map(
            (c) => c.id === chatId ? {
              ...c,
              messages: [...c.messages, full],
              // The sidebar sorts by the most recent message activity: sending
              // a user message, or a completed assistant reply, floats the
              // chat to the top of its group. Streaming assistant deltas stay
              // put mid-run so two concurrent chats don't keep swapping places
              // while the agent streams — the final setStreaming(false) bumps.
              updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c.updatedAt,
              title: c.messages.length === 0 && message.role === "user" ? message.content.slice(0, 48) : c.title
            } : c
          );
          return { chats: chats2 };
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
                text: message.content.slice(0, 1e3),
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

// src/lib/time.ts
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

// src/lib/shortcuts.ts
function shouldFocusSearch(e) {
  return !e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}
var init_shortcuts = __esm({
  "src/lib/shortcuts.ts"() {
    "use strict";
  }
});

// src/lib/chatWindowMeta.ts
function workspaceBaseName(root) {
  if (!root) return "No project";
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return "No project";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
function workspaceKeyFor(root) {
  return (root ?? "") || "__none__";
}
function workspaceDisplayFor(chatRoot, workspaces2, workspaceColors) {
  const key = workspaceKeyFor(chatRoot ?? "");
  const ws = workspaces2.find((w) => w.key === key);
  const label = ws?.label || workspaceBaseName(chatRoot ?? "");
  const root = ws?.root ?? (chatRoot ?? null);
  const color = workspaceColors[key] || "var(--accent)";
  return { key, label, color, root };
}
var init_chatWindowMeta = __esm({
  "src/lib/chatWindowMeta.ts"() {
    "use strict";
  }
});

// src/components/WindowStripCluster.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function WindowStripCluster() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root
  );
  const workspaces2 = useStore((s) => s.workspaces);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const ws = workspaceDisplayFor(activeChatRoot, workspaces2, workspaceColors);
  const dir = useStore((s) => s.dir);
  return /* @__PURE__ */ jsxs("span", { className: "window-strip-cluster", children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        className: "icon-btn titlebar-icon-btn",
        "aria-label": sidebarOpen ? "Hide sidebar (\u2318B)" : "Show sidebar (\u2318B)",
        title: sidebarOpen ? "Hide sidebar (\u2318B)" : "Show sidebar (\u2318B)",
        "aria-pressed": sidebarOpen,
        onClick: () => useStore.getState().toggleSidebar(),
        children: /* @__PURE__ */ jsx("svg", { width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", children: /* @__PURE__ */ jsx("path", { d: "M4 6h16M4 12h16M4 18h10" }) })
      }
    ),
    /* @__PURE__ */ jsxs(
      "button",
      {
        className: "workspace-btn",
        "aria-label": "Open workspace folder",
        title: ws.root ? `${ws.label} \u2014 ${ws.root}` : "No workspace open \u2014 pick a folder for this chat",
        style: { "--ws": ws.color },
        onClick: () => void window.coder.selectFolder().then((d) => {
          if (!d) return;
          const st = useStore.getState();
          st.setChatRoot(st.activeChatId, d);
        }),
        children: [
          /* @__PURE__ */ jsx("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }) }),
          /* @__PURE__ */ jsx("i", { className: "workspace-btn-dot", "aria-hidden": "true" }),
          /* @__PURE__ */ jsx("span", { className: "workspace-btn-label", children: ws.root ? ws.label : "Open workspace" })
        ]
      }
    ),
    /* @__PURE__ */ jsx(
      "button",
      {
        className: "titlebar-icon-btn dir-text-btn",
        onClick: () => useStore.getState().toggleDir(),
        title: dir === "rtl" ? "Right-to-left \u2014 click for LTR" : "Left-to-right \u2014 click for RTL",
        children: dir === "rtl" ? "RTL" : "LTR"
      }
    )
  ] });
}
var init_WindowStripCluster = __esm({
  "src/components/WindowStripCluster.tsx"() {
    "use strict";
    init_store();
    init_chatWindowMeta();
  }
});

// src/components/Sidebar.tsx
var Sidebar_exports = {};
__export(Sidebar_exports, {
  Sidebar: () => Sidebar,
  buildGroups: () => buildGroups,
  toggleGroupSelection: () => toggleGroupSelection,
  useStore: () => useStore
});
import { useEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function titleOf(chat) {
  if (chat.title && chat.title !== "New chat") return chat.title;
  if ("firstUser" in chat && typeof chat.firstUser === "string") {
    return chat.firstUser ? chat.firstUser : "New chat";
  }
  const firstUser = chat.messages.find((m) => m.role === "user");
  return firstUser ? firstUser.content.slice(0, 48) : "New chat";
}
function rootName(root) {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || root;
}
function buildGroups(chats2, workspaces2, pinnedWorkspaces, pinnedChats) {
  const chatsByRoot = /* @__PURE__ */ new Map();
  for (const c of chats2) {
    const key = workspaceKey(c.root ?? "");
    if (!chatsByRoot.has(key)) chatsByRoot.set(key, []);
    chatsByRoot.get(key).push(c);
  }
  const pinRankChat = (id) => {
    const i = pinnedChats.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  const sortChats = (list) => {
    list.sort((a, b) => {
      const ar = pinRankChat(a.id);
      const br = pinRankChat(b.id);
      if (ar !== br) return ar - br;
      return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
    });
  };
  const groups = [];
  for (const ws of workspaces2) {
    const list = chatsByRoot.get(ws.key) ?? [];
    sortChats(list);
    if (!ws.root && list.length === 0) {
      chatsByRoot.delete(ws.key);
      continue;
    }
    groups.push({
      key: ws.key,
      label: ws.label || (ws.root ? rootName(ws.root) : "No project"),
      root: ws.root,
      chats: list
    });
    chatsByRoot.delete(ws.key);
  }
  const pinRank = (key) => {
    const i = pinnedWorkspaces.indexOf(key);
    return i === -1 ? Infinity : i;
  };
  const leftovers = [...chatsByRoot.entries()].map(([key, list]) => {
    sortChats(list);
    const root = list.find((c) => c.root)?.root ?? "";
    return {
      key,
      label: root ? rootName(root) : "No project",
      root: root || null,
      chats: list
    };
  });
  leftovers.sort((a, b) => {
    const ar = pinRank(a.key);
    const br = pinRank(b.key);
    if (ar !== br) return ar - br;
    const aLatest = Math.max(...a.chats.map((c) => c.updatedAt), 0);
    const bLatest = Math.max(...b.chats.map((c) => c.updatedAt), 0);
    return bLatest - aLatest;
  });
  const ordered = [...groups, ...leftovers];
  ordered.sort((a, b) => {
    const ar = pinRank(a.key);
    const br = pinRank(b.key);
    if (ar !== br) return ar - br;
    return 0;
  });
  return ordered;
}
function toggleGroupSelection(prev, groupIds) {
  const next = new Set(prev);
  const allSelected = groupIds.length > 0 && groupIds.every((id) => next.has(id));
  if (allSelected) {
    groupIds.forEach((id) => next.delete(id));
  } else {
    groupIds.forEach((id) => next.add(id));
  }
  return next;
}
function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  if (!open) return null;
  return /* @__PURE__ */ jsx2(SidebarContent, {});
}
function SidebarContent() {
  const chats2 = useStore(
    (s) => (
      // Empty (message-less) chats are in-memory tabs only until the first
      // message is sent — never sidebar rows, never files on disk.
      s.chats.filter((c) => (c.messages?.length ?? 0) > 0).map((c) => ({
        id: c.id,
        title: c.title,
        root: c.root ?? "",
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        hasStreaming: c.messages.some(
          (m) => m.streaming || m.retry?.reconnecting === true
        ),
        pendingPermission: c.pendingPermission ? {
          action: c.pendingPermission.action,
          path: c.pendingPermission.path
        } : null,
        pendingAsk: c.pendingAsk ? { question: c.pendingAsk.question } : null,
        firstUser: (() => {
          const m = c.messages.find((x) => x.role === "user");
          return m ? m.content.slice(0, 48) : "";
        })()
      }))
    )
  );
  const workspaces2 = useStore((s) => s.workspaces);
  const activeChatId = useStore((s) => s.activeChatId);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const theme = useStore((s) => s.theme);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const pinnedChats = useStore((s) => s.pinnedChats);
  const unreadChats = useStore((s) => s.unreadChats);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 3e4);
    return () => clearInterval(id);
  }, []);
  const [savedUi] = useState(() => {
    try {
      const raw = localStorage.getItem("coder:sidebarUi");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [collapsed, setCollapsed] = useState(
    () => new Set(savedUi.collapsedGroups ?? [])
  );
  const [colorOpen, setColorOpen] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef(null);
  const [selectedChats, setSelectedChats] = useState(/* @__PURE__ */ new Set());
  const toggleChatSelected = (id) => {
    setSelectedChats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelected = () => setSelectedChats(/* @__PURE__ */ new Set());
  const [menuOpenId, setMenuOpenId] = useState(null);
  useEffect(() => {
    if (!menuOpenId) return;
    const onDocClick = (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(".chat-item-kebab-wrap") && !t.closest(".chat-item-menu")) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpenId]);
  const [wsMenuOpenKey, setWsMenuOpenKey] = useState(null);
  const [wsMenuPos, setWsMenuPos] = useState(null);
  const [deleteMenuKey, setDeleteMenuKey] = useState(null);
  const [deleteMenuPos, setDeleteMenuPos] = useState(null);
  const [selectingWsKey, setSelectingWsKey] = useState(null);
  const [renamingWsKey, setRenamingWsKey] = useState(null);
  const [wsRenameValue, setWsRenameValue] = useState("");
  const commitWsRename = () => {
    if (renamingWsKey) {
      const v = wsRenameValue.trim();
      if (v) useStore.getState().renameWorkspace(renamingWsKey, v);
    }
    setRenamingWsKey(null);
    setWsRenameValue("");
  };
  useEffect(() => {
    if (!wsMenuOpenKey && !deleteMenuKey) return;
    const onDocClick = (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(".ws-menu-wrap") && !t.closest(".ws-delete-menu-wrap") && !t.closest(".ws-menu") && !t.closest(".ws-delete-menu")) {
        setWsMenuOpenKey(null);
        setDeleteMenuKey(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [wsMenuOpenKey, deleteMenuKey]);
  useEffect(() => {
    const onKey = (e) => {
      if (shouldFocusSearch(e)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const dir = useStore((s) => s.dir);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          "coder:sidebarUi",
          JSON.stringify({ collapsedGroups: [...collapsed] })
        );
      } catch {
      }
    }, 250);
    return () => clearTimeout(t);
  }, [collapsed]);
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(
          "coder:sidebarUi",
          JSON.stringify({ collapsedGroups: [...collapsed] })
        );
      } catch {
      }
    };
    window.addEventListener("coder:flush-ui", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("coder:flush-ui", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [collapsed]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("coder:sidebarWidth");
    const n = saved ? parseInt(saved, 10) : 264;
    return Number.isFinite(n) ? Math.max(180, Math.min(480, n)) : 264;
  });
  const sidebarDrag = useRef(null);
  const sidebarDragCleanup = useRef(null);
  useEffect(() => {
    return () => {
      sidebarDragCleanup.current?.();
      sidebarDragCleanup.current = null;
    };
  }, []);
  const startSidebarResize = (e) => {
    e.preventDefault();
    sidebarDrag.current = { startX: e.clientX, startW: sidebarWidth };
    const onMove = (ev) => {
      if (!sidebarDrag.current) return;
      const w = Math.max(
        180,
        Math.min(
          480,
          sidebarDrag.current.startW + (ev.clientX - sidebarDrag.current.startX)
        )
      );
      setSidebarWidth(w);
      localStorage.setItem("coder:sidebarWidth", String(w));
    };
    const onUp = () => {
      sidebarDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarDragCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    sidebarDragCleanup.current = onUp;
  };
  const groups = useMemo(
    () => buildGroups(chats2, workspaces2, pinnedWorkspaces, pinnedChats),
    [chats2, workspaces2, pinnedWorkspaces, pinnedChats]
  );
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debouncedSearch.trim().length > 0;
  const matchesQuery = (chat, q) => {
    const query = q.trim().toLowerCase();
    if (!query) return true;
    if ((chat.title || "").toLowerCase().includes(query)) return true;
    return chat.firstUser.toLowerCase().includes(query);
  };
  const visibleGroups = useMemo(
    () => searching ? groups.map((g) => ({
      ...g,
      chats: g.chats.filter((c) => matchesQuery(c, debouncedSearch))
    })).filter((g) => g.chats.length > 0) : groups,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, searching, debouncedSearch]
  );
  const newWorkspace = async () => {
    const dir2 = await api.selectFolder();
    if (dir2) useStore.getState().createWorkspace(dir2);
  };
  const onDragStart = (e, key) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
    }
  };
  const onDragOver = (e, key) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  };
  const onDrop = (e, targetKey) => {
    e.preventDefault();
    const from = dragKey || e.dataTransfer.getData("text/plain") || "";
    setDragKey(null);
    setDragOverKey(null);
    if (!from || from === targetKey) return;
    const keys = groups.map((g) => g.key);
    const i = keys.indexOf(from);
    const j = keys.indexOf(targetKey);
    if (i === -1) return;
    keys.splice(i, 1);
    keys.splice(j, 0, from);
    useStore.getState().setWorkspaceOrder(keys);
  };
  const onDragEnd = () => {
    setDragKey(null);
    setDragOverKey(null);
  };
  const toggleGroup = (key) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const startRename = (chat) => {
    setRenamingId(chat.id);
    setRenameValue(titleOf(chat) === "New chat" ? "" : titleOf(chat));
  };
  const commitRename = () => {
    if (renamingId)
      useStore.getState().renameChat(renamingId, renameValue.trim() || "New chat");
    setRenamingId(null);
  };
  return /* @__PURE__ */ jsxs2(
    "aside",
    {
      className: "sidebar",
      style: {
        flexBasis: sidebarWidth,
        width: sidebarWidth,
        "--sidebar-w": `${sidebarWidth}px`
      },
      children: [
        /* @__PURE__ */ jsx2("div", { className: "sidebar-drag", "aria-hidden": "false", children: /* @__PURE__ */ jsx2(WindowStripCluster, {}) }),
        /* @__PURE__ */ jsx2(
          "div",
          {
            className: "sidebar-resize-handle",
            title: "Drag to resize sidebar",
            onMouseDown: startSidebarResize
          }
        ),
        /* @__PURE__ */ jsxs2("div", { className: "sidebar-head", children: [
          /* @__PURE__ */ jsxs2("div", { className: "sidebar-search-box", children: [
            /* @__PURE__ */ jsxs2(
              "svg",
              {
                className: "sidebar-search-icon",
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: "2",
                strokeLinecap: "round",
                children: [
                  /* @__PURE__ */ jsx2("circle", { cx: "11", cy: "11", r: "7" }),
                  /* @__PURE__ */ jsx2("path", { d: "M21 21l-4.3-4.3" })
                ]
              }
            ),
            /* @__PURE__ */ jsx2(
              "input",
              {
                ref: searchInputRef,
                className: "sidebar-search-input",
                type: "text",
                placeholder: "Search chats\u2026",
                value: search,
                onChange: (e) => setSearch(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Escape") setSearch("");
                },
                spellCheck: false,
                dir
              }
            ),
            search && /* @__PURE__ */ jsx2(
              "button",
              {
                className: "sidebar-search-clear",
                title: "Clear search",
                onClick: () => setSearch(""),
                children: /* @__PURE__ */ jsx2(
                  "svg",
                  {
                    width: "11",
                    height: "11",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: "2.4",
                    strokeLinecap: "round",
                    children: /* @__PURE__ */ jsx2("path", { d: "M18 6L6 18M6 6l12 12" })
                  }
                )
              }
            )
          ] }),
          /* @__PURE__ */ jsx2("div", { className: "sidebar-head-actions", children: /* @__PURE__ */ jsx2(
            "button",
            {
              className: "sidebar-head-btn",
              title: "New workspace",
              onClick: newWorkspace,
              children: /* @__PURE__ */ jsx2(
                "svg",
                {
                  width: "14",
                  height: "14",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2.4",
                  strokeLinecap: "round",
                  children: /* @__PURE__ */ jsx2("path", { d: "M12 5v14M5 12h14" })
                }
              )
            }
          ) })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "sidebar-list", children: [
          colorOpen !== null && /* @__PURE__ */ jsx2("div", { className: "color-backdrop", onClick: () => setColorOpen(null) }),
          chats2.length === 0 && /* @__PURE__ */ jsx2("div", { className: "sidebar-empty", children: "No conversations yet" }),
          searching && chats2.length > 0 && visibleGroups.length === 0 && /* @__PURE__ */ jsxs2("div", { className: "sidebar-empty", children: [
            "No chats match \u201C",
            search.trim(),
            "\u201D"
          ] }),
          searching && visibleGroups.length > 0 && /* @__PURE__ */ jsxs2("div", { className: "sidebar-result-count", children: [
            visibleGroups.reduce((n, g) => n + g.chats.length, 0),
            " chats found"
          ] }),
          visibleGroups.map((g) => {
            const isCollapsed = collapsed.has(g.key) && !searching;
            const color = workspaceColors[g.key] || "var(--accent)";
            const isPinned = pinnedWorkspaces.includes(g.key);
            const selectedInGroup = g.chats.filter(
              (c) => selectedChats.has(c.id)
            ).length;
            return /* @__PURE__ */ jsxs2(
              "div",
              {
                className: `sidebar-group${isPinned ? " pinned" : ""} ws-colored${dragKey === g.key ? " dragging" : ""}${dragOverKey === g.key && dragKey && dragKey !== g.key ? " drop-target" : ""}`,
                style: { "--ws": color },
                draggable: true,
                onDragStart: (e) => onDragStart(e, g.key),
                onDragOver: (e) => onDragOver(e, g.key),
                onDrop: (e) => onDrop(e, g.key),
                onDragEnd,
                children: [
                  /* @__PURE__ */ jsxs2("div", { className: "sidebar-group-head", children: [
                    /* @__PURE__ */ jsxs2(
                      "button",
                      {
                        className: "sidebar-group-toggle",
                        onClick: () => toggleGroup(g.key),
                        title: g.root || g.label,
                        children: [
                          /* @__PURE__ */ jsx2(
                            "svg",
                            {
                              className: `sidebar-group-icon${isCollapsed ? " collapsed" : ""}`,
                              style: { color },
                              width: "17",
                              height: "17",
                              viewBox: "0 0 24 24",
                              fill: isCollapsed ? "currentColor" : "none",
                              stroke: "currentColor",
                              strokeWidth: isCollapsed ? 0 : 1.9,
                              strokeLinecap: "round",
                              strokeLinejoin: "round",
                              children: isCollapsed ? /* @__PURE__ */ jsx2("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" }) : /* @__PURE__ */ jsxs2(Fragment, { children: [
                                /* @__PURE__ */ jsx2("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" }),
                                /* @__PURE__ */ jsx2("path", { d: "M2 9a2 2 0 0 1 2-2h7.5l2 2H21a2 2 0 0 1 2 2v1H2Z" })
                              ] })
                            }
                          ),
                          renamingWsKey === g.key ? /* @__PURE__ */ jsx2(
                            "input",
                            {
                              className: "ws-rename-input",
                              autoFocus: true,
                              value: wsRenameValue,
                              onChange: (e) => setWsRenameValue(e.target.value),
                              onBlur: commitWsRename,
                              onKeyDown: (e) => {
                                if (e.key === "Enter") commitWsRename();
                                else if (e.key === "Escape") {
                                  setRenamingWsKey(null);
                                  setWsRenameValue("");
                                }
                              },
                              onClick: (e) => e.stopPropagation()
                            }
                          ) : /* @__PURE__ */ jsx2("span", { className: "sidebar-group-label", children: g.label })
                        ]
                      }
                    ),
                    /* @__PURE__ */ jsxs2("div", { className: "sidebar-group-actions", children: [
                      /* @__PURE__ */ jsx2(
                        "button",
                        {
                          className: "sidebar-group-btn",
                          title: "New chat in this workspace",
                          "aria-label": "New chat in this workspace",
                          style: selectingWsKey === g.key ? { display: "none" } : void 0,
                          onClick: (e) => {
                            e.stopPropagation();
                            useStore.getState().newChatInRoot(g.root ?? g.key);
                          },
                          children: /* @__PURE__ */ jsx2(
                            "svg",
                            {
                              width: "16",
                              height: "16",
                              viewBox: "0 0 24 24",
                              fill: "none",
                              stroke: "currentColor",
                              strokeWidth: "2.2",
                              strokeLinecap: "round",
                              children: /* @__PURE__ */ jsx2("path", { d: "M12 5v14M5 12h14" })
                            }
                          )
                        }
                      ),
                      /* @__PURE__ */ jsxs2("div", { className: "ws-menu-wrap", style: selectingWsKey === g.key ? { display: "none" } : void 0, children: [
                        /* @__PURE__ */ jsx2(
                          "button",
                          {
                            className: "sidebar-group-btn",
                            title: "Workspace options",
                            "aria-label": "Workspace options",
                            "aria-expanded": wsMenuOpenKey === g.key,
                            onClick: (e) => {
                              e.stopPropagation();
                              const next = wsMenuOpenKey === g.key ? null : g.key;
                              setWsMenuOpenKey(next);
                              if (next) {
                                const r = e.currentTarget.getBoundingClientRect();
                                setWsMenuPos({ top: r.bottom + 6, left: r.right - 168 });
                              } else {
                                setWsMenuPos(null);
                              }
                            },
                            children: /* @__PURE__ */ jsxs2(
                              "svg",
                              {
                                width: "16",
                                height: "16",
                                viewBox: "0 0 24 24",
                                fill: "currentColor",
                                children: [
                                  /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "5", r: "1.6" }),
                                  /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "12", r: "1.6" }),
                                  /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "19", r: "1.6" })
                                ]
                              }
                            )
                          }
                        ),
                        wsMenuOpenKey === g.key && wsMenuPos && /* @__PURE__ */ jsxs2(
                          "div",
                          {
                            className: "ws-menu",
                            role: "menu",
                            style: {
                              position: "fixed",
                              top: wsMenuPos.top,
                              left: wsMenuPos.left
                            },
                            onMouseDown: (e) => e.stopPropagation(),
                            children: [
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: `ws-menu-btn${isPinned ? " active" : ""}`,
                                  role: "menuitem",
                                  onClick: () => {
                                    useStore.getState().togglePinWorkspace(g.key);
                                    setWsMenuOpenKey(null);
                                  },
                                  children: [
                                    /* @__PURE__ */ jsx2("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: isPinned ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx2("path", { d: "M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" }) }),
                                    isPinned ? "Unpin" : "Pin to top"
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-menu-btn",
                                  role: "menuitem",
                                  onClick: () => {
                                    setRenamingWsKey(g.key);
                                    setWsRenameValue(g.label);
                                    setWsMenuOpenKey(null);
                                  },
                                  children: [
                                    /* @__PURE__ */ jsx2("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx2("path", { d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" }) }),
                                    "Rename"
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-menu-btn",
                                  role: "menuitem",
                                  onClick: () => {
                                    setColorOpen(colorOpen === g.key ? null : g.key);
                                    setWsMenuOpenKey(null);
                                  },
                                  children: [
                                    /* @__PURE__ */ jsxs2("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [
                                      /* @__PURE__ */ jsx2("circle", { cx: "13.5", cy: "6.5", r: "1.2", fill: "currentColor" }),
                                      /* @__PURE__ */ jsx2("circle", { cx: "17.5", cy: "10.5", r: "1.2", fill: "currentColor" }),
                                      /* @__PURE__ */ jsx2("circle", { cx: "8.5", cy: "7.5", r: "1.2", fill: "currentColor" }),
                                      /* @__PURE__ */ jsx2("circle", { cx: "6.5", cy: "12.5", r: "1.2", fill: "currentColor" }),
                                      /* @__PURE__ */ jsx2("path", { d: "M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.7 1.7-1.7H17a3 3 0 0 0 3-3c0-4.4-4-8-8-8z" })
                                    ] }),
                                    "Color"
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-menu-btn",
                                  role: "menuitem",
                                  title: g.root || "No folder set",
                                  onClick: () => {
                                    setWsMenuOpenKey(null);
                                    void api.selectFolder().then((dir2) => {
                                      if (dir2) useStore.getState().moveWorkspace(g.key, dir2);
                                    });
                                  },
                                  children: [
                                    /* @__PURE__ */ jsxs2("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
                                      /* @__PURE__ */ jsx2("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" }),
                                      /* @__PURE__ */ jsx2("path", { d: "M2 9a2 2 0 0 1 2-2h7.5l2 2H21a2 2 0 0 1 2 2v1H2Z" })
                                    ] }),
                                    "Change folder\u2026"
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-menu-btn danger",
                                  role: "menuitem",
                                  onClick: (e) => {
                                    const btn = e.currentTarget.closest(".ws-menu-wrap")?.querySelector(".sidebar-group-btn");
                                    const r = (btn ?? e.currentTarget).getBoundingClientRect();
                                    setDeleteMenuPos({ top: r.bottom + 6, left: r.right - 180 });
                                    setDeleteMenuKey(g.key);
                                    setWsMenuOpenKey(null);
                                  },
                                  children: [
                                    /* @__PURE__ */ jsx2("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx2("path", { d: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" }) }),
                                    "Delete"
                                  ]
                                }
                              )
                            ]
                          }
                        )
                      ] })
                    ] }),
                    colorOpen === g.key && /* @__PURE__ */ jsxs2(
                      "div",
                      {
                        className: "color-popover",
                        onClick: (e) => e.stopPropagation(),
                        children: [
                          themeById(theme).workspaceColors.map((c2) => /* @__PURE__ */ jsx2(
                            "button",
                            {
                              className: "color-swatch",
                              style: { background: c2 },
                              onClick: () => {
                                useStore.getState().setWorkspaceColor(g.key, c2);
                                setColorOpen(null);
                              }
                            },
                            c2
                          )),
                          /* @__PURE__ */ jsx2(
                            "button",
                            {
                              className: "color-none",
                              title: "Remove color",
                              onClick: () => {
                                useStore.getState().setWorkspaceColor(g.key, "");
                                setColorOpen(null);
                              },
                              children: "\u2715"
                            }
                          )
                        ]
                      }
                    ),
                    deleteMenuKey === g.key && deleteMenuPos && /* @__PURE__ */ jsx2(
                      "div",
                      {
                        className: "ws-delete-menu-wrap",
                        style: {
                          position: "fixed",
                          top: deleteMenuPos.top,
                          left: deleteMenuPos.left
                        },
                        onMouseDown: (e) => e.stopPropagation(),
                        onClick: (e) => e.stopPropagation(),
                        children: /* @__PURE__ */ jsxs2(
                          "div",
                          {
                            className: "ws-delete-menu",
                            role: "menu",
                            onMouseDown: (e) => e.stopPropagation(),
                            children: [
                              /* @__PURE__ */ jsx2("div", { className: "ws-delete-menu-title", children: "Delete\u2026" }),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-delete-menu-btn danger",
                                  role: "menuitem",
                                  onClick: () => {
                                    useStore.getState().deleteWorkspace(g.key);
                                    setDeleteMenuKey(null);
                                  },
                                  children: [
                                    "Delete workspace",
                                    /* @__PURE__ */ jsxs2("span", { style: { opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }, children: [
                                      "(",
                                      g.chats.length,
                                      ")"
                                    ] })
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsxs2(
                                "button",
                                {
                                  className: "ws-delete-menu-btn",
                                  role: "menuitem",
                                  onClick: () => {
                                    setSelectingWsKey(g.key);
                                    setDeleteMenuKey(null);
                                  },
                                  children: [
                                    "Delete chats",
                                    /* @__PURE__ */ jsxs2("span", { style: { opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }, children: [
                                      "(",
                                      g.chats.length,
                                      ")"
                                    ] })
                                  ]
                                }
                              )
                            ]
                          }
                        )
                      }
                    ),
                    selectingWsKey === g.key && /* @__PURE__ */ jsxs2("div", { className: "group-bulk-actions", children: [
                      /* @__PURE__ */ jsx2(
                        "button",
                        {
                          className: "group-select-all",
                          title: selectedInGroup === g.chats.length && g.chats.length > 0 ? "Deselect all" : "Select all",
                          "aria-label": selectedInGroup === g.chats.length && g.chats.length > 0 ? "Deselect all chats" : "Select all chats",
                          "aria-pressed": g.chats.length > 0 && selectedInGroup === g.chats.length,
                          onClick: () => {
                            setSelectedChats(
                              (prev) => toggleGroupSelection(
                                prev,
                                g.chats.map((c) => c.id)
                              )
                            );
                          },
                          children: /* @__PURE__ */ jsxs2(
                            "svg",
                            {
                              width: "13",
                              height: "13",
                              viewBox: "0 0 24 24",
                              fill: "none",
                              stroke: "currentColor",
                              strokeWidth: "2.2",
                              strokeLinecap: "round",
                              strokeLinejoin: "round",
                              children: [
                                g.chats.length > 0 && selectedInGroup === g.chats.length ? /* @__PURE__ */ jsx2("path", { d: "M9 11l3 3L22 4" }) : null,
                                /* @__PURE__ */ jsx2("path", { d: "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" })
                              ]
                            }
                          )
                        }
                      ),
                      /* @__PURE__ */ jsxs2(
                        "button",
                        {
                          className: "group-delete-selected",
                          title: `Delete ${selectedInGroup} selected conversation(s)`,
                          onClick: () => {
                            const ids = g.chats.map((c) => c.id).filter((id) => selectedChats.has(id));
                            if (ids.length === 0) return;
                            ids.forEach(
                              (id) => useStore.getState().deleteChat(id)
                            );
                            setSelectedChats((prev) => {
                              const next = new Set(prev);
                              ids.forEach((id) => next.delete(id));
                              return next;
                            });
                            setSelectingWsKey(null);
                          },
                          children: [
                            /* @__PURE__ */ jsx2(
                              "svg",
                              {
                                width: "13",
                                height: "13",
                                viewBox: "0 0 24 24",
                                fill: "none",
                                stroke: "currentColor",
                                strokeWidth: "2.2",
                                strokeLinecap: "round",
                                strokeLinejoin: "round",
                                children: /* @__PURE__ */ jsx2("path", { d: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" })
                              }
                            ),
                            selectedInGroup
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        "button",
                        {
                          className: "group-cancel-select",
                          title: "Cancel selection",
                          "aria-label": "Cancel selection",
                          onClick: () => {
                            setSelectingWsKey(null);
                            clearSelected();
                          },
                          children: /* @__PURE__ */ jsx2(
                            "svg",
                            {
                              width: "12",
                              height: "12",
                              viewBox: "0 0 24 24",
                              fill: "none",
                              stroke: "currentColor",
                              strokeWidth: "2.4",
                              strokeLinecap: "round",
                              children: /* @__PURE__ */ jsx2("path", { d: "M6 6l12 12M18 6L6 18" })
                            }
                          )
                        }
                      )
                    ] })
                  ] }),
                  !isCollapsed && /* @__PURE__ */ jsx2(
                    "div",
                    {
                      className: "sidebar-group-chats",
                      style: color ? { "--ws": color } : void 0,
                      children: g.chats.map((c) => {
                        const isPinnedChat = pinnedChats.includes(c.id);
                        const hasStreaming = c.hasStreaming;
                        const hasUnread = !hasStreaming && c.id !== activeChatId && unreadChats.includes(c.id);
                        return /* @__PURE__ */ jsxs2(
                          "div",
                          {
                            className: `chat-item ${c.id === activeChatId ? "active" : ""}${isPinnedChat ? " pinned" : ""}${hasUnread ? " unread" : ""}${selectedChats.has(c.id) ? " selected" : ""}${selectingWsKey === g.key ? " selecting" : ""}`,
                            draggable: true,
                            onDragStart: (e) => {
                              try {
                                e.dataTransfer.setData("application/x-coder-chat-id", c.id);
                              } catch {
                              }
                              try {
                                e.dataTransfer.setData("text/plain", c.id);
                              } catch {
                              }
                              e.dataTransfer.effectAllowed = "move";
                            },
                            onClick: () => useStore.getState().openChat(c.id),
                            title: prepareContent(titleOf(c), dir),
                            children: [
                              selectingWsKey === g.key ? /* @__PURE__ */ jsx2("div", { className: "chat-item-select-wrap", children: /* @__PURE__ */ jsx2(
                                "input",
                                {
                                  type: "checkbox",
                                  className: "chat-select-checkbox",
                                  checked: selectedChats.has(c.id),
                                  onClick: (e) => e.stopPropagation(),
                                  onChange: () => toggleChatSelected(c.id),
                                  title: "Select this chat"
                                }
                              ) }) : /* @__PURE__ */ jsxs2(
                                "div",
                                {
                                  className: `chat-item-kebab-wrap${menuOpenId === c.id ? " open" : ""}`,
                                  children: [
                                    /* @__PURE__ */ jsx2(
                                      "button",
                                      {
                                        className: "chat-item-kebab",
                                        title: "Chat actions",
                                        "aria-label": "Chat actions",
                                        "aria-expanded": menuOpenId === c.id,
                                        onClick: (e) => {
                                          e.stopPropagation();
                                          setMenuOpenId(menuOpenId === c.id ? null : c.id);
                                        },
                                        children: /* @__PURE__ */ jsxs2(
                                          "svg",
                                          {
                                            width: "14",
                                            height: "14",
                                            viewBox: "0 0 24 24",
                                            fill: "currentColor",
                                            children: [
                                              /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "5", r: "1.6" }),
                                              /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "12", r: "1.6" }),
                                              /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "19", r: "1.6" })
                                            ]
                                          }
                                        )
                                      }
                                    ),
                                    /* @__PURE__ */ jsxs2(
                                      "div",
                                      {
                                        className: `chat-item-menu${menuOpenId === c.id ? " open" : ""}`,
                                        role: "menu",
                                        onMouseDown: (e) => e.stopPropagation(),
                                        onClick: (e) => e.stopPropagation(),
                                        children: [
                                          /* @__PURE__ */ jsxs2(
                                            "button",
                                            {
                                              className: `chat-item-menu-btn${isPinnedChat ? " active" : ""}`,
                                              role: "menuitem",
                                              onClick: () => {
                                                useStore.getState().togglePinChat(c.id);
                                                setMenuOpenId(null);
                                              },
                                              children: [
                                                /* @__PURE__ */ jsx2(
                                                  "svg",
                                                  {
                                                    width: "13",
                                                    height: "13",
                                                    viewBox: "0 0 24 24",
                                                    fill: isPinnedChat ? "currentColor" : "none",
                                                    stroke: "currentColor",
                                                    strokeWidth: "2",
                                                    strokeLinecap: "round",
                                                    strokeLinejoin: "round",
                                                    children: /* @__PURE__ */ jsx2("path", { d: "M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" })
                                                  }
                                                ),
                                                isPinnedChat ? "Unpin" : "Pin to top"
                                              ]
                                            }
                                          ),
                                          /* @__PURE__ */ jsxs2(
                                            "button",
                                            {
                                              className: "chat-item-menu-btn",
                                              role: "menuitem",
                                              onClick: () => {
                                                startRename(c);
                                                setMenuOpenId(null);
                                              },
                                              children: [
                                                /* @__PURE__ */ jsx2(
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
                                                    children: /* @__PURE__ */ jsx2("path", { d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" })
                                                  }
                                                ),
                                                "Rename"
                                              ]
                                            }
                                          ),
                                          /* @__PURE__ */ jsxs2(
                                            "button",
                                            {
                                              className: "chat-item-menu-btn danger",
                                              role: "menuitem",
                                              onClick: () => {
                                                useStore.getState().deleteChat(c.id);
                                                setMenuOpenId(null);
                                              },
                                              children: [
                                                /* @__PURE__ */ jsx2(
                                                  "svg",
                                                  {
                                                    width: "13",
                                                    height: "13",
                                                    viewBox: "0 0 24 24",
                                                    fill: "none",
                                                    stroke: "currentColor",
                                                    strokeWidth: "2.2",
                                                    strokeLinecap: "round",
                                                    strokeLinejoin: "round",
                                                    children: /* @__PURE__ */ jsx2("path", { d: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" })
                                                  }
                                                ),
                                                "Delete"
                                              ]
                                            }
                                          )
                                        ]
                                      }
                                    )
                                  ]
                                }
                              ),
                              renamingId === c.id ? /* @__PURE__ */ jsx2(
                                "input",
                                {
                                  className: "chat-rename-input",
                                  dir,
                                  autoFocus: true,
                                  value: renameValue,
                                  onChange: (e) => setRenameValue(e.target.value),
                                  onBlur: commitRename,
                                  onKeyDown: (e) => {
                                    if (e.key === "Enter") commitRename();
                                    else if (e.key === "Escape") setRenamingId(null);
                                  },
                                  onClick: (e) => e.stopPropagation()
                                }
                              ) : /* @__PURE__ */ jsxs2("span", { className: "chat-item-title-row", dir, children: [
                                /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-title",
                                    onDoubleClick: (e) => {
                                      e.stopPropagation();
                                      startRename(c);
                                    },
                                    children: prepareContent(titleOf(c), dir)
                                  }
                                ),
                                hasStreaming && /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-streaming",
                                    title: "Agent is working in this chat"
                                  }
                                ),
                                hasUnread && /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-unread",
                                    title: "New message from the agent \u2014 click to view"
                                  }
                                ),
                                c.pendingPermission && /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-pending permission",
                                    title: `Needs permission: ${c.pendingPermission.action}${c.pendingPermission.path ? ` \xB7 ${c.pendingPermission.path}` : ""}`,
                                    children: /* @__PURE__ */ jsx2(
                                      "svg",
                                      {
                                        width: "10",
                                        height: "10",
                                        viewBox: "0 0 24 24",
                                        fill: "none",
                                        stroke: "currentColor",
                                        strokeWidth: "2.4",
                                        strokeLinecap: "round",
                                        strokeLinejoin: "round",
                                        children: /* @__PURE__ */ jsx2("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" })
                                      }
                                    )
                                  }
                                ),
                                c.pendingAsk && /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-pending ask",
                                    title: `Asks you: ${c.pendingAsk.question}`,
                                    children: /* @__PURE__ */ jsxs2(
                                      "svg",
                                      {
                                        width: "10",
                                        height: "10",
                                        viewBox: "0 0 24 24",
                                        fill: "none",
                                        stroke: "currentColor",
                                        strokeWidth: "2.6",
                                        strokeLinecap: "round",
                                        strokeLinejoin: "round",
                                        children: [
                                          /* @__PURE__ */ jsx2("circle", { cx: "12", cy: "12", r: "10" }),
                                          /* @__PURE__ */ jsx2("path", { d: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" }),
                                          /* @__PURE__ */ jsx2("path", { d: "M12 17h.01" })
                                        ]
                                      }
                                    )
                                  }
                                ),
                                /* @__PURE__ */ jsx2(
                                  "span",
                                  {
                                    className: "chat-item-time",
                                    title: fmtClockFull(c.updatedAt),
                                    children: /* @__PURE__ */ jsx2("span", { dir: "ltr", children: fmtAgo(c.updatedAt, nowTick) })
                                  }
                                )
                              ] })
                            ]
                          },
                          c.id
                        );
                      })
                    }
                  )
                ]
              },
              g.key
            );
          })
        ] }),
        /* @__PURE__ */ jsx2("div", { className: "sidebar-footer", children: /* @__PURE__ */ jsxs2(
          "button",
          {
            className: "sidebar-foot-btn",
            title: "Settings (\u2318,)",
            onClick: () => useStore.getState().setSettingsOpen(true),
            children: [
              "\u2699\uFE0F",
              /* @__PURE__ */ jsx2("span", { children: "Settings" })
            ]
          }
        ) })
      ]
    }
  );
}
var init_Sidebar = __esm({
  "src/components/Sidebar.tsx"() {
    "use strict";
    init_store();
    init_themes();
    init_fs();
    init_bidi();
    init_time();
    init_shortcuts();
    init_WindowStripCluster();
  }
});

// tests/sidebar.ssr.test.tsx
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
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
var { buildGroups: buildGroups2, toggleGroupSelection: toggleGroupSelection2 } = await Promise.resolve().then(() => (init_Sidebar(), Sidebar_exports));
var workspaces = [{ key: "/demo", label: "Demo", root: "/demo", color: "#4f8" }];
var chats = [
  { id: "c1", root: "/demo", title: "Chat one", messages: [], updatedAt: 2, createdAt: 1 },
  { id: "c2", root: "/demo", title: "Chat two", messages: [], updatedAt: 1, createdAt: 1 }
];
var failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
console.log("\u06F1) \u0647\u062F\u0631 \u06CC\u06A9\u067E\u0627\u0631\u0686\u0647 \u0633\u0627\u06CC\u062F\u0628\u0627\u0631 (\u0633\u0631\u0686 \u0628\u0627\u0644\u0627 + \u062F\u06A9\u0645\u0647\u0654 \u0641\u0634\u0631\u062F\u0647):");
{
  const groups = buildGroups2(chats, workspaces, [], []);
  check("\u06CC\u06A9 \u06AF\u0631\u0648\u0647 \u0633\u0627\u062E\u062A\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F", groups.length === 1, groups.length);
  check("\u06AF\u0631\u0648\u0647 \u0628\u0631\u0686\u0633\u0628 \u062F\u0631\u0633\u062A \u062F\u0627\u0631\u062F", groups[0]?.label === "Demo");
  check("\u06AF\u0631\u0648\u0647 \u06F2 \u0686\u062A \u062F\u0627\u0631\u062F", groups[0]?.chats?.length === 2, groups[0]?.chats?.length);
}
console.log("\u06F2) \u062A\u06CC\u06A9\u200C\u0632\u062F\u0646 \u0686\u0646\u062F\u062A\u0627\u06CC\u06CC \u0686\u062A\u200C\u0647\u0627 \u0648 \u062D\u0630\u0641 \u06CC\u06A9\u200C\u062C\u0627:");
{
  const groups = buildGroups2(chats, workspaces, [], []);
  const group = groups[0];
  check("\u0686\u062A\u200C\u0647\u0627 \u0628\u0631 \u0627\u0633\u0627\u0633 updatedAt \u0645\u0631\u062A\u0628 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F (c1 \u0642\u0628\u0644 \u0627\u0632 c2)", group?.chats?.[0]?.id === "c1");
  check("\u0628\u062F\u0648\u0646 \u0648\u0631\u06A9\u200C\u0627\u0633\u067E\u06CC\u0633 \u067E\u06CC\u0646\u200C\u0634\u062F\u0647\u060C \u06AF\u0631\u0648\u0647 \u067E\u06CC\u0646 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F", groups.every((g) => g.key === "/demo"));
  check("\u0644\u06CC\u0633\u062A \u0686\u062A\u200C\u0647\u0627 \u06A9\u0627\u0645\u0644 \u0627\u0633\u062A (\u0622\u0645\u0627\u062F\u0647 \u0628\u0631\u0627\u06CC \u062D\u0627\u0644\u062A \u0627\u0646\u062A\u062E\u0627\u0628)", group?.chats?.length === 2);
}
console.log("\u06F3) \u0627\u0646\u062A\u062E\u0627\u0628/\u0644\u063A\u0648 \u0647\u0645\u0647 \u0686\u062A\u200C\u0647\u0627\u06CC \u06CC\u06A9 \u0648\u0631\u06A9\u200C\u0627\u0633\u067E\u06CC\u0633:");
{
  const ids = ["c1", "c2"];
  const selectedAll = toggleGroupSelection2(/* @__PURE__ */ new Set(), ids);
  check("\u0627\u0632 \u062D\u0627\u0644\u062A \u062E\u0627\u0644\u06CC\u060C \u0647\u0645\u0647 \u062A\u06CC\u06A9 \u0645\u06CC\u200C\u062E\u0648\u0631\u0646\u062F", selectedAll.has("c1") && selectedAll.has("c2"));
  const deselected = toggleGroupSelection2(selectedAll, ids);
  check("\u062A\u06A9\u0631\u0627\u0631\u060C \u062A\u06CC\u06A9 \u0647\u0645\u0647 \u0631\u0627 \u0628\u0631\u0645\u06CC\u200C\u062F\u0627\u0631\u062F", deselected.size === 0);
  const partial = toggleGroupSelection2(/* @__PURE__ */ new Set(["c1", "other"]), ids);
  check(
    "\u0627\u0646\u062A\u062E\u0627\u0628 \u062C\u0632\u0626\u06CC \u0628\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0627\u0645\u0644 \u0645\u06CC\u200C\u0631\u0633\u062F \u0648 \u06AF\u0631\u0648\u0647 \u062F\u06CC\u06AF\u0631 \u062F\u0633\u062A \u0646\u0645\u06CC\u200C\u062E\u0648\u0631\u062F",
    partial.has("c1") && partial.has("c2") && partial.has("other")
  );
}
if (failed > 0) {
  console.error(`
${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F \u274C`);
  process.exit(1);
}
console.log("\n\u0647\u0645\u0647 \u062A\u0633\u062A\u200C\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F \u2705");
process.exit(0);
