/**
 * Test entry: run the whole offline suite.
 *
 * The files are enumerated here (instead of a shell glob) so the runner works
 * on Windows PowerShell, POSIX shells and CI alike. On Node versions that
 * support `--test-isolation=none` the suite runs in one process; older Node 20
 * releases do not know that flag, so the standard per-file runner is used.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(HERE, name))

const [major, minor] = process.versions.node.split('.').map((part) => Number(part))
const supportsIsolation = major > 22 || (major === 22 && minor >= 8)

console.log('running ' + files.length + ' test files (node ' + process.versions.node + '):')
for (const file of files) console.log('  - ' + file.slice(HERE.length + 1))
const args = supportsIsolation ? ['--test', '--test-isolation=none', ...files] : ['--test', ...files]
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
