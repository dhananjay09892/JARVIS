// Q75: reflexes in Hindi and Gujarati, in their own scripts and in Latin
// letters. Table-driven like reflex.test.ts: what must be a reflex, in which
// language it was heard, and what must still reach the model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerReflex,
  languageProfileFrom,
  matchReflex,
  matchReflexIn,
  normalise,
  replyLanguageFor,
  timerDoneLine,
  type Heard,
  type Reflex,
  type ReflexContext,
  type TimerView,
} from './reflex.ts'
import { parseIndicDuration } from './reflexIndic.ts'

const MIN = 60_000
const HOUR = 3600_000

const STOP: Reflex = { kind: 'stop' }
const TIME: Reflex = { kind: 'time' }
const DATE: Reflex = { kind: 'date' }
const REPEAT: Reflex = { kind: 'repeat' }
const UP: Reflex = { kind: 'volume', op: 'up' }
const DOWN: Reflex = { kind: 'volume', op: 'down' }
const MUTE: Reflex = { kind: 'volume', op: 'mute' }
const UNMUTE: Reflex = { kind: 'volume', op: 'unmute' }
const QUERY: Reflex = { kind: 'timer-query' }
const set = (ms: number, label?: string): Reflex => (label ? { kind: 'timer-set', ms, label } : { kind: 'timer-set', ms })
const cancel = (all: boolean, label?: string): Reflex => (label ? { kind: 'timer-cancel', all, label } : { kind: 'timer-cancel', all })

// [what was said, the reflex, the language it was heard in]
const HITS: [string, Reflex, Heard][] = [
  // -- Hindi, Devanagari
  ['रुको', STOP, 'hi'],
  ['बस करो।', STOP, 'hi'],
  ['चुप हो जाओ', STOP, 'hi'],
  ['छोड़ो, रहने दो', STOP, 'hi'],
  ['कोई बात नहीं', STOP, 'hi'],
  ['क्या टाइम हुआ है?', TIME, 'hi'],
  ['कितने बजे हैं?', TIME, 'hi'],
  ['अभी कितने बजे हैं', TIME, 'hi'],
  ['ज़रा टाइम बताओ', TIME, 'hi'],
  ['आज क्या तारीख है?', DATE, 'hi'],
  ['आज कौन सा दिन है', DATE, 'hi'],
  ['फिर से बोलो', REPEAT, 'hi'],
  ['क्या कहा?', REPEAT, 'hi'],
  ['आवाज़ बढ़ाओ', UP, 'hi'],
  ['थोड़ा ज़ोर से बोलो', UP, 'hi'],
  ['आवाज कम करो', DOWN, 'hi'],
  ['धीरे बोलो', DOWN, 'hi'],
  ['म्यूट करो', MUTE, 'hi'],
  ['आवाज़ बंद कर दो', MUTE, 'hi'],
  ['अनम्यूट करो', UNMUTE, 'hi'],
  ['आवाज ४० प्रतिशत करो', { kind: 'volume', op: 'set', level: 0.4 }, 'hi'],
  ['5 मिनट का टाइमर लगाओ', set(5 * MIN), 'hi'],
  ['पांच मिनट का टाइमर लगा दो', set(5 * MIN), 'hi'],
  ['चाय के लिए 10 मिनट का टाइमर लगाओ', set(10 * MIN, 'चाय'), 'hi'],
  ['डेढ़ घंटे का टाइमर सेट करो', set(1.5 * HOUR), 'hi'],
  ['1 घंटा 30 मिनट का टाइमर लगाओ', set(1.5 * HOUR), 'hi'],
  ['टाइमर 90 सेकंड का लगाओ', set(90_000), 'hi'],
  ['टाइमर बंद करो', cancel(false), 'hi'],
  ['सारे टाइमर बंद करो', cancel(true), 'hi'],
  ['चाय वाला टाइमर हटाओ', cancel(false, 'चाय'), 'hi'],
  ['टाइमर में कितना समय बाकी है?', QUERY, 'hi'],
  ['कोई टाइमर चल रहा है?', QUERY, 'hi'],
  // -- Hindi, Latin letters
  ['ruko', STOP, 'hi'],
  ['kuch nahi', STOP, 'hi'],
  ['kya time hua hai', TIME, 'hi'],
  ['kitne baje hain', TIME, 'hi'],
  ['aaj kya tarikh hai', DATE, 'hi'],
  ['phir se bolo', REPEAT, 'hi'],
  ['awaaz badhao', UP, 'hi'],
  ['volume kam karo', DOWN, 'hi'],
  ['awaaz band karo', MUTE, 'hi'],
  ['awaaz chalu karo', UNMUTE, 'hi'],
  ['paanch minute ka timer lagao', set(5 * MIN), 'hi'],
  ['chai ke liye 10 minute ka timer laga do', set(10 * MIN, 'chai'), 'hi'],
  ['timer band karo', cancel(false), 'hi'],
  ['timer mein kitna time baaki hai', QUERY, 'hi'],
  // -- Gujarati, Gujarati script
  ['થોભો', STOP, 'gu'],
  ['બસ કર', STOP, 'gu'],
  ['ચૂપ થઈ જા', STOP, 'gu'],
  ['કંઈ નહીં', STOP, 'gu'],
  ['કેટલા વાગ્યા?', TIME, 'gu'],
  ['હમણાં કેટલા વાગ્યા છે', TIME, 'gu'],
  ['આજે કઈ તારીખ છે?', DATE, 'gu'],
  ['આજની તારીખ', DATE, 'gu'],
  ['આજે કયો વાર છે', DATE, 'gu'],
  ['ફરીથી બોલો', REPEAT, 'gu'],
  ['શું કહ્યું?', REPEAT, 'gu'],
  ['અવાજ વધારો', UP, 'gu'],
  ['જોરથી બોલો', UP, 'gu'],
  ['અવાજ ઓછો કરો', DOWN, 'gu'],
  ['ધીમેથી બોલ', DOWN, 'gu'],
  ['મ્યૂટ કરો', MUTE, 'gu'],
  ['અવાજ ચાલુ કરો', UNMUTE, 'gu'],
  ['અવાજ ૩૦ ટકા કરો', { kind: 'volume', op: 'set', level: 0.3 }, 'gu'],
  ['5 મિનિટનું ટાઈમર મૂકો', set(5 * MIN), 'gu'],
  ['પાંચ મિનિટનું ટાઈમર મૂકી દો', set(5 * MIN), 'gu'],
  ['ચા માટે 10 મિનિટનું ટાઈમર મૂકો', set(10 * MIN, 'ચા'), 'gu'],
  ['દોઢ કલાકનું ટાઈમર સેટ કરો', set(1.5 * HOUR), 'gu'],
  ['ટાઈમર બંધ કરો', cancel(false), 'gu'],
  ['બધા ટાઈમર બંધ કરો', cancel(true), 'gu'],
  ['ચાવાળું ટાઈમર બંધ કરો', cancel(false, 'ચા'), 'gu'],
  ['ટાઈમરમાં કેટલો સમય બાકી છે?', QUERY, 'gu'],
  ['કોઈ ટાઈમર ચાલુ છે?', QUERY, 'gu'],
  // -- Gujarati, Latin letters
  ['thobho', STOP, 'gu'],
  ['rehva do', STOP, 'gu'],
  ['ketla vagya', TIME, 'gu'],
  ['aaje kai tarikh che', DATE, 'gu'],
  ['farithi bolo', REPEAT, 'gu'],
  ['avaj vadharo', UP, 'gu'],
  ['avaj ocho karo', DOWN, 'gu'],
  ['avaj bandh karo', MUTE, 'gu'],
  ['avaj chalu karo', UNMUTE, 'gu'],
  ['5 minit nu timer muko', set(5 * MIN), 'gu'],
  ['chaa mate 10 minit nu timer muko', set(10 * MIN, 'chaa'), 'gu'],
  ['badha timer bandh karo', cancel(true), 'gu'],
  ['timer ma ketlo samay baki che', QUERY, 'gu'],
  // -- romanised words both languages share
  ['bas', STOP, 'mixed'],
  ['chup', STOP, 'mixed'],
  ['band karo', STOP, 'mixed'],
  ['mute karo', MUTE, 'mixed'],
  ['timer cancel karo', cancel(false), 'mixed'],
]

for (const [said, want, heard] of HITS) {
  test(`reflex (${heard}): "${said}"`, () => {
    assert.deepEqual(matchReflexIn(said), { reflex: want, heard })
  })
}

// Each of these must go to the model: the same words, but about something else.
const MISSES = [
  // Hindi
  'लाइट बंद करो', // lights off
  'पंखा बंद करो', // fan off
  'टीवी की आवाज कम करो', // the TV's volume
  'टोक्यो में क्या टाइम है', // time in Tokyo
  'दिवाली की तारीख क्या है', // when is Diwali
  'मेरी मीटिंग कैंसल करो', // cancel my meeting
  '5 मिनट बाद मुझे याद दिलाना', // a reminder, not a timer
  '3 दिन का टाइमर लगाओ', // days: not a timer
  'जब कपड़े धुल जाएं तब का टाइमर लगाओ', // not a duration
  'रुको मत, बोलते रहो', // don't stop
  'फिर से ईमेल भेजो', // send the email again
  'light band karo',
  'tv ki awaaz kam karo',
  'kal kitne baje meeting hai',
  // Gujarati
  'લાઈટ બંધ કરો',
  'ટીવીનો અવાજ ઓછો કરો',
  'ન્યૂયોર્કમાં કેટલા વાગ્યા',
  'દિવાળી કઈ તારીખે છે',
  'મારી મીટિંગ રદ કરો',
  '5 મિનિટ પછી યાદ કરાવજે',
  'pankho bandh karo',
  'kale ketla vage meeting che',
]

for (const said of MISSES) {
  test(`not a reflex: "${said}"`, () => {
    assert.equal(matchReflex(said), null)
  })
}

test('normalise: nukta, nasal marks, Indian digits, danda and joined Gujarati postpositions', () => {
  assert.equal(normalise('आवाज़ बढ़ाओ।'), 'आवाज बढाओ')
  assert.equal(normalise('पाँच'), normalise('पांच'))
  assert.equal(normalise('आवाज ४०'), 'आवाज 40')
  assert.equal(normalise('૧૦ મિનિટનું ટાઈમર'), '10 મિનિટ નું ટાઈમર')
  assert.equal(normalise('ज़रा टाइम बताओ ना'), 'टाइम बताओ')
})

test('Hindi and Gujarati durations', () => {
  assert.equal(parseIndicDuration('5 मिनट'), 5 * MIN)
  assert.equal(parseIndicDuration('डेढ घंटा'), 1.5 * HOUR)
  assert.equal(parseIndicDuration('1 घंटा और 30 मिनट'), 1.5 * HOUR)
  assert.equal(parseIndicDuration('અડધો કલાક'), 30 * MIN)
  assert.equal(parseIndicDuration('dedh ghanta'), 1.5 * HOUR)
  assert.equal(parseIndicDuration('10 minit'), 10 * MIN)
  assert.equal(parseIndicDuration('5 दिन'), null)
  assert.equal(parseIndicDuration('मिनट'), null)
  assert.equal(parseIndicDuration('केला 5 मिनट'), null)
})

test('the reply language follows the profile', () => {
  const p = (o: Record<string, string>) => languageProfileFrom(o)
  // Defaults: always the main language, English.
  assert.equal(replyLanguageFor(p({}), 'hi'), 'en')
  assert.equal(replyLanguageFor(p({ JARVIS_LANG_PRIMARY: 'gu' }), 'hi'), 'gu')
  assert.equal(replyLanguageFor(p({ JARVIS_REPLY_LANGUAGE: 'hi' }), 'en'), 'hi')
  // Mirror: the language heard; shared romanised words go to the owner's Indian language.
  const mirror = { JARVIS_REPLY_LANGUAGE: 'mirror' }
  assert.equal(replyLanguageFor(p(mirror), 'gu'), 'gu')
  assert.equal(replyLanguageFor(p(mirror), 'en'), 'en')
  assert.equal(replyLanguageFor(p({ ...mirror, JARVIS_LANG_PRIMARY: 'gu' }), 'mixed'), 'gu')
  assert.equal(replyLanguageFor(p({ ...mirror, JARVIS_LANG_SECONDARY: 'gu' }), 'mixed'), 'gu')
  assert.equal(replyLanguageFor(p(mirror), 'mixed'), 'hi')
  // A ringing timer is not a reply: the main language.
  assert.equal(replyLanguageFor(p({ ...mirror, JARVIS_LANG_PRIMARY: 'hi' })), 'hi')
  // Unknown values fall back, as on the bridge.
  assert.deepEqual(p({ JARVIS_LANG_PRIMARY: 'fr', JARVIS_TEXT_SCRIPT: 'x' }), {
    primary: 'en',
    secondary: 'none',
    reply: 'primary',
    script: 'native',
  })
  assert.equal(languageProfileFrom(null).primary, 'en')
})

const NOW = new Date(2026, 9, 26, 15, 5)
const ctx = (over: Partial<ReflexContext> = {}): ReflexContext => ({
  now: NOW,
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
  endsAt: NOW.getTime() + endsIn,
  ...(label ? { label } : {}),
})

test('answers in Hindi, in Devanagari and in Latin letters', () => {
  const hi = (r: Reflex, over: Partial<ReflexContext> = {}) => answerReflex(r, ctx({ lang: 'hi', ...over })).say
  assert.equal(hi(TIME), 'दोपहर के 3:05 बजे हैं।')
  assert.equal(hi(DATE), 'आज सोमवार, 26 अक्टूबर है।')
  assert.equal(hi(UP), 'आवाज़ 80 प्रतिशत।')
  assert.equal(hi(set(10 * MIN, 'चाय')), 'चाय के लिए 10 मिनट का टाइमर लगा दिया।')
  assert.equal(hi(set(1.5 * HOUR)), '1 घंटा और 30 मिनट का टाइमर लगा दिया।')
  assert.equal(hi(QUERY, { timers: [timer('a', 5 * MIN, 3 * MIN + 20_000)] }), '5 मिनट वाले टाइमर में 3 मिनट और 20 सेकंड बाकी हैं।')
  assert.equal(hi(QUERY), 'कोई टाइमर नहीं चल रहा।')
  assert.equal(hi(cancel(false, 'चाय'), { timers: [timer('a', MIN, MIN, 'चाय')] }), 'चाय वाला टाइमर बंद कर दिया।')
  assert.equal(answerReflex(TIME, ctx({ lang: 'hi', script: 'roman' })).say, 'Dopahar ke 3:05 baje hain.')
  assert.equal(answerReflex(set(5 * MIN), ctx({ lang: 'hi', script: 'roman' })).say, '5 minute ka timer laga diya.')
})

test('answers in Gujarati, in Gujarati script and in Latin letters', () => {
  const gu = (r: Reflex, over: Partial<ReflexContext> = {}) => answerReflex(r, ctx({ lang: 'gu', ...over })).say
  assert.equal(gu(TIME), 'બપોરના 3:05 વાગ્યા છે.')
  assert.equal(gu(TIME, { now: new Date(2026, 9, 26, 8, 30) }), 'સવારના 8:30 વાગ્યા છે.')
  assert.equal(gu(DATE), 'આજે સોમવાર, 26 ઑક્ટોબર છે.')
  assert.equal(gu(DOWN), 'અવાજ 40 ટકા.')
  assert.equal(gu(set(10 * MIN, 'ચા')), 'ચા માટે 10 મિનિટનું ટાઈમર મૂકી દીધું.')
  const two = [timer('a', 5 * MIN, 4 * MIN), timer('b', 10 * MIN, 2 * MIN, 'ચા')]
  assert.equal(gu(cancel(false), { timers: two }), 'ચાવાળું ટાઈમર બંધ કરી દીધું. બીજું એક ટાઈમર હજી ચાલે છે.')
  assert.equal(gu(cancel(true), { timers: two }), 'બધા 2 ટાઈમર બંધ કરી દીધા.')
  assert.equal(answerReflex(TIME, ctx({ lang: 'gu', script: 'roman' })).say, 'Baporna 3:05 vagya che.')
  assert.equal(answerReflex(MUTE, ctx({ lang: 'gu', script: 'roman' })).say, 'Avaj bandh. Fari sambhalva mate "unmute" kaho.')
})

test('the actions do not depend on the language', () => {
  for (const lang of ['en', 'hi', 'gu'] as const) {
    const two = [timer('a', 5 * MIN, 4 * MIN), timer('b', 10 * MIN, 2 * MIN, 'tea')]
    assert.deepEqual(answerReflex(cancel(false), ctx({ lang, timers: two })).cancelTimers, ['b'])
    assert.deepEqual(answerReflex(UP, ctx({ lang })).volume, { level: 0.8, muted: false })
    assert.deepEqual(answerReflex(set(MIN), ctx({ lang })).startTimer, { ms: MIN })
    assert.equal(answerReflex(STOP, ctx({ lang })).say, null)
  }
})

test('a finished timer is announced in the reply language', () => {
  assert.equal(timerDoneLine({ ms: 5 * MIN }), 'Sir, the 5 minute timer is done.')
  assert.equal(timerDoneLine({ ms: 5 * MIN, label: 'चाय' }, 'hi'), 'सर, चाय वाला टाइमर पूरा हो गया।')
  assert.equal(timerDoneLine({ ms: 5 * MIN }, 'gu'), 'સર, 5 મિનિટવાળું ટાઈમર પૂરું થયું.')
  assert.equal(timerDoneLine({ ms: 5 * MIN }, 'gu', 'roman'), 'Sir, 5 minit valu timer puru thayu.')
})
