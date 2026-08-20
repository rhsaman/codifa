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

rm -f test/.tmp-fork.mjs test/.tmp-rm.mjs test/.tmp-ls.mjs test/.tmp-retry.mjs test/.tmp-cw.mjs test/.tmp-hb.mjs test/.tmp-scroll.mjs
echo ""
echo "✅ همه تستهای فرانتاند پاس شدند"