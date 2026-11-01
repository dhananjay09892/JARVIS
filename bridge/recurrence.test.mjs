// Plan 12 building block 5 (Q78): repeating calendar events for the briefing.
// Dates are local calendar dates, so these pass in any time zone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { occursOn, parseRecurrence, recurrenceLines } from './recurrence.mjs'

const on = (lines, startDate, onDate, startMs) => occursOn(parseRecurrence(lines), { startDate, onDate, startMs })

test('weekly on the start weekday, and every other week', () => {
  // 2026-10-05 is a Monday.
  const weekly = ['RRULE:FREQ=WEEKLY']
  assert.equal(on(weekly, '2026-10-05', '2026-10-05'), true, 'the first occurrence is the start')
  assert.equal(on(weekly, '2026-10-05', '2026-11-02'), true)
  assert.equal(on(weekly, '2026-10-05', '2026-11-03'), false)
  assert.equal(on(weekly, '2026-10-05', '2026-09-28'), false, 'never before it started')
  const fortnightly = ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO']
  assert.equal(on(fortnightly, '2026-10-05', '2026-10-19'), true)
  assert.equal(on(fortnightly, '2026-10-05', '2026-10-26'), false)
  assert.equal(on(fortnightly, '2026-10-05', '2026-11-02'), true)
})

test('weekly on several days, with week start', () => {
  const r = ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR']
  assert.equal(on(r, '2026-10-05', '2026-10-28'), true) // Wednesday
  assert.equal(on(r, '2026-10-05', '2026-10-29'), false) // Thursday
  // Every other week from a Sunday start, week starting Monday vs Sunday.
  const mo = ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO']
  const su = ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU']
  // 2026-10-04 is a Sunday. With WKST=MO, Mon 10-05 is already the next week.
  assert.equal(on(mo, '2026-10-04', '2026-10-05'), false)
  assert.equal(on(su, '2026-10-04', '2026-10-05'), true)
})

test('daily, with COUNT and UNTIL', () => {
  assert.equal(on(['RRULE:FREQ=DAILY'], '2026-10-01', '2026-11-01'), true)
  assert.equal(on(['RRULE:FREQ=DAILY;INTERVAL=3'], '2026-10-01', '2026-10-04'), true)
  assert.equal(on(['RRULE:FREQ=DAILY;INTERVAL=3'], '2026-10-01', '2026-10-05'), false)
  assert.equal(on(['RRULE:FREQ=DAILY;COUNT=5'], '2026-10-01', '2026-10-05'), true)
  assert.equal(on(['RRULE:FREQ=DAILY;COUNT=5'], '2026-10-01', '2026-10-06'), false)
  assert.equal(on(['RRULE:FREQ=DAILY;UNTIL=20261010'], '2026-10-01', '2026-10-10'), true)
  assert.equal(on(['RRULE:FREQ=DAILY;UNTIL=20261010'], '2026-10-01', '2026-10-11'), false)
  // Weekdays only.
  assert.equal(on(['RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'], '2026-10-01', '2026-10-31'), false) // Saturday
})

test('a timed UNTIL compares the occurrence start', () => {
  const start = new Date(2026, 9, 1, 9, 0).getTime()
  const untilMs = new Date(2026, 9, 3, 9, 0).getTime()
  const u = new Date(untilMs)
  const stamp = `${u.getUTCFullYear()}${String(u.getUTCMonth() + 1).padStart(2, '0')}${String(u.getUTCDate()).padStart(2, '0')}T${String(u.getUTCHours()).padStart(2, '0')}${String(u.getUTCMinutes()).padStart(2, '0')}00Z`
  const r = [`RRULE:FREQ=DAILY;UNTIL=${stamp}`]
  assert.equal(on(r, '2026-10-01', '2026-10-03', start), true)
  assert.equal(on(r, '2026-10-01', '2026-10-04', start), false)
})

test('monthly by date, by weekday ordinal and from the end', () => {
  assert.equal(on(['RRULE:FREQ=MONTHLY'], '2026-01-15', '2026-11-15'), true)
  assert.equal(on(['RRULE:FREQ=MONTHLY'], '2026-01-15', '2026-11-16'), false)
  assert.equal(on(['RRULE:FREQ=MONTHLY;INTERVAL=2'], '2026-01-15', '2026-02-15'), false)
  // Second Tuesday: 2026-11-10.
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYDAY=2TU'], '2026-01-13', '2026-11-10'), true)
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYDAY=2TU'], '2026-01-13', '2026-11-03'), false)
  // Last Friday: 2026-11-27.
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], '2026-01-30', '2026-11-27'), true)
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], '2026-01-30', '2026-11-20'), false)
  // Last day of the month.
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'], '2026-01-31', '2026-11-30'), true)
  assert.equal(on(['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'], '2026-01-31', '2026-11-29'), false)
})

test('yearly birthdays and the like', () => {
  assert.equal(on(['RRULE:FREQ=YEARLY'], '2020-11-01', '2026-11-01'), true)
  assert.equal(on(['RRULE:FREQ=YEARLY'], '2020-11-01', '2026-10-01'), false)
  // Thanksgiving: fourth Thursday of November, 2026-11-26.
  assert.equal(on(['RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'], '2020-11-26', '2026-11-26'), true)
  assert.equal(on(['RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'], '2020-11-26', '2026-11-19'), false)
})

test('EXDATE removes an occurrence', () => {
  const r = ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Asia/Kolkata:20261102T093000,20261109T093000']
  assert.equal(on(r, '2026-10-05', '2026-11-02'), false)
  assert.equal(on(r, '2026-10-05', '2026-11-09'), false)
  assert.equal(on(r, '2026-10-05', '2026-11-16'), true)
  assert.equal(on(['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20261101'], '2026-10-01', '2026-11-01'), false)
})

test('rules it does not understand never produce an occurrence', () => {
  for (const r of [
    ['RRULE:FREQ=HOURLY'],
    ['RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1'],
    ['RRULE:FREQ=WEEKLY;BYDAY=2MO'],
    ['RRULE:FREQ=DAILY;INTERVAL=0'],
    ['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY'],
    ['RRULE:nonsense'],
    [],
    null,
  ]) {
    assert.equal(parseRecurrence(r).rule, null, JSON.stringify(r))
    assert.equal(on(r, '2026-10-05', '2026-11-02'), false, JSON.stringify(r))
  }
  assert.equal(on(['RRULE:FREQ=DAILY'], 'not a date', '2026-11-02'), false)
})

test('a COUNT too far back is not followed forever', () => {
  assert.equal(on(['RRULE:FREQ=DAILY;COUNT=100000'], '2000-01-01', '2026-11-01'), false)
})

test('recurrenceLines reads the connector header, never the description', () => {
  const header = [
    '<untrusted_data source="connector:gcalendar">',
    'When: 2026-10-05T09:30:00+01:00 – 2026-10-05T09:45:00+01:00',
    'Repeats: RRULE:FREQ=WEEKLY;BYDAY=MO; EXDATE;TZID=Europe/London:20261102T093000',
    'Calendar: Work',
  ]
  assert.deepEqual(recurrenceLines({ text: header.join('\n') }), ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/London:20261102T093000'])
  const sneaky = ['When: 2026-10-05', 'Calendar: Work', '', 'Repeats: RRULE:FREQ=DAILY'].join('\n')
  assert.deepEqual(recurrenceLines({ text: sneaky }), [], 'a description cannot add a rule')
  assert.deepEqual(recurrenceLines({ text: 'Repeats: RRULE:FREQ=DAILY <b>' }), [], 'odd characters: not a rule')
  assert.deepEqual(recurrenceLines({ meta: { recurrence: ['RRULE:FREQ=DAILY', 3] } }), ['RRULE:FREQ=DAILY'], 'meta.recurrence wins when the connector gives it')
  assert.deepEqual(recurrenceLines(null), [])
})
