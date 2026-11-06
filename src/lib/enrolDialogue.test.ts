import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE, parseName, stepEnrol, type EnrolState } from './enrolDialogue.ts'

test('only the voice phrase starts it; other talk is left alone', () => {
  assert.equal(stepEnrol(IDLE, "what's the weather").handled, false)
  const r = stepEnrol(IDLE, 'Jarvis, learn my voice')
  assert.equal(r.handled, true)
  assert.equal(r.state.step, 'consent')
  assert.match(r.say, /on this computer/)
})

test('nothing is recorded without a spoken yes', () => {
  const asked = stepEnrol(IDLE, 'remember my voice').state
  for (const no of ['no', 'what time is it', 'no thanks', 'yes but no']) {
    const r = stepEnrol(asked, no)
    assert.equal(r.state.step, 'idle', no)
    assert.equal(r.startSample, undefined, no)
    assert.equal(r.enrol, undefined, no)
  }
})

test('yes, then a name, then the sample is enrolled under that name', () => {
  let s: EnrolState = stepEnrol(IDLE, 'learn my voice').state
  let r = stepEnrol(s, 'yes please')
  assert.equal(r.state.step, 'name')
  s = r.state
  r = stepEnrol(s, "I'm Priya")
  assert.deepEqual(r.state, { step: 'sample', name: 'Priya' })
  assert.equal(r.startSample, true)
  s = r.state
  r = stepEnrol(s, 'I had a long day at work today')
  assert.deepEqual(r.enrol, { name: 'Priya' })
  assert.equal(r.state.step, 'idle')
})

test('a bad name is asked for again; cancelling at the name step stops', () => {
  const s: EnrolState = { step: 'name' }
  const r = stepEnrol(s, 'a b c d e f g')
  assert.equal(r.state.step, 'name')
  assert.equal(stepEnrol(s, 'never mind').state.step, 'idle')
})

test('parseName', () => {
  assert.equal(parseName('my name is Dhananjay'), 'Dhananjay')
  assert.equal(parseName("It's Mary Ann."), 'Mary Ann')
  assert.equal(parseName('delete everything now please ok'), null)
  assert.equal(parseName('12345'), null)
})
