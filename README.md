<div align="center">

# 💻 Codifa

**The offline-first AI coding assistant for your own machine.**

Codifa is a desktop workspace for working on your projects with an AI agent —
file explorer, code editor, terminal and a streaming chat in one window. The
agent reads, searches and edits your code _itself_, confined to the folder you
choose. Bring your own model: OpenRouter, any OpenAI-compatible API, or a fully
local endpoint. Type, or just talk. Nothing leaves your machine unless you want
it to.

کدیفا یک دستیار کدنویسی دسکتاپی است؛ یک فضای کاری کامل با کاوشگر فایل،
ویرایشگر کد، ترمینال و چتِ هوش مصنوعیِ زنده. در قلب آن یک **عامل واقعی** نشسته
که فایل‌های شما را خودش می‌خواند، جستجو و ویرایش می‌کند — و همه‌چیز فقط در همان
پوشه‌ای که انتخاب کرده‌اید. مدل‌تان را خودتان بیاورید: OpenRouter، هر API سازگار
با OpenAI یا یک مدل کاملاً محلی. تایپ کنید یا حرف بزنید. مگر اینکه خودتان
بخواهید، هیچ‌چیز از دستگاه شما بیرون نمی‌رود.

[English](#english-english) · [فارسی](#persian-فارسی)

![License](https://img.shields.io/badge/license-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)
![GitHub stars](https://img.shields.io/github/stars/rhsaman/codifa?style=social)
![GitHub downloads](https://img.shields.io/github/downloads/rhsaman/codifa/total)

[⬇️ **Download**](https://github.com/rhsaman/codifa/releases/latest) · [⭐ **Star**](https://github.com/rhsaman/codifa) · [🐛 **Report a bug**](https://github.com/rhsaman/codifa/issues/new/choose)

</div>

<p align="center">
  <img src="images/app-image.jpg" alt="Codifa app screenshot" width="700">
</p>

---

## English / English

<details open>
<summary><b>📖 English — click for the full documentation</b></summary>

### ✨ Features

|     | Feature                             | Description                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌  | **Bring your own model**            | Connect OpenRouter, any OpenAI-compatible API, or a local server (Ollama / llama.cpp / vLLM). Models load live and switch right from the header.                                                                                                                                                |
| 🤖  | **A real agent, not autocomplete**  | Three modes — **Ask** (questions and explanations), **Plan** (explores the code and writes an implementation plan) and **Coder** (writes and edits files by itself). Cycle with `Tab`.                                                                                                          |
| 🛠️  | **Works inside your project**       | The agent searches, opens, creates and edits files on its own — always confined to the folder you opened, never touching anything outside your project.                                                                                                                                         |
| 🔍  | **Find in chat**                    | Press `Cmd/Ctrl+F` to search any conversation — every match is highlighted; step between results with `Enter`/`Shift+Enter`.                                                                                                                                                                    |
| 🪟  | **Many chats at once**              | Run parallel conversations, split the chat area into several windows and arrange them however you like.                                                                                                                                                                                          |
| 🖥️  | **Built-in terminal**               | Real terminal sessions — a bottom panel, plus terminal tabs in the side pane, right next to your chat.                                                                                                                                                                                           |
| 🌿  | **Git diff panel**                  | See exactly what changed — per file, with add/remove stats, in the side pane.                                                                                                                                                                                                                    |
| 📦  | **Artifacts**                       | The agent can build previewable HTML/Markdown documents — dashboards, reports, small tools — that run right inside the app (`/artifact create …`).                                                                                                                                               |
| 🗓️  | **Scheduled tasks**                 | Set a task to run on a schedule (e.g. `/schedule create every day at 9am …`) and collect the results in an inbox.                                                                                                                                                                                |
| 🎯  | **Persistent goals**                | Give the agent a standing goal (e.g. `/goal all tests pass`) and it keeps working toward it across turns.                                                                                                                                                                                        |
| 🎤  | **Voice**                           | Hold the mic and speak in Persian or English to get text — or open a live voice conversation and just talk back and forth. Both use the speech services you configure in **Settings → Media Providers**.                                                                                          |
| 🧠  | **Memory**                          | Ask the agent to remember things — notes and saved pages are kept per project and searchable later, fully on your machine.                                                                                                                                                                       |
| 🧩  | **Skills, connectors, plugins**     | Ask the agent to install skills, MCP connectors or plugins (from a repo or a docs page) and they live inside the app itself — nothing is written into other tools' config folders.                                                                                                               |
| 🛟  | **Smooth with small models**        | Works comfortably even with small 8K local models — history is summarized automatically before the context runs out, so the work keeps going instead of stopping.                                                                                                                                |
| 🎨  | **15 themes + full RTL**            | 15 dark and light themes, and Persian/English mix correctly everywhere — parentheses, arrows and markdown never break in RTL.                                                                                                                                                                    |
| ⌨️  | **Slash commands**                  | `/help`, `/compact`, `/clear`, `/new`, `/plan`, `/undo`, `/redo`, `/skill`, `/mcp`, `/plugin`, `/artifact`, `/schedule`, `/goal`.                                                                                                                                                                |

### 📥 Installing (end users)

If you just want to run Codifa — not build it — grab the installer for your OS
from the [latest release](https://github.com/rhsaman/codifa/releases/latest).
The app is **not signed with an Apple Developer ID** and the Windows installers
are **not code-signed**, so each OS shows an extra warning on the first launch;
the steps below clear it.

#### 🍎 macOS (Apple Silicon & Intel)

**Requirements:** macOS 13.4 or newer. Both `aarch64` (Apple Silicon: M1–M4)
and `x64` (Intel) builds are published; pick the one your Mac runs.

**Option A — one-command install (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash
```

It detects your CPU, downloads the matching disk image, verifies the app's code
signature, clears the quarantine attribute and copies the app into
`/Applications`. Every step is printed so you can read what happened. To install
a specific release, pass the tag:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash -s -- v2.0.1
```

**Option B — manual install:**

1. Download the `.dmg` for your CPU from the [latest release](https://github.com/rhsaman/codifa/releases/latest) and drag **Codifa** into `/Applications`.

   | CPU | File |
   | --- | --- |
   | Apple Silicon (M-series) | `Codifa_<version>_aarch64.dmg` |
   | Intel | `Codifa_<version>_x64.dmg` |

2. Clear the quarantine flag, or macOS will refuse to open it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Codifa.app
   ```

3. Open Codifa from `/Applications`. If macOS still blocks it, go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Permissions:** Codifa asks for the microphone (voice input) and screen
recording (Computer Use). Grant them in **System Settings → Privacy & Security**;
because the app is not notarized, you may need to toggle them off and on once
and relaunch the app after an update.

#### 🪟 Windows 10 / 11 (x64)

**Requirements:** 64-bit Windows 10 or newer. The installer brings the
**WebView2 runtime** with it: Tauri's default install mode downloads the
bootstrapper when the runtime is missing, so there is nothing extra to fetch.
On an offline machine, preinstall it from
[Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
first.

**Option A — installer (recommended):**

1. Download `Codifa_<version>_x64-setup.exe` from the [latest release](https://github.com/rhsaman/codifa/releases/latest) and run it.
2. Windows SmartScreen shows _"Windows protected your PC"_ because the
   installer is not code-signed. Click **More info → Run anyway**.
3. Codifa is installed per-user and appears in the Start menu.

**Option B — MSI (for managed installs):** `Codifa_<version>_x64_en-US.msi`
installs the same app for machines where `.exe` bootstrappers are blocked;
`msiexec /i Codifa_<version>_x64_en-US.msi` runs it silently from a script.

To uninstall, use **Settings → Apps → Installed apps → Codifa → Uninstall**.

#### 🐧 Linux (x86_64)

The Linux bundles need a GTK 3 / WebKitGTK 4.1 stack. `apt` pulls these in on
its own when you install the `.deb`; install them by hand only if you use the
`.AppImage`, or on a minimal system:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1
```

On Fedora use `webkit2gtk4.1`, `gtk3` and `libappindicator-gtk3`; on Arch
`webkit2gtk-4.1`, `gtk3` and `libayatana-appindicator`. Then pick one package:

| Package | Use it when | Install |
| --- | --- | --- |
| `.deb` | Debian / Ubuntu | `sudo apt install ./Codifa_<version>_amd64.deb` |
| `.rpm` | Fedora / openSUSE | `sudo dnf install ./Codifa-<version>-1.x86_64.rpm` |
| `.AppImage` | any distro, no root | `chmod +x Codifa_<version>_amd64.AppImage && ./Codifa_<version>_amd64.AppImage` |

`apt install ./<file>.deb` (with the leading `./`) resolves the dependencies for
you; plain `dpkg -i` does not. On Ubuntu 22.04+ the `.AppImage` additionally
needs `sudo apt install libfuse2`. Wayland sessions run through XWayland by
default — if the window misbehaves, launch with `GDK_BACKEND=x11`.

#### 🌐 Any OS — server build (browser only)

`codifa-server-<platform>.zip` in each release contains the same binary without
an installer, for machines you drive from a browser instead of a desktop. Unzip
it, run `codifa serve`, and open the printed URL. See
[Server mode](#-server-mode-use-it-from-a-browser) for the flags, the token and
the systemd/launchd units.

**Linux server — one command (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | bash
```

It downloads `codifa-server-x86_64-unknown-linux-gnu.zip`, unpacks it to
`~/.local/lib/codifa-server` and links `codifa` into `~/.local/bin`. Re-running it
upgrades in place. For a system-wide install every user can reach:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | sudo PREFIX=/usr/local bash
```

**The hardened way** — also install a systemd service: the server binds
`127.0.0.1` ONLY (nothing network-exposed; reach it through an SSH tunnel or
a TLS proxy), restarts on failure, and runs inside the systemd sandbox
(read-only `$HOME`, private tmp, no capabilities). On a headless box it wraps
the server in `xvfb-run` automatically (install `xvfb` first). When it
starts, the token URL is printed and stored in `~/.codifa/web-token`; tunnel
with `ssh -L 8787:127.0.0.1:8787 user@server` and open the URL on your own
machine.

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | bash -s -- --service
```

To pin a release, pass the tag: `... | bash -s -- v2.0.1`.

The server binary is the desktop binary with the window stripped, so it still
needs the GTK 3 / WebKitGTK 4.1 libraries listed in the Linux section above; the
installer warns and names the packages when they are missing. Only `x86_64` is
published — on an ARM server, build from a checkout with
`cargo build --release` instead.

### 🚀 Getting started

1. Click **Open Folder** (or `Cmd/Ctrl+O`) and select your project folder.
2. Open settings (`Cmd/Ctrl+,`). Pick OpenRouter, a custom OpenAI-compatible
   API, or a local server (Ollama / llama.cpp / vLLM); enter your API key and
   choose a model.
3. Choose a mode: **Ask**, **Plan** or **Coder**.
4. Type a message and press `Enter` (or hold the mic button). The agent streams
   its answer and works on your files by itself — always inside the folder you
   opened. In **Plan** mode the finished plan is saved for that project and
   loaded again on your next Plan/Coder run.

> 💡 Your data (chats, settings, skills, memory) lives outside your projects —
> by default in `~/.codifa` on every OS. The path is changeable from
> **Settings → Memory**, and moving it keeps a backup of the old folder.

### 🌐 Server mode (use it from a browser)

The same binary runs headless on a server, and you drive it from any browser.

**`codifa serve` runs in the background by default** — it detaches, prints the
access URL with its token, and gives the terminal back:

```bash
codifa serve         # background; prints: [web] Codifa server ready: http://…?token=…
codifa stop          # stop the background server
codifa serve --foreground   # attach to the terminal instead (Ctrl-C to stop)
```

From a checkout of this repo, `npm run serve` builds the frontend first and
then starts the server the same way (`serve:fg` / `serve:stop` are the
foreground / stop variants). To BUILD the web edition without starting it —
the same binary the release zips contain — run `npm run dist:web`, then
`codifa serve` whenever you want it up.

Open the printed URL — `http://127.0.0.1:8787/?token=…` — and the full app
loads in the browser: chats, agent, files, git, the in-app terminal,
schedules. The token is persisted in `~/.codifa/web-token`, the first
`?token=` visit plants a session cookie, and a daemonized server logs to
`~/.codifa/serve.log`.

**From a packaged app** (the frontend is embedded, no flags needed):

```bash
# macOS
./Codifa.app/Contents/MacOS/codifa serve
# Windows / Linux (release zips named codifa-server-<platform>.zip)
codifa serve
```

On Linux the server binary is the same desktop binary, so it wants the GTK/
WebKit shared libraries installed (`libwebkit2gtk-4.1`, `libgtk-3`, … — the
list CI installs). A headless box without a display needs a virtual one:
`xvfb-run -a codifa serve`. The zip is a glibc build (Ubuntu-based) — mainstream
distros run it as-is; Alpine needs a musl build from source.

**Useful flags & env** (all optional): `--host` (default `127.0.0.1`;
`0.0.0.0` for LAN), `--port` (default `8787`), `--foreground` to keep the
server attached to the terminal, `--dist <dir>` for a dev/cargo run when
`./dist` isn't next to the working directory. Env: `CODIFA_SERVE_HOST` /
`CODIFA_SERVE_PORT` / `CODIFA_SERVE_DIST` / `CODIFA_WEB_TOKEN`.

**Keep it running for good** — a supervisor must use `--foreground`, e.g.
systemd (Linux) or launchd (macOS):

```ini
[Unit]
Description=Codifa web server
[Service]
ExecStart=/usr/local/bin/codifa serve --foreground --host 0.0.0.0 --port 8787
Restart=always
User=youruser
[Install]
WantedBy=multi-user.target
```

**Security:** the web surface is token-gated (cookie, `Authorization: Bearer`
or `?token=`), but the server can run commands and read/write files on its
machine — put it behind TLS (a reverse proxy) or a VPN, and do not expose it
to an untrusted network. The token is generated once, persisted with `0600`
permissions in `~/.codifa/web-token`, and compared in constant time; behind a
TLS proxy the session cookie is automatically flagged `Secure`. The strongest
default is the `--service` install above: loopback-only bind, the systemd
sandbox around it, and access through an SSH tunnel or a TLS proxy — nothing
listens on the network until you deliberately change that. Desktop-only
capabilities degrade gracefully in the browser: opening a workspace asks for
an absolute server path, files open in the in-app viewer, and screen capture
is disabled. Google sign-in needs the desktop app; use API keys on a server.

### ⌨️ Keyboard shortcuts

| Shortcut              | Action                                             |
| --------------------- | -------------------------------------------------- |
| `Enter`                | Send message (`Shift+Enter` = newline)            |
| `Cmd/Ctrl+Enter`      | Queue the message (sends after the current turn, won't interrupt) |
| `Cmd/Ctrl+F`          | Find in the focused chat transcript — highlights every match; `Enter`/`Shift+Enter` step next/previous, `Esc` closes |
| `Cmd/Ctrl+M`          | Fullscreen what has focus — terminal, side pane, else the focused chat window (press again to restore) |
| `Cmd/Ctrl+P`          | Quick-open / search overlay (`⌘⇧F` = content search) |
| `Cmd/Ctrl+B`          | Toggle sidebar                                     |
| `Cmd/Ctrl+,`          | Open settings                                      |
| `Cmd/Ctrl+S`          | Save current file                                  |
| `Cmd/Ctrl+T`          | New chat                                           |
| `Cmd/Ctrl+O`          | Open a project folder                              |
| `Ctrl+H/J/K/L`        | Move focus vim-style between chat windows (k=up, j=down, h=left, l=right) |
| `Shift+Alt(Option)+H/J/K/L` | Swap (move) chat window positions in the same vim directions |
| `Ctrl+X` then `j`     | Toggle the terminal panel (tmux-style prefix)      |
| `Ctrl+X` then `e`     | Open the file explorer (right pane) and focus its filter (tmux-style prefix) |
| `Ctrl+X` then `g`     | Open the git diff panel (tmux-style prefix)        |
| `Ctrl+X` then `a`     | Open the artifacts panel (tmux-style prefix)       |
| `Ctrl+X` then `s`     | Open the schedule panel (tmux-style prefix)        |
| `Ctrl+X` then `t`     | Focus the terminal tab in the right pane (spawns one if there is none) |
| `Ctrl+X` then `u`     | Undo last exchange (tmux-style prefix)             |
| `Ctrl+X` then `r`     | Redo last undone exchange (tmux-style prefix)      |
| `Ctrl+X` then `c`     | Compact the chat context (tmux-style prefix)       |
| `Ctrl+X` then `v`     | Toggle the live voice session (tmux-style prefix)  |
| `Ctrl+X` then `Space` | Hold to record voice (tmux-style prefix)           |

</details>

---

## Persian / فارسی

<details>
<summary><b>📖 فارسی — برای مشاهدهٔ مستندات کامل کلیک کنید</b></summary>

<div dir="rtl">

### ✨ امکانات

|     | ویژگی                          | توضیح                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌  | **مدل‌تان را خودتان بیاورید**  | به OpenRouter، هر API سازگار با OpenAI یا یک سرور محلی (Ollama / llama.cpp / vLLM) وصل می‌شود. فهرست مدل‌ها به‌روز گرفته می‌شود و از همان بالای پنجره قابل تعویض است.                                                                                                                        |
| 🤖  | **عامل واقعی، نه تکمیل خودکار** | سه حالت دارد — «پرسش» (پاسخ و توضیح)، «برنامه» (کد را می‌کاود و برنامهٔ پیاده‌سازی می‌نویسد) و «نویسندهٔ کد» (خودش فایل‌ها را می‌سازد و ویرایش می‌کند). با `Tab` میان‌شان بچرخید.                                                                                                            |
| 🛠️  | **داخل پروژهٔ شما کار می‌کند** | عامل خودش فایل‌ها را جستجو، باز، ساختن و ویرایش می‌کند — اما همیشه فقط داخل همان پوشه‌ای که باز کرده‌اید و هرگز به بیرون از پروژه دست نمی‌زند.                                                                                                                                             |
| 🔍  | **جستجو در چت**                | با `Cmd/Ctrl+F` هر گفتگو را جستجو کنید — همهٔ نتایج هایلایت می‌شوند و با `Enter`/`Shift+Enter` میان‌شان جابه‌جا شوید.                                                                                                                                                                         |
| 🪟  | **چند گفتگوی هم‌زمان**         | چند گفتگوی موازی داشته باشید، ناحیهٔ چت را به چند پنجره بشکنید و هرطور که خواستید بچینید.                                                                                                                                                                                                     |
| 🖥️  | **ترمینال داخلی**              | نشست‌های واقعی ترمینال — یک پنل پایین و چند تب ترمینال در پنل کناری، درست کنار چت.                                                                                                                                                                                                            |
| 🌿  | **پنل Git diff**               | دقیقاً ببینید چه چیزی تغییر کرده — فایل‌به‌فایل، با آمار افزوده/حذف‌شده، در پنل کناری.                                                                                                                                                                                                       |
| 📦  | **آرتیفکت‌ها**                 | عامل می‌تواند سندهای HTML/مارک‌داونِ قابل پیش‌نمایش بسازد — داشبورد، گزارش، ابزار کوچک — که داخل خود برنامه اجرا می‌شوند (`/artifact create …`).                                                                                                                                             |
| 🗓️  | **کارهای زمان‌بندی‌شده**       | کاری را روی یک زمان‌بندی بسپارید (مثلاً `/schedule create every day at 9am …`) و نتایج را در صندوق ورودی ببینید.                                                                                                                                                                              |
| 🎯  | **هدفِ ماندگار**               | به عامل یک هدفِ ثابت بدهید (مثلاً `/goal all tests pass`) تا ترن‌به‌ترن به سمتش پیش برود.                                                                                                                                                                                                    |
| 🎤  | **صدا**                        | میکروفون را نگه دارید و به فارسی یا انگلیسی صحبت کنید تا متن شود — یا یک گفتگوی صدای زنده باز کنید و رفت‌وبرگشتی حرف بزنید. هر دو از سرویس‌های گفتاری استفاده می‌کنند که در **تنظیمات ← فراهم‌کننده‌های رسانه** پیکربندی می‌کنید.                                                            |
| 🧠  | **حافظه**                      | از عامل بخواهید چیزها را به خاطر بسپارد — یادداشت‌ها و صفحات ذخیره‌شده برای هر پروژه نگه داشته می‌شوند و بعداً قابل جستجو هستند؛ کاملاً روی دستگاه خودتان.                                                                                                                                   |
| 🧩  | **مهارت، اتصال، پلاگین**       | از عامل بخواهید مهارت، اتصال MCP یا پلاگین نصب کند (از یک مخزن یا صفحهٔ مستندات) — همه داخل خود برنامه ذخیره می‌شوند و در پوشه‌های پیکربندیِ ابزارهای دیگر چیزی نوشته نمی‌شود.                                                                                                              |
| 🛟  | **روان با مدل‌های کوچک**       | حتی با مدل‌های محلی کوچک (۸ هزار توکن) هم روان کار می‌کند — پیش از تمام‌شدن ظرفیت، تاریخچه خودکار خلاصه می‌شود تا به‌جای توقف، کار پیش برود.                                                                                                                                                 |
| 🎨  | **۱۵ تم + راست‌به‌چپ کامل**    | ۱۵ تم تیره و روشن، و ترکیب فارسی/انگلیسی همه‌جا درست نمایش داده می‌شود — پرانتز و فلش و مارک‌داون در حالت راست‌به‌چپ هرگز به‌هم نمی‌ریزند.                                                                                                                                                  |
| ⌨️  | **دستورهای اسلش**              | `/help`، `/compact`، `/clear`، `/new`، `/plan`، `/undo`، `/redo`، `/skill`، `/mcp`، `/plugin`، `/artifact`، `/schedule`، `/goal`.                                                                                                                                                            |

### 📥 نصب برای کاربران نهایی

اگر فقط می‌خواهید Codifa را اجرا کنید، نصب‌کنندهٔ سیستم‌عامل خودتان را از
[آخرین نسخه](https://github.com/rhsaman/codifa/releases/latest) بردارید. این اپ با
**گواهی Developer ID اپل امضا نشده** و نصب‌کننده‌های ویندوز هم **کدساین نشده‌اند**،
بنابراین هر سیستم‌عامل در اجرای اول یک هشدار اضافه نشان می‌دهد؛ گام‌های زیر آن را
برمی‌دارند.

#### 🍎 مک (اپل سیلیکون و اینتل)

**پیش‌نیاز:** مک‌اواس ۱۳.۴ یا بالاتر. هر دو بیلد `aarch64` (اپل سیلیکون: M1 تا M4)
و `x64` (اینتل) منتشر می‌شوند؛ همان را بردارید که مک شما اجرا می‌کند.

**راه ۱ — نصب با یک دستور (پیشنهادی):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash
```

پردازنده را تشخیص می‌دهد، دیسک‌ایمیج متناسب را دانلود می‌کند، امضای کد اپ را
بررسی می‌کند، فلگ قرنطینه را پاک می‌کند و اپ را در `/Applications` می‌گذارد. هر گام
چاپ می‌شود تا ببینید چه اتفاقی افتاده است. برای نصب یک نسخهٔ مشخص، تگ را بدهید:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash -s -- v2.0.1
```

**راه ۲ — نصب دستی:**

۱. فایل `.dmg` مناسب پردازندهٔ خود را از [آخرین نسخه](https://github.com/rhsaman/codifa/releases/latest) دانلود کنید و **Codifa** را به `/Applications` بکشید.

   | پردازنده | فایل |
   | --- | --- |
   | اپل سیلیکون (سری M) | `Codifa_<version>_aarch64.dmg` |
   | اینتل | `Codifa_<version>_x64.dmg` |

۲. فلگ قرنطینه را پاک کنید، وگرنه مک از باز کردن آن سرباز می‌زند:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Codifa.app
   ```

۳. Codifa را از `/Applications` باز کنید. اگر مک باز هم مسدود کرد، به **System Settings → Privacy & Security** بروید و **Open Anyway** را بزنید.

**مجوزها:** Codifa میکروفون (ورودی صوتی) و ضبط صفحه (Computer Use) را می‌خواهد.
آن‌ها را در **System Settings → Privacy & Security** بدهید؛ چون اپ notarize
نشده است، ممکن است لازم باشد بعد از هر به‌روزرسانی آن‌ها را یک‌بار خاموش و
روشن کنید و اپ را دوباره باز کنید.

#### 🪟 ویندوز ۱۰ و ۱۱ (x64)

**پیش‌نیاز:** ویندوز ۶۴-بیتی ۱۰ یا بالاتر. نصب‌کننده **WebView2 runtime** را با
خودش می‌آورد: حالت پیش‌فرض Tauri وقتی runtime نصب نباشد bootstrapper را دانلود
می‌کند، پس چیز اضافه‌ای لازم نیست. روی ماشین بدون اینترنت، اول از
[صفحهٔ WebView2 مایکروسافت](https://developer.microsoft.com/microsoft-edge/webview2/)
نصبش کنید.

**راه ۱ — نصب‌کننده (پیشنهادی):**

۱. فایل `Codifa_<version>_x64-setup.exe` را از [آخرین نسخه](https://github.com/rhsaman/codifa/releases/latest) دانلود و اجرا کنید.
۲. چون نصب‌کننده کدساین نشده است، SmartScreen پیام _«Windows protected your PC»_ نشان می‌دهد. روی **More info → Run anyway** بزنید.
۳. Codifa به‌صورت per-user نصب می‌شود و در منوی Start ظاهر می‌شود.

**راه ۲ — MSI (برای نصب مدیریت‌شده):** فایل `Codifa_<version>_x64_en-US.msi`
همان اپ را برای ماشین‌هایی نصب می‌کند که `.exe` را مسدود می‌کنند؛
`msiexec /i Codifa_<version>_x64_en-US.msi` آن را بی‌صدا از اسکریپت اجرا می‌کند.

برای حذف: **Settings → Apps → Installed apps → Codifa → Uninstall**.

#### 🐧 لینوکس (x86_64)

باندل‌های لینوکس به GTK 3 و WebKitGTK 4.1 نیاز دارند. وقتی `.deb` را نصب می‌کنید،
`apt` خودش این‌ها را می‌آورد؛ دستی فقط وقتی لازم است که از `.AppImage` استفاده
می‌کنید یا سیستم‌تان حداقلی است:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1
```

روی فدورا `webkit2gtk4.1`، `gtk3` و `libappindicator-gtk3`؛ روی آرچ
`webkit2gtk-4.1`، `gtk3` و `libayatana-appindicator`. بعد یکی از بسته‌ها را بردارید:

| بسته | کِی به کار می‌آید | نصب |
| --- | --- | --- |
| `.deb` | دبیان / اوبونتو | `sudo apt install ./Codifa_<version>_amd64.deb` |
| `.rpm` | فدورا / openSUSE | `sudo dnf install ./Codifa-<version>-1.x86_64.rpm` |
| `.AppImage` | هر توزیعی، بدون root | `chmod +x Codifa_<version>_amd64.AppImage && ./Codifa_<version>_amd64.AppImage` |

`apt install ./<file>.deb` (با `./` ابتدای مسیر) وابستگی‌ها را خودش حل می‌کند،
`dpkg -i` این کار را نمی‌کند. روی اوبونتو ۲۲.۰۴ به بعد، `.AppImage` به
`sudo apt install libfuse2` هم نیاز دارد. نشست‌های Wayland به‌طور پیش‌فرض از
XWayland استفاده می‌کنند؛ اگر پنجره بدرفتاری کرد، با `GDK_BACKEND=x11` اجرا کنید.

#### 🌐 هر سیستم‌عامل — بیلد سرور (فقط مرورگر)

فایل `codifa-server-<platform>.zip` در هر نسخه همان باینری را بدون نصب‌کننده
دارد، برای ماشین‌هایی که از مرورگر کنترل می‌کنید نه از دسکتاپ. بازش کنید،
`codifa serve` را اجرا کنید و آدرس چاپ‌شده را باز کنید. فلگ‌ها، توکن و یونیت‌های
systemd/launchd در بخش [حالت سرور](#-حالت-سرور-استفاده-از-مرورگر) آمده است.

**سرور لینوکس — نصب یک‌خطی (پیشنهادی):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | bash
```

اسکریپت فایل `codifa-server-x86_64-unknown-linux-gnu.zip` را می‌گیرد، در
`~/.local/lib/codifa-server` باز می‌کند و `codifa` را در `~/.local/bin` لینک
می‌کند؛ اجرای دوباره‌اش نسخه را به‌روز می‌کند. برای نصب سیستم‌گسترده که همهٔ
کاربران ببینند:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | sudo PREFIX=/usr/local bash
```

**راه سخت‌گیرانه** — علاوه بر نصب، یک سرویس systemd هم راه می‌اندازد: سرور فقط
روی `127.0.0.1` می‌شنود (هیچ چیزی به شبکه باز نیست؛ با SSH tunnel یا TLS proxy
برسید)، موقع خرابی ری‌استارت می‌شود و داخل سندباکس systemd اجرا می‌شود
(`$HOME` فقط-خواندنی، tmp خصوصی، بدون هیچ capability). روی سرور بدون مانیتور
خودش سرور را داخل `xvfb-run` می‌پیچد (اول `xvfb` را نصب کنید). موقع استارت،
آدرس توکن چاپ و در `~/.codifa/web-token` ذخیره می‌شود؛ با
`ssh -L 8787:127.0.0.1:8787 user@server` تونل بزنید و URL را روی دستگاه خودتان
باز کنید.

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-linux-server.sh | bash -s -- --service
```

برای قفل‌کردن روی یک نسخهٔ خاص، تگ را بدهید: `... | bash -s -- v2.0.1`.

باینری سرور همان باینری دسکتاپ بدون پنجره است، پس همچنان به کتابخانه‌های
GTK 3 / WebKitGTK 4.1 بخش لینوکس بالا نیاز دارد؛ اسکریپت اگر پیدا نشوند هشدار
می‌دهد و نام پکیج هر توزیع را می‌گوید. فقط معماری `x86_64` منتشر می‌شود — روی
سرور ARM، از سورس با `cargo build --release` بسازید.

### 🚀 شروع سریع

۱. روی **باز کردن پوشه** کلیک کنید (یا `Cmd/Ctrl+O`) و پوشهٔ پروژه‌تان را انتخاب کنید.

۲. تنظیمات را باز کنید (`Cmd/Ctrl+,`). OpenRouter یا یک API سازگار با OpenAI یا
یک سرور محلی (Ollama / llama.cpp / vLLM) را انتخاب کنید، کلید API را وارد کنید
و مدل را برگزینید.

۳. حالت را انتخاب کنید: **پرسش**، **برنامه** یا **نویسندهٔ کد**.

۴. پیام خود را بنویسید و `Enter` را بزنید (یا دکمهٔ میکروفون را نگه دارید).
عامل پاسخ را زنده نمایش می‌دهد و خودش روی فایل‌هایتان کار می‌کند — همیشه فقط
داخل همان پوشه‌ای که باز کرده‌اید. در حالتِ «برنامه»، برنامهٔ نهایی برای همان
پروژه ذخیره و در اجرای بعدیِ حالت برنامه/نویسندهٔ کد دوباره بارگذاری می‌شود.

> 💡 داده‌های شما (گفتگوها، تنظیمات، مهارت‌ها، حافظه) بیرون از پروژه‌هایتان
> نگه داشته می‌شود — به‌صورت پیش‌فرض در `~/.codifa` روی هر سیستم‌عاملی. این مسیر
> از **تنظیمات ← حافظه** قابل تغییر است و هنگام جابه‌جایی، از پوشهٔ قبلی پشتیبان
> گرفته می‌شود.

### 🌐 حالت سرور (استفاده از مرورگر)

همان باینری به‌صورت headless اجرا می‌شود و از هر مرورگری می‌توانید با آن کار
کنید.

**`codifa serve` به‌صورت پیش‌فرض در بک‌گراند اجرا می‌شود** — پروسه جدا می‌شود،
آدرس دسترسی با توکن را چاپ می‌کند و ترمینال را آزاد می‌گذارد:

```bash
codifa serve         # بک‌گراند؛ چاپ می‌کند: [web] Codifa server ready: http://…?token=…
codifa stop          # خاموش کردن سرور بک‌گراند
codifa serve --foreground   # چسبیده به ترمینال (خاموشی با Ctrl-C)
```

در ریشه‌ی پروژه، `npm run serve` اول فرانت را می‌سازد و بعد سرور را همین‌طور
روشن می‌کند (`serve:fg` و `serve:stop` هم حالت پیش‌رو و خاموش‌کننده‌اند). برای
«بیلدِ» نسخه‌ی وب بدون روشن‌کردن آن — همان باینری‌ای که زیپ‌های ریلیز دارند —
`npm run dist:web` را بزنید و هر وقت خواستید بالا بیاید `codifa serve`.

آدرس چاپ‌شده — `http://127.0.0.1:8787/?token=…` — را در مرورگر باز کنید؛ کل
برنامه (گفتگوها، عامل، فایل‌ها، گیت، ترمینال داخلی و زمان‌بندها) بالا می‌آید.
توکن در `~/.codifa/web-token` ذخیره می‌شود، اولین بازدیدِ `?token=` یک کوکی
نشست نصب می‌کند و لاگ سرور بک‌گراند در `~/.codifa/serve.log` است.

**از بسته‌ی نصبی** (فرانت داخل باینری embed شده، بدون هیچ فلگی):

```bash
# مک
./Codifa.app/Contents/MacOS/codifa serve
# ویندوز / لینوکس (زیپ‌های codifa-server-<platform>.zip در ریلیزها)
codifa serve
```

**فلگ‌ها و متغیرها** (همه اختیاری‌اند): `--host` (پیش‌فرض `127.0.0.1`؛ برای
شبکه‌ی محلی `0.0.0.0`)، `--port` (پیش‌فرض `8787`)، `--foreground` برای چسبیدن
به ترمینال، و `--dist <مسیر>` برای اجرای dev وقتی `./dist` کنار مسیر جاری
نیست. متغیرهای محیطی: `CODIFA_SERVE_HOST` / `CODIFA_SERVE_PORT` /
`CODIFA_SERVE_DIST` / `CODIFA_WEB_TOKEN`.

**اجرای دائمی** — سرویس‌کننده باید `--foreground` بگیرد، مثلاً یونیت systemd
(لینوکس) یا launchd (مک):

```ini
[Unit]
Description=Codifa web server
[Service]
ExecStart=/usr/local/bin/codifa serve --foreground --host 0.0.0.0 --port 8787
Restart=always
User=youruser
[Install]
WantedBy=multi-user.target
```

**امنیت:** سطح وب با توکن محافظت می‌شود (کوکی، `Authorization: Bearer` یا
`?token=`)، اما سرور می‌تواند روی ماشین خودش دستور اجرا کند و فایل بخواند/بنویسد —
پشت TLS (reverse proxy) یا VPN بگذارید و روی شبکه‌ی نامطمئن باز نکنید. توکن
یک بار ساخته می‌شود، با دسترسی `0600` در `~/.codifa/web-token` ذخیره می‌شود و
با مقایسه‌ی زمان-ثابت سنجیده می‌شود؛ پشت پراکسی TLS، کوکی نشست خودکار پرچم
`Secure` می‌گیرد. مطمئن‌ترین حالت همان نصب `--service` بالاست: bind فقط روی
loopback، سندباکس systemd دور آن، و دسترسی از راه SSH tunnel یا TLS — تا وقتی
خودتان عمداً عوضش نکنید، هیچ چیزی روی شبکه گوش نمی‌دهد. قابلیت‌های
فقط-دسکتاپ در مرورگر با ملایمت غیرفعال می‌شوند: انتخاب پوشه‌ی پروژه
مسیر مطلق سمت سرور را می‌پرسد، فایل‌ها در نمایشگر داخلی باز می‌شوند و ضبط صفحه
از دسترس خارج است. ورود گوگل به اپ دسکتاپ نیاز دارد؛ روی سرور از کلید API
استفاده کنید.

### ⌨️ میان‌برهای صفحه‌کلید

| میان‌بر                | کارکرد                                                |
| ---------------------- | ----------------------------------------------------- |
| `Enter`               | ارسال پیام (`Shift+Enter` = خط جدید)                |
| `Cmd/Ctrl+Enter`       | صف‌کردن پیام (بعد از پایان ترنِ فعلی ارسال می‌شود، بدون قطع) |
| `Cmd/Ctrl+F`           | جستجو در چتِ در فوکوس — همهٔ نتایج هایلایت می‌شوند؛ `Enter`/`Shift+Enter` نتیجهٔ بعدی/قبلی، `Esc` می‌بندد |
| `Cmd/Ctrl+M`           | تمام‌صفحه‌کردن هرچه در فوکوس است — ترمینال، پنل کناری، وگرنه پنجرهٔ چت (دوباره بزنید تا برگردد) |
| `Cmd/Ctrl+P`           | جستجوی سریع و سریع‌باز کردن (`⌘⇧F` = جستجوی محتوا)    |
| `Cmd/Ctrl+B`           | نمایش/پنهان‌کردن نوار کناری                           |
| `Cmd/Ctrl+,`           | باز کردن تنظیمات                                      |
| `Cmd/Ctrl+S`           | ذخیرهٔ فایل جاری                                      |
| `Cmd/Ctrl+T`           | گفتگوی تازه                                           |
| `Cmd/Ctrl+O`           | باز کردن پوشهٔ پروژه                                   |
| `Ctrl+H/J/K/L`        | جابه‌جایی فوکوس میان پنجره‌های چت به سبک ویم (k=بالا، j=پایین، h=چپ، l=راست) |
| `Shift+Alt(Option)+H/J/K/L` | جابه‌جایی (سواپ) جای پنجره‌های چت در همان جهت‌های ویم |
| `Ctrl+X` و سپس `j`     | نمایش/پنهان‌کردن پنل ترمینال (پیشوندِ سبک tmux)      |
| `Ctrl+X` و سپس `e`     | باز کردن فایل اکسپلورر (پنل راست) با فوکوس روی فیلتر آن (پیشوندِ سبک tmux) |
| `Ctrl+X` و سپس `g`     | باز کردن پنل Git diff (پیشوندِ سبک tmux)             |
| `Ctrl+X` و سپس `a`     | باز کردن پنل آرتیفکت‌ها (پیشوندِ سبک tmux)           |
| `Ctrl+X` و سپس `s`     | باز کردن پنل Schedule (پیشوندِ سبک tmux)             |
| `Ctrl+X` و سپس `t`     | فوکوس تب ترمینال در پنل راست (اگر وجود نداشته باشد ساخته می‌شود) |
| `Ctrl+X` و سپس `u`     | بازگردانی آخرین تبادل (پیشوندِ سبک tmux)              |
| `Ctrl+X` و سپس `r`     | بازانجام آخرین تبادل بازگردانی‌شده (پیشوندِ سبک tmux) |
| `Ctrl+X` و سپس `c`     | فشرده‌سازی زمینهٔ گفتگو (پیشوندِ سبک tmux)            |
| `Ctrl+X` و سپس `v`     | نمایش/پنهان‌کردن نشست صدای زنده (پیشوندِ سبک tmux)    |
| `Ctrl+X` و سپس `Space` | نگه‌داشتن Space برای ضبط صدا (پیشوندِ سبک tmux)       |

</div>
</details>

---

## 🤝 Contributing / مشارکت

Contributions of all kinds are welcome — bug reports, feature ideas, docs and
code. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or
pull request.

مشارکت‌های همه‌جانبه خوش‌آمد است — گزارش باگ، ایدهٔ ویژگی، مستندات و کد. پیش از
ثبت issue یا pull request لطفاً [CONTRIBUTING.md](CONTRIBUTING.md) را بخوانید.

---

## 📄 License / مجوز

MIT — do whatever you like, just keep the license. / هر طور که می‌خواهید
استفاده کنید؛ فقط مجوز را نگه دارید.

---

⭐ If Codifa helps you, please star the repo — it helps others find it. /
اگر کدیفا به کارتان آمد، با یک ⭐ به دیده‌شدن آن کمک کنید.
