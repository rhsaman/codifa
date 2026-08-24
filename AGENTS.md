pyproject is contain backend with python and front end with electron and react in src/.
for front end tests must be in test/ and for backend must be in backend/test
for python in backend/ must use uv dont use pip, dont install new package without permission.
my python pakcages is in pyproject.toml.
for installing package for python must use uv add <package name>, dont use uv pip install.

## Context-First
قبل از هر ابزار جستجو، چک کن چه اطلاعاتی از قبل در context هست (RAG/حافظه/پرامپت/فایل‌هایی که
خودت خوانده‌ای). اگر جواب در دسترس است، دوباره جستجو نزن. اطلاعات پروژه را از قبل
در context لود شده بدان، نه چیزی که باید هر بار کاوش شود.

## Search Strategy (همیشه رعایت شود)
۱. TARGETED: برای پیدا کردن فایل/تابع/کلمهٔ مشخص، مستقیم با grep/glob/read جستجو کن.
۲. BROAD: برای کاوش چندفایله و وسیع، از subagent تخصصی استفاده کن:
   task(subagent_type='explore') — در context ایزوله اجرا می‌شود و فقط گزارش فشرده برمی‌گرداند.
۳. همیشه grep را با include/path محدود کن (مثلاً include='*.tsx') تا نتایج بی‌استفاده برنگردد.
۴. جستجوهای مستقل را در یک turn موازی (parallel) بزن.
۵. وقتی فایل کلیدی را پیدا کردی، مستقیم بخوان؛ دوباره دنبالش نگرد.

## مثال
❌ بد: grep('plan') بدون محدودیت → ۲۰۰ match در node_modules و فایل‌های غیرمرتبط.
✅ خوب: grep('kind: .plan.', include='*.tsx', path='src/') → فقط نتایج مرتبط.
❌ بد: تکرار همان جستجو با کلمات مختلف («بذار ببینم…»).
✅ خوب: یک بار grep دقیق + واگذاری کاوش وسیع به task(subagent_type='explore').
