/**
 * The connector interface (plans/connectors/README.md, "The JARVIS connector
 * interface"; types follow plan 38).
 *
 * A connector is one adapter object that reaches one outside source — a
 * mailbox, a calendar, a folder, a chat service — and hands JARVIS what it
 * finds as `Document`s (data connectors) or `ChannelMessage`s (channels), plus
 * any tools it offers a brain. This module only describes and checks that
 * shape; it reaches nothing itself, so it is tested on its own.
 *
 *   id, name, kind, auth, platforms, risk
 *   capabilities  { read, write, subscribe }   what the adapter *can* do; what it
 *                                              *may* do is a grant (grants.mjs)
 *   connect(opts)        → ConnectResult      runs the owner's setup flow
 *   disconnect(opts?)    → void               { eraseData } also erases local data
 *   status()             → { state, detail, lastSync? }
 *   sync?(o)             → AsyncIterable<Document>
 *   tools?()             → ConnectorTool[]    offered to brains, policy-gated
 *   receive?()           → AsyncIterable<ChannelMessage>   channels
 *   send?(msg)           → void               channels, approval-gated
 *
 * Like brains/events.mjs this is the bridge's own copy of a contract, in plain
 * JavaScript so the bridge needs no TypeScript at runtime.
 */

export const KINDS = Object.freeze(['data', 'channel', 'tool-provider'])
export const AUTH_KINDS = Object.freeze(['oauth', 'token', 'local', 'filesystem', 'none'])
export const PLATFORMS = Object.freeze(['win', 'mac', 'linux'])
/** Risk tiers from the connector index: R0 public/local … R3 irreversible. */
export const RISKS = Object.freeze(['R0', 'R1', 'R2', 'R3'])
/** Capabilities, each granted separately. Writes and subscriptions start off. */
export const CAPABILITIES = Object.freeze(['read', 'write', 'subscribe'])
export const STATES = Object.freeze(['ok', 'attention', 'error', 'disconnected'])

/**
 * Sensitivity class of a synced document. Plan 38's `Sensitivity` says how far
 * it may travel (public / private / vault); the class says what it is, so the
 * store and the Privacy Centre can treat health or other people's messages
 * differently from a calendar entry.
 */
export const SENSITIVITY_CLASSES = Object.freeze([
  'public', 'personal', 'work', 'messages', 'contacts', 'finance', 'health', 'location',
])
const VAULT_CLASSES = new Set(['health', 'finance'])

/** Connector ids: lower case, digits and single underscores, as in the folder names. */
export const CONNECTOR_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** Tool names inside a connector: same alphabet. */
export const TOOL_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

const MAX_TEXT = 200_000
const MAX_TITLE = 500

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFn = (v) => typeof v === 'function'

/**
 * Check a connector object. Returns a list of problems (empty when it is fine)
 * rather than throwing, so the registry can say everything that is wrong at once.
 * @param {any} c
 * @returns {string[]}
 */
export function connectorProblems(c) {
  if (!isObject(c)) return ['a connector must be an object']
  const p = []
  const id = typeof c.id === 'string' && CONNECTOR_ID.test(c.id) && c.id.length <= 40 ? c.id : null
  if (!id) p.push(`bad connector id: ${String(c.id)}`)
  const who = id ?? 'connector'
  if (typeof c.name !== 'string' || !c.name.trim()) p.push(`${who} needs a name`)
  if (!KINDS.includes(c.kind)) p.push(`${who} has an unknown kind: ${String(c.kind)}`)
  if (!AUTH_KINDS.includes(c.auth)) p.push(`${who} has an unknown auth kind: ${String(c.auth)}`)
  if (!RISKS.includes(c.risk)) p.push(`${who} has an unknown risk tier: ${String(c.risk)}`)
  if (!Array.isArray(c.platforms) || !c.platforms.length || !c.platforms.every((x) => PLATFORMS.includes(x))) {
    p.push(`${who} needs platforms from ${PLATFORMS.join(', ')}`)
  }
  const caps = c.capabilities
  if (!isObject(caps) || !CAPABILITIES.every((k) => typeof caps[k] === 'boolean')) {
    p.push(`${who} needs capabilities { read, write, subscribe } as booleans`)
  }
  for (const method of ['connect', 'disconnect', 'status']) {
    if (!isFn(c[method])) p.push(`${who} needs ${method}()`)
  }
  for (const method of ['sync', 'tools', 'receive', 'send']) {
    if (c[method] !== undefined && !isFn(c[method])) p.push(`${who}.${method} must be a function`)
  }
  if (isObject(caps)) {
    if (c.kind === 'data' && caps.read && !isFn(c.sync) && !isFn(c.tools)) {
      p.push(`${who} can read but has neither sync() nor tools()`)
    }
    if (c.kind === 'channel' && !isFn(c.receive)) p.push(`${who} is a channel but has no receive()`)
    if (isFn(c.send) && !caps.write) p.push(`${who} has send() but no write capability`)
  }
  return p
}

/**
 * A tool a connector offers. `capability` decides which grant it needs, so a
 * tool that changes anything must say 'write' — the registry refuses a tool
 * whose name reads as an action but claims to be a read (see registry.mjs).
 * @param {any} t
 * @returns {string[]}
 */
export function toolProblems(t) {
  if (!isObject(t)) return ['a connector tool must be an object']
  const p = []
  if (typeof t.name !== 'string' || !TOOL_ID.test(t.name) || t.name.length > 48) p.push(`bad tool name: ${String(t.name)}`)
  if (!CAPABILITIES.includes(t.capability)) p.push(`tool ${String(t.name)} needs a capability (read, write or subscribe)`)
  if (typeof t.description !== 'string' || !t.description.trim()) p.push(`tool ${String(t.name)} needs a description`)
  if (!isFn(t.run)) p.push(`tool ${String(t.name)} needs run()`)
  if (t.params !== undefined) p.push(...paramProblems(t.params).map((e) => `tool ${String(t.name)}: ${e}`))
  return p
}

export const PARAM_TYPES = Object.freeze(['string', 'number', 'boolean'])

/**
 * A tool's inputs, as a small flat spec the MCP server turns into a schema
 * (connectors/mcp.mjs), so this module stays free of dependencies:
 *
 *   params: { query: { type: 'string', min?: 2, max?: 200, optional?: true, description? }, … }
 *
 * Strings must have a `max`, so no tool takes unbounded input.
 * @param {any} params
 * @returns {string[]}
 */
export function paramProblems(params) {
  if (!isObject(params)) return ['params must be an object']
  const p = []
  const names = Object.keys(params)
  if (names.length > 16) p.push('at most 16 params')
  for (const name of names) {
    const s = params[name]
    if (!TOOL_ID.test(name) || name.length > 40) p.push(`bad param name: ${name}`)
    if (!isObject(s) || !PARAM_TYPES.includes(s.type)) {
      p.push(`param ${name} needs a type (${PARAM_TYPES.join(', ')})`)
      continue
    }
    for (const k of ['min', 'max']) {
      if (s[k] !== undefined && !(typeof s[k] === 'number' && Number.isFinite(s[k]))) p.push(`param ${name}.${k} must be a number`)
    }
    if (s.type === 'string' && !(Number.isInteger(s.max) && s.max > 0 && s.max <= 20_000)) p.push(`param ${name} is a string and needs a max (1–20000)`)
    if (s.optional !== undefined && typeof s.optional !== 'boolean') p.push(`param ${name}.optional must be a boolean`)
    if (s.description !== undefined && typeof s.description !== 'string') p.push(`param ${name}.description must be a string`)
  }
  return p
}

const finiteTime = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const shortString = (v, max = 2048) => (typeof v === 'string' && v.length && v.length <= max ? v : undefined)

/**
 * Validate and normalise one synced document. Returns `{ ok: true, doc }` or
 * `{ ok: false, error }`. A document an adapter got wrong is dropped and
 * counted, not allowed to stop the rest of the sync.
 *
 * Shape (before untrusted wrapping, which the registry adds):
 *   id            the source's own id, unique within the connector
 *   title?        subject, file name, event summary
 *   text          the readable body
 *   url?          a link back to the item at the source
 *   author?       who wrote it, as the source names them
 *   createdAt?    ms since epoch
 *   updatedAt     ms since epoch; used for "since" and retention
 *   sensitivity   one of SENSITIVITY_CLASSES
 *   meta?         small flat object of strings/numbers/booleans (labels, folder…)
 *
 * @param {any} raw
 * @param {{ defaultSensitivity?: string }} [opts]
 */
export function normaliseDocument(raw, { defaultSensitivity = 'personal' } = {}) {
  if (!isObject(raw)) return { ok: false, error: 'document is not an object' }
  const id = shortString(raw.id, 512)
  if (!id || /[\u0000-\u001f]/.test(id)) return { ok: false, error: 'document needs an id' }
  if (typeof raw.text !== 'string') return { ok: false, error: `document ${id} has no text` }
  const updatedAt = finiteTime(raw.updatedAt) ?? finiteTime(raw.createdAt)
  if (updatedAt === null) return { ok: false, error: `document ${id} has no time` }
  const sensitivity = raw.sensitivity ?? defaultSensitivity
  if (!SENSITIVITY_CLASSES.includes(sensitivity)) return { ok: false, error: `document ${id} has an unknown sensitivity` }
  const meta = {}
  if (isObject(raw.meta)) {
    for (const [k, v] of Object.entries(raw.meta).slice(0, 32)) {
      if (!/^[\w.-]{1,64}$/.test(k)) continue
      if (typeof v === 'string') meta[k] = v.slice(0, 500)
      else if (typeof v === 'number' && Number.isFinite(v)) meta[k] = v
      else if (typeof v === 'boolean') meta[k] = v
    }
  }
  const doc = {
    id,
    text: raw.text.length > MAX_TEXT ? raw.text.slice(0, MAX_TEXT) : raw.text,
    updatedAt,
    sensitivity,
  }
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : undefined
  if (title) doc.title = title
  const url = shortString(raw.url)
  if (url && /^(https?|file|obsidian|notion):/i.test(url)) doc.url = url
  const author = typeof raw.author === 'string' ? raw.author.slice(0, 200) : undefined
  if (author) doc.author = author
  const createdAt = finiteTime(raw.createdAt)
  if (createdAt !== null) doc.createdAt = createdAt
  if (Object.keys(meta).length) doc.meta = meta
  return { ok: true, doc }
}

/** Plan 38 `Sensitivity` for a class: how far a document may travel. */
export const travelOf = (sensitivityClass) =>
  sensitivityClass === 'public' ? 'public' : VAULT_CLASSES.has(sensitivityClass) ? 'vault' : 'private'
