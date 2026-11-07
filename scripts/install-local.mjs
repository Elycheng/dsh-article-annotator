/**
 * Install this plugin into a local DSH profile.
 *
 *   node scripts/install-local.mjs [--profile-dir <dir>] [--profile <name>]
 *                                  [--dsh-home <dir>] [--backup-dir <dir>] [--dry-run]
 *
 * The plugin is mounted the supported way: add the checkout as a `link:`
 * dependency, select it in `dsh.profile.bundles` (its own bundle patch inserts
 * the loader row), then run `pnpm install` in the profile. No loader row is
 * written by hand — doing both would be a duplicate loader id.
 *
 * Everything the script touches is snapshotted first and restored when the
 * install fails. There is no machine-specific config: the profile is derived
 * from `$DSH_HOME` or `~/.dsh`, and the checkout is this repository.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-article-annotator'
const FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml']

function parseArgs(argv) {
  const args = { profile: 'desktop', dryRun: false }
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
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error('未知参数：' + arg)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node scripts/install-local.mjs [--profile-dir <dir>] [--profile desktop] [--dsh-home <dir>] [--backup-dir <dir>] [--dry-run]')
  process.exit(0)
}
const dshHome = resolve(args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const PROFILE = args.profileDir !== undefined ? resolve(args.profileDir) : join(dshHome, 'profiles', args.profile)
const BACKUP_ROOT = args.backupDir !== undefined ? resolve(args.backupDir) : join(PLUGIN, '.profile-backups')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const BACKUP = join(BACKUP_ROOT, 'profile-' + stamp)
const DRY = args.dryRun

function log(message) {
  console.log((DRY ? '[dry-run] ' : '') + message)
}

function sanitizeLinkPath(path) {
  return path.replace(/\\/g, '/')
}

function snapshot() {
  mkdirSync(BACKUP, { recursive: true })
  for (const name of FILES) {
    const source = join(PROFILE, name)
    if (existsSync(source)) copyFileSync(source, join(BACKUP, name))
  }
  writeFileSync(
    join(BACKUP, 'INSTALL.txt'),
    [
      PACKAGE_NAME + ' profile install snapshot',
      'created: ' + new Date().toISOString(),
      'profile: ' + PROFILE,
      'plugin:  ' + PLUGIN,
      '',
      'Restore by copying these files back over the profile and running:',
      '  pnpm install --ignore-scripts   (cwd: ' + PROFILE + ')',
      '',
    ].join('\n'),
    'utf8',
  )
  log('backup written to ' + BACKUP)
}

function restore(reason) {
  console.error('install failed: ' + reason)
  if (DRY) return
  console.error('restoring profile files from ' + BACKUP)
  for (const name of FILES) {
    const saved = join(BACKUP, name)
    if (existsSync(saved)) copyFileSync(saved, join(PROFILE, name))
  }
  runPnpm()
}

function runPnpm() {
  const result = spawnSync('pnpm', ['install', '--ignore-scripts'], { cwd: PROFILE, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw new Error('无法运行 pnpm：' + result.error.message)
  if (result.status !== 0) throw new Error('pnpm install 退出码 ' + result.status)
}

function updateManifest() {
  const path = join(PROFILE, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dependencies[PACKAGE_NAME] = 'link:' + sanitizeLinkPath(PLUGIN)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) pkg.dsh.profile.bundles.push(PACKAGE_NAME)
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  log('package.json：已写入 link 依赖并选中 bundle')
}

function updatePatch() {
  const path = join(PROFILE, 'cordis.patch.yml')
  let patch = existsSync(path) ? readFileSync(path, 'utf8') : ''
  // Starting from an empty profile, the patch layer is the literal empty array.
  patch = patch.replace(/^\s*\[\]\s*$/gmu, '')
  // A selected bundle supplies its own loader row; a hand-written duplicate is
  // a composition error. Strip a leftover manual row if a previous install
  // added one.
  const hadManualRow = patch.includes(PACKAGE_NAME)
  patch = patch.replace(
    /\n(?:#[^\n]*\n)?- insert:\n\s+- id: article-annotator\n\s+name: dsh-article-annotator\n/u,
    '\n',
  )
  let trimmed = patch.replace(/\n{3,}/gu, '\n\n').trimEnd()
  if (!/(^|\n)- /u.test(trimmed)) trimmed += '\n[]'
  writeFileSync(path, trimmed.replace(/^\n+/, '') + '\n', 'utf8')
  log(hadManualRow ? 'cordis.patch.yml：已移除重复的手写 loader 行（bundle patch 会自动插入）' : 'cordis.patch.yml：保持为空补丁层（bundle patch 自动插入 loader 行）')
}

function verifyInstalled() {
  const linked = join(PROFILE, 'node_modules', PACKAGE_NAME, 'package.json')
  if (!existsSync(linked)) throw new Error('node_modules/' + PACKAGE_NAME + ' 没有建立链接')
  const manifest = JSON.parse(readFileSync(linked, 'utf8'))
  if (manifest.name !== PACKAGE_NAME) throw new Error('链接到的包身份不符：' + manifest.name)
  log('已安装 ' + manifest.name + '@' + manifest.version)
}

function main() {
  if (!existsSync(join(PROFILE, 'package.json'))) {
    console.error('profile not found: ' + PROFILE)
    console.error('用法示例：node scripts/install-local.mjs --dsh-home "$env:DSH_HOME" --profile web')
    process.exit(1)
  }
  if (!existsSync(join(PLUGIN, 'lib', 'client.js'))) {
    console.error('缺少 lib/client.js：请先执行 `npm run build`')
    process.exit(1)
  }
  log('profile: ' + PROFILE)
  log('plugin:  ' + PLUGIN)
  log('backup:  ' + BACKUP)
  if (DRY) {
    log('将添加依赖 "' + PACKAGE_NAME + '": "link:' + sanitizeLinkPath(PLUGIN) + '"')
    log('将在 dsh.profile.bundles 中选中 ' + PACKAGE_NAME)
    log('将执行 pnpm install --ignore-scripts')
    return
  }
  snapshot()
  try {
    updateManifest()
    updatePatch()
    runPnpm()
    verifyInstalled()
  } catch (error) {
    restore(String(error?.message ?? error))
    process.exit(1)
  }
  console.log('')
  console.log(PACKAGE_NAME + ' 已安装到 ' + PROFILE + '。')
  console.log('重启一次 DSH（或等待 Profile HMR 重载）后，刷新页面，右侧栏引导页里会出现「文稿批注」。')
  console.log('备份：' + BACKUP)
  console.log('卸载：node scripts/uninstall-local.mjs --profile-dir "' + PROFILE + '"')
}

main()
