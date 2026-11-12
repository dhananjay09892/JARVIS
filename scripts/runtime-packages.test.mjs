// The installer carries only the packages in scripts/runtime-packages.mjs.
// This reads what bridge/ and launcher/ actually import and compares.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { RUNTIME_PACKAGES } from './runtime-packages.mjs'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const BUILTIN = new Set(builtinModules)

/** Every .mjs under `dir` that ships in the installer (tests do not). */
function sources(dir) {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs'))
    .map((e) => join(e.parentPath, e.name))
}

/** "zod/v4" → "zod", "@scope/name/sub" → "@scope/name". */
const packageOf = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

/**
 * The packages a source file imports: static imports, re-exports and
 * `import('…')` with a literal name. Comment lines are skipped, so a type in
 * a doc comment such as `import('./x.mjs').Thing` is not counted. Relative
 * paths and Node's own modules are not packages.
 */
export function importedPackages(text) {
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
  const specs = new Set()
  const patterns = [
    /\bimport\s+(?:[\w*\s{},$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[\w*\s{},$]+?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) for (const m of code.matchAll(pattern)) specs.add(m[1])
  const packages = new Set()
  for (const spec of specs) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    const name = packageOf(spec)
    if (!BUILTIN.has(name)) packages.add(name)
  }
  return packages
}

test('importedPackages finds static, re-exported and dynamic imports, and nothing else', () => {
  const found = importedPackages([
    "import { a } from 'alpha'",
    "import b, {",
    "  c,",
    "} from '@scope/beta/sub'",
    "import 'gamma/register'",
    "export { d } from 'delta'",
    "const e = await import('epsilon')",
    "import fs from 'node:fs'",
    "import path from 'path'",
    "import { x } from './local.mjs'",
    " * @param {import('zeta').Thing} t   (a doc comment)",
    "// import eta from 'eta'",
  ].join('\n'))
  assert.deepEqual([...found].sort(), ['@scope/beta', 'alpha', 'delta', 'epsilon', 'gamma'])
})

test('every package that bridge/ and launcher/ import is staged for the installer', () => {
  const files = [...sources('bridge'), ...sources('launcher')]
  assert.ok(files.length > 100, `only ${files.length} source files found`)
  const missing = []
  const used = new Set()
  for (const file of files) {
    for (const name of importedPackages(readFileSync(file, 'utf8'))) {
      used.add(name)
      if (!RUNTIME_PACKAGES.includes(name)) missing.push(`${name} (imported by ${relative(root, file).replaceAll('\\', '/')})`)
    }
  }
  assert.ok(used.has('ws') && used.has('zod'), 'the scan found none of the known imports; it is not reading the sources')
  assert.deepEqual(missing, [], 'imported but not in scripts/runtime-packages.mjs, so missing from the installed app')
})

test('every staged package has a version in package.json', () => {
  for (const name of RUNTIME_PACKAGES) {
    assert.equal(typeof pkg.dependencies[name], 'string', `${name} is not in package.json dependencies`)
  }
})
