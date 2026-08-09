# Codefa

> English description below — توضیحات فارسی در ادامه آمده است.

---

## What is Codefa? / کدفا چیست؟

**English —** Codefa is an **offline-first desktop coding assistant** built with
Electron. It gives you a full IDE-style workspace — a file explorer, a Monaco
editor and an AI chat panel — with an **AI agent (built on Pydantic AI) that
actually works inside your project**: it can open files, read them, search across
them and edit them *itself*, all confined to the folder you choose. You can talk
to it by typing *or* by voice (local whisper), and it streams its reasoning and
code changes in real time. It connects to your own models (OpenRouter, any
OpenAI-compatible API, or a local Ollama / llama.cpp / vLLM endpoint), so nothing
leaves your machine unless you want it to.

**فارسی —** کدفا یک دستیار کدنویسی دسکتاپی است که بر پایهٔ Electron و با نگاهی
ویژه به آفلاین بودن ساخته شده است؛ یعنی هر کاری که انجام می‌دهد، روی خودِ دستگاه
شما می‌ماند، مگر آنکه خودتان بخواهید چیزی به بیرون ارسال شود. چیزی که کدفا را از
یک چت‌بات ساده جدا می‌کند، «عامل» باهوشی است که در دل آن نشسته و بر بستر
Pydantic AI کار می‌کند. این عامل صرفاً به شما پاسخ نمی‌دهد؛ بلکه به‌راستی وارد
پروژهٔ شما می‌شود و درست مانند یک همکار مهندس، فایل‌ها را باز می‌کند، مضمونشان را
می‌خواند، در میانشان جستجو می‌کند و حتی خودش آن‌ها را ویرایش می‌کند — و تمام این
دست‌وپا زدن‌ها هم محدود به همان پوشه‌ای است که شما برگزیده‌اید. کار با آن
ساده است: یا متن بنویسید، یا به‌راستی با آن حرف بزنید و بگذارید صدایتان (با
تبدیل گفتار به متنِ محلی) به پیام بدل شود، و جوابش را پاره‌گفتارپاره‌گفتار و
زنده ببینید. چون هر فراهم‌کننده‌ای که دوست دارید به آن وصل می‌شود — از
OpenRouter تا هر APIِ سازگار با OpenAI و حتی یک سرور محلی مانند Ollama یا
llama.cpp — بیشترِ کارها بر بستر و داده‌های خودِ شما انجام می‌شود.

---

## Feature overview — نمای کلی ویژگی‌ها

**English**

- 🔌 **Bring your own model** — OpenRouter, any OpenAI-compatible API, or a fully
  local endpoint; switch models from the UI.
- 🤖 **Real agent, not glorified autocomplete** — reads, searches, writes and
  edits your files inside a sandboxed project folder, including MCP connectors.
- 🎤 **Voice input** — hold a button, speak in Persian/English, get text (local whisper).
- 📊 **Live context meter** — see exactly how much of the model's context you've used.
- 🛟 **Never-stuck agent** — gracefully auto-compacts history on small context windows.
- 🖥️ **Full IDE UI** — file explorer, Monaco editor, markdown chat, dark/light theme.
- 🔒 **Safe by design** — every read/write/search confined to your chosen folder.
- 🔁 **Streaming + persistence** — token-by-token SSE, history kept in `~/.coder/`.

**فارسی**

- 🔌 **مدل‌تان را بیاورید** — به همین فراهم‌کننده‌ای که خودتان انتخاب می‌کنید وصل می‌شود: OpenRouter، هر API سازگار با OpenAI یا یک سرور محلی؛ و تعویض مدل از خودِ رابط کاربری.
- 🤖 **هدف حقیقی، نه تکمیل خودکار** — فایل‌هایتان را می‌خواند، جستجو و ویرایش می‌کند و به دل پروژهٔ ایزولهٔ شما می‌رود؛ و از اتصال‌های MCP هم پشتیبانی می‌کند.
- 🎤 **ورودی صوتی** — دکمه را می‌فشارید، به فارسی یا انگلیسی حرف می‌زنید و متنش همان‌جا آماده می‌شود.
- 📊 **نوار بافتِ زنده** — می‌بینید دقیقاً چه اندازه از پنجرهٔ بافتِ مدل را مصرف کرده‌اید.
- 🛡️ **فشردن ناگهانی ندارد** — در پنجرهٔ بافتِ کوچک، تاریخچه به‌شکلی هوشمند و خودکار فشرده می‌شود تا کار نصفه رها نشود.
- 🖥️ **رابطی به بلندِ یک IDE** — کاوشگر فایل، ویرایشگر و چت، همراه با تم تیره و روشن.
- 🔒 **امنیت از پایه** — هر خواندن، نوشتن یا جستجو فقط در همان پوشهٔ انتخابی شما انجام می‌شود.
- 🔁 **استریم و ماندگاری** — پاسخ‌ها قطعه‌به‌قطعه می‌رسند و بایگانی گفتگوها در `~/.coder/` نگه داشته می‌شود.

---

## English

### Features

- **Multi-provider LLM** — OpenRouter, any OpenAI-compatible API (llama.cpp / vLLM),
  and local Ollama — all driven through Pydantic AI.
- **Dynamic model switching** — models are fetched from the active provider and
  selectable directly from the UI settings.
- **Three agent modes** — `Ask` (read-only mentor that teaches you step by step),
  `Plan` (read-only planner that scouts the code and writes an implementation
  plan) and `Coder` (autonomous code-writing agent). Cycle through them at the
  top of the chat panel or with `Cmd/Ctrl+M`.
- **Tool-based agent** — `search_in_files`, `list_files`, `write_file`,
  `edit_file`, plus MCP connectors, all executed by the Pydantic AI sidecar
  and constrained to the project root.
- **Safe file access** — pick a project folder; every read/write/search is
  confined to it (path-traversal and symlink-escape guards in both Electron IPC
  and Python).
- **Voice input** — a push (mic) button records your voice and transcribes it with a
  fully local, offline `faster-whisper` model once installed; the text is then
  inserted into the composer. While recording, the mic icon animates into a
  live "wave" equalizer (Claude Code style).
- **Live context meter** — the context-usage bar updates in real time during
  long tool loops, using the provider's exact per-request token counts instead
  of an estimate.
- **Graceful small-context handling** — when the model's context window is small
  (e.g. an 8192-token local model) the agent pre-emptively compacts history at 80%
  of the window and auto-compacts on overflow, so the agent keeps working instead
  of crashing.
- **UI** — resizable file explorer (left), Monaco editor (center), streaming AI
  chat with markdown + syntax highlighting (right).
- **RTL / LTR** — chat messages use `direction: auto; unicode-bidi: plaintext` so
  Persian and English mix correctly; the whole README and UI support both.
- **Streaming** — token-by-token SSE streaming from the sidecar, no terminal output.
- **Persistence** — provider config, chat history, skills, MCP connectors and
  saved plans all stored in `~/.coder/` — never inside your project.
- **Slash commands** — `/compact` (summarizes the conversation into a running
  summary), `/clear`, `/new`, `/undo`, `/redo`, `/help`, `/skill` and `/mcp`.
- **Bonus** — model caching, multiple chats, dark/light theme, keyboard shortcuts.

### Requirements

- Node.js >= 20 and npm
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Python >= 3.10 (managed by uv)

### Setup

```bash
npm install       # JS dependencies
npm run setup     # creates backend/.venv and installs pydantic-ai, fastapi, uvicorn
```

Voice input uses a fully local `faster-whisper` model (see `backend/whisper/`).
If it is missing, install it once with:

```bash
npm run setup:voice     # downloads the CTranslate2 "small" model into backend/whisper/
```

### Development

```bash
npm run dev
```

Opens the Electron window with a hot-reloading renderer. The Python sidecar
(FastAPI + Pydantic AI) is auto-spawned on an ephemeral localhost port. When
launched from the packaged `.app`, Codefa also merges the GUI PATH with your login
shell path so tools such as `docker` (used by MCP stdio connectors) are found.

### Building / packaging

```bash
npm run build       # typecheck + build renderer, main and preload
npm run dist        # package for the current OS (dmg/zip on mac, NSIS exe on win, AppImage on linux)
npm run dist:mac    # only macOS
npm run dist:win    # only Windows
npm run dist:linux  # only Linux
```

Output lands in `release/`.

**macOS Gatekeeper warning:** the packaged app is ad-hoc signed (not
notarized), so the first launch from Finder may show
*“CODEFA has been blocked because it may reduce your privacy and lower the
security of your Mac.”* This is expected for locally-built apps without a
Developer ID. Fix: right-click the app → **Open** → **Open** once. If you
copied it from a download, also clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /path/to/CODEFA.app
```

(Removing the warning for every user requires a paid Apple Developer account
and notarization.)

### Usage

1. Click **Open Folder** (or `Cmd/Ctrl+O`) and select your project root.
2. Open settings (`Cmd/Ctrl+,`). The default provider is **opencode**
   (`opencode/deepseek-v4-flash-free` via OpenRouter). You can switch to
   OpenRouter, a custom OpenAI-compatible API, or a local endpoint
   (Ollama / llama.cpp / vLLM), enter your API key / base URL, and pick a model.
3. Choose an agent mode: **Ask**, **Plan** or **Coder**.
4. Type a message and press `Cmd/Ctrl+Enter`. The agent streams its reply and
   uses sandboxed tools to inspect or modify files. Press the mic button to
   dictate instead of typing. In Plan mode, `/compact` saves a running summary,
   and the final plan is stored under `~/.coder/plans/<workspace>/`.

### Keyboard shortcuts

| Shortcut         | Action                                             |
| ---------------- | -------------------------------------------------- |
| `Cmd/Ctrl+Enter` | Send chat message                                  |
| `Cmd/Ctrl+M`     | Cycle agent mode (Ask / Plan / Coder)             |
| `Cmd/Ctrl+P`     | Quick-open / search overlay (⌘⇧F for content grep) |
| `Cmd/Ctrl+B`     | Toggle sidebar                                     |
| `Cmd/Ctrl+,`     | Open settings                                      |
| `Cmd/Ctrl+S`     | Save current file                                  |
| `Cmd/Ctrl+T`     | New chat                                           |

### Architecture

```
┌──────────────── Electron ────────────────┐
│ main.ts   window, sidecar spawn, fs IPC, │
│           config + chat persistence      │
│ preload.ts contextBridge (whitelisted)   │
│ renderer  React + Monaco + chat (SSE)    │
└─────┬──────────────────▲─────────────────┘
      │ spawn / stdio     │ HTTP + SSE (127.0.0.1)
┌─────▼──────────────────┴─────────────────┐
│ Python sidecar  (uv managed .venv)        │
│ server.py     FastAPI /health /models    │
│               /chat/stream (SSE) /fs     │
│               /transcribe (Whisper)      │
│ providers.py  → pydantic-ai OpenAIModel  │
│ tools.py      sandboxed fs tools         │
│ agents.py     Ask / Plan / Coder agents   │
│               (live usage + compact)     │
└───────────────────────────────────────────┘
```

## Persian / فارسی

### کدفا چیست؟

کدفا یک دستیار کدنویسی دسکتاپی است که بر پایهٔ Electron ساخته شده و در نگاه
اول، همان حسی را دارد که یک ویرایشگر کد مدرن می‌دهد: کاوشگری برای فایل‌ها،
ویرایشگری توانمند و یک پنل گفتگو که در کنار شما کار می‌کند. اما تفاوت اصلی در
همان «پنل گفتگو» است؛ پشت این گفتگو، یک عامل هوش مصنوعی واقعی نشسته که بر بستر
Pydantic AI ساخته شده و می‌تواند مستقیماً با کد شما سر و کار داشته باشد. این
عامل فقط حرف نمی‌زند؛ فایل‌های پروژهٔ شما را می‌خواند، در آن‌ها جستجو می‌کند و
خودش آن‌ها را تغییر می‌دهد — آن هم تنها در چارچوب همان پوشه‌ای که برایش مشخص
کرده‌اید. به همین دلیل هم کدفا به هر فراهم‌کننده‌ای وصل می‌شود که خودتان بخواهید،
هم به سرویس‌های ابری مانند OpenRouter، هم به هر APIِ سازگار با OpenAI و هم به
مدل‌های محلی مثل Ollama و llama.cpp؛ تا در هر حال، کار اصلی همواره روی خودِ
دستگاه شما و در همان پروژهٔ خودتان انجام شود.

### امکانات

- **چند فراهم‌کنندهٔ هوش مصنوعی** — کدفا به OpenRouter، هر APIِ سازگار با
  OpenAI (مانند llama.cpp یا vLLM) و نیز Ollama محلی وصل می‌شود؛ همگی از طریق
  Pydantic AI.
- **تعویض سادهٔ مدل** — فهرست مدل‌ها از فراهم‌کنندهٔ فعال دریافت می‌شود و
  می‌توانید از همان صفحهٔ تنظیمات، مدل دلخواه را برگزینید.
- **سه حالتِ عامل** — «پرسش» (دستیارِ فقط‌خواندنی که گام‌به‌گام به شما آموزش
  می‌دهد)، «برنامه» (برنامه‌ریزِ فقط‌خواندنی که کد را می‌کاود و یک برنامهٔ پیاده‌سازی
  می‌نویسد) و «نویسندهٔ کد» (عامل خودمختاری که مستقلاً کد می‌نویسد). با دکمهٔ بالای
  پنل گفتگو یا کلید `Cmd/Ctrl+M` می‌توانید میانشان جابه‌جا شوید.
- **عاملِ ابزارمحور** — عملیات‌هایی مانند `search_in_files`، `write_file`،
  `list_files` و `edit_file` (و همچنین اتصال‌های MCP) همگی توسط
  sidecar پایتونی اجرا و به ریشهٔ پروژه محدود می‌شوند.
- **دسترسی امن به فایل‌ها** — شما پوشهٔ پروژه را مشخص می‌کنید و تمام خواندن‌ها،
  نوشتن‌ها و جستجوها به همان پوشه محدود است؛ هم در سمت الکترون و هم در سمت
  پایتون، در برابر مسیرهای گذر (path traversal) و فرار از symlink حفاظت شده‌اید.
- **ورودی صوتی** — با فشردن دکمهٔ میکروفون، صدای خود را ضبط کنید؛ این صدا با
  مدلِ کاملاً محلی و آفلاینِ `faster-whisper` به متن تبدیل و همان‌جا در کادر پیام
  گذاشته می‌شود. هنگام ضبط هم آیکن میکروفون به صورت یک اکولایزر موجدارِ متحرک
  (به سبک Claude Code) درمی‌آید.
- **نوار استفادهٔ بافتِ زنده** — در طول حلقه‌های طولانیِ ابزار، میزان مصرف بافت
  به‌طور مستقیم و بر پایهٔ شمار توکنِ دقیقی که فراهم‌کننده اعلام می‌کند به‌روز
  می‌شود، نه بر پایهٔ یک برآورد تقریبی.
- **مدیریت هوشمند بافتِ کم** — اگر پنجرهٔ بافتِ مدل کوچک باشد (مثلاً مدلِ
  ۸۱۹۲ توکنی در LM Studio)، عامل پیش از رسیدن به سقف، در ۸۰٪ ظرفیت تاریخچه را
  فشرده می‌کند و در صورت سرریز هم به‌طور خودکار این کار را انجام می‌دهد تا به
  جای توقف، کار همچنان پیش برود.
- **رابط کاربری** — کاوشگر فایل با اندازهٔ قابل تنظیم (چپ)، ویرایشگر Monaco
  (وسط) و چتِ هوش مصنوعی با پشتیبانی از markdown و هایلایتِ سینتکس (راست).
- **راست‌به‌چپ / چپ‌به‌راست** — پیام‌ها از `direction: auto; unicode-bidi:
  plaintext` استفاده می‌کنند تا ترکیب فارسی و انگلیسی به‌درستی نمایش داده شود.
- **استریم** — پاسخ‌ها به‌شکل قطعه‌به‌قطعه و از طریق SSE از sidecar می‌رسند؛
  نیازی به نگه داشتن ترمینال نیست.
- **ماندگاری** — پیکربندی فراهم‌کننده، تاریخچهٔ گفتگوها، مهارت‌ها، اتصال‌های MCP و
  برنامه‌های ذخیره‌شده همه در `~/.coder/` ذخیره می‌شوند و هرگز داخل پوشهٔ پروژهٔ شما.
- **دستورهای اسلش** — `/compact` (خلاصه‌سازی گفتگو به یک خلاصهٔ جاری)، `/clear`،
  `/new`، `/undo`، `/redo`، `/help`، `/skill` و `/mcp`.
- **و چند چیز دیگر** — حافظهٔ پنهانِ مدل، چند گفتگوی موازی، تم تیره و روشن و
  میان‌برهای صفحه‌کلید.

### پیش‌نیازها

- Node.js نسخهٔ ۲۰ به بالا و npm
- [uv](https://docs.astral.sh/uv/) (مدیر بسته‌های پایتون)
- پایتون نسخهٔ ۳.۱۰ به بالا (که خود uv آن را مدیریت می‌کند)

### نصب

```bash
npm install       # نصب وابستگی‌های جاوااسکریپت
npm run setup     # ساخت backend/.venv و نصب pydantic-ai، fastapi و uvicorn
```

ورودی صوتی به مدلِ کاملاً محلیِ `faster-whisper` نیاز دارد (در پوشهٔ
`backend/whisper/`). اگر مدل هنوز روی دستگاه نیست، یک بار نصبش کنید:

```bash
npm run setup:voice     # دانلود مدل CTranslate2 "small" در backend/whisper/
```

### توسعه

```bash
npm run dev
```

با این دستور، پنجرهٔ Electron با رابطِ گرم (hot-reload) باز می‌شود. sidecar
پایتونی (FastAPI + Pydantic AI) به‌صورت خودکار روی یک پورت محلیِ موقت اجرا
می‌شود. در نسخهٔ بسته‌بندی‌شده نیز PATHِ رابط گرافیکی با PATHِ شلِ ورود ترکیب
می‌شود تا ابزارهایی مانند `docker` (که اتصال‌های MCP به آن نیاز دارند) پیدا شوند.

### ساخت و بسته‌بندی

```bash
npm run build       # typecheck + ساخت renderer، main و preload
npm run dist        # بسته‌بندی برای سیستم‌عاملِ فعلی (dmg/zip در مک، NSIS در ویندوز، AppImage در لینوکس)
npm run dist:mac    # فقط مک
npm run dist:win    # فقط ویندوز
npm run dist:linux  # فقط لینوکس
```

خروجی در پوشهٔ `release/` قرار می‌گیرد.

### کاربرد

۱. روی **باز کردن پوشه** کلیک کنید (یا کلید `Cmd/Ctrl+O`) و ریشهٔ پروژه را
   انتخاب کنید.
۲. تنظیمات را باز کنید (`Cmd/Ctrl+,`). فراهم‌کنندهٔ پیش‌فرض **opencode** است
   (`opencode/deepseek-v4-flash-free` از طریق OpenRouter). می‌توانید به
   OpenRouter، به یک APIِ سازگار با OpenAI یا به یک سرور محلی (Ollama /
   llama.cpp / vLLM) وصل شوید، کلید API و آدرس پایه (base URL) را وارد کنید و
   مدل را برگزینید.
۳. حالتِ عامل را انتخاب کنید: **پرسش**، **برنامه** یا **نویسندهٔ کد**.
۴. پیام خود را بنویسید و `Cmd/Ctrl+Enter` را بزنید. عامل پاسخ را به‌صورت
   زنده (استریم) نمایش می‌دهد و برای بررسی یا ویرایش فایل‌ها از ابزارهای
   sandbox شده بهره می‌گیرد. اگر دوست داشتید به جای تایپ، صحبت کنید، فقط
   دکمهٔ میکروفون را فشار دهید. در حالتِ برنامه، برنامهٔ نهایی در
   `~/.coder/plans/<workspace>/` ذخیره می‌شود.

### میان‌برهای صفحه‌کلید

| میان‌بر            | کارکرد                             |
| ------------------ | ---------------------------------- |
| `Cmd/Ctrl+Enter` | ارسال پیام گفتگو                   |
| `Cmd/Ctrl+M`     | چرخش میان حالت‌های عامل (پرسش / برنامه / نویسندهٔ کد) |
| `Cmd/Ctrl+P`     | جستجوی سریع و سریع‌باز کردن (⌘⇧F برای جستجوی محتوا) |
| `Cmd/Ctrl+B`     | نمایش/پنهان‌کردن نوار کناری        |
| `Cmd/Ctrl+,`     | باز کردن تنظیمات                   |
| `Cmd/Ctrl+S`     | ذخیرهٔ فایل جاری                   |
| `Cmd/Ctrl+T`     | گفتگوی تازه                        |

### معماری

```
┌───────────────────────────── Electron ─────────────────────────────┐
│ main.ts       پنجره، راه‌اندازی sidecar، IPC فایل،                    │
│               ذخیره‌سازی پیکربندی و گفتگوها                            │
│ preload.ts    contextBridge (دسترسی‌های کنترل‌شده)                     │
│ renderer      React + Monaco + گفتگو (SSE)                           │
└──────────────┬───────────────────────────▲──────────────────────────┘
               │ spawn / stdio              │ HTTP + SSE (127.0.0.1)
┌──────────────▼───────────────────────────┴──────────────────────────┐
│ ساید‌کار پایتون  (uv .venv)                                          │
│ server.py      FastAPI  /health  /models                            │
│                /chat/stream (SSE)  /fs                              │
│                /transcribe (Whisper)                                │
│ providers.py   → pydantic-ai OpenAIModel                            │
│ tools.py       ابزارهای امنِ فایل (sandbox)                          │
│ agents.py      عامل پرسش / برنامه / نویسندهٔ کد                        │
│                (مصرف زندهٔ بافت + فشرده‌سازی)                         │
└──────────────────────────────────────────────────────────────────────┘
```