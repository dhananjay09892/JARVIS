// Plan 12 block 5 (Q34): the page's side of the morning briefing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSection, offerFrom, offerStillOpen, OFFER_OPEN_MS, sectionsFrom, type BriefingRun } from './briefingRun.ts'

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

test('offerFrom: only a real offer with something to say (Q78)', () => {
  assert.deepEqual(offerFrom({ offer: true, say: ' Good morning, sir. Your briefing is ready. Shall I go ahead? ' }), { say: 'Good morning, sir. Your briefing is ready. Shall I go ahead?' })
  assert.equal(offerFrom({ offer: false, why: 'not-yet' }), null)
  assert.equal(offerFrom({ offer: true }), null)
  assert.equal(offerFrom({ offer: 'yes', say: 'x' }), null)
  assert.equal(offerFrom(null), null)
  assert.equal(offerFrom('offer'), null)
  assert.equal(offerFrom({ offer: true, say: 'x'.repeat(1000) })?.say.length, 200)
})

test('an offer stays open for a minute', () => {
  assert.equal(offerStillOpen(0, 1000), false, 'no offer made')
  assert.equal(offerStillOpen(1000, 1000 + OFFER_OPEN_MS), true)
  assert.equal(offerStillOpen(1000, 1001 + OFFER_OPEN_MS), false)
  assert.equal(offerStillOpen(5000, 1000), false, 'a clock that went backwards')
})
