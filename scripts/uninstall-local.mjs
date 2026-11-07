/**
 * Remove this plugin from a local DSH profile.
 *
 *   node scripts/uninstall-local.mjs [--profile-dir <dir>] [--profile <name>]
 *                                    [--dsh-home <dir>] [--backup-dir <dir>]
 *
 * Restores the newest snapshot written by install-local.mjs when one exists,
 * then strips the dependency / bundle selection / duplicate loader row and
 * reinstalls the profile. Review data under `$DSH_HOME/article-annotator` is
 * intentionally kept; delete it by hand if the annotations and the writing
 * style memory are no longer wanted.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-article-annotator'
const FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml']

function parseArgs(argv) {
  const args = { profile: 'desktop' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (argv[i] === undefined) throw new Error(arg + ' 需要一个值')
      return argv[i]
    }
    if (arg === '--profile-dir') args.profileDir = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--dsh-home') args.dshHome = next()
    else if (arg === '--backup-dir') args.backupDir = next()
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error('未知参数：' + arg)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node scripts/uninstall-local.mjs [--profile-dir <dir>] [--profile desktop] [--dsh-home <dir>] [--backup-dir <dir>]')
  process.exit(0)
}
const dshHome = resolve(args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const PROFILE = args.profileDir !== undefined ? resolve(args.profileDir) : join(dshHome, 'profiles', args.profile)
const BACKUP_ROOT = args.backupDir !== undefined ? resolve(args.backupDir) : join(PLUGIN, '.profile-backups')

function latestBackup() {
  if (!existsSync(BACKUP_ROOT)) return null
  const entries = readdirSync(BACKUP_ROOT)
    .filter((name) => name.startsWith('profile-'))
    .sort()
  return entries.length === 0 ? null : join(BACKUP_ROOT, entries[entries.length - 1])
}

const backup = latestBackup()
if (backup !== null) {
  console.log('restoring profile files from ' + backup)
  for (const name of FILES) {
    const saved = join(backup, name)
    if (existsSync(saved)) copyFileSync(saved, join(PROFILE, name))
  }
} else {
  console.log('no install snapshot found; removing the plugin from the profile manifest directly')
}

const pkgPath = join(PROFILE, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('profile not found: ' + PROFILE)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (pkg.dependencies) delete pkg.dependencies[PACKAGE_NAME]
if (Array.isArray(pkg.dsh?.profile?.bundles)) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME)
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const patchPath = join(PROFILE, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  let patch = readFileSync(patchPath, 'utf8')
  patch = patch.replace(/\n(?:#[^\n]*\n)?- insert:\n\s+- id: article-annotator\n\s+name: dsh-article-annotator\n/u, '\n')
  if (!/(^|\n)- /u.test(patch)) patch = patch.replace(/\n{3,}/gu, '\n\n').trimEnd() + '\n[]\n'
  writeFileSync(patchPath, patch, 'utf8')
}

const linked = join(PROFILE, 'node_modules', PACKAGE_NAME)
if (existsSync(linked)) rmSync(linked, { recursive: true, force: true })

const result = spawnSync('pnpm', ['install', '--ignore-scripts'], { cwd: PROFILE, stdio: 'inherit', shell: process.platform === 'win32' })
if (result.error !== undefined) {
  console.error('无法运行 pnpm：' + result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error('pnpm install 退出码 ' + result.status + '；重启 DSH 前请检查 profile')
  process.exit(result.status ?? 1)
}
console.log(PACKAGE_NAME + ' 已从 ' + PROFILE + ' 移除。重启 DSH 生效。')
