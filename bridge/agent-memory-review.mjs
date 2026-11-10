/**
 * Memory reviews handed back by agents shaped like the Memory Curator.
 *
 * A review is plain text in a fixed shape, set by the agent's instructions:
 *
 *   Memory review: 1 to keep, 1 to merge, 1 to check
 *
 *   Keep:
 *   - personal · The owner's daughter starts school on 5 January · said twice today
 *
 *   Merge:
 *   - #12 + #15 · "Sister is Asha" and "Asha is my sister" · keep as "…"
 *
 *   Check:
 *   - #8 · "Works at Acme" · today the owner mentioned a new job
 *
 * `readMemoryReview` turns that text into proposals the board and the
 * notification can show. They are proposals only: nothing here saves,
 * merges, changes or deletes a memory, and nothing else applies them. The
 * owner decides each one (by asking JARVIS to remember, change or forget,
 * which goes through the normal memory tools and the policy).
 *
 * `memoryReviewAlert` raises the end of a run as `info` through the
 * notification policy (notify-policy.mjs): kept for the next briefing, never
 * spoken or shown at once. A tidy-up is never worth interrupting anyone for.
 *
 * The proposals are a model's summary of memories and conversations that
 * may quote outside text; they are clipped and stripped of control
 * characters, and the alert is private to the owner. A Merge proposal needs
 * at least two memory ids and a Check proposal exactly one, or it is dropped:
 * a proposal the owner cannot act on is noise.
 */

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g

/** At most this many proposals are kept per list, and this many characters per proposal. */
export const MAX_PROPOSALS = 20
export const MAX_PROPOSAL = 240
/** At most this many memories in one merge. */
export const MAX_MERGE_IDS = 6
const MAX_SUMMARY = 120
const MAX_ALERT_BODY = 300
const MAX_ID = 2 ** 31 - 1

const REVIEW_LINE = /^[ \t]*(?:\*\*|__)?memory review(?::(?:\*\*|__)?|(?:\*\*|__):)[ \t]*(.*)$/i
/** A list heading: "Keep:", "## Merge", "**Check:**". */
const HEADING = /^[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*|__)?(keep|remember|merge|check|stale)[ \t]*:?(?:\*\*|__)?:?[ \t]*$/i
const ITEM = /^[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+(.+)$/
const LISTS = Object.freeze({ keep: 'keep', remember: 'keep', merge: 'merge', check: 'check', stale: 'check' })
/** The ids a proposal starts with: "#12 + #15 · …", "#8 · …". */
const LEADING_IDS = /^((?:#\d{1,10}[ \t]*(?:\+|,|&|and)?[ \t]*)+)(?:·|-|:|—)?[ \t]*/i

/**
 * Should this agent's result be read as a memory review? Yes when it reports
 * (output `report`) and may read memory; readMemoryReview still needs the
 * text in the review shape.
 *
 * @param {object | null} def a checked AgentDefinition
 */
export function isMemoryReviewAgent(def) {
  return isRecord(def) && def.output === 'report' && (def.memory === 'read' || def.memory === 'propose')
}

const tidy = (s) => clip(s.replace(CONTROL, ' ').replace(/\s+/g, ' ').replace(/(?:\*\*|__)/g, ''), MAX_PROPOSAL)

/** Splits the leading `#id` list off a proposal. */
function leadingIds(text) {
  const m = LEADING_IDS.exec(text)
  if (!m) return { ids: [], rest: text }
  const ids = []
  for (const [, n] of m[1].matchAll(/#(\d+)/g)) {
    const id = Number(n)
    if (Number.isSafeInteger(id) && id > 0 && id <= MAX_ID && !ids.includes(id)) ids.push(id)
  }
  return { ids, rest: text.slice(m[0].length).trim() }
}

/**
 * Read a memory review from an agent's result.
 *
 * @param {string} text
 * @returns {{
 *   summary: string,
 *   keep: string[],
 *   merge: { ids: number[], text: string }[],
 *   check: { id: number, text: string }[],
 * } | null} null when the text does not start with a `Memory review:` line
 */
export function readMemoryReview(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && (!lines[i].trim() || /^[ \t]*```[a-z]*[ \t]*$/i.test(lines[i]))) i++
  const head = REVIEW_LINE.exec(lines[i] ?? '')
  if (!head) return null
  const review = { summary: tidy(head[1]).slice(0, MAX_SUMMARY), keep: [], merge: [], check: [] }
  let list = null
  for (i += 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i])
    if (h) { list = LISTS[h[1].toLowerCase()]; continue }
    if (!list) continue
    const m = ITEM.exec(lines[i])
    if (!m) continue
    const item = tidy(m[1])
    if (!item || review[list].length >= MAX_PROPOSALS) continue
    if (list === 'keep') { review.keep.push(item); continue }
    const { ids, rest } = leadingIds(item)
    if (list === 'merge' && ids.length >= 2 && ids.length <= MAX_MERGE_IDS) review.merge.push({ ids, text: rest })
    if (list === 'check' && ids.length === 1) review.check.push({ id: ids[0], text: rest })
  }
  return review
}

/** How many proposals a review holds. */
export const proposalCount = (r) =>
  isRecord(r) ? (r.keep?.length ?? 0) + (r.merge?.length ?? 0) + (r.check?.length ?? 0) : 0

/**
 * How the end of a memory-review run is raised, or null to use the plain
 * "finished" alert (no review, or a failed run). Always `info`: kept for the
 * next briefing.
 *
 * @param {{ memoryReview?: ReturnType<typeof readMemoryReview> }} task the finished task (view)
 * @param {string} name the agent's name, already clipped
 * @returns {{ urgency: 'info', title: string, body: string } | null}
 */
export function memoryReviewAlert(task, name) {
  const r = isRecord(task) && isRecord(task.memoryReview) ? task.memoryReview : null
  if (!r || !Array.isArray(r.keep) || !Array.isArray(r.merge) || !Array.isArray(r.check)) return null
  const n = proposalCount(r)
  if (!n) return { urgency: 'info', title: `${name}: nothing to change`, body: 'Your saved memories look tidy.' }
  const lines = [
    ...r.keep.map((k) => `- Keep: ${k}`),
    ...r.merge.map((m) => `- Merge ${m.ids.map((id) => `#${id}`).join(' + ')}: ${m.text}`),
    ...r.check.map((c) => `- Check #${c.id}: ${c.text}`),
  ]
  return {
    urgency: 'info',
    title: `${name}: ${n} memory suggestion${n === 1 ? '' : 's'}`,
    body: lines.join('\n').slice(0, MAX_ALERT_BODY),
  }
}
