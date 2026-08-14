import { app as x, BrowserWindow as F, ipcMain as u, dialog as q, screen as X, desktopCapturer as G, nativeImage as fe } from "electron";
import { spawn as Y, execSync as he, execFile as L } from "child_process";
import * as c from "path";
import * as g from "os";
import * as o from "fs";
import * as pe from "net";
const te = ".coder";
let S = null;
function W() {
  return c.join(x.getPath("userData"), "data-root.json");
}
function ye(n) {
  let t = String(n ?? "").trim();
  return t ? (t === "~" ? t = g.homedir() : t.startsWith("~/") && (t = c.join(g.homedir(), t.slice(2))), c.resolve(t)) : c.join(g.homedir(), te);
}
function A() {
  if (S) return S;
  try {
    if (o.existsSync(W())) {
      const n = JSON.parse(o.readFileSync(W(), "utf-8"));
      if (n && typeof n.path == "string" && n.path.trim())
        return S = c.resolve(n.path), o.mkdirSync(S, { recursive: !0 }), S;
    }
  } catch {
  }
  S = c.join(g.homedir(), te);
  try {
    o.mkdirSync(S, { recursive: !0 });
  } catch {
  }
  return S;
}
function me(n) {
  const t = c.resolve(n);
  o.mkdirSync(t, { recursive: !0 }), S = t;
  try {
    o.writeFileSync(
      W(),
      JSON.stringify({ path: t }, null, 2),
      "utf-8"
    );
  } catch {
  }
  return t;
}
function ne(n, t) {
  o.mkdirSync(t, { recursive: !0 });
  for (const e of o.readdirSync(n)) {
    const r = c.join(n, e), i = c.join(t, e), s = o.statSync(r);
    if (s.isDirectory())
      ne(r, i);
    else if (s.isFile())
      if (!o.existsSync(i)) o.copyFileSync(r, i);
      else try {
        o.copyFileSync(r, i);
      } catch {
      }
  }
}
function re(n) {
  for (const t of o.readdirSync(n)) {
    const e = c.join(n, t);
    let r;
    try {
      r = o.statSync(e);
    } catch {
      continue;
    }
    if (r.isDirectory()) {
      re(e);
      try {
        o.rmdirSync(e);
      } catch {
      }
    } else if (!t.endsWith(".bak"))
      try {
        o.unlinkSync(e);
      } catch {
      }
  }
}
function ge(n) {
  const t = c.resolve(n.trim() || "");
  if (!t) return A();
  const e = A();
  return t === e || t === e || t.startsWith(e + c.sep) ? e : (ne(e, t), me(t), re(e), t);
}
function we(n, t) {
  const e = (a) => {
    const l = String(a ?? "").trim();
    return l ? ye(l) : c.join(A(), "vector-db");
  }, r = e(n), i = e(t);
  if (i === r || !o.existsSync(r)) return i;
  o.mkdirSync(i, { recursive: !0 });
  const s = o.readdirSync(r).filter((a) => a.endsWith(".sqlite") || /\.sqlite-(wal|shm)$/.test(a));
  for (const a of s) {
    const l = c.join(r, a), f = c.join(i, a);
    o.copyFileSync(l, f);
    try {
      o.unlinkSync(l);
    } catch {
    }
  }
  return i;
}
function Se() {
  const n = [
    process.env.CODER_BACKEND,
    c.join(process.cwd(), "backend"),
    c.join(x.getAppPath(), "backend"),
    c.join(process.resourcesPath, "backend"),
    c.join(x.getAppPath(), "resources", "backend")
  ];
  for (const t of n)
    if (t && o.existsSync(c.join(t, "server.py")))
      return t;
  return null;
}
function ve(n) {
  const t = c.join(n, ".venv", "bin", "python");
  if (process.platform === "win32") {
    const e = c.join(n, ".venv", "Scripts", "python.exe");
    return o.existsSync(e) ? { cmd: e, args: [] } : null;
  }
  return o.existsSync(t) ? { cmd: t, args: [] } : null;
}
function xe() {
  const n = process.env.PATH || "", t = /* @__PURE__ */ new Set();
  for (const e of n.split(":")) e && t.add(e);
  for (const e of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ])
    o.existsSync(e) && t.add(e);
  try {
    const e = process.env.SHELL || "/bin/zsh", r = process.platform === "darwin" ? `${e} -l -c 'echo -n "$PATH"'` : `${e} -c 'echo -n "$PATH"'`, i = he(r, { timeout: 3e3, encoding: "utf8" });
    for (const s of i.split(":")) s && t.add(s);
  } catch {
  }
  return Array.from(t).join(":");
}
function be() {
  return new Promise((n, t) => {
    const e = pe.createServer();
    e.unref(), e.on("error", t), e.listen(0, "127.0.0.1", () => {
      const r = e.address();
      if (r && typeof r == "object") {
        const i = r.port;
        e.close(() => n(i));
      } else
        e.close(() => t(new Error("could not allocate port")));
    });
  });
}
let v = null, E = null;
function ie() {
  return v ? Promise.resolve(v) : E || (E = je().finally(() => {
    E = null;
  }), E);
}
async function je() {
  var l, f;
  const n = Se();
  if (!n)
    throw new Error("backend/server.py not found; run `npm run setup`");
  const t = await be(), e = `http://127.0.0.1:${t}`, r = ve(n);
  let i;
  const s = {
    ...process.env,
    PATH: xe(),
    PYTHONIOENCODING: "utf-8",
    // User-level data root (configurable from Settings → Data path). The
    // sidecar owns the SQLite state DB and the skills/plans/mcp files there,
    // so it must agree with Electron about where that root is.
    CODER_DATA_DIR: A()
  };
  if (r)
    i = Y(r.cmd, [...r.args, c.join(n, "server.py"), "--port", String(t)], {
      cwd: n,
      stdio: ["ignore", "pipe", "pipe"],
      env: s
    });
  else {
    const d = ["run", "--project", n, "python", "server.py", "--port", String(t)];
    i = Y("uv", d, {
      cwd: n,
      stdio: ["ignore", "pipe", "pipe"],
      env: s
    });
  }
  (l = i.stdout) == null || l.on("data", (d) => {
    const w = d.toString().trim();
    w && console.log("[sidecar]", w);
  }), (f = i.stderr) == null || f.on("data", (d) => {
    const w = d.toString().trim();
    w && console.error("[sidecar]", w);
  }), i.on("exit", (d) => {
    console.error(`[sidecar] exited with code ${d}`), v = null;
  }), i.on("error", (d) => {
    console.error("[sidecar] spawn error", d), v = null;
  });
  const a = Date.now() + 3e4;
  for (; Date.now() < a; ) {
    if (i.exitCode !== null)
      throw new Error("Python sidecar exited during startup; run `npm run setup`");
    try {
      if ((await fetch(`${e}/health`, { signal: AbortSignal.timeout(1e3) })).ok)
        return v = { url: e, process: i }, v;
    } catch {
    }
    await new Promise((d) => setTimeout(d, 400));
  }
  throw i.kill(), new Error("Python sidecar did not become healthy; run `npm run setup`");
}
async function P() {
  try {
    return (await ie()).url;
  } catch (n) {
    return console.error("[sidecar]", n.message), null;
  }
}
function se() {
  v && (v.process.kill(), v = null);
}
function ke(n, t, e) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; width: ${n}px; height: ${t}px; }
  body { cursor: crosshair; user-select: none; -webkit-user-select: none; }
  #shot { position: fixed; left: 0; top: 0; width: 100%; height: 100%; }
  #c { position: fixed; left: 0; top: 0; z-index: 2; }
</style>
</head>
<body>
  <img id="shot" src="${e}" />
  <canvas id="c"></canvas>
  <script>
    const W = window.innerWidth
    const H = window.innerHeight
    const canvas = document.getElementById('c')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    const img = document.getElementById('shot')
    let start = null
    let cur = null
    let dragging = false

    function draw() {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, W, H)
      if (cur) {
        const r = normRect(start, cur)
        ctx.clearRect(r.x, r.y, r.width, r.height)
        ctx.strokeStyle = '#4f8cff'
        ctx.lineWidth = 2
        ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2)
        ctx.fillStyle = '#fff'
        ctx.font = '12px system-ui, sans-serif'
        ctx.fillText(Math.round(r.width) + ' x ' + Math.round(r.height), r.x + 6, r.y + 16)
      }
    }

    function normRect(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y)
      }
    }

    canvas.addEventListener('mousedown', (e) => {
      start = { x: e.clientX, y: e.clientY }
      cur = start
      dragging = true
      draw()
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      cur = { x: e.clientX, y: e.clientY }
      draw()
    })
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return
      dragging = false
      const r = normRect(start, { x: e.clientX, y: e.clientY })
      if (r.width > 2 && r.height > 2) {
        window.coder.selectRegion({ x: r.x, y: r.y, width: r.width, height: r.height })
      } else {
        window.coder.cancelRegion()
      }
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.coder.cancelRegion()
    })
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      window.coder.cancelRegion()
    })
    img.addEventListener('load', draw)
  <\/script>
</body>
</html>`;
}
function $(n, t) {
  const e = o.realpathSync(n), r = t.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!r) return e;
  const i = c.join(e, r);
  let s = i;
  for (; !o.existsSync(s); ) {
    const l = c.dirname(s);
    if (l === s) throw new Error("path escapes project root");
    s = l;
  }
  const a = o.realpathSync(s);
  if (a !== e && !a.startsWith(e + c.sep))
    throw new Error("path escapes project root");
  return c.join(a, c.relative(s, i));
}
const oe = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "release",
  "coverage",
  ".idea",
  ".vscode"
]);
function Ae(n, t) {
  if (!n || !o.existsSync(n)) return [];
  let e;
  try {
    e = $(n, t);
  } catch {
    return [];
  }
  let r;
  try {
    r = o.readdirSync(e, { withFileTypes: !0 });
  } catch {
    return [];
  }
  const i = [];
  for (const s of r) {
    if (s.name.startsWith(".") && s.name !== ".gitignore" && s.name !== ".env" || s.isDirectory() && oe.has(s.name)) continue;
    let a = "file";
    s.isSymbolicLink() ? a = "link" : s.isDirectory() && (a = "dir");
    const l = [t, s.name].filter(Boolean).join("/");
    i.push({ name: s.name, kind: a, path: l });
  }
  return i.sort((s, a) => s.kind === "dir" && a.kind !== "dir" ? -1 : s.kind !== "dir" && a.kind === "dir" ? 1 : s.name.localeCompare(a.name)), i;
}
function De(n, t) {
  const e = $(n, t);
  if (!o.existsSync(e)) return null;
  if (o.statSync(e).isDirectory())
    throw new Error("path is a directory");
  return { content: o.readFileSync(e, "utf-8") };
}
function Ee(n, t, e) {
  const r = $(n, t);
  if (o.existsSync(r) && o.statSync(r).isDirectory())
    throw new Error("path is a directory");
  const i = c.dirname(r);
  o.existsSync(i) || o.mkdirSync(i, { recursive: !0 }), o.writeFileSync(r, e, "utf-8");
}
function _e(n, t) {
  const e = t.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!e) return !1;
  const r = $(n, e);
  return o.rmSync(r, { recursive: !0, force: !0 }), !0;
}
const Fe = /* @__PURE__ */ new Set([
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".mdx",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".vue",
  ".svelte",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".csv",
  ".tsv",
  ".gitignore"
]), K = 200, Pe = 4e3, Te = 2e6;
function Re(n) {
  const t = [], e = [n];
  for (; e.length > 0; ) {
    const r = e.pop();
    let i;
    try {
      i = o.readdirSync(r, { withFileTypes: !0 });
    } catch {
      continue;
    }
    for (const s of i) {
      const a = c.join(r, s.name);
      if (s.isDirectory()) {
        if (s.name.startsWith(".") || oe.has(s.name)) continue;
        e.push(a);
      } else if (s.isFile() && (t.push(a), t.length >= Pe))
        return t;
    }
  }
  return t;
}
function $e(n, t) {
  const e = t.toLowerCase().trim();
  if (!e) return [];
  const r = [];
  for (const i of Re(n)) {
    if (r.length >= K) break;
    const s = c.extname(i).toLowerCase();
    if (!Fe.has(s) && ![".md", ".txt"].includes(s)) continue;
    let a;
    try {
      if (o.statSync(i).size > Te) continue;
      a = o.readFileSync(i, "utf-8");
    } catch {
      continue;
    }
    const l = a.split(`
`);
    for (let f = 0; f < l.length; f++) {
      const d = l[f];
      if (d.toLowerCase().includes(e) && (r.push({
        file: c.relative(n, i).split(c.sep).join("/"),
        line: f + 1,
        text: d.slice(0, 300)
      }), r.length >= K))
        break;
    }
  }
  return r;
}
const Ce = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif"
};
function Ie(n) {
  if (typeof n != "string") return null;
  const t = Ce[c.extname(n).toLowerCase()];
  if (!t) return null;
  try {
    const e = o.readFileSync(n);
    return e.length > 8 * 1024 * 1024 ? null : `data:${t};base64,${e.toString("base64")}`;
  } catch {
    return null;
  }
}
function We() {
  const n = A();
  return o.existsSync(n) || o.mkdirSync(n, { recursive: !0 }), n;
}
function C(n) {
  const t = A(), e = n.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!e) return t;
  const r = c.resolve(t, e), i = o.existsSync(r) ? o.realpathSync(r) : r;
  if (i !== t && !i.startsWith(t + c.sep))
    throw new Error("path escapes the data root");
  return i;
}
function Ne(n) {
  let t;
  try {
    t = C(n);
  } catch {
    return [];
  }
  let e;
  try {
    e = o.readdirSync(t, { withFileTypes: !0 });
  } catch {
    return [];
  }
  const r = [];
  for (const i of e) {
    let s = "file";
    i.isSymbolicLink() ? s = "link" : i.isDirectory() && (s = "dir");
    const a = [n, i.name].filter(Boolean).join("/");
    r.push({ name: i.name, kind: s, path: a });
  }
  return r.sort((i, s) => i.kind === "dir" && s.kind !== "dir" ? -1 : i.kind !== "dir" && s.kind === "dir" ? 1 : i.name.localeCompare(s.name)), r;
}
function Oe(n) {
  const t = C(n);
  if (!o.existsSync(t)) return null;
  if (o.statSync(t).isDirectory()) throw new Error("path is a directory");
  return { content: o.readFileSync(t, "utf-8") };
}
function Le(n, t) {
  const e = C(n);
  if (o.existsSync(e) && o.statSync(e).isDirectory())
    throw new Error("path is a directory");
  const r = c.dirname(e);
  o.existsSync(r) || o.mkdirSync(r, { recursive: !0 }), o.writeFileSync(e, t, "utf-8");
}
function Me(n) {
  const t = n.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!t) return !1;
  const e = C(t);
  return o.rmSync(e, { recursive: !0, force: !0 }), !0;
}
function Z(n, t) {
  try {
    const e = c.join(We(), n);
    if (o.existsSync(e))
      return JSON.parse(o.readFileSync(e, "utf-8"));
  } catch {
  }
  return t;
}
const Q = !!process.env.VITE_DEV_SERVER_URL;
let m = null;
const M = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  process.env.PATH
].filter(Boolean).join(":");
let N = null, O = [], h = null, _ = 0;
function ae() {
  return new Promise((n) => {
    L(
      "lsof",
      ["-nP", "-c", "nvim", "-U", "-F0n"],
      { timeout: 5e3, env: { ...process.env, PATH: M } },
      (t, e) => {
        if (t || !e) return n([]);
        const r = [];
        for (const i of e.split("\0")) {
          if (!i.startsWith("n")) continue;
          let s = i.slice(1);
          if (s.startsWith("->") && (s = s.slice(2)), !!s.startsWith("/") && /nvim\.\d+\.0$/.test(s))
            try {
              o.statSync(s).isSocket() && r.push(s);
            } catch {
            }
        }
        n([...new Set(r)]);
      }
    );
  });
}
function He(n) {
  return new Promise((t) => {
    L(
      "nvim",
      ["--server", n, "--remote-expr", 'expand("%:p")'],
      { timeout: 1500, env: { ...process.env, PATH: M } },
      (e, r) => {
        if (e) return t(null);
        const i = String(r ?? "").trim();
        t(i || null);
      }
    );
  });
}
function ze(n) {
  return new Promise((t) => {
    L(
      "nvim",
      ["--server", n, "--remote-expr", `luaeval('(function() local ok,res=pcall(function() local d=vim.lsp.diagnostic.get(0) or {} local a={} for _,x in ipairs(d) do a[#a+1]={lnum=x.lnum,col=x.col,end_lnum=x.end_lnum,end_col=x.end_col,severity=x.severity,source=x.source,code=x.code,message=x.message} end local enc=vim.json and function(t) return vim.json.encode(t) end or function(t) return vim.fn.json_encode(t) end return enc(a) end) return ok and res or "[]" end)()')`],
      { timeout: 1500, env: { ...process.env, PATH: M } },
      (r, i) => {
        if (r) return t([]);
        const s = String(i ?? "").trim();
        if (!s) return t([]);
        try {
          const a = JSON.parse(s);
          t(Array.isArray(a) ? a : []);
        } catch {
          t([]);
        }
      }
    );
  });
}
async function Be() {
  const n = await ae();
  let t = null, e = [];
  for (const a of n.slice(0, 8))
    if (t = await He(a), t) {
      e = await ze(a);
      break;
    }
  const r = JSON.stringify(e), i = t !== N, s = r !== JSON.stringify(O);
  if (!(!i && !s)) {
    N = t, O = e;
    for (const a of F.getAllWindows())
      a.webContents.send("nvim:file", { abs: t, diagnostics: e });
  }
}
function Ve() {
  if (h) return;
  const n = async () => {
    var e, r;
    (await ae()).length === 0 ? (_ += 1, _ > 0 && h && (clearInterval(h), h = setInterval(n, 5e3), (e = h.unref) == null || e.call(h))) : _ > 0 && h ? (_ = 0, clearInterval(h), h = setInterval(n, 1500), (r = h.unref) == null || r.call(h)) : _ = 0, await Be();
  };
  setTimeout(() => {
    var t;
    h || (h = setInterval(n, 1500), (t = h.unref) == null || t.call(h), n());
  }, 5e3);
}
function ce() {
  m = new F({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "CODEFA",
    icon: c.join(import.meta.dirname, "../build/icon.png"),
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: !Q,
    webPreferences: {
      preload: import.meta.dirname + "/preload.cjs",
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !1
    }
  }), Q && process.env.VITE_DEV_SERVER_URL ? m.loadURL(process.env.VITE_DEV_SERVER_URL) : m.loadFile(c.join(x.getAppPath(), "dist", "index.html")), m.on("closed", () => {
    m = null;
  });
}
function Ue() {
  u.handle("sidecar:url", async () => P()), u.handle("nvim:get", () => ({ abs: N, diagnostics: O }));
  const n = /^[A-Z][A-Z0-9_]*$/;
  u.handle("env:get", (t, e) => typeof e != "string" || e.length === 0 || e.length > 128 || !n.test(e) ? null : process.env[e] ?? null), u.handle("dialog:select-folder", async () => {
    if (!m) return null;
    const t = await q.showOpenDialog(m, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select project folder"
    });
    return t.canceled || t.filePaths.length === 0 ? null : t.filePaths[0];
  }), u.handle("dialog:select-file", async () => {
    if (!m) return null;
    const t = await q.showOpenDialog(m, {
      properties: ["openFile"],
      title: "Select an image or file to attach",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });
    return t.canceled || t.filePaths.length === 0 ? null : t.filePaths[0];
  }), u.handle("fs:list", (t, e, r) => Ae(e, r)), u.handle("fs:read", (t, e, r) => De(e, r)), u.handle("fs:write", (t, e, r, i) => (Ee(e, r, i), !0)), u.handle("fs:delete", (t, e, r) => _e(e, r)), u.handle("fs:search", (t, e, r) => $e(e, r)), u.handle("fs:read-image", (t, e) => Ie(e)), u.handle("coder:list", (t, e) => Ne(e)), u.handle("coder:read", (t, e) => Oe(e)), u.handle("coder:write", (t, e, r) => (Le(e, r), !0)), u.handle("coder:delete", (t, e) => Me(e)), u.handle("screenshot:capture", async () => {
    const t = X.getPrimaryDisplay(), { width: e, height: r } = t.bounds, i = await G.getSources({
      types: ["screen"],
      thumbnailSize: { width: e, height: r }
    }), s = i.find((f) => f.display_id === String(t.id)) ?? i[0];
    if (!s || s.thumbnail.isEmpty()) return null;
    const a = s.thumbnail.toPNG(), l = c.join(g.tmpdir(), `coder-shot-${Date.now()}.png`);
    try {
      o.writeFileSync(l, a);
    } catch {
      return null;
    }
    return { path: l, dataUrl: `data:image/png;base64,${a.toString("base64")}` };
  }), u.handle("screenshot:capture-region", async () => {
    const t = X.getPrimaryDisplay(), e = t.scaleFactor || 1, { x: r, y: i, width: s, height: a } = t.bounds, l = await G.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(s * e), height: Math.round(a * e) }
    }), f = l.find((I) => I.display_id === String(t.id)) ?? l[0];
    if (!f || f.thumbnail.isEmpty()) return null;
    const d = f.thumbnail, w = c.join(g.tmpdir(), `coder-overlay-${Date.now()}.html`);
    try {
      o.writeFileSync(w, ke(s, a, d.toDataURL()));
    } catch {
      return null;
    }
    return await new Promise((I) => {
      const b = new F({
        x: r,
        y: i,
        width: s,
        height: a,
        frame: !1,
        transparent: !0,
        resizable: !1,
        movable: !1,
        fullscreenable: !1,
        hasShadow: !1,
        alwaysOnTop: !0,
        skipTaskbar: !0,
        webPreferences: {
          preload: c.join(import.meta.dirname, "preload.cjs"),
          contextIsolation: !0,
          nodeIntegration: !1,
          sandbox: !1
        }
      });
      b.setAlwaysOnTop(!0, "screen-saver"), b.setVisibleOnAllWorkspaces(!0, { visibleOnFullScreen: !0 });
      let H = !1;
      const j = (R) => {
        if (!H) {
          H = !0, u.removeListener("overlay:selected", z), u.removeListener("overlay:cancel", B), clearTimeout(ue);
          try {
            o.unlinkSync(w);
          } catch {
          }
          b.isDestroyed() || b.destroy(), I(R);
        }
      }, T = (R, p) => Math.max(0, Math.min(Math.round(R), p)), z = (R, p) => {
        const de = {
          x: T(((p == null ? void 0 : p.x) ?? 0) * e, d.getSize().width),
          y: T(((p == null ? void 0 : p.y) ?? 0) * e, d.getSize().height),
          width: T(((p == null ? void 0 : p.width) ?? 0) * e, d.getSize().width),
          height: T(((p == null ? void 0 : p.height) ?? 0) * e, d.getSize().height)
        }, V = d.crop(de);
        if (V.isEmpty()) return j(null);
        const U = V.toPNG(), J = c.join(g.tmpdir(), `coder-shot-${Date.now()}.png`);
        try {
          o.writeFileSync(J, U);
        } catch {
          return j(null);
        }
        j({ path: J, dataUrl: `data:image/png;base64,${U.toString("base64")}` });
      }, B = () => j(null);
      u.on("overlay:selected", z), u.on("overlay:cancel", B), b.on("closed", () => j(null));
      const ue = setTimeout(() => j(null), 12e4);
      b.loadFile(w).then(
        () => {
          b.show(), b.focus();
        },
        () => j(null)
      );
    });
  }), u.handle("image:normalize", (t, e) => {
    if (typeof e != "string" || !e) return null;
    let r = fe.createFromPath(e);
    if (r.isEmpty()) return null;
    const { width: i, height: s } = r.getSize(), a = 2048;
    if (i > a || s > a) {
      const d = a / Math.max(i, s);
      r = r.resize({ width: Math.round(i * d), height: Math.round(s * d) });
    }
    const l = r.toPNG(), f = c.join(g.tmpdir(), `coder-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      o.writeFileSync(f, l);
    } catch {
      return null;
    }
    return { path: f, dataUrl: `data:image/png;base64,${l.toString("base64")}` };
  }), u.handle("store:get", async (t, e) => {
    const r = await Je();
    return e === "settings" ? r.settings : e === "chats" ? r.chats : null;
  }), u.handle("store:set", (t, e, r) => e === "settings" ? (ee({ settings: r }), !0) : e === "chats" ? (ee({ chats: Array.isArray(r) ? r : [] }), !0) : !1), u.handle("data:path", () => A()), u.handle("data:move", async (t, e) => {
    await le(), se();
    const r = ge(e);
    try {
      await ie();
    } catch (i) {
      console.error("[sidecar] restart after data move failed:", i);
    }
    for (const i of F.getAllWindows())
      i.webContents.send("sidecar:changed");
    return k = null, r;
  }), u.handle(
    "data:move-vector",
    (t, e, r) => we(e, r)
  );
}
let k = null, y = {}, D = null;
async function Je() {
  if (k) return k;
  const n = await Promise.race([
    P().catch(() => null),
    new Promise((t) => setTimeout(() => t(null), 3e3))
  ]);
  if (n)
    try {
      const t = await fetch(`${n}/app/state`), e = t.ok ? await t.json() : {};
      return k = {
        settings: e.settings ?? null,
        chats: Array.isArray(e.chats) ? e.chats : []
      }, k;
    } catch {
    }
  return k = { settings: Z("settings.json", {}), chats: Z("chats.json", []) }, k;
}
function ee(n) {
  n.settings !== void 0 && (y.settings = n.settings), n.chats !== void 0 && (y.chats = n.chats), D && clearTimeout(D), D = setTimeout(() => void le(), 300);
}
async function le() {
  if (D && (clearTimeout(D), D = null), !y.settings && !Array.isArray(y.chats)) return;
  const n = y;
  y = {};
  const t = await P().catch(() => null);
  if (t)
    try {
      await fetch(`${t}/app/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(n)
      });
    } catch {
      n.settings !== void 0 && y.settings === void 0 && (y.settings = n.settings), Array.isArray(n.chats) && !Array.isArray(y.chats) && (y.chats = n.chats);
    }
}
async function qe() {
  const n = c.join(g.homedir(), ".coder", "settings.json"), t = c.join(g.homedir(), ".coder", "chats.json"), e = o.existsSync(n), r = o.existsSync(t);
  if (!e && !r) return;
  const i = await P().catch(() => null);
  if (!i) return;
  let s = {};
  try {
    const l = await fetch(`${i}/app/state`);
    s = l.ok ? await l.json() : {};
  } catch {
  }
  if (s.settings != null || Array.isArray(s.chats) && s.chats.length > 0) {
    if (e)
      try {
        o.renameSync(n, `${n}.bak`);
      } catch {
      }
    if (r)
      try {
        o.renameSync(t, `${t}.bak`);
      } catch {
      }
    return;
  }
  const a = {};
  if (e)
    try {
      a.settings = JSON.parse(o.readFileSync(n, "utf-8"));
    } catch {
    }
  if (r)
    try {
      a.chats = JSON.parse(o.readFileSync(t, "utf-8"));
    } catch {
    }
  if (!(!a.settings && !Array.isArray(a.chats)))
    try {
      if ((await fetch(`${i}/app/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(a)
      })).ok) {
        if (e)
          try {
            o.renameSync(n, `${n}.bak`);
          } catch {
          }
        if (r)
          try {
            o.renameSync(t, `${t}.bak`);
          } catch {
          }
      }
    } catch {
    }
}
x.whenReady().then(async () => {
  Ue();
  try {
    await Promise.race([
      qe(),
      new Promise((n) => setTimeout(n, 4e3))
    ]);
  } catch (n) {
    console.error("legacy migration failed:", n);
  }
  ce(), P().catch((n) => console.error("sidecar startup failed:", n)), Ve();
});
x.on("window-all-closed", () => {
  process.platform !== "darwin" && x.quit();
});
x.on("activate", () => {
  F.getAllWindows().length === 0 && m === null && ce();
});
x.on("will-quit", () => {
  se();
});
