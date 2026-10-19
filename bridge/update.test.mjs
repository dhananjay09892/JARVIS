import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkForUpdate, installedVersion, isNewer, parseVersion, _resetUpdateCache } from './update.mjs'

test('versions compare numerically, not as text', () => {
  assert.deepEqual(parseVersion('v0.10.2'), [0, 10, 2])
  assert.equal(isNewer('0.10.0', '0.9.9'), true)
  assert.equal(isNewer('v0.1.1', '0.1.1'), false)
  assert.equal(isNewer('0.1.0', '0.1.1'), false)
  assert.equal(isNewer('nightly', '0.1.1'), false)
})

const reply = (body, ok = true) => async () => ({ ok, json: async () => body })

test('reports an update only when the latest release is newer', async () => {
  _resetUpdateCache()
  const current = installedVersion()
  const newer = await checkForUpdate({ fetchImpl: reply({ tag_name: 'v99.0.0' }) })
  assert.equal(newer.updateAvailable, true)
  assert.equal(newer.latest, '99.0.0')
  assert.match(newer.downloadUrl, /JARVIS-Setup\.exe$/)

  _resetUpdateCache()
  const same = await checkForUpdate({ fetchImpl: reply({ tag_name: `v${current}` }) })
  assert.equal(same.updateAvailable, false)
})

test('offline, errors and garbage mean no update, never a throw', async () => {
  _resetUpdateCache()
  const offline = await checkForUpdate({
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(offline.updateAvailable, false)
  _resetUpdateCache()
  assert.equal((await checkForUpdate({ fetchImpl: reply({}, false) })).updateAvailable, false)
  _resetUpdateCache()
  assert.equal((await checkForUpdate({ fetchImpl: reply({ tag_name: 'garbage' }) })).updateAvailable, false)
})

test('the answer is cached so GitHub is not asked on every launch', async () => {
  _resetUpdateCache()
  let calls = 0
  const counting = async () => {
    calls++
    return { ok: true, json: async () => ({ tag_name: 'v99.0.0' }) }
  }
  await checkForUpdate({ fetchImpl: counting })
  await checkForUpdate({ fetchImpl: counting })
  assert.equal(calls, 1)
})
