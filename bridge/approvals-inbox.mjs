/**
 * The approvals inbox: every card waiting on the owner, from every mission
 * and from workflows, as one numbered list, answered in the app or by voice.
 *
 * Voice is the risky part, so it is narrow:
 *   - The words that decide are the owner's own last message, read here. A
 *     position, an "all" or a yes/no the model passes in is never used.
 *   - A position means a card the page reported it is showing, in the order
 *     it showed them. A card that is not on screen cannot be named, and
 *     "all" means the cards on screen, not everything pending.
 *   - Unclear words answer nothing. Only "approve" and "deny" style words
 *     count; a question about the cards ("what is waiting?") changes nothing.
 *
 * Nothing here weakens the policy engine: a card is only ever answered
 * through the same one-shot hub reply a click uses.
 */

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

const MAX_SHOWN = 20

/** `Task "Trip planning" (Researcher): Send the email` → its parts; other cards have no mission. */
export function cardParts(title) {
  const m = /^Task "(.*?)"(?: \((.*?)\))?: ([\s\S]*)$/.exec(typeof title === 'string' ? title : '')
  return m ? { mission: m[1], agent: m[2] || '', action: m[3] } : { mission: '', agent: '', action: clip(title, 200) }
}

/** What the page and the voice list show for a pending card. */
export function inboxCards(pending) {
  return pending.map((p, i) => ({
    position: i + 1,
    id: p.id,
    ...cardParts(p.title),
    details: clip(p.details, 600),
  }))
}

const ORDINALS = new Map(Object.entries({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}))
const CARDINALS = new Map(Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }))
/** A number word names a card only after one of these: "the second one" is not card 1. */
const LEADS = new Set(['number', 'card', 'item', 'and', 'or', 'plus', 'then'])

const APPROVE = /\b(approve|approved|accept|allow|confirm|yes)\b/
const DENY = /\b(deny|denied|reject|rejected|decline|refuse|dismiss|no)\b/

/**
 * What the owner's words ask of the cards on screen.
 *
 * "approve the first two" → positions 1, 2; "deny the third" → 3; "approve
 * 1 and 3"; "approve all". Returns `{ decision, positions }`, or `{ reason }`
 * when the words are not a clear answer.
 *
 * @param {string} text the owner's last message
 * @param {number} shown how many cards are on screen
 */
export function parseVoiceAnswer(text, shown) {
  const t = clip(text, 500).toLowerCase()
  const yes = APPROVE.test(t)
  const no = DENY.test(t)
  if (yes === no) return { reason: 'The owner\'s last words did not clearly approve or deny.' }
  if (!shown) return { reason: 'No card is on screen to answer.' }
  const decision = yes ? 'approve' : 'deny'
  if (/\b(all|everything|every one|them all)\b/.test(t)) return { decision, positions: Array.from({ length: shown }, (_, i) => i + 1) }
  const words = t.split(/[^a-z0-9]+/).filter(Boolean)
  const positions = new Set()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const n = /^\d{1,2}$/.test(w) ? Number(w) : ORDINALS.get(w) ?? (LEADS.has(words[i - 1]) ? CARDINALS.get(w) : undefined)
    if (!n) continue
    // "the first two" / "the first 3": a count after "first" means the first N.
    if (w === 'first' && i + 1 < words.length) {
      const count = /^\d{1,2}$/.test(words[i + 1]) ? Number(words[i + 1]) : CARDINALS.get(words[i + 1])
      if (count && count > 1) {
        for (let k = 1; k <= count; k++) positions.add(k)
        i += 1
        continue
      }
    }
    positions.add(n)
  }
  if (!positions.size) {
    return shown === 1
      ? { decision, positions: [1] }
      : { reason: `Which ones? ${shown} cards are on screen, numbered from 1.` }
  }
  const out = [...positions].sort((a, b) => a - b)
  if (out.some((n) => n < 1 || n > shown)) return { reason: `Only cards 1 to ${shown} are on screen.` }
  return { decision, positions: out }
}

/**
 * One session's inbox over the approval hub.
 *
 * @param {{ list: () => { id: string, title: string, details: string }[], reply: (id: string, approved: boolean) => boolean }} hub
 * @param {{ ownerText: () => string }} o ownerText: the owner's last message this session
 */
export function createInbox(hub, { ownerText }) {
  /** Ids the page says it is showing, in its order. */
  let shown = []
  return {
    /** The page reports which cards it is displaying, in order. */
    shownByPage(ids) {
      shown = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string').slice(0, MAX_SHOWN) : []
    },
    list() {
      return inboxCards(hub.list())
    },
    /** What is waiting and on screen, numbered as the page numbers them. */
    summary() {
      const byId = new Map(inboxCards(hub.list()).map((c) => [c.id, c]))
      const cards = []
      shown.forEach((id, i) => { if (byId.has(id)) cards.push({ ...byId.get(id), position: i + 1 }) })
      return { waiting: byId.size, onScreen: shown.length, cards }
    },
    /** Answer cards by the owner's own last words. Never takes a position or a verdict from the caller. */
    answerByVoice() {
      const pending = new Map(hub.list().map((p) => [p.id, p]))
      // Positions are the page's numbers. A card the page shows that is not
      // in the hub (a per-turn card) keeps its number and is never answered here.
      const visible = shown
      const parsed = parseVoiceAnswer(ownerText(), visible.length)
      if (!parsed.positions) return { answered: [], reason: parsed.reason }
      const approved = parsed.decision === 'approve'
      const answered = []
      for (const pos of parsed.positions) {
        const id = visible[pos - 1]
        if (id && pending.has(id) && hub.reply(id, approved)) {
          const parts = cardParts(pending.get(id).title)
          answered.push({ position: pos, mission: parts.mission, action: parts.action })
        }
      }
      return { decision: parsed.decision, answered }
    },
  }
}
