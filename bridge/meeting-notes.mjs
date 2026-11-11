/**
 * Meeting Notes as an agent (roster #10): a triggered named agent that writes
 * up a meeting once it has ended: short minutes, the decisions taken and the
 * action items, as notes on the board and task drafts for the owner.
 *
 *   - When: the meeting source here watches the meeting notes the Granola
 *     connector (connectors/granola.mjs) has synced. A note that is new, from
 *     the last day and not yet written up is announced on the bus as
 *     `meeting.ended`, one per tick, and the Meeting Notes agent waits on that
 *     topic (agent-triggers.mjs). Nothing is fetched here: Granola is read
 *     only through the documents its connector already keeps.
 *   - What it reads: one read-only tool, `read_meeting`, with no arguments.
 *     It hands back the oldest meeting from the last day that has not been
 *     written up: its title, when, and what was recorded (the note's text),
 *     plus the calendar entry that matches it (Google Calendar documents, by
 *     time and title), so the model never picks which meeting or document to
 *     read.
 *   - What it writes: text, in a fixed shape (see the agent's file), read
 *     back into `task.meetingNotes` by `readMeetingNotes`. The action items
 *     are task drafts: nothing here creates a task, sends anything, saves to
 *     memory or writes a file. The owner decides what to do with each.
 *   - Once only: a meeting is remembered as written up (its document id and
 *     when) only once a run ends well with notes in the shape, for 30 days. A
 *     meeting that was announced but not written up (the agent was busy, off,
 *     or the run failed) is announced again later, at most a few times.
 *   - The alert: a normal, private alert for the owner that carries the
 *     parsed notes, through the notification policy (notify-policy.mjs). A
 *     run with no meeting to write up raises nothing.
 *
 * Everything the tool returns is untrusted: what people said in a meeting
 * reaches the model inside an <untrusted_data> envelope, clipped and stripped
 * of control characters, and counts as outside content for the taint guard.
 *
 * Like watcher.mjs this has no package imports, so it is tested alone;
 * server.mjs turns `serverSpec()` into the SDK server.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEETING_SERVER, MEETING_TOOL_NAMES } from './policy.mjs'
import { settingsDir } from './settings.mjs'
import { wrapUntrusted } from './untrusted.mjs'

export { MEETING_SERVER, MEETING_TOOL_NAMES }
export const MEETING_NOTES_ID = 'meeting-notes'
export const MEETING_TOOL = MEETING_TOOL_NAMES[0]
export const MEETING_TOOL_ID = `mcp__${MEETING_SERVER}__${MEETING_TOOL}`
export const MEETING_TOPIC = 'meeting.ended'

/** Connectors whose synced documents are meetings with something recorded. */
export const MEETING_SOURCES = Object.freeze(['granola'])
/** Connectors whose synced documents are calendar entries. */
export const CALENDAR_SOURCES = Object.freeze(['gcalendar'])
/** Only meetings from this window are announced or written up. */
export const LOOKBACK_MS = 24 * 60 * 60 * 1000
/** A calendar entry matches when the note falls inside it, give or take this. */
export const MATCH_SLACK_MS = 30 * 60 * 1000
/** A meeting announced but not written up is announced again after this, at most this often. */
export const REANNOUNCE_MS = 30 * 60 * 1000
export const MAX_ANNOUNCE = 3
/** How long a written-up meeting is remembered, and how many are. */
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_SEEN = 2000
/** How much of a meeting's recorded text the model is given. */
export const MAX_RECORDED = 20_000
/** Items kept per list of the notes, and characters per item. */
export const MAX_ITEMS = 20
export const MAX_ITEM = 240
/** Runs kept for tasks that have not ended yet. */
export const MAX_KEPT = 20
const MAX_DOCS = 100
const MAX_CALENDAR_DOCS = 500
const MAX_TITLE = 200
const MAX_BODY = 1500
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const oneLine = (s, n) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const fold = (s) => oneLine(s, 1000).toLowerCase()
const iso = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z')

/** The stored text of a document, out of its untrusted envelope. */
function bodyOf(doc) {
  const t = String(doc?.text ?? '')
  const m = /^<untrusted_data\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted_data>\s*$/.exec(t)
  return m ? m[1] : t
}

/** When a meeting note's meeting happened: its creation, else its last change. */
const noteTime = (doc) => (Number.isFinite(doc?.createdAt) ? doc.createdAt : doc?.updatedAt)

/** The bus id of a meeting: its connector and document id. */
export const meetingKey = (connectorId, docId) => `${connectorId}:${docId}`

export const meetingStateFile = (env = process.env) => join(settingsDir(env), 'agent-meeting-notes.json')

/**
 * Which meetings were announced (with how often) and which were written up.
 * Ids and times only, no titles. With no `file` it lives in memory, for
 * tests. Reading never throws; a failed write is logged and the bridge
 * carries on.
 */
export function createMeetingState({ file = null, now = () => Date.now(), log = console } = {}) {
  /** key → { at, n } */
  const announced = new Map()
  /** key → when written up */
  const written = new Map()
  const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 300
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(isObject(raw?.announced) ? raw.announced : {}).slice(0, MAX_SEEN)) {
        if (okKey(k) && isObject(v) && Number.isFinite(v.at) && Number.isInteger(v.n) && v.n > 0) announced.set(k, { at: v.at, n: v.n })
      }
      for (const [k, t] of Object.entries(isObject(raw?.written) ? raw.written : {}).slice(0, MAX_SEEN)) {
        if (okKey(k) && Number.isFinite(t)) written.set(k, t)
      }
    } catch {
      log.warn?.('[jarvis] meeting notes state unreadable; starting fresh')
    }
  }
  const prune = () => {
    const cutoff = now() - SEEN_TTL_MS
    for (const [k, t] of written) if (t < cutoff) written.delete(k)
    for (const [k, v] of announced) if (v.at < cutoff) announced.delete(k)
    while (written.size > MAX_SEEN) written.delete(written.keys().next().value)
    while (announced.size > MAX_SEEN) announced.delete(announced.keys().next().value)
  }
  const save = () => {
    if (!file) return
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ v: 1, announced: Object.fromEntries(announced), written: Object.fromEntries(written) })}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      log.error?.('[jarvis] meeting notes state write failed:', err?.message ?? err)
    }
  }
  const isWritten = (key) => {
    const t = written.get(key)
    return t !== undefined && t >= now() - SEEN_TTL_MS
  }
  return {
    isWritten,
    /** Should this meeting be announced now? Not written up, and not announced lately or too often. */
    mayAnnounce(key) {
      if (isWritten(key)) return false
      const a = announced.get(key)
      return !a || (a.n < MAX_ANNOUNCE && now() - a.at >= REANNOUNCE_MS)
    },
    announce(key) {
      const a = announced.get(key)
      announced.delete(key)
      announced.set(key, { at: now(), n: (a?.n ?? 0) + 1 })
      prune()
      save()
    },
    /** Remember a meeting as written up. */
    commit(key) {
      if (!okKey(key)) return
      written.delete(key)
      written.set(key, now())
      prune()
      save()
    },
    timesAnnounced: (key) => announced.get(key)?.n ?? 0,
    size: () => written.size,
  }
}

/**
 * Meeting notes synced in the last day, oldest first, as
 * `{ key, connectorId, doc, at }`. Never throws: a connector that cannot be
 * read gives nothing.
 */
export function recentMeetings(store, { now, log = console } = {}) {
  if (!store) return []
  const out = []
  for (const connectorId of MEETING_SOURCES) {
    let docs
    try {
      docs = store.recent(connectorId, { since: now - LOOKBACK_MS, limit: MAX_DOCS })
    } catch (err) {
      log.warn?.(`[jarvis] meeting notes could not read ${connectorId}:`, err?.message ?? err)
      continue
    }
    for (const doc of Array.isArray(docs) ? docs : []) {
      if (!isObject(doc) || typeof doc.id !== 'string' || !doc.id) continue
      const meta = isObject(doc.meta) ? doc.meta : {}
      if (meta.kind !== undefined && meta.kind !== 'meeting-note') continue
      const at = noteTime(doc)
      if (!Number.isFinite(at) || at < now - LOOKBACK_MS || at > now + MATCH_SLACK_MS) continue
      out.push({ key: meetingKey(connectorId, doc.id), connectorId, doc, at })
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
}

/** A calendar document's timed start and end, or null (all-day, series rule, cancelled, declined). */
function entryTimes(doc) {
  const m = isObject(doc?.meta) ? doc.meta : null
  if (!m || m.status === 'cancelled' || m.myResponse === 'declined' || m.allDay === true) return null
  const start = typeof m.start === 'string' && m.start.includes('T') ? Date.parse(m.start) : NaN
  const end = typeof m.end === 'string' && m.end.includes('T') ? Date.parse(m.end) : NaN
  if (!Number.isFinite(start)) return null
  return { start, end: Number.isFinite(end) && end > start ? end : start + 60 * 60 * 1000 }
}

const words = (s) => new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))

/**
 * The calendar entry a meeting note belongs to, or null: the timed entry the
 * note falls inside (give or take MATCH_SLACK_MS), preferring one whose title
 * shares words with the note's, then the closest start.
 */
export function calendarEntryFor(meeting, calendarDocs) {
  if (!isObject(meeting) || !Number.isFinite(meeting.at)) return null
  const title = words(meeting.doc?.title)
  let best = null
  for (const doc of Array.isArray(calendarDocs) ? calendarDocs : []) {
    const t = entryTimes(doc)
    if (!t || meeting.at < t.start - MATCH_SLACK_MS || meeting.at > t.end + MATCH_SLACK_MS) continue
    const shared = [...words(doc.title)].filter((w) => title.has(w)).length
    const distance = Math.abs(meeting.at - t.start)
    if (!best || shared > best.shared || (shared === best.shared && distance < best.distance)) best = { doc, ...t, shared, distance }
  }
  return best ? { doc: best.doc, start: best.start, end: best.end } : null
}

/** Calendar documents to match against, or [] when no calendar is synced. */
function calendarDocs(store, log) {
  if (!store) return []
  const out = []
  for (const id of CALENDAR_SOURCES) {
    try {
      const docs = store.recent(id, { limit: MAX_CALENDAR_DOCS })
      if (Array.isArray(docs)) out.push(...docs)
    } catch (err) {
      log.warn?.(`[jarvis] meeting notes could not read ${id}:`, err?.message ?? err)
    }
  }
  return out
}

/**
 * The meeting source: on each tick, announces the oldest meeting note from
 * the last day that is not written up and not announced lately, as
 * `meeting.ended` on the bus. One per tick, so one meeting at a time reaches
 * the agent. It reads documents already synced; it fetches nothing.
 *
 * @param {object} o
 * @param {{ recent: Function } | null} o.store the connector document store
 * @param {{ publish: Function } | null} o.bus the event bus
 * @param {ReturnType<typeof createMeetingState>} o.state
 * @param {() => boolean} [o.wanted] whether anything listens (the agent is switched on); nothing is announced otherwise
 */
export function createMeetingSource({ store = null, bus = null, state, wanted = () => true, now = () => Date.now(), log = console } = {}) {
  if (!state) throw new TypeError('The meeting source needs its state.')
  return {
    tick() {
      if (!bus || !store) return { published: null }
      let on = false
      try { on = wanted() === true } catch { on = false }
      if (!on) return { published: null }
      const at = now()
      const next = recentMeetings(store, { now: at, log }).find((m) => state.mayAnnounce(m.key))
      if (!next) return { published: null }
      const entry = calendarEntryFor(next, calendarDocs(store, log))
      const r = bus.publish(MEETING_TOPIC, {
        meetingId: next.key,
        source: next.connectorId,
        title: oneLine(next.doc.title, MAX_TITLE) || 'Untitled meeting',
        endedAt: Math.max(0, Math.round(entry && entry.end <= at ? entry.end : next.at)),
      })
      if (!r?.ok) return { published: null, error: r?.error ?? 'not published' }
      state.announce(next.key)
      return { published: next.key }
    },
  }
}

// --- the notes the agent hands back ----------------------------------------------------------

const NOTES_LINE = /^[ \t]*(?:\*\*|__)?meeting notes(?::(?:\*\*|__)?|(?:\*\*|__):)[ \t]*(.*)$/i
const HEADING = /^[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*|__)?(minutes|summary|decisions|decided|action items|actions|to do|to-dos)[ \t]*:?(?:\*\*|__)?:?[ \t]*$/i
const ITEM = /^[ \t]*(?:[-*•]|\d{1,2}[.)]|\[[ x]\])[ \t]+(.+)$/i
const LISTS = Object.freeze({
  minutes: 'minutes', summary: 'minutes', decisions: 'decisions', decided: 'decisions',
  'action items': 'actions', actions: 'actions', 'to do': 'actions', 'to-dos': 'actions',
})
const tidy = (s) => oneLine(String(s).replace(/(?:\*\*|__)/g, ''), MAX_ITEM)

/** One action item: "who · what · due when", "who · what" or "what". */
function actionOf(text) {
  const parts = text.split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 3) {
    const due = parts.slice(2).join(' · ').replace(/^due[:\s]+/i, '').trim()
    return { text: parts[1], owner: parts[0], ...(due && { due }) }
  }
  if (parts.length === 2) return { text: parts[1], owner: parts[0] }
  return { text }
}

/**
 * Read meeting notes from an agent's result.
 *
 * @param {string} text
 * @returns {{
 *   title: string,
 *   minutes: string[],
 *   decisions: string[],
 *   actions: { text: string, owner?: string, due?: string }[],
 * } | null} null when the text does not start with a `Meeting notes:` line
 */
export function readMeetingNotes(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && (!lines[i].trim() || /^[ \t]*```[a-z]*[ \t]*$/i.test(lines[i]))) i++
  const head = NOTES_LINE.exec(lines[i] ?? '')
  if (!head) return null
  const notes = { title: tidy(head[1]).slice(0, MAX_TITLE), minutes: [], decisions: [], actions: [] }
  let list = null
  for (i += 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i])
    if (h) { list = LISTS[h[1].toLowerCase()]; continue }
    if (!list) continue
    const m = ITEM.exec(lines[i])
    if (!m) continue
    const item = tidy(m[1])
    if (!item || /^none\b/i.test(item) || notes[list].length >= MAX_ITEMS) continue
    notes[list].push(list === 'actions' ? actionOf(item) : item)
  }
  return notes
}

/** Should this agent's result be read as meeting notes? A report agent that reads meetings. */
export const isMeetingNotesAgent = (def) =>
  isObject(def) && def.output === 'report' && Array.isArray(def.tools) && def.tools.includes(MEETING_TOOL_ID)

/** A copy of meeting notes, so a view never shares its lists with the task. */
export const copyMeetingNotes = (n) => ({ ...n, minutes: [...n.minutes], decisions: [...n.decisions], actions: n.actions.map((a) => ({ ...a })) })

// --- the tool and the alert --------------------------------------------------------------------

/**
 * The Meeting Notes agent's tool and what each run read.
 *
 * @param {object} o
 * @param {{ recent: Function } | null} o.store the connector document store (connectors/store.mjs)
 * @param {ReturnType<typeof createMeetingState>} [o.state]
 * @param {() => number} [o.now]
 */
export function createMeetingReads({ store = null, state = createMeetingState(), now = () => Date.now(), log = console } = {}) {
  /** task id → the meeting its latest read handed out */
  const kept = new Map()
  const keep = (taskId, out) => {
    kept.delete(taskId)
    kept.set(taskId, out)
    while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value)
  }

  /** The meeting to write up now, with its calendar entry, or null. Changes nothing. */
  function next() {
    const at = now()
    const meeting = recentMeetings(store, { now: at, log }).find((m) => !state.isWritten(m.key))
    if (!meeting) return null
    return { ...meeting, entry: calendarEntryFor(meeting, calendarDocs(store, log)) }
  }

  /** The tool's answer for a task: the meeting, wrapped as untrusted data. */
  function call(taskId) {
    let m
    try {
      m = next()
    } catch (err) {
      log.error?.('[jarvis] meeting read failed:', err?.message ?? err)
      return { isError: true, content: [{ type: 'text', text: 'Meeting: the meeting could not be read.' }] }
    }
    if (!m) {
      if (typeof taskId === 'string' && taskId) keep(taskId, { key: null })
      return { content: [{ type: 'text', text: wrapUntrusted('Meeting: nothing to write up', `${MEETING_SERVER}:${MEETING_TOOL}`) }] }
    }
    const title = oneLine(m.doc.title, MAX_TITLE) || 'Untitled meeting'
    if (typeof taskId === 'string' && taskId) keep(taskId, { key: m.key, title })
    let recorded = bodyOf(m.doc).replace(CONTROL, ' ')
    const cut = recorded.length > MAX_RECORDED
    if (cut) recorded = recorded.slice(0, MAX_RECORDED)
    const e = m.entry
    const entryMeta = e && isObject(e.doc.meta) ? e.doc.meta : {}
    const calendar = e
      ? `Calendar: ${oneLine(e.doc.title, MAX_TITLE) || 'untitled entry'} · ${iso(e.start)} to ${iso(e.end)}${Number.isInteger(entryMeta.attendees) ? ` · ${entryMeta.attendees} invited` : ''}`
      : 'Calendar: no matching calendar entry'
    const text = [
      `Meeting: ${title}`,
      `When: ${iso(m.at)}`,
      calendar,
      '',
      'What was recorded:',
      recorded.trim() || '(nothing)',
      ...(cut ? ['(the rest was cut)'] : []),
    ].join('\n')
    return { content: [{ type: 'text', text: wrapUntrusted(text, `${MEETING_SERVER}:${MEETING_TOOL}`) }] }
  }

  return {
    next,
    call,
    /** What one task's server is made of (server.mjs builds the SDK server from it). */
    serverSpec(taskId = null) {
      return {
        name: MEETING_SERVER,
        instructions: 'read_meeting returns the meeting to write up, with its calendar entry. It only reads; it sends nothing.',
        tools: [{
          name: MEETING_TOOL,
          description: 'Returns the latest meeting that has ended and not been written up: its title, time, calendar entry and what was recorded. Read-only; takes no arguments. Call it once.',
          handler: async () => call(taskId),
        }],
      }
    },
    /** What a task's latest read handed out, if anything. */
    get(taskId) {
      return kept.get(taskId) ?? null
    },
    /**
     * The alert for a Meeting Notes run that ended:
     *   - undefined: not this agent's run, or it did not end well, or it
     *     never read a meeting, or its result was not in the notes shape;
     *     the caller uses the usual alert;
     *   - null: there was no meeting to write up; nothing is raised;
     *   - the alert, with the decisions and action items.
     * A run that wrote notes has its meeting remembered as written up.
     */
    notification(task, at) {
      if (!isObject(task) || typeof task.id !== 'string') return undefined
      if (task.status === 'queued' || task.status === 'running') return undefined
      const out = kept.get(task.id) ?? null
      kept.delete(task.id)
      if (task.agentId !== MEETING_NOTES_ID || task.status !== 'done' || !out) return undefined
      if (!out.key) return null
      const notes = isObject(task.meetingNotes) ? task.meetingNotes : readMeetingNotes(task.result)
      if (!notes || !Array.isArray(notes.decisions) || !Array.isArray(notes.actions)) return undefined
      try { state.commit(out.key) } catch (err) { log.error?.('[jarvis] meeting notes state could not be kept:', err?.message ?? err) }
      const d = notes.decisions.length
      const a = notes.actions.length
      const lines = [
        `${d} decision${d === 1 ? '' : 's'}, ${a} action item${a === 1 ? '' : 's'}`,
        ...notes.decisions.map((x) => `- Decided: ${x}`),
        ...notes.actions.map((x) => `- To do: ${x.owner ? `${x.owner}: ` : ''}${x.text}${x.due ? ` (due ${x.due})` : ''}`),
      ]
      return {
        v: 1,
        id: `agent-run-${task.id}`,
        ts: at,
        source: 'agent',
        urgency: 'normal',
        audience: ['owner'],
        privacy: 'private',
        title: `Meeting notes: ${out.title}`.slice(0, 120),
        body: lines.join('\n').slice(0, MAX_BODY),
      }
    },
  }
}
