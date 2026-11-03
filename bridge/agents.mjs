/**
 * The agent registry: which named agents exist, and which of them may run.
 *
 * Definitions come from two places:
 *
 *   - built-in: Markdown files shipped with the app (`bridge/agents/`).
 *     They are read-only; the owner copies one to change it.
 *   - user: `agents/<id>.md` in the JARVIS data directory (settingsDir()).
 *
 * Every file is parsed and checked by agent-definition.mjs, then checked
 * against what is actually installed:
 *
 *   - every tool it lists exists in the live tool catalogue;
 *   - every connector it lists is registered, and one listed as `write`
 *     declares the write capability (the policy still decides each call);
 *   - its id is unique, and a user file may not reuse a built-in's id;
 *   - a user file is named after its id (`researcher.md` holds `researcher`);
 *   - a definition made by an agent (`createdBy: agent`) stays inactive until
 *     the owner approves that exact file. Editing it afterwards needs a new
 *     approval, because the approval is recorded against the file's hash.
 *
 * A file that fails any check is reported with its reasons and skipped. Nothing
 * here throws on a bad file, a missing folder or an unreadable approvals file,
 * so one broken definition can never stop the bridge.
 *
 * Accepting a definition grants nothing: its tools are an upper bound that the
 * runtime narrows further, and every call still goes through policy.mjs.
 * Reasons are short and never echo file content, so they are safe to log and
 * to show on the Agents screen.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgentFile, MAX_FILE_CHARS } from './agent-definition.mjs'
import { READ_ONLY_BUILTINS, WRITE_BUILTINS } from './policy.mjs'
import { settingsDir } from './settings.mjs'

/** Where built-in definitions ship. */
export const BUILTIN_AGENTS_DIR = fileURLToPath(new URL('./agents/', import.meta.url))

/** Where the owner's own definitions live. */
export const userAgentsDir = (env = process.env) => join(settingsDir(env), 'agents')

/** Where approvals of agent-made definitions are kept (beside settings, no secrets). */
export const agentApprovalsFile = (env = process.env) => join(settingsDir(env), 'agent-approvals.json')

/** At most this many files are read from one folder. */
export const MAX_AGENT_FILES = 500

/** Why an agent that loaded is not active. */
export const INACTIVE_REASONS = Object.freeze({
  'needs-approval': 'made by an agent; waiting for your approval',
})

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const MCP_PART = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The live tool catalogue: which tool names exist right now.
 *
 * @param {object} [o]
 * @param {Iterable<string>} [o.builtins] SDK built-ins (Read, WebSearch, …)
 * @param {Record<string, Iterable<string> | null>} [o.servers] MCP server key →
 *   its tool names, offered as `mcp__<key>__<tool>`. `null` marks a server whose
 *   tool list the bridge cannot read (someone else's MCP process): any tool on
 *   it counts as existing, because the server itself does.
 * @param {Iterable<string>} [o.names] other exact names (JARVIS's own tools)
 */
export function createToolCatalogue({ builtins = [...READ_ONLY_BUILTINS, ...WRITE_BUILTINS], servers = {}, names = [] } = {}) {
  const exact = new Set([...builtins, ...names])
  const opaque = new Set()
  for (const [key, tools] of Object.entries(servers ?? {})) {
    if (!MCP_PART.test(key)) continue
    if (tools === null) { opaque.add(key); continue }
    for (const t of tools ?? []) if (typeof t === 'string' && t) exact.add(`mcp__${key}__${t}`)
  }
  return Object.freeze({
    has(name) {
      if (typeof name !== 'string') return false
      if (exact.has(name)) return true
      const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name)
      return m !== null && opaque.has(m[1])
    },
    names: () => [...exact].sort(),
  })
}

/**
 * The connectors a definition may name, from the connector registry's
 * `list()` (or a plain array of `{ id, capabilities }`).
 */
function connectorIndex(connectors) {
  let list = []
  try {
    list = typeof connectors?.list === 'function' ? connectors.list() : connectors
  } catch {
    list = []
  }
  const index = new Map()
  for (const c of Array.isArray(list) ? list : []) {
    if (isRecord(c) && typeof c.id === 'string') index.set(c.id, isRecord(c.capabilities) ? c.capabilities : {})
  }
  return index
}

/** The tool catalogue as `has(name)`, from a catalogue, a Set/array or a predicate. */
function toolCheck(tools) {
  if (typeof tools === 'function') return (n) => { try { return tools(n) === true } catch { return false } }
  if (tools && typeof tools.has === 'function') return (n) => { try { return tools.has(n) === true } catch { return false } }
  if (Array.isArray(tools)) { const s = new Set(tools); return (n) => s.has(n) }
  return () => false
}

/** `.md` files in a folder, sorted, or a problem if the folder can't be read. */
function definitionFiles(dir) {
  if (!dir || !existsSync(dir)) return { files: [] }
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
    return { files: names.slice(0, MAX_AGENT_FILES), truncated: names.length > MAX_AGENT_FILES }
  } catch {
    return { files: [], problem: 'the folder could not be read' }
  }
}

function readApprovals(file) {
  if (!file || !existsSync(file)) return {}
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(data) && isRecord(data.approved) ? data.approved : {}
  } catch {
    return {}
  }
}

/**
 * @param {object} [o]
 * @param {string} [o.builtinDir] built-in definitions (read-only)
 * @param {string} [o.userDir] the owner's definitions
 * @param {string} [o.approvalsFile] approvals of agent-made definitions
 * @param {*} [o.tools] the live tool catalogue (see createToolCatalogue)
 * @param {*} [o.connectors] the connector registry, or `[{ id, capabilities }]`
 * @param {{ warn?: Function }} [o.log]
 * @param {() => number} [o.now]
 */
export function createAgentRegistry({
  builtinDir = BUILTIN_AGENTS_DIR,
  userDir = userAgentsDir(),
  approvalsFile = agentApprovalsFile(),
  tools = createToolCatalogue(),
  connectors = [],
  log = console,
  now = Date.now,
} = {}) {
  let agents = new Map() // id -> entry
  let refused = []

  /** Check one parsed definition against what is installed. */
  function installedProblems(def, hasTool, connectorCaps) {
    const problems = []
    def.tools.forEach((t, i) => { if (!hasTool(t)) problems.push(`tools.${i}: no such tool is installed`) })
    for (const [id, access] of Object.entries(def.connectors)) {
      if (!connectorCaps.has(id)) problems.push(`connectors.${id}: no such connector is installed`)
      else if (access === 'write' && connectorCaps.get(id).write !== true) problems.push(`connectors.${id}: this connector cannot write`)
    }
    return problems
  }

  function readOne(dir, file, source) {
    const path = join(dir, file)
    try {
      if (statSync(path).size > MAX_FILE_CHARS * 4) return { problems: [`(file): larger than ${MAX_FILE_CHARS} characters`] }
      const text = readFileSync(path, 'utf8')
      const parsed = parseAgentFile(text)
      if (!parsed.ok) return { problems: parsed.errors }
      return { def: parsed.value, hash: hashOf(text), path, source }
    } catch {
      return { problems: ['(file): could not be read'] }
    }
  }

  function load() {
    const hasTool = toolCheck(tools)
    const connectorCaps = connectorIndex(connectors)
    const approvals = readApprovals(approvalsFile)
    const next = new Map()
    const nextRefused = []
    const refuse = (source, file, reasons) => nextRefused.push({ source, file, reasons: [...reasons] })

    for (const source of ['builtin', 'user']) {
      const dir = source === 'builtin' ? builtinDir : userDir
      const { files, problem, truncated } = definitionFiles(dir)
      if (problem) refuse(source, '(folder)', [problem])
      if (truncated) refuse(source, '(folder)', [`more than ${MAX_AGENT_FILES} files; the rest were not read`])
      for (const file of files) {
        const r = readOne(dir, file, source)
        if (r.problems) { refuse(source, file, r.problems); continue }
        const { def } = r
        const problems = []
        if (source === 'user' && basename(file, '.md') !== def.id) problems.push(`id: the file must be named ${def.id}.md`)
        if (source === 'builtin' && def.createdBy !== 'builtin') problems.push('createdBy: a built-in agent must say builtin')
        if (source === 'user' && def.createdBy === 'builtin') problems.push('createdBy: only agents shipped with JARVIS are builtin')
        const existing = next.get(def.id)
        if (existing) {
          problems.push(existing.source === 'builtin' && source === 'user'
            ? `id: ${def.id} is a built-in agent; copy it under a new id to change it`
            : `id: another file already uses ${def.id}`)
        }
        problems.push(...installedProblems(def, hasTool, connectorCaps))
        if (problems.length) { refuse(source, file, problems); continue }

        const approval = approvals[def.id]
        const approved = def.createdBy !== 'agent' || (isRecord(approval) && approval.sha256 === r.hash)
        next.set(def.id, {
          id: def.id,
          source,
          file,
          definition: Object.freeze(def),
          hash: r.hash,
          active: approved,
          ...(approved ? {} : { inactiveReason: 'needs-approval' }),
        })
      }
    }

    agents = next
    refused = nextRefused
    for (const r of refused) log?.warn?.(`[jarvis] agent file ${r.source}/${r.file} refused: ${r.reasons.slice(0, 3).join('; ')}`)
    return registry.summary()
  }

  const view = (e) => ({
    id: e.id,
    name: e.definition.name,
    description: e.definition.description,
    mode: e.definition.mode,
    source: e.source,
    readOnly: e.source === 'builtin',
    createdBy: e.definition.createdBy,
    active: e.active,
    ...(e.inactiveReason ? { inactiveReason: e.inactiveReason, inactiveDetail: INACTIVE_REASONS[e.inactiveReason] } : {}),
  })

  const registry = {
    /** Read both folders again. Returns the summary; never throws on bad files. */
    load,
    reload: load,

    /** Every agent that loaded, active or waiting for approval. */
    list: () => [...agents.values()].map(view),

    /** Agents that may run now. */
    active: () => [...agents.values()].filter((e) => e.active).map(view),

    /** Files that were refused, with their reasons. */
    refused: () => refused.map((r) => ({ ...r, reasons: [...r.reasons] })),

    has: (id) => agents.has(id),

    /** The checked definition, or null. Inactive agents are returned too; check `isActive`. */
    get: (id) => agents.get(id)?.definition ?? null,

    isActive: (id) => agents.get(id)?.active === true,

    summary: () => ({ loaded: agents.size, active: [...agents.values()].filter((e) => e.active).length, refused: refused.length }),

    /**
     * Record the owner's approval of an agent-made definition, as it is now.
     * The caller is the approval flow; this only remembers the decision.
     * @param {string} id
     * @param {{ by?: string }} [o]
     */
    approve(id, { by = 'owner' } = {}) {
      const e = agents.get(id)
      if (!e) return { ok: false, error: 'no such agent' }
      if (e.definition.createdBy !== 'agent') return { ok: false, error: 'only agent-made definitions need approval' }
      if (e.active) return { ok: true, id }
      const approvals = readApprovals(approvalsFile)
      approvals[id] = { sha256: e.hash, approvedAt: new Date(now()).toISOString(), by: String(by).slice(0, 60) }
      try {
        const dir = join(approvalsFile, '..')
        mkdirSync(dir, { recursive: true })
        const tmp = `${approvalsFile}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify({ v: 1, approved: approvals }, null, 2)}\n`, { mode: 0o600 })
        renameSync(tmp, approvalsFile)
      } catch {
        return { ok: false, error: 'the approval could not be saved' }
      }
      const { inactiveReason: _waiting, ...rest } = e
      agents.set(id, { ...rest, active: true })
      return { ok: true, id }
    },
  }

  return registry
}
