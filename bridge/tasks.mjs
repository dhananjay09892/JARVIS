/**
 * Tasks: background sub-agents that JARVIS delegates to and the board that
 * shows them.
 *
 * The orchestrator (the voice conversation) never does long work itself. It
 * spawns a task, gets an id back at once, and carries on talking. Each task is
 * its own agent session with its own abort signal, so several run side by side
 * and any one can be cancelled without touching the others.
 *
 * This module owns state and scheduling only. How an agent is actually run is
 * injected as `runAgent`, which keeps it testable and keeps the brain wiring
 * (and its permission rules) in server.mjs where every other session is built.
 * `runAgent` returns the session as BrainEvents (brains/events.mjs), so this
 * module never sees a provider's own message shapes.
 *
 * When a task ends, a `task.finished` event goes on the event bus (bus.mjs,
 * plan 12) if one is passed in: status, title and a clipped summary only.
 *
 * Nothing here grants anything. A task asks for approval through the same cards
 * as everything else; the manager only tags the card with the task it came from
 * and marks the task as waiting while the card is open.
 *
 * A task may carry an `agentId`: it is then a named agent (agents.mjs) and
 * `runAgent` is handed that agent's checked definition, which narrows what the
 * session gets (agent-runtime.mjs). The manager enforces the definition's
 * budget as hard stops: tool calls (through `budget.toolCall`, which the
 * session's guard asks before each call), minutes, and cost when `costCounts()`
 * says this run is billed per use. A stopped run ends `failed` with the reason.
 * A task without an agent id runs exactly as it always has.
 *
 * The owner's agent settings (agent-settings.mjs) reach the manager as
 * getters, read each time they matter, so they apply live:
 *
 *   - `concurrency` (a number, or a function returning one) caps how many
 *     tasks run at once; the rest queue. Raising it starts queued tasks at
 *     the next `refresh()`; lowering it lets running tasks finish.
 *   - `paused()` returns why background work is paused ("pause all agents",
 *     or the kill switch), or null. While paused nothing new is accepted or
 *     started, and `refresh()` stops every queued and running task.
 *   - `defaultBudget()` is the budget an agent runs under when its file sets
 *     none. Tasks without an agent id get no budget, as before.
 *   - `refresh()` also stops any agent task whose agent is no longer active
 *     (switched off, or its file changed), and starts what may now start.
 *
 * A named agent may get a reviewer pass (agent-review.mjs): its result is
 * checked against the goal and the run's log before the task is done; on a
 * fail the agent runs again with the reasons, at most three attempts, and
 * then the task fails saying why. `runAgent` is then handed `retry` (the
 * attempt and the reasons) and a task whose goal carries them.
 *
 * Delegation (agent-delegation.mjs): a run of the Coordinator may start
 * the agents on its `delegate` list through `delegate()`, which `runAgent`
 * is handed bound to that run as `delegation` when the run may delegate at
 * all. Each child is a task one level deeper (`parentId`, `depth`), held to
 * `maxDepth()` (hard ceiling 2), the children cap and a share of what its
 * parent has left; it ends when its parent ends. Everything is checked here,
 * on every start, whatever the session asked for.
 *
 * A team preset (agent-teams.mjs) is a Coordinator task that runs no session
 * of its own: `spawnTeam` checks up front that the team could run, and the
 * run starts each member in turn through the same `delegate()`, so every
 * delegation rule above holds for every member; the Reviewer's verdict
 * decides how the team's task ends.
 *
 * Mission limits (mission-budget.mjs, plan 13 phase 3): when `missionDefaults`
 * is given, every task runs under limits on time, tool calls, tokens and cost,
 * cut to fixed ceilings, and under the scope it was started with (tools,
 * folders, domains). A limit that is reached asks the owner (`approveMore`,
 * at most twice) or stops the task, per `overspend()`; each stop and each
 * out-of-scope refusal goes to `onStop` for the audit.
 *
 * Only background tasks live here. The voice session is not a task, so the
 * cap and the pause never hold it back.
 *
 * Pause and resume (plan 13, phase 1): `pause(id)` stops a task's session and
 * keeps the task, its plan, log and what it has spent; `resume(id)` queues it
 * again and its new session starts from the goal plus what the board recorded
 * (mission-control.mjs resumeBrief). Every run of a task carries a number, and
 * anything a stopped run does late (a progress report, an approval answer, the
 * end of its stream) is ignored once a newer run exists. A resumed task keeps
 * spending the budget it had: tool calls, active minutes and cost carry over.
 * A task the bridge was running when it stopped comes back paused, not lost;
 * a task started by another agent, or a team run, comes back interrupted, as
 * these cannot be paused on their own. Paused tasks are never pruned and do
 * not count against the cap.
 *
 * Planner, verifier and handoff (mission-plan.mjs, plan 13 phases 2 and 9):
 * a plan step may carry a success check, which the worker reports as passed
 * or failed. A plain mission that reads as risky shows its plan as an
 * approval card (`approvePlan`, per `planApproval()`), and none of its tools
 * run until the owner approves that plan. Nothing ends `done` with a failed
 * step, and a plain mission's result is read against its goal by `verifier`
 * (when `verify()` is on) first. A mission that cannot go on becomes
 * `blocked`: kept like a paused one, with a reason and the owner's options,
 * and `resume(id, { choice })` carries the pick into its next run. A task
 * another agent started cannot wait for the owner, so it fails with the same
 * message instead.
 */
import { randomUUID } from 'node:crypto'
import { BUDGET_STOPS, AGENT_REFUSALS } from './agent-runtime.mjs'
import { MAX_REVIEW_ATTEMPTS, REVIEW_STOPS, automaticChecks, parseVerdict, retryGoal, reviewWanted } from './agent-review.mjs'
import {
  DELEGATION_REFUSALS, DELEGATION_STOPS, DELEGATOR_ID as DELEGATOR, MAX_CHILDREN, MAX_WAIT_MS, DEPTH_CEILING, budgetSpent, mayDelegate,
  remainingBudget, shareBudget,
} from './agent-delegation.mjs'
import { resolveAgent } from './agent-ask.mjs'
import { resumeBrief } from './mission-control.mjs'
import {
  PLAN_CARD_TITLE, PLAN_REFUSALS, failedStepBlock, handoffMessage, pickChoice, planBlock, planCard, planKey, readBlocked, readPlan,
  readStepCheck, riskyText, verifyBlock,
} from './mission-plan.mjs'
import { LIMIT_KINDS, askMoreTitle, extendLimit, missionLimits, normaliseScope, withCeilings } from './mission-budget.mjs'
import { isDraftAgent, readDraft } from './agent-draft-result.mjs'
import { isAlertAgent, readTriage } from './agent-triage-result.mjs'
import { isMemoryReviewAgent, readMemoryReview } from './agent-memory-review.mjs'
import { copyMeetingNotes, isMeetingNotesAgent, readMeetingNotes } from './meeting-notes.mjs'
import {
  TEAM_STOPS, memberGoal, memberRecord, memberTitle, reviewGoal, teamAgents, teamOutcome, teamPlan, teamPreset, teamResult, teamSize,
} from './agent-teams.mjs'

export const MAX_CONCURRENT = 3
/** The cap is a setting from 1 to 8 (agent-settings.mjs); anything else falls back to the default. */
const CAP_MAX = 8
const MAX_KEPT = 50
const MAX_LOG = 40
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

const ACTIVE = new Set(['queued', 'running', 'waiting_approval', 'waiting_input'])
export const ANSWER_TTL_MS = 30 * 60 * 1000
export const isActive = (task) => ACTIVE.has(task.status)
/** Kept for the owner to resume: paused, or blocked with options to pick from. */
export const isHeld = (task) => task.status === 'paused' || task.status === 'blocked'
/** Not ended: live, or held and waiting to be resumed. */
export const isOpen = (task) => ACTIVE.has(task.status) || isHeld(task)
export const PAUSE_REFUSALS = Object.freeze({
  missing: 'No such task.',
  ended: 'That task has already ended.',
  already: 'That task is already paused.',
  child: 'Another agent started that task. Pause the task that started it.',
  team: 'A team run cannot be paused. Cancel it instead.',
  notPaused: 'That task is not paused.',
})
/** What a step check that failed tells the worker. */
export const STEP_FAILED_NOTE = 'Recorded as not passed. Fix it and report the check again, or report blocked with options. A mission with a failed step is never reported as done.'
export const RESTART_PAUSED = 'Paused: JARVIS restarted while this was running. Resume it to carry on.'

/** A copy of a triage, so a view never shares its lists with the task. */
const copyTriage = (t) => ({ ...t, urgent: [...t.urgent], soon: [...t.soon], later: [...t.later], drafts: t.drafts.map((d) => ({ ...d })) })
/** A copy of a memory review, for the same reason. */
const copyReview = (r) => ({ ...r, keep: [...r.keep], merge: r.merge.map((m) => ({ ...m, ids: [...m.ids] })), check: r.check.map((c) => ({ ...c })) })

/** What the browser and the orchestrator see: no signals, no internals. */
function snapshot(t) {
  return {
    id: t.id,
    title: t.title,
    goal: t.goal,
    status: t.status,
    steps: t.steps.map((s, i) => ({
      label: s, state: i < t.step - 1 ? 'done' : i === t.step - 1 ? 'active' : 'todo',
      ...(t.checks?.[i] && { check: t.checks[i] }),
      ...(t.outcomes?.[i] && { outcome: t.outcomes[i].passed ? 'passed' : 'failed', ...(t.outcomes[i].evidence && { evidence: t.outcomes[i].evidence }) }),
    })),
    percent: t.status === 'done' ? 100 : t.steps.length ? Math.round((Math.max(0, t.step - 1) / t.steps.length) * 100) : 0,
    note: t.note,
    question: t.question?.text ?? '',
    log: t.log.slice(-MAX_LOG),
    result: t.result,
    error: t.error,
    costUsd: t.costUsd,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ...(t.agentId && { agentId: t.agentId, agentName: t.agentName }),
    ...(t.draft && { draft: { ...t.draft } }),
    ...(t.triage && { triage: copyTriage(t.triage) }),
    ...(t.memoryReview && { memoryReview: copyReview(t.memoryReview) }),
    ...(t.meetingNotes && { meetingNotes: copyMeetingNotes(t.meetingNotes) }),
    ...(t.depth > 1 && { depth: t.depth }),
    ...(t.parentId && { parentId: t.parentId }),
    ...(t.team && { team: { id: t.team, name: teamPreset(t.team)?.name ?? t.team } }),
    ...(t.resumed > 0 && { resumed: t.resumed }),
    // Why it cannot go on and what the owner may pick; the note carries the same as one message.
    ...(t.blocked && { blocked: { kind: t.blocked.kind, reason: t.blocked.reason, options: [...t.blocked.options] } }),
    ...(t.handoff && { handoff: { ...t.handoff } }),
    ...(t.planApproved && { planApproved: true }),
    ...(typeof t.verified === 'boolean' && { verified: t.verified }),
    // What the task has used so far, so a resume (or a restart) keeps its budget.
    ...((t.calls > 0 || t.usedMs > 0 || t.runFrom) && { usage: { toolCalls: t.calls ?? 0, activeMs: activeMs(t), ...(t.tokens > 0 && { tokens: t.tokens }) } }),
    // The limits it runs under now (after any extension), and the scope it was given.
    ...(t.limits && { limits: { ...t.limits }, ...(t.extensions > 0 && { extensions: t.extensions }) }),
    ...(t.asked && { asked: { ...t.asked } }),
    ...(t.scope && { scope: { allowedTools: [...t.scope.allowedTools], allowedPaths: [...t.scope.allowedPaths], allowedDomains: [...t.scope.allowedDomains] } }),
  }
}

/** The limits a mission may ask to have lowered, from untrusted input. */
const pickAsked = (l) => {
  const out = {}
  for (const f of ['maxToolCalls', 'maxMinutes', 'maxCostUsd', 'maxTokens']) if (typeof l?.[f] === 'number' && Number.isFinite(l[f]) && l[f] >= 0) out[f] = l[f]
  return Object.keys(out).length ? out : null
}

/** Milliseconds the task has spent running, across every run. */
const activeMs = (t) => (t.usedMs ?? 0) + (t.runFrom ? Math.max(0, Date.now() - t.runFrom) : 0)

/**
 * @param {object} o
 * @param {Function} o.runAgent starts one task's session; returns its BrainEvents
 * @param {{ has: Function, get: Function, isActive: Function }} [o.agents] the agent registry
 * @param {(agent: object) => boolean} [o.costCounts] is this agent's run billed per use (an API key)? Only then is maxCostUsd enforced.
 * @param {number | (() => number)} [o.concurrency] how many tasks may run at once (1–8)
 * @param {() => string | null} [o.paused] why background work is paused, or null
 * @param {() => object | null} [o.defaultBudget] the budget for an agent whose file sets none
 * @param {Function} [o.reviewer] checks a named agent's result (agent-review.mjs createReviewer); without one nothing is reviewed
 * @param {() => boolean} [o.reviewDefault] the owner's reviewer default, for agents whose file does not say
 * @param {() => number} [o.maxDepth] agents.maxDepth (1–2); how deep delegation may go
 * @param {number} [o.maxChildren] how many agents one run may start in all
 * @param {() => object | null} [o.missionDefaults] the default mission limits (mission-budget.mjs); without it only named agents have limits, as before
 * @param {() => 'ask' | 'stop'} [o.overspend] what a reached limit does
 * @param {(title: string, details?: string) => Promise<boolean>} [o.approveMore] shows the "allow more?" card
 * @param {(e: { taskId: string, agentId?: string, rule: string, reason: string }) => void} [o.onStop] hears every limit stop and scope refusal, and every plan answer, block and failed final check
 * @param {() => 'risky' | 'always' | 'never'} [o.planApproval] which plain missions show their plan for approval first
 * @param {(title: string, details?: string) => Promise<boolean>} [o.approvePlan] shows the plan card; without it no plan is asked about
 * @param {Function} [o.verifier] reads a plain mission's result against its goal (mission-plan.mjs createVerifier); without one nothing is verified
 * @param {() => boolean} [o.verify] is the final check switched on
 */
export function createTaskManager({
  runAgent, store = null, bus = null, agents = null, costCounts = () => false,
  concurrency = MAX_CONCURRENT, paused = () => null, defaultBudget = () => null,
  reviewer = null, reviewDefault = () => false, maxDepth = () => 1, maxChildren = MAX_CHILDREN,
  missionDefaults = null, overspend = () => 'ask', approveMore = null, onStop = null,
  planApproval = () => 'risky', approvePlan = null, verifier = null, verify = () => true,
  now = () => Date.now(), log = console,
} = {}) {
  const tasks = new Map()
  const listeners = new Set()

  /** The cap now. A getter that throws or returns nonsense falls back to the default. */
  const cap = () => {
    let n
    try { n = typeof concurrency === 'function' ? concurrency() : concurrency } catch { n = MAX_CONCURRENT }
    return Number.isInteger(n) && n >= 1 && n <= CAP_MAX ? n : MAX_CONCURRENT
  }

  /** Why nothing may run now, or null. A getter that throws counts as paused. */
  const pauseReason = () => {
    let r
    try { r = paused() } catch { return 'Background work is paused.' }
    return typeof r === 'string' && r ? r : null
  }

  /** The budget an agent runs under: its own, else the owner's default. */
  const budgetOf = (agent) => {
    if (agent?.budget) return agent.budget
    let b = null
    try { b = defaultBudget() } catch { b = null }
    return b && typeof b === 'object' ? b : null
  }

  /**
   * The limits a task starts under. Without `missionDefaults` that is what it
   * always was: a named agent's budget, else none. With it, every task has all
   * four limits: its agent's budget (or the owner's default), cut to the
   * ceilings, and lowered further by anything the mission itself asked for.
   */
  const missionBase = (t, agent) => {
    const own = agent ? budgetOf(agent) : null
    if (typeof missionDefaults !== 'function') return own
    let def = null
    try { def = missionDefaults() } catch { def = null }
    return missionLimits({ ...(def && typeof def === 'object' ? def : {}), ...(agent?.budget ?? {}) }, t.asked)
  }

  /** A `TaskOutcome` (shared/contracts.ts) on the bus. The bus never throws. */
  const announce = (t) => {
    if (!bus) return
    bus.publish('task.finished', {
      taskId: t.id,
      title: clip(t.title, 60) || 'Task',
      status: t.status,
      summary: clip(t.status === 'done' ? t.result : t.error, 300),
      ...(typeof t.costUsd === 'number' && t.costUsd >= 0 && { costUsd: t.costUsd }),
      ...(Number.isInteger(t.startedAt) && { startedAt: t.startedAt }),
      endedAt: t.endedAt,
      sensitivity: 'private',
    })
  }

  const emit = (t) => {
    const snap = snapshot(t)
    // A failing disk must not stop a task; the board still works from memory.
    try { store?.save(snap, t.createdAt) } catch (err) { log.error?.('[jarvis] task store write failed:', err.message) }
    const frame = { type: 'task', task: snap }
    for (const send of listeners) send(frame)
  }

  /** Back from disk. Nothing is resumed: an unfinished task lost its agent with the old process. */
  function restore() {
    let saved = []
    try { saved = store?.load() ?? [] } catch (err) { log.error?.('[jarvis] task store read failed:', err.message) }
    for (const s of saved) {
      const t = {
        id: s.id, title: s.title, goal: s.goal, status: s.status, steps: s.steps.map((x) => x.label),
        checks: s.steps.map((x) => clip(x.check, 160)),
        outcomes: s.steps.map((x) => (x.outcome === 'passed' || x.outcome === 'failed' ? { passed: x.outcome === 'passed', evidence: clip(x.evidence, 200) } : null)),
        step: s.steps.filter((x) => x.state === 'done').length + 1, note: s.note, log: s.log, result: s.result,
        error: s.error, costUsd: s.costUsd, startedAt: s.startedAt, endedAt: s.endedAt, createdAt: s.createdAt ?? s.startedAt ?? now(),
        waiting: 0, question: null, tools: new Set(), abort: new AbortController(),
        ...(typeof s.agentId === 'string' && s.agentId && { agentId: s.agentId, agentName: clip(s.agentName, 60) || s.agentId }),
        depth: Number.isInteger(s.depth) && s.depth > 1 ? s.depth : 1,
        ...(typeof s.parentId === 'string' && s.parentId && { parentId: s.parentId }),
        ...(teamPreset(s.team?.id) && { team: teamPreset(s.team.id).id }),
        children: 0, childCostUsd: 0, waiters: new Set(),
        calls: Number.isInteger(s.usage?.toolCalls) && s.usage.toolCalls > 0 ? s.usage.toolCalls : 0,
        usedMs: typeof s.usage?.activeMs === 'number' && s.usage.activeMs > 0 ? s.usage.activeMs : 0,
        runFrom: null,
        resumed: Number.isInteger(s.resumed) && s.resumed > 0 ? s.resumed : 0,
        tokens: Number.isInteger(s.usage?.tokens) && s.usage.tokens > 0 ? s.usage.tokens : 0,
        extensions: Number.isInteger(s.extensions) && s.extensions > 0 ? Math.min(s.extensions, 2) : 0,
        ...(s.limits && typeof s.limits === 'object' && { limits: withCeilings(s.limits) }),
        ...(s.asked && typeof s.asked === 'object' && { asked: pickAsked(s.asked) }),
        ...(normaliseScope(s.scope) && { scope: normaliseScope(s.scope) }),
        ...(typeof s.verified === 'boolean' && { verified: s.verified }),
        ...(s.handoff && typeof s.handoff === 'object' && { handoff: { reason: clip(s.handoff.reason, 300), choice: clip(s.handoff.choice, 500) } }),
      }
      if (s.planApproved === true && t.steps.length) t.planApproved = planKey(t.steps, t.checks)
      if (t.status === 'blocked') {
        const b = readBlocked(s.blocked)
        // A blocked task that lost its options is still kept; it can only be resumed plainly or cancelled.
        t.blocked = b.ok ? { kind: clip(s.blocked?.kind, 20) || 'worker', ...b.blocked } : { kind: 'worker', reason: clip(s.blocked?.reason, 300) || 'it could not go on', options: [] }
      }
      if (ACTIVE.has(t.status) && !t.parentId && !t.team) {
        // Its agent is gone with the old process, but the task is not: it
        // waits, paused, for the owner to resume it. Nothing restarts on its own.
        t.status = 'paused'
        t.note = RESTART_PAUSED
        note(t, 'paused', RESTART_PAUSED)
        emit(t)
      } else if (ACTIVE.has(t.status)) {
        t.status = 'interrupted'
        t.error = 'Interrupted: JARVIS restarted while this was running.'
        t.endedAt = now()
        note(t, 'interrupted', t.error)
        emit(t)
        announce(t)
      }
      tasks.set(t.id, t)
    }
  }
  const note = (t, kind, text) => {
    t.log.push({ at: now(), kind, text: clip(text, 160) })
    if (t.log.length > MAX_LOG * 2) t.log.splice(0, t.log.length - MAX_LOG)
  }

  function prune() {
    const finished = [...tasks.values()].filter((t) => !isOpen(t))
    for (const t of finished.slice(0, Math.max(0, finished.length - MAX_KEPT))) forget(t.id)
  }

  function forget(id) {
    tasks.delete(id)
    try { store?.remove(id) } catch (err) { log.error?.('[jarvis] task store delete failed:', err.message) }
  }

  const running = () => [...tasks.values()].filter((t) => isActive(t) && t.status !== 'queued').length

  function pump() {
    if (pauseReason()) return
    for (const t of tasks.values()) {
      if (running() >= cap()) return
      if (t.status === 'queued') start(t)
    }
  }

  /** Is this task's agent still allowed to run? Plain tasks always are. */
  const agentStillActive = (t) => {
    if (!t.agentId) return true
    try { return agents?.isActive(t.agentId) === true } catch { return false }
  }

  /**
   * Apply the settings as they are now: while paused, stop every queued and
   * running task; otherwise stop agent tasks whose agent was switched off,
   * then start whatever the cap allows.
   */
  function refresh() {
    const reason = pauseReason()
    let stopped = 0
    for (const t of [...tasks.values()]) {
      if (!isActive(t)) continue
      const why = reason ?? (agentStillActive(t) ? null : `The ${t.agentName} agent was switched off.`)
      if (!why) continue
      t.abort.abort()
      finish(t, 'cancelled', { error: why })
      stopped += 1
    }
    pump()
    return { stopped, paused: reason !== null }
  }

  /**
   * What a finished run leaves on its task: the result, and for an agent
   * whose output is a draft, the draft read from it (agent-draft-result.mjs)
   * so the board can show and copy it; for an alert agent in the triage
   * shape (agent-triage-result.mjs), the triage, so its end can be raised by
   * what it found; for a memory-reading report agent in the review shape
   * (agent-memory-review.mjs, the Memory Curator), its memory proposals;
   * for a report agent that reads meetings (meeting-notes.mjs), the minutes,
   * decisions and action-item drafts. Reading any of them sends, saves or
   * changes nothing.
   */
  function doneFields(agent, result) {
    const draft = isDraftAgent(agent) ? readDraft(result) : null
    const triage = isAlertAgent(agent) ? readTriage(result) : null
    const memoryReview = isMemoryReviewAgent(agent) ? readMemoryReview(result) : null
    const meetingNotes = isMeetingNotesAgent(agent) ? readMeetingNotes(result) : null
    return {
      result, ...(draft && { draft }), ...(triage && { triage }), ...(memoryReview && { memoryReview }), ...(meetingNotes && { meetingNotes }),
    }
  }

  function finish(t, status, fields = {}) {
    if (!isOpen(t)) return
    if (t.timer) { clearTimeout(t.timer); t.timer = null }
    if (t.runFrom) { t.usedMs = activeMs(t); t.runFrom = null }
    // Release a parked question first, while the task still counts as active.
    t.question?.settle(null)
    Object.assign(t, fields, { status, endedAt: now() })
    t.blocked = null
    if (status === 'done') t.step = t.steps.length + 1
    note(t, status, fields.error ?? fields.result ?? status)
    emit(t)
    announce(t)
    // A delegating run waiting on this one hears at once.
    for (const wake of t.waiters) wake()
    t.waiters.clear()
    // What a child spent counts against what its parent may still share.
    const parent = t.parentId ? tasks.get(t.parentId) : null
    if (parent && typeof t.costUsd === 'number' && t.costUsd > 0) parent.childCostUsd += t.costUsd
    // A child never outlives the run that started it.
    for (const c of [...tasks.values()]) {
      if (c.parentId !== t.id || !isActive(c)) continue
      c.abort.abort()
      finish(c, 'cancelled', { error: DELEGATION_STOPS.parentEnded })
    }
    prune()
    pump()
  }

  /** The progress callback handed to the agent's report_progress tool. */
  const reporter = (t, run) => (p) => {
    if (!isActive(t) || t.run !== run) return { ok: false, reason: 'This task has ended.' }
    // "I am stuck": the worker hands the mission back with a reason and options.
    if (p.blocked !== undefined && p.blocked !== null) {
      const b = readBlocked(p.blocked)
      if (!b.ok) return { ok: false, reason: b.reason }
      block(t, run, { kind: 'worker', ...b.blocked })
      return { ok: true, blocked: true, note: 'The owner has been told. Stop now.' }
    }
    let toApprove = null
    if (Array.isArray(p.plan) && p.plan.length) {
      if (t.planAsk) return { ok: false, reason: PLAN_REFUSALS.pending }
      const plan = readPlan(p)
      if (plan.labels.length) {
        t.steps = plan.labels
        t.checks = plan.checks
        t.outcomes = []
        t.step = 1
        note(t, 'plan', `${t.steps.length} steps`)
        if (planNeedsApproval(t, p, plan)) toApprove = plan
      }
    }
    if (Number.isInteger(p.step) && t.steps.length) {
      t.step = Math.min(Math.max(1, p.step), t.steps.length)
      note(t, 'step', t.steps[t.step - 1])
    }
    if (typeof p.note === 'string' && p.note.trim()) {
      t.note = clip(p.note, 160)
      note(t, 'note', t.note)
    }
    // The success check of one step: the last report for a step is the one that counts.
    const checked = readStepCheck(p.checked, t.steps.length)
    if (checked) {
      t.outcomes[checked.step - 1] = { passed: checked.passed, evidence: checked.evidence }
      note(t, 'check', `step ${checked.step} ${checked.passed ? 'passed' : 'failed'}${checked.evidence ? `: ${checked.evidence}` : ''}`)
    }
    emit(t)
    if (toApprove) return askPlan(t, run, toApprove)
    return { ok: true, ...(checked && !checked.passed && { note: STEP_FAILED_NOTE }) }
  }

  /** The owner's plan-approval choice now. A getter that throws counts as the careful default. */
  const planMode = () => {
    if (typeof approvePlan !== 'function') return 'never'
    try {
      const m = planApproval()
      return m === 'always' || m === 'never' ? m : 'risky'
    } catch { return 'risky' }
  }

  /** May this task be asked for plan approval at all? Plain missions only; a named agent has its own narrower tools. */
  const planned = (t) => !t.agentId && !t.parentId && !t.team

  /** Must this plan be shown to the owner before the mission goes on? An approval holds only for the plan that was shown. */
  function planNeedsApproval(t, p, plan) {
    if (!planned(t) || t.planApproved === plan.key) return false
    const mode = planMode()
    if (mode === 'never') return false
    return mode === 'always' || t.planNeeded === true || p.risky === true || riskyText(`${plan.labels.join('\n')}\n${plan.checks.join('\n')}`)
  }

  /** Why no tool may run yet, or null: a plan is owed, or is waiting for its answer. */
  const planHeld = (t) => {
    if (t.planAsk) return PLAN_REFUSALS.waiting
    return t.planNeeded && !t.planApproved && planMode() !== 'never' ? PLAN_REFUSALS.first : null
  }

  /**
   * Show the plan as an approval card and wait. Approved: the mission goes
   * on. Anything else (a "no", no answer, nobody connected) and it waits,
   * blocked, for the owner; it is never taken as a yes.
   */
  async function askPlan(t, run, plan) {
    const asking = (async () => {
      try { return (await approver(t, approvePlan, run)(PLAN_CARD_TITLE, planCard(plan))) === true } catch { return false }
    })()
    t.planAsk = asking
    let ok = false
    try { ok = await asking } finally { if (t.planAsk === asking) t.planAsk = null }
    if (!isActive(t) || t.run !== run) return { ok: false, reason: 'This task has ended.' }
    if (!ok) {
      report(t, 'mission-plan-denied', 'the plan was not approved')
      block(t, run, planBlock())
      return { ok: false, reason: 'The plan was not approved. Stop now.' }
    }
    t.planApproved = plan.key
    note(t, 'plan', 'approved by the owner')
    report(t, 'mission-plan-approved', 'the owner approved the plan')
    emit(t)
    return { ok: true, approved: true }
  }

  /** Stop a task's session but keep the task: what pause and block share. */
  function hold(t, status, text) {
    // Release a parked question while the task still counts as live.
    t.question?.settle(null)
    if (t.timer) { clearTimeout(t.timer); t.timer = null }
    if (t.runFrom) { t.usedMs = activeMs(t); t.runFrom = null }
    t.status = status
    t.note = clip(text, 900)
    t.abort.abort()
    note(t, status, text)
    emit(t)
    for (const wake of t.waiters) wake()
    t.waiters.clear()
    for (const c of [...tasks.values()]) {
      if (c.parentId !== t.id || !isActive(c)) continue
      c.abort.abort()
      finish(c, 'cancelled', { error: DELEGATION_STOPS.parentEnded })
    }
    pump()
  }

  /**
   * The mission cannot go on: keep it, blocked, with the reason and the
   * owner's options. A task another agent started (or a team run) cannot wait
   * for the owner on its own, so it fails with the same message.
   */
  function block(t, run, info, fields = {}) {
    if (!isActive(t) || t.run !== run) return
    const message = handoffMessage(info)
    report(t, 'mission-blocked', `${info.kind}: ${clip(info.reason, 200)}`)
    if (t.parentId || t.team) {
      t.abort.abort()
      finish(t, 'failed', { ...fields, error: message })
      return
    }
    Object.assign(t, fields)
    t.blocked = { kind: info.kind, reason: info.reason, options: [...info.options] }
    hold(t, 'blocked', message)
  }

  /** Wraps an approval so the card names the task and the task shows it is waiting. */
  const approver = (t, approve, run) => async (title, details) => {
    if (!isActive(t) || t.run !== run) return false
    t.waiting += 1
    t.status = 'waiting_approval'
    note(t, 'approval', title)
    emit(t)
    try {
      const who = t.agentName ? ` (${t.agentName})` : ''
      return await approve(`Task "${t.title}"${who}: ${title}`, details)
    } finally {
      // A card answered after its run was paused belongs to no run now.
      if (t.run === run) {
        t.waiting -= 1
        if (t.status === 'waiting_approval' && t.waiting === 0) t.status = t.question ? 'waiting_input' : 'running'
        emit(t)
      }
    }
  }

  /** Lets the agent put one question to the owner and wait for the typed answer. */
  const asker = (t, run) => (text) => {
    const q = clip(text, 500)
    if (!isActive(t) || t.run !== run || t.question || !q) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => t.question?.settle(null), ANSWER_TTL_MS)
      timer.unref?.()
      t.question = {
        text: q,
        settle(answer) {
          clearTimeout(timer)
          t.question = null
          if (isActive(t) && t.waiting === 0) t.status = 'running'
          note(t, 'answer', answer === null ? 'no answer' : 'answered')
          emit(t)
          resolve(answer)
        },
      }
      t.status = 'waiting_input'
      note(t, 'question', q)
      emit(t)
    })
  }

  /** Why a worker's turn failed, from its `error` event, in words for the board. */
  function failureText(e) {
    if (!e) return 'The agent stopped without saying why.'
    if (e.code === 'ended') return 'The agent ended without a result.'
    if (e.code === 'session_error' && e.message) return clip(e.message, 300)
    return `The agent stopped: ${e.code}.`
  }

  /**
   * End a run at a budget limit: abort its session and fail it with the reason.
   * Like cancel, but honest that the work stopped short rather than finished.
   */
  const stopper = (t, run = t.run) => (reason) => {
    if (!isActive(t) || t.run !== run) return
    t.abort.abort()
    finish(t, 'failed', { error: reason })
  }

  const LIMIT_STOP = {
    maxToolCalls: BUDGET_STOPS.toolCalls, maxMinutes: BUDGET_STOPS.minutes, maxCostUsd: BUDGET_STOPS.cost, maxTokens: BUDGET_STOPS.tokens,
  }
  const LIMIT_ORDER = ['maxToolCalls', 'maxMinutes', 'maxCostUsd', 'maxTokens']

  /** Tell the audit about a stop or a refusal. It must never change what happens. */
  const report = (t, rule, reason) => {
    try { onStop?.({ taskId: t.id, ...(t.agentId && { agentId: t.agentId }), rule, reason }) } catch (err) { log.error?.('[jarvis] mission audit failed:', err?.message ?? err) }
  }

  /** Is this limit used up now? Cost only counts for a run billed per use. */
  function exceeded(t, field) {
    const limit = t.limits?.[field]
    if (typeof limit !== 'number') return false
    switch (field) {
      case 'maxToolCalls': return t.calls >= limit
      case 'maxMinutes': return activeMs(t) >= limit * 60_000
      case 'maxTokens': return (t.tokens ?? 0) >= limit
      case 'maxCostUsd': {
        if (typeof t.costUsd !== 'number' || t.costUsd <= limit) return false
        try { return costCounts(t.agent ?? null) === true } catch { return false }
      }
      default: return false
    }
  }

  /**
   * A limit was reached. With "ask" and an approval card available, ask the
   * owner for more (twice at most, never past the ceiling); otherwise, or on a
   * "no", end the run with the reason and audit it. Resolves true when the run
   * may go on. One question at a time: other callers wait for its answer.
   */
  async function reached(t, run, field) {
    const live = () => isActive(t) && t.run === run
    if (!live()) return false
    if (t.more) {
      await t.more.catch(() => false)
      return live() && !exceeded(t, field)
    }
    const limit = t.limits[field]
    let mode = 'ask'
    try { mode = overspend() === 'stop' ? 'stop' : 'ask' } catch { mode = 'stop' }
    const next = mode === 'ask' && typeof approveMore === 'function' ? extendLimit(t.limits, t.start ?? t.limits, field, t.extensions ?? 0) : null
    const end = (why) => {
      stopper(t, run)(LIMIT_STOP[field](limit))
      report(t, `mission-${LIMIT_KINDS[field]}`, `${LIMIT_KINDS[field]} limit reached; ${why}`)
      return false
    }
    if (!next) return end(mode === 'stop' ? 'stopped by the setting' : 'no more allowed')
    const asking = (async () => {
      try { return (await approver(t, approveMore, run)(askMoreTitle(field, limit))) === true } catch { return false }
    })()
    t.more = asking
    let ok = false
    try { ok = await asking } finally { if (t.more === asking) t.more = null }
    if (!live()) return false
    if (!ok) return end('owner did not allow more')
    t.limits = next
    t.extensions = (t.extensions ?? 0) + 1
    note(t, 'budget', `allowed more: ${LIMIT_KINDS[field]} now ${next[field]}`)
    report(t, `mission-${LIMIT_KINDS[field]}-extended`, `owner allowed more ${LIMIT_KINDS[field]}`)
    if (field === 'maxMinutes') armTimer(t, run)
    emit(t)
    return true
  }

  /** The minutes limit as a timer: when it fires the limit has been reached. */
  function armTimer(t, run) {
    if (t.timer) { clearTimeout(t.timer); t.timer = null }
    const minutes = t.limits?.maxMinutes
    if (!(typeof minutes === 'number' && minutes > 0)) return
    const left = Math.max(0, minutes * 60_000 - activeMs(t))
    t.timer = setTimeout(() => {
      t.timer = null
      if (!isActive(t) || t.run !== run) return
      void reached(t, run, 'maxMinutes')
    }, left)
    t.timer.unref?.()
  }

  /** The budget the session's guard spends from; null without one. */
  function budgetFor(t, limits, run) {
    if (!Number.isInteger(limits?.maxToolCalls) && !t.planNeeded) return null
    return {
      /**
       * One tool call is about to run. Returns null to let it, or the refusal;
       * only when a limit has been reached does it return a promise, which
       * settles once the owner has been asked (or the run has been stopped).
       */
      toolCall() {
        if (!isActive(t) || t.run !== run) return AGENT_REFUSALS.budget
        const held = planHeld(t)
        if (held) return held
        if (t.more || LIMIT_ORDER.some((f) => exceeded(t, f))) return slow()
        return take()
      },
    }
    async function slow() {
      if (t.more) await t.more.catch(() => false)
      for (const field of LIMIT_ORDER) {
        if (!isActive(t) || t.run !== run) return AGENT_REFUSALS.budget
        if (exceeded(t, field) && !(await reached(t, run, field))) return AGENT_REFUSALS.budget
      }
      return take()
    }
    function take() {
      if (!isActive(t) || t.run !== run) return AGENT_REFUSALS.budget
      // A child spends from its parent's tool calls as it goes, so the
      // children of one run share what that run has, not each a copy.
      const parent = t.parentId ? tasks.get(t.parentId) : null
      if (parent && Number.isInteger(parent.limits?.maxToolCalls)) {
        if (!isActive(parent) || parent.calls >= parent.limits.maxToolCalls) {
          stopper(t, run)(DELEGATION_STOPS.parentBudget)
          return AGENT_REFUSALS.budget
        }
        parent.calls += 1
      }
      t.calls += 1
      return null
    }
  }

  /** The owner's reviewer default now. A getter that throws counts as off. */
  const reviewDefaultNow = () => {
    try { return reviewDefault() === true } catch { return false }
  }

  /** Add one attempt's (or one review's) cost to what the task has spent before it. */
  const spend = (t, usd) => {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return
    t.costUsd = (typeof t.costBase === 'number' ? t.costBase : 0) + usd
  }

  /**
   * One run of the task's session. Returns the agent's summary when the run
   * completed, or null when the run ended the task itself (failed, cancelled
   * or stopped at a budget).
   */
  async function attemptOnce(t, agent, limits, retry) {
    // This run only: once the task is paused (and perhaps resumed as a newer
    // run), nothing this run does late may end or change the task.
    const run = t.run
    const signal = t.abort.signal
    const live = () => isActive(t) && t.run === run
    const end = (status, fields) => { if (live()) finish(t, status, fields) }
    try {
      const task = snapshot(t)
      const goal = retry?.goal ?? (t.resumed > 0 ? resumeBrief(task) : null)
      t.handoff = null
      const stream = runAgent({
        task: goal ? { ...task, goal } : task,
        signal,
        report: reporter(t, run),
        ask: asker(t, run),
        wrapApprove: (approve) => approver(t, approve, run),
        ...(agent && { agent }),
        ...((agent || t.limits || t.planNeeded) && { budget: budgetFor(t, t.limits ?? limits, run) }),
        ...(t.limits && { stop: stopper(t, run) }),
        ...(t.scope && { scopeDenied: (r) => report(t, `mission-scope-${r.kind}`, `${r.tool}: ${r.reason}`) }),
        ...(agent && { depth: t.depth }),
        ...(agent && delegationFor(t, agent)),
        ...(retry && { retry: { attempt: retry.attempt, reasons: [...retry.reasons] } }),
      })
      // The worker's session as BrainEvents (brains/events.mjs). The summary is
      // the text after the last tool call: what the worker wrote once its work
      // was done, not the "let me look" lines in between.
      let reply = ''
      let failure = null
      for await (const e of stream) {
        if (!live()) break
        switch (e?.t) {
          case 'text':
            reply += e.delta
            break
          case 'tool_start':
          case 'tool_call':
            reply = ''
            if (!t.tools.has(e.id)) {
              t.tools.add(e.id)
              note(t, 'tool', e.name.replace(/^mcp__/, '').replace(/__/g, ' › '))
              emit(t)
            }
            break
          case 'usage':
            if (e.costUsd !== undefined) spend(t, e.costUsd)
            for (const n of [e.inTokens, e.outTokens]) if (Number.isFinite(n) && n > 0) t.tokens = (t.tokens ?? 0) + Math.floor(n)
            for (const field of ['maxCostUsd', 'maxTokens']) {
              if (live() && exceeded(t, field)) await reached(t, run, field)
            }
            break
          case 'error':
            failure = e
            break
          case 'done':
            if (e.reason === 'complete') return live() ? clip(reply, 1200) : null
            if (e.reason === 'cancelled' || signal.aborted) end('cancelled', { error: 'Cancelled.' })
            else {
              if (live()) log.error?.('[jarvis] task failed:', failure?.message ?? failure?.code ?? e.reason)
              end('failed', { error: failureText(failure) })
            }
            return null
        }
      }
      // A stream that ends with no result and no cancel is a failure, not a success.
      end('failed', { error: 'The agent ended without a result.' })
      return null
    } catch (err) {
      if (signal.aborted) end('cancelled', { error: 'Cancelled.' })
      else if (live()) {
        log.error?.('[jarvis] task failed:', err)
        end('failed', { error: clip(String(err?.message ?? err), 300) })
      }
      return null
    }
  }

  /**
   * The reviewer's verdict on one attempt (agent-review.mjs), or null when
   * the review itself ended the task (cancelled, or the reviewer failed).
   * The reviewer is handed the owner's original goal and a copy of the log.
   */
  async function reviewOnce(t, agent, result, attempt) {
    const run = t.run
    const live = () => isActive(t) && t.run === run
    note(t, 'review', `reviewing attempt ${attempt}`)
    emit(t)
    let verdict
    try {
      verdict = await reviewer({
        task: { id: t.id, title: t.title, goal: t.goal },
        agent,
        result,
        log: t.log.map((l) => ({ ...l })),
        attempt,
        signal: t.abort.signal,
      })
    } catch (err) {
      if (!live()) return null
      if (t.abort.signal.aborted) { finish(t, 'cancelled', { error: 'Cancelled.' }); return null }
      log.error?.('[jarvis] review failed:', err?.message ?? err)
      finish(t, 'failed', { result, error: REVIEW_STOPS.unavailable(clip(String(err?.message ?? ''), 120)) })
      return null
    }
    if (!live()) return null
    if (!verdict || typeof verdict.pass !== 'boolean') verdict = parseVerdict('')
    if (typeof verdict.costUsd === 'number') { spend(t, verdict.costUsd); t.costBase = t.costUsd }
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => clip(r, 300)) : []
    return { pass: verdict.pass, reasons }
  }

  async function start(t) {
    t.run = (t.run ?? 0) + 1
    const run = t.run
    let agent = null
    if (t.agentId) {
      // Checked again at start: the agent may have been switched off or
      // changed while this task sat in the queue.
      let ok = false
      try { ok = agents?.isActive(t.agentId) === true; agent = ok ? agents.get(t.agentId) : null } catch { ok = false }
      if (!ok || !agent) {
        t.startedAt = now()
        finish(t, 'failed', { error: `The ${t.agentName} agent is not available any more.` })
        return
      }
    }
    // A child runs within what its parent has left now, not when it was asked for.
    let limits = missionBase(t, agent)
    if (t.parentId) {
      const parent = tasks.get(t.parentId)
      if (!parent || !isActive(parent)) {
        t.startedAt = now()
        finish(t, 'cancelled', { error: DELEGATION_STOPS.parentEnded })
        return
      }
      const left = parentLeft(parent)
      if (budgetSpent(left)) {
        t.startedAt = now()
        finish(t, 'failed', { error: DELEGATION_STOPS.parentBudget })
        return
      }
      const own = limits
      limits = shareBudget(own, left)
      if (own && Number.isInteger(own.maxTokens)) limits = { ...(limits ?? {}), maxTokens: own.maxTokens }
    }
    // A resumed mission keeps the extra the owner allowed; its ceilings still hold.
    t.limits = limits && t.extensions > 0 && t.limits ? withCeilings({ ...limits, ...t.limits }) : limits
    t.start = limits
    t.agent = agent
    t.status = 'running'
    // A resumed task keeps when it first started and what it has already used.
    t.startedAt = t.startedAt ?? now()
    t.runFrom = Date.now()
    t.calls = Number.isInteger(t.calls) ? t.calls : 0
    t.costBase = typeof t.costUsd === 'number' ? t.costUsd : 0
    // A plain mission whose goal reads as risky owes the owner a plan before any tool runs.
    const mode = planMode()
    t.planNeeded = planned(t) && (mode === 'always' || (mode === 'risky' && riskyText(`${t.title}\n${t.goal}`)))
    note(t, 'start', `${t.resumed > 0 ? 'resumed' : 'started'}${agent ? ` as ${agent.name}` : ''}`)
    emit(t)
    armTimer(t, run)
    if (t.team) { await runTeam(t); return }
    // Only a named agent is reviewed, and only when its file or the owner's
    // default asks for it. The budget covers every attempt together.
    const reviewed = Boolean(agent) && typeof reviewer === 'function' && reviewWanted(agent, reviewDefaultNow())
    let retry = null
    for (let attempt = 1; ; attempt++) {
      const result = await attemptOnce(t, agent, limits, retry)
      if (result === null || !isActive(t) || t.run !== run) return
      // A step that did not pass its check: blocked with options, never done.
      const failed = failedStepBlock(t.steps, t.outcomes)
      if (failed) { block(t, run, failed, { result }); return }
      if (!reviewed) {
        if (await verified(t, run, result)) finish(t, 'done', doneFields(agent, result))
        return
      }
      if (typeof t.costUsd === 'number') t.costBase = t.costUsd
      const verdict = await reviewOnce(t, agent, result, attempt)
      if (!verdict || t.run !== run) return
      if (verdict.pass) {
        note(t, 'review', `passed on attempt ${attempt}`)
        finish(t, 'done', doneFields(agent, result))
        return
      }
      note(t, 'review', `not accepted: ${verdict.reasons[0] ?? 'no reason given'}`)
      if (attempt >= MAX_REVIEW_ATTEMPTS) {
        finish(t, 'failed', { result, error: REVIEW_STOPS.failed(attempt, verdict.reasons) })
        return
      }
      retry = { attempt: attempt + 1, reasons: verdict.reasons, goal: retryGoal(t.goal, verdict.reasons, attempt + 1) }
      note(t, 'retry', `attempt ${attempt + 1} of ${MAX_REVIEW_ATTEMPTS}`)
      emit(t)
    }
  }

  /** Is the final check switched on now? A getter that throws counts as on. */
  const verifyNow = () => {
    try { return verify() !== false } catch { return true }
  }

  /**
   * The final check of a plain mission's result against its goal. Resolves
   * true when the task may end done. A result the verifier does not accept
   * blocks the mission with the reasons; a verifier that could not run lets
   * the result through marked as not verified, and says so on the board.
   */
  async function verified(t, run, result) {
    if (!planned(t) || typeof verifier !== 'function' || !verifyNow()) return true
    const live = () => isActive(t) && t.run === run
    note(t, 'verify', 'checking the result against the goal')
    emit(t)
    // What the check costs is added to what the run has spent.
    if (typeof t.costUsd === 'number') t.costBase = t.costUsd
    let verdict
    try {
      const view = snapshot(t)
      verdict = await verifier({ task: { id: t.id, title: t.title, goal: t.goal, steps: view.steps, log: t.log.map((l) => ({ ...l })) }, result, signal: t.abort.signal })
    } catch (err) {
      if (!live()) return false
      if (t.abort.signal.aborted) { finish(t, 'cancelled', { error: 'Cancelled.' }); return false }
      log.error?.('[jarvis] mission verify failed:', err?.message ?? err)
      t.verified = false
      note(t, 'verify', 'the result could not be checked, so it is not verified')
      return true
    }
    if (!live()) return false
    if (!verdict || typeof verdict.pass !== 'boolean') verdict = parseVerdict('')
    if (typeof verdict.costUsd === 'number') { spend(t, verdict.costUsd); t.costBase = t.costUsd }
    if (verdict.pass) {
      t.verified = true
      note(t, 'verify', 'the result meets the goal')
      return true
    }
    t.verified = false
    report(t, 'mission-verify-failed', 'the result did not meet the goal')
    block(t, run, verifyBlock(verdict.reasons), { result })
    return false
  }

  /** A new task in the queue; started as soon as the cap allows. */
  function enqueue({ title, goal, agent = null, depth = 1, parentId = null, team = null, scope = null, asked = null }) {
    const g = goal
    const t = {
      id: `t${randomUUID().slice(0, 8)}`,
      title: clip(title, 60) || clip(g, 60),
      goal: g,
      status: 'queued',
      steps: [],
      checks: [],
      outcomes: [],
      step: 0,
      note: '',
      log: [],
      result: '',
      error: '',
      costUsd: null,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      waiting: 0,
      question: null,
      tools: new Set(),
      abort: new AbortController(),
      ...(agent && { agentId: agent.id, agentName: agent.name }),
      // A schedule or an event may start a run below another (agent-triggers.mjs).
      depth: Number.isInteger(depth) && depth > 1 ? Math.min(depth, DEPTH_CEILING) : 1,
      ...(parentId && { parentId }),
      ...(team && { team }),
      children: 0, childCostUsd: 0, waiters: new Set(),
      calls: 0, usedMs: 0, runFrom: null, run: 0, resumed: 0, tokens: 0, extensions: 0,
      ...(normaliseScope(scope) && { scope: normaliseScope(scope) }),
      ...(pickAsked(asked) && { asked: pickAsked(asked) }),
    }
    tasks.set(t.id, t)
    note(t, 'queued', 'queued')
    emit(t)
    return t
  }

  const maxChildrenNow = () => (Number.isInteger(maxChildren) && maxChildren >= 1 ? maxChildren : MAX_CHILDREN)

  /** What a parent has left to share, from its budget and what it and its children spent. */
  const parentLeft = (p) => remainingBudget(p.limits, { calls: p.calls, startedAt: p.startedAt, costUsd: p.costUsd, childCostUsd: p.childCostUsd }, now())

  /** The agents a delegating definition may start, with their names. */
  function allowList(def) {
    return (Array.isArray(def?.delegate) ? def.delegate : []).map((id) => {
      let name = id
      try { if (agents?.has(id)) name = agents.get(id)?.name || id } catch { name = id }
      return { id, name }
    })
  }

  /** The run's agent definition, while it may still run; null otherwise. */
  function liveDefinition(t) {
    if (!t?.agentId) return null
    try { return agents?.isActive(t.agentId) === true ? agents.get(t.agentId) ?? null : null } catch { return null }
  }

  /** Start an agent from inside run `parent`. Every rule is checked here, every time. */
  function delegate(parent, { agent: who, goal, title } = {}) {
    if (!parent || !isActive(parent)) return { ok: false, reason: DELEGATION_REFUSALS.ended }
    const held = pauseReason()
    if (held) return { ok: false, reason: held }
    const def = liveDefinition(parent)
    if (!def) return { ok: false, reason: DELEGATION_REFUSALS.notDelegator }
    const may = mayDelegate(def, { depth: parent.depth, maxDepth })
    if (!may.ok) return { ok: false, reason: may.reason }
    const entries = allowList(def)
    const target = resolveAgent(entries, typeof who === 'string' ? who : '')
    if (!target) return { ok: false, reason: DELEGATION_REFUSALS.offList(entries.map((e) => e.name)) }
    if (parent.children >= maxChildrenNow()) return { ok: false, reason: DELEGATION_REFUSALS.children(maxChildrenNow()) }
    // With room for one, a parent waiting on its child would wait for ever.
    if (cap() < 2) return { ok: false, reason: DELEGATION_REFUSALS.cap }
    if (budgetSpent(parentLeft(parent))) return { ok: false, reason: DELEGATION_REFUSALS.noBudget }
    const g = clip(goal, 4000)
    if (!g) return { ok: false, reason: DELEGATION_REFUSALS.noGoal }
    let agent = null
    try { agent = agents.has(target.id) && agents.isActive(target.id) === true ? agents.get(target.id) : null } catch { agent = null }
    if (!agent) return { ok: false, reason: `The ${target.name} agent is not switched on.` }
    parent.children += 1
    const t = enqueue({ title, goal: g, agent, depth: parent.depth + 1, parentId: parent.id })
    note(parent, 'delegate', `started ${agent.name}`)
    emit(parent)
    pump()
    return { ok: true, task: snapshot(t) }
  }

  /** A child's state for the run that started it; with `wait` (ms, capped), once it ends or the wait runs out. */
  async function child(parent, { id, wait } = {}) {
    if (!parent) return { ok: false, reason: DELEGATION_REFUSALS.ended }
    const c = typeof id === 'string' ? tasks.get(id) : null
    if (!c || c.parentId !== parent.id) return { ok: false, reason: DELEGATION_REFUSALS.notChild }
    const ms = typeof wait === 'number' && Number.isFinite(wait) ? Math.min(Math.max(0, wait), MAX_WAIT_MS) : 0
    if (ms > 0 && isActive(c) && isActive(parent)) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); c.waiters.delete(done); parent.waiters.delete(done); resolve() }
        const timer = setTimeout(done, ms)
        timer.unref?.()
        c.waiters.add(done)
        parent.waiters.add(done)
      })
    }
    const v = snapshot(c)
    return {
      ok: true,
      task: {
        id: v.id, agent: v.agentName, status: v.status, percent: v.percent, note: v.note,
        ...(v.result && { result: v.result }), ...(v.error && { error: v.error }),
      },
    }
  }

  /** Resolves once task `c` has ended, or the run waiting on it has. */
  function untilEnded(parent, c) {
    if (!isActive(c) || !isActive(parent)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { c.waiters.delete(done); parent.waiters.delete(done); resolve() }
      c.waiters.add(done)
      parent.waiters.add(done)
    })
  }

  /** Start one member of a team run and wait for it to end. Returns the ended task, or null when the run has ended. */
  async function runMember(t, { agent, goal, title }) {
    const r = delegate(t, { agent, goal, title })
    if (!r.ok) {
      let name = agent
      try { name = agents?.get(agent)?.name || agent } catch { name = agent }
      finish(t, 'failed', { error: TEAM_STOPS.couldNotStart(name, r.reason) })
      return null
    }
    const c = tasks.get(r.task.id)
    await untilEnded(t, c)
    if (!isActive(t)) return null
    if (c.status !== 'done') {
      finish(t, 'failed', { error: TEAM_STOPS.memberFailed(c.agentName, c.status, c.error) })
      return null
    }
    return c
  }

  /**
   * A team run (agent-teams.mjs): each member in order through delegate(),
   * then the Reviewer, whose verdict decides how the task ends.
   */
  async function runTeam(t) {
    const preset = teamPreset(t.team)
    if (!preset) { finish(t, 'failed', { error: TEAM_STOPS.unknown(t.team) }); return }
    t.steps = teamPlan(preset)
    const members = []
    for (let i = 0; i < preset.steps.length; i++) {
      if (!isActive(t)) return
      t.step = i + 1
      t.note = `${preset.steps[i].label}`
      note(t, 'step', t.steps[i])
      emit(t)
      const c = await runMember(t, {
        agent: preset.steps[i].agent,
        goal: memberGoal(preset, i, { goal: t.goal, members }),
        title: memberTitle(preset, i, t.title),
      })
      if (!c) return
      members.push(memberRecord(snapshot(c)))
    }
    if (!isActive(t)) return
    t.step = preset.steps.length + 1
    t.note = 'Review'
    note(t, 'step', 'Review')
    emit(t)
    const result = teamResult(preset, members)
    let last = null
    try { last = agents?.get(preset.steps.at(-1).agent) ?? null } catch { last = null }
    const auto = last ? automaticChecks(last, result) : { checks: null }
    const c = await runMember(t, {
      agent: preset.reviewer,
      goal: reviewGoal(preset, { title: t.title, goal: t.goal, members, result, checks: auto.checks, ...(auto.clean && { clean: auto.clean }) }),
      title: memberTitle(preset, preset.steps.length, t.title),
    })
    if (!c) return
    const outcome = teamOutcome(c.result, result)
    note(t, 'review', outcome.verdict.pass ? 'the Reviewer accepted the result' : `not accepted: ${outcome.verdict.reasons[0] ?? 'no reason given'}`)
    finish(t, outcome.status, outcome.fields)
  }

  /**
   * Why a team could not run now, or null. Checked when it is asked for;
   * every member is checked again by delegate() as it starts.
   */
  function teamRefusal(preset, coord) {
    const may = mayDelegate(coord, { depth: 1, maxDepth })
    if (!may.ok) return may.reason
    if (cap() < 2) return DELEGATION_REFUSALS.cap
    if (teamSize(preset) > maxChildrenNow()) return TEAM_STOPS.children(preset, maxChildrenNow())
    const listed = new Set(allowList(coord).map((a) => a.id))
    for (const id of teamAgents(preset)) {
      let name = id
      let on = false
      try { name = agents.get(id)?.name || id; on = agents.has(id) && agents.isActive(id) === true } catch { on = false }
      if (!listed.has(id)) return TEAM_STOPS.notListed(preset, name)
      if (!on) return TEAM_STOPS.missing(preset, name)
    }
    return null
  }

  /** The delegation handle for a run that may delegate, as `runAgent` gets it; nothing otherwise. */
  function delegationFor(t, agent) {
    if (!mayDelegate(agent, { depth: t.depth, maxDepth }).ok) return null
    return {
      delegation: {
        start: (request) => delegate(t, request),
        check: (request) => child(t, request),
        agents: () => allowList(agent),
      },
    }
  }

  restore()

  return {
    /** Removes an ended task from the board and from disk. A live one is cancelled first by the owner, not here. */
    dismiss(id) {
      const t = tasks.get(id)
      if (!t) return { ok: false, reason: 'No such task.' }
      if (isOpen(t)) return { ok: false, reason: 'Cancel it first.' }
      forget(id)
      for (const send of listeners) send({ type: 'task_removed', id })
      return { ok: true }
    },
    spawn({ title, goal, agentId, depth, scope, limits: asked }) {
      const g = clip(goal, 4000)
      if (!g) return { ok: false, reason: 'A task needs a goal.' }
      const held = pauseReason()
      if (held) return { ok: false, reason: held }
      let agent = null
      if (agentId !== undefined && agentId !== null) {
        try { agent = typeof agentId === 'string' && agents?.has(agentId) ? agents.get(agentId) : null } catch { agent = null }
        if (!agent) return { ok: false, reason: 'There is no agent by that name.' }
        let on = false
        try { on = agents.isActive(agentId) === true } catch { on = false }
        if (!on) return { ok: false, reason: `The ${agent.name} agent is not switched on.` }
      }
      const t = enqueue({ title, goal: g, agent, depth, scope, asked })
      pump()
      return { ok: true, task: snapshot(t) }
    },
    /**
     * Start a team preset (agent-teams.mjs) on a goal: a Coordinator task
     * whose members run in order, then the Reviewer. Refused with a reason
     * the voice session can say when the team could not run now.
     */
    spawnTeam({ team, title, goal }) {
      const preset = teamPreset(team)
      if (!preset) return { ok: false, reason: TEAM_STOPS.unknown(team) }
      const g = clip(goal, 4000)
      if (!g) return { ok: false, reason: `What should the ${preset.name} do?` }
      const held = pauseReason()
      if (held) return { ok: false, reason: held }
      let coord = null
      try { coord = agents?.has(DELEGATOR) && agents.isActive(DELEGATOR) === true ? agents.get(DELEGATOR) : null } catch { coord = null }
      if (!coord) return { ok: false, reason: `The ${preset.name} needs the Coordinator agent, which is not switched on.` }
      const why = teamRefusal(preset, coord)
      if (why) return { ok: false, reason: why }
      const t = enqueue({ title: clip(title, 60) || clip(`${preset.name}: ${g}`, 60), goal: g, agent: coord, team: preset.id })
      pump()
      return { ok: true, task: snapshot(t) }
    },
    /** The owner's typed answer to a task's question. */
    answer(id, text) {
      const t = tasks.get(id)
      if (!t?.question) return { ok: false, reason: 'That task is not waiting for an answer.' }
      t.question.settle(clip(text, 2000))
      return { ok: true }
    },
    /**
     * Start an agent from inside a run (agent-delegation.mjs). Only the
     * Coordinator, only its `delegate` list, only to `maxDepth()`, at most
     * `maxChildren` per run, within the parent's budget.
     */
    delegate: (parentId, request) => delegate(tasks.get(parentId), request),
    /** A child's state, as the run that started it may see it; `wait` (ms) waits for it to end. */
    child: (parentId, request) => child(tasks.get(parentId), request),
    get: (id) => (tasks.has(id) ? snapshot(tasks.get(id)) : null),
    list: () => [...tasks.values()].map(snapshot),
    cancel(id) {
      const t = tasks.get(id)
      if (!t) return { ok: false, reason: 'No such task.' }
      if (!isOpen(t)) return { ok: false, reason: 'That task has already ended.' }
      t.abort.abort()
      finish(t, 'cancelled', { error: 'Cancelled.' })
      return { ok: true }
    },
    /**
     * Stop a task's session but keep the task to resume later. Its children
     * end (a child never outlives the run that started it); its plan, log and
     * what it has spent stay. Refused for a task another agent started and
     * for a team run.
     */
    pause(id) {
      const t = tasks.get(id)
      if (!t) return { ok: false, reason: PAUSE_REFUSALS.missing }
      if (t.status === 'paused') return { ok: false, reason: PAUSE_REFUSALS.already }
      if (!isActive(t)) return { ok: false, reason: PAUSE_REFUSALS.ended }
      if (t.parentId) return { ok: false, reason: PAUSE_REFUSALS.child }
      if (t.team) return { ok: false, reason: PAUSE_REFUSALS.team }
      hold(t, 'paused', 'Paused by the owner.')
      return { ok: true, task: snapshot(t) }
    },
    /**
     * Queue a paused or blocked task again. Its new session starts from the
     * goal and what the board recorded (for a blocked one, also why it stopped
     * and the owner's `choice`), within what is left of its budget. Refused
     * while background work is paused or when its agent is no longer on.
     */
    resume(id, { choice } = {}) {
      const t = tasks.get(id)
      if (!t) return { ok: false, reason: PAUSE_REFUSALS.missing }
      if (!isHeld(t)) return { ok: false, reason: isActive(t) ? PAUSE_REFUSALS.notPaused : PAUSE_REFUSALS.ended }
      const held = pauseReason()
      if (held) return { ok: false, reason: held }
      if (!agentStillActive(t)) return { ok: false, reason: `The ${t.agentName} agent is not switched on.` }
      t.status = 'queued'
      t.abort = new AbortController()
      t.tools = new Set()
      t.waiting = 0
      t.question = null
      t.planAsk = null
      t.note = ''
      t.resumed = (t.resumed ?? 0) + 1
      if (t.blocked) {
        // The next run is told why this one stopped and what the owner picked.
        // Picking an option never approves a plan: that is still asked on its card.
        t.handoff = { reason: t.blocked.reason, choice: pickChoice(t.blocked, choice) }
        t.blocked = null
        // A failed check is the old run's; the new run checks its steps again.
        t.outcomes = (t.outcomes ?? []).map((o) => (o && o.passed ? o : null))
        delete t.verified
      }
      note(t, 'resumed', `resumed by the owner${t.handoff?.choice ? `: ${t.handoff.choice}` : ''}`)
      emit(t)
      pump()
      return { ok: true, task: snapshot(t) }
    },
    cancelAll() {
      for (const t of tasks.values()) if (isActive(t)) { t.abort.abort(); finish(t, 'cancelled', { error: 'Cancelled.' }) }
    },
    /** Apply changed agent settings or the kill switch at once (see refresh above). */
    refresh,
    /** A connected browser receives every task now and every change after. */
    subscribe(send) {
      listeners.add(send)
      for (const t of tasks.values()) send({ type: 'task', task: snapshot(t) })
      return () => listeners.delete(send)
    },
  }
}
