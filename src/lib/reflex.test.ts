// Plan 06 phase 1 (Q25): the reflex layer. Table-driven: what must be a
// reflex, and, as important, what must still reach the model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerReflex,
  familyOf,
  matchReflex,
  nextVolume,
  normalise,
  parseDuration,
  parseNumber,
  speakDate,
  speakDuration,
  speakTime,
  timerDoneLine,
  MAX_TIMERS,
  REFLEX_FAMILIES,
  VOLUME_FLOOR,
  type Reflex,
  type ReflexContext,
  type TimerView,
} from './reflex.ts'

const MIN = 60_000
const HOUR = 3600_000

const HITS: [string, Reflex][] = [
  // stop
  ['Stop.', { kind: 'stop' }],
  ['stop stop', { kind: 'stop' }],
  ['OK, stop', { kind: 'stop' }],
  ['Never mind.', { kind: 'stop' }],
  ["That's all, thanks.", { kind: 'stop' }],
  ['Be quiet please', { kind: 'stop' }],
  ['Cancel that', { kind: 'stop' }],
  ['Forget it', { kind: 'stop' }],
  // time and date
  ['What time is it?', { kind: 'time' }],
  ["What's the time now?", { kind: 'time' }],
  ['Can you tell me the time please?', { kind: 'time' }],
  ["What’s the date today?", { kind: 'date' }],
  ['What day is it?', { kind: 'date' }],
  ["Today's date", { kind: 'date' }],
  // repeat
  ['Say that again', { kind: 'repeat' }],
  ['Could you repeat that, please?', { kind: 'repeat' }],
  ['Pardon?', { kind: 'repeat' }],
  ["Sorry, I didn't catch that", { kind: 'repeat' }],
  // volume
  ['Volume up', { kind: 'volume', op: 'up' }],
  ['Louder', { kind: 'volume', op: 'up' }],
  ['Turn it up a bit', { kind: 'volume', op: 'up' }],
  ['Speak up', { kind: 'volume', op: 'up' }],
  ['Quieter please', { kind: 'volume', op: 'down' }],
  ['Turn the volume down', { kind: 'volume', op: 'down' }],
  ['Mute', { kind: 'volume', op: 'mute' }],
  ['unmute yourself', { kind: 'volume', op: 'unmute' }],
  ['Set the volume to 40 percent', { kind: 'volume', op: 'set', level: 0.4 }],
  ['volume 7', { kind: 'volume', op: 'set', level: 0.7 }],
  ['Volume to seventy', { kind: 'volume', op: 'set', level: 0.7 }],
  ['volume 30%', { kind: 'volume', op: 'set', level: 0.3 }],
  // timers
  ['Set a timer for 5 minutes', { kind: 'timer-set', ms: 5 * MIN }],
  ['Set a timer for five minutes.', { kind: 'timer-set', ms: 5 * MIN }],
  ['set a five minute timer', { kind: 'timer-set', ms: 5 * MIN }],
  ['Timer for 90 seconds', { kind: 'timer-set', ms: 90_000 }],
  ['Start a 10-minute timer for the pasta', { kind: 'timer-set', ms: 10 * MIN, label: 'the pasta' }],
  ['Set a timer for twenty five minutes for tea', { kind: 'timer-set', ms: 25 * MIN, label: 'tea' }],
  ['Set a timer for an hour and a half', { kind: 'timer-set', ms: 1.5 * HOUR }],
  ['Set a timer for 1 hour 30 minutes', { kind: 'timer-set', ms: 1.5 * HOUR }],
  ['Set a timer for half an hour', { kind: 'timer-set', ms: 30 * MIN }],
  ['Jarvis could you set me a timer for 2 minutes and 30 seconds please', { kind: 'timer-set', ms: 150_000 }],
  ['Cancel the timer', { kind: 'timer-cancel', all: false }],
  ['Stop the timer', { kind: 'timer-cancel', all: false }],
  ['Cancel all timers', { kind: 'timer-cancel', all: true }],
  ['Cancel all the timers', { kind: 'timer-cancel', all: true }],
  ['Cancel the pasta timer', { kind: 'timer-cancel', all: false, label: 'pasta' }],
  ['How much time is left on the timer?', { kind: 'timer-query' }],
  ['How long left on my timer', { kind: 'timer-query' }],
  ["What's left on the timer?", { kind: 'timer-query' }],
  ['Any timers running?', { kind: 'timer-query' }],
]

for (const [said, want] of HITS) {
  test(`reflex: "${said}"`, () => {
    // The page strips a leading vocative before this; the one case above with
    // "Jarvis" in it checks a stray one still fails safe or matches cleanly.
    const got = matchReflex(said.replace(/^jarvis\s+/i, ''))
    assert.deepEqual(got, want)
  })
}

// Everything here must go to the model: a reflex that fires on these would
// answer the wrong question, or act where the owner asked for something else.
const MISSES = [
  'Stop the car rental subscription',
  'Stop my 3pm meeting from repeating',
  'Cancel my dentist appointment',
  'What time is it in Tokyo?',
  'What time is the match tonight?',
  'What date is Diwali this year?',
  'Repeat after me: hello world',
  'Turn up the heating',
  'Turn the lights down',
  'Turn down the offer politely in an email',
  'Mute the TV',
  'Volume of a sphere with radius 3',
  'Set a timer for when the laundry is done',
  'Set a timer for 3 days',
  'Set a timer for 0 seconds',
  'Remind me in 5 minutes to call mum',
  'How long does it take to boil an egg?',
  'What is the time complexity of quicksort?',
  'Tell me about the history of timers',
  'Stop being so formal from now on',
  'Is it louder in a city or a forest?',
  'Thank you',
  'Never mind the email, what about the calendar?',
  '',
  '   ',
]

for (const said of MISSES) {
  test(`not a reflex: "${said}"`, () => {
    assert.equal(matchReflex(said), null)
  })
}

test('normalise trims polite words and punctuation but keeps decimals', () => {
  assert.equal(normalise('Okay, can you please set a timer for 1.5 hours now, thanks!'), 'set a timer for 1.5 hours')
  assert.equal(normalise('Stop… sir.'), 'stop')
})

test('numbers and durations', () => {
  assert.equal(parseNumber('twenty five'), 25)
  assert.equal(parseNumber('an'), 1)
  assert.equal(parseNumber('twenty zero'), null)
  assert.equal(parseNumber('banana'), null)
  assert.equal(parseDuration('1.5 hours'), 1.5 * HOUR)
  assert.equal(parseDuration('a minute and a half'), 90_000)
  assert.equal(parseDuration('a minute and 20 seconds'), 80_000)
  assert.equal(parseDuration('a couple of minutes'), 2 * MIN)
  assert.equal(parseDuration('5 minutes for later'), null)
  assert.equal(parseDuration('minutes'), null)
})

test('durations are spoken plainly', () => {
  assert.equal(speakDuration(5 * MIN), '5 minutes')
  assert.equal(speakDuration(MIN), '1 minute')
  assert.equal(speakDuration(1.5 * HOUR), '1 hour and 30 minutes')
  assert.equal(speakDuration(2 * MIN + 5000), '2 minutes and 5 seconds')
  assert.equal(speakDuration(HOUR + 3000), '1 hour')
  assert.equal(speakDuration(400), '0 seconds')
})

test('time and date are spoken naturally', () => {
  const d = new Date(2026, 9, 26, 15, 5)
  assert.match(speakTime(d, 'en-US'), /^3:05\sPM$/)
  assert.equal(speakTime(d, 'en-GB'), '15:05')
  assert.equal(speakDate(d), 'Monday, the 26th of October')
  assert.equal(speakDate(new Date(2026, 9, 1)), 'Thursday, the 1st of October')
  assert.equal(speakDate(new Date(2026, 9, 12)), 'Monday, the 12th of October')
  assert.equal(speakDate(new Date(2026, 9, 22)), 'Thursday, the 22nd of October')
})

test('volume steps, floors, mutes and remembers the level', () => {
  assert.deepEqual(nextVolume({ level: 0.6, muted: false }, 'up'), { level: 0.8, muted: false })
  assert.deepEqual(nextVolume({ level: 1, muted: false }, 'up'), { level: 1, muted: false })
  assert.deepEqual(nextVolume({ level: 0.2, muted: false }, 'down'), { level: VOLUME_FLOOR, muted: false })
  assert.deepEqual(nextVolume({ level: 0.6, muted: false }, 'mute'), { level: 0.6, muted: true })
  assert.deepEqual(nextVolume({ level: 0.6, muted: true }, 'unmute'), { level: 0.6, muted: false })
  assert.deepEqual(nextVolume({ level: 0.6, muted: false }, 'set', 0), { level: 0.6, muted: true })
  // Louder while muted unmutes.
  assert.deepEqual(nextVolume({ level: 0.6, muted: true }, 'up'), { level: 0.8, muted: false })
})

const ctx = (over: Partial<ReflexContext> = {}): ReflexContext => ({
  now: new Date(2026, 9, 26, 15, 5),
  lastAnswer: '',
  volume: { level: 0.6, muted: false },
  timers: [],
  ringing: false,
  locale: 'en-GB',
  ...over,
})
const timer = (id: string, ms: number, endsIn: number, label?: string): TimerView => ({
  id,
  ms,
  endsAt: new Date(2026, 9, 26, 15, 5).getTime() + endsIn,
  ...(label ? { label } : {}),
})

test('answers: stop goes quiet and silences a ringing timer', () => {
  assert.deepEqual(answerReflex({ kind: 'stop' }, ctx()), { say: null, then: 'dormant', silence: true })
})

test('answers: time, date, repeat', () => {
  assert.equal(answerReflex({ kind: 'time' }, ctx()).say, "It's 15:05.")
  assert.equal(answerReflex({ kind: 'date' }, ctx()).say, "It's Monday, the 26th of October.")
  assert.equal(answerReflex({ kind: 'repeat' }, ctx({ lastAnswer: 'The meeting is at four.' })).say, 'The meeting is at four.')
  assert.match(answerReflex({ kind: 'repeat' }, ctx()).say ?? '', /haven't said anything/)
})

test('answers: volume', () => {
  const up = answerReflex({ kind: 'volume', op: 'up' }, ctx())
  assert.deepEqual(up.volume, { level: 0.8, muted: false })
  assert.equal(up.say, 'Volume 80 percent.')
  assert.match(answerReflex({ kind: 'volume', op: 'up' }, ctx({ volume: { level: 1, muted: false } })).say ?? '', /as loud/)
  assert.match(answerReflex({ kind: 'volume', op: 'mute' }, ctx()).say ?? '', /unmute/)
})

test('answers: timers set, query and cancel', () => {
  const set = answerReflex({ kind: 'timer-set', ms: 10 * MIN, label: 'the pasta' }, ctx())
  assert.equal(set.say, 'Timer set for 10 minutes for the pasta.')
  assert.deepEqual(set.startTimer, { ms: 10 * MIN, label: 'the pasta' })

  const full = Array.from({ length: MAX_TIMERS }, (_, i) => timer(`t${i}`, MIN, MIN))
  assert.equal(answerReflex({ kind: 'timer-set', ms: MIN }, ctx({ timers: full })).startTimer, undefined)

  assert.equal(answerReflex({ kind: 'timer-query' }, ctx()).say, 'There are no timers running.')
  assert.equal(
    answerReflex({ kind: 'timer-query' }, ctx({ timers: [timer('a', 5 * MIN, 3 * MIN + 20_000)] })).say,
    '3 minutes and 20 seconds left on the 5 minute timer.',
  )
  const two = [timer('a', 5 * MIN, 4 * MIN), timer('b', 10 * MIN, 2 * MIN, 'the pasta')]
  assert.equal(
    answerReflex({ kind: 'timer-query' }, ctx({ timers: two })).say,
    '2 timers. The pasta timer: 2 minutes; the 5 minute timer: 4 minutes.',
  )

  // Several, none named: the next to ring goes, and the rest are mentioned.
  const one = answerReflex({ kind: 'timer-cancel', all: false }, ctx({ timers: two }))
  assert.deepEqual(one.cancelTimers, ['b'])
  assert.match(one.say ?? '', /One other timer is still running/)
  assert.deepEqual(answerReflex({ kind: 'timer-cancel', all: true }, ctx({ timers: two })).cancelTimers, ['a', 'b'])
  assert.deepEqual(answerReflex({ kind: 'timer-cancel', all: false, label: 'pasta' }, ctx({ timers: two })).cancelTimers, ['b'])
  assert.match(answerReflex({ kind: 'timer-cancel', all: false, label: 'egg' }, ctx({ timers: two })).say ?? '', /can't find/)
  assert.equal(answerReflex({ kind: 'timer-cancel', all: false }, ctx()).say, 'There are no timers running.')
  // "Stop the timer" while one is ringing just silences it.
  assert.deepEqual(answerReflex({ kind: 'timer-cancel', all: false }, ctx({ ringing: true })), { say: null, then: 'listen', silence: true })
})

test('timer done line and families for traces', () => {
  assert.equal(timerDoneLine({ ms: 5 * MIN }), 'Sir, the 5 minute timer is done.')
  assert.equal(timerDoneLine({ ms: 5 * MIN, label: 'the pasta' }), 'Sir, the pasta timer is done.')
  assert.equal(familyOf({ kind: 'timer-query' }), 'timer')
  assert.equal(familyOf({ kind: 'volume', op: 'up' }), 'volume')
})

// ---------------------------------------------------------------------------
// The morning briefing (plan 12, Q34)
// ---------------------------------------------------------------------------

const BRIEFING_HITS: [string, Reflex][] = [
  ['Brief me', { kind: 'briefing', short: false }],
  ['Jarvis, brief me please', { kind: 'briefing', short: false }],
  ['Brief me on my day', { kind: 'briefing', short: false }],
  ['Morning briefing', { kind: 'briefing', short: false }],
  ['Give me my morning briefing.', { kind: 'briefing', short: false }],
  ["Read me today's briefing", { kind: 'briefing', short: false }],
  ['Can I have my briefing?', { kind: 'briefing', short: false }],
  ['Daily brief', { kind: 'briefing', short: false }],
  ['Start the briefing', { kind: 'briefing', short: false }],
  ['Quick briefing', { kind: 'briefing', short: true }],
  ['Give me a short morning briefing', { kind: 'briefing', short: true }],
  ['Brief me quickly', { kind: 'briefing', short: true }],
  ['Quick morning rundown', { kind: 'briefing', short: true }],
  ['Skip the briefing', { kind: 'briefing-end' }],
  ['Stop the morning briefing', { kind: 'briefing-end' }],
  ['No briefing today', { kind: 'briefing-end' }],
]

for (const [said, want] of BRIEFING_HITS) {
  test(`briefing reflex: "${said}"`, () => {
    assert.deepEqual(matchReflex(said.replace(/^jarvis,?\s+/i, '')), want)
  })
}

test('"skip" means the next section only while a briefing is going', () => {
  for (const said of ['Skip', 'skip that', 'Next.', 'next section', 'Move on', 'skip it please']) {
    assert.deepEqual(matchReflex(said, { briefing: true }), { kind: 'briefing-skip' }, said)
    assert.equal(matchReflex(said), null, `${said} goes to the model when no briefing is running`)
  }
  assert.deepEqual(matchReflex('Skip the rest', { briefing: true }), { kind: 'briefing-end' })
  assert.equal(matchReflex('Skip the rest'), null)
  // Stop is still stop: it ends the briefing with everything else.
  assert.deepEqual(matchReflex('Stop', { briefing: true }), { kind: 'stop' })
})

test('briefing reflexes leave other requests to the model', () => {
  for (const said of [
    'Read the brief',
    'Brief Sam on the project',
    'Write a briefing for the board',
    'Summarise the briefing document',
    'What was in the morning briefing?',
    'Skip the intro of this video',
    'Next week',
    'Brief me about the new tax rules',
  ]) {
    assert.equal(matchReflex(said), null, said)
    assert.equal(matchReflex(said, { briefing: true }), null, `${said} (during a briefing)`)
  }
})

test('answers: the briefing reflexes tell the page what to do', () => {
  assert.deepEqual(answerReflex({ kind: 'briefing', short: true }, ctx()), { say: null, then: 'listen', briefing: 'start', briefingShort: true })
  assert.deepEqual(answerReflex({ kind: 'briefing-skip' }, ctx({ briefing: true })), { say: null, then: 'listen', briefing: 'next' })
  assert.equal(answerReflex({ kind: 'briefing-skip' }, ctx()).briefing, undefined)
  assert.equal(answerReflex({ kind: 'briefing-end' }, ctx({ briefing: true })).briefing, 'end')
  assert.deepEqual(answerReflex({ kind: 'briefing-end' }, ctx()), { say: "There's no briefing running, sir.", then: 'listen' })
  assert.equal(familyOf({ kind: 'briefing', short: false }), 'briefing')
  assert.equal(familyOf({ kind: 'briefing-skip' }), 'briefing')
})

test('answers to the offer at a wake (Q78)', () => {
  assert.deepEqual(answerReflex({ kind: 'briefing-end' }, ctx({ offered: true })), { say: 'Very good, sir. Say "brief me" whenever you like.', then: 'listen', briefing: 'end' })
  assert.deepEqual(matchReflex('Yes please', { offered: true }), { kind: 'briefing', short: false })
  assert.deepEqual(matchReflex('Not right now', { offered: true }), { kind: 'briefing-end' })
  // During a briefing "skip it" is still the next section, not a "no".
  assert.deepEqual(matchReflex('Skip it', { offered: true, briefing: true }), { kind: 'briefing-skip' })
})

test('reflex families match the ones bridge traces accept', async () => {
  // @ts-expect-error a plain-JS bridge module, imported only for this check
  const { REFLEXES } = await import('../../bridge/traces.mjs')
  assert.deepEqual([...REFLEX_FAMILIES], REFLEXES)
})
