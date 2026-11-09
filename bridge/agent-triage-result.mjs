/**
 * Triage results handed back by alert agents shaped like the Inbox Triager.
 *
 * A triage is plain text in a fixed shape, set by the agent's instructions:
 *
 *   Triage: 1 urgent, 1 to answer, 2 can wait
 *
 *   Urgent:
 *   - Gmail · Priya Shah · Contract must be signed by 17:00 today · …
 *
 *   Answer soon:
 *   - …
 *
 *   Can wait:
 *   - …
 *
 *   Drafts:
 *   Draft: email
 *   To: …
 *   Subject: …
 *
 *   …
 *
 * `readTriage` turns that text into lists the board and the notification can
 * use; nothing here sends, saves or opens anything. `triageAlert` decides
 * how loudly the end of a run is raised through the notification policy
 * (notify-policy.mjs), which still has the last word:
 *
 *   - urgent items  → `important`: shown, and spoken when nobody is busy;
 *     held in quiet hours. Never `urgent`: the items come from mail and chat
 *     text that anyone can send, so a message must not be able to wake the
 *     owner at night by calling itself urgent.
 *   - nothing urgent → `info`: kept for the next briefing, not raised.
 *
 * The urgent items themselves are a model's summary of untrusted text; they
 * are clipped and stripped of control characters, and the alert is private
 * to the owner.
 */
import { readDraft } from './agent-draft-result.mjs'

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g

/** At most this many items are kept per list, and this many characters per item. */
export const MAX_TRIAGE_ITEMS = 20
export const MAX_ITEM = 240
const MAX_SUMMARY = 120
const MAX_DRAFTS = 5
const MAX_ALERT_BODY = 300

const TRIAGE_LINE = /^[ \t]*(?:\*\*|__)?triage(?::(?:\*\*|__)?|(?:\*\*|__):)[ \t]*(.*)$/i
/** A list heading: "Urgent:", "## Answer soon", "**Can wait:**". */
const HEADING = /^[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*|__)?(urgent|answer soon|reply soon|can wait|drafts?)[ \t]*:?(?:\*\*|__)?:?[ \t]*$/i
const ITEM = /^[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+(.+)$/
const LISTS = Object.freeze({ urgent: 'urgent', 'answer soon': 'soon', 'reply soon': 'soon', 'can wait': 'later', draft: 'drafts', drafts: 'drafts' })

/**
 * Should this agent's result be read as a triage? Yes when its output is
 * `alert` and the text is in the triage shape (readTriage is not null).
 *
 * @param {object | null} def a checked AgentDefinition
 */
export function isAlertAgent(def) {
  return isRecord(def) && def.output === 'alert'
}

const item = (s) => clip(s.replace(CONTROL, ' ').replace(/\s+/g, ' ').replace(/(?:\*\*|__)/g, ''), MAX_ITEM)

/** Split the text after a "Drafts:" heading at each "Draft:" line and read each one. */
function readDrafts(lines) {
  const drafts = []
  let current = null
  const flush = () => {
    if (!current) return
    const d = readDraft(current.join('\n'))
    if (d && drafts.length < MAX_DRAFTS) drafts.push(d)
    current = null
  }
  for (const line of lines) {
    if (/^[ \t]*(?:\*\*|__)?draft:/i.test(line)) { flush(); current = [line]; continue }
    if (current) current.push(line)
  }
  flush()
  return drafts
}

/**
 * Read a triage from an agent's result.
 *
 * @param {string} text
 * @returns {{ summary: string, urgent: string[], soon: string[], later: string[], drafts: object[] } | null}
 *   null when the text does not start with a `Triage:` line
 */
export function readTriage(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && (!lines[i].trim() || /^[ \t]*```[a-z]*[ \t]*$/i.test(lines[i]))) i++
  const head = TRIAGE_LINE.exec(lines[i] ?? '')
  if (!head) return null
  const triage = { summary: item(head[1]).slice(0, MAX_SUMMARY), urgent: [], soon: [], later: [], drafts: [] }
  let list = null
  const draftLines = []
  for (i += 1; i < lines.length; i++) {
    const line = lines[i]
    const h = HEADING.exec(line)
    if (h && !(list === 'drafts' && LISTS[h[1].toLowerCase()] === 'drafts')) {
      list = LISTS[h[1].toLowerCase()]
      continue
    }
    if (list === 'drafts') { draftLines.push(line); continue }
    if (!list) continue
    const m = ITEM.exec(line)
    if (!m) continue
    const text = item(m[1])
    if (text && triage[list].length < MAX_TRIAGE_ITEMS) triage[list].push(text)
  }
  triage.drafts = readDrafts(draftLines)
  return triage
}

/**
 * How the end of an alert agent's run is raised, or null to use the plain
 * "finished" alert (no triage, or a failed run).
 *
 * @param {{ triage?: ReturnType<typeof readTriage> }} task the finished task (view)
 * @param {string} name the agent's name, already clipped
 * @returns {{ urgency: 'important' | 'info', title: string, body: string } | null}
 */
export function triageAlert(task, name) {
  const t = isRecord(task) && isRecord(task.triage) ? task.triage : null
  if (!t || !Array.isArray(t.urgent)) return null
  const n = t.urgent.length
  if (n) {
    return {
      urgency: 'important',
      title: `${name}: ${n} urgent item${n === 1 ? '' : 's'}`,
      body: t.urgent.map((u) => `- ${u}`).join('\n').slice(0, MAX_ALERT_BODY),
    }
  }
  const soon = Array.isArray(t.soon) ? t.soon.length : 0
  const later = Array.isArray(t.later) ? t.later.length : 0
  return {
    urgency: 'info',
    title: `${name}: nothing urgent`,
    body: soon + later ? `${soon} to answer, ${later} can wait.` : 'Nothing new.',
  }
}
