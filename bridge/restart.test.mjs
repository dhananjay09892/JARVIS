import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RESTART_EXIT_CODE, canRestart, createRestarter } from './restart.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('only a supervised bridge offers to restart itself', () => {
  assert.equal(canRestart({}), false)
  assert.equal(canRestart({ JARVIS_SUPERVISED: '0' }), false)
  assert.equal(canRestart({ JARVIS_SUPERVISED: '1' }), true)
})

test('an unsupervised bridge refuses and does not exit', async () => {
  const exits = []
  const r = createRestarter({ env: {}, exit: (c) => exits.push(c), log: () => {}, delayMs: 1 })
  assert.equal(r.available, false)
  const out = r.request()
  assert.equal(out.ok, false)
  assert.match(out.reason, /start it again/)
  await wait(10)
  assert.deepEqual(exits, [])
})

test('a supervised bridge answers first, then closes and exits with the restart code once', async () => {
  const steps = []
  const r = createRestarter({
    env: { JARVIS_SUPERVISED: '1' },
    exit: (c) => steps.push(['exit', c]),
    beforeExit: () => steps.push(['close']),
    log: () => {},
    delayMs: 5,
  })
  assert.equal(r.available, true)
  assert.deepEqual(r.request(), { ok: true })
  assert.deepEqual(r.request(), { ok: true })
  assert.deepEqual(steps, [], 'nothing happens before the reply has gone out')
  await wait(30)
  assert.deepEqual(steps, [['close'], ['exit', RESTART_EXIT_CODE]])
})

test('a failing close still exits', async () => {
  const exits = []
  const r = createRestarter({
    env: { JARVIS_SUPERVISED: '1' },
    exit: (c) => exits.push(c),
    beforeExit: () => {
      throw new Error('already closed')
    },
    log: () => {},
    delayMs: 1,
  })
  r.request()
  await wait(20)
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})

test('both launchers mark the bridge supervised and start it again on the restart code', () => {
  for (const file of ['../launcher/jarvis.mjs', '../scripts/start.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, new RegExp(`const RESTART_EXIT_CODE = ${RESTART_EXIT_CODE}\\b`), `${file} restart code`)
    assert.match(src, /JARVIS_SUPERVISED: '1'/, `${file} marks the bridge supervised`)
  }
})

test('the bridge serves the restart route behind the Origin rule and wires live apply', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const at = src.indexOf("requestUrl.pathname === '/settings/restart' && req.method === 'POST'")
  assert.ok(at > 0, 'restart route')
  assert.match(src.slice(at, at + 300), /if \(!origin\) \{\s*res\.writeHead\(403/)
  assert.match(src, /onSettingsChange\(/)
  assert.match(src, /if \(changed\.includes\('JARVIS_TRACES'\)\) applyTraces\(\)/)
})
