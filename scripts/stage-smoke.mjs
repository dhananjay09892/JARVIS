#!/usr/bin/env node
/**
 * Checks the folder the Windows installer wraps, after scripts/package.mjs
 * has built it: does the staged app start with the staged Node, and does it
 * have what it needs?
 *
 *   node scripts/package.mjs && node scripts/stage-smoke.mjs
 *
 * The tests run the source tree with the developer's node_modules. This runs
 * what a user gets: installer/stage/node/node.exe, the copied bridge, the
 * built page and the runtime packages installed for the stage. It exits 1
 * with the reason when a check fails.
 *
 * The staged bridge gets a home folder of its own in the temp folder and
 * none of this process's environment beyond what Node needs, so it reads no
 * real settings or secrets. It makes no model call: the brain is set to the
 * one that needs an API key, no key is given, and nothing is sent to it. The
 * bundled Claude program is checked for presence only; it is not started.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PACKAGES } from './runtime-packages.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = join(root, 'installer', 'stage')
const app = join(stage, 'app')
const node = join(stage, 'node', 'node.exe')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** What a child needs from the real environment to run at all; nothing of the user's. */
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'])
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.has(k.toUpperCase())))

const results = []
const ok = (what, detail = '') => { results.push(what); console.log(`ok    ${what}${detail ? `  (${detail})` : ''}`) }
class CheckFailed extends Error {}
const fail = (what, detail = '') => { throw new CheckFailed(`${what}${detail ? `\n${detail}` : ''}`) }

const megabytes = (dir) => {
  let total = 0
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) total += statSync(join(e.parentPath, e.name)).size
  }
  return Math.round(total / 1e6)
}

const freePort = () => new Promise((res, rej) => {
  const probe = createServer()
  probe.once('error', rej)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => res(port)) })
})

/**
 * True when `path` is inside the staged app's own node_modules.
 *
 * The stage sits inside the repository, and Node looks for a package in every
 * parent folder, so a package missing from the stage would be found in the
 * developer's node_modules and everything would seem fine. An installed app
 * has no such parent folder. So it is not enough that a package loads: it has
 * to load from the stage.
 */
const inStagedModules = (path) => {
  const rel = relative(join(app, 'node_modules'), path)
  return rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel)
}

/** Run a short script with the staged Node, from the staged app folder. */
function inStage(code) {
  return spawnSync(node, ['--input-type=module', '-e', code], { cwd: app, env: baseEnv(), encoding: 'utf8', timeout: 60_000 })
}

async function main() {
  if (process.platform !== 'win32') fail('The stage is Windows-only; run this on Windows.')

  // 1. The pieces the installer expects.
  for (const [what, path] of [
    ['the staged Node', node],
    ['the windowless launcher', join(stage, 'JARVIS.vbs')],
    ['the bridge', join(app, 'bridge', 'server.mjs')],
    ['the launcher script', join(app, 'launcher', 'jarvis.mjs')],
    ['the built page', join(app, 'dist', 'index.html')],
    ['the app manifest', join(app, 'package.json')],
    ["Node's licence", join(stage, 'node', 'LICENSE')],
  ]) {
    if (!existsSync(path)) fail(`missing from the stage: ${what}`, `${path}\nRun node scripts/package.mjs first.`)
  }
  ok('the stage has its files')

  const staged = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  if (staged.version !== pkg.version) fail('the staged app has the wrong version', `staged ${staged.version}, package.json ${pkg.version}`)
  for (const name of RUNTIME_PACKAGES) {
    if (!staged.dependencies?.[name]) fail(`the staged app does not list ${name}`)
  }
  ok('the staged app lists every runtime package', `version ${staged.version}`)

  const tests = readdirSync(join(app, 'bridge'), { recursive: true }).filter((f) => String(f).endsWith('.test.mjs'))
  if (tests.length) fail('test files were staged', tests.slice(0, 5).join(', '))
  ok('no test files are staged')

  // 2. Every runtime package loads with the staged Node, from the staged app.
  for (const name of RUNTIME_PACKAGES) {
    const r = inStage(`console.log(import.meta.resolve(${JSON.stringify(name)})); await import(${JSON.stringify(name)})`)
    if (r.status !== 0) fail(`the staged Node cannot load ${name}`, (r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n').slice(0, 6).join('\n'))
    const from = fileURLToPath(r.stdout.trim().split('\n')[0])
    if (!inStagedModules(from)) fail(`${name} is not in the stage`, `it loaded from ${from}\nAn installed app would not find it.`)
  }
  ok('the staged Node loads every runtime package from the stage', RUNTIME_PACKAGES.join(', '))

  // 3. The Claude program the bridge will launch is there (found the way bridge/claude-cli.mjs finds it). Not started.
  const claude = inStage(
    "import { createRequire } from 'node:module'; import { statSync } from 'node:fs';" +
    'const p = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude.exe`);' +
    'console.log(p); console.log(statSync(p).size)',
  )
  const [claudePath = '', claudeSize = ''] = claude.stdout.trim().split('\n')
  const claudeBytes = Number(claudeSize)
  if (claude.status !== 0 || !(claudeBytes > 1e6)) fail('the bundled Claude program is missing from the stage', (claude.stderr || claude.stdout).trim().split('\n').slice(0, 4).join('\n'))
  if (!inStagedModules(claudePath.trim())) fail('the bundled Claude program is not in the stage', `it was found at ${claudePath}`)
  ok('the bundled Claude program is present', `${Math.round(claudeBytes / 1e6)} MB, not started`)

  // 4. The staged bridge starts and serves the page.
  const home = mkdtempSync(join(tmpdir(), 'jarvis-stage-smoke-'))
  const port = await freePort()
  const env = {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    JARVIS_HOME: join(home, 'jarvis'),
    JARVIS_BRIDGE_PORT: String(port),
    JARVIS_UPDATE_CHECK: 'off',
    JARVIS_BRAIN: 'openai',
  }
  mkdirSync(env.APPDATA, { recursive: true })
  mkdirSync(env.LOCALAPPDATA, { recursive: true })
  // As the launcher starts it: the staged Node, from the app folder.
  const child = spawn(node, ['bridge/server.mjs'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  let gone = null
  const exited = new Promise((res) => child.once('exit', (code, signal) => { gone = code ?? signal ?? 'gone'; res() }))
  try {
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    for (;;) {
      if (gone !== null) fail(`the staged bridge exited before it answered (${gone})`, output.trim().split('\n').slice(-15).join('\n'))
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
        if (res.ok) {
          const health = await res.json()
          if (health.ok !== true) fail('/health did not say ok', JSON.stringify(health))
          break
        }
      } catch (err) {
        if (err instanceof CheckFailed) throw err
      }
      if (Date.now() > deadline) fail('the staged bridge did not answer /health within 60 seconds', output.trim().split('\n').slice(-15).join('\n'))
      await new Promise((r) => setTimeout(r, 150))
    }
    ok('the staged bridge starts and answers /health')

    const page = await fetch(`${base}/`)
    const html = await page.text()
    if (page.status !== 200 || !html.includes('id="root"')) fail('/ did not serve the built page', `status ${page.status}, ${html.length} bytes`)
    const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1]
    if (!script) fail('the page names no script')
    const js = await fetch(new URL(script, `${base}/`))
    const jsBytes = (await js.arrayBuffer()).byteLength
    if (js.status !== 200 || jsBytes < 100_000) fail("the page's script was not served", `${script}: status ${js.status}, ${jsBytes} bytes`)
    ok('the staged bridge serves the built page and its script', `${script}, ${Math.round(jsBytes / 1e3)} kB`)

    const settings = await fetch(`${base}/settings/schema`)
    if (settings.status !== 200) fail('/settings/schema did not answer', `status ${settings.status}`)
    ok('the settings screen can load its schema')
  } finally {
    if (gone === null) child.kill()
    await exited
    // Windows lets go of the child's open files a moment after it exits.
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  console.log(`\nstage smoke: ${results.length} checks passed. Staged folder: ${megabytes(stage)} MB (app ${megabytes(app)} MB, node ${megabytes(join(stage, 'node'))} MB).`)
}

main().catch((err) => {
  console.error(`\nFAILED  ${err instanceof CheckFailed ? err.message : err?.stack ?? err}`)
  process.exitCode = 1
})
