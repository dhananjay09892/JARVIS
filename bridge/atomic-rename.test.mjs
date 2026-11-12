import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameWithRetry } from './atomic-rename.mjs'

const refusal = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: 'rename' })

/** A rename that is refused `times` times with `code`, then works. Records every call and wait. */
function flakyRename(times, code = 'EPERM') {
  const calls = []
  const waits = []
  const errors = []
  const rename = (from, to) => {
    calls.push([from, to])
    if (calls.length <= times) {
      const err = refusal(code)
      errors.push(err)
      throw err
    }
  }
  return { rename, sleep: (ms) => waits.push(ms), calls, waits, errors }
}

test('succeeds after two refusals, waiting a little longer each time', () => {
  const f = flakyRename(2)
  renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, sleep: f.sleep })
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.calls[2], ['a.tmp', 'a'])
  assert.deepEqual(f.waits, [10, 20])
})

test('each of EPERM, EBUSY and EACCES is tried again', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const f = flakyRename(1, code)
    renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, sleep: f.sleep })
    assert.equal(f.calls.length, 2, code)
  }
})

test('gives up after the limit and throws the first error, unchanged', () => {
  const f = flakyRename(Infinity)
  assert.throws(
    () => renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, sleep: f.sleep }),
    (err) => err === f.errors[0],
  )
  assert.equal(f.calls.length, 6, 'one try and five more')
  assert.deepEqual(f.waits, [10, 20, 30, 40, 50])
  assert.equal(f.waits.reduce((a, b) => a + b, 0), 150, 'the total wait is bounded')
})

test('the number of tries and the wait can be set', () => {
  const f = flakyRename(Infinity)
  assert.throws(() => renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, sleep: f.sleep, retries: 2, stepMs: 1 }))
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.waits, [1, 2])
})

test('never retries other errors', () => {
  // null: an error that carries no code at all
  for (const code of ['ENOENT', 'ENOSPC', 'EXDEV', null]) {
    const f = flakyRename(Infinity, code)
    assert.throws(
      () => renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, sleep: f.sleep }),
      (err) => err === f.errors[0],
    )
    assert.equal(f.calls.length, 1, String(code))
    assert.deepEqual(f.waits, [])
  }
})

test('off Windows a refusal is thrown at once', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = flakyRename(Infinity)
    assert.throws(() => renameWithRetry('a.tmp', 'a', { platform, rename: f.rename, sleep: f.sleep }), { code: 'EPERM' })
    assert.equal(f.calls.length, 1, platform)
    assert.deepEqual(f.waits, [])
  }
})

test('with the real rename, the temp file replaces the old one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-rename-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'data.json')
  writeFileSync(file, 'old')
  writeFileSync(`${file}.tmp`, 'new')
  renameWithRetry(`${file}.tmp`, file)
  assert.equal(readFileSync(file, 'utf8'), 'new')
  assert.throws(() => readFileSync(`${file}.tmp`), { code: 'ENOENT' })
})

test('the real wait blocks for about as long as asked', () => {
  const f = flakyRename(1)
  const started = performance.now()
  renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: f.rename, stepMs: 30 })
  const took = performance.now() - started
  assert.ok(took >= 25, `waited ${took} ms`)
  assert.equal(f.calls.length, 2)
})
