/**
 * Drafts handed back by agents whose output is `draft` (the Writer, or an
 * owner's agent shaped like it).
 *
 * A draft is plain text in a fixed shape, set by the agent's instructions:
 *
 *   Draft: email
 *   To: Priya Shah <priya@example.com>
 *   Subject: Thank you for Saturday
 *
 *   Hi Priya, …
 *
 *   Notes for you:
 *   - what to check before sending
 *
 * `readDraft` turns that text into a draft the board can show and copy;
 * nothing here sends, saves or opens anything. `draftProblems` lists what is
 * wrong with the shape, in words the agent can fix. Like the citation checks
 * (agent-citations.mjs) these are plain text rules with no model call: the
 * reviewer pass (agent-review.mjs) is handed them as notes to weigh, and a
 * task without a reviewer simply keeps its text.
 */

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

/** The kinds of draft an agent may hand back. */
export const DRAFT_KINDS = Object.freeze(['email', 'message', 'document', 'summary'])

/** At most this many problems are reported, so a long draft cannot flood the reviewer. */
export const MAX_DRAFT_PROBLEMS = 6

/** Limits on what is kept from a draft. The text itself is the task's result, already bounded. */
const MAX_HEADER = 300
const MAX_BODY = 20_000
const MAX_NOTES = 2_000

/** The header fields a draft may carry, as they are written and as they are kept. */
const FIELDS = Object.freeze({ to: 'to', cc: 'cc', subject: 'subject', title: 'title' })
/** The fields each kind needs. */
const REQUIRED = Object.freeze({
  email: ['to', 'subject'],
  message: ['to'],
  document: ['title'],
  summary: ['title'],
})
const FIELD_LABEL = Object.freeze({ to: 'To', cc: 'Cc', subject: 'Subject', title: 'Title' })

/** The first line: "Draft: email", "**Draft:** email", "Draft - email". */
const KIND_LINE = /^[ \t]*(?:\*\*|__)?draft(?:\*\*|__)?[ \t]*[:\-—][ \t]*(?:\*\*|__)?[ \t]*([a-z]+)[ \t]*(?:\*\*|__)?[ \t]*$/i
/** A header line: "To: …", "Subject: …". */
const HEADER_LINE = /^[ \t]*(?:\*\*|__)?(to|cc|subject|title)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.*)$/i
/** The notes heading: "Notes for you:", "## Notes for you". */
const NOTES_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*notes for you[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*(.*)$/i
/** A placeholder the owner would have to fill in: [Name], [Your name], {{date}}, <insert …>. */
const PLACEHOLDER = /\[(?:name|your name|recipient(?:'s)? name|first name|date|time|company|address|phone|amount|insert[^\]\n]{0,40}|todo|tbd|x+)\]|\{\{[^}\n]{1,40}\}\}|<insert[^>\n]{0,40}>/i
/** Words claiming something left the run. An agent with drafts only cannot do any of it. */
const CLAIMS_SENT = /\b(?:i(?:'ve| have)?|it(?:'s| has| was)?|this (?:has been|was)|has been|was)[ \t]+(?:already[ \t]+)?(?:sent|posted|published|forwarded|scheduled|emailed|replied)\b/i

/**
 * Should this agent's result be read as a draft? Yes when its output is `draft`.
 *
 * @param {object | null} def a checked AgentDefinition
 */
export function isDraftAgent(def) {
  return isRecord(def) && def.output === 'draft'
}

/**
 * Read a draft from an agent's result.
 *
 * @param {string} text
 * @returns {{ kind: string, to?: string, cc?: string, subject?: string, title?: string, body: string, notes?: string } | null}
 *   null when the text does not start with a `Draft:` line naming a known kind
 */
export function readDraft(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  // Leading blank lines and a code fence the model wrapped the draft in.
  while (i < lines.length && (!lines[i].trim() || /^[ \t]*```[a-z]*[ \t]*$/i.test(lines[i]))) i++
  const kindMatch = KIND_LINE.exec(lines[i] ?? '')
  const kind = kindMatch?.[1].toLowerCase()
  if (!kind || !DRAFT_KINDS.includes(kind)) return null
  i++
  const draft = { kind }
  for (; i < lines.length; i++) {
    const h = HEADER_LINE.exec(lines[i])
    if (!h) break
    const key = FIELDS[h[1].toLowerCase()]
    const value = clip(h[2].replace(/(?:\*\*|__)/g, ''), MAX_HEADER)
    if (value && !(key in draft)) draft[key] = value
  }
  let rest = lines.slice(i)
  // A closing code fence is not part of the text.
  while (rest.length && (!rest.at(-1).trim() || /^[ \t]*```[ \t]*$/.test(rest.at(-1)))) rest = rest.slice(0, -1)
  let notesAt = -1
  for (let j = rest.length - 1; j >= 0; j--) if (NOTES_HEADING.test(rest[j])) { notesAt = j; break }
  let notes = ''
  if (notesAt >= 0) {
    const first = NOTES_HEADING.exec(rest[notesAt])[1]
    notes = [first, ...rest.slice(notesAt + 1)].join('\n')
    rest = rest.slice(0, notesAt)
  }
  draft.body = clip(rest.join('\n'), MAX_BODY)
  if (clip(notes, MAX_NOTES)) draft.notes = clip(notes, MAX_NOTES)
  return draft
}

/**
 * What is wrong with a draft's shape, in words the agent can act on. An empty
 * list means none of the rules found anything.
 *
 * @param {string} text the agent's result
 * @returns {string[]}
 */
export function draftProblems(text) {
  const draft = readDraft(text)
  if (!draft) {
    return [`The draft does not start with a "Draft:" line naming its kind (${DRAFT_KINDS.join(', ')}).`]
  }
  const problems = []
  for (const key of REQUIRED[draft.kind]) {
    if (!draft[key]) problems.push(`A draft ${draft.kind} needs a "${FIELD_LABEL[key]}:" line.`)
  }
  if (!draft.body) problems.push('The draft has no text after its header lines.')
  const placeholder = PLACEHOLDER.exec(draft.body) ?? PLACEHOLDER.exec(draft.subject ?? '') ?? PLACEHOLDER.exec(draft.to ?? '')
  if (placeholder) {
    problems.push(`The draft still has a placeholder (${clip(placeholder[0], 40)}); write around it and say what is missing in the notes.`)
  }
  if (draft.notes && CLAIMS_SENT.test(draft.notes)) {
    problems.push('The notes say something was sent, posted or scheduled; this agent can only draft, so say it is a draft.')
  }
  return problems.slice(0, MAX_DRAFT_PROBLEMS)
}
