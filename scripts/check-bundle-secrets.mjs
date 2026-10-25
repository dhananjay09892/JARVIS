#!/usr/bin/env node
// Runs after `vite build` (see the "build" script in package.json): fails the
// build when anything in dist/ looks like a key. Plan 25 phase 4 (Q22).
//
//   node scripts/check-bundle-secrets.mjs [distDir]
//
// It looks for the literal values of the secret variables in the shell and in
// .env, .env.local, .env.production and .env.production.local, and for the
// shapes of well-known provider keys. It prints the file and what kind of
// secret it found, never the secret.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDotenv, scanText, secretValues } from './bundle-secrets.mjs'

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.html', '.css', '.json', '.map', '.txt', '.svg', '.webmanifest', '.xml',
])
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

/** Scans `distDir`; returns `[{ file, kind, name }]`. */
export function checkDist(distDir, { root = process.cwd(), env = process.env } = {}) {
  const fileEnvs = ENV_FILES.map((f) => join(root, f))
    .filter((p) => existsSync(p))
    .map((p) => parseDotenv(readFileSync(p, 'utf8')))
  const values = secretValues(...fileEnvs, env)
  const findings = []
  for (const file of walk(distDir)) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue
    const text = readFileSync(file, 'utf8')
    for (const f of scanText(text, values)) findings.push({ file: relative(root, file), ...f })
  }
  return findings
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist')
  if (!existsSync(dist)) {
    console.error(`check-bundle-secrets: ${dist} does not exist; run vite build first.`)
    process.exit(2)
  }
  const findings = checkDist(dist)
  if (findings.length === 0) {
    console.log('check-bundle-secrets: no keys in the built front end.')
  } else {
    console.error('check-bundle-secrets: the built front end contains secrets:')
    for (const f of findings) {
      console.error(`  ${f.file}: ${f.kind === 'value' ? `the value of ${f.name}` : `something shaped like a ${f.name}`}`)
    }
    console.error('Keys belong behind the bridge. See "Keys behind the bridge" in README.md.')
    process.exit(1)
  }
}
