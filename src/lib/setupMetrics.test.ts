// Plan 29 phase 1 + plan 16 (Q77): the wizard tracker on the page, run end to
// end into the bridge's store. "Done when": a completed and an abandoned
// wizard are counted correctly with metrics on, nothing stored with them off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardTracker, type SetupEvent } from './setupMetrics.ts'
// @ts-expect-error: plain JavaScript module from the bridge, no type declarations
import { createSetupMetrics } from '../../bridge/setup-metrics.mjs'

function rig(t: { after: (fn: () => void) => void }, on: { value: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-wizard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'setup-metrics.json')
  // The bridge checks the setting too; here both sides read the same switch.
  const store = createSetupMetrics({ enabled: () => on.value, file })
  let n = 0
  const sent: SetupEvent[] = []
  const tracker = createWizardTracker({
    enabled: () => on.value,
    newId: () => `run-test-${++n}`,
    send: (e) => {
      sent.push(e)
      store.record(e)
    },
  })
  return { store, tracker, sent, file }
}

test('a completed and an abandoned wizard, counted correctly with metrics on', (t) => {
  const { store, tracker } = rig(t, { value: true })

  // First pass: through every step and Finish.
  tracker.open()
  tracker.step(1)
  tracker.step(2)
  tracker.step(3)
  tracker.complete()

  // Second pass ("Run setup wizard again"): reaches the Claude step, and the
  // page is closed. Nothing more is sent: that silence is what "abandoned" is.
  tracker.open()
  tracker.step(1)

  const s = store.stats()
  assert.equal(s.runs, 2)
  assert.equal(s.completed, 1)
  assert.equal(s.abandoned, 1)
  assert.equal(s.completionRate, 0.5)
  assert.equal(s.leftAt.claude, 1)
})

test('nothing is stored with metrics off', (t) => {
  const { tracker, sent, file } = rig(t, { value: false })
  tracker.open()
  tracker.step(1)
  tracker.selftest(['mic-muted'])
  tracker.skip()
  assert.equal(sent.length, 0)
  assert.equal(existsSync(file), false)
})

test('turned on part-way: counted from then on', (t) => {
  const on = { value: false }
  const { store, tracker } = rig(t, on)
  tracker.open()
  on.value = true
  tracker.step(1)
  tracker.skip()
  const s = store.stats()
  assert.equal(s.runs, 1)
  assert.equal(s.skipped, 1)
  assert.equal(s.leftAt.claude, 1)
})

test('the self-test is counted with its problem ids, in the wizard and from Settings', (t) => {
  const { store, tracker, sent } = rig(t, { value: true })
  tracker.open()
  tracker.selftest(['mic-wrong-device'])
  tracker.complete()
  tracker.selftest([])
  assert.equal(sent[1].kind, 'selftest')
  assert.equal((sent[1] as { place: string }).place, 'wizard')
  assert.equal((sent[3] as { place: string }).place, 'settings')
  const s = store.stats()
  assert.equal(s.selftest.runs, 2)
  assert.equal(s.selftest.clean, 1)
  assert.deepEqual(s.selftest.failures, [{ id: 'mic-wrong-device', count: 1 }])
  // A self-test from Settings is not a wizard run.
  assert.equal(s.runs, 1)
})

test('moving to the same step twice sends one event; nothing after the wizard closes', (t) => {
  const { tracker, sent } = rig(t, { value: true })
  tracker.open()
  tracker.step(0)
  tracker.step(1)
  tracker.step(1)
  tracker.complete()
  tracker.step(2)
  tracker.skip()
  assert.deepEqual(
    sent.map((e) => e.kind),
    ['start', 'reach', 'complete'],
  )
})
