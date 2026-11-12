// Starts the real bridge as a child process and checks that it comes up.
//
// No other test imports server.mjs (it opens a socket and loads everything),
// so a mistake that only shows when the file runs, such as a bad import or an
// exception while the pieces are wired together, would otherwise reach a
// release. server-syntax.test.mjs only checks that the file parses.
//
// The child gets a home folder of its own in the temp folder and none of this
// process's environment beyond what Node needs to run, so it reads no real
// settings, secrets or Claude configuration and writes nowhere else. It makes
// no model call: the brain is set to the one that needs an API key, no key is
// given, and no message is ever sent to it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const BOOT_TIMEOUT_MS = 60_000

/** What a child needs from the real environment to run at all; nothing of the user's. */
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'])

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Start server.mjs with a private home. Resolves once /health answers, or rejects with the child's output. */
async function startBridge(t, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-boot-'))
  const port = await freePort()
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.has(k.toUpperCase())))
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    JARVIS_HOME: join(home, 'jarvis'),
    JARVIS_BRIDGE_PORT: String(port),
    JARVIS_UPDATE_CHECK: 'off',
    JARVIS_BRAIN: 'openai',
    ...extraEnv,
  })
  mkdirSync(env.APPDATA, { recursive: true })
  mkdirSync(env.LOCALAPPDATA, { recursive: true })

  const child = spawn(process.execPath, [SERVER], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    // Windows lets go of the child's open files a moment after it exits.
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let early = null
  void exited.then((e) => { early = e })
  for (;;) {
    if (early) throw new Error(`the bridge exited before it answered (code ${early.code}, signal ${early.signal}):\n${output}`)
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return { base, port, home, child, exited, health: await res.json(), output: () => output }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`the bridge did not answer /health within ${BOOT_TIMEOUT_MS} ms:\n${output}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Try a WebSocket handshake. Resolves to { open, first } or { refused: status }. */
function handshake(port, { origin, path = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {})
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('websocket handshake timed out')) }, 10_000)
    const finish = (result) => { clearTimeout(timer); resolve(result) }
    ws.once('unexpected-response', (_req, res) => { res.resume(); finish({ refused: res.statusCode }) })
    ws.once('error', (err) => { if (ws.readyState !== WebSocket.OPEN) finish({ refused: null, error: String(err?.message ?? err) }) })
    ws.once('open', () => {
      ws.once('message', (data) => {
        ws.close()
        finish({ open: true, first: JSON.parse(String(data)) })
      })
    })
  })
}

test('the bridge starts, answers /health, and lets only a local page open its socket', async (t) => {
  const bridge = await startBridge(t)

  assert.equal(bridge.health.ok, true)
  // No key was given to the child, so neither premium voice path is on.
  assert.equal(bridge.health.tts, false)
  assert.equal(bridge.health.stt, false)

  // The page the dev server serves may connect, and is greeted at once.
  const local = await handshake(bridge.port, { origin: 'http://localhost:5173' })
  assert.equal(local.open, true, JSON.stringify(local))
  assert.equal(local.first.type, 'ready')

  // Another site, a page on an unexpected local port, a client with no Origin
  // (a script), and an unknown path are all turned away at the handshake.
  for (const [what, opts] of [
    ['another site', { origin: 'https://example.com' }],
    ['a local page on another port', { origin: 'http://localhost:3000' }],
    ['https on a dev port', { origin: 'https://localhost:5173' }],
    ['no origin', {}],
    ['an unknown path', { origin: 'http://localhost:5173', path: '/elsewhere' }],
  ]) {
    const r = await handshake(bridge.port, opts)
    assert.equal(r.refused, 403, `${what}: ${JSON.stringify(r)}`)
  }

  // Still up after all of that.
  assert.equal(bridge.child.exitCode, null, bridge.output())
  const again = await fetch(`${bridge.base}/health`)
  assert.equal(again.status, 200)
})
