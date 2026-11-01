/**
 * Hindi and Gujarati phrasings for the reflex layer (plans 06 + 28, Q75).
 *
 * The same rule as the English patterns in reflex.ts: a pattern must match the
 * WHOLE utterance, after normalising and trimming a few polite words. "बस" or
 * "bas" is a stop; "लाइट बंद करो" (lights off) or "टीवी की आवाज कम करो" (the
 * TV's volume) are not, and go to the model. A miss costs a model turn, never
 * a wrong action.
 *
 * Each language is covered in its own script (Devanagari, Gujarati) and in
 * Latin letters, because speech-to-text and typing produce both. Every pattern
 * says which language it heard: 'hi', 'gu', or 'mixed' for romanised words
 * that are the same in both ("bas", "chup", "band karo"). The reply language
 * then comes from the owner's language profile (reflex.ts, replyLanguageFor).
 *
 * Input here is already normalised by reflex.ts: lower case, no punctuation,
 * no nukta, Indian digits as 0-9, and Gujarati postpositions split off
 * ("મિનિટનું" → "મિનિટ નું").
 */
import type { MatchContext, Reflex } from './reflex.ts'

/** Which language an utterance was in. 'mixed': romanised words shared by Hindi and Gujarati. */
export type Heard = 'en' | 'hi' | 'gu' | 'mixed'

// ---------------------------------------------------------------------------
// Numbers and durations
// ---------------------------------------------------------------------------

/** Number words in both languages and both scripts. Halves count: "डेढ़ घंटा" is 1.5 hours. */
const NUMBERS: Record<string, number> = {
  // Hindi, Devanagari (nukta already removed: डेढ़ → डेढ)
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, छह: 6, छः: 6, छे: 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
  ग्यारह: 11, बारह: 12, पंद्रह: 15, पन्द्रह: 15, बीस: 20, पच्चीस: 25, तीस: 30, चालीस: 40,
  पैंतालीस: 45, पचास: 50, साठ: 60, नब्बे: 90, आधा: 0.5, आधी: 0.5, आधे: 0.5, डेढ: 1.5, ढाई: 2.5,
  // Hindi, Latin letters
  ek: 1, do: 2, teen: 3, chaar: 4, char: 4, paanch: 5, panch: 5, chhah: 6, chhe: 6, saat: 7,
  aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, pandrah: 15, bees: 20, pachchis: 25,
  pachees: 25, tees: 30, chalis: 40, chaalis: 40, paintalis: 45, pachas: 50, pachaas: 50,
  saath: 60, nabbe: 90, aadha: 0.5, adha: 0.5, aadhe: 0.5, dedh: 1.5, dhai: 2.5,
  // Gujarati, Gujarati script
  બે: 2, ત્રણ: 3, ચાર: 4, પાંચ: 5, છ: 6, સાત: 7, આઠ: 8, નવ: 9, દસ: 10, અગિયાર: 11, બાર: 12,
  પંદર: 15, વીસ: 20, પચીસ: 25, ત્રીસ: 30, ચાલીસ: 40, પિસ્તાળીસ: 45, પચાસ: 50, સાઈઠ: 60, સાઠ: 60,
  નેવું: 90, અડધો: 0.5, અડધી: 0.5, અડધું: 0.5, દોઢ: 1.5, અઢી: 2.5, એક: 1,
  // Gujarati, Latin letters
  be: 2, tran: 3, chha: 6, chh: 6, sat: 7, nav: 9, agiyar: 11, bar: 12, pandar: 15, vees: 20,
  vis: 20, pachis: 25, tris: 30, pistalis: 45, saith: 60, nevu: 90, adadho: 0.5, addho: 0.5,
  adadhi: 0.5, adhdho: 0.5, dodh: 1.5, adhi: 2.5,
}

const UNITS: [RegExp, number][] = [
  [/^(?:सेकंड|सेकेंड|सेकण्ड|સેકન્ડ|સેકંડ|second|seconds|sec|secs|sekand|sekend)$/u, 1000],
  [/^(?:मिनट|मिनिट|મિનિટ|મિનીટ|minute|minutes|minat|mint|min|mins|minit)$/u, 60_000],
  [/^(?:घंटा|घंटे|घण्टा|घण्टे|કલાક|ghanta|ghante|hour|hours|kalak)$/u, 3600_000],
]

const unitMs = (w: string): number | null => {
  for (const [re, ms] of UNITS) if (re.test(w)) return ms
  return null
}

const AND = new Set(['और', 'aur', 'અને', 'ane', 'and'])

/**
 * A Hindi or Gujarati duration in milliseconds, or null if any word of it is
 * not part of a duration. "5 मिनट", "डेढ़ घंटा", "1 घंटा 30 मिनट",
 * "દોઢ કલાક", "paanch minute", "10 minit".
 */
export function parseIndicDuration(text: string): number | null {
  const words = text.trim().split(/\s+/).filter((w) => w && !AND.has(w))
  if (!words.length || words.length % 2) return null
  let total = 0
  for (let i = 0; i < words.length; i += 2) {
    const n = /^\d+(?:\.\d+)?$/.test(words[i]) ? Number(words[i]) : NUMBERS[words[i]]
    const unit = unitMs(words[i + 1])
    if (n === undefined || unit === null || !(n > 0)) return null
    total += n * unit
  }
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

type Entry = { heard: Heard; re: RegExp; make: (m: RegExpExecArray) => Reflex | null }

const fixed = (heard: Heard, re: RegExp, r: Reflex): Entry => ({ heard, re, make: () => r })
const alt = (...xs: string[]) => `(?:${xs.join('|')})`
const R = (src: string) => new RegExp(`^(?:${src})$`, 'u')

/** A label as spoken: letters and marks of any script, a few words at most. */
const LABEL = "([\\p{L}\\p{M}' ]{1,40}?)"
/** Words that point at a timer rather than name it ("वो टाइमर", "that timer"). */
const NOT_LABEL = /^(?:वो|वह|यह|ये|उस|इस|मेरा|मेरे|मेरी|पेलुं|પેલું|આ|એ|મારું|મારા|vo|wo|woh|ye|yeh|us|is|mera|mere|maru|mara|pelu|aa|e|the|my|this|that)$/u

const timerSet = (dur: string | undefined, label: string | undefined): Reflex | null => {
  const ms = dur ? parseIndicDuration(dur) : null
  if (ms === null) return null
  const l = label?.trim().replace(/\s+/g, ' ').slice(0, 40)
  return l && !NOT_LABEL.test(l) ? { kind: 'timer-set', ms, label: l } : { kind: 'timer-set', ms }
}

const timerCancel = (all: string | undefined, label: string | undefined, plural = false): Reflex => {
  const l = label?.trim()
  const named = l && !NOT_LABEL.test(l) ? l : undefined
  const isAll = Boolean(all) || plural
  return named ? { kind: 'timer-cancel', all: isAll, label: named } : { kind: 'timer-cancel', all: isAll }
}

const volumeSet = (raw: string): Reflex | null => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  // As in English: up to 10 is out of ten, above that out of a hundred.
  const level = n > 10 ? n / 100 : n / 10
  return level <= 1 ? { kind: 'volume', op: 'set', level } : null
}

// -- Hindi, Devanagari ------------------------------------------------------

const HI_DO = alt('करो', 'कर दो', 'करिए', 'करिये', 'कीजिए', 'कीजिये', 'कर दीजिए', 'कर दीजिये', 'करना')
const HI_SPEAK = alt('बोलो', 'बोलिए', 'बोलिये', 'बोल')
const HI_TIME = alt('टाइम', 'टाईम', 'समय', 'वक्त')
const HI_VOL = alt('आवाज', 'वॉल्यूम', 'वोल्यूम', 'वॉल्युम', 'वाल्यूम', 'साउंड')
const HI_TIMER = alt('टाइमर', 'टाईमर')
const HI_SETV = alt('लगाओ', 'लगा दो', 'लगाइए', 'लगाइये', 'लगा दीजिए', 'सेट करो', 'सेट कर दो', 'सेट कीजिए', 'चालू करो', 'चालू कर दो', 'शुरू करो', 'शुरू कर दो', 'लगाना', 'रखो', 'रख दो', 'स्टार्ट करो')
const HI_OFFV = alt('बंद करो', 'बंद कर दो', 'बंद कीजिए', 'हटाओ', 'हटा दो', 'कैंसल करो', 'कैंसल कर दो', 'कैंसिल करो', 'रद्द करो', 'रद्द कर दो', 'खत्म करो', 'ऑफ करो')
const HI_LEFT = alt('बाकी', 'बचा', 'बची')

const HINDI: Entry[] = [
  fixed('hi', R(`रुको|रुक जाओ|रुकिए|रुकिये|रुक|बस|बस बस|बस करो|बस कीजिए|बस हो गया|बस इतना ही|इतना ही|चुप|चुप हो जाओ|चुप रहो|चुप करो|बंद करो|बोलना बंद करो|रहने दो|रहने दीजिए|छोडो|छोडो रहने दो|जाने दो|कुछ नहीं|कोई बात नहीं`), { kind: 'stop' }),
  fixed('hi', R(`(?:अभी )?(?:क्या ${HI_TIME} (?:हुआ )?(?:है|हुआ)|${HI_TIME} क्या (?:हुआ )?(?:है|हुआ)|${HI_TIME} कितना हुआ(?: है)?|कितने बजे (?:हैं|है)|कितने बज गए(?: हैं)?|कितना बजा(?: है)?|कितना बज गया(?: है)?|${HI_TIME} ${alt('बताओ', 'बताइए', 'बताइये', 'बताना')})`), { kind: 'time' }),
  fixed('hi', R(`आज ${alt('क्या', 'कौन सी', 'कौनसी')} तारीख (?:है|हैं)|आज तारीख क्या है|आज की तारीख(?: क्या है| बताओ)?|आज ${alt('कौन सा', 'कौनसा', 'क्या')} दिन है|आज क्या है|तारीख क्या है|तारीख बताओ`), { kind: 'date' }),
  fixed('hi', R(`${alt('फिर से', 'फिरसे', 'दोबारा', 'दुबारा')}(?: ${alt('बोलो', 'बोलिए', 'बोलिये', 'कहो', 'कहिए', 'कहिये', 'बताओ', 'बोल')})?|एक बार ${alt('और', 'फिर')} ${alt('बोलो', 'बोलिए', 'कहो')}|(?:आपने |तुमने )?क्या ${alt('कहा', 'बोला', 'बोले')}|सुना नहीं|सुनाई नहीं दिया|मैंने सुना नहीं`), { kind: 'repeat' }),
  fixed('hi', R(`(?:${HI_VOL} ${alt('बढाओ', 'बढा दो', 'बढाइए', 'बढाइये', 'बढा दीजिए', 'तेज करो', 'तेज कर दो', 'ऊंची करो', 'ऊंची कर दो', 'ज्यादा करो', 'ज्यादा कर दो')}|(?:थोडा )?${alt('जोर से', 'ऊंची आवाज में')}(?: ${HI_SPEAK})?|${HI_VOL} अप)(?: थोडा)?(?: और)?`), { kind: 'volume', op: 'up' }),
  fixed('hi', R(`(?:${HI_VOL} ${alt('कम करो', 'कम कर दो', 'कम कीजिए', 'कम करिए', 'धीमी करो', 'धीमी कर दो', 'धीरे करो', 'घटाओ', 'घटा दो', 'नीचे करो')}|(?:थोडा )?${alt('धीरे', 'धीमे', 'आहिस्ता')}(?: से)?(?: ${HI_SPEAK})?|${HI_VOL} डाउन)(?: थोडा)?(?: और)?`), { kind: 'volume', op: 'down' }),
  fixed('hi', R(`${alt('म्यूट', 'म्युट')}(?: ${HI_DO})?|${HI_VOL} बंद(?: ${HI_DO})?`), { kind: 'volume', op: 'mute' }),
  fixed('hi', R(`${alt('अनम्यूट', 'अनम्युट')}(?: ${HI_DO})?|${HI_VOL} ${alt('चालू', 'ऑन')} ${HI_DO}|${HI_VOL} वापस लाओ`), { kind: 'volume', op: 'unmute' }),
  { heard: 'hi', re: R(`${HI_VOL} (\\d{1,3})(?: ?${alt('प्रतिशत', 'परसेंट', 'पर्सेंट', '%')})? (?:पर )?${alt('करो', 'कर दो', 'रखो', 'रख दो', 'कीजिए', 'सेट करो')}`), make: (m) => volumeSet(m[1]) },
  // Timers. "चाय के लिए 5 मिनट का टाइमर लगाओ", "टाइमर 5 मिनट का लगाओ", "5 मिनट का टाइमर चाय के लिए".
  { heard: 'hi', re: R(`(?:${LABEL} के लिए )?(.+?) का ${HI_TIMER}(?: ${HI_SETV})?`), make: (m) => timerSet(m[2], m[1]) },
  { heard: 'hi', re: R(`${HI_TIMER} (.+?) का ${HI_SETV}`), make: (m) => timerSet(m[1], undefined) },
  { heard: 'hi', re: R(`(.+?) का ${HI_TIMER} ${LABEL} के लिए(?: ${HI_SETV})?`), make: (m) => timerSet(m[1], m[2]) },
  { heard: 'hi', re: R(`(?:(सारे|सभी|सब) )?(?:${LABEL} ${alt('वाला', 'वाले', 'का', 'के')} )?${HI_TIMER}(्स)? ${HI_OFFV}`), make: (m) => timerCancel(m[1], m[2], Boolean(m[3])) },
  fixed('hi', R(`(?:${alt('मेरे', 'इस', 'उस', 'वो')} )?(?:\\S+ ${alt('वाले', 'के')} )?${HI_TIMER} (?:में )?${alt('कितना', 'कितनी देर', 'कितना समय', 'कितना टाइम', 'कितना वक्त')}(?: और)? ${HI_LEFT}(?: है| हैं)?|${alt('कोई', 'कौन से', 'कौनसे', 'कितने')} ${HI_TIMER}(?:्स)? चल ${alt('रहा', 'रहे')} ${alt('है', 'हैं')}|${HI_TIMER}(?:्स)?(?: ${alt('का क्या हुआ', 'का स्टेटस', 'स्टेटस', 'चेक करो', 'दिखाओ')})?`), { kind: 'timer-query' }),
]

// -- Hindi, Latin letters ---------------------------------------------------

const HR_DO = alt('karo', 'kar do', 'kariye', 'kijiye', 'kar dijiye', 'karna')
const HR_SPEAK = alt('bolo', 'boliye', 'bol')
const HR_TIME = alt('time', 'samay', 'waqt', 'wakt')
const HR_VOL = alt('awaaz', 'aawaz', 'awaz', 'aawaaz', 'awaj', 'volume', 'sound')
const HR_SETV = alt('lagao', 'laga do', 'lagaiye', 'laga dijiye', 'set karo', 'set kar do', 'chalu karo', 'shuru karo', 'start karo', 'rakho', 'rakh do')
const HR_OFFV = alt('band karo', 'band kar do', 'hatao', 'hata do', 'radd karo', 'khatam karo', 'khatm karo', 'off karo')
const HR_LEFT = alt('baaki', 'baki', 'bacha', 'bachi')
const HR_IS = alt('hai', 'hain', 'he')

const HINDI_ROMAN: Entry[] = [
  fixed('hi', R(`ruko|ruk jao|rukiye|rehne do|rahne do|chhodo|chodo|jaane do|jane do|kuch nahi|kuchh nahi|koi baat nahi|koi bat nahi|bas itna hi|itna hi|bas ho gaya|chup ho jao|chup raho|bolna band karo`), { kind: 'stop' }),
  fixed('hi', R(`(?:abhi )?(?:kya ${HR_TIME} (?:hua )?(?:${HR_IS}|hua)|${HR_TIME} kya (?:hua )?(?:${HR_IS}|hua)|kitne baje ${HR_IS}|kitne baj gaye(?: ${HR_IS})?|kitna baja(?: ${HR_IS})?|kitna baj gaya(?: ${HR_IS})?|${HR_TIME} ${alt('batao', 'bataiye', 'batana')})`), { kind: 'time' }),
  fixed('hi', R(`${alt('aaj', 'aj')} ${alt('kya', 'kaun si', 'kaunsi')} ${alt('tareekh', 'tarikh', 'date')} ${HR_IS}|${alt('aaj', 'aj')} ${alt('tareekh', 'tarikh', 'date')} kya ${HR_IS}|${alt('aaj', 'aj')} ki ${alt('tareekh', 'tarikh', 'date')}(?: kya ${HR_IS})?|${alt('aaj', 'aj')} ${alt('kaun sa', 'kaunsa', 'kya')} din ${HR_IS}|${alt('tareekh', 'tarikh')} kya ${HR_IS}|${alt('tareekh', 'tarikh')} batao`), { kind: 'date' }),
  fixed('hi', R(`${alt('phir se', 'fir se', 'phirse', 'firse', 'dobara', 'dubara')}(?: ${alt('bolo', 'boliye', 'kaho', 'kahiye', 'batao', 'bol')})?|ek baar ${alt('aur', 'phir', 'fir')} ${alt('bolo', 'boliye', 'kaho')}|(?:aapne |tumne )?kya ${alt('kaha', 'bola', 'bole')}|suna nahi|sunai nahi diya`), { kind: 'repeat' }),
  fixed('hi', R(`(?:${HR_VOL} ${alt('badhao', 'badha do', 'badhaiye', 'tez karo', 'tez kar do', 'unchi karo', 'zyada karo', 'jyada karo')}|(?:thoda )?${alt('zor se', 'jor se', 'unchi awaaz mein')}(?: ${HR_SPEAK})?)(?: thoda)?(?: aur)?`), { kind: 'volume', op: 'up' }),
  fixed('hi', R(`(?:${HR_VOL} ${alt('kam karo', 'kam kar do', 'kam kijiye', 'dheemi karo', 'dhimi karo', 'ghatao', 'ghata do')}|(?:thoda )?${alt('dheere', 'dhire', 'dheeme', 'aahista')}(?: se)?(?: ${HR_SPEAK})?)(?: thoda)?(?: aur)?`), { kind: 'volume', op: 'down' }),
  fixed('hi', R(`${HR_VOL} band ${HR_DO}`), { kind: 'volume', op: 'mute' }),
  fixed('hi', R(`${HR_VOL} ${alt('chalu', 'on')} ${HR_DO}|${HR_VOL} wapas lao`), { kind: 'volume', op: 'unmute' }),
  { heard: 'hi', re: R(`${HR_VOL} (\\d{1,3})(?: ?${alt('pratishat', 'percent', '%')})? (?:par |pe )?${alt('karo', 'kar do', 'rakho', 'set karo')}`), make: (m) => volumeSet(m[1]) },
  { heard: 'hi', re: R(`(?:${LABEL} ke liye )?(.+?) ka timer(?: ${HR_SETV})?`), make: (m) => timerSet(m[2], m[1]) },
  { heard: 'hi', re: R(`timer (.+?) ka ${HR_SETV}`), make: (m) => timerSet(m[1], undefined) },
  { heard: 'hi', re: R(`(.+?) ka timer ${LABEL} ke liye(?: ${HR_SETV})?`), make: (m) => timerSet(m[1], m[2]) },
  { heard: 'hi', re: R(`(?:(saare|sare|sabhi|sab) )?(?:${LABEL} ${alt('wala', 'wale', 'vala', 'vale', 'ka', 'ke')} )?timer(s)? ${HR_OFFV}`), make: (m) => timerCancel(m[1], m[2], Boolean(m[3])) },
  fixed('hi', R(`(?:${alt('mere', 'is', 'us', 'wo', 'vo')} )?(?:\\S+ ${alt('wale', 'vale', 'ke')} )?timer (?:${alt('mein', 'me', 'main')} )?${alt('kitna', 'kitni der', 'kitna time', 'kitna samay', 'kitna waqt')}(?: aur)? ${HR_LEFT}(?: ${HR_IS})?|${alt('koi', 'kaun se', 'kaunse', 'kitne')} timers? chal ${alt('raha', 'rahe')} ${HR_IS}|timers? ${alt('ka kya hua', 'ka status', 'check karo', 'dikhao')}`), { kind: 'timer-query' }),
]

// -- Gujarati, Gujarati script ----------------------------------------------

const GU_DO = alt('કરો', 'કર', 'કરી દો', 'કરી દે', 'કરજો', 'કરજે')
const GU_SPEAK = alt('બોલો', 'બોલ')
const GU_TIME = alt('ટાઈમ', 'ટાઇમ', 'સમય')
const GU_VOL = alt('અવાજ', 'વોલ્યુમ', 'વૉલ્યુમ', 'વોલ્યૂમ', 'સાઉન્ડ')
const GU_TIMER = alt('ટાઈમર', 'ટાઇમર')
const GU_SETV = alt('મૂકો', 'મૂક', 'મુકો', 'મુક', 'મૂકી દો', 'મૂકી દે', 'સેટ કરો', 'સેટ કર', 'ચાલુ કરો', 'ચાલુ કર', 'લગાવો', 'લગાવ', 'શરૂ કરો', 'શરૂ કર')
const GU_OFFV = alt('બંધ કરો', 'બંધ કર', 'બંધ કરી દો', 'બંધ કરી દે', 'કાઢી નાખો', 'કાઢી નાખ', 'હટાવો', 'હટાવ', 'કેન્સલ કરો', 'કેન્સલ કર', 'રદ કરો', 'રદ કર')
const GU_IS = alt('છે', 'થઈ')
const GU_OF = alt('નું', 'નો')

const GUJARATI: Entry[] = [
  fixed('gu', R(`થોભો|થોભ|રોકાઈ જા|રોકાઈ જાઓ|રોકાઈ જાવ|બસ|બસ બસ|બસ કર|બસ કરો|ચૂપ|ચુપ|ચૂપ થા|ચૂપ થઈ જા|ચૂપ થઈ જાઓ|ચૂપ રહો|ચૂપ રહે|બંધ કર|બંધ કરો|બોલવા નું બંધ ${GU_DO}|રહેવા દે|રહેવા દો|જવા દે|જવા દો|કંઈ નહીં|કાંઈ નહીં|કશું નહીં|કંઈ નહિ|બસ આટલું જ|આટલું જ`), { kind: 'stop' }),
  fixed('gu', R(`(?:${alt('હમણાં', 'અત્યારે')} )?(?:કેટલા વાગ્યા(?: છે)?|કેટલા વાગે છે|શું ${GU_TIME} થયો(?: છે)?|${GU_TIME} શું થયો(?: છે)?|${GU_TIME} શું છે|${GU_TIME} કેટલો થયો|${GU_TIME} ${alt('કહો', 'કહે', 'બતાવો', 'બતાવ')})`), { kind: 'time' }),
  fixed('gu', R(`આજે ${alt('કઈ', 'શું')} તારીખ ${GU_IS}|આજે તારીખ શું છે|આજ ની તારીખ(?: શું છે| કહો| બતાવો)?|આજે ${alt('કયો', 'શું')} ${alt('વાર', 'દિવસ')} છે|તારીખ શું છે|તારીખ ${alt('કહો', 'બતાવો')}`), { kind: 'date' }),
  fixed('gu', R(`${alt('ફરી', 'ફરીથી', 'પાછું', 'ફરી વાર', 'ફરી એક વાર')}(?: ${alt('બોલો', 'બોલ', 'કહો', 'કહે', 'બોલશો')})?|(?:તમે |તેં )?શું ${alt('કહ્યું', 'બોલ્યા', 'બોલ્યો', 'બોલ્યું')}|સંભળાયું નહીં|સાંભળ્યું નહીં`), { kind: 'repeat' }),
  fixed('gu', R(`(?:${GU_VOL} ${alt('વધારો', 'વધાર', 'વધારી દો', 'વધારી દે', 'મોટો કરો', 'મોટો કર', 'વધુ કરો', 'વધુ કર')}|(?:થોડું )?${alt('મોટેથી', 'જોરથી', 'મોટા અવાજે')}(?: ${GU_SPEAK})?)(?: થોડું)?(?: વધુ)?`), { kind: 'volume', op: 'up' }),
  fixed('gu', R(`(?:${GU_VOL} ${alt('ઓછો કરો', 'ઓછો કર', 'ઓછું કરો', 'ઓછું કર', 'ઓછો કરી દો', 'ઘટાડો', 'ઘટાડ', 'ધીમો કરો', 'ધીમો કર')}|(?:થોડું )?${alt('ધીમેથી', 'ધીમે', 'ધીરે')}(?: ${GU_SPEAK})?)(?: થોડું)?(?: વધુ)?`), { kind: 'volume', op: 'down' }),
  fixed('gu', R(`${alt('મ્યૂટ', 'મ્યુટ')}(?: ${GU_DO})?|${GU_VOL} બંધ ${GU_DO}`), { kind: 'volume', op: 'mute' }),
  fixed('gu', R(`${alt('અનમ્યૂટ', 'અનમ્યુટ')}(?: ${GU_DO})?|${GU_VOL} ચાલુ ${GU_DO}`), { kind: 'volume', op: 'unmute' }),
  { heard: 'gu', re: R(`${GU_VOL} (\\d{1,3})(?: ?${alt('ટકા', 'પરસેન્ટ', '%')})? (?:પર )?${alt('કરો', 'કર', 'રાખો', 'રાખ', 'કરી દો')}`), make: (m) => volumeSet(m[1]) },
  // "ચા માટે 5 મિનિટનું ટાઈમર મૂકો", "ટાઈમર 5 મિનિટનું મૂકો", "5 મિનિટનું ટાઈમર ચા માટે".
  { heard: 'gu', re: R(`(?:${LABEL} ${alt('માટે', 'સારુ')} )?(.+?) ${GU_OF} ${GU_TIMER}(?: ${GU_SETV})?`), make: (m) => timerSet(m[2], m[1]) },
  { heard: 'gu', re: R(`${GU_TIMER} (.+?) ${GU_OF} ${GU_SETV}`), make: (m) => timerSet(m[1], undefined) },
  { heard: 'gu', re: R(`(.+?) ${GU_OF} ${GU_TIMER} ${LABEL} માટે(?: ${GU_SETV})?`), make: (m) => timerSet(m[1], m[2]) },
  { heard: 'gu', re: R(`(?:(બધા|બધાં|બધાય) )?(?:${LABEL} ${alt('વાળું', 'વાળો', 'નું', 'નો')} )?${GU_TIMER}(્સ)? ${GU_OFFV}`), make: (m) => timerCancel(m[1], m[2], Boolean(m[3])) },
  fixed('gu', R(`(?:${alt('મારા', 'આ', 'પેલા')} )?(?:\\S+ ${alt('વાળા', 'ના')} )?${GU_TIMER} (?:માં )?(?:હજી )?${alt('કેટલો સમય', 'કેટલો ટાઈમ', 'કેટલું', 'કેટલી વાર', 'કેટલી મિનિટ')}(?: હજી)? ${alt('બાકી', 'રહ્યો', 'રહ્યું', 'રહી')}(?: છે)?|${alt('કોઈ', 'કયા', 'કેટલા')} ${GU_TIMER}(?:્સ)? ${alt('ચાલુ છે', 'ચાલે છે')}|${GU_TIMER}(?: ${alt('નું શું થયું', 'નું સ્ટેટસ', 'ચેક કરો', 'બતાવો')})?`), { kind: 'timer-query' }),
]

// -- Gujarati, Latin letters ------------------------------------------------

const GR_DO = alt('karo', 'kar', 'kari do', 'kari de', 'karjo', 'karje')
const GR_SPEAK = alt('bolo', 'bol')
const GR_TIME = alt('time', 'samay')
const GR_VOL = alt('avaj', 'avaaj', 'awaaj', 'avaz', 'awaz', 'volume', 'sound')
const GR_SETV = alt('muko', 'muk', 'mooko', 'mooki do', 'muki do', 'muki de', 'set karo', 'set kar', 'chalu karo', 'chalu kar', 'lagavo', 'sharu karo')
const GR_OFFV = alt('bandh karo', 'bandh kar', 'bandh kari do', 'kadhi nakho', 'kadhi nakh', 'rad karo', 'rad kar', 'hatavo')
const GR_IS = alt('che', 'chhe', 'thai')
const GR_OF = alt('nu', 'no', 'nun')

const GUJARATI_ROMAN: Entry[] = [
  fixed('gu', R(`thobho|thobh|rokai ja|rokai jao|chup tha|chup thai ja|chup thai jao|bandh kar|bandh karo|bolvanu bandh ${GR_DO}|rehva de|rehva do|reva de|reva do|java de|java do|kai nahi|kain nahi|kashu nahi|bas aatlu j|aatlu j`), { kind: 'stop' }),
  fixed('gu', R(`(?:${alt('hamna', 'atyare')} )?(?:ketla vagya(?: ${GR_IS})?|ketla vage ${GR_IS}|shu ${GR_TIME} thayo(?: ${GR_IS})?|${GR_TIME} shu thayo(?: ${GR_IS})?|${GR_TIME} shu ${GR_IS}|${GR_TIME} ${alt('kaho', 'kahe', 'batavo')})`), { kind: 'time' }),
  fixed('gu', R(`aaje ${alt('kai', 'shu')} tarikh ${GR_IS}|aaje tarikh shu ${GR_IS}|aaj ?ni tarikh(?: shu ${GR_IS})?|aaje ${alt('kayo', 'shu')} ${alt('vaar', 'var', 'divas')} ${GR_IS}|tarikh shu ${GR_IS}`), { kind: 'date' }),
  fixed('gu', R(`${alt('fari', 'farithi', 'pachhu', 'pachu', 'fari var', 'fari ek var')}(?: ${alt('bolo', 'bol', 'kaho', 'kahe')})?|(?:tame )?shu ${alt('kahyu', 'bolya', 'bolyo')}|${alt('sambhlayu', 'sambhdayu', 'sambhalyu')} nahi`), { kind: 'repeat' }),
  fixed('gu', R(`(?:${GR_VOL} ${alt('vadharo', 'vadhar', 'vadhari do', 'vadhari de', 'moto karo', 'moto kar', 'vadhu karo')}|(?:thodu )?${alt('motethi', 'jorthi', 'zorthi')}(?: ${GR_SPEAK})?)(?: thodu)?(?: vadhu)?`), { kind: 'volume', op: 'up' }),
  fixed('gu', R(`(?:${GR_VOL} ${alt('ocho karo', 'ocho kar', 'ochu karo', 'ochu kar', 'ghatado', 'dhimo karo', 'dhimo kar')}|(?:thodu )?dhimethi(?: ${GR_SPEAK})?)(?: thodu)?(?: vadhu)?`), { kind: 'volume', op: 'down' }),
  fixed('gu', R(`${GR_VOL} bandh ${GR_DO}`), { kind: 'volume', op: 'mute' }),
  fixed('gu', R(`${GR_VOL} chalu ${GR_DO}`), { kind: 'volume', op: 'unmute' }),
  { heard: 'gu', re: R(`${GR_VOL} (\\d{1,3})(?: ?${alt('taka', 'percent', '%')})? (?:par )?${alt('karo', 'kar', 'rakho', 'rakh')}`), make: (m) => volumeSet(m[1]) },
  { heard: 'gu', re: R(`(?:${LABEL} ${alt('mate', 'saru')} )?(.+?) ?${GR_OF} timer(?: ${GR_SETV})?`), make: (m) => timerSet(m[2], m[1]) },
  { heard: 'gu', re: R(`timer (.+?) ?${GR_OF} ${GR_SETV}`), make: (m) => timerSet(m[1], undefined) },
  { heard: 'gu', re: R(`(?:(badha|badhan|badhay) )?(?:${LABEL} ${alt('valu', 'vadu', 'nu', 'no')} )?timer(s)? ${GR_OFFV}`), make: (m) => timerCancel(m[1], m[2], Boolean(m[3])) },
  fixed('gu', R(`(?:${alt('mara', 'aa', 'pela')} )?timer ?(?:ma )?(?:${alt('haji', 'hji')} )?${alt('ketlo samay', 'ketlo time', 'ketlu', 'ketli var', 'ketli minit')}(?: ${alt('haji', 'hji')})? ${alt('baki', 'baaki', 'rahyo', 'rahyu')}(?: ${GR_IS})?|${alt('koi', 'kaya', 'ketla')} timers? chalu ${GR_IS}|timer ?${alt('nu shu thayu', 'nu status')}`), { kind: 'timer-query' }),
]

// -- Romanised words shared by both -----------------------------------------

const MIXED: Entry[] = [
  fixed('mixed', R(`bas|bas bas|bas karo|bas kar|chup|chup karo|chup kar|band karo|band kar`), { kind: 'stop' }),
  fixed('mixed', R(`(?:thoda |thodu )?${alt('dhire', 'dhime')}(?: ${alt('bolo', 'bol', 'boliye')})?`), { kind: 'volume', op: 'down' }),
  fixed('mixed', R(`mute ${alt('karo', 'kar', 'kar do', 'kari do')}`), { kind: 'volume', op: 'mute' }),
  fixed('mixed', R(`unmute ${alt('karo', 'kar', 'kar do', 'kari do')}`), { kind: 'volume', op: 'unmute' }),
  { heard: 'mixed', re: R(`(?:(sab|badha) )?timers? ${alt('cancel karo', 'cancel kar', 'cancel kar do', 'cancel kari do', 'off karo', 'off kar')}`), make: (m) => timerCancel(m[1], undefined) },
]

// -- The morning briefing (plans 12 + 28, Q78) --------------------------------
//
// As in English, "briefing" has to be in the sentence to start one ("ब्रीफिंग
// सुनाओ", "briefing sunao", "બ્રીફિંગ સંભળાવો"); a quick one is "छोटी" /
// "ટૂંકી" / "jaldi". "आगे" / "આગળ" (next) only mean the briefing while one is
// going, and "हां" / "હા" (yes) only right after he offered one at a wake.
// "बस", "रुको" and the other stop words still stop it, as in English.

const BRIEF_HI = alt('ब्रीफिंग', 'ब्रिफिंग')
const BRIEF_GU = alt('બ્રીફિંગ', 'બ્રિફિંગ')
const BRIEF_R = alt('briefing', 'brifing')
const briefing = (short: boolean): Reflex => ({ kind: 'briefing', short })

const BRIEFING_ALWAYS: Entry[] = [
  // Hindi, Devanagari
  fixed('hi', R(`(?:आज की |मेरी )?(?:${alt('मॉर्निंग', 'मोर्निंग', 'सुबह की')} )?${BRIEF_HI} ${alt('सुनाओ', 'सुनाइए', 'सुनाइये', 'सुना दो', 'सुना दीजिए', 'दो', 'दीजिए', 'दीजिये', 'बताओ', 'बताइए', 'शुरू करो', 'शुरू कीजिए', 'चालू करो')}`), briefing(false)),
  fixed('hi', R(`(?:${alt('छोटी', 'जल्दी से', 'जल्दी', 'शॉर्ट')} )(?:${alt('सी', 'वाली')} )?${BRIEF_HI} ${alt('सुनाओ', 'सुनाइए', 'सुना दो', 'दो', 'दीजिए', 'बताओ')}|${BRIEF_HI} जल्दी (?:से )?${alt('सुनाओ', 'सुना दो', 'बताओ')}`), briefing(true)),
  fixed('hi', R(`${BRIEF_HI} ${alt('बंद करो', 'बंद कर दो', 'बंद कीजिए', 'रहने दो', 'रहने दीजिए', 'छोडो', 'रोको', 'रोक दो', 'मत सुनाओ')}|आज ${BRIEF_HI} नहीं|${BRIEF_HI} नहीं चाहिए`), { kind: 'briefing-end' }),
  // Gujarati, Gujarati script ("આજની" arrives as "આજ ની")
  fixed('gu', R(`(?:આજ ની |મારી )?(?:${alt('મોર્નિંગ', 'સવાર ની')} )?${BRIEF_GU} ${alt('સંભળાવો', 'સંભળાવ', 'સંભળાવી દો', 'આપો', 'આપ', 'કહો', 'કહે', 'શરૂ કરો', 'શરૂ કર', 'ચાલુ કરો')}`), briefing(false)),
  fixed('gu', R(`${alt('ટૂંકી', 'નાની', 'ઝડપથી', 'જલ્દી')} ${BRIEF_GU} ${alt('સંભળાવો', 'સંભળાવ', 'આપો', 'કહો')}|${BRIEF_GU} ${alt('ઝડપથી', 'જલ્દી')} ${alt('સંભળાવો', 'સંભળાવ', 'કહો')}`), briefing(true)),
  fixed('gu', R(`${BRIEF_GU} ${alt('બંધ કરો', 'બંધ કર', 'બંધ કરી દો', 'રહેવા દો', 'રહેવા દે', 'રોકો', 'રોકી દો', 'ના સંભળાવો')}|આજે ${BRIEF_GU} નહીં|${BRIEF_GU} નથી જોઈતી`), { kind: 'briefing-end' }),
  // Hindi, Latin letters
  fixed('hi', R(`(?:aaj ki |meri )?(?:${alt('morning', 'subah ki')} )?${BRIEF_R} ${alt('sunao', 'sunaiye', 'suna do', 'suna dijiye', 'dijiye', 'batao', 'bataiye', 'shuru karo', 'chalu karo', 'start karo')}`), briefing(false)),
  fixed('hi', R(`${alt('chhoti', 'choti', 'jaldi se', 'jaldi', 'short')} ${BRIEF_R} ${alt('sunao', 'suna do', 'dijiye', 'batao')}|${BRIEF_R} jaldi (?:se )?${alt('sunao', 'suna do', 'batao')}`), briefing(true)),
  fixed('hi', R(`${BRIEF_R} ${alt('rehne do', 'rahne do', 'chhodo', 'chodo', 'roko', 'rok do', 'mat sunao')}|aaj ${BRIEF_R} nahi|${BRIEF_R} nahi chahiye`), { kind: 'briefing-end' }),
  // Gujarati, Latin letters
  fixed('gu', R(`(?:aaj ni |aajni |mari )?(?:${alt('morning', 'savar ni')} )?${BRIEF_R} ${alt('sambhlavo', 'sambhalavo', 'sambhdavo', 'sambhlav', 'aapo', 'aap', 'kaho', 'sharu karo', 'chalu kar')}`), briefing(false)),
  fixed('gu', R(`${alt('tunki', 'tuki', 'nani', 'jaldi', 'jhadapthi')} ${BRIEF_R} ${alt('sambhlavo', 'sambhalavo', 'aapo', 'kaho')}`), briefing(true)),
  fixed('gu', R(`${BRIEF_R} ${alt('bandh karo', 'bandh kar', 'rehva do', 'reva do', 'rehva de', 'roko')}|aaje ${BRIEF_R} nahi|${BRIEF_R} nathi joti`), { kind: 'briefing-end' }),
  // Shared romanised words
  fixed('mixed', R(`${BRIEF_R} ${alt('band karo', 'band kar', 'band kar do', 'off karo', 'cancel karo')}`), { kind: 'briefing-end' }),
  fixed('mixed', R(`${BRIEF_R} ${alt('do', 'start', 'shuru')}`), briefing(false)),
]

/** "Next part" — only while a briefing is being read out. */
const BRIEFING_SKIP: Entry[] = [
  fixed('hi', R(`${alt('आगे', 'आगे बढो', 'आगे बढिए', 'आगे चलो', 'अगला', 'अगला वाला', 'अगला हिस्सा', 'अगली बात', 'इसे छोडो', 'ये छोडो', 'यह छोडो')}`), { kind: 'briefing-skip' }),
  fixed('gu', R(`${alt('આગળ', 'આગળ વધો', 'આગળ વધ', 'આગળ ચાલો', 'પછી નું', 'હવે પછી નું', 'આ છોડો', 'આ છોડ')}`), { kind: 'briefing-skip' }),
  fixed('hi', R(`${alt('aage', 'aage badho', 'aage chalo', 'agla', 'agla wala', 'agli baat', 'ise chhodo', 'ye chhodo')}`), { kind: 'briefing-skip' }),
  fixed('gu', R(`${alt('aagal', 'agal', 'aagal vadho', 'agal vadho', 'pachhi nu', 'pachi nu', 'aa chhodo')}`), { kind: 'briefing-skip' }),
  fixed('hi', R(`(?:बाकी|baaki|baki) ${alt('छोडो', 'रहने दो', 'chhodo', 'rehne do')}`), { kind: 'briefing-end' }),
  fixed('gu', R(`(?:બાકી ${alt('છોડો', 'રહેવા દો')}|baki ${alt('chhodo', 'rehva do')})`), { kind: 'briefing-end' }),
]

/** "Yes" / "no" — only right after he offered the briefing at a wake. */
const OFFER_ANSWERS: Entry[] = [
  fixed('hi', R(`${alt('हां', 'हां हां', 'हां सुनाओ', 'हां बताओ', 'सुनाओ', 'जरूर', 'ठीक है', 'चलो', 'बिल्कुल', 'हां क्यों नहीं')}`), briefing(false)),
  fixed('hi', R(`${alt('नहीं', 'ना', 'अभी नहीं', 'नहीं अभी नहीं', 'बाद में', 'नहीं चाहिए', 'नहीं धन्यवाद')}`), { kind: 'briefing-end' }),
  fixed('gu', R(`${alt('હા', 'હા હા', 'હા સંભળાવો', 'સંભળાવો', 'જરૂર', 'ચાલો', 'બરાબર', 'ભલે', 'હા કેમ નહીં')}`), briefing(false)),
  fixed('gu', R(`${alt('ના', 'ના ના', 'હમણાં નહીં', 'અત્યારે નહીં', 'પછી', 'પછી થી', 'નથી જોઈતું', 'ના આભાર')}`), { kind: 'briefing-end' }),
  fixed('hi', R(`${alt('haan', 'haan haan', 'haan sunao', 'sunao', 'zaroor', 'jaroor', 'jarur', 'theek hai', 'thik hai', 'bilkul')}`), briefing(false)),
  fixed('hi', R(`${alt('nahi', 'nahin', 'abhi nahi', 'baad mein', 'baad me', 'nahi chahiye')}`), { kind: 'briefing-end' }),
  fixed('gu', R(`${alt('sambhlavo', 'barabar', 'bhale')}`), briefing(false)),
  fixed('gu', R(`${alt('hamna nahi', 'atyare nahi', 'pachhi', 'pachi')}`), { kind: 'briefing-end' }),
  fixed('mixed', R(`${alt('ha', 'haa', 'ha ha', 'chalo')}`), briefing(false)),
  fixed('mixed', R(`${alt('na', 'na na')}`), { kind: 'briefing-end' }),
]

// Order matters only where two lists could both match; the shared romanised
// words are tried last so a distinctively Hindi or Gujarati phrase keeps its
// language. The briefing comes first so "ब्रीफिंग बंद करो" is not read as a
// plain stop.
const ALL: Entry[] = [...BRIEFING_ALWAYS, ...HINDI, ...GUJARATI, ...HINDI_ROMAN, ...GUJARATI_ROMAN, ...MIXED]

/**
 * The reflex a normalised Hindi or Gujarati utterance asks for, and which
 * language it was in; null to send it to the model. `ctx` says what the page
 * is in the middle of (a briefing, an offer), as for English.
 */
export function matchIndic(s: string, ctx: MatchContext = {}): { reflex: Reflex; heard: Heard } | null {
  const lists: Entry[] = []
  if (ctx.offered && !ctx.briefing) lists.push(...OFFER_ANSWERS)
  if (ctx.briefing) lists.push(...BRIEFING_SKIP)
  for (const e of [...lists, ...ALL]) {
    const m = e.re.exec(s)
    if (!m) continue
    const reflex = e.make(m)
    if (reflex) return { reflex, heard: e.heard }
  }
  return null
}
