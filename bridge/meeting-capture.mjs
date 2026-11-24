/**
 * Meeting capture and minutes (Q97): while a meeting is being captured, the
 * speech-to-text lines (already labelled with who spoke, from speaker ID) are
 * collected as text, and when the meeting ends they become minutes: a short
 * summary, the decisions, and action items that wait for the owner's approval.
 *
 *   mc.notice()                      → the notice that must be shown first
 *   mc.start({ noticeId, noticeShown, consentConfirmed, title, participants })
 *   mc.addSegment(id, { speaker, text })
 *   mc.end(id)                       → the minutes (saved on this computer)
 *   mc.decide(minutesId, actionId, 'approve' | 'dismiss')
 *   mc.list() / mc.get(id) / mc.remove(id)
 *
 * Rules this module keeps:
 *   - Off until the owner switches it on (`enabled`).
 *   - Capture cannot start unless the caller says the current notice was shown
 *     (its id and `noticeShown: true`) AND that the owner confirmed everyone on
 *     the call knows or agreed (`consentConfirmed: true`). The notice is written
 *     for the strictest case (all-party consent); which law applies is the
 *     owner's to check, the notice says so.
 *   - Only text arrives here. Raw audio never reaches this module and is never
 *     stored by it. The transcript lives in memory while the meeting runs and
 *     is dropped when it ends or is abandoned; only the minutes are kept.
 *   - Secrets are removed (the patterns in memory.mjs) from every line before
 *     it is held, so neither the transcript nor the minutes can contain them.
 *   - Minutes are kept for `keepDays` days, then deleted, and can be deleted at
 *     any time. The file is private to the user (mode 0600).
 *   - Action items are `pending` until approved or dismissed. Approving only
 *     marks the item: nothing here creates a task, sends a message or writes
 *     to a calendar. That is for the policy engine and a later step.
 *   - A line from the call is data, never an instruction: this module only
 *     matches words in it, and nothing in it is run or sent to a model.
 *
 * Like knowledge-base.mjs, this has no package imports beyond the repo's own.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithRetry } from './atomic-rename.mjs'
import { redact } from './memory.mjs'
import { settingsDir } from './settings.mjs'

export const MEETING_SETTINGS = Object.freeze({ enabled: 'JARVIS_MEETINGS', keepDays: 'JARVIS_MEETINGS_KEEP_DAYS' })
export const MEETING_SETTING_IDS = Object.freeze(Object.values(MEETING_SETTINGS))

export const NOTICE_ID = 'meeting-notice-1'
export const NOTICE_TEXT =
  'JARVIS is about to listen to this meeting and turn what is said into a written transcript, ' +
  'then into minutes. The sound itself is not kept. Some places require everyone on the call ' +
  'to agree to being recorded or transcribed. Tell the others now, and only start when they ' +
  'know. You are responsible for checking the rules that apply to you.'

export const MAX_SEGMENTS = 5000
export const MAX_SEGMENT_CHARS = 2000
export const MAX_TRANSCRIPT_CHARS = 400_000
export const MAX_ACTIVE_MS = 8 * 60 * 60 * 1000
export const MAX_MINUTES = 200
export const DEFAULT_KEEP_DAYS = 30
export const MAX_ITEMS = 20
export const MAX_ITEM = 240
const MAX_PARTICIPANTS = 30
const MAX_NAME = 60
const MAX_TITLE = 120
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const oneLine = (s, n) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

export function defaultMeetingsDir(env = process.env) {
  if (env.JARVIS_MEETINGS_DIR) return env.JARVIS_MEETINGS_DIR
  return join(settingsDir(env), 'meetings')
}

/** Days to keep minutes: 1 to 365; anything else is the default. */
export function parseKeepDays(value) {
  const n = Number(String(value ?? '').trim())
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_KEEP_DAYS
}

// --- reading the transcript ----------------------------------------------------------------------

const STOP = new Set(('the a an and or but of to in on at for with is are was were be been it this that these those i you we they he she ' +
  'so then just yeah okay ok well um uh like have has had do does did not no yes will would can could should about from as by if ' +
  'there here what when which who our your their my me us them its').split(' '))
const DECISION = /\b(?:we(?:'ve| have)? (?:decided|agreed)|(?:it(?:'s| is)|that(?:'s| is)) (?:decided|agreed|settled)|decision(?: is)?\s*[:\-]|decided to|agreed to|let(?:'s| us) go with|we(?:'ll| will) go with|going with)\b/i
const ACTION_MARK = /\b(?:action(?: item)?|to-?do|follow[- ]up)\s*[:\-]\s*/i
const FIRST_PERSON = /^(?:i(?:'ll| will| am going to|'m going to| can take)|let me)\s+(.+)$/i
const THIRD_PERSON = /^([A-Z][\p{L}'-]{1,30})\s+(?:will|to|is going to|can you|could you)\s+(.+)$/u
const ASK = /^(?:please|can you|could you|we need to|someone (?:should|needs to|has to))\s+(.+)$/i
const DUE = /\b(?:by|before|due|on)\s+((?:next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|end of (?:day|week|month)|eod|eow|next week|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?))\b/i

/** Split speech into sentences, keeping the speaker. */
function sentencesOf(segments) {
  const out = []
  for (const seg of segments) {
    const parts = seg.text.match(/[^.!?\n]+[.!?]*/g) ?? []
    for (const p of parts) {
      const text = oneLine(p, MAX_ITEM * 2)
      if (text.length >= 8) out.push({ speaker: seg.speaker, text })
    }
  }
  return out
}

const clean = (s) => oneLine(s.replace(/[.!?]+$/, ''), MAX_ITEM)

/** One sentence as an action item, or null. */
function actionFrom(sentence) {
  const { speaker, text } = sentence
  let body = text
  const mark = ACTION_MARK.exec(body)
  let marked = false
  if (mark) { body = body.slice(mark.index + mark[0].length); marked = true }
  body = body.replace(/^(?:ok(?:ay)?|so|right|and|then|yeah)[, ]+/i, '').trim()
  let owner = null
  let what = null
  let m
  if ((m = FIRST_PERSON.exec(body))) { owner = speaker; what = m[1] }
  else if ((m = THIRD_PERSON.exec(body))) { owner = m[1]; what = m[2] }
  else if ((m = ASK.exec(body))) { what = m[1] }
  else if (marked) { what = body }
  if (!what) return null
  // Plain statements of intent about the past or the mood of the call are not tasks.
  if (/^(?:think|guess|suppose|mean|wonder|see|be honest|say|know)\b/i.test(what)) return null
  const due = DUE.exec(what)?.[1]?.trim()
  const item = { text: clean(what), ...(owner && { owner: oneLine(owner, MAX_NAME) }), ...(due && { due: oneLine(due, 40) }) }
  return item.text.length >= 4 ? item : null
}

/**
 * Minutes from a labelled transcript, by words alone (no model, nothing sent
 * anywhere). A model-written summary can replace the `summary` later.
 *
 * @param {{ speaker: string, text: string }[]} segments
 * @returns {{ summary: string[], decisions: string[], actions: { text: string, owner?: string, due?: string }[], speakers: string[] }}
 */
export function minutesFrom(segments) {
  const list = Array.isArray(segments) ? segments : []
  const sentences = sentencesOf(list)
  const speakers = [...new Set(list.map((s) => s.speaker))].slice(0, MAX_PARTICIPANTS)

  const decisions = []
  const actions = []
  const used = new Set()
  sentences.forEach((s, i) => {
    if (DECISION.test(s.text) && decisions.length < MAX_ITEMS) { decisions.push(clean(s.text)); used.add(i); return }
    const a = actionFrom(s)
    if (a && actions.length < MAX_ITEMS && !actions.some((x) => x.text.toLowerCase() === a.text.toLowerCase())) { actions.push(a); used.add(i) }
  })

  // Summary: the sentences that carry the meeting's most repeated words, in the order they were said.
  const freq = new Map()
  const toks = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w))
  for (const s of sentences) for (const w of new Set(toks(s.text))) freq.set(w, (freq.get(w) ?? 0) + 1)
  const scored = sentences
    .map((s, i) => {
      const ws = toks(s.text)
      const score = ws.reduce((n, w) => n + ((freq.get(w) ?? 1) - 1), 0) / Math.sqrt(ws.length || 1)
      return { i, score, text: s.text }
    })
    .filter((s) => !used.has(s.i) && s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 5)
    .sort((a, b) => a.i - b.i)
  return { summary: scored.map((s) => clean(s.text)), decisions, actions, speakers }
}

// --- the capture ---------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string | null} [o.dir] where minutes are kept; null keeps them in memory (tests)
 * @param {() => boolean} [o.enabled]
 * @param {() => number} [o.keepDays]
 * @param {() => number} [o.now]
 */
export function createMeetingCapture({ dir = null, enabled = () => false, keepDays = () => DEFAULT_KEEP_DAYS, now = () => Date.now(), log = console } = {}) {
  const file = dir ? join(dir, 'minutes.json') : null
  /** @type {Map<string, object>} */
  let minutes = new Map()
  /** The one meeting being captured, or null. The transcript is only here, in memory. */
  let active = null

  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const m of Array.isArray(raw?.minutes) ? raw.minutes : []) {
        if (isObject(m) && typeof m.id === 'string' && Array.isArray(m.actions)) minutes.set(m.id, m)
      }
    } catch {
      log.warn?.('[jarvis] meeting minutes unreadable; starting fresh')
    }
  }
  const save = () => {
    if (!file) return
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ v: 1, minutes: [...minutes.values()] })}\n`, { mode: 0o600 })
      renameWithRetry(tmp, file)
    } catch (err) {
      log.error?.('[jarvis] meeting minutes write failed:', err?.message ?? err)
    }
  }
  const prune = () => {
    const cutoff = now() - keepDays() * 24 * 60 * 60 * 1000
    let changed = false
    for (const [id, m] of minutes) if (!(m.endedAt >= cutoff)) { minutes.delete(id); changed = true }
    while (minutes.size > MAX_MINUTES) { minutes.delete(minutes.keys().next().value); changed = true }
    if (changed) save()
  }
  const expireActive = () => {
    if (active && now() - active.startedAt > MAX_ACTIVE_MS) active = null
  }
  const off = () => ({ ok: false, reason: 'Meeting capture is switched off.' })

  return {
    notice: () => ({ id: NOTICE_ID, text: NOTICE_TEXT }),

    status() {
      expireActive()
      prune()
      return { enabled: enabled() === true, capturing: active ? { id: active.id, title: active.title, startedAt: active.startedAt, lines: active.segments.length } : null, saved: minutes.size, keepDays: keepDays() }
    },

    /** Start capturing. Needs the notice shown and the owner's confirmation. */
    start({ noticeId, noticeShown, consentConfirmed, title, participants } = {}) {
      if (enabled() !== true) return off()
      expireActive()
      if (active) return { ok: false, reason: 'A meeting is already being captured. End it first.' }
      if (noticeId !== NOTICE_ID || noticeShown !== true) return { ok: false, reason: 'The recording notice has to be shown first.', needs: 'notice' }
      if (consentConfirmed !== true) return { ok: false, reason: 'Confirm that everyone on the call knows and agrees before capture starts.', needs: 'consent' }
      const names = (Array.isArray(participants) ? participants : []).map((p) => oneLine(p, MAX_NAME)).filter(Boolean).slice(0, MAX_PARTICIPANTS)
      active = {
        id: randomUUID(),
        title: oneLine(title, MAX_TITLE) || 'Meeting',
        participants: names,
        startedAt: now(),
        segments: [],
        chars: 0,
      }
      return { ok: true, id: active.id }
    },

    /** Add one transcribed line. Text only; secrets are removed before it is held. */
    addSegment(id, { speaker, text } = {}) {
      expireActive()
      if (!active || active.id !== id) return { ok: false, reason: 'No such meeting is being captured.' }
      if (enabled() !== true) { active = null; return off() }
      if (typeof text !== 'string') return { ok: false, reason: 'Send the line as text.' }
      const line = redact(oneLine(text, MAX_SEGMENT_CHARS)).text
      if (!line) return { ok: true, kept: false }
      if (active.segments.length >= MAX_SEGMENTS || active.chars + line.length > MAX_TRANSCRIPT_CHARS) return { ok: false, reason: 'This meeting is too long to keep capturing. End it to get the minutes.' }
      active.segments.push({ speaker: oneLine(speaker, MAX_NAME) || 'Unknown', text: line })
      active.chars += line.length
      return { ok: true, kept: true, lines: active.segments.length }
    },

    /** End the meeting: make and save the minutes, and drop the transcript. */
    end(id) {
      expireActive()
      if (!active || active.id !== id) return { ok: false, reason: 'No such meeting is being captured.' }
      const m = active
      active = null
      const made = minutesFrom(m.segments)
      const endedAt = now()
      const out = {
        id: m.id,
        title: m.title,
        startedAt: m.startedAt,
        endedAt,
        participants: m.participants,
        speakers: made.speakers,
        lines: m.segments.length,
        summary: made.summary,
        decisions: made.decisions,
        actions: made.actions.map((a, i) => ({ id: `a${i + 1}`, state: 'pending', ...a })),
      }
      minutes.set(out.id, out)
      prune()
      save()
      return { ok: true, minutes: out }
    },

    /** Drop the meeting being captured without making minutes. */
    abandon() {
      const was = active !== null
      active = null
      return { ok: true, was }
    },

    /** Approve or dismiss one action item. Only marks it; nothing is created or sent. */
    decide(minutesId, actionId, decision) {
      const m = minutes.get(minutesId)
      const a = m?.actions.find((x) => x.id === actionId)
      if (!a) return { ok: false, reason: 'No such action item.' }
      if (decision !== 'approve' && decision !== 'dismiss') return { ok: false, reason: 'Choose approve or dismiss.' }
      if (a.state !== 'pending') return { ok: false, reason: `This item was already ${a.state}.` }
      a.state = decision === 'approve' ? 'approved' : 'dismissed'
      a.decidedAt = now()
      save()
      return { ok: true, action: { ...a } }
    },

    list() {
      prune()
      return [...minutes.values()].sort((a, b) => b.endedAt - a.endedAt).map((m) => ({
        id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt,
        decisions: m.decisions.length, actions: m.actions.length, pending: m.actions.filter((a) => a.state === 'pending').length,
      }))
    },
    get(id) {
      prune()
      const m = minutes.get(id)
      return m ? structuredClone(m) : null
    },
    remove(id) {
      const had = minutes.delete(id)
      if (had) save()
      return { ok: had }
    },
    /** Switching capture off: drop what is being captured and every saved minute. */
    forgetAll() {
      active = null
      const n = minutes.size
      minutes = new Map()
      save()
      return { ok: true, removed: n }
    },
  }
}
