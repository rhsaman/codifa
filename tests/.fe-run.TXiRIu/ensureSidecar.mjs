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
var PERSIAN_RANGE, RTL_CHAR_RE, FA_DIGITS, DIGITS_RE, LINE_RANGE_RE, LINE_RANGE_CONN_RE, PATH_RE, BARE_RANGE_FENCE_RE, MIXED_WORD_RE, SCRIPT_BOUNDARY_RE;
var init_bidi = __esm({
  "src/lib/bidi.ts"() {
    "use strict";
    PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
    RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
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
    MIXED_WORD_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
    SCRIPT_BOUNDARY_RE = new RegExp(
      `([${PERSIAN_RANGE}])([A-Za-z0-9_])|([A-Za-z0-9_])([${PERSIAN_RANGE}])`,
      "g"
    );
  }
});

// src/lib/context.ts
function modelContextWindow(provider, model) {
  if (!provider) return null;
  const manual = provider.manualContextMap ?? {};
  const directManual = manual[model];
  if (directManual && directManual > 0) return directManual;
  const prefixedManual = manual[`${provider.id ?? ""}/${model}`];
  if (prefixedManual && prefixedManual > 0) return prefixedManual;
  const map = provider.contextMap ?? {};
  const direct = map[model];
  if (direct && direct > 0) return direct;
  const prefixed = map[`${provider.id ?? ""}/${model}`];
  if (prefixed && prefixed > 0) return prefixed;
  return null;
}
var PERSIAN_CHAR;
var init_context = __esm({
  "src/lib/context.ts"() {
    "use strict";
    init_bidi();
    PERSIAN_CHAR = new RegExp(`[${PERSIAN_RANGE}\\u200C\\u200D]`);
  }
});

// src/lib/api.ts
var api_exports = {};
__export(api_exports, {
  cancelModelDownload: () => cancelModelDownload,
  cancelSteer: () => cancelSteer,
  clearChatTraces: () => clearChatTraces,
  clearMemory: () => clearMemory,
  clearOrphanScheduleRuns: () => clearOrphanScheduleRuns,
  clearScheduleRuns: () => clearScheduleRuns,
  createRealtimeSession: () => createRealtimeSession,
  deleteMcp: () => deleteMcp,
  deleteSchedule: () => deleteSchedule,
  deleteScheduleRun: () => deleteScheduleRun,
  downloadModel: () => downloadModel,
  ensureSidecar: () => ensureSidecar,
  fetchCredits: () => fetchCredits,
  fetchModels: () => fetchModels,
  fetchPlan: () => fetchPlan,
  fetchSystemPrompts: () => fetchSystemPrompts,
  getChatTraces: () => getChatTraces,
  getMemoryStats: () => getMemoryStats,
  getModelsStatus: () => getModelsStatus,
  getSkillFile: () => getSkillFile,
  gitAutoCommit: () => gitAutoCommit,
  gitBranches: () => gitBranches,
  gitCheckout: () => gitCheckout,
  gitCommit: () => gitCommit,
  gitDiff: () => gitDiff,
  gitDiscard: () => gitDiscard,
  gitLog: () => gitLog,
  gitPush: () => gitPush,
  gitShow: () => gitShow,
  gitStatus: () => gitStatus,
  invalidateSidecarCache: () => invalidateSidecarCache,
  listAllScheduleRuns: () => listAllScheduleRuns,
  listCheckpoints: () => listCheckpoints,
  listMcp: () => listMcp,
  listScheduleRuns: () => listScheduleRuns,
  listSchedules: () => listSchedules,
  listSkills: () => listSkills,
  normalizeSystemPromptKeys: () => normalizeSystemPromptKeys,
  pauseModelDownload: () => pauseModelDownload,
  preloadLocalModel: () => preloadLocalModel,
  providerKeys: () => providerKeys,
  readDocumentText: () => readDocumentText,
  removeModel: () => removeModel,
  requestChatTitle: () => requestChatTitle,
  respondAsk: () => respondAsk,
  respondPermission: () => respondPermission,
  restoreCheckpoint: () => restoreCheckpoint,
  resumeModelDownload: () => resumeModelDownload,
  runScheduleNow: () => runScheduleNow,
  saveMcp: () => saveMcp,
  saveSchedule: () => saveSchedule,
  speakText: () => speakText,
  speakTextStream: () => speakTextStream,
  splitTtsSentences: () => splitTtsSentences,
  steerChat: () => steerChat,
  streamChat: () => streamChat,
  syncSkill: () => syncSkill,
  testModel: () => testModel,
  testModelsBatch: () => testModelsBatch,
  transcribeAudio: () => transcribeAudio,
  triggerCompact: () => triggerCompact
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
function invalidateSidecarCache() {
  sidecarUrl = null;
  sidecarInFlight = null;
}
function providerKeys(cfg) {
  const raw = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : [];
  const out = raw.filter((k) => typeof k === "string" && k.trim() !== "");
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim() !== "" && !out.includes(cfg.apiKey.trim())) out.push(cfg.apiKey.trim());
  return out;
}
async function createRealtimeSession(opts) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const body = {
    provider: opts.kind,
    base_url: opts.baseUrl
  };
  const keys = (opts.apiKeys ?? []).filter((k) => typeof k === "string" && k);
  if (keys.length > 0) body.api_keys = JSON.stringify(keys);
  if ((opts.model ?? "").trim()) body.model = (opts.model ?? "").trim();
  if ((opts.voice ?? "").trim()) body.voice = (opts.voice ?? "").trim();
  const post = async (base) => {
    const res = await fetch(`${base}/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3e4)
    });
    if (!res.ok) {
      const data2 = await res.json().catch(() => ({}));
      throw new Error(
        data2.detail || `realtime session failed (${res.status})`
      );
    }
    const data = await res.json();
    const ephemeralToken = data.ephemeral_token ?? data.ephemeralToken ?? "";
    const websocketUrl = data.websocket_url ?? data.websocketUrl ?? "";
    const expiresAt = data.expires_at ?? data.expiresAt ?? "";
    if (!ephemeralToken || !websocketUrl) throw new Error("realtime session failed (bad response)");
    return { ephemeralToken, websocketUrl, expiresAt };
  };
  try {
    return await post(url);
  } catch (err) {
    if (err instanceof TypeError) {
      sidecarUrl = null;
      const retryUrl = await ensureSidecar();
      if (retryUrl && retryUrl !== url) return await post(retryUrl);
    }
    throw err;
  }
}
async function speakText(text, opts, callerSignal) {
  return await speakTextStream(text, opts, void 0, callerSignal);
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
async function transcribeAudio(blob, onModelLoading, lang, opts) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const form = new FormData();
  form.append("audio", blob, "clip.wav");
  if (lang) form.append("lang", lang);
  if (opts) {
    form.append("provider", opts.kind);
    form.append("base_url", opts.baseUrl);
    const sttKeys = (opts.apiKeys ?? []).filter((k) => typeof k === "string" && k);
    if (sttKeys.length > 0) form.append("api_keys", JSON.stringify(sttKeys));
    if (opts.model) form.append("model", opts.model);
  }
  if (onModelLoading) onModelLoading(true);
  try {
    const res = await fetch(`${url}/transcribe`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(12e4)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        body.detail || `transcription failed (${res.status})`
      );
    }
    const data = await res.json();
    const cleanText = (data.text ?? "").trim();
    if (cleanText && (cleanText.includes("<link") || cleanText.includes("/_next/") || cleanText.includes("&lt;") || /<\/?[a-z]/i.test(cleanText))) {
      throw new Error("Transcription returned an error page \u2014 please try again.");
    }
    return cleanText;
  } catch (err) {
    if (err instanceof TypeError) {
      sidecarUrl = null;
      const retryUrl = await ensureSidecar();
      if (retryUrl && retryUrl !== url) {
        const res = await fetch(`${retryUrl}/transcribe`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(12e4)
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body.detail || `transcription failed (${res.status})`
          );
        }
        const data = await res.json();
        const retryText = (data.text ?? "").trim();
        if (retryText && (retryText.includes("<link") || retryText.includes("/_next/") || retryText.includes("&lt;") || /<\/?[a-z]/i.test(retryText))) {
          throw new Error("Transcription returned an error page \u2014 please try again.");
        }
        return retryText;
      }
    }
    throw err;
  } finally {
    if (onModelLoading) onModelLoading(false);
  }
}
function preloadLocalModel(kind) {
  void (async () => {
    try {
      const url = await ensureSidecar();
      if (!url) return;
      await fetch(`${url}/models/preload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
        signal: AbortSignal.timeout(1e4)
      }).catch(() => null);
    } catch {
    }
  })();
}
async function fetchModels(cfg) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const sig = providerRequestKey(cfg);
  const cached = modelsInFlight.get(sig);
  if (cached) return cached;
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_keys: JSON.stringify(providerKeys(cfg))
  });
  const p = (async () => {
    const res = await fetch(`${url}/models?${params}`, { signal: AbortSignal.timeout(9e4) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `models request failed (${res.status})`);
    }
    const data = await res.json();
    const models = [];
    const context = {};
    const pricing = {};
    const reasoning = {};
    for (const m of data.models ?? []) {
      models.push(m.id);
      if (m.context) context[m.id] = m.context;
      if (m.pricing) pricing[m.id] = m.pricing;
      if (typeof m.reasoning === "boolean") reasoning[m.id] = m.reasoning;
    }
    return { models, context, pricing, reasoning };
  })();
  modelsInFlight.set(sig, p);
  p.finally(() => {
    setTimeout(() => {
      if (modelsInFlight.get(sig) === p) modelsInFlight.delete(sig);
    }, 1e3);
  }).catch(() => {
  });
  return p;
}
async function testModel(cfg, model) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const body = {
    provider: cfg.kind,
    provider_id: cfg.id ?? "",
    base_url: cfg.baseUrl ?? "",
    api_keys: providerKeys(cfg),
    model
  };
  const res = await fetch(`${url}/models/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // > backend's 65s cap so the server's real error message surfaces
    // instead of a client-side abort.
    signal: AbortSignal.timeout(75e3)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `model test failed (${res.status})`);
  }
  return await res.json();
}
async function testModelsBatch(cfg, models) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const uniq = [...new Set(models.filter((m) => typeof m === "string" && m.trim() !== ""))].slice(0, 100);
  if (uniq.length === 0) return [];
  const res = await fetch(`${url}/models/test-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: cfg.kind,
      provider_id: cfg.id ?? "",
      base_url: cfg.baseUrl ?? "",
      api_keys: providerKeys(cfg),
      models: uniq
    }),
    signal: AbortSignal.timeout(75e3)
  });
  if (!res.ok) {
    const data2 = await res.json().catch(() => ({}));
    throw new Error(data2.detail || `model batch test failed (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}
function providerRequestKey(cfg) {
  return [
    cfg.id,
    cfg.kind,
    cfg.baseUrl ?? "",
    providerKeys(cfg).join(",")
  ].join("|");
}
async function fetchCredits(cfg) {
  const url = await ensureSidecar();
  if (!url) return {};
  const sig = providerRequestKey(cfg);
  const cached = creditsInFlight.get(sig);
  if (cached) return cached;
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_keys: JSON.stringify(providerKeys(cfg))
  });
  const p = (async () => {
    try {
      const res = await fetch(`${url}/credits?${params}`, { signal: AbortSignal.timeout(15e3) });
      if (!res.ok) return {};
      const data = await res.json();
      return data;
    } catch {
      return {};
    }
  })();
  creditsInFlight.set(sig, p);
  p.finally(() => {
    setTimeout(() => {
      if (creditsInFlight.get(sig) === p) creditsInFlight.delete(sig);
    }, 1e3);
  });
  return p;
}
async function streamChat(params, onEvent) {
  let url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const MAX_RECONNECT_ATTEMPTS = 5;
  const BASE_BACKOFF_MS = 1e3;
  let gotDone = false;
  let gotAnyEvent = false;
  const wrappedOnEvent = (e) => {
    if (e?.kind === "done") gotDone = true;
    gotAnyEvent = true;
    onEvent(e);
  };
  const parseFrame = (frame) => {
    for (const line of frame.split("\n")) {
      if (line.startsWith(": ")) {
        wrappedOnEvent({ kind: "keepalive" });
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        const event = JSON.parse(raw);
        wrappedOnEvent(event);
      } catch {
      }
    }
  };
  let attempt = 0;
  while (true) {
    if (params.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (attempt > 0) {
      url = await ensureSidecar();
      if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
    }
    let res;
    try {
      res = await fetch(`${url}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: params.signal,
        body: JSON.stringify({
          // `provider` stays as the kind so the backend can keep using it as
          // the model-lookup / timeout key, which is provider-KIND-scoped
          // (e.g. "openrouter" / "opencode" / "google"). `provider_id` carries
          // the user-configured id so per-usage entries group under the right
          // provider even when several providers share the same kind.
          provider: params.provider.kind,
          provider_id: params.provider.id,
          api_keys: providerKeys(params.provider),
          base_url: params.provider.baseUrl,
          model: params.provider.model,
          root: params.root,
          mode: params.mode,
          prompt: params.prompt,
          chat_id: params.chatId ?? "",
          history: params.history,
          attachments: params.attachments ?? [],
          images: params.images ?? [],
          system_prompt: params.systemPrompt ?? "",
          thinking_level: params.thinkingLevel ?? "",
          model_reasoning: params.modelReasoning ?? false,
          mcp_servers: params.mcpServers ?? {},
          skills: params.skills ?? [],
          allow_create: params.allowCreate ?? false,
          cap: params.cap ?? {},
          allow_outside: params.allowOutside ?? false,
          allow_outside_folders: params.allowOutsideFolders ?? [],
          allow_computer: params.allowComputer ?? false,
          vector_db_path: params.vectorDbPath ?? "",
          vector_config: params.vectorConfig ?? null,
          subagent_models: params.subagentModels ?? {},
          providers: params.providers ?? {},
          // Single auto-compaction threshold as a percentage of the raw window.
          compact_at_percent: params.compactAtPercent ?? 80,
          restart: params.restart ?? false,
          goal: params.goal ?? null,
          goal_turns: params.goalTurns ?? 0,
          context_window: modelContextWindow(params.provider, params.provider.model) ?? 0
        })
      });
    } catch (err) {
      if (params.signal?.aborted) throw err;
      wrappedOnEvent({
        kind: "retry",
        attempt: attempt + 1,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        reason: "Connection lost \u2014 reconnecting from checkpoint\u2026",
        reconnecting: true
      });
      attempt++;
      if (attempt > MAX_RECONNECT_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
      continue;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `chat request failed (${res.status})`);
    }
    if (!res.body) throw new Error("no response body");
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          parseFrame(chunk);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) parseFrame(buffer);
      if (!gotDone) {
        throw new Error("SSE stream ended without a terminal 'done' event (sidecar drop)");
      }
      return;
    } catch (err) {
      if (params.signal?.aborted || err.name === "AbortError") throw err;
      if (gotAnyEvent) {
        throw new Error(
          "Connection lost mid-turn \u2014 the turn was interrupted. Click Retry to resume from the last checkpoint."
        );
      }
      wrappedOnEvent({
        kind: "retry",
        attempt: attempt + 1,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        reason: "Connection lost \u2014 reconnecting from checkpoint\u2026",
        reconnecting: true
      });
      attempt++;
      if (attempt > MAX_RECONNECT_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
      continue;
    }
  }
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
async function triggerCompact(params) {
  const url = await ensureSidecar();
  if (!url) throw new Error("Python agent not ready \u2014 run `npm run setup`");
  const res = await fetch(`${url}/chat/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: params.signal,
    body: JSON.stringify({
      provider: params.provider.kind,
      model: params.provider.model,
      base_url: params.provider.baseUrl,
      api_keys: params.provider.apiKeys,
      provider_id: params.provider.id ?? "",
      fallback_provider: params.fallback.kind,
      fallback_model: params.fallback.model,
      fallback_base_url: params.fallback.baseUrl,
      fallback_api_keys: params.fallback.apiKeys,
      fallback_provider_id: params.fallback.id ?? "",
      history: params.history,
      context_window: params.contextWindow ?? 0,
      compact_at_percent: params.compactAtPercent ?? 80
    })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `compact request failed (${res.status})`);
  }
  return await res.json();
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
async function readDocumentText(root, absPath, format = "text", opts) {
  const url = await ensureSidecar();
  if (!url) return { error: "agent backend is not running" };
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
async function respondPermission(id, allowed) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/permission/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, allowed })
    });
  } catch {
  }
}
async function respondAsk(id, answer) {
  const url = await ensureSidecar();
  if (!url) return;
  try {
    await fetch(`${url}/ask/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer })
    });
  } catch {
  }
}
async function downloadModel(kind, model, baseUrl = "") {
  const url = await ensureSidecar();
  if (!url) return;
  await fetch(`${url}/models/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, model, base_url: baseUrl })
  });
}
async function getModelsStatus() {
  const url = await ensureSidecar();
  if (!url) return { whisper: { dirs: [] }, embedding: { dirs: [] } };
  const res = await fetch(`${url}/models/status`);
  if (!res.ok) return { whisper: { dirs: [] }, embedding: { dirs: [] } };
  const data = await res.json();
  return {
    whisper: data.whisper ?? { dirs: [] },
    embedding: data.embedding ?? { dirs: [] },
    decision: data.decision,
    piper: data.piper
  };
}
async function removeModel(kind, model) {
  const url = await ensureSidecar();
  if (!url) return;
  await fetch(`${url}/models/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, model })
  });
}
async function pauseModelDownload(kind) {
  const url = await ensureSidecar();
  if (!url) return;
  const res = await fetch(`${url}/models/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.detail || `pause failed (${res.status})`
    );
  }
}
async function resumeModelDownload(kind) {
  const url = await ensureSidecar();
  if (!url) return;
  const res = await fetch(`${url}/models/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.detail || `resume failed (${res.status})`
    );
  }
}
async function cancelModelDownload(kind) {
  const url = await ensureSidecar();
  if (!url) return;
  const res = await fetch(`${url}/models/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.detail || `stop failed (${res.status})`
    );
  }
}
async function listSkills() {
  const url = await ensureSidecar();
  if (!url) {
    console.error("[skills] listSkills: sidecar not available");
    return [];
  }
  try {
    const res = await fetch(`${url}/skills`);
    if (!res.ok) {
      console.error(`[skills] listSkills: /skills returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.skills ?? [];
  } catch (err) {
    console.error("[skills] listSkills: fetch failed", err);
    return [];
  }
}
async function getSkillFile(name, file) {
  const url = await ensureSidecar();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/skills/file?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.content === "string" ? data.content : null;
  } catch {
    return null;
  }
}
function normalizeSystemPromptKeys(prompts) {
  const out = { ...prompts };
  for (const [legacy, canonical] of Object.entries(LEGACY_PROMPT_KEYS)) {
    const value = out[legacy];
    delete out[legacy];
    if (value !== void 0 && out[canonical] === void 0) out[canonical] = value;
  }
  return out;
}
async function fetchSystemPrompts() {
  const url = await ensureSidecar();
  if (!url) return {};
  try {
    const res = await fetch(`${url}/system-prompts`);
    if (!res.ok) return {};
    return normalizeSystemPromptKeys(await res.json());
  } catch (err) {
    console.error("[prompts] fetchSystemPrompts: fetch failed", err);
    return {};
  }
}
async function syncSkill(params) {
  const url = await ensureSidecar();
  if (!url) return { ok: false, note: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/skills/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: params.name,
        previous_name: params.previousName ?? "",
        content: params.content ?? "",
        description: params.description ?? "",
        delete: params.delete ?? false,
        // Multi-file (Codex-style) skills: extra file contents to upsert.
        // Omitted when undefined so single-file skills are unaffected.
        // Send both spellings for backend compatibility.
        ...params.files !== void 0 ? { extra_files: params.files, files: params.files } : {},
        // Deleted extra files. Send both spellings for backend compatibility.
        ...params.deletedFiles !== void 0 && params.deletedFiles.length > 0 ? { deleted_files: params.deletedFiles, deletedFiles: params.deletedFiles } : {}
      })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, note: body.detail || `save failed (${res.status})` };
    }
    return await res.json();
  } catch {
    return { ok: false, note: "could not reach the agent" };
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
async function getMemoryStats(root, vectorDbPath) {
  const url = await ensureSidecar();
  const empty = {
    available: false,
    db: "",
    docs: 0,
    chunks: 0,
    kinds: {},
    max_docs: 0,
    max_chunks: 0,
    ttl_days: 0
  };
  if (!url || !root) return empty;
  try {
    const qs = new URLSearchParams({ root });
    if (vectorDbPath) qs.set("vector_db_path", vectorDbPath);
    const res = await fetch(`${url}/memory/stats?${qs.toString()}`);
    if (!res.ok) return empty;
    return { ...empty, ...await res.json() };
  } catch {
    return empty;
  }
}
async function clearMemory(root, vectorDbPath) {
  const url = await ensureSidecar();
  if (!url || !root) return { ok: false, error: "no active workspace" };
  try {
    const res = await fetch(`${url}/memory/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, vector_db_path: vectorDbPath ?? "" })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.detail || `clear failed (${res.status})` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function listCheckpoints(chatId) {
  const url = await ensureSidecar();
  if (!url || !chatId) return [];
  try {
    const res = await fetch(`${url}/checkpoints/${encodeURIComponent(chatId)}`);
    if (!res.ok) return [];
    const body = await res.json();
    return body.checkpoints ?? [];
  } catch {
    return [];
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
async function sidecarGet(path) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.detail || `request failed (${res.status})` };
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
async function gitCommit(root, message, addAll = false) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, message, add_all: addAll })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.detail || `commit failed (${res.status})` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function gitDiscard(root) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/git/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      return { error: body.detail || `discard failed (${res.status})` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function gitBranches(root) {
  return sidecarGet(`/git/branches?root=${encodeURIComponent(root)}`);
}
async function gitCheckout(root, branch, create = false) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, branch, create })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.detail || `checkout failed (${res.status})` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function gitPush(root) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/git/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.detail || `push failed (${res.status})` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function gitAutoCommit(root, provider) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/git/autocommit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root,
        provider: provider.kind,
        model: provider.model,
        base_url: provider.baseUrl,
        api_keys: provider.apiKeys,
        provider_id: provider.id ?? ""
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.detail || `autocommit failed (${res.status})` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function listSchedules() {
  const out = await sidecarGet("/schedules");
  if ("error" in out) return out;
  return out.schedules ?? [];
}
async function saveSchedule(task) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.schedule) return { error: body.detail || `save failed (${res.status})` };
    return body.schedule;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function deleteSchedule(id) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.detail || `delete failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function runScheduleNow(id) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });
    if (!res.ok) {
      const body2 = await res.json().catch(() => ({}));
      return { error: body2.detail || `run failed (${res.status})` };
    }
    const body = await res.json().catch(() => ({}));
    return typeof body.run_id === "string" && body.run_id ? { ok: true, run_id: body.run_id } : { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  if (!url) return { error: "Python agent not ready" };
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
  if (!url) return { error: "Python agent not ready" };
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
async function deleteScheduleRun(runId) {
  const url = await ensureSidecar();
  if (!url) return { error: "Python agent not ready" };
  try {
    const res = await fetch(`${url}/schedule-runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body.detail || `delete failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function getChatTraces(chatId, kind, taskId) {
  if (!chatId) return [];
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (taskId) params.set("task_id", taskId);
  const qs = params.toString();
  const out = await sidecarGet(
    `/chats/${encodeURIComponent(chatId)}/traces${qs ? `?${qs}` : ""}`
  );
  if ("error" in out) return out;
  return out.traces ?? [];
}
async function clearChatTraces(chatId) {
  const url = await ensureSidecar();
  if (!url || !chatId) return { error: "Python agent not ready" };
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
var sidecarUrl, sidecarInFlight, modelsInFlight, creditsInFlight, LEGACY_PROMPT_KEYS;
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
    modelsInFlight = /* @__PURE__ */ new Map();
    creditsInFlight = /* @__PURE__ */ new Map();
    LEGACY_PROMPT_KEYS = {
      chat: "ask",
      codewriter: "build"
    };
  }
});

// tests/ensureSidecar.test.ts
var onChanged = null;
var onDead = null;
var sidecarUrlCalls = 0;
globalThis.window = {
  addEventListener: () => {
  },
  dispatchEvent: () => {
  },
  localStorage: { getItem: () => null, setItem: () => {
  }, removeItem: () => {
  } },
  coder: {
    getSidecarUrl: async () => {
      sidecarUrlCalls++;
      return "http://127.0.0.1:8899";
    },
    onSidecarChanged: (cb) => {
      onChanged = cb;
      return () => {
      };
    },
    onSidecarDead: (cb) => {
      onDead = cb;
      return () => {
      };
    }
  }
};
globalThis.localStorage = globalThis.window.localStorage;
var failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  \u2705 ${name}`);
  else {
    failed++;
    console.error(`  \u274C ${name}`, extra ?? "");
  }
}
var aliveUrl = null;
globalThis.fetch = async (url) => {
  if (url.endsWith("/health")) {
    if (aliveUrl && url.startsWith(aliveUrl)) return new Response("", { status: 200 });
    throw new Error("connection refused");
  }
  return new Response("", { status: 200 });
};
var { ensureSidecar: ensureSidecar2 } = await Promise.resolve().then(() => (init_api(), api_exports));
function reset() {
  aliveUrl = null;
  sidecarUrlCalls = 0;
  onChanged?.();
}
console.log("\u06F1) \u0627\u0648\u0644\u06CC\u0646 \u0641\u0631\u0627\u062E\u0648\u0627\u0646\u06CC \u2192 getSidecarUrl \u0635\u062F\u0627 \u0632\u062F\u0647 \u0645\u06CC\u0634\u0648\u062F \u0648 \u0622\u062F\u0631\u0633 \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F:");
{
  reset();
  aliveUrl = "http://127.0.0.1:8899";
  const url = await ensureSidecar2();
  check("\u0622\u062F\u0631\u0633 \u0628\u0631\u06AF\u0634\u062A\u06CC = http://127.0.0.1:8899", url === "http://127.0.0.1:8899", url);
  check("getSidecarUrl \u062F\u0642\u06CC\u0642\u0627\u064B \u06CC\u06A9 \u0628\u0627\u0631 \u0635\u062F\u0627 \u0632\u062F\u0647 \u0634\u062F", sidecarUrlCalls === 1, sidecarUrlCalls);
}
console.log("\u06F2) \u06A9\u0634 \u0632\u0646\u062F\u0647 \u2192 health-check \u0645\u0648\u0641\u0642\u060C \u0647\u0645\u0627\u0646 \u0622\u062F\u0631\u0633 \u06A9\u0634 \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F (\u0628\u062F\u0648\u0646 restart):");
{
  reset();
  aliveUrl = "http://127.0.0.1:8899";
  const first = await ensureSidecar2();
  const second = await ensureSidecar2();
  check("\u062F\u0648 \u0641\u0631\u0627\u062E\u0648\u0627\u0646\u06CC \u06CC\u06A9\u0633\u0627\u0646\u0627\u0646\u062F (\u06A9\u0634 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0634\u062F)", first === second, { first, second });
  check("getSidecarUrl \u0641\u0642\u0637 \u06CC\u06A9 \u0628\u0627\u0631 \u0635\u062F\u0627 \u0632\u062F\u0647 \u0634\u062F (\u06A9\u0634)", sidecarUrlCalls === 1, sidecarUrlCalls);
}
console.log("\u06F3) \u06A9\u0634 \u0645\u0631\u062F\u0647 \u2192 health-check \u0634\u06A9\u0633\u062A\u060C \u06A9\u0634 \u067E\u0627\u06A9 \u0634\u062F\u0647 \u0648 restart \u0645\u06CC\u0634\u0648\u062F:");
{
  reset();
  aliveUrl = "http://127.0.0.1:8899";
  const first = await ensureSidecar2();
  aliveUrl = null;
  const second = await ensureSidecar2();
  check("\u0641\u0631\u0627\u062E\u0648\u0627\u0646\u06CC \u062F\u0648\u0645 \u0622\u062F\u0631\u0633 \u0645\u0639\u062A\u0628\u0631 \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u0627\u0646\u062F", second === "http://127.0.0.1:8899", second);
  check("getSidecarUrl \u062F\u0648\u0628\u0627\u0631\u0647 \u0635\u062F\u0627 \u0632\u062F\u0647 \u0634\u062F (restart)", sidecarUrlCalls === 2, sidecarUrlCalls);
}
console.log("\u06F4) \u0639\u062F\u0645 \u062F\u0633\u062A\u0631\u0633\u06CC \u0627\u0648\u0644\u06CC\u0647 \u2192 getSidecarUrl null \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u0627\u0646\u062F:");
{
  reset();
  const orig = globalThis.window.coder.getSidecarUrl;
  globalThis.window.coder.getSidecarUrl = async () => {
    sidecarUrlCalls++;
    return null;
  };
  const url = await ensureSidecar2();
  check("\u0622\u062F\u0631\u0633 null \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F", url === null, url);
  globalThis.window.coder.getSidecarUrl = orig;
}
console.log("\u06F5) \u0631\u0648\u06CC\u062F\u0627\u062F sidecar:dead \u0627\u0632 \u0633\u0645\u062A Electron \u2192 \u06A9\u0634 \u067E\u0627\u06A9 \u0645\u06CC\u0634\u0648\u062F \u0648 restart \u0627\u0646\u062C\u0627\u0645 \u0645\u06CC\u0634\u0648\u062F:");
{
  reset();
  aliveUrl = "http://127.0.0.1:8899";
  await ensureSidecar2();
  onDead?.();
  aliveUrl = null;
  const url = await ensureSidecar2();
  check("\u0628\u0639\u062F \u0627\u0632 sidecar:dead\u060C getSidecarUrl \u062F\u0648\u0628\u0627\u0631\u0647 \u0635\u062F\u0627 \u0632\u062F\u0647 \u0634\u062F", sidecarUrlCalls === 2, sidecarUrlCalls);
  check("\u0622\u062F\u0631\u0633 \u0645\u0639\u062A\u0628\u0631 \u0628\u0631\u0645\u06CC\u06AF\u0631\u062F\u062F", url === "http://127.0.0.1:8899", url);
}
console.log("\u06F6) normalizeSystemPromptKeys: legacy backend keys \u2192 canonical mode ids:");
{
  const { normalizeSystemPromptKeys: normalizeSystemPromptKeys2 } = await Promise.resolve().then(() => (init_api(), api_exports));
  const legacy = normalizeSystemPromptKeys2({ chat: "ask prompt", codewriter: "build prompt" });
  check("chat maps to ask", legacy.ask === "ask prompt", legacy);
  check("codewriter maps to build", legacy.build === "build prompt", legacy);
  check("legacy keys dropped", !("chat" in legacy) && !("codewriter" in legacy), legacy);
  const both = normalizeSystemPromptKeys2({ ask: "new prompt", chat: "old prompt" });
  check("canonical key wins over legacy", both.ask === "new prompt", both);
}
if (failed > 0) {
  console.error(`
\u274C ${failed} \u062A\u0633\u062A \u0634\u06A9\u0633\u062A \u062E\u0648\u0631\u062F`);
  process.exit(1);
}
console.log("\n\u2705 \u0647\u0645\u0647\u0654 \u062A\u0633\u062A\u0647\u0627\u06CC ensureSidecar \u067E\u0627\u0633 \u0634\u062F\u0646\u062F");
