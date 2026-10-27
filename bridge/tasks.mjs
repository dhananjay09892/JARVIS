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
 */
import { randomUUID } from 'node:crypto'

export const MAX_CONCURRENT = 3
const MAX_KEPT = 50
const MAX_LOG = 40
const MAX_STEPS = 12
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

const ACTIVE = new Set(['queued', 'running', 'waiting_approval', 'waiting_input'])
export const ANSWER_TTL_MS = 30 * 60 * 1000
export const isActive = (task) => ACTIVE.has(task.status)

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
  }
}

export function createTaskManager({ runAgent, store = null, bus = null, concurrency = MAX_CONCURRENT, now = () => Date.now(), log = console } = {}) {
  const tasks = new Map()
  const listeners = new Set()

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
    for (const t of tasks.values()) {
      if (running() >= concurrency) return
      if (t.status === 'queued') start(t)
    }
  }

  function finish(t, status, fields = {}) {
    if (!isActive(t)) return
    // Release a parked question first, while the task still counts as active.
    t.question?.settle(null)
    Object.assign(t, fields, { status, endedAt: now() })
    if (status === 'done') t.step = t.steps.length + 1
    note(t, status, fields.error ?? fields.result ?? status)
    emit(t)
    announce(t)
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
      return await approve(`Task "${t.title}": ${title}`, details)
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

  async function start(t) {
    t.status = 'running'
    t.startedAt = now()
    note(t, 'start', 'started')
    emit(t)
    try {
      const stream = runAgent({
        task: snapshot(t),
        signal: t.abort.signal,
        report: reporter(t),
        ask: asker(t),
        wrapApprove: (approve) => approver(t, approve),
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
            if (e.costUsd !== undefined) t.costUsd = e.costUsd
            break
          case 'error':
            failure = e
            break
          case 'done':
            if (e.reason === 'complete') finish(t, 'done', { result: clip(reply, 1200) })
            else if (e.reason === 'cancelled' || t.abort.signal.aborted) finish(t, 'cancelled', { error: 'Cancelled.' })
            else {
              log.error?.('[jarvis] task failed:', failure?.message ?? failure?.code ?? e.reason)
              finish(t, 'failed', { error: failureText(failure) })
            }
            break
        }
      }
      // A stream that ends with no result and no cancel is a failure, not a success.
      if (isActive(t)) finish(t, 'failed', { error: 'The agent ended without a result.' })
    } catch (err) {
      if (t.abort.signal.aborted) finish(t, 'cancelled', { error: 'Cancelled.' })
      else {
        log.error?.('[jarvis] task failed:', err)
        finish(t, 'failed', { error: clip(String(err?.message ?? err), 300) })
      }
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
    spawn({ title, goal }) {
      const g = clip(goal, 4000)
      if (!g) return { ok: false, reason: 'A task needs a goal.' }
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
      }
      tasks.set(t.id, t)
      note(t, 'queued', 'queued')
      emit(t)
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
    /** A connected browser receives every task now and every change after. */
    subscribe(send) {
      listeners.add(send)
      for (const t of tasks.values()) send({ type: 'task', task: snapshot(t) })
      return () => listeners.delete(send)
    },
  }
}
