import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const PRODUCT = (process.env.npm_package_productName) || 'Codifa'

export default async function afterSign(context) {
  const { appOutDir, packager } = context
  const productName = packager?.appInfo?.productFilename || PRODUCT
  const appPath = join(appOutDir, `${productName}.app`)

  if (!existsSync(appPath)) {
    console.error('ad-hoc-sign: app bundle not found, skipping')
    return
  }

  const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

  try {
    run(`xattr -cr "${appPath}" 2>/dev/null || true`)
    run(`codesign --force --deep --sign - "${appPath}"`)
    run(`codesign --verify --deep --strict --verbose=1 "${appPath}"`)
    console.log(`ad-hoc-sign: signed ${appPath}`)
  } catch (err) {
    console.error('ad-hoc-sign: signing failed', err.message)
    process.exit(1)
  }
}
