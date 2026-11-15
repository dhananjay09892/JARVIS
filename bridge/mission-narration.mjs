/**
 * Progress narration and mission metrics (plan 13 phase 5; task Q92).
 *
 * The task manager (tasks.mjs) sends a frame to its listeners on every change.
 * `createNarrator` watches those frames for plain missions and turns the few
 * moments worth a word into `Notification`s (shared/contracts.ts) for the
 * notification policy (notify-policy.mjs). The policy, not this module,
 * decides whether a notification is said, shown or held: it speaks only when
 * the owner is idle and outside quiet hours, shows it silently in a
 * conversation, and holds it in a meeting or asleep. Nothing here grants
 * anything or talks on its own.
 *
 * Moments, per mission:
 *   - a step passed its check          (mode "milestones" only; at most one per
 *                                       `MIN_GAP_MS`, at most `MAX_STEP_UPDATES`,
 *                                       never for the last step, and it expires
 *                                       after `STEP_EXPIRES_MS` so a stale update
 *                                       is dropped, not read out later)
 *   - the mission is blocked           (modes "milestones" and "done"; the reason
 *                                       and the owner's options)
 *   - the mission finished or failed   (modes "milestones" and "done"; a short summary)
 *
 * Mode "off" says nothing. A cancelled or interrupted mission says nothing.
 * Named agents, delegated children and team runs are not narrated here: a
 * scheduled agent already reports through its own alert (agent-schedule.mjs).
 *
 * The first frame seen for a mission is its baseline: a mission that is
 * already over or held when the narrator starts (the replay a new listener
 * gets) is never narrated, so a restart does not read out old news.
 *
 * `missionMetrics` is the Diagnostics view (plan 16): counts and rates over
 * the missions the task manager still holds. Numbers only, never a title,
 * goal or result.
 */

export const NARRATE_MODES = Object.freeze(['milestones', 'done', 'off'])
export const MIN_GAP_MS = 2 * 60_000
export const MAX_STEP_UPDATES = 3
export const STEP_EXPIRES_MS = 10 * 60_000

const clip = (s, n) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, n) : '')
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted'])

/** The owner's narration mode from the setting; anything unknown is the default. */
export function narrateMode(value) {
  return NARRATE_MODES.includes(value) ? value : 'milestones'
}

/** A plain mission: not a named agent, a delegated child or a team run. */
export const isPlainMission = (t) => !t.agentId && !t.parentId && !t.team

const passedCount = (t) => (Array.isArray(t.steps) ? t.steps.filter((s) => s.outcome === 'passed').length : 0)

function notification(t, kind, at, urgency, title, body, extra = {}) {
  return {
    v: 1,
    id: `mission-${t.id}-${kind}`,
    ts: at,
    source: 'mission',
    urgency,
    audience: ['owner'],
    privacy: 'private',
    title: clip(title, 120) || 'Mission update',
    body: clip(body, 300),
    ...extra,
  }
}

/**
 * @param {object} o
 * @param {(n: object) => void} o.notify raises an alert (notifier.submit)
 * @param {() => string} [o.mode] the narration setting, read on every frame
 * @param {() => number} [o.now]
 */
export function createNarrator({ notify, mode = () => 'milestones', now = () => Date.now() } = {}) {
  if (typeof notify !== 'function') throw new TypeError('The narrator needs a notify function.')
  /** task id → { status, passed, lastStepAt, steps, blocks } */
  const seen = new Map()
  const counts = { step: 0, blocked: 0, finished: 0, skipped: 0 }

  const current = () => {
    try { return narrateMode(mode()) } catch { return 'milestones' }
  }

  const raise = (n, kind) => {
    counts[kind] += 1
    try { notify(n) } catch { /* an alert that cannot be raised must never stop a mission */ }
  }

  return {
    /** Feed every frame the task manager sends (`taskManager.subscribe`). */
    observe(frame) {
      if (frame?.type === 'task_removed') {
        seen.delete(frame.id)
        return
      }
      const t = frame?.type === 'task' ? frame.task : null
      if (!t || typeof t.id !== 'string' || !isPlainMission(t)) return
      const at = now()
      const before = seen.get(t.id)
      const passed = passedCount(t)
      if (!before) {
        // Baseline. A mission already ended or held was not narrated by this process.
        const held = t.status === 'blocked' || t.status === 'paused'
        seen.set(t.id, { status: t.status, passed, lastStepAt: -Infinity, steps: 0, blocks: held && t.status === 'blocked' ? 1 : 0, over: TERMINAL.has(t.status) })
        return
      }
      const m = current()
      const status = t.status
      const was = before.status
      before.status = status

      if (status === 'blocked' && was !== 'blocked') {
        before.blocks += 1
        if (m !== 'off') {
          const options = Array.isArray(t.blocked?.options) ? t.blocked.options.map((o) => clip(o, 80)).filter(Boolean) : []
          const body = `${clip(t.blocked?.reason, 160) || 'It could not go on.'}${options.length ? ` Options: ${options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join('; ')}.` : ''}`
          raise(notification(t, `blocked-${before.blocks}`, at, 'important', `"${clip(t.title, 60)}" is blocked`, body), 'blocked')
        }
        return
      }

      if ((status === 'done' || status === 'failed') && !before.over) {
        before.over = true
        if (m !== 'off') {
          const ok = status === 'done'
          raise(notification(
            t, 'end', at, 'important',
            ok ? `"${clip(t.title, 60)}" is done` : `"${clip(t.title, 60)}" could not finish`,
            ok ? t.result : t.error,
          ), 'finished')
        }
        return
      }
      if (TERMINAL.has(status)) {
        before.over = true
        return
      }
      if (status !== 'running' && status !== 'waiting_approval' && status !== 'waiting_input') {
        before.passed = Math.max(before.passed, passed)
        return
      }

      if (passed > before.passed) {
        const total = Array.isArray(t.steps) ? t.steps.length : 0
        const idx = passed
        before.passed = passed
        if (m !== 'milestones' || idx >= total) return
        if (before.steps >= MAX_STEP_UPDATES || at - before.lastStepAt < MIN_GAP_MS) {
          counts.skipped += 1
          return
        }
        before.steps += 1
        before.lastStepAt = at
        const label = t.steps[idx - 1]?.label
        raise(notification(
          t, `step-${idx}`, at, 'important',
          `"${clip(t.title, 60)}": step ${idx} of ${total} done`,
          label,
          { expiresAt: at + STEP_EXPIRES_MS },
        ), 'step')
      }
    },
    /** What was narrated since start: counts only. */
    stats() {
      return { tracked: seen.size, ...counts }
    },
  }
}

/**
 * Success rate, how often help was needed and cost per mission, over task
 * snapshots (tasks.mjs `list()`). Delegated children are left out so a team
 * run counts once. Only finished missions (done or failed) enter the rates.
 *
 * "Help needed" is a mission that was ever blocked (it carries a hand-off or
 * is blocked now) or asked the owner for an approval or an answer.
 */
export function missionMetrics(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && !t.parentId)
  const done = list.filter((t) => t.status === 'done').length
  const failed = list.filter((t) => t.status === 'failed').length
  const finished = done + failed
  const needsHelp = (t) => Boolean(t.blocked || t.handoff) || (Array.isArray(t.log) && t.log.some((l) => l?.kind === 'approval' || l?.kind === 'question' || l?.kind === 'mission-blocked'))
  const helped = list.filter((t) => (t.status === 'done' || t.status === 'failed') && needsHelp(t)).length
  const costs = list.filter((t) => (t.status === 'done' || t.status === 'failed') && typeof t.costUsd === 'number' && t.costUsd >= 0).map((t) => t.costUsd)
  return {
    missions: list.length,
    open: list.filter((t) => !TERMINAL.has(t.status)).length,
    done,
    failed,
    cancelled: list.filter((t) => t.status === 'cancelled').length,
    ...(finished > 0 && { successRate: done / finished, helpRate: helped / finished }),
    ...(costs.length > 0 && { avgCostUsd: costs.reduce((a, b) => a + b, 0) / costs.length }),
  }
}
