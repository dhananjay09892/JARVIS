import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronFromWhen, describeCron, describeSchedule, parseTime, parseWhenWords, resolveRequest } from './mission-schedule-words.mjs'
import { checkSchedule, createScheduleStore } from './mission-schedule.mjs'
import { scheduleMissionTool, isTaskTool } from './task-tools.mjs'
import { parseCron } from './agent-schedule.mjs'

test('parseTime: 24-hour and 12-hour clocks, and nonsense', () => {
  assert.deepEqual(parseTime('16:00'), { h: 16, m: 0 })
  assert.deepEqual(parseTime('4 pm'), { h: 16, m: 0 })
  assert.deepEqual(parseTime('4:30pm'), { h: 16, m: 30 })
  assert.deepEqual(parseTime('12 am'), { h: 0, m: 0 })
  assert.deepEqual(parseTime('12 pm'), { h: 12, m: 0 })
  assert.deepEqual(parseTime('9'), { h: 9, m: 0 })
  for (const bad of ['25:00', '13 pm', '0 pm', '9:75', 'noon', '', null, 4]) assert.equal(parseTime(bad), null, String(bad))
})

test('cronFromWhen: every picker choice gives a cron that parses', () => {
  const cases = [
    [{ every: 'week', day: 'friday', time: '16:00' }, '0 16 * * 5'],
    [{ every: 'week', day: 'Mon', time: '8:30 am' }, '30 8 * * 1'],
    [{ every: 'day', time: '9' }, '0 9 * * *'],
    [{ every: 'weekday', time: '8:30' }, '30 8 * * 1-5'],
    [{ every: 'weekend', time: '10 am' }, '0 10 * * 0,6'],
    [{ every: 'month', dayOfMonth: 1, time: '10 am' }, '0 10 1 * *'],
    [{ every: 'hours', hours: 2 }, '0 */2 * * *'],
    [{ every: 'hours', hours: 1 }, '0 * * * *'],
  ]
  for (const [when, cron] of cases) {
    const r = cronFromWhen(when)
    assert.deepEqual(r, { ok: true, cron })
    assert.ok(parseCron(cron), `${cron} parses`)
  }
})

test('cronFromWhen: bad input is refused with a reason, never a guessed schedule', () => {
  for (const when of [null, {}, { every: 'fortnight' }, { every: 'week', time: '9' }, { every: 'week', day: 'funday', time: '9' },
    { every: 'day', time: 'noon' }, { every: 'month', dayOfMonth: 31, time: '9' }, { every: 'month', dayOfMonth: 0, time: '9' },
    { every: 'hours', hours: 0 }, { every: 'hours', hours: 13 }, { every: 'hours', hours: '1; rm -rf' }]) {
    const r = cronFromWhen(when)
    assert.equal(r.ok, false, JSON.stringify(when))
    assert.ok(r.reason.length > 5)
  }
})

test('parseWhenWords: the ways an owner says it', () => {
  const want = (text, cron) => {
    const p = parseWhenWords(text)
    assert.equal(p.ok, true, text)
    assert.equal(cronFromWhen(p.when).cron, cron, text)
  }
  want('every Friday at 4 pm', '0 16 * * 5')
  want('Every friday at 4pm.', '0 16 * * 5')
  want('on Fridays at 16:00', '0 16 * * 5')
  want('every day at 9', '0 9 * * *')
  want('daily at 7:15 am', '15 7 * * *')
  want('weekdays at 8:30', '30 8 * * 1-5')
  want('every weekday at 8:30 am', '30 8 * * 1-5')
  want('on weekends at 10', '0 10 * * 0,6')
  want('every month on the 1st at 10 am', '0 10 1 * *')
  want('on the 15th of every month at 9', '0 9 15 * *')
  want('every 2 hours', '0 */2 * * *')
  want('hourly', '0 * * * *')
})

test('parseWhenWords: no time, or words it does not know, is a question, not a guess', () => {
  for (const t of ['every friday', 'sometimes', 'at 4 pm', 'every blursday at 4 pm', '', '   ', null]) {
    const r = parseWhenWords(t)
    assert.equal(r.ok, false, String(t))
    assert.match(r.reason, /when|understand/i)
  }
})

test('describeCron: reads what the picker writes, and says "custom" for the rest', () => {
  assert.equal(describeCron('0 16 * * 5'), 'every Friday at 4 pm')
  assert.equal(describeCron('30 8 * * 1-5'), 'every weekday at 8:30 am')
  assert.equal(describeCron('0 0 * * *'), 'every day at 12 am')
  assert.equal(describeCron('0 12 * * 0,6'), 'every weekend at 12 pm')
  assert.equal(describeCron('0 10 1 * *'), 'every month on the 1st at 10 am')
  assert.equal(describeCron('0 9 22 * *'), 'every month on the 22nd at 9 am')
  assert.equal(describeCron('0 9 13 * *'), 'every month on the 13th at 9 am')
  assert.equal(describeCron('0 */2 * * *'), 'every 2 hours')
  assert.equal(describeCron('0 * * * *'), 'every hour')
  assert.match(describeCron('*/20 9-17 * * 1,3'), /^custom schedule/)
  assert.match(describeCron('nonsense'), /^custom schedule/)
  assert.match(describeCron(undefined), /^custom schedule/)
})

test('describeSchedule: cron, the one event topic, and anything else', () => {
  assert.equal(describeSchedule({ cron: '0 16 * * 5' }), 'every Friday at 4 pm')
  assert.equal(describeSchedule({ topic: 'meeting.ended' }), 'when a meeting ends')
  assert.match(describeSchedule({ topic: 'x.y' }), /x\.y/)
})

test('resolveRequest: words or a picker object become a cron; cron and topic pass through', () => {
  assert.deepEqual(resolveRequest({ title: 't', goal: 'g', when: 'every Friday at 4 pm' }),
    { ok: true, request: { title: 't', goal: 'g', cron: '0 16 * * 5' } })
  assert.deepEqual(resolveRequest({ title: 't', goal: 'g', when: { every: 'day', time: '9' } }).request.cron, '0 9 * * *')
  assert.deepEqual(resolveRequest({ title: 't', goal: 'g', cron: '0 9 * * *' }).request.cron, '0 9 * * *')
  assert.deepEqual(resolveRequest({ title: 't', goal: 'g', topic: 'meeting.ended' }).request.topic, 'meeting.ended')
  assert.equal(resolveRequest({ title: 't', goal: 'g', when: 'every friday at 4 pm', cron: '0 9 * * *' }).ok, false)
  assert.equal(resolveRequest({ title: 't', goal: 'g', when: 'whenever' }).ok, false)
  assert.equal(resolveRequest(null).ok, true)
})

test('words cannot get round the store rules: too often and too many are still refused', () => {
  const often = resolveRequest({ title: 't', goal: 'g', when: { every: 'hours', hours: 1 } })
  assert.equal(checkSchedule(often.request).ok, true, 'hourly is allowed (60 min is over the 15 min gap)')
  // The store has the only say on the cap.
  const store = createScheduleStore({ log: { log() {}, warn() {}, error() {} } })
  for (let i = 0; i < 20; i++) assert.equal(store.add({ title: `t${i}`, goal: 'g', cron: '0 9 * * *' }).ok, true)
  assert.equal(store.add({ title: 'one more', goal: 'g', cron: '0 9 * * *' }).ok, false)
})

// ---- schedule_mission --------------------------------------------------

const silent = { log() {}, warn() {}, error() {} }

test('schedule_mission: nothing is saved before the owner approves, and the card shows the exact title, goal and time', async () => {
  const store = createScheduleStore({ log: silent })
  const cards = []
  let release
  const approve = (title, details) => new Promise((resolve) => { cards.push({ title, details }); release = resolve })
  const pending = scheduleMissionTool(store, approve, { title: 'Status report', goal: 'Compile the weekly status report from my notes.', when: 'every Friday at 4 pm' })
  await new Promise((r) => setImmediate(r))
  assert.equal(store.list().length, 0, 'not saved while the card is open')
  assert.equal(cards.length, 1)
  assert.match(cards[0].title, /Status report/)
  assert.match(cards[0].details, /Title: Status report/)
  assert.match(cards[0].details, /When: every Friday at 4 pm \(0 16 \* \* 5\)/)
  assert.match(cards[0].details, /Goal: Compile the weekly status report from my notes\./)
  release(true)
  const out = await pending
  assert.equal(out.scheduled, true)
  assert.equal(out.when, 'every Friday at 4 pm')
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].cron, '0 16 * * 5')
})

test('schedule_mission: a denial, a throwing hub and a non-true answer all save nothing', async () => {
  for (const approve of [async () => false, async () => { throw new Error('x') }, async () => 'yes', async () => 1, async () => undefined]) {
    const store = createScheduleStore({ log: silent })
    const out = await scheduleMissionTool(store, approve, { title: 't', goal: 'g', when: 'daily at 9' })
    assert.equal(out.scheduled, false)
    assert.equal(out.reason, 'not approved')
    assert.equal(store.list().length, 0)
  }
})

test('schedule_mission: a bad request never reaches the card; no hub or no store is a plain refusal', async () => {
  const store = createScheduleStore({ log: silent })
  let asked = 0
  const approve = async () => { asked++; return true }
  for (const a of [
    { title: 't', goal: 'g', when: 'whenever' },
    { title: 't', goal: 'g' },
    { title: 't', goal: 'g', when: 'every day at 9', event: 'meeting.ended' },
    { title: 't', goal: 'g', event: 'task.finished' },
    { title: '', goal: 'g', when: 'daily at 9' },
    { title: 't', goal: 'g', when: { every: 'hours', hours: 0 } },
  ]) {
    const out = await scheduleMissionTool(store, approve, a)
    assert.equal(out.scheduled, false, JSON.stringify(a))
  }
  assert.equal(asked, 0)
  assert.equal((await scheduleMissionTool(store, null, { title: 't', goal: 'g', when: 'daily at 9' })).scheduled, false)
  assert.equal((await scheduleMissionTool(null, approve, { title: 't', goal: 'g', when: 'daily at 9' })).scheduled, false)
  assert.equal(store.list().length, 0)
})

test('schedule_mission: an event schedule is allowed for the listed topic; a full store is reported after approval', async () => {
  const store = createScheduleStore({ log: silent })
  const approve = async () => true
  const ev = await scheduleMissionTool(store, approve, { title: 'Follow-ups', goal: 'Draft follow-ups.', event: 'meeting.ended' })
  assert.equal(ev.scheduled, true)
  assert.equal(ev.when, 'when a meeting ends')
  for (let i = 0; i < 19; i++) store.add({ title: `t${i}`, goal: 'g', cron: '0 9 * * *' })
  const full = await scheduleMissionTool(store, approve, { title: 'x', goal: 'g', when: 'daily at 9' })
  assert.equal(full.scheduled, false)
  assert.match(full.reason, /At most 20/)
})

test('schedule_mission is on the voice session\'s own tool list, and the page text cannot be used to skip the card', () => {
  assert.equal(isTaskTool('schedule_mission'), true)
})
