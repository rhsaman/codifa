// Cross-platform updater asset-picking tests.
// Run: node test/updater-core.test.ts  (Node ≥23 strips TS types natively)
import { pickAsset, isNewer, parseVersion, assetSha256 } from '../src/lib/updater-core.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://example.com/${name}`,
  size: 1,
})

console.log('1) macOS — arm64:')
{
  const assets = [
    asset('Codifa-1.4.1-arm64.dmg'),
    asset('Codifa-1.4.1-arm64-mac.zip'),
    asset('Codifa-1.4.1-x64.dmg'),
    asset('Codifa-1.4.1-x64-mac.zip'),
  ]
  const picked = pickAsset(assets, 'darwin', 'arm64')
  check('دقیقاً -arm64.dmg انتخاب میشود', picked?.name === 'Codifa-1.4.1-arm64.dmg', picked)
}

console.log('2) macOS — x64 (نباید dmg اشتباه بگیرد):')
{
  const assets = [
    asset('Codifa-1.4.1-arm64.dmg'),
    asset('Codifa-1.4.1-x64.dmg'),
    asset('Codifa-1.4.1-x64-mac.zip'),
  ]
  const picked = pickAsset(assets, 'darwin', 'x64')
  check('دقیقاً -x64.dmg انتخاب میشود (نه arm64)', picked?.name === 'Codifa-1.4.1-x64.dmg', picked)
}

console.log('3) macOS — fallback به universal:')
{
  const assets = [asset('Codifa-1.4.1-arm64.dmg'), asset('Codifa-1.4.1-universal.dmg')]
  const picked = pickAsset(assets, 'darwin', 'x64')
  check('روی x64 به universal.dmg میرود', picked?.name === 'Codifa-1.4.1-universal.dmg', picked)
}

console.log('4) macOS — فقط zip موجود است:')
{
  const assets = [asset('Codifa-1.4.1-arm64-mac.zip')]
  const picked = pickAsset(assets, 'darwin', 'arm64')
  check('به -arm64-mac.zip میرود', picked?.name === 'Codifa-1.4.1-arm64-mac.zip', picked)
}

console.log('5) macOS — هیچ asset سازگاری نیست:')
{
  const picked = pickAsset([asset('Codifa-1.4.1-linux.AppImage')], 'darwin', 'arm64')
  check('null برمیگردد (نه دانلود اشتباه)', picked === null, picked)
}

console.log('6) Windows — NSIS Setup:')
{
  const assets = [asset('Codifa-1.4.1 Setup.exe'), asset('Codifa-1.4.1.exe.blockmap')]
  const picked = pickAsset(assets, 'win32', 'x64')
  check('Setup.exe انتخاب میشود', picked?.name === 'Codifa-1.4.1 Setup.exe', picked)
}

console.log('7) Windows — فقط portable:')
{
  const assets = [asset('Codifa-1.4.1-portable.exe')]
  const picked = pickAsset(assets, 'win32', 'x64')
  check('به هر .exe میرود', picked?.name === 'Codifa-1.4.1-portable.exe', picked)
}

console.log('8) Windows — بدون exe:')
{
  const picked = pickAsset([asset('Codifa-1.4.1.dmg')], 'win32', 'x64')
  check('null برمیگردد', picked === null, picked)
}

console.log('9) Linux — AppImage (نه deb):')
{
  const assets = [asset('Codifa-1.4.1.AppImage'), asset('codifa_1.4.1_amd64.deb')]
  const picked = pickAsset(assets, 'linux', 'x64')
  check('AppImage انتخاب میشود', picked?.name === 'Codifa-1.4.1.AppImage', picked)
}

console.log('10) Linux — فقط deb:')
{
  const picked = pickAsset([asset('codifa_1.4.1_amd64.deb')], 'linux', 'x64')
  check('null برمیگردد (deb نیاز به sudo دارد)', picked === null, picked)
}

console.log('11) مقایسه نسخه (isNewer(current, candidate) — قرینه‌ی commands.rs):')
check('1.5.0 > 1.4.1', isNewer('1.4.1', '1.5.0') === true)
check('v1.4.1 با 1.4.1 برابر → false', isNewer('1.4.1', 'v1.4.1') === false)
check('1.4.1 < 1.4.2 → false', isNewer('1.4.2', '1.4.1') === false)
check('1.4.10 > 1.4.9 (عددی، نه متنی)', isNewer('1.4.9', '1.4.10') === true)
check('parseVersion پیشوند v را حذف میکند', JSON.stringify(parseVersion('v1.2.3').nums) === JSON.stringify([1, 2, 3]))

console.log('12) prerelease — فقط به بیلدهای prerelease پیشنهاد می‌شود:')
check('کاربر stable نباید RC ببیند (2.1.0-rc1 برای 2.0.2)', isNewer('2.0.2', '2.1.0-rc1') === false)
check('نسخه نهایی از rc خودش جلوتر است', isNewer('2.1.0-rc1', '2.1.0') === true)
check('rc → نسخه نهایی هم‌بیس همیشه آپدیت است', isNewer('2.1.0-rc1', '2.1.0') === true)
check('prerelease → base بالاتر prerelease پیشنهاد می‌شود', isNewer('2.1.0-rc1', '2.2.0-rc1') === true)
check('rc10 > rc9 (عددی، نه متنی)', isNewer('2.1.0-rc9', '2.1.0-rc10') === true)
check('rc9 از rc10 عقب است', isNewer('2.1.0-rc10', '2.1.0-rc9') === false)
check('تگ بدون عدد (nightly) هرگز نمی‌برد', isNewer('2.0.1', 'nightly') === false)

console.log('13) assetSha256 — هر دو شکل فید، و هش خراب رد می‌شود:')
check(
  'digest گیت‌هاب (sha256:hex) استخراج می‌شود',
  assetSha256({ name: 'a.dmg', browser_download_url: '', size: 0, digest: 'sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789' }) ===
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
)
check(
  'sha256 فید سایت استخراج می‌شود',
  assetSha256({ name: 'a.exe', browser_download_url: '', size: 0, sha256: 'aabbCCDDEEFF00112233445566778899aabbccddeeff00112233445566778899' }) ===
    'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
)
check('هش ناقص = بدون پین', assetSha256({ name: 'a', browser_download_url: '', size: 0, digest: 'sha256:deadbeef' }) === null)
check('بدون hash = بدون پین', assetSha256({ name: 'a', browser_download_url: '', size: 0 }) === null)

if (failed > 0) {
  console.error(`\n${failed} تست FAILED`)
  process.exit(1)
}
console.log('\nهمه تستهای updater-core پاس شدند ✅')