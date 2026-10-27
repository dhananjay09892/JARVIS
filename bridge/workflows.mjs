/**
 * Workflows: stored recipes JARVIS can propose and run, on demand or daily.
 *
 * What a workflow is allowed to be is deliberately narrow. Steps are structured
 * tool calls, not free text, and come in two kinds:
 *
 *   read    read_file, list_files — inside the workspace rules, run without asking
 *   action  run_command, push_branch — ALWAYS ask, on every run
 *
 * Two approvals stand between a workflow and your machine, and neither can be
 * bypassed by the other:
 *
 *   1. Changing the stored recipe (create / edit / delete by the model) shows
 *      you the full recipe on a card first.
 *   2. Every action step of every run — scheduled or not — shows the exact
 *      command on a card. A workflow cannot pre-approve its own steps and no
 *      approval is remembered. If nobody is there, the run waits; when the
 *      request expires it is rejected, not skipped past.
 *
 * Memory is not consulted here, and a workflow's definition grants nothing.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { approvedCommand } from './development.mjs'
import { redact, defaultMemoryDir } from './memory.mjs'

export const STEP_KINDS = { read_file: 'read', list_files: 'read', run_command: 'action', push_branch: 'action' }
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
const MAX_STEPS = 20

const REMOTE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/
const str = (v) => (typeof v === 'string' ? v : '')

/** The PowerShell for a push step — identical to the push_branch tool. */
export const pushCommand = (s) => `git push '${s.remote}' 'HEAD:${s.branch}'`

/** Validates and normalises a workflow. Never trusts the caller's shape. */
export function validateWorkflow(input) {
  const name = str(input?.name).trim()
  if (!name || name.length > 60) return { ok: false, reason: 'Name must be 1–60 characters.' }
  const description = str(input?.description).trim().slice(0, 500)
  let scheduleTime = input?.scheduleTime ?? null
  if (scheduleTime !== null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(str(scheduleTime))) return { ok: false, reason: 'Schedule must be a 24-hour local time like 08:30.' }
  }
  const raw = input?.steps
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) return { ok: false, reason: `A workflow needs 1–${MAX_STEPS} steps.` }
  const steps = []
  for (const [i, s] of raw.entries()) {
    const kind = STEP_KINDS[s?.type]
    const at = `Step ${i + 1}`
    if (!kind) return { ok: false, reason: `${at}: type must be one of ${Object.keys(STEP_KINDS).join(', ')}.` }
    const label = str(s.label).trim().slice(0, 80)
    if (s.type === 'read_file') {
      if (!str(s.path)) return { ok: false, reason: `${at}: path is required.` }
      steps.push({ type: s.type, path: str(s.path), label })
    } else if (s.type === 'list_files') {
      steps.push({ type: s.type, path: str(s.path) || '.', label })
    } else if (s.type === 'run_command') {
      const command = str(s.command)
      if (!str(s.cwd) || !command.trim() || command.length > 8000) return { ok: false, reason: `${at}: cwd and a command up to 8000 characters are required.` }
      steps.push({ type: s.type, cwd: str(s.cwd), command, label })
    } else {
      if (!str(s.cwd) || !REMOTE.test(str(s.remote)) || !BRANCH.test(str(s.branch))) return { ok: false, reason: `${at}: cwd, a valid remote and a valid branch are required.` }
      steps.push({ type: s.type, cwd: str(s.cwd), remote: s.remote, branch: s.branch, label })
    }
  }
  return { ok: true, value: { name, description, scheduleTime, enabled: input?.enabled !== false, steps } }
}

/** What the approval card shows for a recipe. Action steps are marked loudly. */
export function describeWorkflow(w) {
  const lines = [
    `Name: ${w.name}`,
    w.description ? `About: ${w.description}` : null,
    `Schedule: ${w.scheduleTime ? `daily at ${w.scheduleTime} local time, while JARVIS is running` : 'manual only'}${w.enabled === false ? ' (disabled)' : ''}`,
    '',
    'Steps:',
  ].filter((l) => l !== null)
  w.steps.forEach((s, i) => {
    const what = s.type === 'read_file' ? `read file ${s.path}`
      : s.type === 'list_files' ? `list folder ${s.path}`
      : s.type === 'run_command' ? `in ${s.cwd}: ${s.command}`
      : `in ${s.cwd}: ${pushCommand(s)}`
    lines.push(`${i + 1}. [${STEP_KINDS[s.type] === 'action' ? 'ACTION — asks every run' : 'read only'}] ${what}`)
  })
  lines.push('', 'Approving this saves the recipe only. Every ACTION step will still ask for its own approval each time it runs.')
  return lines.join('\n')
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Due when its time has passed today and it has not been started today. */
export function isDue(workflow, lastScheduledDay, d = new Date()) {
  if (!workflow.enabled || !workflow.scheduleTime) return false
  const [h, m] = workflow.scheduleTime.split(':').map(Number)
  return d.getHours() * 60 + d.getMinutes() >= h * 60 + m && lastScheduledDay !== localDay(d)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function openWorkflows({ file, dir = defaultMemoryDir() } = {}) {
  let path = file
  if (!path) {
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'jarvis-workflows.sqlite')
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      schedule_time TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      workflow_name TEXT NOT NULL,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','schedule')),
      day TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','waiting_approval','completed','failed','interrupted')),
      steps TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_wf ON runs(workflow_id, started_at);
  `)
  const now = () => new Date().toISOString()
  const row = (r) => r && ({
    id: r.id, name: r.name, description: r.description, scheduleTime: r.schedule_time, enabled: r.enabled === 1,
    steps: JSON.parse(r.steps), createdAt: r.created_at, updatedAt: r.updated_at,
  })
  const runRow = (r) => ({
    id: r.id, workflowId: r.workflow_id, workflow: r.workflow_name, trigger: r.trigger_kind, status: r.status,
    steps: JSON.parse(r.steps), startedAt: r.started_at, finishedAt: r.finished_at,
  })

  // A run cannot outlive the process that was running it.
  db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status IN ('running','waiting_approval')").run(now())

  return {
    path,
    close() { db.close() },
    list: () => db.prepare('SELECT * FROM workflows ORDER BY name').all().map(row),
    get: (idOrName) => row(db.prepare('SELECT * FROM workflows WHERE id = ? OR name = ?').get(idOrName, idOrName)) ?? null,
    create(v) {
      const id = `wf-${randomUUID()}`
      const t = now()
      db.prepare('INSERT INTO workflows (id, name, description, schedule_time, enabled, steps, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, v.name, v.description, v.scheduleTime, v.enabled ? 1 : 0, JSON.stringify(v.steps), t, t)
      return id
    },
    update(id, v) {
      const r = db.prepare('UPDATE workflows SET name=?, description=?, schedule_time=?, enabled=?, steps=?, updated_at=? WHERE id=?')
        .run(v.name, v.description, v.scheduleTime, v.enabled ? 1 : 0, JSON.stringify(v.steps), now(), id)
      return Number(r.changes) > 0
    },
    setEnabled(id, enabled) { return Number(db.prepare('UPDATE workflows SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, now(), id).changes) > 0 },
    remove(id) { return Number(db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes) > 0 },

    startRun(w, trigger, day = localDay(new Date())) {
      const id = `run-${randomUUID()}`
      const steps = w.steps.map((s, i) => ({ index: i + 1, type: s.type, status: 'pending', detail: '' }))
      db.prepare('INSERT INTO runs (id, workflow_id, workflow_name, trigger_kind, day, status, steps, started_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, w.id, w.name, trigger, day, 'running', JSON.stringify(steps), now())
      return { id, steps }
    },
    saveRun(id, status, steps, finished = false) {
      db.prepare('UPDATE runs SET status=?, steps=?, finished_at=? WHERE id=?').run(status, JSON.stringify(steps), finished ? now() : null, id)
    },
    runs(workflowId, limit = 10) {
      const rows = workflowId
        ? db.prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?').all(workflowId, limit)
        : db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit)
      return rows.map(runRow)
    },
    lastScheduledDay(workflowId) {
      return db.prepare("SELECT day FROM runs WHERE workflow_id = ? AND trigger_kind = 'schedule' ORDER BY started_at DESC LIMIT 1").get(workflowId)?.day ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// Approvals that outlive a single socket
// ---------------------------------------------------------------------------

/**
 * Approval cards for runs nobody is watching. Unlike the per-connection queue,
 * a request stays pending when no browser is open and is shown to the first one
 * that connects. It is still one-shot, still needs approved === true, and a
 * request that expires resolves false.
 */
export function createApprovalHub({ ttlMs = APPROVAL_TTL_MS } = {}) {
  const pending = new Map()
  const listeners = new Set()
  const broadcast = (frame) => { for (const send of listeners) send(frame) }
  const frame = (id, p) => ({ type: 'approval', id, approvalId: id, title: p.title, details: p.details, expiresInSec: Math.round(ttlMs / 1000) })
  const settle = (id, approved) => {
    const p = pending.get(id)
    if (!p) return false
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(approved === true)
    broadcast({ type: 'approval_closed', approvalId: id })
    return true
  }
  return {
    request(title, details) {
      const id = `wfapproval-${randomUUID()}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, false), ttlMs)
        timer.unref?.()
        const p = { title, details, resolve, timer }
        pending.set(id, p)
        broadcast(frame(id, p))
      })
    },
    reply: (id, approved) => settle(id, approved),
    /** A connected browser receives everything still waiting. Returns a detach function. */
    attach(send) {
      listeners.add(send)
      for (const [id, p] of pending) send(frame(id, p))
      return () => listeners.delete(send)
    },
    cancelAll() { for (const id of [...pending.keys()]) settle(id, false) },
    count: () => pending.size,
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Runs workflows and, with `start()`, is the bridge's scheduler. With a `bus`
 * (bus.mjs, plan 12) every run publishes `workflow.started` and
 * `workflow.finished`: names, trigger and step counts only, never a step's
 * command, path or output.
 */
export function createEngine({ store, files, approve, execute, bus = null, log = console, clock = () => new Date() }) {
  const active = new Set()

  async function run(workflow, trigger) {
    if (active.has(workflow.id)) return { ok: false, reason: 'That workflow is already running.' }
    active.add(workflow.id)
    const { id, steps } = store.startRun(workflow, trigger, localDay(clock()))
    const save = (status, finished) => store.saveRun(id, status, steps, finished)
    const startedAt = clock().getTime()
    const announce = (status) => bus?.publish(status === 'running' ? 'workflow.started' : 'workflow.finished', {
      runId: id,
      workflowId: workflow.id,
      name: workflow.name,
      trigger,
      status,
      stepsTotal: steps.length,
      stepsCompleted: steps.filter((s) => s.status === 'completed').length,
      startedAt,
      ...(status !== 'running' && { finishedAt: Math.max(startedAt, clock().getTime()) }),
    })
    announce('running')
    const finish = (async () => {
      let failed = false
      try {
        for (const [i, step] of workflow.steps.entries()) {
          const rec = steps[i]
          if (failed) { rec.status = 'skipped'; rec.detail = 'An earlier step did not complete.'; continue }
          rec.status = 'running'
          save('running')
          const ask = async (title, details) => {
            rec.status = 'waiting_approval'
            save('waiting_approval')
            const ok = await approve(`${title} — workflow "${workflow.name}"`,
              `Workflow "${workflow.name}" · step ${i + 1} of ${workflow.steps.length} · ${trigger === 'schedule' ? 'scheduled run' : 'started manually'}\n\n${details}`)
            rec.status = 'running'
            save('running')
            return ok
          }
          try {
            if (step.type === 'read_file') {
              const r = await files.read(step.path)
              rec.detail = `${Buffer.byteLength(r.content)} bytes, sha256 ${r.sha256.slice(0, 12)}…`
            } else if (step.type === 'list_files') {
              rec.detail = `${(await files.list(step.path)).length} entries`
            } else {
              const command = step.type === 'push_branch' ? pushCommand(step) : step.command
              const r = await approvedCommand({ cwd: step.cwd, command }, ask, { files, ...(execute && { execute }) })
              rec.detail = redact(String(r.stdout ?? '').replace(/\s+/g, ' ').trim()).text.slice(0, 300) || 'Exited with code 0.'
            }
            rec.status = 'completed'
          } catch (err) {
            failed = true
            rec.status = /not approved/i.test(err.message) ? 'rejected' : 'failed'
            rec.detail = rec.status === 'rejected'
              ? 'Not approved (rejected or expired); the step did not run.'
              : redact(String(err.message).replace(/\s+/g, ' ')).text.slice(0, 400)
          }
        }
        save(failed ? 'failed' : 'completed', true)
        announce(failed ? 'failed' : 'completed')
      } catch (err) {
        log.error('[jarvis] workflow run crashed:', err)
        save('failed', true)
        announce('failed')
      } finally {
        active.delete(workflow.id)
      }
    })()
    return { ok: true, runId: id, done: finish }
  }

  return {
    run,
    isActive: (workflowId) => active.has(workflowId),
    /** Starts any scheduled workflow that is due. Returns how many it started. */
    tick() {
      let started = 0
      for (const w of store.list()) {
        if (active.has(w.id) || !isDue(w, store.lastScheduledDay(w.id), clock())) continue
        void run(w, 'schedule')
        started += 1
      }
      return started
    },
    start(intervalMs = 30_000) {
      const t = setInterval(() => { try { this.tick() } catch (err) { log.error('[jarvis] scheduler tick failed:', err) } }, intervalMs)
      t.unref?.()
      setTimeout(() => this.tick(), 3000).unref?.()
      return () => clearInterval(t)
    },
  }
}
