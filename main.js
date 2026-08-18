import { app as v, ipcMain as f, safeStorage as L, session as se, BrowserWindow as E, shell as De, dialog as oe, clipboard as Fe, screen as ae, desktopCapturer as ce, nativeImage as Te } from "electron";
import { spawn as le, execSync as Pe, execFile as X } from "child_process";
import * as c from "path";
import * as x from "os";
import * as o from "fs";
import * as Re from "net";
import * as k from "fs/promises";
import * as Ie from "crypto";
const $e = ".codifa", Ce = ".coder";
let S = null;
function q() {
  return c.join(v.getPath("userData"), "data-root.json");
}
function D() {
  if (S) return S;
  try {
    if (o.existsSync(q())) {
      const n = JSON.parse(o.readFileSync(q(), "utf-8"));
      if (n && typeof n.path == "string" && n.path.trim())
        return S = c.resolve(n.path), o.mkdirSync(S, { recursive: !0 }), S;
    }
  } catch {
  }
  S = c.join(x.homedir(), $e), Le();
  try {
    o.mkdirSync(S, { recursive: !0 });
  } catch {
  }
  return S;
}
function Le() {
  if (!S || o.existsSync(S)) return;
  const n = c.join(x.homedir(), Ce);
  if (!(n === S || !o.existsSync(n)))
    try {
      me(n, S);
    } catch {
    }
}
function Ne(n) {
  const e = c.resolve(n);
  o.mkdirSync(e, { recursive: !0 }), S = e;
  try {
    o.writeFileSync(
      q(),
      JSON.stringify({ path: e }, null, 2),
      "utf-8"
    );
  } catch {
  }
  return e;
}
function me(n, e) {
  o.mkdirSync(e, { recursive: !0 });
  for (const t of o.readdirSync(n)) {
    const r = c.join(n, t), i = c.join(e, t), s = o.statSync(r);
    if (s.isDirectory())
      me(r, i);
    else if (s.isFile())
      if (!o.existsSync(i)) o.copyFileSync(r, i);
      else try {
        o.copyFileSync(r, i);
      } catch {
      }
  }
}
async function ge(n, e, t) {
  await k.mkdir(e, { recursive: !0 });
  const r = await k.readdir(n);
  let i = 0;
  for (const s of r) {
    const a = c.join(n, s), l = c.join(e, s), d = await k.stat(a);
    if (d.isDirectory())
      await ge(a, l, t);
    else if (d.isFile())
      try {
        await k.copyFile(a, l);
      } catch {
      }
    i++, t(c.basename(n), Math.round(i / r.length * 100)), await new Promise((u) => setImmediate(u));
  }
}
function We(n, e) {
  const t = D(), r = c.resolve(n.trim() || "");
  if (!r || r === t || r.startsWith(t + c.sep))
    return Promise.resolve(t);
  const i = Oe(t);
  return e("Preparing", 0), Me(t, r, i, e).then(() => e("Cleaning up old location", 90)).then(() => He(t, i)).then(() => (e("Done", 100), r));
}
function Oe(n) {
  let e = [];
  try {
    e = o.readdirSync(n);
  } catch {
    return [];
  }
  return e.filter((t) => t !== ".DS_Store");
}
async function Me(n, e, t, r) {
  await k.mkdir(e, { recursive: !0 });
  const i = t.length;
  let s = 0;
  for (const a of t) {
    const l = c.join(n, a), d = c.join(e, a);
    try {
      const u = await k.stat(l);
      u.isDirectory() ? await ge(l, d, () => {
      }) : u.isFile() && await k.copyFile(l, d);
    } catch {
    }
    s++, r(`Copying ${a}`, Math.round(s / i * 85)), await new Promise((u) => setImmediate(u));
  }
}
async function He(n, e) {
  for (const t of e) {
    const r = c.join(n, t);
    try {
      (await k.stat(r)).isDirectory() ? await k.rm(r, { recursive: !0, force: !0 }) : await k.unlink(r);
    } catch {
    }
    await new Promise((i) => setImmediate(i));
  }
}
const U = "enc:", N = "raw:";
let B = null;
function we() {
  return c.join(v.getPath("userData"), "secrets.key");
}
function J(n) {
  const e = we();
  try {
    o.mkdirSync(c.dirname(e), { recursive: !0 }), o.writeFileSync(e, n, { mode: 384 });
    try {
      o.chmodSync(e, 384);
    } catch {
    }
  } catch {
  }
}
function Se() {
  if (B) return B;
  const n = we();
  let e = "";
  if (o.existsSync(n))
    try {
      const t = o.readFileSync(n, "utf-8").trim();
      if (t.startsWith(U)) {
        const r = t.slice(U.length);
        L.isEncryptionAvailable() && (e = L.decryptString(Buffer.from(r, "base64")));
      } else t.startsWith(N) && (e = t.slice(N.length));
    } catch {
    }
  if (!e || e.length < 16) {
    e = Ie.randomBytes(32).toString("base64");
    try {
      L.isEncryptionAvailable() ? J(`${U}${L.encryptString(e).toString("base64")}`) : (console.warn("[secrets] OS keychain unavailable (e.g. headless Linux) — storing the encryption key with file permissions only (0600) instead of safeStorage."), J(`${N}${e}`));
    } catch {
      console.warn("[secrets] safeStorage encrypt failed — storing the encryption key with file permissions only (0600) instead of safeStorage."), J(`${N}${e}`);
    }
  }
  return B = e, e;
}
function ze() {
  f.handle("secrets:getKey", () => Se());
}
function Ue() {
  const n = [
    process.env.CODER_BACKEND,
    c.join(process.cwd(), "backend"),
    c.join(v.getAppPath(), "backend"),
    c.join(process.resourcesPath, "backend"),
    c.join(v.getAppPath(), "resources", "backend")
  ];
  for (const e of n)
    if (e && o.existsSync(c.join(e, "server.py")))
      return e;
  return null;
}
function Be(n) {
  const e = c.join(n, ".venv", "bin", "python");
  if (process.platform === "win32") {
    const t = c.join(n, ".venv", "Scripts", "python.exe");
    return o.existsSync(t) ? { cmd: t, args: [] } : null;
  }
  return o.existsSync(e) ? { cmd: e, args: [] } : null;
}
function Je() {
  const n = process.platform === "win32", e = n ? ";" : ":", t = /* @__PURE__ */ new Set();
  for (const r of (process.env.PATH || "").split(e)) r && t.add(r);
  if (n)
    return Array.from(t).join(e);
  for (const r of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ])
    o.existsSync(r) && t.add(r);
  try {
    const r = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"), i = process.platform === "darwin" ? `${r} -l -c 'echo -n "$PATH"'` : `${r} -c 'echo -n "$PATH"'`, s = Pe(i, { timeout: 3e3, encoding: "utf8" });
    for (const a of s.split(e)) a && t.add(a);
  } catch {
  }
  return Array.from(t).join(e);
}
function qe() {
  return new Promise((n, e) => {
    const t = Re.createServer();
    t.unref(), t.on("error", e), t.listen(0, "127.0.0.1", () => {
      const r = t.address();
      if (r && typeof r == "object") {
        const i = r.port;
        t.close(() => n(i));
      } else
        t.close(() => e(new Error("could not allocate port")));
    });
  });
}
let A = null, R = null, M = !1;
function ve() {
  return A ? Promise.resolve(A) : R || (R = Ge().finally(() => {
    R = null;
  }), R);
}
async function Ge() {
  var l, d;
  const n = Ue();
  if (!n)
    throw new Error("backend/server.py not found; run `npm run setup`");
  const e = await qe(), t = `http://127.0.0.1:${e}`, r = Be(n);
  let i;
  const s = {
    ...process.env,
    PATH: Je(),
    PYTHONIOENCODING: "utf-8",
    // User-level data root (configurable from Settings → Data path). The
    // sidecar owns the SQLite state DB and the skills/plans/mcp files there,
    // so it must agree with Electron about where that root is.
    CODER_DATA_DIR: D(),
    // AES key used to decrypt secrets (API keys / OAuth creds) that the
    // renderer stores encrypted in settings.json. In-memory only, never on disk.
    CODER_SECRET_KEY: Se()
  };
  if (r)
    i = le(r.cmd, [...r.args, c.join(n, "server.py"), "--port", String(e)], {
      cwd: n,
      stdio: ["ignore", "pipe", "pipe"],
      env: s
    });
  else {
    const u = ["run", "--project", n, "python", "server.py", "--port", String(e)];
    i = le("uv", u, {
      cwd: n,
      stdio: ["ignore", "pipe", "pipe"],
      env: s
    });
  }
  (l = i.stdout) == null || l.on("data", (u) => {
    const p = u.toString().trim();
    p && console.log("[sidecar]", p);
  }), (d = i.stderr) == null || d.on("data", (u) => {
    const p = u.toString().trim();
    p && console.error("[sidecar]", p);
  }), i.on("exit", (u, p) => {
    M ? (console.log(`[sidecar] stopped (${p || "exit"})`), M = !1) : console.error(u === null ? `[sidecar] exited unexpectedly (signal ${p})` : `[sidecar] exited with code ${u}`), A = null;
  }), i.on("error", (u) => {
    console.error("[sidecar] spawn error", u), A = null;
  });
  const a = Date.now() + 3e4;
  for (; Date.now() < a; ) {
    if (i.exitCode !== null)
      throw new Error("Python sidecar exited during startup; run `npm run setup`");
    try {
      if ((await fetch(`${t}/health`, { signal: AbortSignal.timeout(1e3) })).ok)
        return A = { url: t, process: i }, A;
    } catch {
    }
    await new Promise((u) => setTimeout(u, 400));
  }
  throw i.kill(), new Error("Python sidecar did not become healthy; run `npm run setup`");
}
async function T() {
  try {
    return (await ve()).url;
  } catch (n) {
    return console.error("[sidecar]", n.message), null;
  }
}
function Ke() {
  return A ? A.url : null;
}
async function _e(n = 5e3) {
  const e = A;
  if (!e) return;
  A = null, M = !0;
  const t = e.process;
  if (t.exitCode !== null) {
    M = !1;
    return;
  }
  await new Promise((r) => {
    const i = setTimeout(() => {
      console.error("[sidecar] stop timed out; killing"), t.kill("SIGKILL");
    }, n);
    t.once("exit", () => {
      clearTimeout(i), r();
    }), t.kill("SIGTERM");
  });
}
const Ve = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"], Xe = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
function Ye(n) {
  const e = n.trim();
  if (e.length >= 2) {
    const t = e[0], r = e[e.length - 1];
    if (t === '"' && r === '"' || t === "'" && r === "'")
      return e.slice(1, -1);
  }
  return e;
}
function Ze() {
  const n = x.homedir();
  for (const e of Ve) {
    let t;
    try {
      t = o.readFileSync(c.join(n, e), "utf8");
    } catch {
      continue;
    }
    for (const r of t.split(`
`)) {
      const i = r.trim();
      if (!i || i.startsWith("#") || i.startsWith("unset ") || i.includes("$(") || i.includes("`")) continue;
      const s = Xe.exec(i);
      if (!s) continue;
      const a = s[1];
      if (a in process.env) continue;
      let l = Ye(s[2]);
      !l || l.startsWith("$") || (process.env[a] = l);
    }
  }
}
function Qe(n, e, t) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; width: ${n}px; height: ${e}px; }
  body { cursor: crosshair; user-select: none; -webkit-user-select: none; }
  #shot { position: fixed; left: 0; top: 0; width: 100%; height: 100%; }
  #c { position: fixed; left: 0; top: 0; z-index: 2; }
</style>
</head>
<body>
  <img id="shot" src="${t}" />
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
function H(n, e) {
  const t = o.realpathSync(n), r = e.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!r) return t;
  const i = c.join(t, r);
  let s = i;
  for (; !o.existsSync(s); ) {
    const l = c.dirname(s);
    if (l === s) throw new Error("path escapes project root");
    s = l;
  }
  const a = o.realpathSync(s);
  if (a !== t && !a.startsWith(t + c.sep))
    throw new Error("path escapes project root");
  return c.join(a, c.relative(s, i));
}
const be = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "release",
  "coverage",
  ".idea",
  ".vscode",
  "vendor"
]), et = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "dist-electron",
  "release",
  "build",
  "coverage",
  ".cache",
  ".idea",
  ".vscode",
  ".DS_Store",
  "target",
  "vendor",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "out",
  "bin",
  "obj"
]), ue = 5e4;
function tt(n) {
  if (!n || !o.existsSync(n)) return [];
  const e = [], t = [n];
  for (; t.length > 0 && e.length < ue; ) {
    const r = t.pop();
    let i;
    try {
      i = o.readdirSync(r, { withFileTypes: !0 });
    } catch {
      continue;
    }
    for (const s of i) {
      if (e.length >= ue) break;
      const a = c.join(r, s.name);
      if (s.isDirectory()) {
        if (et.has(s.name)) continue;
        t.push(a);
      } else s.isFile() && e.push({
        rel: c.relative(n, a).split(c.sep).join("/"),
        name: s.name
      });
    }
  }
  return e.sort((r, i) => r.rel.localeCompare(i.rel)), e;
}
function nt(n, e) {
  if (!n || !o.existsSync(n)) return [];
  let t;
  try {
    t = H(n, e);
  } catch {
    return [];
  }
  let r;
  try {
    r = o.readdirSync(t, { withFileTypes: !0 });
  } catch {
    return [];
  }
  const i = [];
  for (const s of r) {
    if (s.name.startsWith(".") && s.name !== ".gitignore" && s.name !== ".env" || s.isDirectory() && be.has(s.name)) continue;
    let a = "file";
    s.isSymbolicLink() ? a = "link" : s.isDirectory() && (a = "dir");
    const l = [e, s.name].filter(Boolean).join("/");
    i.push({ name: s.name, kind: a, path: l });
  }
  return i.sort((s, a) => s.kind === "dir" && a.kind !== "dir" ? -1 : s.kind !== "dir" && a.kind === "dir" ? 1 : s.name.localeCompare(a.name)), i;
}
function rt(n, e) {
  const t = H(n, e);
  if (!o.existsSync(t)) return null;
  if (o.statSync(t).isDirectory())
    throw new Error("path is a directory");
  return { content: o.readFileSync(t, "utf-8") };
}
function it(n, e, t) {
  const r = H(n, e);
  if (o.existsSync(r) && o.statSync(r).isDirectory())
    throw new Error("path is a directory");
  const i = c.dirname(r);
  o.existsSync(i) || o.mkdirSync(i, { recursive: !0 }), o.writeFileSync(r, t, "utf-8");
}
function st(n, e) {
  const t = e.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!t) return !1;
  const r = H(n, t);
  return o.rmSync(r, { recursive: !0, force: !0 }), !0;
}
const ot = /* @__PURE__ */ new Set([
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
]), de = 200, at = 4e3, ct = 2e6;
function lt(n) {
  const e = [], t = [n];
  for (; t.length > 0; ) {
    const r = t.pop();
    let i;
    try {
      i = o.readdirSync(r, { withFileTypes: !0 });
    } catch {
      continue;
    }
    for (const s of i) {
      const a = c.join(r, s.name);
      if (s.isDirectory()) {
        if (s.name.startsWith(".") || be.has(s.name)) continue;
        t.push(a);
      } else if (s.isFile() && (e.push(a), e.length >= at))
        return e;
    }
  }
  return e;
}
function ut(n, e) {
  const t = e.toLowerCase().trim();
  if (!t) return [];
  const r = [];
  for (const i of lt(n)) {
    if (r.length >= de) break;
    const s = c.extname(i).toLowerCase();
    if (!ot.has(s) && ![".md", ".txt"].includes(s)) continue;
    let a;
    try {
      if (o.statSync(i).size > ct) continue;
      a = o.readFileSync(i, "utf-8");
    } catch {
      continue;
    }
    const l = a.split(`
`);
    for (let d = 0; d < l.length; d++) {
      const u = l[d];
      if (u.toLowerCase().includes(t) && (r.push({
        file: c.relative(n, i).split(c.sep).join("/"),
        line: d + 1,
        text: u.slice(0, 300)
      }), r.length >= de))
        break;
    }
  }
  return r;
}
const dt = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif"
};
function ft(n) {
  if (typeof n != "string") return null;
  const e = dt[c.extname(n).toLowerCase()];
  if (!e) return null;
  try {
    const t = o.readFileSync(n);
    return t.length > 8 * 1024 * 1024 ? null : `data:${e};base64,${t.toString("base64")}`;
  } catch {
    return null;
  }
}
function ht() {
  const n = D();
  return o.existsSync(n) || o.mkdirSync(n, { recursive: !0 }), n;
}
function z(n) {
  const e = D(), t = n.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!t) return e;
  const r = c.resolve(e, t), i = o.existsSync(r) ? o.realpathSync(r) : r;
  if (i !== e && !i.startsWith(e + c.sep))
    throw new Error("path escapes the data root");
  return i;
}
function pt(n) {
  let e;
  try {
    e = z(n);
  } catch {
    return [];
  }
  let t;
  try {
    t = o.readdirSync(e, { withFileTypes: !0 });
  } catch {
    return [];
  }
  const r = [];
  for (const i of t) {
    let s = "file";
    i.isSymbolicLink() ? s = "link" : i.isDirectory() && (s = "dir");
    const a = [n, i.name].filter(Boolean).join("/");
    r.push({ name: i.name, kind: s, path: a });
  }
  return r.sort((i, s) => i.kind === "dir" && s.kind !== "dir" ? -1 : i.kind !== "dir" && s.kind === "dir" ? 1 : i.name.localeCompare(s.name)), r;
}
function yt(n) {
  const e = z(n);
  if (!o.existsSync(e)) return null;
  if (o.statSync(e).isDirectory()) throw new Error("path is a directory");
  return { content: o.readFileSync(e, "utf-8") };
}
function mt(n, e) {
  const t = z(n);
  if (o.existsSync(t) && o.statSync(t).isDirectory())
    throw new Error("path is a directory");
  const r = c.dirname(t);
  o.existsSync(r) || o.mkdirSync(r, { recursive: !0 }), o.writeFileSync(t, e, "utf-8");
}
function gt(n) {
  const e = n.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!e) return !1;
  const t = z(e);
  return o.rmSync(t, { recursive: !0, force: !0 }), !0;
}
function fe(n, e) {
  try {
    const t = c.join(ht(), n);
    if (o.existsSync(t))
      return JSON.parse(o.readFileSync(t, "utf-8"));
  } catch {
  }
  return e;
}
const he = !!process.env.VITE_DEV_SERVER_URL;
let b = null;
Ze();
const Y = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  process.env.PATH
].filter(Boolean).join(":");
let G = null, K = [], y = null, I = 0;
function wt() {
  const n = [], e = x.tmpdir();
  if (e)
    try {
      for (const r of o.readdirSync(e))
        r.startsWith("nvim") && n.push(c.join(e, r));
    } catch {
    }
  const t = process.env.XDG_RUNTIME_DIR;
  return t && n.push(c.join(t, "nvim")), n.push(c.join(x.homedir(), "Library", "Caches", "nvim")), n;
}
function St(n) {
  const e = c.basename(n), t = e.match(/^nvim\.(\d+)\.0$/);
  if (t) return Number(t[1]);
  const r = c.basename(c.dirname(n));
  return e === "0" && /^\d+$/.test(r) ? Number(r) : null;
}
function vt(n) {
  if (!Number.isInteger(n) || n <= 0) return !1;
  try {
    return process.kill(n, 0), !0;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function xe(n, e, t) {
  let r;
  try {
    r = await o.promises.readdir(n, { withFileTypes: !0 });
  } catch {
    return;
  }
  for (const i of r) {
    const s = c.join(n, i.name);
    if (i.isDirectory()) {
      e < 5 && await xe(s, e + 1, t);
      continue;
    }
    const a = St(s);
    if (a === null) continue;
    let l = !1;
    try {
      l = o.statSync(s).isSocket();
    } catch {
      continue;
    }
    l && vt(a) && t.push(s);
  }
}
async function ke() {
  const n = [];
  for (const t of wt())
    t && await xe(t, 0, n);
  const e = [...new Set(n)];
  return e.length > 0 ? e : new Promise((t) => {
    X(
      "lsof",
      ["-nP", "-c", "nvim", "-U", "-F0n"],
      { timeout: 5e3, env: { ...process.env, PATH: Y } },
      (r, i) => {
        if (r || !i) return t([]);
        const s = [];
        for (const a of i.split("\0")) {
          if (!a.startsWith("n")) continue;
          let l = a.slice(1);
          if (l.startsWith("->") && (l = l.slice(2)), !!l.startsWith("/") && /nvim\.\d+\.0$/.test(l))
            try {
              o.statSync(l).isSocket() && s.push(l);
            } catch {
            }
        }
        t([...new Set(s)]);
      }
    );
  });
}
function _t(n) {
  return new Promise((e) => {
    X(
      "nvim",
      ["--server", n, "--remote-expr", 'expand("%:p")'],
      { timeout: 1500, env: { ...process.env, PATH: Y } },
      (t, r) => {
        if (t) return e(null);
        const i = String(r ?? "").trim();
        e(i || null);
      }
    );
  });
}
function bt(n) {
  return new Promise((e) => {
    X(
      "nvim",
      ["--server", n, "--remote-expr", `luaeval('(function() local ok,res=pcall(function() local d=vim.lsp.diagnostic.get(0) or {} local a={} for _,x in ipairs(d) do a[#a+1]={lnum=x.lnum,col=x.col,end_lnum=x.end_lnum,end_col=x.end_col,severity=x.severity,source=x.source,code=x.code,message=x.message} end local enc=vim.json and function(t) return vim.json.encode(t) end or function(t) return vim.fn.json_encode(t) end return enc(a) end) return ok and res or "[]" end)()')`],
      { timeout: 1500, env: { ...process.env, PATH: Y } },
      (r, i) => {
        if (r) return e([]);
        const s = String(i ?? "").trim();
        if (!s) return e([]);
        try {
          const a = JSON.parse(s);
          e(Array.isArray(a) ? a : []);
        } catch {
          e([]);
        }
      }
    );
  });
}
async function xt() {
  const n = await ke();
  let e = null, t = [];
  for (const a of n.slice(0, 8))
    if (e = await _t(a), e) {
      t = await bt(a);
      break;
    }
  const r = JSON.stringify(t), i = e !== G, s = r !== JSON.stringify(K);
  if (!(!i && !s)) {
    G = e, K = t;
    for (const a of E.getAllWindows())
      a.webContents.send("nvim:file", { abs: e, diagnostics: t });
  }
}
function kt() {
  if (y) return;
  const n = async () => {
    var t, r;
    (await ke()).length === 0 ? (I += 1, I > 0 && y && (clearInterval(y), y = setInterval(n, 5e3), (t = y.unref) == null || t.call(y))) : I > 0 && y ? (I = 0, clearInterval(y), y = setInterval(n, 1500), (r = y.unref) == null || r.call(y)) : I = 0, await xt();
  };
  setTimeout(() => {
    var e;
    y || (y = setInterval(n, 1500), (e = y.unref) == null || e.call(y), n());
  }, 5e3);
}
function Ae() {
  b = new E({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "Codifa",
    icon: c.join(import.meta.dirname, "../build/icon.png"),
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: !he,
    webPreferences: {
      preload: import.meta.dirname + "/preload.cjs",
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !1
    }
  }), he && process.env.VITE_DEV_SERVER_URL ? b.loadURL(process.env.VITE_DEV_SERVER_URL) : b.loadFile(c.join(v.getAppPath(), "dist", "index.html")), b.on("closed", () => {
    b = null;
  });
}
function At() {
  ze(), f.handle("sidecar:url", async () => T()), f.handle("nvim:get", () => ({ abs: G, diagnostics: K }));
  const n = /^[A-Z][A-Z0-9_]*$/;
  f.handle("env:get", (e, t) => typeof t != "string" || t.length === 0 || t.length > 128 || !n.test(t) ? null : process.env[t] ?? null), f.handle("oauth:google", async (e, t, r, i) => {
    const s = typeof t == "string" ? t.trim() : "", a = typeof r == "string" ? r.trim() : "";
    if (!s) throw new Error("missing Google OAuth client id");
    const l = await T();
    if (!l) throw new Error("Python agent not ready — run `npm run setup`");
    const d = await fetch(`${l}/oauth/google/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: s,
        client_secret: a,
        scope: typeof i == "string" && i.trim() ? i.trim() : ""
      }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!d.ok) {
      const w = await d.json().catch(() => ({}));
      throw new Error(w.detail || `oauth start failed (${d.status})`);
    }
    const { url: u, state: p } = await d.json();
    if (!u || !p) throw new Error("oauth start returned no url");
    await De.openExternal(u);
    const F = Date.now() + 5 * 6e4;
    for (; Date.now() < F; ) {
      await new Promise((j) => setTimeout(j, 750));
      const w = await fetch(`${l}/oauth/google/result?state=${encodeURIComponent(p)}`, {
        signal: AbortSignal.timeout(1e4)
      }).catch(() => null);
      if (!w) continue;
      const _ = await w.json().catch(() => null);
      if (!(!_ || _.status === "pending")) {
        if (_.status === "error")
          throw new Error(_.message || "Google sign-in failed");
        return {
          refreshToken: _.refresh_token ?? "",
          accessToken: _.access_token ?? "",
          expiresIn: _.expires_in ?? 3600
        };
      }
    }
    throw new Error("Google sign-in timed out");
  }), f.handle("dialog:select-folder", async () => {
    if (!b) return null;
    const e = await oe.showOpenDialog(b, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select project folder"
    });
    return e.canceled || e.filePaths.length === 0 ? null : e.filePaths[0];
  }), f.handle("dialog:select-file", async () => {
    if (!b) return null;
    const e = await oe.showOpenDialog(b, {
      properties: ["openFile"],
      title: "Select an image or file to attach",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });
    return e.canceled || e.filePaths.length === 0 ? null : e.filePaths[0];
  }), f.handle("fs:list", (e, t, r) => nt(t, r)), f.handle("fs:walk", (e, t) => tt(t)), f.handle("fs:read", (e, t, r) => rt(t, r)), f.handle("fs:write", (e, t, r, i) => (it(t, r, i), !0)), f.handle("fs:delete", (e, t, r) => st(t, r)), f.handle("fs:search", (e, t, r) => ut(t, r)), f.handle("fs:read-image", (e, t) => ft(t)), f.handle("clipboard:write", (e, t) => (Fe.writeText(typeof t == "string" ? t : ""), !0)), f.handle("coder:list", (e, t) => pt(t)), f.handle("coder:read", (e, t) => yt(t)), f.handle("coder:write", (e, t, r) => (mt(t, r), !0)), f.handle("coder:delete", (e, t) => gt(t)), f.handle("screenshot:capture", async () => {
    const e = ae.getPrimaryDisplay(), { width: t, height: r } = e.bounds, i = await ce.getSources({
      types: ["screen"],
      thumbnailSize: { width: t, height: r }
    }), s = i.find((d) => d.display_id === String(e.id)) ?? i[0];
    if (!s || s.thumbnail.isEmpty()) return null;
    const a = s.thumbnail.toPNG(), l = c.join(x.tmpdir(), `coder-shot-${Date.now()}.png`);
    try {
      o.writeFileSync(l, a);
    } catch {
      return null;
    }
    return { path: l, dataUrl: `data:image/png;base64,${a.toString("base64")}` };
  }), f.handle("screenshot:capture-region", async () => {
    const e = ae.getPrimaryDisplay(), t = e.scaleFactor || 1, { x: r, y: i, width: s, height: a } = e.bounds, l = await ce.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(s * t), height: Math.round(a * t) }
    }), d = l.find((F) => F.display_id === String(e.id)) ?? l[0];
    if (!d || d.thumbnail.isEmpty()) return null;
    const u = d.thumbnail, p = c.join(x.tmpdir(), `coder-overlay-${Date.now()}.html`);
    try {
      o.writeFileSync(p, Qe(s, a, u.toDataURL()));
    } catch {
      return null;
    }
    return await new Promise((F) => {
      const w = new E({
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
      w.setAlwaysOnTop(!0, "screen-saver"), w.setVisibleOnAllWorkspaces(!0, { visibleOnFullScreen: !0 });
      let _ = !1;
      const j = (C) => {
        if (!_) {
          _ = !0, f.removeListener("overlay:selected", ee), f.removeListener("overlay:cancel", te), clearTimeout(je);
          try {
            o.unlinkSync(p);
          } catch {
          }
          w.isDestroyed() || w.destroy(), F(C);
        }
      }, $ = (C, g) => Math.max(0, Math.min(Math.round(C), g)), ee = (C, g) => {
        const Ee = {
          x: $(((g == null ? void 0 : g.x) ?? 0) * t, u.getSize().width),
          y: $(((g == null ? void 0 : g.y) ?? 0) * t, u.getSize().height),
          width: $(((g == null ? void 0 : g.width) ?? 0) * t, u.getSize().width),
          height: $(((g == null ? void 0 : g.height) ?? 0) * t, u.getSize().height)
        }, ne = u.crop(Ee);
        if (ne.isEmpty()) return j(null);
        const re = ne.toPNG(), ie = c.join(x.tmpdir(), `coder-shot-${Date.now()}.png`);
        try {
          o.writeFileSync(ie, re);
        } catch {
          return j(null);
        }
        j({ path: ie, dataUrl: `data:image/png;base64,${re.toString("base64")}` });
      }, te = () => j(null);
      f.on("overlay:selected", ee), f.on("overlay:cancel", te), w.on("closed", () => j(null));
      const je = setTimeout(() => j(null), 12e4);
      w.loadFile(p).then(
        () => {
          w.show(), w.focus();
        },
        () => j(null)
      );
    });
  }), f.handle("image:normalize", (e, t) => {
    if (typeof t != "string" || !t) return null;
    let r = Te.createFromPath(t);
    if (r.isEmpty()) return null;
    const { width: i, height: s } = r.getSize(), a = 2048;
    if (i > a || s > a) {
      const u = a / Math.max(i, s);
      r = r.resize({ width: Math.round(i * u), height: Math.round(s * u) });
    }
    const l = r.toPNG(), d = c.join(x.tmpdir(), `coder-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      o.writeFileSync(d, l);
    } catch {
      return null;
    }
    return { path: d, dataUrl: `data:image/png;base64,${l.toString("base64")}` };
  }), f.handle("store:get", async (e, t) => {
    const r = await jt();
    return t === "settings" ? r.settings : t === "chats" ? r.chats : null;
  }), f.handle("store:set", (e, t, r) => t === "settings" ? (O({ settings: r }), !0) : t === "chats" ? (O({ chats: Array.isArray(r) ? r : [] }), !0) : t === "deleted_chats" ? (O({ deleted_chats: Array.isArray(r) ? r : [] }), !0) : t === "deleted_workspaces" ? (O({ deleted_workspaces: Array.isArray(r) ? r : [] }), !0) : !1), f.handle("data:path", () => D()), f.handle("data:has-settings", () => {
    try {
      return o.existsSync(c.join(D(), "settings.json"));
    } catch {
      return !1;
    }
  }), f.handle("data:move", async (e, t) => {
    await Q(), await _e();
    const r = E.getAllWindows()[0], i = await We(t, (s, a) => {
      r && !r.isDestroyed() && r.webContents.send("migrate:progress", { label: s, pct: a });
    });
    Ne(i);
    try {
      await ve();
    } catch (s) {
      throw new Error(`sidecar restart after data move failed: ${s.message}`);
    }
    for (const s of E.getAllWindows())
      s.webContents.send("sidecar:changed");
    return m = null, i;
  });
}
let m = null, h = {}, P = null, W = null;
async function jt() {
  if (m) return m;
  const n = await Promise.race([
    T().catch(() => null),
    new Promise((e) => setTimeout(() => e(null), 3e3))
  ]);
  if (n)
    try {
      const e = await fetch(`${n}/app/state`), t = e.ok ? await e.json() : {}, r = V(), i = t.settings ?? (r == null ? void 0 : r.settings) ?? null, s = Array.isArray(t.chats) && t.chats.length > 0 ? t.chats : (r == null ? void 0 : r.chats) ?? [];
      return m = { settings: i, chats: s }, Z(m), m;
    } catch {
    }
  return m = V() ?? {
    settings: fe("settings.json", {}),
    chats: fe("chats.json", [])
  }, Et(), m;
}
function Z(n) {
  try {
    const e = c.join(D(), "app-state-cache.json");
    o.promises.writeFile(e, JSON.stringify(n), "utf-8");
  } catch {
  }
}
function V() {
  try {
    const n = c.join(D(), "app-state-cache.json");
    if (!o.existsSync(n)) return null;
    const e = JSON.parse(o.readFileSync(n, "utf-8"));
    return {
      settings: e.settings ?? null,
      chats: Array.isArray(e.chats) ? e.chats : []
    };
  } catch {
    return null;
  }
}
async function Et() {
  const n = await T().catch(() => null);
  if (n)
    try {
      const e = await fetch(`${n}/app/state`), t = e.ok ? await e.json() : {}, r = V();
      m = {
        settings: t.settings ?? (r == null ? void 0 : r.settings) ?? null,
        chats: Array.isArray(t.chats) && t.chats.length > 0 ? t.chats : (r == null ? void 0 : r.chats) ?? []
      }, Z(m);
      for (const i of E.getAllWindows())
        i.webContents.send("sidecar:changed");
    } catch {
    }
}
function O(n) {
  n.settings !== void 0 && (h.settings = n.settings), n.chats !== void 0 && (h.chats = n.chats), n.deleted_chats !== void 0 && (h.deleted_chats = [
    ...h.deleted_chats ?? [],
    ...n.deleted_chats
  ]), n.deleted_workspaces !== void 0 && (h.deleted_workspaces = [
    ...h.deleted_workspaces ?? [],
    ...n.deleted_workspaces
  ]), P && clearTimeout(P), P = setTimeout(() => void Q(), 300);
}
async function Q() {
  var t, r, i, s;
  if (W && (await W, !h.settings && !Array.isArray(h.chats) && !((t = h.deleted_chats) != null && t.length) && !((r = h.deleted_workspaces) != null && r.length)) || (P && (clearTimeout(P), P = null), !h.settings && !Array.isArray(h.chats) && !((i = h.deleted_chats) != null && i.length) && !((s = h.deleted_workspaces) != null && s.length))) return;
  const n = h;
  h = {};
  const e = (async () => {
    var l;
    const a = Ke() ?? await T().catch(() => null);
    if (!a) {
      pe(n);
      return;
    }
    try {
      const d = new AbortController(), u = setTimeout(() => d.abort(), 1500);
      try {
        await fetch(`${a}/app/state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(n),
          signal: d.signal
        });
      } finally {
        clearTimeout(u);
      }
      m && (n.settings !== void 0 && (m.settings = n.settings), Array.isArray(n.chats) && (m.chats = n.chats), (l = n.deleted_chats) != null && l.length && (m.chats = (m.chats ?? []).filter((p) => !n.deleted_chats.includes(p.id))), Z(m));
    } catch {
      pe(n);
    }
  })();
  W = e;
  try {
    await e;
  } finally {
    W = null;
  }
}
function pe(n) {
  var e, t, r, i;
  n.settings !== void 0 && h.settings === void 0 && (h.settings = n.settings), Array.isArray(n.chats) && !Array.isArray(h.chats) && (h.chats = n.chats), (e = n.deleted_chats) != null && e.length && !((t = h.deleted_chats) != null && t.length) && (h.deleted_chats = [...h.deleted_chats ?? [], ...n.deleted_chats]), (r = n.deleted_workspaces) != null && r.length && !((i = h.deleted_workspaces) != null && i.length) && (h.deleted_workspaces = [...h.deleted_workspaces ?? [], ...n.deleted_workspaces]);
}
async function Dt() {
  const n = [c.join(x.homedir(), ".coder")];
  for (const e of n)
    await Ft(e);
}
async function Ft(n) {
  const e = c.join(n, "settings.json"), t = c.join(n, "chats.json"), r = o.existsSync(e), i = o.existsSync(t);
  if (!r && !i) return;
  const s = await T().catch(() => null);
  if (!s) return;
  let a = {};
  try {
    const d = await fetch(`${s}/app/state`);
    a = d.ok ? await d.json() : {};
  } catch {
  }
  if (a.settings != null || Array.isArray(a.chats) && a.chats.length > 0) {
    if (r)
      try {
        o.renameSync(e, `${e}.bak`);
      } catch {
      }
    if (i)
      try {
        o.renameSync(t, `${t}.bak`);
      } catch {
      }
    return;
  }
  const l = {};
  if (r)
    try {
      l.settings = JSON.parse(o.readFileSync(e, "utf-8"));
    } catch {
    }
  if (i)
    try {
      l.chats = JSON.parse(o.readFileSync(t, "utf-8"));
    } catch {
    }
  if (!(!l.settings && !Array.isArray(l.chats)))
    try {
      if ((await fetch(`${s}/app/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(l)
      })).ok) {
        if (r)
          try {
            o.renameSync(e, `${e}.bak`);
          } catch {
          }
        if (i)
          try {
            o.renameSync(t, `${t}.bak`);
          } catch {
          }
      }
    } catch {
    }
}
v.whenReady().then(async () => {
  At(), se.defaultSession.setPermissionRequestHandler((n, e, t) => {
    t(e === "media" || e === "clipboard-sanitized-write");
  }), se.defaultSession.setPermissionCheckHandler(
    (n, e) => e === "media" || e === "clipboard-sanitized-write"
  );
  try {
    await Promise.race([
      Dt(),
      new Promise((n) => setTimeout(n, 4e3))
    ]);
  } catch (n) {
    console.error("legacy migration failed:", n);
  }
  Ae(), T().catch((n) => console.error("sidecar startup failed:", n)), kt();
});
v.on("window-all-closed", () => {
  process.platform !== "darwin" && v.quit();
});
v.on("activate", () => {
  E.getAllWindows().length === 0 && b === null && Ae();
});
let ye = !1;
v.on("before-quit", (n) => {
  if (ye) return;
  n.preventDefault(), ye = !0;
  const e = E.getAllWindows()[0];
  e && !e.isDestroyed() && e.webContents.send("flush-persist");
  const t = () => {
    _e(), v.quit();
  }, r = setTimeout(t, 8e3);
  let i = !1;
  const s = async () => {
    var l, d;
    if (!i) {
      i = !0;
      for (let u = 0; u < 4 && (await Q().catch(() => {
      }), !!(h.settings !== void 0 || Array.isArray(h.chats) || (((l = h.deleted_chats) == null ? void 0 : l.length) ?? 0) > 0 || (((d = h.deleted_workspaces) == null ? void 0 : d.length) ?? 0) > 0)); u++)
        await new Promise((F) => setTimeout(F, 300));
      clearTimeout(r), t();
    }
  }, a = setTimeout(s, 1500);
  f.once("flush-persist-done", () => {
    clearTimeout(a), setTimeout(s, 100);
  });
});
