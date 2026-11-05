/**
 * Settings → Agents, bridge side (agents phase A3): the HTTP routes the
 * Agents screen talks to, kept apart from server.mjs so they can be tested
 * against a temporary data folder with no network and no model.
 *
 *   GET  /agents                    the roster: every loaded agent with its switch, run numbers
 *                                   and last run; refused files with their reasons; the limits
 *   GET  /agents/:id                one agent: its whole definition, its file as text, numbers
 *   GET  /agents/:id/runs           its recent runs (newest first) and numbers
 *   POST /agents                    { definition } or { file }  create a user agent
 *   POST /agents/reload             read both folders again
 *   POST /agents/:id/update         { definition } or { file }  replace a user agent
 *   POST /agents/:id/copy           { id, name? }  copy any agent (built-in or user) to a new user agent
 *   POST /agents/:id/enabled        { enabled, confirm? }  the per-agent switch; turning on an agent
 *                                   that runs unasked (scheduled, triggered, continuous) needs confirm
 *   POST /agents/:id/delete         { confirm: true }  delete a user agent
 *
 * Rules this module keeps:
 *   - Built-in agents are read-only: they can be read, copied and switched,
 *     never changed or deleted.
 *   - Every write is checked exactly as the registry checks a file when it
 *     loads (agent-definition.mjs, then agents.mjs `check`): unknown tools or
 *     connectors, a built-in's id, a non-Coordinator that delegates, an
 *     unattended agent without a budget are all refused with their reasons,
 *     and nothing is written.
 *   - The page writes as the owner, so it can create `user` agents only. An
 *     agent-made definition (`createdBy: agent`) arrives through its approval
 *     card, never here; editing one keeps it agent-made, which needs a new
 *     approval because the approval is pinned to the file's hash.
 *   - Writes are local files in the owner's agents folder and go through
 *     `gate`, which the bridge points at the kill switch: while JARVIS is
 *     frozen nothing is written. Turning things on that widen what runs
 *     unasked needs `confirm: true`; turning things off never does.
 *   - Deleting an agent also forgets its switch, so a later file with the same
 *     id starts from its mode's default (off for anything that runs unasked).
 *   - Writing a definition grants nothing: the runtime still narrows its tools
 *     and policy.mjs still decides every call.
 *
 * Run numbers come from the task manager's list, which is what the task store
 * keeps (the most recent tasks). Reasons are short and never echo request
 * content. `handle()` returns `{ status, body }`, or null for a path that is
 * not ours. The server checks the Origin before calling it for anything but GET.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkAgentDefinition, formatAgentFile, parseAgentFile, MAX_FILE_CHARS, REVIEW_SET, UNATTENDED_MODES,
} from './agent-definition.mjs'
import { MAX_AGENT_FILES } from './agents.mjs'

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/
const UNATTENDED = new Set(UNATTENDED_MODES)
/** Runs returned per agent. */
export const MAX_RUNS = 20
/** Statuses a run can end with. A cancelled run is the owner's choice, not a failure. */
const ENDED = new Set(['done', 'failed', 'cancelled', 'interrupted'])
const FAILED = new Set(['failed', 'interrupted'])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ok = (body, status = 200) => ({ status, body: { ok: true, ...body } })
const bad = (reason, status = 400, extra = {}) => ({ status, body: { ok: false, reason, ...extra } })
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places

/**
 * One agent's runs and numbers, from task snapshots (tasks.mjs `list()`).
 * `successRate` is done ÷ (done + failed + interrupted); cancelled runs are
 * left out, and it is null until a run has finished. Minutes count runs that
 * started and ended; cost adds up what was recorded (subscription runs have none).
 */
export function agentRunStats(tasks, id) {
  const runs = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => isObject(t) && t.agentId === id)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  let done = 0, failed = 0, cancelled = 0, active = 0, minutes = 0, costUsd = 0
  let lastRunAt = null
  for (const t of runs) {
    if (t.status === 'done') done++
    else if (FAILED.has(t.status)) failed++
    else if (t.status === 'cancelled') cancelled++
    else active++
    if (ENDED.has(t.status) && Number.isFinite(t.startedAt) && Number.isFinite(t.endedAt) && t.endedAt >= t.startedAt) {
      minutes += (t.endedAt - t.startedAt) / 60_000
    }
    if (typeof t.costUsd === 'number' && Number.isFinite(t.costUsd) && t.costUsd > 0) costUsd += t.costUsd
    const at = t.startedAt ?? t.createdAt
    if (Number.isFinite(at) && (lastRunAt === null || at > lastRunAt)) lastRunAt = at
  }
  const finished = done + failed
  return {
    stats: {
      runs: runs.length,
      done,
      failed,
      cancelled,
      active,
      successRate: finished ? round(done / finished, 3) : null,
      minutes: round(minutes, 1),
      costUsd: round(costUsd, 4),
      lastRunAt,
    },
    runs: runs.slice(0, MAX_RUNS).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt ?? null,
      startedAt: t.startedAt ?? null,
      endedAt: t.endedAt ?? null,
      minutes: Number.isFinite(t.startedAt) && Number.isFinite(t.endedAt) ? round((t.endedAt - t.startedAt) / 60_000, 1) : null,
      costUsd: typeof t.costUsd === 'number' ? t.costUsd : null,
      ...(t.status === 'done' ? {} : t.error ? { error: String(t.error).slice(0, 300) } : {}),
    })),
  }
}

/**
 * A definition as file text. A file that did not say `review` itself leaves
 * the line out, so the owner's reviewer default (JARVIS_AGENTS_REVIEWER) keeps
 * applying to it after a save.
 */
export function agentFileText(def) {
  const text = formatAgentFile(def)
  return def?.[REVIEW_SET] === true ? text : text.replace(/^review: (?:true|false)\n/m, '')
}

/**
 * @param {object} o
 * @param {ReturnType<import('./agents.mjs').createAgentRegistry>} o.registry
 * @param {{ isSwitchedOn: Function, hasSwitch?: Function, switchPatch: Function, maxConcurrent?: Function, maxDepth?: Function, paused?: Function }} o.settings agent settings (agent-settings.mjs)
 * @param {(patch: object) => unknown} o.saveSettings saves a settings patch (settings.mjs updateSettings)
 * @param {{ list: () => object[] }} [o.tasks] the task manager, for run history
 * @param {(write: { action: string, id: string }) => string | null} [o.gate] a reason to refuse a write, or null
 * @param {() => void} [o.changed] told after any change (the bridge refreshes the task manager)
 * @param {{ log?: Function, warn?: Function }} [o.log]
 */
export function createAgentRoutes({
  registry,
  settings,
  saveSettings,
  tasks = { list: () => [] },
  gate = () => null,
  changed = () => {},
  log = console,
} = {}) {
  if (!registry || typeof registry.get !== 'function') throw new Error('agent routes: registry is required')
  if (!settings || typeof settings.switchPatch !== 'function') throw new Error('agent routes: settings are required')
  if (typeof saveSettings !== 'function') throw new Error('agent routes: saveSettings is required')

  const allTasks = () => {
    try { return tasks.list() } catch { return [] }
  }
  const switchedOn = (id) => {
    try { return settings.isSwitchedOn(id, registry.get(id)) === true } catch { return false }
  }
  const notify = () => {
    try { changed() } catch (err) { log?.warn?.('[jarvis] agents: refresh after a change failed:', err?.message ?? err) }
  }
  const refusedWrite = (action, id) => {
    let why
    try { why = gate({ action, id }) } catch { why = 'The change could not be checked, so nothing was saved.' }
    return typeof why === 'string' && why ? bad(why, 409) : null
  }

  const card = (view, all) => {
    const def = registry.get(view.id)
    const { stats } = agentRunStats(all, view.id)
    return {
      ...view,
      icon: def?.icon ?? null,
      switchedOn: switchedOn(view.id),
      runsUnasked: UNATTENDED.has(view.mode),
      tools: def?.tools.length ?? 0,
      connectors: Object.keys(def?.connectors ?? {}).length,
      review: def?.review === true,
      stats,
    }
  }

  const limits = () => {
    const read = (f) => { try { return typeof f === 'function' ? f() : null } catch { return null } }
    return { maxConcurrent: read(settings.maxConcurrent), maxDepth: read(settings.maxDepth), paused: read(settings.paused) }
  }

  /** The body's definition as a checked one: `{ def, text }` or `{ errors }`. */
  function readBody(body, id) {
    if (!isObject(body)) return { errors: ['(body): send JSON'] }
    if (typeof body.file === 'string') {
      if (body.file.length > MAX_FILE_CHARS) return { errors: [`(file): larger than ${MAX_FILE_CHARS} characters`] }
      const parsed = parseAgentFile(body.file)
      // The owner's own text is kept as written (comments and all).
      return parsed.ok ? { def: parsed.value, text: body.file.replace(/\r\n?/g, '\n') } : { errors: parsed.errors }
    }
    if (isObject(body.definition)) {
      const raw = { ...body.definition }
      if (id !== undefined && raw.id === undefined) raw.id = id
      const checked = checkAgentDefinition(raw)
      return checked.ok ? { def: checked.value, text: agentFileText(checked.value) } : { errors: checked.errors }
    }
    return { errors: ['(body): send a definition or a file'] }
  }

  function userFileCount() {
    try {
      return existsSync(registry.userDir) ? readdirSync(registry.userDir).filter((f) => f.toLowerCase().endsWith('.md')).length : 0
    } catch {
      return 0
    }
  }

  /** Write `<id>.md` atomically, reload, and check it loaded; undo on failure. */
  function writeDefinition(def, text) {
    const dir = registry.userDir
    const path = join(dir, `${def.id}.md`)
    let previous = null
    try {
      if (existsSync(path)) previous = readFileSync(path, 'utf8')
    } catch {
      return bad('The file could not be read before saving.', 500)
    }
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = join(dir, `.${def.id}.${process.pid}.tmp`)
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      return bad('The file could not be saved.', 500)
    }
    registry.reload()
    const entry = registry.entry(def.id)
    if (!entry || entry.source !== 'user') {
      // It passed the checks but did not load: put things back as they were.
      try {
        if (previous === null) rmSync(path, { force: true })
        else writeFileSync(path, previous, { encoding: 'utf8', mode: 0o600 })
      } catch { /* reported below */ }
      registry.reload()
      const why = registry.refused().find((r) => r.source === 'user' && r.file === `${def.id}.md`)?.reasons
      return bad('The agent did not load, so the change was undone.', 422, why ? { reasons: why } : {})
    }
    return null
  }

  /** Forget a switch so the agent starts from its mode's default. */
  function forgetSwitch(id) {
    try {
      if (typeof settings.hasSwitch === 'function' && !settings.hasSwitch(id)) return
      saveSettings(settings.switchPatch(id, null))
    } catch (err) {
      log?.warn?.(`[jarvis] agents: could not clear the switch for ${id}:`, err?.message ?? err)
    }
  }

  function detail(id) {
    const def = registry.get(id)
    const view = registry.list().find((a) => a.id === id)
    if (!def || !view) return bad('No such agent.', 404)
    const all = allTasks()
    const { stats, runs } = agentRunStats(all, id)
    return ok({ agent: { ...card(view, all), stats }, definition: { ...def }, file: agentFileText(def), runs })
  }

  function create(body) {
    const blocked = refusedWrite('create', '')
    if (blocked) return blocked
    const { def, text, errors } = readBody(body)
    if (errors) return bad('That definition is not valid.', 400, { reasons: errors })
    if (def.createdBy === 'agent') return bad('Agent-made definitions are saved from their approval card.', 400)
    if (registry.has(def.id)) return bad(`There is already an agent called ${def.id}.`, 409)
    if (userFileCount() >= MAX_AGENT_FILES) return bad(`You already have ${MAX_AGENT_FILES} agents; delete one first.`, 409)
    const problems = registry.check(def)
    if (problems.length) return bad('That definition cannot be used.', 422, { reasons: problems })
    forgetSwitch(def.id)
    const failed = writeDefinition(def, text)
    if (failed) return failed
    log?.log?.(`[jarvis] agents: created ${def.id}`)
    notify()
    return { ...detail(def.id), status: 201 }
  }

  function update(id, body) {
    const entry = registry.entry(id)
    if (!entry) return bad('No such agent.', 404)
    if (entry.source !== 'user') return bad('Built-in agents cannot be changed; copy one to edit it.', 403)
    const blocked = refusedWrite('update', id)
    if (blocked) return blocked
    const { def, text, errors } = readBody(body, id)
    if (errors) return bad('That definition is not valid.', 400, { reasons: errors })
    if (def.id !== id) return bad('An agent cannot be renamed; copy it under the new id instead.', 400)
    const before = registry.get(id)
    if (def.createdBy === 'agent' && before.createdBy !== 'agent') return bad('Only an agent-made definition is marked agent.', 400)
    if (before.createdBy === 'agent' && def.createdBy !== 'agent') {
      return bad('This agent was made by an agent; it stays marked so and needs your approval after a change.', 400)
    }
    const problems = registry.check(def, { replacing: id })
    if (problems.length) return bad('That definition cannot be used.', 422, { reasons: problems })
    const failed = writeDefinition(def, text)
    if (failed) return failed
    log?.log?.(`[jarvis] agents: updated ${id}`)
    notify()
    return detail(id)
  }

  function copy(id, body) {
    const source = registry.get(id)
    if (!source) return bad('No such agent.', 404)
    const blocked = refusedWrite('copy', id)
    if (blocked) return blocked
    if (!isObject(body) || typeof body.id !== 'string' || !AGENT_ID.test(body.id)) {
      return bad('Give the copy an id: lowercase letters, digits and dashes, starting with a letter.', 400)
    }
    if (registry.has(body.id)) return bad(`There is already an agent called ${body.id}.`, 409)
    if (body.name !== undefined && typeof body.name !== 'string') return bad('The name must be text.', 400)
    if (userFileCount() >= MAX_AGENT_FILES) return bad(`You already have ${MAX_AGENT_FILES} agents; delete one first.`, 409)
    const { requestedBy: _asked, review, ...rest } = source
    const checked = checkAgentDefinition({
      ...rest,
      // Keep "the file did not say" as it was, so the reviewer default still applies.
      ...(source[REVIEW_SET] === true && { review }),
      id: body.id,
      name: body.name?.trim() || `${source.name} (copy)`.slice(0, 60),
      createdBy: 'user',
      // Only the Coordinator delegates; a copy never inherits that.
      delegate: [],
    })
    if (!checked.ok) return bad('That copy is not valid.', 400, { reasons: checked.errors })
    const problems = registry.check(checked.value)
    if (problems.length) return bad('That copy cannot be used.', 422, { reasons: problems })
    forgetSwitch(body.id)
    const failed = writeDefinition(checked.value, agentFileText(checked.value))
    if (failed) return failed
    log?.log?.(`[jarvis] agents: copied ${id} to ${body.id}`)
    notify()
    return { ...detail(body.id), status: 201 }
  }

  function setEnabled(id, body) {
    const def = registry.get(id)
    if (!def) return bad('No such agent.', 404)
    if (!isObject(body) || typeof body.enabled !== 'boolean') return bad('Send { enabled: true } or { enabled: false }.', 400)
    if (body.enabled) {
      // Switching on is a change to what runs; switching off never waits.
      const blocked = refusedWrite('enable', id)
      if (blocked) return blocked
      if (UNATTENDED.has(def.mode) && body.confirm !== true) {
        return bad(`The ${def.name} agent runs without being asked (${def.mode}). Confirm to switch it on.`, 400, { needsConfirm: true })
      }
    }
    try {
      saveSettings(settings.switchPatch(id, body.enabled))
    } catch {
      return bad('The switch could not be saved.', 500)
    }
    log?.log?.(`[jarvis] agents: ${id} switched ${body.enabled ? 'on' : 'off'}`)
    notify()
    return ok({ id, switchedOn: switchedOn(id) })
  }

  function remove(id, body) {
    const entry = registry.entry(id)
    if (!entry) return bad('No such agent.', 404)
    if (entry.source !== 'user') return bad('Built-in agents cannot be deleted; switch one off instead.', 403)
    const blocked = refusedWrite('delete', id)
    if (blocked) return blocked
    if (!isObject(body) || body.confirm !== true) return bad('Confirm to delete this agent.', 400, { needsConfirm: true })
    try {
      rmSync(join(registry.userDir, entry.file), { force: true })
    } catch {
      return bad('The file could not be deleted.', 500)
    }
    registry.reload()
    forgetSwitch(id)
    log?.log?.(`[jarvis] agents: deleted ${id}`)
    notify()
    return ok({ id, deleted: true })
  }

  return {
    /**
     * @param {{ method: string, path: string, body?: unknown }} req
     * @returns {Promise<{ status: number, body: object } | null> | { status: number, body: object } | null}
     */
    handle({ method, path, body }) {
      if (path !== '/agents' && !path.startsWith('/agents/')) return null
      const parts = path.split('/').filter(Boolean).slice(1)

      if (parts.length === 0) {
        if (method === 'GET') {
          const all = allTasks()
          return ok({ agents: registry.list().map((v) => card(v, all)), refused: registry.refused(), limits: limits() })
        }
        if (method === 'POST') return create(body)
        return bad('Method not allowed.', 405)
      }
      if (parts.length === 1 && parts[0] === 'reload') {
        if (method !== 'POST') return bad('Method not allowed.', 405)
        const summary = registry.reload()
        notify()
        return ok({ summary, refused: registry.refused() })
      }

      const id = parts[0]
      if (!AGENT_ID.test(id)) return bad('No such agent.', 404)
      if (parts.length === 1) return method === 'GET' ? detail(id) : bad('Method not allowed.', 405)
      if (parts.length !== 2) return bad('Not found.', 404)
      const action = parts[1]
      if (action === 'runs') {
        if (method !== 'GET') return bad('Method not allowed.', 405)
        if (!registry.has(id)) return bad('No such agent.', 404)
        return ok({ id, ...agentRunStats(allTasks(), id) })
      }
      if (method !== 'POST') return bad('Method not allowed.', 405)
      switch (action) {
        case 'update': return update(id, body)
        case 'copy': return copy(id, body)
        case 'enabled': return setEnabled(id, body)
        case 'delete': return remove(id, body)
        default: return bad('Not found.', 404)
      }
    },
  }
}
