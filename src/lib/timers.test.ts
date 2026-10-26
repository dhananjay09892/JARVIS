// Plan 06 phase 1 (Q25): reflex timers, on a fake clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeTimers } from './timers.ts'
import { MAX_TIMERS, type TimerView } from './reflex.ts'

function rig(saved: string | null = null, start = 1_000_000) {
  let t = start
  const jobs = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const fired: TimerView[] = []
  let stored = saved
  let ids = 0
  const timers = makeTimers({
    now: () => t,
    schedule: (fn, ms) => {
      const h = next++
      jobs.set(h, { at: t + ms, fn })
      return h
    },
    unschedule: (h) => jobs.delete(h as number),
    onFire: (v) => fired.push(v),
    storage: { get: () => stored, set: (v) => (stored = v) },
    newId: () => `id${ids++}`,
  })
  const advance = (ms: number) => {
    t += ms
    for (const [h, j] of [...jobs]) {
      if (j.at <= t) {
        jobs.delete(h)
        j.fn()
      }
    }
  }
  return { timers, fired, advance, stored: () => stored, jobs, now: () => t }
}

test('a timer rings once at its end and leaves the list', () => {
  const r = rig()
  const v = r.timers.start(5000, 'tea')
  assert.ok(v)
  assert.equal(r.timers.list().length, 1)
  r.advance(4999)
  assert.equal(r.fired.length, 0)
  r.advance(1)
  assert.deepEqual(r.fired.map((f) => f.label), ['tea'])
  assert.equal(r.timers.list().length, 0)
  r.advance(60_000)
  assert.equal(r.fired.length, 1)
})

test('cancelled timers never ring', () => {
  const r = rig()
  const a = r.timers.start(5000)!
  r.timers.start(9000)
  assert.equal(r.timers.cancel([a.id, 'nope']), 1)
  r.advance(10_000)
  assert.equal(r.fired.length, 1)
  assert.equal(r.fired[0].ms, 9000)
})

test('list is soonest first; limits on count and length hold', () => {
  const r = rig()
  r.timers.start(9000)
  r.timers.start(3000)
  assert.deepEqual(r.timers.list().map((v) => v.ms), [3000, 9000])
  assert.equal(r.timers.start(500), null)
  assert.equal(r.timers.start(25 * 3600_000), null)
  for (let i = r.timers.list().length; i < MAX_TIMERS; i++) assert.ok(r.timers.start(60_000))
  assert.equal(r.timers.start(60_000), null)
})

test('timers survive a reload; ones that ended while closed are dropped', () => {
  const first = rig()
  first.timers.start(60_000, 'pasta')
  first.timers.start(5000)
  const saved = first.stored()
  assert.ok(saved)
  const views = JSON.parse(saved!) as TimerView[]
  assert.equal(views.length, 2)

  // Reopen 10 s later on a fresh page: the 5 s timer is gone, the other rings on time.
  const again = rig(saved, first.now() + 10_000)
  // Only the timer still in the future was re-armed, and nothing rang late.
  again.advance(0)
  assert.equal(again.fired.length, 0)
  assert.equal(JSON.parse(again.stored()!).length, 1)
  assert.deepEqual(again.timers.list().map((v) => v.label), ['pasta'])
  again.advance(50_000)
  assert.deepEqual(again.fired.map((v) => v.label), ['pasta'])
})

test('broken storage starts empty instead of throwing', () => {
  for (const bad of ['not json', '{"a":1}', '[{"id":3}]', '[null]']) {
    const r = rig(bad)
    assert.deepEqual(r.timers.list(), [])
  }
})
