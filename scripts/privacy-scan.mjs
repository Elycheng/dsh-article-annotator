/**
 * Release privacy scan.
 *
 * Walks the repository and reports anything that must not be published:
 * personal home directories, machine-specific absolute paths, e-mail
 * addresses, private IPs and a handful of token shapes. The matched text is
 * deliberately NOT printed (the report itself must stay safe to paste), only
 * the rule name and location are shown.
 *
 * Extra substrings (developer user name, machine name, …) can be supplied via
 * `PRIVACY_DENY=a,b,c` or a local `.privacy-deny.local` file (one per line,
 * gitignored). Exit code 1 means "do not publish yet".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP_DIRS = new Set(['node_modules', '.git', '.profile-backups', '.scratch', '.client-build', 'fixtures'])
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.md', '.txt', '.svg', '.html', '.css', '.sh', '.ps1'])

const RULES = [
  { name: 'windows-user-dir', pattern: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+/giu },
  { name: 'posix-home-dir', pattern: /(^|[^A-Za-z0-9._-])\/(?:home|Users)\/[A-Za-z0-9._-]+\//gu },
  { name: 'email-address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu, allow: [/^git@github\.com$/u] },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  { name: 'api-key-shape', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gu },
  { name: 'private-ip', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/gu },
  { name: 'localhost-with-port', pattern: /127\.0\.0\.1:\d{4,5}/gu, allow: [/^127\.0\.0\.1:8791$/u] },
]

function loadDenyList() {
  const items = (process.env.PRIVACY_DENY ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  try {
    const local = readFileSync(join(ROOT, '.privacy-deny.local'), 'utf8')
    for (const line of local.split(/\r?\n/u)) {
      const value = line.trim()
      if (value !== '' && !value.startsWith('#')) items.push(value)
    }
  } catch {
    // Optional file.
  }
  return items
}

const denyList = loadDenyList()
if (denyList.length > 0) {
  RULES.push({ name: 'local-deny-list', pattern: new RegExp(denyList.map(escapeRegExp).join('|'), 'gu') })
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const findings = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) {
      walk(full)
      continue
    }
    const ext = name.endsWith('.d.ts') ? '.ts' : extname(name)
    if (!TEXT_EXTS.has(ext)) continue
    scanFile(full)
  }
}

function scanFile(full) {
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    return
  }
  const lines = text.split(/\r?\n/u)
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(line)) !== null) {
        const value = match[0]
        if (Array.isArray(rule.allow) && rule.allow.some((pattern) => pattern.test(value))) continue
        findings.push({ file: relative(ROOT, full), line: index + 1, rule: rule.name })
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1
      }
    }
  }
}

walk(ROOT)

if (findings.length === 0) {
  console.log('privacy scan: clean (' + RULES.length + ' rules)')
  process.exit(0)
}

console.error('privacy scan: ' + findings.length + ' finding(s) — do not publish before fixing:')
for (const finding of findings) console.error('  ' + finding.file + ':' + finding.line + '  [' + finding.rule + ']')
console.error('')
console.error('Matched text is intentionally hidden. Fix or remove the content, then re-run `npm run check:privacy`.')
process.exit(1)
