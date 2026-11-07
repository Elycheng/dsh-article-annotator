/** One-off: drop the pre-rename package from the local desktop profile. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.argv[2]
if (!PROFILE) throw new Error('usage: node _profile-migrate.mjs <profile-dir>')
const OLD = 'dsh-article-review'
const pkgPath = join(PROFILE, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (pkg.dependencies && OLD in pkg.dependencies) {
  delete pkg.dependencies[OLD]
  console.log('removed dependency ' + OLD)
}
if (Array.isArray(pkg.dsh?.profile?.bundles)) {
  const before = pkg.dsh.profile.bundles.length
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== OLD)
  if (pkg.dsh.profile.bundles.length !== before) console.log('removed bundle selection ' + OLD)
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
const linked = join(PROFILE, 'node_modules', OLD)
if (existsSync(linked)) {
  rmSync(linked, { recursive: true, force: true })
  console.log('removed node_modules link ' + OLD)
}
