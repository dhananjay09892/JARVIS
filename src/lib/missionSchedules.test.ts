import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_NAMES, EVERY_LABEL, emptyPick, scheduleRequest, type WhenPick } from './missionSchedules'

const pick = (over: Partial<WhenPick>): WhenPick => ({ ...emptyPick(), ...over })

test('the default pick is "every Friday at 16:00"', () => {
  const r = scheduleRequest('Status', 'Compile it', emptyPick())
  assert.deepEqual(r, { ok: true, body: { title: 'Status', goal: 'Compile it', when: { every: 'week', day: 'Friday', time: '16:00' } } })
})

test('each kind sends only the fields it needs', () => {
  const body = (over: Partial<WhenPick>) => {
    const r = scheduleRequest('t', 'g', pick(over))
    assert.equal(r.ok, true)
    return r.ok ? r.body : null
  }
  assert.deepEqual(body({ every: 'day', time: '09:00' })?.when, { every: 'day', time: '09:00' })
  assert.deepEqual(body({ every: 'weekday', time: '08:30' })?.when, { every: 'weekday', time: '08:30' })
  assert.deepEqual(body({ every: 'month', dayOfMonth: '15', time: '10:00' })?.when, { every: 'month', time: '10:00', dayOfMonth: 15 })
  assert.deepEqual(body({ every: 'hours', hours: '3' })?.when, { every: 'hours', hours: 3 })
  assert.deepEqual(body({ every: 'event' }), { title: 't', goal: 'g', topic: 'meeting.ended' })
})

test('a missing name, goal or time is asked for in words', () => {
  assert.match((scheduleRequest('  ', 'g', emptyPick()) as { reason: string }).reason, /name/)
  assert.match((scheduleRequest('t', '', emptyPick()) as { reason: string }).reason, /what/)
  assert.match((scheduleRequest('t', 'g', pick({ time: '' })) as { reason: string }).reason, /time/)
})

test('every kind has a label, and the week starts on Sunday like the bridge', () => {
  for (const k of ['day', 'weekday', 'weekend', 'week', 'month', 'hours', 'event'] as const) assert.ok(EVERY_LABEL[k])
  assert.equal(DAY_NAMES[0], 'Sunday')
  assert.equal(DAY_NAMES[5], 'Friday')
})
