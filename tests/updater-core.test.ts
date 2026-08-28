// Cross-platform updater asset-picking tests.
// Run: node test/updater-core.test.ts  (Node ≥23 strips TS types natively)
import { pickAsset, isNewer, parseVersion } from '../electron/updater-core.ts'

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

console.log('11) مقایسه نسخه:')
check('1.5.0 > 1.4.1', isNewer('1.5.0', '1.4.1') === true)
check('v1.4.1 با 1.4.1 برابر → false', isNewer('v1.4.1', '1.4.1') === false)
check('1.4.1 < 1.4.2 → false', isNewer('1.4.1', '1.4.2') === false)
check('1.4.10 > 1.4.9 (عددی، نه متنی)', isNewer('1.4.10', '1.4.9') === true)
check('parseVersion پیشوند v را حذف میکند', JSON.stringify(parseVersion('v1.2.3')) === JSON.stringify([1, 2, 3]))

if (failed > 0) {
  console.error(`\n${failed} تست FAILED`)
  process.exit(1)
}
console.log('\nهمه تستهای updater-core پاس شدند ✅')