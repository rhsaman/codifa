// test/_globals.ts
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

// src/lib/store.ts
import { create } from "zustand";

// src/lib/fs.ts
var api = {
  getSidecarUrl: () => window.coder.getSidecarUrl(),
  getEnv: (key) => window.coder.getEnv(key),
  googleSignIn: (clientId, clientSecret, scope) => window.coder.googleSignIn(clientId, clientSecret, scope),
  selectFolder: () => window.coder.selectFolder(),
  selectFile: () => window.coder.selectFile(),
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
  getNvimFile: () => window.coder.getNvimFile(),
  onNvimFile: (cb) => window.coder.onNvimFile(
    (f) => cb(f)
  )
};

// src/lib/bidi.ts
var PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
var RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);

// src/lib/context.ts
var PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
function contextPercent(used, windowSize, reserved = 0) {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round(used / windowSize * 100);
}
function modelContextWindow(provider, model) {
  if (!provider) return null;
  const map = provider.contextMap ?? {};
  const direct = map[model];
  if (direct && direct > 0) return direct;
  const prefixed = map[`${provider.id ?? ""}/${model}`];
  if (prefixed && prefixed > 0) return prefixed;
  return provider.contextWindow && provider.contextWindow > 0 ? provider.contextWindow : null;
}

// src/lib/api.ts
var sidecarUrl = null;
api.onSidecarChanged(() => {
  sidecarUrl = null;
});
api.onSidecarDead(() => {
  sidecarUrl = null;
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
  if (sidecarUrl) {
    if (await isSidecarAlive(sidecarUrl)) return sidecarUrl;
    sidecarUrl = null;
  }
  const url = await api.getSidecarUrl();
  if (url) sidecarUrl = url;
  return sidecarUrl;
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

// src/lib/modes.ts
var BUILTIN_MODES = [
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
    description: "Plans the work: scouts the code and lays out concrete steps and changes for Coder mode. Read-only files and terminal, never writes.",
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true }
  },
  {
    id: "coder",
    label: "Coder",
    icon: "code",
    description: "Write and edit code, run commands. Full access to your project.",
    capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true }
  }
];
var BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
var FALLBACK_MODE = BUILTIN_MODES[0];
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "coder";
  return id || "ask";
}

// src/lib/secrets.ts
var PREFIX = "enc:v1:";
var keyPromise = null;
function getKey() {
  keyPromise ??= (async () => {
    try {
      const b64 = await window.coder.secretsGetKey();
      if (!b64) return null;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } catch {
      return null;
    }
  })();
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
  if (!k) return plain;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new Uint8Array(enc.encode(plain))));
    return `${PREFIX}${toB64(iv)}.${toB64(ct)}`;
  } catch {
    return plain;
  }
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
var SECRET_KEYS = ["apiKey", "oauthClientId", "oauthClientSecret", "oauthRefreshToken"];
async function encryptProvider(p) {
  const out = { ...p };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    out[key] = await encryptSecret(v || "");
  }
  return out;
}
async function decryptProvider(p) {
  const out = { ...p };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    out[key] = await decryptSecret(v || "");
  }
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
  const provider = raw.provider ? { ...raw.provider, apiKey: await decryptSecret(raw.provider.apiKey || "") } : raw.provider;
  return { ...raw, providers, searchConsole, searchPlugins, provider };
}

// src/lib/provider-meta.ts
var PROVIDER_META = {
  opencode: {
    kind: "opencode",
    label: "opencode gateway",
    name: "opencode",
    defaultEnvVar: "OPENCODE_API_KEY",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    requiresKey: false,
    builtin: true,
    unprefixedModelId: true,
    baseUrlHint: "https://opencode.ai/zen/v1 \u2014 routed via the opencode gateway (never OpenRouter).",
    defaultBaseUrl: "https://opencode.ai/zen/v1"
  },
  openrouter: {
    kind: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    defaultEnvVar: "OPENROUTER_API_KEY",
    envVars: ["OPENROUTER_API_KEY"],
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://openrouter.ai/api/v1",
    defaultBaseUrl: "https://openrouter.ai/api/v1"
  },
  google: {
    kind: "google",
    label: "Google",
    name: "Google",
    defaultEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    envVars: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    requiresKey: true,
    builtin: true,
    oauth: true,
    baseUrlHint: "https://generativelanguage.googleapis.com/v1beta/openai \u2014 Gemini models via Google.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  },
  nvidia: {
    kind: "nvidia",
    label: "NVIDIA",
    name: "NVIDIA",
    defaultEnvVar: "NVIDIA_API_KEY",
    envVars: ["NVIDIA_API_KEY"],
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://integrate.api.nvidia.com/v1 \u2014 NVIDIA NIM hosted models.",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
  },
  cloudflare: {
    kind: "cloudflare",
    label: "Cloudflare",
    name: "Cloudflare",
    defaultEnvVar: "CLOUDFLARE_AUTH_TOKEN",
    envVars: ["CLOUDFLARE_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN"],
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1 \u2014 Workers AI.",
    extraHint: "Also requires CLOUDFLARE_ACCOUNT_ID in your environment.",
    defaultBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1"
  },
  tokenrouter: {
    kind: "tokenrouter",
    label: "TokenRouter",
    name: "TokenRouter",
    defaultEnvVar: "TOKEN_ROUTER_API_KEY",
    envVars: ["TOKEN_ROUTER_API_KEY", "TOKENROUTER_API_KEY"],
    requiresKey: true,
    builtin: true,
    baseUrlHint: "https://api.tokenrouter.com/v1 \u2014 unified AI model hub.",
    defaultBaseUrl: "https://api.tokenrouter.com/v1"
  },
  ollama: {
    kind: "ollama",
    label: "local",
    name: "local",
    defaultEnvVar: "",
    envVars: [],
    requiresKey: false,
    builtin: true,
    local: true,
    editableBaseUrl: true
  },
  custom: {
    kind: "custom",
    label: "Custom API",
    name: "Custom API",
    defaultEnvVar: "",
    envVars: [],
    requiresKey: false,
    builtin: false,
    editableBaseUrl: true
  }
};

// src/lib/themes.ts
var DEFAULT_THEME = "catppuccin";

// src/lib/store.ts
var uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function sanitizeChats(chats) {
  return chats.map((c) => {
    const clean = { ...c };
    delete clean.pendingAsk;
    delete clean.pendingPermission;
    return {
      ...clean,
      messages: c.messages.map((m) => {
        const msg = { ...m };
        delete msg.retry;
        if (msg.streaming) msg.interrupted = true;
        delete msg.streaming;
        delete msg.thinking;
        if (Array.isArray(msg.toolActivity)) {
          msg.toolActivity = trimToolActivity(msg.toolActivity);
        }
        return msg;
      })
    };
  });
}
var MID_STREAM_MS = 2e3;
var lastMidStreamPersist = 0;
var MAX_TOOL_TEXT = 4e3;
var MAX_TOOL_ITEMS = 50;
var MAX_TOOL_SNIPPET = 500;
var MAX_TOOL_ARG = 2e3;
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
    if (Array.isArray(out.items)) {
      out.items = out.items.slice(0, MAX_TOOL_ITEMS).map(
        (it) => typeof it.snippet === "string" && it.snippet.length > MAX_TOOL_SNIPPET ? { ...it, snippet: it.snippet.slice(0, MAX_TOOL_SNIPPET) + "\u2026" } : it
      );
    }
    if (Array.isArray(out.children)) out.children = trimToolActivity(out.children);
    return out;
  });
}
var MODE_LABELS = { ask: "Ask", plan: "Plan", coder: "Coder" };
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
  if ("codewriter" in out && !("coder" in out)) {
    out.coder = out.codewriter;
    delete out.codewriter;
  }
  return out;
}
var persistTimer;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore.getState().persist(), 500);
}
function writeChatsNow(s) {
  void api.storeSet("chats", sanitizeChats(s.chats));
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
    flushPendingPersist().catch((err) => console.error("state flush on quit failed:", err)).finally(() => {
      api.flushPersistDone();
    });
  });
}
var persistSeq = 0;
function writeStateNow(s) {
  const { settings, chats, root, dir, recentModels, sidebarOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, embeddingModel, embeddingBaseUrl, subagentModels, taskTtlHours, shortTermTtlHours, longTermTtlHours, cacheTtlMinutes, memoryMaxNotes, memorySlidingTtl, memoryTtlDays, memoryMaxDocs, memoryMaxChunks, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats } = s;
  const seq = ++persistSeq;
  const memory = { taskTtlHours, shortTermTtlHours, longTermTtlHours, cacheTtlMinutes, maxNotes: memoryMaxNotes, slidingTtl: memorySlidingTtl };
  const writes = [
    api.storeSet("chats", sanitizeChats(chats))
  ];
  if (s.settingsHydrated) {
    writes.unshift(
      (async () => {
        const payload = await encryptSettings({ ...settings, root, dir, recentModels, sidebarOpen, fontSize, vectorDbPath, dataPath, whisperModel, whisperBaseUrl, embeddingModel, embeddingBaseUrl, subagentModels, memory, memoryTtlDays, memoryMaxDocs, memoryMaxChunks, workspaceColors, pinnedWorkspaces, workspaces, searchPlugins, searchConsole, pinnedChats });
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
var historyStacks = /* @__PURE__ */ new Map();
function stackFor(chatId) {
  let st = historyStacks.get(chatId);
  if (!st) {
    st = { undo: [], redo: [] };
    historyStacks.set(chatId, st);
  }
  return st;
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
      apiKey: "",
      envVar: meta.defaultEnvVar,
      baseUrl: meta.defaultBaseUrl ?? "",
      model: "",
      ...extra
    };
  };
  return [
    row("opencode", { model: "deepseek-v4-flash-free" }),
    row("openrouter"),
    row("ollama"),
    row("google"),
    row("nvidia"),
    row("cloudflare"),
    row("tokenrouter")
  ];
}
function normalizeProvider(p) {
  const kind = p.kind || "custom";
  const meta = PROVIDER_META[kind];
  const unprefixed = meta?.unprefixedModelId;
  let model = p.model || "";
  if (unprefixed && model.startsWith("opencode/")) model = model.slice("opencode/".length);
  return {
    // The local llama.cpp provider's id was historically 'ollama'; keep it
    // stable by migrating any legacy rows to the canonical 'local' id.
    id: p.id === "ollama" ? "local" : p.id || "custom",
    name: p.name || PROVIDER_NAMES[kind] || "Custom API",
    kind,
    apiKey: p.apiKey || "",
    envVar: p.envVar ?? defaultEnvVar(kind),
    // Use defaultBaseUrl from provider meta if user hasn't set a custom baseUrl
    baseUrl: p.baseUrl || meta?.defaultBaseUrl || "",
    model,
    authType: p.authType ?? "",
    oauthClientId: p.oauthClientId || "",
    oauthClientSecret: p.oauthClientSecret || "",
    oauthRefreshToken: p.oauthRefreshToken || "",
    contextWindow: p.contextWindow,
    contextMap: p.contextMap,
    pricingMap: p.pricingMap,
    reasoningMap: p.reasoningMap,
    thinkingLevel: p.thinkingLevel ?? "",
    models: Array.isArray(p.models) ? p.models.map((m) => unprefixed ? m.replace(/^opencode\//, "") : m) : [],
    removedModels: Array.isArray(p.removedModels) ? p.removedModels : []
  };
}
function defaultEnvVar(kind) {
  return PROVIDER_META[kind]?.defaultEnvVar ?? "";
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
      if (model) out.push({ providerId: pid === "ollama" ? "local" : pid, model, lastUsed });
    }
  }
  return out.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).slice(0, 20);
}
function makeChat(mode = "ask") {
  const now = Date.now();
  const s = useStore.getState();
  const activeProvider = s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
  const recent = [...s.recentModels].sort(
    (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
  )[0];
  const recentProvider = recent ? s.settings.providers.find((p) => p.id === recent.providerId) : void 0;
  const providerId = recentProvider?.id ?? activeProvider?.id;
  const model = recentProvider && recent ? recent.model : activeProvider?.model;
  return {
    id: uid(),
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
var useStore = create((set, get) => ({
  loaded: false,
  settingsHydrated: false,
  settings: { providers: defaultProviders(), activeProviderId: "opencode", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactHeadroom: 2e4 },
  builtinMcp: [],
  root: "",
  theme: DEFAULT_THEME,
  dir: "rtl",
  fontSize: 14,
  vectorDbPath: "",
  memoryTtlDays: 180,
  memoryMaxDocs: 500,
  memoryMaxChunks: 4e3,
  whisperModel: "Systran/faster-whisper-medium",
  whisperBaseUrl: "",
  embeddingModel: "intfloat/multilingual-e5-base",
  embeddingBaseUrl: "",
  recentModels: [],
  subagentModels: {},
  taskTtlHours: 6,
  shortTermTtlHours: 24,
  longTermTtlHours: 8760,
  cacheTtlMinutes: 60,
  memoryMaxNotes: 500,
  memorySlidingTtl: true,
  searchPlugins: [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
  searchConsole: { clientId: "", clientSecret: "", refreshToken: "", siteUrl: "" },
  sidebarOpen: true,
  dataPath: "",
  workspaceColors: {},
  pinnedWorkspaces: [],
  pinnedChats: [],
  workspaces: [],
  chats: [],
  deletedChatIds: [],
  deletedWorkspaceRoots: [],
  activeChatId: "",
  focusComposer: false,
  unreadChats: [],
  prefixNotice: null,
  settingsOpen: false,
  isStreaming: false,
  isThinking: false,
  outsideAllowed: false,
  chatAborts: {},
  setChatAbort: (chatId, abort) => set((s) => ({ chatAborts: { ...s.chatAborts, [chatId]: abort } })),
  /** Absolute path of the file currently open in Neovim (null if none / unknown). */
  nvimFile: null,
  /** LSP diagnostics reported for the Neovim file (empty when none / unknown). */
  nvimDiagnostics: [],
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
    const loadedChats0 = chats && chats.length > 0 ? chats : [];
    const loadedChats = loadedChats0.map((c) => {
      const clean = { ...c };
      delete clean.compacting;
      delete clean.compactNotice;
      delete clean.compactError;
      delete clean.cmdError;
      delete clean.stalled;
      return clean.mode ? { ...clean, mode: normalizeMode(clean.mode) } : clean;
    });
    const activeId = loadedChats[loadedChats.length - 1]?.id ?? "";
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
      const kind = oldP.id === "openrouter" || oldP.id === "ollama" || oldP.id === "opencode" ? oldP.id : "custom";
      const name = PROVIDER_NAMES[kind];
      const legacy = normalizeProvider({
        id: oldP.id || "custom",
        name: name || oldP.name || "Custom API",
        kind,
        apiKey: oldP.apiKey || "",
        baseUrl: kind === "custom" || kind === "ollama" ? oldP.baseUrl || "" : "",
        model: oldP.model || "",
        contextWindow: oldP.contextWindow
      });
      const defs = defaultProviders().filter((p) => p.id !== legacy.id);
      providers = [legacy, ...defs];
      activeProviderId = legacy.id;
    } else {
      providers = defaultProviders();
      activeProviderId = providers[0].id;
    }
    const loadedSettings = {
      providers,
      activeProviderId,
      systemPrompts: migrateModePrompts(raw.systemPrompts ?? {}),
      modes: Array.isArray(raw.modes) ? raw.modes.filter((m) => m && !BUILTIN_IDS.has(m.id)) : [],
      mcpServers: raw.mcpServers ?? {},
      mcpEnabled: Array.isArray(raw.mcpEnabled) ? raw.mcpEnabled.filter((n) => !!raw.mcpServers?.[n]) : [],
      compactHeadroom: typeof raw.compactHeadroom === "number" && raw.compactHeadroom >= 0 && raw.compactHeadroom <= 2e5 ? Math.round(raw.compactHeadroom) : 2e4
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
    const root = typeof raw.root === "string" ? raw.root : "";
    const dbMcp = await listMcp();
    const mergedMcp = { ...loadedSettings.mcpServers ?? {}, ...dbMcp.mcpServers ?? {} };
    loadedSettings.mcpServers = mergedMcp;
    const builtins = (dbMcp.builtins ?? []).filter((n) => mergedMcp[n]);
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
      memoryTtlDays: typeof raw.memoryTtlDays === "number" && raw.memoryTtlDays > 0 ? raw.memoryTtlDays : 180,
      memoryMaxDocs: typeof raw.memoryMaxDocs === "number" && raw.memoryMaxDocs >= 10 ? raw.memoryMaxDocs : 500,
      memoryMaxChunks: typeof raw.memoryMaxChunks === "number" && raw.memoryMaxChunks >= 50 ? raw.memoryMaxChunks : 4e3,
      dataPath: typeof raw.dataPath === "string" && raw.dataPath.trim() ? raw.dataPath : realDataPath || "",
      whisperModel: typeof raw.whisperModel === "string" && raw.whisperModel.trim() ? raw.whisperModel : "Systran/faster-whisper-medium",
      whisperBaseUrl: typeof raw.whisperBaseUrl === "string" ? raw.whisperBaseUrl : "",
      embeddingModel: typeof raw.embeddingModel === "string" && raw.embeddingModel.trim() ? raw.embeddingModel : "intfloat/multilingual-e5-base",
      embeddingBaseUrl: typeof raw.embeddingBaseUrl === "string" ? raw.embeddingBaseUrl : "",
      subagentModels: typeof raw.subagentModels === "object" && raw.subagentModels !== null ? { ...raw.subagentModels } : {},
      taskTtlHours: typeof raw.memory?.taskTtlHours === "number" && raw.memory.taskTtlHours > 0 ? raw.memory.taskTtlHours : 6,
      shortTermTtlHours: typeof raw.memory?.shortTermTtlHours === "number" && raw.memory.shortTermTtlHours > 0 ? raw.memory.shortTermTtlHours : 24,
      longTermTtlHours: typeof raw.memory?.longTermTtlHours === "number" && raw.memory.longTermTtlHours > 0 ? raw.memory.longTermTtlHours : 8760,
      cacheTtlMinutes: typeof raw.memory?.cacheTtlMinutes === "number" && raw.memory.cacheTtlMinutes > 0 ? raw.memory.cacheTtlMinutes : 60,
      memoryMaxNotes: typeof raw.memory?.maxNotes === "number" && raw.memory.maxNotes >= 20 ? raw.memory.maxNotes : 500,
      memorySlidingTtl: typeof raw.memory?.slidingTtl === "boolean" ? raw.memory.slidingTtl : true,
      // Rows for removed engines (e.g. Google Custom Search, sunset by Google)
      // are dropped here so they disappear from Settings → Plugins on reload.
      searchPlugins: searchPlugins.length > 0 ? searchPlugins : [{ kind: "duckduckgo", label: "DuckDuckGo", enabled: true, order: 0 }],
      searchConsole: {
        clientId: typeof raw.searchConsole?.clientId === "string" ? raw.searchConsole.clientId : "",
        clientSecret: typeof raw.searchConsole?.clientSecret === "string" ? raw.searchConsole.clientSecret : "",
        refreshToken: typeof raw.searchConsole?.refreshToken === "string" ? raw.searchConsole.refreshToken : "",
        siteUrl: typeof raw.searchConsole?.siteUrl === "string" ? raw.searchConsole.siteUrl : ""
      },
      recentModels: Array.isArray(raw.recentModels) ? normalizeRecentModels(raw.recentModels) : [],
      sidebarOpen: raw.sidebarOpen !== false,
      workspaceColors: raw.workspaceColors ?? {},
      pinnedWorkspaces: Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : [],
      pinnedChats: Array.isArray(raw.pinnedChats) ? raw.pinnedChats : [],
      workspaces,
      chats: loadedChats,
      activeChatId: activeId
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
      apiKey: "",
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
            removedModels: (p.removedModels ?? []).filter((m) => !models.includes(m))
          } : p
        )
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
  removeProviderModel: (id, model) => {
    set((s) => {
      const target = s.settings.providers.find((p) => p.id === id);
      const remaining = (target?.models ?? []).filter((m) => m !== model);
      return {
        settings: {
          ...s.settings,
          providers: s.settings.providers.map(
            (p) => p.id === id ? {
              ...p,
              models: remaining,
              removedModels: Array.from(/* @__PURE__ */ new Set([...p.removedModels ?? [], model]))
              // The main model is chosen in the composer, NOT here — never
              // rewrite `model` when a provider model is removed.
            } : p
          )
        },
        recentModels: s.recentModels.filter((r) => !(r.providerId === id && r.model === model))
      };
    });
    get().persist();
  },
  setMcpServers: (mcpServers) => {
    set((s) => ({ settings: { ...s.settings, mcpServers } }));
    get().persist();
  },
  addMcpServer: (name, cfg) => {
    set((s) => ({
      settings: { ...s.settings, mcpServers: { ...s.settings.mcpServers ?? {}, [name]: cfg } }
    }));
    get().persist();
    void saveMcp(name, cfg);
  },
  updateMcpServer: (name, cfg) => {
    set((s) => ({
      settings: { ...s.settings, mcpServers: { ...s.settings.mcpServers ?? {}, [name]: cfg } }
    }));
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
    set({ root, outsideAllowed: false });
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
  setMemoryConfig: ({ ttlDays, maxDocs, maxChunks }) => {
    set({
      memoryTtlDays: typeof ttlDays === "number" && ttlDays > 0 ? Math.round(ttlDays) : get().memoryTtlDays,
      memoryMaxDocs: typeof maxDocs === "number" && maxDocs >= 10 ? Math.round(maxDocs) : get().memoryMaxDocs,
      memoryMaxChunks: typeof maxChunks === "number" && maxChunks >= 50 ? Math.round(maxChunks) : get().memoryMaxChunks
    });
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
  setEmbeddingModel: (m) => {
    set({ embeddingModel: (m ?? "").trim() || "intfloat/multilingual-e5-base" });
    get().persist();
  },
  setEmbeddingBaseUrl: (u) => {
    set({ embeddingBaseUrl: (u ?? "").trim() });
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
      taskTtlHours: typeof c.task === "number" && c.task > 0 ? Math.round(c.task) : get().taskTtlHours,
      shortTermTtlHours: typeof c.shortTerm === "number" && c.shortTerm > 0 ? Math.round(c.shortTerm) : get().shortTermTtlHours,
      longTermTtlHours: typeof c.longTerm === "number" && c.longTerm > 0 ? Math.round(c.longTerm) : get().longTermTtlHours,
      cacheTtlMinutes: typeof c.cache === "number" && c.cache > 0 ? Math.round(c.cache) : get().cacheTtlMinutes,
      memoryMaxNotes: typeof c.maxNotes === "number" && c.maxNotes >= 20 ? Math.round(c.maxNotes) : get().memoryMaxNotes,
      memorySlidingTtl: typeof c.sliding === "boolean" ? c.sliding : get().memorySlidingTtl
    });
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
    get().persist();
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    get().setSidebarOpen(next);
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
      const recentModels = [
        { providerId: pid, model: m, lastUsed: now },
        ...s.recentModels.filter((x) => x.model !== m || x.providerId !== pid)
      ].slice(0, 20);
      return { recentModels };
    });
    get().persist();
  },
  newChat: (mode) => {
    const chat = makeChat(mode ?? "ask");
    const s = useStore.getState();
    const prevRoot = s.chats.find((c) => c.id === s.activeChatId)?.root;
    const lastRoot = [...s.chats].reverse().find((c) => c.root)?.root;
    chat.root = prevRoot ?? lastRoot ?? s.root;
    const activeChatId = chat.id;
    set((st) => ({ chats: [...st.chats, chat], activeChatId }));
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
      return { workspaces, chats: [...st.chats, chat], activeChatId };
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
      const activeChatId = s.activeChatId === id ? chats[chats.length - 1]?.id ?? "" : s.activeChatId;
      return {
        chats,
        activeChatId,
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
      return {
        chats,
        workspaces,
        pinnedWorkspaces,
        pinnedChats,
        activeChatId,
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
  togglePinChat: (id) => {
    set((s) => {
      const wasPinned = s.pinnedChats.includes(id);
      const pinnedChats = wasPinned ? s.pinnedChats.filter((k) => k !== id) : [id, ...s.pinnedChats];
      return { pinnedChats };
    });
    get().persist();
  },
  setActiveChat: (id) => {
    set((s) => ({
      activeChatId: id,
      // Opening a chat clears its green "new message" dot.
      unreadChats: s.unreadChats.filter((cid) => cid !== id)
    }));
    persistSoon();
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
  setChatRoot: (id, root) => {
    set((s) => ({
      root: s.activeChatId === id ? root : s.root,
      chats: s.chats.map((c) => c.id === id ? { ...c, root, updatedAt: Date.now() } : c)
    }));
    get().persist();
  },
  setChatDraft: (id, patch) => {
    set((s) => ({
      chats: s.chats.map(
        (c) => c.id === id ? { ...c, draft: { ...c.draft, ...patch } } : c
      )
    }));
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
  addMessage: (chatId, message) => {
    const id = uid();
    const full = { ...message, id, createdAt: Date.now() };
    set((s) => {
      if (message.role === "user") {
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
          updatedAt: !message.streaming && (message.role === "user" || message.role === "assistant") ? Date.now() : c.updatedAt,
          title: c.messages.length === 0 && message.role === "user" ? message.content.slice(0, 48) : c.title
        } : c
      );
      return { chats };
    });
    get().persist();
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
    let completedChatId = null;
    set((s) => {
      const chats = s.chats.map((c) => {
        const msg = c.messages.find((m) => m.id === id);
        if (!msg) return c;
        const completes = msg.streaming === true && patch.streaming === false;
        if (completes) completedChatId = c.id;
        return {
          ...c,
          messages: c.messages.map((m) => m.id === id ? { ...m, ...patch } : m),
          updatedAt: completes ? Date.now() : c.updatedAt
        };
      });
      const unreadChats = completedChatId && completedChatId !== s.activeChatId && !s.unreadChats.includes(completedChatId) ? [...s.unreadChats, completedChatId] : s.unreadChats;
      return { chats, unreadChats };
    });
    maybePersistMidStream();
  },
  accrueChatUsage: (chatId, modelId, delta) => {
    if ((delta.input || 0) <= 0 && (delta.output || 0) <= 0) return;
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== chatId) return c;
        const usage = { ...c.usage ?? {} };
        const prev = usage[modelId] ?? { input: 0, output: 0 };
        usage[modelId] = {
          input: prev.input + (delta.input || 0),
          output: prev.output + (delta.output || 0),
          cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
          cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
          lastUsed: Date.now()
        };
        const working = c.messages.some((m) => m.streaming);
        return { ...c, usage, updatedAt: working ? c.updatedAt : Date.now() };
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
  setChatStalled: (id, stalled) => {
    set((s) => ({
      chats: s.chats.map((c) => c.id === id ? { ...c, stalled } : c)
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
    set((s) => ({
      chats: s.chats.map((c) => c.id === id ? { ...c, scrollPos: pos } : c)
    }));
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
    const chat = s.chats.find((c) => c.id === s.activeChatId);
    if (!chat) return false;
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    set((st) => ({
      chats: st.chats.map(
        (c) => c.id === s.activeChatId ? { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() } : c
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
        messages.push(summaryMsg);
        return {
          ...c,
          messages,
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
  anyStreaming: () => get().chats.some((c) => c.messages.some((m) => m.streaming)),
  setCompactHeadroom: (tokens) => {
    set((s) => ({ settings: { ...s.settings, compactHeadroom: tokens } }));
    get().persist();
  },
  setNvimFile: (abs) => set({ nvimFile: abs }),
  setNvimDiagnostics: (diagnostics) => set({ nvimDiagnostics: diagnostics })
}));
api.onSidecarChanged(() => {
  void useStore.getState().load();
});

// test/usageContext.test.ts
function check(name, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    console.log(`  \u2717 ${name}`);
    if (extra !== void 0) console.log("    got:", JSON.stringify(extra));
    globalThis.__FAILED = true;
  }
}
console.log("\u06F1) modelContextWindow \u2014 \u067E\u0646\u062C\u0631\u0647\u06CC \u06A9\u0627\u0646\u062A\u06A9\u0633\u062A \u0645\u062F\u0644 \u0639\u062F\u062F \u0648\u0627\u0642\u0639\u06CC \u0631\u0627 \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u0627\u0646\u062F (\u0646\u0648\u0627\u0631 \u0628\u0627\u0644\u0627):");
{
  const p1 = {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-4o"],
    contextMap: { "gpt-4o": 128e3 },
    contextWindow: 0
  };
  check("\u0627\u0632 contextMap (id \u062E\u0627\u0644\u0635) \u0639\u062F\u062F \u0648\u0627\u0642\u0639\u06CC \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F", modelContextWindow(p1, "gpt-4o") === 128e3, modelContextWindow(p1, "gpt-4o"));
  const p2 = {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-4o"],
    contextMap: { "openai/gpt-4o": 128e3 },
    contextWindow: 0
  };
  check("\u0627\u0632 contextMap (id \u067E\u06CC\u0634\u0648\u0646\u062F\u062F\u0627\u0631) \u0639\u062F\u062F \u0648\u0627\u0642\u0639\u06CC \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F", modelContextWindow(p2, "gpt-4o") === 128e3, modelContextWindow(p2, "gpt-4o"));
  const p3 = {
    id: "x",
    name: "X",
    models: ["m1"],
    contextMap: {},
    contextWindow: 2e5
  };
  check("fallback \u0631\u0648\u06CC provider.contextWindow \u0639\u062F\u062F \u0648\u0627\u0642\u0639\u06CC \u0627\u0633\u062A", modelContextWindow(p3, "m1") === 2e5, modelContextWindow(p3, "m1"));
  check("\u0627\u06AF\u0631 \u06A9\u0627\u0646\u062A\u06A9\u0633\u062A\u06CC \u0647\u0633\u062A \u062E\u0627\u0644\u06CC \u0628\u0631\u0646\u0645\u06CC\u06AF\u0631\u062F\u062F", modelContextWindow(p1, "gpt-4o") != null);
}
console.log("\u06F2) contextPercent \u2014 \u062F\u0631\u0635\u062F \u0645\u0635\u0631\u0641 \u06A9\u0627\u0646\u062A\u06A9\u0633\u062A \u0639\u062F\u062F \u0648\u0627\u0642\u0639\u06CC \u0627\u0633\u062A (\u0646\u0648\u0627\u0631 \u0628\u0627\u0644\u0627):");
{
  check("\u06F5\u06F0\u066A \u0628\u0631\u0627\u06CC \u0646\u06CC\u0645\u0647 \u067E\u0646\u062C\u0631\u0647", contextPercent(5e4, 1e5) === 50, contextPercent(5e4, 1e5));
  check("\u06F0\u066A \u0628\u0631\u0627\u06CC \u0645\u0635\u0631\u0641 \u0635\u0641\u0631", contextPercent(0, 1e5) === 0, contextPercent(0, 1e5));
  check("\u062F\u0631\u0635\u062F \u0631\u0646\u062F \u0634\u062F\u0647\u0654 \u0648\u0627\u0642\u0639\u06CC (\u06F1\u06F2\u066A \u0628\u0631\u0627\u06CC \u06F1\u06F2\u066B\u06F3\u06F4\u06F5\u066A)", contextPercent(12345, 1e5) === 12, contextPercent(12345, 1e5));
  check("\u0627\u06AF\u0631 \u067E\u0646\u062C\u0631\u0647 \u0646\u0627\u0645\u0639\u0644\u0648\u0645 \u0627\u0633\u062A null \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F", contextPercent(100, null) == null, contextPercent(100, null));
}
console.log("\u06F3) \u0641\u0631\u0648\u0634\u06AF\u0627\u0647 \u2014 accrueChatUsage \u0645\u0635\u0631\u0641 \u0648\u0627\u0642\u0639\u06CC \u0647\u0631 \u0645\u062F\u0644 \u0631\u0627 (\u062A\u062C\u0645\u0639\u06CC) \u0646\u06AF\u0647 \u0645\u06CC\u062F\u0627\u0631\u062F (\u0633\u062A\u0648\u0646 \u06A9\u0646\u0627\u0631\u06CC):");
{
  const st = useStore.getState();
  const chatId = st.newChat("ask");
  useStore.getState().accrueChatUsage(chatId, "gpt-4o", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  useStore.getState().accrueChatUsage(chatId, "gpt-4o", { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 });
  const u1 = useStore.getState().chats.find((c) => c.id === chatId).usage["gpt-4o"];
  check("\u0645\u062C\u0645\u0648\u0639 \u062A\u062C\u0645\u0639\u06CC\u0650 input \u062F\u0631\u0633\u062A \u0627\u0633\u062A (\u06F1\u06F5\u06F0)", u1?.input === 150, u1);
  check("\u0645\u062C\u0645\u0648\u0639 \u062A\u062C\u0645\u0639\u06CC\u0650 output \u062F\u0631\u0633\u062A \u0627\u0633\u062A (\u06F1\u06F5)", u1?.output === 15, u1);
  useStore.getState().accrueChatUsage(chatId, "claude-3-5-sonnet", { input: 200, output: 20, cacheRead: 100, cacheWrite: 0 });
  const ch = useStore.getState().chats.find((c) => c.id === chatId);
  check("\u0645\u062F\u0644 \u062F\u0648\u0645 \u062F\u0627\u0646\u0647\u06CC \u062C\u062F\u0627\u06AF\u0627\u0646\u0647 \u062F\u0627\u0631\u062F", ch.usage["claude-3-5-sonnet"]?.input === 200, ch.usage);
  check("\u0645\u062F\u0644 \u0627\u0648\u0644 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u06A9\u0631\u062F\u0647", ch.usage["gpt-4o"]?.input === 150, ch.usage);
  check("cache read \u0648\u0627\u0642\u0639\u06CC \u062B\u0628\u062A \u0634\u062F\u0647", ch.usage["claude-3-5-sonnet"]?.cacheRead === 100, ch.usage);
  useStore.getState().resetChatUsage(chatId);
  const cleared = useStore.getState().chats.find((c) => c.id === chatId).usage;
  check("resetChatUsage \u0647\u0645\u0647 \u0631\u0627 \u067E\u0627\u06A9 \u0645\u06CC\u06A9\u0646\u062F", cleared == null || Object.keys(cleared).length === 0, cleared);
}
console.log("\u06F4) \u067E\u06CC\u0627\u0645 \u062F\u0633\u062A\u06CC\u0627\u0631 \u2014 usage \u0631\u0648\u06CC\u062F\u0627\u062F \u0639\u062F\u062F \u0645\u0635\u0631\u0641\u0634\u062F\u0647\u06CC \u0648\u0627\u0642\u0639\u06CC \u0631\u0627 \u0646\u06AF\u0647 \u0645\u06CC\u062F\u0627\u0631\u062F (\u0646\u0648\u0627\u0631 \u0628\u0627\u0644\u0627 contextUsed):");
{
  const st = useStore.getState();
  const chatId = st.newChat("ask");
  const msg = useStore.getState().addMessage(chatId, { role: "assistant", content: "done" });
  useStore.getState().updateMessage(msg.id, {
    usage: { inputTokens: 7321, outputTokens: 412, totalTokens: 7733, cacheReadTokens: 5e3, cacheWriteTokens: 0 }
  });
  const updated = useStore.getState().chats.find((c) => c.id === chatId).messages.find((m) => m.id === msg.id);
  const consumed = (updated.usage?.inputTokens ?? 0) + (updated.usage?.outputTokens ?? 0);
  check("inputTokens \u0648\u0627\u0642\u0639\u06CC \u0631\u0648\u06CC \u067E\u06CC\u0627\u0645 \u0646\u0634\u0633\u062A\u0647", updated.usage?.inputTokens === 7321, updated.usage);
  check("outputTokens \u0648\u0627\u0642\u0639\u06CC \u0631\u0648\u06CC \u067E\u06CC\u0627\u0645 \u0646\u0634\u0633\u062A\u0647", updated.usage?.outputTokens === 412, updated.usage);
  check("contextUsed \u0648\u0627\u0642\u0639\u06CC \u0627\u0633\u062A (\u06F7\u06F7\u06F3\u06F3 \u0646\u0647 \u062A\u062E\u0645\u06CC\u0646)", consumed === 7733, consumed);
  check("cache read \u0648\u0627\u0642\u0639\u06CC \u0631\u0648\u06CC \u067E\u06CC\u0627\u0645 \u0646\u0634\u0633\u062A\u0647", updated.usage?.cacheReadTokens === 5e3, updated.usage);
}
console.log(globalThis.__FAILED ? "\n\u2717 \u0628\u0631\u062E\u06CC \u062A\u0633\u062A\u0647\u0627 \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F\u0646\u062F" : "\n\u2713 \u0647\u0645\u0647 \u062A\u0633\u062A\u0647\u0627 \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
process.exit(globalThis.__FAILED ? 1 : 0);
