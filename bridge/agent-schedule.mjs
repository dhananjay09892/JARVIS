/**
 * Scheduled agents: named agents with `mode: scheduled` run on their
 * `schedule` (a 5-field cron string) as ordinary tasks.
 *
 * There is no second scheduler. This module only answers "is anything due
 * now?" on each tick of the workflow engine's ticker (workflows.mjs
 * `addJob`), and a due agent is handed to the task manager (tasks.mjs) like
 * any other named agent, so the concurrency cap, the budget, the reviewer,
 * the pause and the kill switch all apply unchanged: a run that would exceed
 * the cap waits in the task queue.
 *
 * The rules:
 *
 *   - An agent is only ever run when the registry says it is active (loaded,
 *     approved if an agent made it) AND the owner switched it on. Scheduled
 *     agents are off until switched on (agent-settings.mjs).
 *   - A scheduled agent without a budget never runs (its file is refused
 *     already; this is checked again here).
 *   - While an agent is off, or all agents are paused, or JARVIS is frozen,
 *     its due times are skipped, not saved up: switching it back on does not
 *     start a run for a time that passed while it was off.
 *   - Missed runs while JARVIS was not running (the PC was off) are made up
 *     once, not once per missed time, and only within `MAX_CATCH_UP_MS`.
 *   - A run never piles on a previous one: if the agent's last scheduled task
 *     is still queued or running, a due time is skipped.
 *   - The first time an agent is seen, nothing from before is made up.
 *
 * The last time handled per agent is kept in a small JSON file beside the
 * settings (ids and times only, nothing from a run), so missed runs can be
 * found after a restart. A missing or unreadable file means "nothing seen
 * yet", never a crash.
 *
 * When a scheduled run ends, the result goes out as a `Notification`
 * (shared/contracts.ts) through the notification policy (notify-policy.mjs),
 * which decides whether to say it, show it or hold it. A run the owner
 * cancelled raises nothing. An alert agent that hands back a triage (the
 * Inbox Triager) is raised as `important` when it found something urgent and
 * as `info` (kept for the briefing) when it did not (agent-triage-result.mjs).
 *
 * Nothing here grants anything: what the run may do is still its definition,
 * narrowed by agent-runtime.mjs and decided call by call by policy.mjs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsDir } from './settings.mjs'
import { isActive as taskActive } from './tasks.mjs'
import { triageAlert } from './agent-triage-result.mjs'

const MINUTE = 60_000
/** Missed runs older than this are not made up. */
export const MAX_CATCH_UP_MS = 7 * 24 * 60 * MINUTE
const MAX_STATE = 500
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
]

function value(raw, f) {
  if (/^\d{1,2}$/.test(raw)) return Number(raw)
  const i = f.names?.indexOf(raw.toUpperCase()) ?? -1
  return i >= 0 ? i + f.base : NaN
}

/** One cron field → a Set of allowed values, or null when it does not parse. */
function field(text, f) {
  const out = new Set()
  for (const part of text.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(part)
    if (!m) return null
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!(step >= 1)) return null
    let lo
    let hi
    if (m[1] === '*') {
      lo = f.min
      hi = f.max === 7 ? 6 : f.max
    } else {
      const [a, b] = m[1].split('-')
      lo = value(a, f)
      hi = b === undefined ? (m[2] === undefined ? lo : f.max) : value(b, f)
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < f.min || hi > f.max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/**
 * A 5-field cron string ("minute hour day-of-month month day-of-week", local
 * time) → a matcher, or null when it is not understood. Supports `*`,
 * numbers, ranges, steps, lists, and month and day names; Sunday is 0 or 7.
 * As in cron, when both day fields are restricted a day matches either.
 * Anything else (@daily, L, W, #, ?) is not understood, and an agent with a
 * schedule that is not understood never runs.
 */
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.length > 120) return null
  const parts = expr.trim().split(/[ \t]+/)
  if (parts.length !== 5) return null
  const sets = parts.map((p, i) => field(p, FIELDS[i]))
  if (sets.some((s) => s === null)) return null
  const [min, hour, dom, month, dow] = sets
  if (dow.has(7)) dow.add(0)
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  return {
    /** Does this local minute match? */
    matches(ms) {
      const d = new Date(ms)
      if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !month.has(d.getMonth() + 1)) return false
      const a = dom.has(d.getDate())
      const b = dow.has(d.getDay())
      if (domAny && dowAny) return true
      if (domAny) return b
      if (dowAny) return a
      return a || b
    },
  }
}

const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE

/**
 * The latest minute in (after, now] that the schedule matches, or null.
 * Looks back at most `MAX_CATCH_UP_MS`.
 */
export function latestDue(cron, after, now) {
  const end = floorMinute(now)
  const start = Math.max(Number.isFinite(after) ? after : -Infinity, end - MAX_CATCH_UP_MS)
  for (let t = end; t > start; t -= MINUTE) if (cron.matches(t)) return t
  return null
}

// ---------------------------------------------------------------------------
// State: the last due time handled per agent
// ---------------------------------------------------------------------------

export const scheduleStateFile = (env = process.env) => join(settingsDir(env), 'agent-schedule.json')

/**
 * The last time handled per agent, in a JSON file (ids and times only). With
 * no `file` it lives in memory, for tests. Reading never throws; a failed
 * write is logged and the bridge carries on.
 */
export function createScheduleState({ file = null, log = console } = {}) {
  const last = new Map()
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const entries = raw && typeof raw === 'object' && raw.last && typeof raw.last === 'object' ? Object.entries(raw.last) : []
      for (const [id, t] of entries.slice(0, MAX_STATE)) if (AGENT_ID.test(id) && Number.isFinite(t) && t >= 0) last.set(id, t)
    } catch {
      log.warn?.('[jarvis] agent schedule state unreadable; starting fresh')
    }
  }
  const save = () => {
    if (!file) return
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ v: 1, last: Object.fromEntries(last) }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      log.error?.('[jarvis] agent schedule state write failed:', err?.message ?? err)
    }
  }
  return {
    get: (id) => last.get(id),
    /** Set several at once and write once. */
    setMany(pairs) {
      let changed = false
      for (const [id, t] of pairs) {
        if (!AGENT_ID.test(id) || !Number.isFinite(t) || last.get(id) === t) continue
        last.set(id, t)
        changed = true
      }
      if (changed) save()
    },
    entries: () => Object.fromEntries(last),
  }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/** What a skipped or refused due time is logged as. Short, no content. */
export const SCHEDULE_SKIPS = Object.freeze({
  badSchedule: 'its schedule is not understood',
  noBudget: 'it has no budget',
  stillRunning: 'its last scheduled run has not finished',
})

/** The goal a scheduled run is given; the definition's body holds the instructions. */
export const scheduledGoal = (agent, at) =>
  `Scheduled run of ${agent.name} for ${new Date(at).toISOString()}. Do your usual job as your instructions describe, then report the result.`

/** The alert for a scheduled run that ended. null when nothing should be raised. */
export function runNotification(task, at) {
  if (!task || (task.status !== 'done' && task.status !== 'failed' && task.status !== 'interrupted')) return null
  const name = clip(task.agentName, 60) || 'An agent'
  const ok = task.status === 'done'
  // An alert agent's triage decides how loudly it is raised (agent-triage-result.mjs).
  const triage = ok ? triageAlert(task, name) : null
  return {
    v: 1,
    id: `agent-run-${task.id}`,
    ts: at,
    source: 'agent',
    urgency: 'normal',
    audience: ['owner'],
    privacy: 'private',
    title: ok ? `${name} finished its scheduled run` : `${name} could not finish its scheduled run`,
    body: clip(ok ? task.result : task.error, 300),
    ...triage,
  }
}

/**
 * @param {object} o
 * @param {{ list: Function, get: Function, isActive: Function }} o.agents the switched registry (agent-settings.mjs switchedRegistry)
 * @param {{ spawn: Function, get: Function, subscribe: Function }} o.tasks the task manager
 * @param {() => string | null} [o.paused] why agents are paused now, or null
 * @param {{ submit: Function } | null} [o.notifier] the notification policy engine
 * @param {ReturnType<typeof createScheduleState>} [o.state]
 * @param {() => number} [o.clock]
 * @param {(agent: object) => string | null} [o.scheduleOf] the schedule an
 *   agent runs on: its file's, unless the bridge takes it from a setting (the
 *   Morning Briefing follows the briefing time). null means "no time set":
 *   it does not run, and nothing is made up once a time is set.
 * @param {(task: object, at: number) => object | null} [o.notificationFor]
 *   the alert for a run that ended (runNotification unless an agent has its own)
 */
export function createAgentScheduler({
  agents, tasks, paused = () => null, notifier = null, state = createScheduleState(),
  clock = () => Date.now(), log = console, scheduleOf = (agent) => agent.schedule, notificationFor = runNotification,
} = {}) {
  if (!agents || !tasks) throw new TypeError('The agent scheduler needs the agent registry and the task manager.')
  /** agent id → task id of its latest scheduled run */
  const running = new Map()
  /** task id → true, for scheduled runs whose end has not been reported */
  const watching = new Set()
  /** agent id → schedule string already reported as not understood */
  const reported = new Map()
  const cronCache = new Map()
  /** agent ids seen with no time set, so setting one does not make up runs from before */
  const unscheduled = new Set()

  const cronOf = (expr) => {
    if (!cronCache.has(expr)) cronCache.set(expr, parseCron(expr))
    return cronCache.get(expr)
  }

  const pauseReason = () => {
    try {
      const r = paused()
      return typeof r === 'string' && r ? r : null
    } catch {
      return 'paused'
    }
  }
  const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }

  // The end of a scheduled run goes to the notification policy.
  const unsubscribe = tasks.subscribe((frame) => {
    const t = frame?.type === 'task' ? frame.task : null
    if (!t || !watching.has(t.id) || taskActive(t)) return
    watching.delete(t.id)
    let n = null
    try { n = notificationFor(t, clock()) } catch (err) { log.error?.('[jarvis] scheduled agent alert could not be built:', err?.message ?? err) }
    if (n && notifier) {
      try { notifier.submit(n) } catch (err) { log.error?.('[jarvis] scheduled agent alert failed:', err?.message ?? err) }
    }
  })

  /** Is this agent's last scheduled run still queued or running? */
  const busy = (id) => {
    const taskId = running.get(id)
    if (!taskId) return false
    const t = safe(() => tasks.get(taskId), null)
    if (t && taskActive(t)) return true
    running.delete(id)
    return false
  }

  /**
   * Looks at every scheduled agent once. Starts the ones that are due and
   * may run; skips (and forgets) due times for the rest. Returns what it did,
   * for tests and the log.
   */
  function tick() {
    const now = clock()
    const held = pauseReason()
    const updates = []
    const started = []
    const skipped = []
    const list = safe(() => agents.list(), [])
    for (const view of Array.isArray(list) ? list : []) {
      if (view?.mode !== 'scheduled' || typeof view.id !== 'string') continue
      const id = view.id
      const agent = safe(() => agents.get(id), null)
      if (!agent || agent.mode !== 'scheduled') continue
      const expr = safe(() => scheduleOf(agent), agent.schedule)
      // No time set: nothing is due. Once one is, counting starts from then.
      if (expr === null || expr === undefined) { unscheduled.add(id); continue }
      const cron = cronOf(expr)
      if (!cron) {
        if (reported.get(id) !== expr) {
          reported.set(id, expr)
          log.warn?.(`[jarvis] agent ${id} will not run: ${SCHEDULE_SKIPS.badSchedule}`)
        }
        continue
      }
      if (unscheduled.delete(id)) { updates.push([id, floorMinute(now)]); continue }
      const last = state.get(id)
      // First sight: start counting from now; nothing before is made up.
      if (last === undefined) { updates.push([id, floorMinute(now)]); continue }
      const due = latestDue(cron, last, now)
      if (due === null) continue
      // From here the due time is handled one way or another: never twice.
      updates.push([id, due])
      const on = safe(() => agents.isActive(id) === true, false)
      if (held || !on) { skipped.push({ id, at: due, reason: held ?? 'switched off' }); continue }
      if (!agent.budget) { skipped.push({ id, at: due, reason: SCHEDULE_SKIPS.noBudget }); continue }
      if (busy(id)) { skipped.push({ id, at: due, reason: SCHEDULE_SKIPS.stillRunning }); continue }
      const r = safe(() => tasks.spawn({ title: agent.name, goal: scheduledGoal(agent, due), agentId: id }), { ok: false, reason: 'the task could not be queued' })
      if (!r?.ok) { skipped.push({ id, at: due, reason: clip(r?.reason, 120) || 'refused' }); continue }
      running.set(id, r.task.id)
      watching.add(r.task.id)
      started.push({ id, at: due, taskId: r.task.id })
    }
    state.setMany(updates)
    for (const s of started) log.log?.(`[jarvis] scheduled agent ${s.id} started (${s.taskId})`)
    for (const s of skipped) if (s.reason === SCHEDULE_SKIPS.stillRunning || s.reason === SCHEDULE_SKIPS.noBudget) log.warn?.(`[jarvis] scheduled agent ${s.id} skipped: ${s.reason}`)
    return { started, skipped }
  }

  return {
    tick,
    stop() { unsubscribe() },
  }
}
