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

If you just want to run Codifa — not build it — grab the installer. Codifa is
**not signed with an Apple Developer ID**, so macOS quarantines the downloaded
image and refuses the first launch with _"Codifa is damaged and can't be
opened"_ or _"Apple could not verify…"_. The installer clears that flag for you.

**Option A — one-command install (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash
```

It downloads the latest release, verifies the app's code signature, clears the
quarantine attribute and copies the app into `/Applications`. Every step is
printed so you can read what happened. To install a specific release, pass the
tag:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash -s -- v1.7.0
```

**Option B — manual install:**

1. Download the `.dmg` from the [latest release](https://github.com/rhsaman/codifa/releases/latest) and drag **Codifa** into `/Applications`.
2. Clear the quarantine flag, or macOS will refuse to open it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Codifa.app
   ```

3. Open Codifa from `/Applications`. If macOS still blocks it, go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Requirements:** macOS 13.4 or newer, Apple Silicon. There is no Intel macOS
build; the installer refuses to run on one rather than install a binary the CPU
cannot execute.

**Permissions:** Codifa asks for the microphone (voice input) and screen
recording (Computer Use). Grant them in **System Settings → Privacy & Security**;
because the app is not notarized, you may need to toggle them off and on once
and relaunch the app after an update.

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

اگر فقط می‌خواهید Codifa را اجرا کنید، همان نصب‌کننده را بردارید. Codifa با
**گواهی Developer ID اپل امضا نشده است**، بنابراین مک فایل دانلودشده را
قرنطینه می‌کند و اجرای اول با پیام _«Codifa خراب است و باز نمی‌شود»_ یا
_«اپل نتوانست تأیید کند…»_ رد می‌شود. اسکریپت نصب این فلگ را برایتان پاک
می‌کند.

**راه ۱ — نصب با یک دستور (پیشنهادی):**

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash
```

آخرین نسخه را دانلود می‌کند، امضای کد اپ را بررسی می‌کند، فلگ قرنطینه را پاک
می‌کند و اپ را در `/Applications` می‌گذارد. هر گام چاپ می‌شود تا ببینید چه
اتفاقی افتاده است. برای نصب یک نسخهٔ مشخص، تگ را بدهید:

```bash
curl -fsSL https://raw.githubusercontent.com/rhsaman/codifa/main/scripts/install-macos.sh | bash -s -- v1.7.0
```

**راه ۲ — نصب دستی:**

۱. فایل `.dmg` را از [آخرین نسخه](https://github.com/rhsaman/codifa/releases/latest) دانلود کنید و **Codifa** را به `/Applications` بکشید.
۲. فلگ قرنطینه را پاک کنید، وگرنه مک از باز کردن آن سرباز می‌زند:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Codifa.app
   ```

۳. Codifa را از `/Applications` باز کنید. اگر مک باز هم مسدود کرد، به **System Settings → Privacy & Security** بروید و **Open Anyway** را بزنید.

**پیش‌نیاز:** مک‌اواس ۱۳.۴ یا بالاتر، اپل سیلیکون. نسخهٔ اینتل برای مک وجود
ندارد و اسکریپت نصب روی مک اینتل اجرا نمی‌شود تا باینری‌ای نصب نکند که
پردازنده نمی‌تواند اجرا کند.

**مجوزها:** Codifa میکروفون (ورودی صوتی) و ضبط صفحه (Computer Use) را می‌خواهد.
آن‌ها را در **System Settings → Privacy & Security** بدهید؛ چون اپ notarize
نشده است، ممکن است لازم باشد بعد از هر به‌روزرسانی آن‌ها را یک‌بار خاموش و
روشن کنید و اپ را دوباره باز کنید.

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
