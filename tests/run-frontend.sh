#!/usr/bin/env bash
# Frontend sanity tests for the reading-mode / section-chat feature.
# Run: npm run test:frontend
set -e
cd "$(dirname "$0")/.."

echo "── تست ۱: splitSections (منطق بخشبندی) ──"
node tests/sections.test.ts

echo ""
echo "── تست ۲: forkSection (ساخت چت جدید با زمینه بخش) ──"
npx esbuild tests/forkSection.test.ts --bundle --platform=node --format=esm \
  --outfile=tests/.tmp-fork.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-fork.mjs

echo ""
echo "── تست ۳: ReadingMode (رندر SSR مودال) ──"
npx esbuild tests/readingMode.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
  --outfile=tests/.tmp-rm.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-rm.mjs

echo ""
echo "── تست ۴: LoadingScreen (حالت خطا و Retry) ──"
npx esbuild tests/loadingScreen.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --outfile=tests/.tmp-ls.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-ls.mjs

echo ""
echo "── تست ۵: updater-core (انتخاب asset اپدیت در همه OS ها) ──"
node tests/updater-core.test.ts

echo ""
echo "── تست ۶: retry logic (تصمیم restart/resume + گاردها) ──"
node tests/retry.test.ts

echo ""
echo "── تست ۷: retry store (پاک کردن زیر پیام + حفظ partial و tool call ها) ──"
npx esbuild tests/retryStore.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-retry.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-retry.mjs

echo ""
echo "── تست ۷ب: resetStreamForRetry (پاک‌کردن متن نیمه‌کاره روی retry، حفظ tool/user) ──"
npx esbuild tests/retryStream.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-rs.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-rs.mjs

echo ""
echo "── تست ۸: context_window (پنجرهٔ مخصوص مدل به بکاند، نه پنجرهٔ کلی پرووایدر) ──"
npx esbuild tests/contextWindow.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-cw.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-cw.mjs

echo ""
echo "── تست ۹: persist heartbeat (ذخیرهٔ میان-استریم + تریم toolActivity + flag interrupted) ──"
npx esbuild tests/persistHeartbeat.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-hb.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-hb.mjs

echo ""
echo "── تست ۱۰: scrollPos (ذخیرهٔ دقیق موقعیت اسکرول + بدون reorder + ماندن در snapshot) ──"
npx esbuild tests/scrollPos.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-scroll.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-scroll.mjs

echo ""
echo "── تست ۱۱: scrollPadding (فاصلهٔ پایین اسکرول برای کامپوزر شناور + کارت‌های ask/perm) ──"
npx esbuild tests/scrollPadding.test.ts --bundle --platform=node --format=esm \
  --packages=external --outfile=tests/.tmp-sp.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-sp.mjs

echo ""
echo "── تست ۱۲: usageContext (مصرف واقعی هر مدل در ستون کناری + پنجره/درصد کانتکست در نوار بالا) ──"
npx esbuild tests/usageContext.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-uc.mjs >/dev/null 2>&1
node tests/.tmp-uc.mjs

echo ""
echo "── تست ۱۳: contextUsed (نوار بالا: مجموع توکنِ آخرین پیام دستیار = input+output+cache، مثل overflow.ts در opencode) ──"
npx esbuild tests/contextUsed.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-cu.mjs >/dev/null 2>&1
node tests/.tmp-cu.mjs

echo ""
echo "── تست ۱۴: link (هدایت لینک‌های خارجی به مرورگر سیستم) ──"
node tests/link.test.ts

echo ""
echo "── تست ۱۵: skills (استخراج منشن @slug اسکیل + سازگاری نام نمایشی) ──"
npx esbuild tests/skills.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-skills.mjs >/dev/null 2>&1
node tests/.tmp-skills.mjs

echo ""
echo "── تست ۱۶: skills cache (رفرش لیست پس از ذخیره/حذف اسکیل) ──"
npx esbuild tests/skillsCache.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-skillsCache.mjs >/dev/null 2>&1
node tests/.tmp-skillsCache.mjs

echo ""
echo "── تست ۱۷: thinking (شناسایی مدل‌های reasoning مثل hy3-free برای فعال‌سازی قرص و reasoning_effort) ──"
node tests/thinking.test.ts

echo ""
echo "── تست ۱۸: ensureSidecar (health-check قبل از کش + restart خودکار هنگام مرگ سرور) ──"
npx esbuild tests/ensureSidecar.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-es.mjs >/dev/null 2>&1
node tests/.tmp-es.mjs

echo ""
echo "── تست ۱۹: transcribeAudio (throw کردن detail سرور روی ۵۰۰ + برگرداندن متن روی ۲۰۰) ──"
npx esbuild tests/transcribe.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-tr.mjs >/dev/null 2>&1
node tests/.tmp-tr.mjs

echo ""
echo "── تست ۲۰: voice auto-send (اولین Space/Enter بعد از ترانسکریپشن پیام را می‌فرستد) ──"
node tests/voice.test.ts

echo ""
echo "── تست ۲۱: web results (نمایش لینک‌های web_search در UI) ──"
npx esbuild tests/webResults.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --outfile=tests/.tmp-wr.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-wr.mjs

echo ""
echo "── تست ۲۱ب: engine badge (badge تم‌محور نام پروایدر وب‌سرچ) ──"
npx esbuild tests/engineBadge.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --outfile=tests/.tmp-eb.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-eb.mjs

echo ""
echo "── تست ۲۲: RetryBanner (نوتیفیکیشن خطای یکدست: stalled + rate-limit + gave-up) ──"
npx esbuild tests/retryBanner.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
  --outfile=tests/.tmp-rb.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-rb.mjs

echo ""
echo "── تست ۲۳: streamChat reconnect (لایهٔ خودترمیم روی SSE: خطای اتصال/وسط استریم retry، قطع دستی/HTTP خیر) ──"
npx esbuild tests/streamChatReconnect.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-sc.mjs >/dev/null 2>&1
node tests/.tmp-sc.mjs

echo ""
echo "── تست ۲۴: ThinkingIndicator (۳ نقطه لودینگ به‌جای ✦ + نمایش در فوتر پیام) ──"
npx esbuild tests/thinkingIndicator.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
  --outfile=tests/.tmp-ti.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-ti.mjs

echo ""
echo "── تست ۲۵: contextBudget (سوییچ mode کانتکست را کم نمی‌کند + هیچ پیامی هر turn ریخته نمی‌شود، مثل opencode) ──"
npx esbuild tests/contextBudget.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-cb.mjs >/dev/null 2>&1
node tests/.tmp-cb.mjs

echo ""
echo "── تست ۲۶: compactChat (فولد پیام‌های قدیمی + افزودن خلاصه در انتها + فولد خلاصهٔ قبلی) ──"
npx esbuild tests/compactChat.test.ts --bundle --platform=node --format=esm \
  --packages=external --external:electron --outfile=tests/.tmp-cc.mjs >/dev/null 2>&1
node tests/.tmp-cc.mjs

echo ""
echo "── تست ۲۷: Sidebar (هدر یکپارچه: سرچ بالا + دکمهٔ فشرده) ──"
npx esbuild tests/sidebar.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
  --alias:src/lib/store=./src/lib/store \
  --outfile=tests/.tmp-sb.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-sb.mjs

echo ""
echo "── تست ۲۸: usage key (کلید صریح providerId/model + استخراج مستقیم پرووایدر بدون scoring) ──"
node tests/usage.test.ts

echo ""
echo "── تست ۲۹: bidi (ایزوله‌کردن برچسب‌های فارسی/انگلیسی مخلوط در نمودار Mermaid) ──"
node tests/bidi.test.ts

echo ""
echo "── تست ۳۰: کنتراست هایلایت diff (متن هایلایت نباید به --on-accent فال‌بک دهد) ──"
node tests/diffContrast.test.ts

echo ""
echo "── تست ۳۱: Settings → Storage (Data & maintenance + TTL وب/fetch جداگانه) ──"
npx esbuild tests/settingsStorage.ssr.test.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --packages=external \
  --alias:highlight.js/styles/github-dark.min.css=./tests/css-stub.js \
  --outfile=tests/.tmp-set.mjs --external:electron >/dev/null 2>&1
node tests/.tmp-set.mjs

echo ""
echo "── تست ۳۲: نست شدن sub-event زیر کارت task (حتی وقتی کارت done است) ──"
npx esbuild tests/toolNesting.test.ts --bundle --platform=node --format=esm \
  --outfile=tests/.tmp-tn.mjs >/dev/null 2>&1
node tests/.tmp-tn.mjs

echo ""
echo "── تست ۳۳: watchdog tool-counter (شمارنده به‌جای boolean برای tool موازی) ──"
node tests/watchdog.test.ts

rm -f tests/.tmp-fork.mjs tests/.tmp-es.mjs tests/.tmp-rm.mjs tests/.tmp-ls.mjs tests/.tmp-retry.mjs tests/.tmp-cw.mjs tests/.tmp-hb.mjs tests/.tmp-scroll.mjs tests/.tmp-sp.mjs tests/.tmp-uc.mjs tests/.tmp-cu.mjs tests/.tmp-skills.mjs tests/.tmp-skillsCache.mjs tests/.tmp-tr.mjs tests/.tmp-wr.mjs tests/.tmp-eb.mjs tests/.tmp-rb.mjs tests/.tmp-sc.mjs tests/.tmp-ti.mjs tests/.tmp-cb.mjs tests/.tmp-sb.mjs tests/.tmp-cc.mjs tests/.tmp-set.mjs tests/.tmp-rs.mjs tests/.tmp-tn.mjs
echo ""
echo "✅ همه تستهای فرانتاند پاس شدند"
