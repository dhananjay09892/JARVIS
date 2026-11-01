/**
 * The briefing's words in English, Hindi and Gujarati (plans 12 + 28, Q78).
 *
 * One "book" per language and script: Hindi and Gujarati in their own script
 * (Devanagari, Gujarati) or in Latin letters, as the owner's language profile
 * asks (JARVIS_TEXT_SCRIPT). The English book is the exact wording the
 * briefing had before (Q34).
 *
 * What stays as it came: calendar titles, mail senders, workflow names and
 * place names are the owner's own text and are never translated. Numbers stay
 * as digits, which every voice reads in either script. Weather conditions are
 * translated when they are one of the weather connector's (C16) plain WMO
 * descriptions, and otherwise said as they came.
 *
 * Weekday and month names are kept here rather than asked of Intl, whose
 * Gujarati and Hindi support varies between Node builds (as in the page's
 * src/lib/reflexSay.ts, whose wording these follow).
 */

const ordinal = (n) => {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A BCP 47 tag we can hand to Intl, or the fallback. */
export function safeLocale(locale, fallback = 'en-GB') {
  if (typeof locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale)) return fallback
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : fallback
  } catch {
    return fallback
  }
}

/** "a", "b and c", "a, b and c", with the language's "and". */
const joinWith = (and) => (items) => {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`
}

/** 0 morning, 1 afternoon, 2 evening, 3 night: how a clock time is said in Hindi and Gujarati. */
function dayPart(ts) {
  const h = new Date(ts).getHours()
  if (h >= 4 && h < 12) return 0
  if (h >= 12 && h < 16) return 1
  if (h >= 16 && h < 20) return 2
  return 3
}
const twelve = (ts) => {
  const d = new Date(ts)
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 0 morning, 1 afternoon, 2 evening: which greeting. */
const greetingPart = (ts) => {
  const h = new Date(ts).getHours()
  return h < 12 ? 0 : h < 18 ? 1 : 2
}

/** The weather connector's WMO descriptions, lower case, in each language. */
const CONDITIONS = {
  'clear sky': ['आसमान साफ़', 'aasmaan saaf', 'આકાશ ચોખ્ખું', 'aakash chokhkhu'],
  'mainly clear': ['ज़्यादातर साफ़', 'zyaadatar saaf', 'મોટે ભાગે ચોખ્ખું', 'mote bhage chokhkhu'],
  'partly cloudy': ['हल्के बादल', 'halke baadal', 'થોડાં વાદળ', 'thoda vadal'],
  overcast: ['घने बादल', 'ghane baadal', 'ઘેરાં વાદળ', 'ghera vadal'],
  fog: ['कोहरा', 'kohra', 'ધુમ્મસ', 'dhummas'],
  'light drizzle': ['हल्की बूंदाबांदी', 'halki boondaabaandi', 'હળવી ઝરમર', 'halvi zarmar'],
  drizzle: ['बूंदाबांदी', 'boondaabaandi', 'ઝરમર', 'zarmar'],
  'heavy drizzle': ['तेज़ बूंदाबांदी', 'tez boondaabaandi', 'ભારે ઝરમર', 'bhare zarmar'],
  'light rain': ['हल्की बारिश', 'halki baarish', 'હળવો વરસાદ', 'halvo varsad'],
  rain: ['बारिश', 'baarish', 'વરસાદ', 'varsad'],
  'heavy rain': ['तेज़ बारिश', 'tez baarish', 'ભારે વરસાદ', 'bhare varsad'],
  'light rain showers': ['हल्की बौछारें', 'halki bauchhaarein', 'હળવાં ઝાપટાં', 'halva zapta'],
  'rain showers': ['बौछारें', 'bauchhaarein', 'ઝાપટાં', 'zapta'],
  'violent rain showers': ['बहुत तेज़ बौछारें', 'bahut tez bauchhaarein', 'ખૂબ ભારે ઝાપટાં', 'khub bhare zapta'],
  thunderstorm: ['आंधी-तूफ़ान', 'aandhi-toofaan', 'વાવાઝોડું', 'vavazodu'],
  'light snow': ['हल्की बर्फ़बारी', 'halki barfbaari', 'હળવી હિમવર્ષા', 'halvi himvarsha'],
  snow: ['बर्फ़बारी', 'barfbaari', 'હિમવર્ષા', 'himvarsha'],
  'heavy snow': ['भारी बर्फ़बारी', 'bhaari barfbaari', 'ભારે હિમવર્ષા', 'bhare himvarsha'],
}
const condition = (column) => (c) => CONDITIONS[c]?.[column] ?? c

// ---------------------------------------------------------------------------
// English (the Q34 wording, unchanged)
// ---------------------------------------------------------------------------

const enList = joinWith('and')

const ENGLISH = {
  lang: 'en',
  list: enList,
  hello(ts) {
    const d = new Date(ts)
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(d)
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(d)
    return `${['Good morning', 'Good afternoon', 'Good evening'][greetingPart(ts)]}. It's ${weekday}, the ${ordinal(d.getDate())} of ${month}.`
  },
  time: (ts, locale) => new Intl.DateTimeFormat(safeLocale(locale), { hour: 'numeric', minute: '2-digit' }).format(new Date(ts)),
  condition: (c) => c,
  degrees: (n, unit) => `${n} degrees${unit === '°F' ? ' Fahrenheit' : ''}`,
  weatherNow(place, deg, cond) {
    return `${place ? `In ${place} it's` : "It's"} ${deg} and ${cond}.`
  },
  weatherNowShort: (deg, cond) => `It's ${deg} and ${cond}.`,
  weatherToday(cond, low, highDeg, rain) {
    const range = low !== null ? `, ${low} to ${highDeg}` : ''
    return `Today, ${cond}${range}${rain !== null ? `, ${rain} percent chance of rain` : ''}.`
  },
  umbrella: 'Worth taking an umbrella.',
  allDay: (title) => `${title}, all day`,
  at: (title, time) => `${title} at ${time}`,
  moreItems: (n) => `${n} more`,
  calendarNone: 'Nothing else on your calendar today.',
  calendarOne: (item) => `One thing on your calendar today: ${item}.`,
  calendarMany: (n, items) => `You have ${n} things on your calendar today: ${enList(items)}.`,
  mailNone: 'No new email.',
  mail(count, important, senders) {
    let s = plural(count, 'new email')
    if (important) s += `, ${important} marked important`
    if (senders) s += `, from ${enList(senders.shown.concat(senders.more ? [plural(senders.more, 'other')] : []))}`
    return `${s}.`
  },
  workflowsFailed: (names) => `The ${enList(names)} workflow${names.length > 1 ? 's' : ''} failed.`,
  workflowsFine: (n) => `${plural(n, 'workflow run')} finished fine.`,
  tasks(n, failed, stopped) {
    let s = `${plural(n, 'background task')} finished`
    const counts = []
    if (failed) counts.push(`${failed} failed`)
    if (stopped) counts.push(`${stopped} ${stopped === 1 ? 'was' : 'were'} stopped`)
    if (counts.length) s += `; ${enList(counts)}`
    return `${s}.`
  },
  failedTitles: (titles) => `Failed: ${enList(titles)}.`,
  overnight: (parts) => `Overnight: ${parts.join(' ')}`,
  heldCount: (n, askAlone) => `I held back ${plural(n, 'alert')}${askAlone ? '; ask me when you are alone' : ''}.`,
  heldList(shown, more, hidden) {
    const tail = more ? `, and ${plural(more, 'other')}${hidden ? ' I will tell you when you are alone' : ''}` : ''
    return `While you were away: ${enList(shown)}${tail}.`
  },
  nothing: "I have nothing to brief you on yet. Set up the weather or your calendar in Settings, under Connectors, and I'll include them.",
  offer: (ts) => `${['Good morning', 'Good afternoon', 'Good evening'][greetingPart(ts)]}, sir. Your briefing is ready. Shall I go ahead?`,
}

// ---------------------------------------------------------------------------
// Hindi
// ---------------------------------------------------------------------------

const HI_DAYS = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार']
const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
const HI_PARTS = ['सुबह', 'दोपहर', 'शाम', 'रात']
const HI_HELLO = ['सुप्रभात', 'नमस्ते', 'शुभ संध्या']
const hiList = joinWith('और')

const HINDI = {
  lang: 'hi',
  list: hiList,
  hello(ts) {
    const d = new Date(ts)
    return `${HI_HELLO[greetingPart(ts)]}। आज ${HI_DAYS[d.getDay()]}, ${d.getDate()} ${HI_MONTHS[d.getMonth()]} है।`
  },
  time: (ts) => `${HI_PARTS[dayPart(ts)]} ${twelve(ts)} बजे`,
  condition: condition(0),
  degrees: (n, unit) => `${n} डिग्री${unit === '°F' ? ' फ़ारेनहाइट' : ''}`,
  weatherNow: (place, deg, cond) => `${place ? `${place} में ` : ''}अभी ${cond}, ${deg}।`,
  weatherNowShort: (deg, cond) => `अभी ${cond}, ${deg}।`,
  weatherToday(cond, low, highDeg, rain) {
    const range = low !== null ? `, ${low} से ${highDeg}` : ''
    return `आज ${cond}${range}${rain !== null ? `, बारिश की ${rain} प्रतिशत संभावना` : ''}।`
  },
  umbrella: 'छाता साथ रख लीजिए।',
  allDay: (title) => `${title}, पूरे दिन`,
  at: (title, time) => `${title} ${time}`,
  moreItems: (n) => `${n} और`,
  calendarNone: 'आज कैलेंडर पर और कुछ नहीं है।',
  calendarOne: (item) => `आज कैलेंडर पर एक चीज़ है: ${item}।`,
  calendarMany: (n, items) => `आज कैलेंडर पर ${n} चीज़ें हैं: ${hiList(items)}।`,
  mailNone: 'कोई नया ईमेल नहीं।',
  mail(count, important, senders) {
    let s = `${count} ${count === 1 ? 'नया' : 'नए'} ईमेल`
    if (important) s += `, ${important} ज़रूरी`
    if (senders) s += `, ${hiList(senders.shown.concat(senders.more ? [`${senders.more} और`] : []))} से`
    return `${s}।`
  },
  workflowsFailed: (names) => `${hiList(names)} वर्कफ़्लो फ़ेल ${names.length > 1 ? 'हो गए' : 'हो गया'}।`,
  workflowsFine: (n) => `${n} वर्कफ़्लो ठीक से ${n === 1 ? 'पूरा हुआ' : 'पूरे हुए'}।`,
  tasks(n, failed, stopped) {
    let s = `${n} बैकग्राउंड ${n === 1 ? 'काम पूरा हुआ' : 'काम पूरे हुए'}`
    const counts = []
    if (failed) counts.push(`${failed} फ़ेल`)
    if (stopped) counts.push(`${stopped} ${stopped === 1 ? 'रोका गया' : 'रोके गए'}`)
    if (counts.length) s += `; ${hiList(counts)}`
    return `${s}।`
  },
  failedTitles: (titles) => `फ़ेल: ${hiList(titles)}।`,
  overnight: (parts) => `रात में: ${parts.join(' ')}`,
  heldCount: (n, askAlone) => `मैंने ${n} ${n === 1 ? 'सूचना' : 'सूचनाएँ'} रोक कर रखी${askAlone ? '; जब आप अकेले हों तब पूछिए' : ''}।`,
  heldList(shown, more, hidden) {
    const tail = more ? `, और ${more} और${hidden ? ', जो मैं आपको अकेले में बताऊँगा' : ''}` : ''
    return `आपके पीछे से: ${hiList(shown)}${tail}।`
  },
  nothing: 'अभी ब्रीफिंग के लिए कुछ नहीं है। Settings में Connectors के नीचे मौसम या अपना कैलेंडर जोड़िए, मैं उन्हें शामिल कर लूँगा।',
  offer: (ts) => `${HI_HELLO[greetingPart(ts)]}, सर। आपकी ब्रीफिंग तैयार है। सुनाऊँ?`,
}

const HI_DAYS_R = ['Ravivaar', 'Somvaar', 'Mangalvaar', 'Budhvaar', 'Guruvaar', 'Shukravaar', 'Shanivaar']
const MONTHS_R = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const HI_PARTS_R = ['subah', 'dopahar', 'shaam', 'raat']
const HI_HELLO_R = ['Suprabhat', 'Namaste', 'Shubh sandhya']
const hiListR = joinWith('aur')

const HINDI_ROMAN = {
  lang: 'hi',
  list: hiListR,
  hello(ts) {
    const d = new Date(ts)
    return `${HI_HELLO_R[greetingPart(ts)]}. Aaj ${HI_DAYS_R[d.getDay()]}, ${d.getDate()} ${MONTHS_R[d.getMonth()]} hai.`
  },
  time: (ts) => `${HI_PARTS_R[dayPart(ts)]} ${twelve(ts)} baje`,
  condition: condition(1),
  degrees: (n, unit) => `${n} degree${unit === '°F' ? ' Fahrenheit' : ''}`,
  weatherNow: (place, deg, cond) => `${place ? `${place} mein abhi` : 'Abhi'} ${cond}, ${deg}.`,
  weatherNowShort: (deg, cond) => `Abhi ${cond}, ${deg}.`,
  weatherToday(cond, low, highDeg, rain) {
    const range = low !== null ? `, ${low} se ${highDeg}` : ''
    return `Aaj ${cond}${range}${rain !== null ? `, baarish ki ${rain} pratishat sambhaavna` : ''}.`
  },
  umbrella: 'Chhaata saath rakh lijiye.',
  allDay: (title) => `${title}, poore din`,
  at: (title, time) => `${title} ${time}`,
  moreItems: (n) => `${n} aur`,
  calendarNone: 'Aaj calendar par aur kuch nahi hai.',
  calendarOne: (item) => `Aaj calendar par ek cheez hai: ${item}.`,
  calendarMany: (n, items) => `Aaj calendar par ${n} cheezein hain: ${hiListR(items)}.`,
  mailNone: 'Koi naya email nahi.',
  mail(count, important, senders) {
    let s = `${count} ${count === 1 ? 'naya' : 'naye'} email`
    if (important) s += `, ${important} zaroori`
    if (senders) s += `, ${hiListR(senders.shown.concat(senders.more ? [`${senders.more} aur`] : []))} se`
    return `${s}.`
  },
  workflowsFailed: (names) => `${hiListR(names)} workflow fail ${names.length > 1 ? 'ho gaye' : 'ho gaya'}.`,
  workflowsFine: (n) => `${n} workflow theek se ${n === 1 ? 'poora hua' : 'poore hue'}.`,
  tasks(n, failed, stopped) {
    let s = `${n} background ${n === 1 ? 'kaam poora hua' : 'kaam poore hue'}`
    const counts = []
    if (failed) counts.push(`${failed} fail`)
    if (stopped) counts.push(`${stopped} ${stopped === 1 ? 'roka gaya' : 'roke gaye'}`)
    if (counts.length) s += `; ${hiListR(counts)}`
    return `${s}.`
  },
  failedTitles: (titles) => `Fail: ${hiListR(titles)}.`,
  overnight: (parts) => `Raat mein: ${parts.join(' ')}`,
  heldCount: (n, askAlone) => `Maine ${n} ${n === 1 ? 'soochna' : 'soochnaayein'} rok kar rakhi${askAlone ? '; jab aap akele hon tab poochhiye' : ''}.`,
  heldList(shown, more, hidden) {
    const tail = more ? `, aur ${more} aur${hidden ? ', jo main aapko akele mein bataaunga' : ''}` : ''
    return `Aapke peechhe se: ${hiListR(shown)}${tail}.`
  },
  nothing: 'Abhi briefing ke liye kuch nahi hai. Settings mein Connectors ke neeche mausam ya apna calendar jodiye, main unhe shaamil kar loonga.',
  offer: (ts) => `${HI_HELLO_R[greetingPart(ts)]}, sir. Aapki briefing taiyaar hai. Sunaaun?`,
}

// ---------------------------------------------------------------------------
// Gujarati
// ---------------------------------------------------------------------------

const GU_DAYS = ['રવિવાર', 'સોમવાર', 'મંગળવાર', 'બુધવાર', 'ગુરુવાર', 'શુક્રવાર', 'શનિવાર']
const GU_MONTHS = ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઑગસ્ટ', 'સપ્ટેમ્બર', 'ઑક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર']
const GU_PARTS = ['સવારે', 'બપોરે', 'સાંજે', 'રાત્રે']
const GU_HELLO = ['સુપ્રભાત', 'નમસ્તે', 'શુભ સાંજ']
const guList = joinWith('અને')

const GUJARATI = {
  lang: 'gu',
  list: guList,
  hello(ts) {
    const d = new Date(ts)
    return `${GU_HELLO[greetingPart(ts)]}. આજે ${GU_DAYS[d.getDay()]}, ${d.getDate()} ${GU_MONTHS[d.getMonth()]} છે.`
  },
  time: (ts) => `${GU_PARTS[dayPart(ts)]} ${twelve(ts)} વાગ્યે`,
  condition: condition(2),
  degrees: (n, unit) => `${n} ડિગ્રી${unit === '°F' ? ' ફેરનહાઇટ' : ''}`,
  weatherNow: (place, deg, cond) => `${place ? `${place}માં ` : ''}અત્યારે ${cond}, ${deg}.`,
  weatherNowShort: (deg, cond) => `અત્યારે ${cond}, ${deg}.`,
  weatherToday(cond, low, highDeg, rain) {
    const range = low !== null ? `, ${low} થી ${highDeg}` : ''
    return `આજે ${cond}${range}${rain !== null ? `, વરસાદની ${rain} ટકા શક્યતા` : ''}.`
  },
  umbrella: 'છત્રી સાથે રાખજો.',
  allDay: (title) => `${title}, આખો દિવસ`,
  at: (title, time) => `${title} ${time}`,
  moreItems: (n) => `બીજી ${n}`,
  calendarNone: 'આજે કૅલેન્ડરમાં બીજું કંઈ નથી.',
  calendarOne: (item) => `આજે કૅલેન્ડરમાં એક વસ્તુ છે: ${item}.`,
  calendarMany: (n, items) => `આજે કૅલેન્ડરમાં ${n} વસ્તુઓ છે: ${guList(items)}.`,
  mailNone: 'કોઈ નવો ઈમેલ નથી.',
  mail(count, important, senders) {
    let s = `${count} ${count === 1 ? 'નવો' : 'નવા'} ઈમેલ`
    if (important) s += `, ${important} મહત્ત્વના`
    if (senders) s += `, ${guList(senders.shown.concat(senders.more ? [`બીજા ${senders.more}`] : []))} તરફથી`
    return `${s}.`
  },
  workflowsFailed: (names) => `${guList(names)} વર્કફ્લો નિષ્ફળ ${names.length > 1 ? 'ગયા' : 'ગયો'}.`,
  workflowsFine: (n) => `${n} વર્કફ્લો બરાબર ${n === 1 ? 'પૂરો થયો' : 'પૂરા થયા'}.`,
  tasks(n, failed, stopped) {
    let s = `${n} બૅકગ્રાઉન્ડ ${n === 1 ? 'કામ પૂરું થયું' : 'કામ પૂરાં થયાં'}`
    const counts = []
    if (failed) counts.push(`${failed} નિષ્ફળ`)
    if (stopped) counts.push(`${stopped} અટકાવ્યાં`)
    if (counts.length) s += `; ${guList(counts)}`
    return `${s}.`
  },
  failedTitles: (titles) => `નિષ્ફળ: ${guList(titles)}.`,
  overnight: (parts) => `રાત દરમિયાન: ${parts.join(' ')}`,
  heldCount: (n, askAlone) => `મેં ${n} સૂચના રોકી રાખી${askAlone ? '; તમે એકલા હો ત્યારે પૂછજો' : ''}.`,
  heldList(shown, more, hidden) {
    const tail = more ? `, અને બીજી ${more}${hidden ? ', જે હું તમને એકલામાં કહીશ' : ''}` : ''
    return `તમારી ગેરહાજરીમાં: ${guList(shown)}${tail}.`
  },
  nothing: 'હજી બ્રીફિંગ માટે કંઈ નથી. Settings માં Connectors નીચે હવામાન કે તમારું કૅલેન્ડર ઉમેરો, હું તેમને સામેલ કરીશ.',
  offer: (ts) => `${GU_HELLO[greetingPart(ts)]}, સર. તમારી બ્રીફિંગ તૈયાર છે. સંભળાવું?`,
}

const GU_DAYS_R = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar']
const GU_PARTS_R = ['savare', 'bapore', 'saanje', 'raatre']
const GU_HELLO_R = ['Suprabhat', 'Namaste', 'Shubh saanj']
const guListR = joinWith('ane')

const GUJARATI_ROMAN = {
  lang: 'gu',
  list: guListR,
  hello(ts) {
    const d = new Date(ts)
    return `${GU_HELLO_R[greetingPart(ts)]}. Aaje ${GU_DAYS_R[d.getDay()]}, ${d.getDate()} ${MONTHS_R[d.getMonth()]} che.`
  },
  time: (ts) => `${GU_PARTS_R[dayPart(ts)]} ${twelve(ts)} vagye`,
  condition: condition(3),
  degrees: (n, unit) => `${n} degree${unit === '°F' ? ' Fahrenheit' : ''}`,
  weatherNow: (place, deg, cond) => `${place ? `${place} ma atyare` : 'Atyare'} ${cond}, ${deg}.`,
  weatherNowShort: (deg, cond) => `Atyare ${cond}, ${deg}.`,
  weatherToday(cond, low, highDeg, rain) {
    const range = low !== null ? `, ${low} thi ${highDeg}` : ''
    return `Aaje ${cond}${range}${rain !== null ? `, varsad ni ${rain} taka shakyata` : ''}.`
  },
  umbrella: 'Chhatri saathe rakhjo.',
  allDay: (title) => `${title}, aakho divas`,
  at: (title, time) => `${title} ${time}`,
  moreItems: (n) => `biji ${n}`,
  calendarNone: 'Aaje calendar ma biju kai nathi.',
  calendarOne: (item) => `Aaje calendar ma ek vastu che: ${item}.`,
  calendarMany: (n, items) => `Aaje calendar ma ${n} vastuo che: ${guListR(items)}.`,
  mailNone: 'Koi navo email nathi.',
  mail(count, important, senders) {
    let s = `${count} ${count === 1 ? 'navo' : 'nava'} email`
    if (important) s += `, ${important} mahattvana`
    if (senders) s += `, ${guListR(senders.shown.concat(senders.more ? [`bija ${senders.more}`] : []))} taraf thi`
    return `${s}.`
  },
  workflowsFailed: (names) => `${guListR(names)} workflow nishfal ${names.length > 1 ? 'gaya' : 'gayo'}.`,
  workflowsFine: (n) => `${n} workflow barabar ${n === 1 ? 'puro thayo' : 'pura thaya'}.`,
  tasks(n, failed, stopped) {
    let s = `${n} background ${n === 1 ? 'kaam puru thayu' : 'kaam pura thaya'}`
    const counts = []
    if (failed) counts.push(`${failed} nishfal`)
    if (stopped) counts.push(`${stopped} atkavya`)
    if (counts.length) s += `; ${guListR(counts)}`
    return `${s}.`
  },
  failedTitles: (titles) => `Nishfal: ${guListR(titles)}.`,
  overnight: (parts) => `Raat darmiyan: ${parts.join(' ')}`,
  heldCount: (n, askAlone) => `Me ${n} suchna roki rakhi${askAlone ? '; tame ekla ho tyare puchhjo' : ''}.`,
  heldList(shown, more, hidden) {
    const tail = more ? `, ane biji ${more}${hidden ? ', je hu tamne ekla ma kahish' : ''}` : ''
    return `Tamari gerhajri ma: ${guListR(shown)}${tail}.`
  },
  nothing: 'Haji briefing mate kai nathi. Settings ma Connectors niche havaman ke tamaru calendar umero, hu temne samel karish.',
  offer: (ts) => `${GU_HELLO_R[greetingPart(ts)]}, sir. Tamari briefing taiyar che. Sambhlavu?`,
}

export const BRIEFING_LANGS = Object.freeze(['en', 'hi', 'gu'])

/** The book for a language and script; English for anything unknown. */
export function briefingWords(lang = 'en', script = 'native') {
  const roman = script === 'roman'
  if (lang === 'hi') return roman ? HINDI_ROMAN : HINDI
  if (lang === 'gu') return roman ? GUJARATI_ROMAN : GUJARATI
  return ENGLISH
}
