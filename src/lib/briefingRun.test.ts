// Plan 12 block 5 (Q34): the page's side of the morning briefing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSection, sectionsFrom, type BriefingRun } from './briefingRun.ts'

test('sectionsFrom keeps only well-formed sections, clipped', () => {
  assert.deepEqual(sectionsFrom(null), [])
  assert.deepEqual(sectionsFrom('x'), [])
  const got = sectionsFrom([
    { id: 'greeting', say: ' Good morning. ' },
    { id: 'weather' },
    { say: 'no id' },
    { id: 'calendar', say: '   ' },
    null,
    { id: 'mail', say: 'x'.repeat(5000) },
  ])
  assert.deepEqual(got.map((s) => s.id), ['greeting', 'mail'])
  assert.equal(got[0].say, 'Good morning.')
  assert.equal(got[1].say.length, 1200)
  assert.equal(sectionsFrom(Array.from({ length: 30 }, () => ({ id: 'held', say: 'a' }))).length, 10)
})

test('nextSection walks the run, so a skip lands on the section after the one cut off', () => {
  const run: BriefingRun = { sections: sectionsFrom([{ id: 'greeting', say: 'a' }, { id: 'weather', say: 'b' }, { id: 'calendar', say: 'c' }]), next: 0 }
  assert.equal(nextSection(run)?.id, 'greeting')
  // Talked over during the weather: it was taken, so "skip" goes on to the calendar.
  assert.equal(nextSection(run)?.id, 'weather')
  assert.equal(nextSection(run)?.id, 'calendar')
  assert.equal(nextSection(run), null)
  assert.equal(nextSection(null), null)
})
