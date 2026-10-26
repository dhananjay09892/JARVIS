import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceWarmer, WARM_URL } from './voice-warm.mjs'

function fakeFetch({ fail = false } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (fail) throw new Error('offline')
    let cancelled = false
    return { ok: true, body: { cancel: async () => { cancelled = true } }, get cancelled() { return cancelled } }
  }
  fn.calls = calls
  return fn
}

test('a warm-up is a bare HEAD to the voice API: no key, no text, no body', async () => {
  const fetch = fakeFetch()
  const w = createVoiceWarmer({ fetch })
  assert.equal(await w.warm(), 'warmed')
  assert.equal(fetch.calls.length, 1)
  const { url, init } = fetch.calls[0]
  assert.equal(url, WARM_URL)
  assert.equal(init.method, 'HEAD')
  assert.equal(init.headers, undefined, 'no headers, so never the API key')
  assert.equal(init.body, undefined)
  assert.ok(init.signal, 'bounded by a timeout')
})

test('a burst of turns opens one connection, not many', async () => {
  let now = 1_000
  const fetch = fakeFetch()
  const w = createVoiceWarmer({ fetch, clock: () => now, intervalMs: 2_000 })
  const first = w.warm()
  assert.equal(await w.warm(), 'skipped', 'one already in flight')
  await first
  now += 500
  assert.equal(await w.warm(), 'skipped', 'made a moment ago')
  now += 2_000
  assert.equal(await w.warm(), 'warmed')
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(w.stats(), { warmed: 2, skipped: 2, failed: 0 })
})

test('never throws when the network is down', async () => {
  const w = createVoiceWarmer({ fetch: fakeFetch({ fail: true }) })
  assert.equal(await w.warm(), 'failed')
  assert.equal(w.stats().failed, 1)
})

test('the response is drained so the connection goes back to the pool', async () => {
  let res
  const fetch = async () => {
    res = { cancelled: false, body: { cancel: async () => { res.cancelled = true } } }
    return res
  }
  await createVoiceWarmer({ fetch }).warm()
  assert.equal(res.cancelled, true)
})
