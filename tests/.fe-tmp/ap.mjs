// tests/_globals.ts
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

// tests/artifactPanel.ssr.test.tsx
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";

// src/components/ArtifactPanel.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
var HLJS_LANGUAGES = [
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
var HLJS_BY_NAME = Object.fromEntries(HLJS_LANGUAGES);

// src/lib/fs.ts
var api = {
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
  computerPermissions: () => window.coder.computerPermissions(),
  requestScreenRecording: () => window.coder.requestScreenRecording(),
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

// src/lib/bidi.ts
var PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
var RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
var FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
var DIGITS_RE = `[0-9${FA_DIGITS}]`;
var LINE_RANGE_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*[-\u2013\u2014~]\\s*(${DIGITS_RE}+))?`
);
var LINE_RANGE_CONN_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)\\s+(?:\u062A\u0627|\u0627\u0644\u06CC)\\s+(${DIGITS_RE}+)`
);
var PATH_RE = new RegExp(
  `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`
);
var BARE_RANGE_FENCE_RE = new RegExp(
  "^```\\s*([\\w-]+):(" + DIGITS_RE + "+)-(" + DIGITS_RE + "+)\\s*$"
);
var MIXED_WORD_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);
var SCRIPT_BOUNDARY_RE = new RegExp(
  `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
  "g"
);

// src/lib/context.ts
var PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
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

// src/lib/api.ts
var sidecarUrl = null;
var sidecarInFlight = null;
var SIDECAR_RESOLVE_TIMEOUT_MS = 1e4;
api.onSidecarChanged(() => {
  sidecarUrl = null;
  sidecarInFlight = null;
});
api.onSidecarDead(() => {
  sidecarUrl = null;
  sidecarInFlight = null;
});
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
async function listMcp() {
  const url = await ensureSidecar();
  if (!url) return { mcpServers: {}, builtins: [] };
  try {
    const res = await fetch(`${url}/plugins/mcp`);
    if (!res.ok) return { mcpServers: {}, builtins: [] };
    const data = await res.json();
    const out = {};
    for (const r of data.connectors ?? []) {
      if (!r.name || r.plugin_enabled === false) continue;
      out[r.name] = r.cfg ?? {};
    }
    return { mcpServers: out, builtins: [] };
  } catch {
    return { mcpServers: {}, builtins: [] };
  }
}
async function callMcpTool(tool, args, servers = {}) {
  const name = tool.trim();
  if (!name) return { error: "an MCP tool name is required" };
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const res = await fetch(`${url}/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: name, args, servers })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `mcp call failed (${res.status})` };
    return { result: data.result ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
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
async function getArtifactAssets(chatId, id) {
  const url = await ensureSidecar();
  if (!url) return { error: "the local backend is not ready" };
  try {
    const qs = new URLSearchParams({ chat_id: chatId, id }).toString();
    const res = await fetch(`${url}/artifacts/assets?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.detail || `request failed (${res.status})` };
    return { files: data.files ?? [] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// src/lib/store.ts
import { create } from "zustand";

// src/lib/nvimTerminals.ts
var DEFAULT_NVIM_TERMINAL = "inapp";
var DEFAULT_TERMINAL_SHELL = "zsh";
function resolveNvimTerminal(_v) {
  return DEFAULT_NVIM_TERMINAL;
}

// src/lib/xtermTheme.ts
var DEFAULT_VIEWER_FONT_SIZE = 14;
var DEFAULT_TERMINAL_FONT_SIZE = 14;
function clampCodeFontSize(raw, fallback) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(24, Math.max(9, Math.round(raw)));
}
var liveScreens = /* @__PURE__ */ new Set();
function applyTerminalFontSize(px) {
  for (const s of liveScreens) {
    s.term.options.fontSize = px;
    s.refit();
  }
}

// src/lib/marketplaceDefaults.ts
function marketSourceKey(m) {
  return `${m.repo}\0${m.path ?? ""}\0${m.git_ref ?? ""}`;
}
var RETIRED_MARKETPLACES = ["anthropics/claude-plugins-official"];
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

// src/lib/modes.ts
var BUILTIN_MODES = [
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
var BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
var FALLBACK_MODE = BUILTIN_MODES[0];
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "build";
  return id || "ask";
}

// src/lib/secrets.ts
var PREFIX = "enc:v1:";
var keyPromise = null;
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
var enc = new TextEncoder();
var dec = new TextDecoder();
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

// src/lib/provider-meta.ts
var PROVIDER_META = {
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
var FOREIGN_PROVIDER_PREFIXES = /* @__PURE__ */ new Set([
  ...Object.keys(PROVIDER_META),
  "opencode"
]);

// src/lib/themes.ts
var DEFAULT_THEME = "rose-pine";

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

// src/lib/thinking.ts
var REASONING_PATTERNS = [
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
function supportsReasoning(modelId, kind = "openrouter", reasoning) {
  const id = (modelId || "").trim();
  if (!id) return false;
  if (typeof reasoning === "boolean") return reasoning;
  return REASONING_PATTERNS.some((re) => re.test(id));
}

// src/lib/toolSlots.ts
var OTHER_SLOTS = ["compact", "web", "title"];
var TOOL_FALLBACK_SLOTS = ["explore", "vision", "schedule", ...OTHER_SLOTS];
var MAIN_MODEL_ENTRY = "main model";
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
var MAIN_MODEL_ENTRIES = /* @__PURE__ */ new Set(["", "main", "main_model", "main model"]);
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

// src/lib/toolActivity.ts
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

// src/lib/chatTree.ts
var TREE_KEY = "coder:chatTree";
function nid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clampSize(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}
var CHAT_WINDOW_MAX = 6;
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

// src/lib/store.ts
var MAX_SCHEDULE_RUNS_SEEN = 500;
function normalizeScheduleRunsSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return [...new Set(out)].slice(-MAX_SCHEDULE_RUNS_SEEN);
}
var TITLE_MAX_WORDS = 4;
function capTitleWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS).join(" ");
}
var uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
var MAX_COMPACTED_PER_CHAT = 50;
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
var FORK_SEED_CHARS_PER_MESSAGE = 600;
var FORK_SEED_MAX_CHARS = 4e3;
function forkSeedLine(m) {
  const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Context";
  const flat = m.content.replace(/\s+/g, " ").trim();
  const body = flat.length > FORK_SEED_CHARS_PER_MESSAGE ? `${flat.slice(0, FORK_SEED_CHARS_PER_MESSAGE).trimEnd()}\u2026` : flat;
  return `${who}: ${body}`;
}
function forkSeedMessage(src2, forkIndex) {
  const upto = src2.messages.slice(0, forkIndex + 1).filter((m) => !m.compacted && !m.modeSwitch);
  const lines = [];
  let budget = FORK_SEED_MAX_CHARS;
  for (let i = upto.length - 1; i >= 0; i--) {
    const line = forkSeedLine(upto[i]);
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.unshift(line);
  }
  const body = lines.join("\n");
  const header = src2.title && src2.title !== "New chat" ? src2.title : "Forked conversation";
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
var QUEUED_SENT_GRACE_MS = 10 * 60 * 1e3;
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
var MID_STREAM_MS = 2e3;
var lastMidStreamPersist = 0;
var MAX_TOOL_TEXT = 4e3;
var MAX_TOOL_ARG = 2e3;
var ANTROPIC_SKILLS_MARKETPLACE = {
  repo: "anthropics/skills",
  label: "Anthropic skills",
  kind: "skills"
};
var COMMUNITY_MARKETPLACE = {
  repo: "anthropics/claude-plugins-community",
  label: "Community",
  kind: "mcp"
};
var DEFAULT_MARKETPLACES = [
  ANTROPIC_SKILLS_MARKETPLACE,
  COMMUNITY_MARKETPLACE
];
var MARKETPLACE_DEFAULTS_VERSION = 4;
var MAX_PERSIST_IMAGE_CHARS = 1e5;
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
var MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build" };
var SEARCH_PLUGIN_LABELS = {
  duckduckgo: "DuckDuckGo",
  tavily: "Tavily"
};
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
var persistTimer;
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
var PERSIST_DEBOUNCE_MS = 100;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore.getState().persist(), PERSIST_DEBOUNCE_MS);
}
var OPEN_CHATS_KEY = "coder:openChats";
var ACTIVE_CHAT_KEY = "coder:activeChat";
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
var VISIBLE_CHATS_KEY = "coder:visibleChats";
var WINDOW_SIZES_KEY = "coder:chatWindowSizes";
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
var CHAT_LAYOUT_KEY = "coder:chatLayout";
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
var CHAT_FULL_KEY = "coder:chatFull";
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
var WINDOW_FULL_KEY = "coder:windowFullscreen";
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
var TERMINAL_PANEL_KEY = "coder:terminalPanel";
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
var TERMINAL_FULL_KEY = "coder:terminalFullscreen";
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
var TERMINAL_HEIGHT_KEY = "coder:terminalHeight";
var MIN_TERMINAL_HEIGHT = 140;
var DEFAULT_TERMINAL_HEIGHT = 300;
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
var panelPersistTimer;
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
    const { settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
    const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
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
var persistSeq = 0;
function writeStateNow(s) {
  const { settings, chats, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 } = s;
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
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, rightPanelOpen, fontSize, viewerFontSize, terminalFontSize, dataPath, sttProviderId, sttModel, sttFallbacks, sttLanguage, sttPrompt, ttsProviderId, ttsModel, ttsVoice, ttsFallbacks, liveProviderId, liveModel, liveVoice, subagentModels, subagentThinking, toolFallbacks, cacheTtlMinutes, historyLimit, webSearchAutoFetch, skillCatalogMaxChars, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, marketplaces, searchConsole, pinnedChats, scheduleRunsSeen, computerUse, browserUse, marketplaceDefaultsVersion: MARKETPLACE_DEFAULTS_VERSION2 });
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
var MAX_REDO_EXCHANGES = 20;
var historyStacks = /* @__PURE__ */ new Map();
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
var chatDeleteHooks = [];
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
var PROVIDER_NAMES = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
);
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
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl,
    accountId: scoped ? accountId : void 0,
    model: p.model || "",
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
var MAX_PINNED_RECENT_MODELS = 3;
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
var HYDRATED_CHAT_CAP = 10;
var HYDRATED_BYTE_BUDGET = 24 * 1024 * 1024;
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
var bodyBytes = /* @__PURE__ */ new Map();
var hydratePromises = /* @__PURE__ */ new Map();
function applyChatBody(body) {
  const src2 = body;
  const messages = Array.isArray(src2.messages) ? src2.messages : [];
  bodyBytes.set(body.id, approxBytes(messages));
  useStore.setState((s) => {
    let changed = false;
    const chats = s.chats.map((c2) => {
      if (c2.id !== body.id) return c2;
      changed = true;
      return {
        ...body,
        mode: src2.mode ? normalizeMode(src2.mode) : c2.mode,
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
var useStore = create((set, get) => ({
  loaded: false,
  settingsHydrated: false,
  settings: { providers: defaultProviders(), activeProviderId: "openrouter", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactAtPercent: 80, disableTextSuggestions: true, nvimTerminal: DEFAULT_NVIM_TERMINAL, terminalShell: DEFAULT_TERMINAL_SHELL },
  builtinMcp: [],
  root: "",
  theme: DEFAULT_THEME,
  dir: "rtl",
  fontSize: 14,
  viewerFontSize: DEFAULT_VIEWER_FONT_SIZE,
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
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
  liveVoiceChatId: null,
  liveVoiceState: "idle",
  recentModels: [],
  subagentModels: {},
  subagentThinking: {},
  toolFallbacks: {},
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
    const src2 = s.chats.find((c2) => c2.messages.some((m) => m.id === messageId));
    if (!src2) return;
    const chatId = s.newChatInRoot(src2.root ?? "", src2.mode);
    if (src2.providerId) {
      useStore.getState().setChatProvider(chatId, src2.providerId, src2.model ?? "");
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
    const src2 = get().chats.find((c2) => c2.messages.some((m) => m.id === messageId));
    if (!src2) return null;
    const idx = src2.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const chatId = get().newChatInRoot(src2.root ?? "", src2.mode);
    if (src2.providerId) {
      get().setChatProvider(chatId, src2.providerId, src2.model ?? "");
    }
    const seed = forkSeedMessage(src2, idx);
    set((st) => ({
      chats: st.chats.map(
        (c2) => c2.id === chatId ? {
          ...c2,
          messages: [seed],
          // 'New chat' (not "(fork)") on purpose: the title generator only
          // fires while the title is still the untouched placeholder, so
          // the user's FIRST new message here renames the fork for real.
          title: "New chat",
          thinkingLevel: src2.thinkingLevel,
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

// src/components/ArtifactPanel.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function isMcpRequest(data) {
  if (!data || typeof data !== "object") return false;
  const msg = data;
  return msg.source === "codifa-artifact" && typeof msg.id === "number" && typeof msg.tool === "string" && msg.tool.trim().length > 0;
}
function ArtifactPanel({
  title,
  kind,
  body,
  chatId,
  id
}) {
  const missing = !body.trim();
  const [fetched, setFetched] = useState("");
  const [error, setError] = useState("");
  const [assets, setAssets] = useState([]);
  const frameRef = useRef(null);
  const mcpServers = useStore((st) => st.settings.mcpServers ?? {});
  const mcpEnabled = useStore((st) => st.settings.mcpEnabled ?? []);
  const enabledServers = useMemo(() => {
    const sel = {};
    for (const n of mcpEnabled) if (mcpServers[n]) sel[n] = mcpServers[n];
    return sel;
  }, [mcpServers, mcpEnabled]);
  useEffect(() => {
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
  useEffect(() => {
    if (!chatId || !id) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    void getArtifactAssets(chatId, id).then((out) => {
      if (cancelled) return;
      setAssets("error" in out ? [] : out.files);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, id, body]);
  useEffect(() => {
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!isMcpRequest(data)) return;
      const reply = (payload) => frame.contentWindow?.postMessage(
        { source: "codifa-artifact-reply", id: data.id, ...payload },
        "*"
      );
      void callMcpTool(data.tool, data.args, enabledServers).then((out) => {
        if ("error" in out) reply({ ok: false, error: out.error });
        else reply({ ok: true, result: out.result });
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabledServers]);
  const doc = body.trim() ? body : fetched;
  if (!doc.trim()) {
    return /* @__PURE__ */ jsxs("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ jsx("div", { className: "artifact-panel-head", children: /* @__PURE__ */ jsx("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ jsx("div", { className: "viewer-empty", children: error ? `Could not load this artifact's content: ${error}` : missing && chatId && id ? "Loading artifact\u2026" : "This artifact's content is no longer in memory \u2014 reopen it from its card in the chat." })
    ] });
  }
  if (kind === "md") {
    return /* @__PURE__ */ jsxs("div", { className: "artifact-panel", children: [
      /* @__PURE__ */ jsx("div", { className: "artifact-panel-head", children: /* @__PURE__ */ jsx("span", { className: "artifact-panel-title", children: title }) }),
      /* @__PURE__ */ jsx("div", { className: "artifact-panel-md markdown-body", dir: "auto", children: /* @__PURE__ */ jsx(ReactMarkdown, { remarkPlugins: [remarkGfm], children: doc }) })
    ] });
  }
  return /* @__PURE__ */ jsxs("div", { className: "artifact-panel", children: [
    /* @__PURE__ */ jsxs("div", { className: "artifact-panel-head", children: [
      /* @__PURE__ */ jsx("span", { className: "artifact-panel-title", children: title }),
      assets.length > 0 && /* @__PURE__ */ jsxs("span", { className: "artifact-panel-assets", title: assets.map((a) => a.path).join("\n"), children: [
        assets.length,
        " file",
        assets.length === 1 ? "" : "s"
      ] })
    ] }),
    /* @__PURE__ */ jsx(
      "iframe",
      {
        ref: frameRef,
        className: "artifact-panel-frame",
        title,
        sandbox: "allow-scripts",
        srcDoc: doc
      }
    )
  ] });
}

// tests/artifactPanel.ssr.test.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var passed = 0;
var failures = [];
function check(name, cond, extra = "") {
  if (cond) passed++;
  else failures.push(extra ? `${name} - ${extra}` : name);
}
var html = renderToString(
  /* @__PURE__ */ jsx2(
    ArtifactPanel,
    {
      title: "Q3 dashboard",
      kind: "html",
      body: '<h1 id="x">Q3</h1>',
      chatId: "c1",
      id: "q3"
    }
  )
);
check("renders the artifact panel shell", html.includes("artifact-panel"));
check(
  "shows the artifact title",
  html.includes("artifact-panel-title") && html.includes("Q3 dashboard")
);
check(
  "renders the html body in the frame",
  html.includes("artifact-panel-frame") && /srcdoc=/i.test(html) && html.includes("id=&quot;x&quot;")
);
check(
  "sandbox allows scripts only",
  html.includes('sandbox="allow-scripts"') && !html.includes("allow-same-origin")
);
check("never renders markdown chrome for html", !html.includes("artifact-panel-md"));
var md = renderToString(
  /* @__PURE__ */ jsx2(
    ArtifactPanel,
    {
      title: "Q3 summary",
      kind: "md",
      body: "## Revenue\n\n- up 12%",
      chatId: "c1",
      id: "q3-md"
    }
  )
);
check(
  "markdown artifact uses the md container",
  md.includes("artifact-panel-md") && md.includes("markdown-body")
);
check("markdown artifact renders headings", md.includes("<h2") && md.includes("Revenue"));
check("markdown artifact renders list items", md.includes("<li") && md.includes("up 12%"));
check("markdown artifact has no frame", !md.includes("artifact-panel-frame"));
var empty = renderToString(/* @__PURE__ */ jsx2(ArtifactPanel, { title: "Ghost", kind: "html", body: "" }));
check(
  "empty artifact explains itself",
  empty.includes("viewer-empty") && empty.includes("no longer in memory")
);
check("empty artifact renders no frame", !empty.includes("artifact-panel-frame"));
var pending = renderToString(
  /* @__PURE__ */ jsx2(ArtifactPanel, { title: "Q3", kind: "html", body: "  ", chatId: "c1", id: "q3" })
);
check(
  "owned empty artifact does not claim loss while loading",
  !pending.includes("no longer in memory")
);
check("no asset hint when there are none", !html.includes("artifact-panel-assets"));
check("no asset hint on markdown either", !md.includes("artifact-panel-assets"));
var src = readFileSync("src/components/ArtifactPanel.tsx", "utf8");
check(
  "the page channel asks for a tool, not a server",
  src.includes("isMcpRequest") && src.includes('source: "codifa-artifact"')
);
check(
  "an unverified frame cannot drive the channel",
  src.includes("event.source !== frame.contentWindow")
);
check(
  "assets are fetched, not assumed present",
  src.includes("getArtifactAssets")
);
console.log(`${passed} artifact-panel checks passed`);
if (failures.length) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
