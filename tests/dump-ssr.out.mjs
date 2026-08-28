var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/sections.ts
function splitSections(markdown) {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const sections = [];
  let current = null;
  let buf = [];
  let fence = null;
  const flush = () => {
    if (!current) return;
    const content = buf.join("\n").trim();
    if (content) sections.push({ ...current, content });
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
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = {
        id: `s${sections.length}`,
        title: m[2].trim(),
        level: m[1].length,
        content: ""
      };
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
var HEADING_RE;
var init_sections = __esm({
  "src/lib/sections.ts"() {
    "use strict";
    HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
  }
});

// src/lib/fs.ts
var api;
var init_fs = __esm({
  "src/lib/fs.ts"() {
    "use strict";
    api = {
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
      onFlushPersist: (cb) => window.coder.onFlushPersist(cb),
      flushPersistDone: () => window.coder.flushPersistDone(),
      onMigrateProgress: (cb) => window.coder.onMigrateProgress(cb),
      getNvimFile: () => window.coder.getNvimFile(),
      onNvimFile: (cb) => window.coder.onNvimFile(
        (f) => cb(f)
      )
    };
  }
});

// src/lib/api.ts
async function ensureSidecar() {
  if (sidecarUrl) return sidecarUrl;
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
var sidecarUrl;
var init_api = __esm({
  "src/lib/api.ts"() {
    "use strict";
    init_fs();
    sidecarUrl = null;
    api.onSidecarChanged(() => {
      sidecarUrl = null;
    });
  }
});

// src/lib/modes.ts
function normalizeMode(id) {
  if (id === "chat") return "ask";
  if (id === "codewriter") return "coder";
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
    BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id));
    FALLBACK_MODE = BUILTIN_MODES[0];
  }
});

// src/lib/secrets.ts
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
var PREFIX, keyPromise, enc, dec, SECRET_KEYS;
var init_secrets = __esm({
  "src/lib/secrets.ts"() {
    "use strict";
    PREFIX = "enc:v1:";
    keyPromise = null;
    enc = new TextEncoder();
    dec = new TextDecoder();
    SECRET_KEYS = ["apiKey", "oauthClientId", "oauthClientSecret", "oauthRefreshToken"];
  }
});

// src/lib/provider-meta.ts
var PROVIDER_META;
var init_provider_meta = __esm({
  "src/lib/provider-meta.ts"() {
    "use strict";
    PROVIDER_META = {
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

// src/lib/store.ts
import { create } from "zustand";
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
        delete msg.streaming;
        delete msg.thinking;
        delete msg.toolActivity;
        return msg;
      })
    };
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
  if ("codewriter" in out && !("coder" in out)) {
    out.coder = out.codewriter;
    delete out.codewriter;
  }
  return out;
}
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useStore.getState().persist(), 500);
}
function flushPendingPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = void 0;
  }
  return writeStateNow(useStore.getState());
}
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
      out.push({ providerId: "", model: entry.trim() });
    } else if (entry && typeof entry === "object") {
      const e = entry;
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const pid = typeof e.providerId === "string" ? e.providerId : "";
      if (model) out.push({ providerId: pid === "ollama" ? "local" : pid, model });
    }
  }
  return out.slice(0, 20);
}
function makeChat(mode = "ask") {
  const now = Date.now();
  const s = useStore.getState();
  const activeProvider = s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ?? s.settings.providers[0];
  return {
    id: uid(),
    title: "New chat",
    mode,
    thinkingLevel: "medium",
    providerId: activeProvider?.id,
    model: activeProvider?.model,
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
var uid, MODE_LABELS, SEARCH_PLUGIN_LABELS, persistTimer, persistSeq, historyStacks, PROVIDER_NAMES, useStore;
var init_store = __esm({
  "src/lib/store.ts"() {
    "use strict";
    init_fs();
    init_api();
    init_modes();
    init_secrets();
    init_provider_meta();
    init_themes();
    uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    MODE_LABELS = { ask: "Ask", plan: "Plan", coder: "Coder" };
    SEARCH_PLUGIN_LABELS = {
      duckduckgo: "DuckDuckGo",
      tavily: "Tavily"
    };
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        void flushPendingPersist();
      });
      api.onFlushPersist(() => {
        flushPendingPersist().catch(() => {
        }).finally(() => {
          api.flushPersistDone();
        });
      });
    }
    persistSeq = 0;
    historyStacks = /* @__PURE__ */ new Map();
    PROVIDER_NAMES = Object.fromEntries(
      Object.values(PROVIDER_META).map((m) => [m.kind, m.name])
    );
    useStore = create((set, get) => ({
      loaded: false,
      settingsHydrated: false,
      settings: { providers: defaultProviders(), activeProviderId: "opencode", systemPrompts: {}, mcpServers: {}, mcpEnabled: [], modes: [], compactThreshold: 80 },
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
          compactThreshold: typeof raw.compactThreshold === "number" && raw.compactThreshold >= 50 && raw.compactThreshold <= 95 ? raw.compactThreshold : 80
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
          persistSoon();
          return;
        }
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
        set((s) => {
          const recentModels = [
            { providerId: pid, model: m },
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
      addMessage: (chatId, message2) => {
        const id = uid();
        const full = { ...message2, id, createdAt: Date.now() };
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
        if (!get().anyStreaming()) persistSoon();
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
            const boundary = messages.findIndex((m) => !m.compacted);
            messages.splice(boundary === -1 ? messages.length : boundary, 0, summaryMsg);
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
      setCompactThreshold: (pct) => {
        set((s) => ({ settings: { ...s.settings, compactThreshold: pct } }));
        get().persist();
      },
      setNvimFile: (abs) => set({ nvimFile: abs }),
      setNvimDiagnostics: (diagnostics) => set({ nvimDiagnostics: diagnostics })
    }));
    api.onSidecarChanged(() => {
      void useStore.getState().load();
    });
  }
});

// src/lib/bidi.ts
function stripBidiMarks(text) {
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
function prepareContent(text, _dir) {
  if (!text) return text;
  const cleaned = stripBidiMarks(text);
  const parts = cleaned.split(/```/g);
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p;
    return fixZwsp(p);
  });
  return fixed.join("```");
}
var PERSIAN_RANGE, BIDI_MARKS, INVISIBLE_SEP, LEFT_WORDISH, RIGHT_WORDISH, RTL_CHAR_RE;
var init_bidi = __esm({
  "src/lib/bidi.ts"() {
    "use strict";
    PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
    BIDI_MARKS = /[\u202A-\u202E\u2066-\u2069]/g;
    INVISIBLE_SEP = /[\u200B\u200E\u200F\u061C]+/g;
    LEFT_WORDISH = /[\p{L}\p{N}\)\]\u060C\u061B\u061F,.;!?:»«\u2013\u2014"']/u;
    RIGHT_WORDISH = /[\p{L}\p{N}(*_`\[\u2013\u2014«»"']/u;
    RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
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

// test/css-stub.js
var init_css_stub = __esm({
  "test/css-stub.js"() {
    "use strict";
  }
});

// src/components/ReadingMode.tsx
var ReadingMode_exports = {};
__export(ReadingMode_exports, {
  ReadingMode: () => ReadingMode
});
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { jsx, jsxs } from "react/jsx-runtime";
function ReadingMode({
  message: message2,
  onClose
}) {
  const dir = useStore((s) => s.dir);
  const sections = useMemo(() => splitSections(message2.content), [message2.content]);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const section = sections[active];
  if (!section) return null;
  const askFor = (s) => {
    useStore.getState().forkSection(message2.id, s.title, s.content);
    onClose();
  };
  const copy = async () => {
    try {
      await copyToClipboard(section.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  return /* @__PURE__ */ jsx("div", { className: "modal-overlay reading-mode-overlay", onClick: onClose, children: /* @__PURE__ */ jsxs(
    "div",
    {
      className: "modal settings-modal reading-mode",
      onClick: (e) => e.stopPropagation(),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "settings-header", children: [
          /* @__PURE__ */ jsxs("div", { className: "settings-header-title", children: [
            /* @__PURE__ */ jsx("h2", { children: "\u{1F4D6} \u062D\u0627\u0644\u062A \u0645\u0637\u0627\u0644\u0639\u0647" }),
            /* @__PURE__ */ jsxs("span", { className: "settings-header-tab", children: [
              "\u0628\u062E\u0634 ",
              active + 1,
              " \u0627\u0632 ",
              sections.length
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "modal-close",
              onClick: onClose,
              title: "Close (Esc)",
              "aria-label": "Close",
              children: "\u2715"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "settings-body reading-mode-body", children: [
          /* @__PURE__ */ jsx("div", { className: "reading-mode-list", dir, children: sections.map((s, i) => /* @__PURE__ */ jsxs(
            "div",
            {
              className: `reading-mode-item${i === active ? " active" : ""}`,
              children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    className: "reading-mode-item-title",
                    onClick: () => setActive(i),
                    title: s.title,
                    children: /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: "reading-mode-item-level",
                        style: { paddingInlineStart: (s.level - 1) * 12 },
                        children: s.title
                      }
                    )
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    className: "reading-mode-ask",
                    onClick: () => askFor(s),
                    title: "\u0633\u0648\u0627\u0644 \u0627\u0632 \u0627\u06CC\u0646 \u0628\u062E\u0634 \u2014 \u0686\u062A \u062C\u062F\u06CC\u062F",
                    "aria-label": "\u0633\u0648\u0627\u0644 \u0627\u0632 \u0627\u06CC\u0646 \u0628\u062E\u0634",
                    children: "\u{1F4AC}"
                  }
                )
              ]
            },
            s.id
          )) }),
          /* @__PURE__ */ jsxs("div", { className: "settings-content reading-mode-content", children: [
            /* @__PURE__ */ jsxs("div", { className: "reading-mode-content-head", children: [
              /* @__PURE__ */ jsx("h3", { dir, children: section.title }),
              /* @__PURE__ */ jsxs("div", { className: "reading-mode-content-actions", children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    className: `msg-copy reading-mode-copy${copied ? " copied" : ""}`,
                    onClick: copy,
                    title: "Copy section",
                    children: copied ? "Copied \u2713" : "Copy"
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    className: "reading-mode-ask-btn",
                    onClick: () => askFor(section),
                    title: "\u0686\u062A \u062C\u062F\u06CC\u062F \u0628\u0627 \u0632\u0645\u06CC\u0646\u0647 \u0627\u06CC\u0646 \u0628\u062E\u0634",
                    children: "\u{1F4AC} \u0633\u0648\u0627\u0644 \u0627\u0632 \u0627\u06CC\u0646 \u0628\u062E\u0634"
                  }
                )
              ] })
            ] }),
            /* @__PURE__ */ jsx("div", { className: "chat-message markdown-body", dir: "auto", children: /* @__PURE__ */ jsx(
              ReactMarkdown,
              {
                remarkPlugins: [remarkGfm],
                rehypePlugins: [rehypeHighlight],
                children: prepareContent(section.content, dir)
              }
            ) })
          ] })
        ] })
      ]
    }
  ) });
}
var init_ReadingMode = __esm({
  "src/components/ReadingMode.tsx"() {
    "use strict";
    init_sections();
    init_store();
    init_bidi();
    init_clipboard();
    init_css_stub();
  }
});

// test/dump-ssr.mjs
import { jsx as jsx2 } from "react/jsx-runtime";
globalThis.window = {
  addEventListener: () => {
  },
  coder: new Proxy({}, { get: (_t, prop) => {
    if (prop === "then") return void 0;
    return async () => {
    };
  } })
};
var { renderToString } = await import("react-dom/server");
var { ReadingMode: ReadingMode2 } = await Promise.resolve().then(() => (init_ReadingMode(), ReadingMode_exports));
var message = {
  id: "m1",
  role: "assistant",
  content: "## \u0628\u062E\u0634 \u0627\u0644\u0641\n\n\u0645\u062A\u0646 \u0627\u0644\u0641\n\n## \u0628\u062E\u0634 \u0628\n\n\u0645\u062A\u0646 \u0628",
  createdAt: Date.now()
};
var html = renderToString(/* @__PURE__ */ jsx2(ReadingMode2, { message, onClose: () => {
} }));
console.log(html);
