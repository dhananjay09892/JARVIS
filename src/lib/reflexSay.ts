/**
 * What reflexes say in Hindi and Gujarati (plans 06 + 28, Q75), in the
 * language's own script or in Latin letters, as the owner's language profile
 * asks (JARVIS_TEXT_SCRIPT). English lives in reflex.ts.
 *
 * Numbers stay as digits: every voice reads them, in either script. Clock
 * times are said the way people say them ("दोपहर के 3:05 बजे हैं"), and the
 * weekday and month names are kept here rather than asked of the browser,
 * whose Gujarati and Hindi support varies.
 */

export type Phrasebook = {
  time(d: Date): string
  date(d: Date): string
  duration(ms: number): string
  /** "the pasta timer" / "the 5 minute timer", in the language. */
  timerName(t: { ms: number; label?: string }): string
  nothingYet: string
  muted: string
  loudest: string
  quietest: string
  volume(pct: number): string
  tooMany(n: number): string
  timerSet(duration: string, label?: string): string
  noTimers: string
  cantFind(label: string): string
  cancelled(name: string): string
  cancelledAll(n: number): string
  cancelledOne(name: string, rest: number): string
  left(duration: string, name: string): string
  several(n: number, lines: string[], more: number): string
  timerDone(name: string): string
  /** The morning briefing (Q34, Q78). */
  briefingEnded: string
  briefingNone: string
  nothingToSkip: string
  /** "No" to the briefing offered at a wake (Q78). */
  briefingDeclined: string
}

/** Splits a duration into whole hours, minutes and seconds; seconds drop once there are hours. */
function parts(ms: number): { h: number; m: number; s: number } {
  let s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return { h, m, s: h ? 0 : s }
}

function joinDuration(ms: number, unit: (n: number, u: 'h' | 'm' | 's') => string, and: string): string {
  const { h, m, s } = parts(ms)
  const out: string[] = []
  if (h) out.push(unit(h, 'h'))
  if (m) out.push(unit(m, 'm'))
  if (s) out.push(unit(s, 's'))
  if (!out.length) return unit(0, 's')
  return out.length === 1 ? out[0] : `${out.slice(0, -1).join(' ')} ${and} ${out[out.length - 1]}`
}

const twelve = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`

/** Part of the day, the way a clock time is said in Hindi and Gujarati. */
function dayPart(d: Date): 0 | 1 | 2 | 3 {
  const h = d.getHours()
  if (h >= 4 && h < 12) return 0 // morning
  if (h >= 12 && h < 16) return 1 // afternoon
  if (h >= 16 && h < 20) return 2 // evening
  return 3 // night
}

const stripThe = (l: string) => l.replace(/^(?:the|my)\s+/i, '')

// -- Hindi ------------------------------------------------------------------

const HI_DAYS = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार']
const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
const HI_PARTS = ['सुबह', 'दोपहर', 'शाम', 'रात']

const hiDuration = (ms: number) =>
  joinDuration(ms, (n, u) => `${n} ${u === 'h' ? (n === 1 ? 'घंटा' : 'घंटे') : u === 'm' ? 'मिनट' : 'सेकंड'}`, 'और')
const hiName = (t: { ms: number; label?: string }) =>
  `${t.label ? stripThe(t.label) : hiDuration(t.ms)} वाला टाइमर`

const HINDI: Phrasebook = {
  time: (d) => `${HI_PARTS[dayPart(d)]} के ${twelve(d)} बजे हैं।`,
  date: (d) => `आज ${HI_DAYS[d.getDay()]}, ${d.getDate()} ${HI_MONTHS[d.getMonth()]} है।`,
  duration: hiDuration,
  timerName: hiName,
  nothingYet: 'मैंने अभी तक कुछ नहीं कहा है, सर।',
  muted: 'आवाज़ बंद। फिर से सुनने के लिए "अनम्यूट" कहिए।',
  loudest: 'इससे ज़्यादा आवाज़ नहीं हो सकती, सर।',
  quietest: 'इससे धीमी आवाज़ नहीं हो सकती। बिल्कुल चुप के लिए "म्यूट" कहिए।',
  volume: (p) => `आवाज़ ${p} प्रतिशत।`,
  tooMany: (n) => `${n} टाइमर पहले से चल रहे हैं, सर। पहले कोई एक बंद कीजिए।`,
  timerSet: (dur, label) => (label ? `${stripThe(label)} के लिए ${dur} का टाइमर लगा दिया।` : `${dur} का टाइमर लगा दिया।`),
  noTimers: 'कोई टाइमर नहीं चल रहा।',
  cantFind: (label) => `${label} वाला कोई टाइमर नहीं मिला।`,
  cancelled: (name) => `${name} बंद कर दिया।`,
  cancelledAll: (n) => `सारे ${n} टाइमर बंद कर दिए।`,
  cancelledOne: (name, rest) => `${name} बंद कर दिया। ${rest === 1 ? 'एक और टाइमर अभी चल रहा है।' : `${rest} और टाइमर अभी चल रहे हैं।`}`,
  left: (dur, name) => `${name.replace(/वाला टाइमर$/, 'वाले टाइमर')} में ${dur} बाकी हैं।`,
  several: (n, lines, more) => `${n} टाइमर। ${lines.join('; ')}${more ? `, और ${more} और` : ''}।`,
  timerDone: (name) => `सर, ${name} पूरा हो गया।`,
  briefingEnded: 'ठीक है, ब्रीफिंग यहीं रोक देता हूँ।',
  briefingNone: 'अभी कोई ब्रीफिंग नहीं चल रही, सर।',
  nothingToSkip: 'छोड़ने के लिए कुछ नहीं है, सर।',
  briefingDeclined: 'ठीक है, सर। जब चाहें "ब्रीफिंग सुनाओ" कहिए।',
}

const HI_DAYS_R = ['Ravivaar', 'Somvaar', 'Mangalvaar', 'Budhvaar', 'Guruvaar', 'Shukravaar', 'Shanivaar']
const MONTHS_R = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const HI_PARTS_R = ['Subah', 'Dopahar', 'Shaam', 'Raat']

const hiDurationR = (ms: number) =>
  joinDuration(ms, (n, u) => `${n} ${u === 'h' ? (n === 1 ? 'ghanta' : 'ghante') : u === 'm' ? 'minute' : 'second'}`, 'aur')
const hiNameR = (t: { ms: number; label?: string }) =>
  `${t.label ? stripThe(t.label) : hiDurationR(t.ms)} wala timer`

const HINDI_ROMAN: Phrasebook = {
  time: (d) => `${HI_PARTS_R[dayPart(d)]} ke ${twelve(d)} baje hain.`,
  date: (d) => `Aaj ${HI_DAYS_R[d.getDay()]}, ${d.getDate()} ${MONTHS_R[d.getMonth()]} hai.`,
  duration: hiDurationR,
  timerName: hiNameR,
  nothingYet: 'Maine abhi tak kuch nahi kaha hai, sir.',
  muted: 'Awaaz band. Phir se sunne ke liye "unmute" kahiye.',
  loudest: 'Isse zyada awaaz nahi ho sakti, sir.',
  quietest: 'Isse dheemi awaaz nahi ho sakti. Bilkul chup ke liye "mute" kahiye.',
  volume: (p) => `Awaaz ${p} pratishat.`,
  tooMany: (n) => `${n} timer pehle se chal rahe hain, sir. Pehle koi ek band kijiye.`,
  timerSet: (dur, label) => (label ? `${stripThe(label)} ke liye ${dur} ka timer laga diya.` : `${dur} ka timer laga diya.`),
  noTimers: 'Koi timer nahi chal raha.',
  cantFind: (label) => `${label} wala koi timer nahi mila.`,
  cancelled: (name) => `${name} band kar diya.`,
  cancelledAll: (n) => `Saare ${n} timer band kar diye.`,
  cancelledOne: (name, rest) => `${name} band kar diya. ${rest === 1 ? 'Ek aur timer abhi chal raha hai.' : `${rest} aur timer abhi chal rahe hain.`}`,
  left: (dur, name) => `${name.replace(/wala timer$/, 'wale timer')} mein ${dur} baaki hain.`,
  several: (n, lines, more) => `${n} timer. ${lines.join('; ')}${more ? `, aur ${more} aur` : ''}.`,
  timerDone: (name) => `Sir, ${name} poora ho gaya.`,
  briefingEnded: 'Theek hai, briefing yahin rok deta hoon.',
  briefingNone: 'Abhi koi briefing nahi chal rahi, sir.',
  nothingToSkip: 'Chhodne ke liye kuch nahi hai, sir.',
  briefingDeclined: 'Theek hai, sir. Jab chahein "briefing sunao" kahiye.',
}

// -- Gujarati ---------------------------------------------------------------

const GU_DAYS = ['રવિવાર', 'સોમવાર', 'મંગળવાર', 'બુધવાર', 'ગુરુવાર', 'શુક્રવાર', 'શનિવાર']
const GU_MONTHS = ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઑગસ્ટ', 'સપ્ટેમ્બર', 'ઑક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર']
const GU_PARTS = ['સવારના', 'બપોરના', 'સાંજના', 'રાતના']

const guDuration = (ms: number) =>
  joinDuration(ms, (n, u) => `${n} ${u === 'h' ? 'કલાક' : u === 'm' ? 'મિનિટ' : 'સેકન્ડ'}`, 'અને')
const guName = (t: { ms: number; label?: string }) =>
  `${t.label ? stripThe(t.label) : guDuration(t.ms)}વાળું ટાઈમર`

const GUJARATI: Phrasebook = {
  time: (d) => `${GU_PARTS[dayPart(d)]} ${twelve(d)} વાગ્યા છે.`,
  date: (d) => `આજે ${GU_DAYS[d.getDay()]}, ${d.getDate()} ${GU_MONTHS[d.getMonth()]} છે.`,
  duration: guDuration,
  timerName: guName,
  nothingYet: 'મેં હજી કંઈ કહ્યું નથી, સર.',
  muted: 'અવાજ બંધ. ફરી સાંભળવા માટે "અનમ્યૂટ" કહો.',
  loudest: 'આનાથી વધારે અવાજ નહીં થાય, સર.',
  quietest: 'આનાથી ધીમો અવાજ નહીં થાય. સાવ ચૂપ માટે "મ્યૂટ" કહો.',
  volume: (p) => `અવાજ ${p} ટકા.`,
  tooMany: (n) => `${n} ટાઈમર પહેલેથી ચાલે છે, સર. પહેલાં કોઈ એક બંધ કરો.`,
  timerSet: (dur, label) => (label ? `${stripThe(label)} માટે ${dur}નું ટાઈમર મૂકી દીધું.` : `${dur}નું ટાઈમર મૂકી દીધું.`),
  noTimers: 'કોઈ ટાઈમર ચાલુ નથી.',
  cantFind: (label) => `${label}વાળું કોઈ ટાઈમર મળ્યું નહીં.`,
  cancelled: (name) => `${name} બંધ કરી દીધું.`,
  cancelledAll: (n) => `બધા ${n} ટાઈમર બંધ કરી દીધા.`,
  cancelledOne: (name, rest) => `${name} બંધ કરી દીધું. ${rest === 1 ? 'બીજું એક ટાઈમર હજી ચાલે છે.' : `બીજા ${rest} ટાઈમર હજી ચાલે છે.`}`,
  left: (dur, name) => `${name}માં ${dur} બાકી છે.`,
  several: (n, lines, more) => `${n} ટાઈમર. ${lines.join('; ')}${more ? `, અને બીજા ${more}` : ''}.`,
  timerDone: (name) => `સર, ${name} પૂરું થયું.`,
  briefingEnded: 'ભલે, બ્રીફિંગ અહીં જ અટકાવું છું.',
  briefingNone: 'અત્યારે કોઈ બ્રીફિંગ ચાલુ નથી, સર.',
  nothingToSkip: 'છોડવા માટે કંઈ નથી, સર.',
  briefingDeclined: 'ભલે, સર. જ્યારે ઇચ્છો ત્યારે "બ્રીફિંગ સંભળાવો" કહેજો.',
}

const GU_DAYS_R = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar']
const GU_PARTS_R = ['Savarna', 'Baporna', 'Sanjna', 'Ratna']

const guDurationR = (ms: number) =>
  joinDuration(ms, (n, u) => `${n} ${u === 'h' ? 'kalak' : u === 'm' ? 'minit' : 'second'}`, 'ane')
const guNameR = (t: { ms: number; label?: string }) =>
  `${t.label ? stripThe(t.label) : guDurationR(t.ms)} valu timer`

const GUJARATI_ROMAN: Phrasebook = {
  time: (d) => `${GU_PARTS_R[dayPart(d)]} ${twelve(d)} vagya che.`,
  date: (d) => `Aaje ${GU_DAYS_R[d.getDay()]}, ${d.getDate()} ${MONTHS_R[d.getMonth()]} che.`,
  duration: guDurationR,
  timerName: guNameR,
  nothingYet: 'Me haji kai kahyu nathi, sir.',
  muted: 'Avaj bandh. Fari sambhalva mate "unmute" kaho.',
  loudest: 'Aanathi vadhare avaj nahi thay, sir.',
  quietest: 'Aanathi dhimo avaj nahi thay. Saav chup mate "mute" kaho.',
  volume: (p) => `Avaj ${p} taka.`,
  tooMany: (n) => `${n} timer pahelethi chale che, sir. Pahela koi ek bandh karo.`,
  timerSet: (dur, label) => (label ? `${stripThe(label)} mate ${dur} nu timer muki didhu.` : `${dur} nu timer muki didhu.`),
  noTimers: 'Koi timer chalu nathi.',
  cantFind: (label) => `${label} valu koi timer malyu nahi.`,
  cancelled: (name) => `${name} bandh kari didhu.`,
  cancelledAll: (n) => `Badha ${n} timer bandh kari didha.`,
  cancelledOne: (name, rest) => `${name} bandh kari didhu. ${rest === 1 ? 'Biju ek timer haji chale che.' : `Bija ${rest} timer haji chale che.`}`,
  left: (dur, name) => `${name} ma ${dur} baki che.`,
  several: (n, lines, more) => `${n} timer. ${lines.join('; ')}${more ? `, ane bija ${more}` : ''}.`,
  timerDone: (name) => `Sir, ${name} puru thayu.`,
  briefingEnded: 'Bhale, briefing ahiya j atkavu chu.',
  briefingNone: 'Atyare koi briefing chalu nathi, sir.',
  nothingToSkip: 'Chhodva mate kai nathi, sir.',
  briefingDeclined: 'Bhale, sir. Jyare icchho tyare "briefing sambhlavo" kahejo.',
}

/** The phrasebook for a Hindi or Gujarati reply in the given script. English lives in reflex.ts. */
export function indicPhrasebook(lang: 'hi' | 'gu', script: 'native' | 'roman'): Phrasebook {
  if (lang === 'hi') return script === 'roman' ? HINDI_ROMAN : HINDI
  return script === 'roman' ? GUJARATI_ROMAN : GUJARATI
}
