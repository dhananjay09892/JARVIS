#!/usr/bin/env node
/**
 * Assemble the folder the Windows installer wraps:
 *
 *   installer/stage/
 *     JARVIS.vbs        windowless launcher (shortcuts point here)
 *     node/node.exe     the Node runtime this script ran under (needs Node 22+)
 *     app/              bridge, built UI, launcher, production node_modules
 *
 * Then compile installer/jarvis.iss with Inno Setup (see .github/workflows).
 * Run:  node scripts/package.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { RUNTIME_PACKAGES, pruneOnnxRuntime } from './runtime-packages.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = join(root, 'installer', 'stage')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

/**
 * Node's LICENSE (MIT plus the third-party licences bundled into Node) must ship next to node.exe.
 * It is fetched for the exact version being copied, so it always matches the binary.
 */
async function fetchNodeLicence(dest) {
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not download Node's LICENSE for ${process.version} (${res.status}): ${url}`)
  const text = await res.text()
  if (!text.includes('Node.js is licensed for use as follows')) throw new Error(`unexpected Node LICENSE content from ${url}`)
  writeFileSync(dest, text)
}

if (process.platform !== 'win32') throw new Error('The installer is Windows-only; run this on Windows.')
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ is required (node:sqlite).')

// Hand tracking needs MediaPipe's WASM next to the page (see scripts/start.mjs).
if (!existsSync(join(root, 'public/mediapipe/vision_wasm_internal.wasm'))) {
  cpSync(join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), join(root, 'public/mediapipe'), { recursive: true })
}

// The offline wake word's ONNX runtime, served from /ort/ (see scripts/start.mjs).
{
  const from = join(root, 'node_modules/onnxruntime-web/dist')
  mkdirSync(join(root, 'public/ort'), { recursive: true })
  for (const f of readdirSync(from).filter((f) => f.startsWith('ort-wasm'))) {
    cpSync(join(from, f), join(root, 'public/ort', f))
  }
}

console.log('building the UI…')
run('npm', ['run', 'build'])

console.log('staging…')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'node'), { recursive: true })
mkdirSync(join(stage, 'app'), { recursive: true })
cpSync(process.execPath, join(stage, 'node', 'node.exe'))
await fetchNodeLicence(join(stage, 'node', 'LICENSE'))
cpSync(join(root, 'launcher/JARVIS.vbs'), join(stage, 'JARVIS.vbs'))
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
cpSync(join(root, 'DISCLAIMER.txt'), join(stage, 'DISCLAIMER.txt'))
cpSync(join(root, 'CREDITS.md'), join(stage, 'CREDITS.md'))
// Licence texts and source links that must travel with the installer (GPL-3.0 and eSpeak NG notice).
cpSync(join(root, 'installer/licences'), join(stage, 'licences'), { recursive: true })
cpSync(join(root, 'bridge'), join(stage, 'app/bridge'), {
  recursive: true,
  filter: (src) => !src.endsWith('.test.mjs'),
})
cpSync(join(root, 'launcher'), join(stage, 'app/launcher'), { recursive: true })
cpSync(join(root, 'dist'), join(stage, 'app/dist'), { recursive: true })

// Only what the bridge imports at runtime; the UI is already compiled into dist/.
const runtime = RUNTIME_PACKAGES
writeFileSync(
  join(stage, 'app/package.json'),
  JSON.stringify(
    {
      name: 'jarvis-app',
      version: pkg.version,
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(runtime.map((d) => [d, pkg.dependencies[d]])),
    },
    null,
    2,
  ),
)
console.log('installing runtime dependencies (includes the bundled Claude Code binary)…')
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], join(stage, 'app'))

// Keep only the speaker-recognition binary the staged node.exe can load.
{
  const { kept, removed, removedBytes } = pruneOnnxRuntime(join(stage, 'app'))
  console.log(`onnxruntime-node: kept ${kept}, removed ${removed.join(', ')} (${Math.round(removedBytes / 1e6)} MB)`)
}

console.log(`\nstaged ${pkg.version} in ${stage}\nnext: ISCC /DAppVersion=${pkg.version} installer\\jarvis.iss`)
