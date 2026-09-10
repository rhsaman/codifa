#!/bin/bash
# دانلود مقاوم باینری Electron به‌صورت تکه‌تکه (chunked) با Range requests.
# علت: curl با resume در این شبکه گاهی فایل را truncate می‌کند؛ دانلود هر
# تکه‌ی ۸MB در فایل جداگانه این مشکل را حذف می‌کند — retry فقط همان تکه را
# دوباره می‌گیرد و تکه‌های کامل‌شده دست‌نخورده می‌مانند.
set -u
URL="${ELECTRON_URL:-https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-darwin-arm64.zip}"
TOTAL=96569232
CHUNK=8388608  # 8MB
DIR=/tmp/el-chunks
mkdir -p "$DIR"
N=$(( (TOTAL + CHUNK - 1) / CHUNK ))
fetch_chunk() {
  local i=$1
  local start=$(( i * CHUNK ))
  local end=$(( start + CHUNK - 1 ))
  [ $end -ge $TOTAL ] && end=$(( TOTAL - 1 ))
  local out="$DIR/chunk-$i"
  local want=$(( end - start + 1 ))
  # از قبل کامل است؟
  [ -f "$out" ] && [ "$(stat -f %z "$out")" -eq "$want" ] && return 0
  for try in 1 2 3 4 5 6 7 8 9 10; do
    curl -sL --fail --max-time 240 --speed-limit 2048 --speed-time 30 \
      -H "Range: bytes=$start-$end" -o "$out" "$URL" \
      && [ "$(stat -f %z "$out" 2>/dev/null || echo 0)" -eq "$want" ] && return 0
    rm -f "$out"
    sleep 2
  done
  return 1
}
# موج ۱: تکه‌های ۰، ۳، ۶، ... (هر بار ۳ اتصال موازی)
# موج ۲: تکه‌های ۱، ۴، ۷، ...
# موج ۳: تکه‌های ۲، ۵، ۸، ...
for off in 0 1 2; do
  pids=()
  for (( i=off; i<N; i+=3 )); do
    fetch_chunk "$i" &
    pids+=($!)
  done
  fail=0
  for p in "${pids[@]}"; do wait "$p" || fail=1; done
  [ $fail -eq 1 ] && { echo "FAILED" > /tmp/el-dl.done; exit 1; }
done
# الحاق تکه‌ها
cat "$DIR"/chunk-* > /tmp/el.zip 2>/dev/null
# مرتب‌سازی صریح تکه‌ها (glob مرتب نیست برای اعداد بالای ۹)
rm -f /tmp/el.zip
for (( i=0; i<N; i++ )); do cat "$DIR/chunk-$i" >> /tmp/el.zip; done
[ "$(stat -f %z /tmp/el.zip)" -eq "$TOTAL" ] && { echo "OK" > /tmp/el-dl.done; exit 0; }
echo "FAILED" > /tmp/el-dl.done
exit 1
