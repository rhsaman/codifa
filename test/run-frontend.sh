#!/usr/bin/env bash
# Frontend sanity tests for the reading-mode / section-chat feature.
# Run: npm run test:frontend
set -e
cd "$(dirname "$0")/.."

echo "── تست ۱: splitSections (منطق بخشبندی) ──"
node test/sections.test.ts

echo ""
echo "── تست ۲: forkSection (ساخت چت جدید با زمینه بخش) ──"
npx esbuild test/forkSection.test.ts --bundle --platform=node --format=esm \
  --outfile=test/.tmp-fork.mjs --external:electron >/dev/null 2>&1
node test/.tmp-fork.mjs

echo ""
echo "── تست ۳: ReadingMode (رندر SSR مودال) ──"
npx esbuild test/readingMode.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./test/css-stub.js \
  --outfile=test/.tmp-rm.mjs --external:electron >/dev/null 2>&1
node test/.tmp-rm.mjs

echo ""
echo "── تست ۴: LoadingScreen (حالت خطا و Retry) ──"
npx esbuild test/loadingScreen.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --outfile=test/.tmp-ls.mjs --external:electron >/dev/null 2>&1
node test/.tmp-ls.mjs

echo ""
echo "── تست ۵: updater-core (انتخاب asset اپدیت در همه OS ها) ──"
node test/updater-core.test.ts

echo ""
echo "── تست ۶: retry logic (تصمیم restart/resume + گاردها) ──"
node test/retry.test.ts

echo ""
echo "── تست ۷: retry store (پاک کردن زیر پیام + حفظ partial و tool call ها) ──"
npx esbuild test/retryStore.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=test/.tmp-retry.mjs --external:electron >/dev/null 2>&1
node test/.tmp-retry.mjs

echo ""
echo "── تست ۸: context_window (پنجرهٔ مخصوص مدل به بکاند، نه پنجرهٔ کلی پرووایدر) ──"
npx esbuild test/contextWindow.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=test/.tmp-cw.mjs --external:electron >/dev/null 2>&1
node test/.tmp-cw.mjs

echo ""
echo "── تست ۹: persist heartbeat (ذخیرهٔ میان-استریم + تریم toolActivity + flag interrupted) ──"
npx esbuild test/persistHeartbeat.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=test/.tmp-hb.mjs --external:electron >/dev/null 2>&1
node test/.tmp-hb.mjs

echo ""
echo "── تست ۱۰: scrollPos (ذخیرهٔ دقیق موقعیت اسکرول + بدون reorder + ماندن در snapshot) ──"
npx esbuild test/scrollPos.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=test/.tmp-scroll.mjs --external:electron >/dev/null 2>&1
node test/.tmp-scroll.mjs

echo ""
echo "── تست ۱۱: scrollPadding (فاصلهٔ پایین اسکرول برای کامپوزر شناور + کارت‌های ask/perm) ──"
npx esbuild test/scrollPadding.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=test/.tmp-sp.mjs --external:electron >/dev/null 2>&1
node test/.tmp-sp.mjs

echo ""
echo "── تست ۱۲: usageContext (مصرف واقعی هر مدل در ستون کناری + پنجره/درصد کانتکست در نوار بالا) ──"
npx esbuild test/usageContext.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-uc.mjs >/dev/null 2>&1
node test/.tmp-uc.mjs

echo ""
echo "── تست ۱۳: contextUsed (نوار بالا: مجموع توکنِ آخرین پیام دستیار = input+output+cache، مثل overflow.ts در opencode) ──"
npx esbuild test/contextUsed.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-cu.mjs >/dev/null 2>&1
node test/.tmp-cu.mjs

echo ""
echo "── تست ۱۴: link (هدایت لینک‌های خارجی به مرورگر سیستم) ──"
node test/link.test.ts

echo ""
echo "── تست ۱۵: skills (استخراج منشن @slug اسکیل + سازگاری نام نمایشی) ──"
npx esbuild test/skills.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-skills.mjs >/dev/null 2>&1
node test/.tmp-skills.mjs

echo ""
echo "── تست ۱۶: skills cache (رفرش لیست پس از ذخیره/حذف اسکیل) ──"
npx esbuild test/skillsCache.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-skillsCache.mjs >/dev/null 2>&1
node test/.tmp-skillsCache.mjs

echo ""
echo "── تست ۱۷: thinking (شناسایی مدل‌های reasoning مثل hy3-free برای فعال‌سازی قرص و reasoning_effort) ──"
node test/thinking.test.ts

echo ""
echo "── تست ۱۸: ensureSidecar (health-check قبل از کش + restart خودکار هنگام مرگ سرور) ──"
npx esbuild test/ensureSidecar.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-es.mjs >/dev/null 2>&1
node test/.tmp-es.mjs

echo ""
echo "── تست ۱۹: transcribeAudio (throw کردن detail سرور روی ۵۰۰ + برگرداندن متن روی ۲۰۰) ──"
npx esbuild test/transcribe.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-tr.mjs >/dev/null 2>&1
node test/.tmp-tr.mjs

echo ""
echo "── تست ۲۰: voice auto-send (اولین Space/Enter بعد از ترانسکریپشن پیام را می‌فرستد) ──"
node test/voice.test.ts

echo ""
echo "── تست ۲۱: web results (نمایش لینک‌های web_search در UI) ──"
npx esbuild test/webResults.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --outfile=test/.tmp-wr.mjs --external:electron >/dev/null 2>&1
node test/.tmp-wr.mjs

echo ""
echo "── تست ۲۲: RetryBanner (نوتیفیکیشن خطای یکدست: stalled + rate-limit + gave-up) ──"
npx esbuild test/retryBanner.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./test/css-stub.js \
  --outfile=test/.tmp-rb.mjs --external:electron >/dev/null 2>&1
node test/.tmp-rb.mjs

echo ""
echo "── تست ۲۳: streamChat reconnect (لایهٔ خودترمیم روی SSE: خطای اتصال/وسط استریم retry، قطع دستی/HTTP خیر) ──"
npx esbuild test/streamChatReconnect.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-sc.mjs >/dev/null 2>&1
node test/.tmp-sc.mjs

echo ""
echo "── تست ۲۴: ThinkingIndicator (۳ نقطه لودینگ به‌جای ✦ + نمایش در فوتر پیام) ──"
npx esbuild test/thinkingIndicator.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./test/css-stub.js \
  --outfile=test/.tmp-ti.mjs --external:electron >/dev/null 2>&1
node test/.tmp-ti.mjs

echo ""
echo "── تست ۲۵: contextBudget (سوییچ mode کانتکست را کم نمی‌کند + هیچ پیامی هر turn ریخته نمی‌شود، مثل opencode) ──"
npx esbuild test/contextBudget.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=test/.tmp-cb.mjs >/dev/null 2>&1
node test/.tmp-cb.mjs

echo ""
echo "── تست ۲۶: Sidebar (هدر یکپارچه: سرچ بالا + دکمهٔ فشرده) ──"
npx esbuild test/sidebar.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./test/css-stub.js \
  --alias:../src/lib/store=./test/sidebar-store-stub.ts \
  --outfile=test/.tmp-sb.mjs --external:electron >/dev/null 2>&1
node test/.tmp-sb.mjs

rm -f test/.tmp-fork.mjs test/.tmp-es.mjs test/.tmp-rm.mjs test/.tmp-ls.mjs test/.tmp-retry.mjs test/.tmp-cw.mjs test/.tmp-hb.mjs test/.tmp-scroll.mjs test/.tmp-sp.mjs test/.tmp-uc.mjs test/.tmp-cu.mjs test/.tmp-skills.mjs test/.tmp-skillsCache.mjs test/.tmp-tr.mjs test/.tmp-wr.mjs test/.tmp-rb.mjs test/.tmp-sc.mjs test/.tmp-ti.mjs test/.tmp-cb.mjs test/.tmp-sb.mjs
echo ""
echo "✅ همه تستهای فرانتاند پاس شدند"
