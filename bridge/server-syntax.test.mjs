// server.mjs starts a socket and loads everything, so no test imports it; a bad
// merge in its connector list shipped in 0.2.2 and the app could not start.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('bridge/server.mjs parses', () => {
  const file = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
