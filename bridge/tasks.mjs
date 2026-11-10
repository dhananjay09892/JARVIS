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
 * Only background tasks live here. The voice session is not a task, so the
 * cap and the pause never hold it back.
 */
import { randomUUID } from 'node:crypto'
import { BUDGET_STOPS, AGENT_REFUSALS } from './agent-runtime.mjs'
import { MAX_REVIEW_ATTEMPTS, REVIEW_STOPS, automaticChecks, parseVerdict, retryGoal, reviewWanted } from './agent-review.mjs'
import {
  DELEGATION_REFUSALS, DELEGATION_STOPS, DELEGATOR_ID as DELEGATOR, MAX_CHILDREN, MAX_WAIT_MS, DEPTH_CEILING, budgetSpent, mayDelegate,
  remainingBudget, shareBudget,
} from './agent-delegation.mjs'
import { resolveAgent } from './agent-ask.mjs'
import { isDraftAgent, readDraft } from './agent-draft-result.mjs'
import { isAlertAgent, readTriage } from './agent-triage-result.mjs'
import { isMemoryReviewAgent, readMemoryReview } from './agent-memory-review.mjs'
import {
  TEAM_STOPS, memberGoal, memberRecord, memberTitle, reviewGoal, teamAgents, teamOutcome, teamPlan, teamPreset, teamResult, teamSize,
} from './agent-teams.mjs'

export const MAX_CONCURRENT = 3
/** The cap is a setting from 1 to 8 (agent-settings.mjs); anything else falls back to the default. */
const CAP_MAX = 8
const MAX_KEPT = 50
const MAX_LOG = 40
const MAX_STEPS = 12
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

const ACTIVE = new Set(['queued', 'running', 'waiting_approval', 'waiting_input'])
export const ANSWER_TTL_MS = 30 * 60 * 1000
export const isActive = (task) => ACTIVE.has(task.status)

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
    steps: t.steps.map((s, i) => ({ label: s, state: i < t.step - 1 ? 'done' : i === t.step - 1 ? 'active' : 'todo' })),
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
    ...(t.depth > 1 && { depth: t.depth }),
    ...(t.parentId && { parentId: t.parentId }),
    ...(t.team && { team: { id: t.team, name: teamPreset(t.team)?.name ?? t.team } }),
  }
}

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
 */
export function createTaskManager({
  runAgent, store = null, bus = null, agents = null, costCounts = () => false,
  concurrency = MAX_CONCURRENT, paused = () => null, defaultBudget = () => null,
  reviewer = null, reviewDefault = () => false, maxDepth = () => 1, maxChildren = MAX_CHILDREN,
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
        step: s.steps.filter((x) => x.state === 'done').length + 1, note: s.note, log: s.log, result: s.result,
        error: s.error, costUsd: s.costUsd, startedAt: s.startedAt, endedAt: s.endedAt, createdAt: s.createdAt ?? s.startedAt ?? now(),
        waiting: 0, question: null, tools: new Set(), abort: new AbortController(),
        ...(typeof s.agentId === 'string' && s.agentId && { agentId: s.agentId, agentName: clip(s.agentName, 60) || s.agentId }),
        depth: Number.isInteger(s.depth) && s.depth > 1 ? s.depth : 1,
        ...(typeof s.parentId === 'string' && s.parentId && { parentId: s.parentId }),
        ...(teamPreset(s.team?.id) && { team: teamPreset(s.team.id).id }),
        children: 0, childCostUsd: 0, waiters: new Set(),
      }
      if (ACTIVE.has(t.status)) {
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
    const finished = [...tasks.values()].filter((t) => !isActive(t))
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
   * (agent-memory-review.mjs, the Memory Curator), its memory proposals.
   * Reading any of them sends, saves or changes nothing.
   */
  function doneFields(agent, result) {
    const draft = isDraftAgent(agent) ? readDraft(result) : null
    const triage = isAlertAgent(agent) ? readTriage(result) : null
    const memoryReview = isMemoryReviewAgent(agent) ? readMemoryReview(result) : null
    return { result, ...(draft && { draft }), ...(triage && { triage }), ...(memoryReview && { memoryReview }) }
  }

  function finish(t, status, fields = {}) {
    if (!isActive(t)) return
    if (t.timer) { clearTimeout(t.timer); t.timer = null }
    // Release a parked question first, while the task still counts as active.
    t.question?.settle(null)
    Object.assign(t, fields, { status, endedAt: now() })
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
  const reporter = (t) => (p) => {
    if (!isActive(t)) return { ok: false, reason: 'This task has ended.' }
    if (Array.isArray(p.plan) && p.plan.length) {
      t.steps = p.plan.map((s) => clip(s, 80)).filter(Boolean).slice(0, MAX_STEPS)
      t.step = 1
      note(t, 'plan', `${t.steps.length} steps`)
    }
    if (Number.isInteger(p.step) && t.steps.length) {
      t.step = Math.min(Math.max(1, p.step), t.steps.length)
      note(t, 'step', t.steps[t.step - 1])
    }
    if (typeof p.note === 'string' && p.note.trim()) {
      t.note = clip(p.note, 160)
      note(t, 'note', t.note)
    }
    emit(t)
    return { ok: true }
  }

  /** Wraps an approval so the card names the task and the task shows it is waiting. */
  const approver = (t, approve) => async (title, details) => {
    if (!isActive(t)) return false
    t.waiting += 1
    t.status = 'waiting_approval'
    note(t, 'approval', title)
    emit(t)
    try {
      const who = t.agentName ? ` (${t.agentName})` : ''
      return await approve(`Task "${t.title}"${who}: ${title}`, details)
    } finally {
      t.waiting -= 1
      if (t.status === 'waiting_approval' && t.waiting === 0) t.status = t.question ? 'waiting_input' : 'running'
      emit(t)
    }
  }

  /** Lets the agent put one question to the owner and wait for the typed answer. */
  const asker = (t) => (text) => {
    const q = clip(text, 500)
    if (!isActive(t) || t.question || !q) return Promise.resolve(null)
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
  const stopper = (t) => (reason) => {
    if (!isActive(t)) return
    t.abort.abort()
    finish(t, 'failed', { error: reason })
  }

  /** The budget the session's guard spends from; null without one. */
  function budgetFor(t, limits) {
    if (!Number.isInteger(limits?.maxToolCalls)) return null
    return {
      /** One tool call is about to run. Returns null to let it, or the refusal. */
      toolCall() {
        if (!isActive(t)) return AGENT_REFUSALS.budget
        if (t.calls >= limits.maxToolCalls) {
          stopper(t)(BUDGET_STOPS.toolCalls(limits.maxToolCalls))
          return AGENT_REFUSALS.budget
        }
        // A child spends from its parent's tool calls as it goes, so the
        // children of one run share what that run has, not each a copy.
        const parent = t.parentId ? tasks.get(t.parentId) : null
        if (parent && Number.isInteger(parent.limits?.maxToolCalls)) {
          if (!isActive(parent) || parent.calls >= parent.limits.maxToolCalls) {
            stopper(t)(DELEGATION_STOPS.parentBudget)
            return AGENT_REFUSALS.budget
          }
          parent.calls += 1
        }
        t.calls += 1
        return null
      },
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
    try {
      const task = snapshot(t)
      const stream = runAgent({
        task: retry ? { ...task, goal: retry.goal } : task,
        signal: t.abort.signal,
        report: reporter(t),
        ask: asker(t),
        wrapApprove: (approve) => approver(t, approve),
        ...(agent && { agent, budget: budgetFor(t, limits), stop: stopper(t) }),
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
        if (!isActive(t)) break
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
            if (typeof limits?.maxCostUsd === 'number' && typeof t.costUsd === 'number' && t.costUsd > limits.maxCostUsd) {
              let billed = false
              try { billed = costCounts(agent) === true } catch { billed = false }
              if (billed) stopper(t)(BUDGET_STOPS.cost(limits.maxCostUsd))
            }
            break
          case 'error':
            failure = e
            break
          case 'done':
            if (e.reason === 'complete') return isActive(t) ? clip(reply, 1200) : null
            if (e.reason === 'cancelled' || t.abort.signal.aborted) finish(t, 'cancelled', { error: 'Cancelled.' })
            else {
              log.error?.('[jarvis] task failed:', failure?.message ?? failure?.code ?? e.reason)
              finish(t, 'failed', { error: failureText(failure) })
            }
            return null
        }
      }
      // A stream that ends with no result and no cancel is a failure, not a success.
      if (isActive(t)) finish(t, 'failed', { error: 'The agent ended without a result.' })
      return null
    } catch (err) {
      if (t.abort.signal.aborted) finish(t, 'cancelled', { error: 'Cancelled.' })
      else {
        log.error?.('[jarvis] task failed:', err)
        finish(t, 'failed', { error: clip(String(err?.message ?? err), 300) })
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
      if (!isActive(t)) return null
      if (t.abort.signal.aborted) { finish(t, 'cancelled', { error: 'Cancelled.' }); return null }
      log.error?.('[jarvis] review failed:', err?.message ?? err)
      finish(t, 'failed', { result, error: REVIEW_STOPS.unavailable(clip(String(err?.message ?? ''), 120)) })
      return null
    }
    if (!isActive(t)) return null
    if (!verdict || typeof verdict.pass !== 'boolean') verdict = parseVerdict('')
    if (typeof verdict.costUsd === 'number') { spend(t, verdict.costUsd); t.costBase = t.costUsd }
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => clip(r, 300)) : []
    return { pass: verdict.pass, reasons }
  }

  async function start(t) {
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
    let limits = agent ? budgetOf(agent) : null
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
      limits = shareBudget(limits, left)
    }
    t.limits = limits
    t.status = 'running'
    t.startedAt = now()
    t.calls = 0
    t.costBase = 0
    note(t, 'start', agent ? `started as ${agent.name}` : 'started')
    emit(t)
    if (limits && typeof limits.maxMinutes === 'number' && limits.maxMinutes > 0) {
      t.timer = setTimeout(() => stopper(t)(BUDGET_STOPS.minutes(limits.maxMinutes)), limits.maxMinutes * 60_000)
      t.timer.unref?.()
    }
    if (t.team) { await runTeam(t); return }
    // Only a named agent is reviewed, and only when its file or the owner's
    // default asks for it. The budget covers every attempt together.
    const reviewed = Boolean(agent) && typeof reviewer === 'function' && reviewWanted(agent, reviewDefaultNow())
    let retry = null
    for (let attempt = 1; ; attempt++) {
      const result = await attemptOnce(t, agent, limits, retry)
      if (result === null || !isActive(t)) return
      if (!reviewed) { finish(t, 'done', doneFields(agent, result)); return }
      if (typeof t.costUsd === 'number') t.costBase = t.costUsd
      const verdict = await reviewOnce(t, agent, result, attempt)
      if (!verdict) return
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

  /** A new task in the queue; started as soon as the cap allows. */
  function enqueue({ title, goal, agent = null, depth = 1, parentId = null, team = null }) {
    const g = goal
    const t = {
      id: `t${randomUUID().slice(0, 8)}`,
      title: clip(title, 60) || clip(g, 60),
      goal: g,
      status: 'queued',
      steps: [],
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
      if (isActive(t)) return { ok: false, reason: 'Cancel it first.' }
      forget(id)
      for (const send of listeners) send({ type: 'task_removed', id })
      return { ok: true }
    },
    spawn({ title, goal, agentId, depth }) {
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
      const t = enqueue({ title, goal: g, agent, depth })
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
      if (!isActive(t)) return { ok: false, reason: 'That task has already ended.' }
      t.abort.abort()
      finish(t, 'cancelled', { error: 'Cancelled.' })
      return { ok: true }
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
