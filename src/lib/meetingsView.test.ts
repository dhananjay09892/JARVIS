import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canStart, keepDaysProblem, meetingStatsText, minutesRowText } from './meetingsView.ts'
// @ts-expect-error plain JS bridge module, no type declarations
import { REGISTRY } from '../../bridge/settings-registry.mjs'
// @ts-expect-error plain JS bridge module, no type declarations
import { minutesAccuracy } from '../../bridge/meeting-capture.mjs'
// @ts-expect-error plain JS bridge module, no type declarations
import { LABELLED_CALL } from '../../bridge/meeting-selfcheck.mjs'

test('keep days agree with the bridge setting pattern', () => {
  const def = (REGISTRY as { id: string; pattern?: RegExp }[]).find((s) => s.id === 'JARVIS_MEETINGS_KEEP_DAYS')!
  for (const v of ['1', '30', '365', '0', '366', '', 'x', '1.5', '-3', '1000', ' 7 ']) {
    assert.equal(keepDaysProblem(v) === null, def.pattern!.test(v.trim()), JSON.stringify(v))
  }
})

test('Start needs the switch, the notice shown, the consent box, and no meeting running', () => {
  const ok = { enabled: true, noticeShown: true, consent: true, capturing: false }
  assert.equal(canStart(ok), true)
  for (const k of ['enabled', 'noticeShown', 'consent'] as const) assert.equal(canStart({ ...ok, [k]: false }), false, k)
  assert.equal(canStart({ ...ok, capturing: true }), false)
})

test('minutes rows and the Diagnostics line show counts only', () => {
  assert.equal(minutesRowText({ id: 'x', title: 'Sync', startedAt: 0, endedAt: 1, decisions: 1, actions: 3, pending: 2 }), 'Sync · 1 decision · 3 actions (2 waiting)')
  assert.equal(minutesRowText({ id: 'x', title: 'Sync', startedAt: 0, endedAt: 1, decisions: 0, actions: 0, pending: 0 }), 'Sync · 0 decisions · 0 actions')
  assert.equal(meetingStatsText(null), 'off')
  assert.equal(meetingStatsText({ enabled: false }), 'off')
  const accuracy = minutesAccuracy(LABELLED_CALL)
  const line = meetingStatsText({ enabled: true, saved: 2, capturing: null, accuracy })
  assert.match(line, /^idle · 2 saved · action items 3\/3 on the test call \(100% found, 100% right\)$/)
  assert.match(meetingStatsText({ enabled: true, saved: 0, capturing: { id: 'a', title: 'secret title', startedAt: 0, lines: 4 } }), /^capturing, 4 lines · 0 saved$/)
})
