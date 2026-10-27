// Q75: the model is told what reflexes did, so a follow-up question about a
// timer gets a real answer. The brain here is a mock that answers only from
// what it is sent, as the real one must.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerReflex, matchReflex, matchReflexIn, type ReflexContext, type TimerView } from './reflex.ts'
import { makeReflexMemory, MAX_NOTE } from './reflexNote.ts'

const MIN = 60_000
const T0 = new Date(2026, 9, 26, 15, 5).getTime()

/**
 * A page in miniature: reflexes run on it, and anything else goes to the
 * brain with the reflex note as its context, the way App.respond does.
 */
function page(brain: (prompt: string, context: string) => string) {
  const memory = makeReflexMemory()
  let now = T0
  let timers: TimerView[] = []
  let volume = { level: 0.6, muted: false }
  let seq = 0
  const sent: string[] = []

  const say = (text: string): string | null => {
    const hit = matchReflexIn(text)
    if (hit) {
      const ctx: ReflexContext = { now: new Date(now), lastAnswer: '', volume, timers, ringing: false, locale: 'en-GB' }
      const a = answerReflex(hit.reflex, ctx)
      if (a.startTimer) timers.push({ id: `t${seq++}`, ms: a.startTimer.ms, endsAt: now + a.startTimer.ms, ...(a.startTimer.label ? { label: a.startTimer.label } : {}) })
      if (a.cancelTimers) timers = timers.filter((t) => !a.cancelTimers!.includes(t.id))
      if (a.volume) volume = a.volume
      memory.record(text, a.say, { volumeChanged: Boolean(a.volume), at: now })
      return a.say
    }
    const context = memory.note({ now: new Date(now), timers, volume })
    sent.push(context)
    const answer = brain(text, context)
    if (context) memory.sent()
    return answer
  }

  return {
    say,
    sent,
    wait(ms: number) {
      now += ms
      for (const t of timers.filter((t) => t.endsAt <= now)) memory.timerDone(t, t.endsAt)
      timers = timers.filter((t) => t.endsAt > now)
    },
  }
}

/** Answers "what was that timer for?" from its context alone, like a model would have to. */
const mockBrain = (prompt: string, context: string): string => {
  if (/what was that timer for/i.test(prompt)) {
    const m = /Timers running now: the (.+?) timer \(/.exec(context)
    return m ? `It's for the ${m[1].replace(/^the /, '')}.` : "I don't know of any timer, sir."
  }
  return 'Noted.'
}

test('a follow-up question about a timer is answered from the reflex note', () => {
  const p = page(mockBrain)
  assert.equal(p.say('Set a timer for 10 minutes for the pasta'), 'Timer set for 10 minutes for the pasta.')
  p.wait(2 * MIN)
  // Not a reflex: it goes to the brain.
  assert.equal(matchReflex('What was that timer for?'), null)
  assert.equal(p.say('What was that timer for?'), "It's for the pasta.")
  const note = p.sent[0]
  assert.match(note, /the user said "Set a timer for 10 minutes for the pasta" and you answered "Timer set for 10 minutes for the pasta\."/)
  assert.match(note, /Timers running now: the pasta timer \(10 minutes, set at 15:05, 8 minutes left\)\./)
})

test('without the note the same brain cannot answer', () => {
  assert.equal(mockBrain('What was that timer for?', ''), "I don't know of any timer, sir.")
})

test('a Hindi timer is told to the brain too', () => {
  const p = page(mockBrain)
  assert.match(p.say('चाय के लिए 5 मिनट का टाइमर लगाओ') ?? '', /Timer set for 5 minutes for चाय/)
  assert.equal(p.say('What was that timer for?'), "It's for the चाय.")
})

test('exchanges are told once; running timers every turn; finished timers once', () => {
  const p = page(mockBrain)
  p.say('Set a timer for 5 minutes')
  p.say('Louder')
  p.say('Tell me a joke')
  assert.match(p.sent[0], /said "Louder"/)
  assert.match(p.sent[0], /Your voice volume is 80 percent\./)
  p.say('And another one')
  assert.doesNotMatch(p.sent[1], /said "/)
  assert.match(p.sent[1], /Timers running now: the 5 minute timer/)
  p.wait(6 * MIN)
  p.say('How was it?')
  assert.match(p.sent[2], /The 5 minute timer finished at 15:10\./)
  assert.doesNotMatch(p.sent[2], /Timers running now/)
  p.say('Anything else?')
  assert.doesNotMatch(p.sent[3], /finished/)
})

test('nothing to tell: no note at all', () => {
  const p = page(mockBrain)
  p.say('Hello')
  assert.equal(p.sent[0], '')
})

test('stop is told as going quiet, and the note stays short', () => {
  const memory = makeReflexMemory()
  memory.record('stop', null, { at: T0 })
  const note = memory.note({ now: new Date(T0), timers: [], volume: { level: 0.6, muted: false } })
  assert.match(note, /said "stop" and you answered by going quiet\. No timers are running now\./)
  const long = makeReflexMemory()
  for (let i = 0; i < 5; i++) long.record('x'.repeat(500), 'y'.repeat(500), { at: T0 })
  const timers = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, ms: MIN, endsAt: T0 + MIN, label: `label number ${i}` }))
  const n = long.note({ now: new Date(T0), timers, volume: { level: 0.6, muted: true } })
  assert.ok(n.length <= MAX_NOTE, `note is ${n.length} characters`)
  assert.equal((n.match(/the user said/g) ?? []).length, 3)
})

test('a new conversation forgets everything', () => {
  const memory = makeReflexMemory()
  memory.record('louder', 'Volume 80 percent.', { volumeChanged: true, at: T0 })
  memory.clear()
  assert.equal(memory.note({ now: new Date(T0), timers: [], volume: { level: 0.8, muted: false } }), '')
})
