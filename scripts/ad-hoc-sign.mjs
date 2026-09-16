import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const PRODUCT = (process.env.npm_package_productName) || 'Codifa'
const STABLE_IDENTITY = 'Coder Dev Signing'

function hasStableIdentity() {
  try {
    const out = execSync('security find-identity -v -p codesigning').toString()
    return out.includes(STABLE_IDENTITY)
  } catch {
    return false
  }
}

export default async function afterSign(context) {
  const { appOutDir, packager } = context
  const productName = packager?.appInfo?.productFilename || PRODUCT
  const appPath = join(appOutDir, `${productName}.app`)

  if (!existsSync(appPath)) {
    console.error('ad-hoc-sign: app bundle not found, skipping')
    return
  }

  const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
  const stable = hasStableIdentity()
  const signIdentity = stable ? STABLE_IDENTITY : '-'

  try {
    run(`xattr -cr "${appPath}" 2>/dev/null || true`)
    run(`codesign --force --deep --sign "${signIdentity}" "${appPath}"`)
    run(`codesign --verify --deep --strict --verbose=1 "${appPath}"`)

    if (stable) {
      console.log(`ad-hoc-sign: signed ${appPath} with stable identity "${STABLE_IDENTITY}" — مجوز Accessibility بین بیلدها حفظ می‌شود.`)
    } else {
      console.warn(`ad-hoc-sign: identity "${STABLE_IDENTITY}" در Keychain پیدا نشد — با ad-hoc امضا شد.`)
      console.warn(`یعنی مجوز Accessibility این بار هم باطل می‌شود. برای ثابت‌شدن همیشگی، یک‌بار در Keychain Access یک certificate از نوع Code Signing / Self Signed Root با همین نام "${STABLE_IDENTITY}" بساز.`)
    }
  } catch (err) {
    console.error('ad-hoc-sign: signing failed', err.message)
    process.exit(1)
  }
}
