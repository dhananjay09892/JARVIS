import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrainMetrics } from './metrics.mjs'

const session = (events) => {
  let cancelled = 0
  return {
    events: (async function* () { yield* events })(),
    cancel: () => { cancelled++ },
    close() {},
    get cancelled() { return cancelled },
  }
}
const drain = async (run) => {
  const out = []
  for await (const e of run.events) out.push(e)
  return out
}

test('turns, how they ended and the codes of failed ones are counted per brain and actor', async () => {
  const m = createBrainMetrics({ now: () => Date.UTC(2026, 9, 25) })
  const events = [
    { t: 'text', delta: 'hi' }, { t: 'done', reason: 'complete' },
    { t: 'error', code: 'auth', retryable: false, message: 'No API key is stored for this brain.' }, { t: 'done', reason: 'error' },
    { t: 'error', code: 'max_steps', retryable: false, message: 'x' }, { t: 'done', reason: 'limit' },
    { t: 'done', reason: 'cancelled' },
    { t: 'error', code: 'Weird Code!', message: 'x' }, { t: 'done', reason: 'error' },
  ]
  const out = await drain(m.observe('openai', 'voice', session(events)))
  assert.deepEqual(out, events, 'events pass through unchanged')
  await drain(m.observe('claude', 'worker', session([{ t: 'done', reason: 'complete' }])))
  assert.deepEqual(m.snapshot(), {
    since: '2026-10-25T00:00:00.000Z',
    brains: [
      { brain: 'openai', actor: 'voice', turns: 5, complete: 1, cancelled: 1, limit: 1, error: 2, errors: { auth: 1, max_steps: 1, other: 1 } },
      { brain: 'claude', actor: 'worker', turns: 1, complete: 1, cancelled: 0, limit: 0, error: 0, errors: {} },
    ],
  })
})

test('the snapshot holds counts only, and observing keeps cancel and close', async () => {
  const m = createBrainMetrics()
  const run = session([{ t: 'error', code: 'provider', message: 'secret prompt text sk-abc' }, { t: 'done', reason: 'error' }])
  const observed = m.observe('openai', 'stranger', run)
  observed.cancel()
  assert.equal(run.cancelled, 1)
  assert.equal(typeof observed.close, 'function')
  await drain(observed)
  const snap = JSON.stringify(m.snapshot())
  assert.doesNotMatch(snap, /secret|sk-abc/)
  assert.equal(m.snapshot().brains[0].actor, 'voice', 'an unknown actor counts as voice')
})
