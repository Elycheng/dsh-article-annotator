/**
 * Test entry: run the whole offline suite in one process.
 *
 * `node --test` normally spawns a child per file; the DSH sandbox used during
 * development cannot open the pipes that needs, so the files are enumerated
 * here and handed to a single non-isolated runner. Running from a normal
 * terminal (no sandbox) works the same way.
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

console.log('running ' + files.length + ' test files:')
for (const file of files) console.log('  - ' + file.slice(HERE.length + 1))
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
