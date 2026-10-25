/**
 * The connector registry (plans/connectors/README.md; task C01).
 *
 * Every connector the bridge knows about is registered here at startup, each
 * inside its own try/catch: a connector whose optional dependency is missing,
 * or whose adapter throws, is recorded as a failure and the rest of JARVIS
 * starts as normal.
 *
 * The registry is also the only door between a connector and the rest of the
 * bridge, so the framework's rules are enforced here rather than trusted to
 * each adapter:
 *
 *   - Credentials (rule 5): an adapter gets a credential view scoped to its
 *     own id, never the whole store.
 *   - Grants and kill switches (rules 3, 9): sync, tools and channels check
 *     grants.mjs on every call, including mid-sync.
 *   - Tool list snapshot (rule 2): tools are read once at registration and
 *     checked; an adapter cannot add tools later. A "read" tool whose name
 *     reads as an action is refused.
 *   - Untrusted content (rule 4): every document text and tool result is
 *     wrapped with wrapUntrusted (untrusted.mjs, task Q02) before it leaves.
 *   - Policy (plan 15): connector tools are offered to brains as
 *     `mcp__jarvis_connectors__<connector>__<capability>__<tool>`; the policy
 *     engine (policy.mjs) asks `policyRule()` about every such call. Writes
 *     need the write grant AND general writes AND an approval per call.
 *   - Errors are ConnectorErrors with owner-readable messages; anything an
 *     adapter throws is scrubbed of its own credential values before logging.
 */
import { CAPABILITIES, connectorProblems, normaliseDocument, patternOf, toolProblems, travelOf } from './interface.mjs'
import { createGrants } from './grants.mjs'
import { createMemoryCredentialStore } from './credentials.mjs'
import { ConnectorError, ERROR_MESSAGES } from './http.mjs'
import { stripHiddenText, neutraliseControlTags, wrapUntrusted } from '../untrusted.mjs'
import { isReadName, isVetoed } from '../policy.mjs'

/** The MCP server name connector tools are offered under. */
export const CONNECTOR_SERVER = 'jarvis_connectors'

/** Policy rule ids this module can return (each has a reason in policy.mjs). */
export const CONNECTOR_RULES = Object.freeze([
  'connector-read', 'connector-write', 'connector-subscribe', 'connector-not-granted',
  'connector-disabled', 'connector-frozen', 'connector-unknown', 'connector-malformed',
])

/** `<connector>__<capability>__<tool>`: the tool half of the MCP name. */
export const connectorToolName = (connectorId, capability, tool) => `${connectorId}__${capability}__${tool}`

/** The full name a brain sees. */
export const connectorMcpName = (connectorId, capability, tool) =>
  `mcp__${CONNECTOR_SERVER}__${connectorToolName(connectorId, capability, tool)}`

/** Split a connector tool name (with or without the mcp__server__ prefix). */
export function parseConnectorTool(name) {
  let s = String(name ?? '')
  const prefix = `mcp__${CONNECTOR_SERVER}__`
  if (s.startsWith(prefix)) s = s.slice(prefix.length)
  const parts = s.split('__')
  if (parts.length !== 3) return null
  const [connectorId, capability, tool] = parts
  if (!connectorId || !tool || !CAPABILITIES.includes(capability)) return null
  return { connectorId, capability, tool }
}

/** Patterns that look like secrets, scrubbed from anything an adapter says. */
const SECRET_SHAPES = [
  /Bearer\s+[^\s"',]+/gi,
  /\b(?:sk|pk|rk|xox[abprs]|ghp|gho|ghu|ghs|github_pat|ya29|secret|ntn)[-_][\w-]{6,}/gi,
  /\b[A-Za-z0-9_\-.]{40,}\b/g,
  /\bGOCSPX-[\w-]{6,}/g, // Google OAuth client secret
  /\b1\/\/[\w-]{20,}/g, // Google refresh token
]

/**
 * Remove credential values and secret-shaped strings from text.
 * @param {string} text
 * @param {string[]} [secrets] exact values to remove
 */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '')
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[redacted]')
  }
  for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]')
  return out
}

/** A short piece of outside text that is shown, not read as a document: title, author. */
const cleanLabel = (s) => neutraliseControlTags(stripHiddenText(s).text).replace(/[\r\n]+/g, ' ')

/**
 * The document id in a deletion marker, or null when it is not a usable one
 * (same rules as a document id in interface.mjs normaliseDocument).
 */
export function deletionId(v) {
  if (typeof v !== 'string' || !v.length || v.length > 512 || /[\u0000-\u001f]/.test(v)) return null
  return v
}

const STATE_FOR_CODE = {
  'auth': 'attention', 'revoked': 'attention', 'not-connected': 'attention',
  'not-granted': 'attention', 'disabled': 'attention', 'frozen': 'attention',
  'consent-denied': 'attention', 'setup-needed': 'attention',
}

/**
 * @param {{
 *   credentials?: ReturnType<typeof createMemoryCredentialStore>,
 *   grants?: ReturnType<typeof createGrants>,
 *   log?: Pick<Console, 'error' | 'warn'>,
 *   fetch?: typeof globalThis.fetch,      handed to adapter factories
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onErase?: (connectorId: string) => void | Promise<void>,   the document store's erase (C02)
 *   approve?: (request: { connectorId: string, tool: string, input: unknown }) => Promise<boolean>,
 *   maxDocsPerSync?: number,
 * }} [opts]
 */
export function createConnectorRegistry({
  credentials = createMemoryCredentialStore(),
  grants = createGrants(),
  log = console,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  onErase = null,
  approve = null,
  maxDocsPerSync = 5000,
} = {}) {
  const connectors = new Map() // id -> connector
  const toolsOf = new Map() // id -> Map(toolName -> tool)
  const health = new Map() // id -> { lastSync?, error? }
  const failures = []

  const secretsOf = (id) => {
    try {
      return credentials.describe(id).keys.map(({ key }) => credentials.get(id, key)).filter(Boolean)
    } catch {
      return []
    }
  }

  /** Turn anything thrown into a ConnectorError, logging a scrubbed developer note. */
  const failure = (id, err) => {
    const e = err instanceof ConnectorError ? err : new ConnectorError('other')
    const note = scrubSecrets(err?.detail ?? err?.message ?? String(err), secretsOf(id))
    log?.warn?.(`[jarvis] connector ${id}: ${e.code}${note ? ` (${note})` : ''}`)
    health.set(id, { ...health.get(id), error: { code: e.code, message: e.message, at: now() } })
    return { code: e.code, message: e.message, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) }
  }

  const blocked = (code) => ({ code, message: ERROR_MESSAGES[code] })

  /** Why this connector may not use this capability right now, or null. */
  const gate = (id, capability) => {
    if (!connectors.has(id)) return blocked('other')
    if (grants.isFrozen()) return blocked('frozen')
    if (grants.isDisabled(id)) return blocked('disabled')
    if (!grants.has(id, capability)) return blocked('not-granted')
    return null
  }

  function checkTools(c) {
    const map = new Map()
    if (typeof c.tools !== 'function') return map
    const list = c.tools()
    if (!Array.isArray(list)) throw new Error(`${c.id}.tools() must return an array`)
    for (const t of list) {
      const p = toolProblems(t)
      if (p.length) throw new Error(`${c.id}: ${p.join('; ')}`)
      if (c.capabilities[t.capability] !== true) throw new Error(`${c.id}: tool ${t.name} needs ${t.capability}, which the connector does not declare`)
      if (t.capability === 'read' && (!isReadName(t.name) || isVetoed(CONNECTOR_SERVER, t.name))) {
        throw new Error(`${c.id}: read tool ${t.name} must begin with a read verb and contain no action verb`)
      }
      if (t.capability === 'subscribe' && isVetoed(CONNECTOR_SERVER, t.name)) {
        throw new Error(`${c.id}: subscribe tool ${t.name} contains an action verb`)
      }
      if (map.has(t.name)) throw new Error(`${c.id}: duplicate tool ${t.name}`)
      map.set(t.name, Object.freeze({ ...t }))
    }
    return map
  }

  const registry = {
    /**
     * Register one connector, or a factory `{ id, create(ctx) }`. Never throws:
     * returns `{ ok: true, id }` or `{ ok: false, id, error }`.
     */
    register(entry) {
      const id = typeof entry?.id === 'string' ? entry.id : '(unnamed)'
      try {
        let c = entry
        if (typeof entry?.create === 'function') {
          const prefix = `[jarvis] connector ${id}:`
          c = entry.create({
            id,
            credentials: credentials.scoped(id),
            fetch,
            sleep,
            now,
            log: { warn: (...a) => log?.warn?.(prefix, ...a), error: (...a) => log?.error?.(prefix, ...a) },
          })
          if (c?.id !== id) throw new Error(`factory ${id} built a connector with a different id`)
        }
        const problems = connectorProblems(c)
        if (problems.length) throw new Error(problems.join('; '))
        if (connectors.has(c.id)) throw new Error(`${c.id} is already registered`)
        const tools = checkTools(c)
        grants.init(c.id, c.capabilities)
        connectors.set(c.id, c)
        toolsOf.set(c.id, tools)
        health.set(c.id, {})
        return { ok: true, id: c.id }
      } catch (err) {
        const message = scrubSecrets(err?.message ?? String(err))
        log?.error?.(`[jarvis] connector ${id} not registered: ${message}`)
        failures.push({ id, error: message })
        return { ok: false, id, error: message }
      }
    },

    /** Register several; one failure never stops the others. */
    registerAll(entries) {
      return (entries ?? []).map((e) => registry.register(e))
    },

    has: (id) => connectors.has(id),
    get(id) {
      const c = connectors.get(id)
      if (!c) throw new Error(`No connector called ${id}.`)
      return c
    },
    /** Connectors that failed to register, for Diagnostics. */
    failures: () => failures.map((f) => ({ ...f })),
    grants,

    /** Status for the Settings card: the adapter's view, overridden by switches and the last error. */
    status(id) {
      const c = registry.get(id)
      const h = health.get(id) ?? {}
      const base = { lastSync: h.lastSync }
      if (grants.isFrozen()) return { ...base, state: 'attention', detail: ERROR_MESSAGES.frozen }
      if (grants.isDisabled(id)) return { ...base, state: 'attention', detail: ERROR_MESSAGES.disabled }
      if (h.error) return { ...base, state: STATE_FOR_CODE[h.error.code] ?? 'error', detail: h.error.message, code: h.error.code }
      try {
        const s = c.status() ?? {}
        return {
          state: ['ok', 'attention', 'error', 'disconnected'].includes(s.state) ? s.state : 'error',
          detail: scrubSecrets(String(s.detail ?? ''), secretsOf(id)).slice(0, 300),
          lastSync: h.lastSync ?? s.lastSync,
        }
      } catch (err) {
        return { ...base, state: 'error', detail: failure(id, err).message }
      }
    },

    /** One summary per connector, for Settings and Diagnostics. Never includes secrets. */
    list() {
      return [...connectors.values()].map((c) => ({
        id: c.id, name: c.name, kind: c.kind, auth: c.auth, risk: c.risk, platforms: [...c.platforms],
        capabilities: { ...c.capabilities },
        pattern: patternOf(c.auth),
        setup: c.setup ? structuredClone(c.setup) : null,
        canTest: typeof c.test === 'function' || typeof c.sync === 'function',
        canSync: typeof c.sync === 'function',
        // A tool provider (like the built-in documents search) keeps nothing of its own.
        erasable: typeof onErase === 'function' && c.kind !== 'tool-provider',
        grants: grants.of(c.id),
        disabled: grants.isDisabled(c.id),
        credentials: credentials.describe(c.id),
        tools: [...toolsOf.get(c.id).values()].map((t) => ({ name: t.name, capability: t.capability })),
        status: registry.status(c.id),
      }))
    },

    /** Run the connector's setup flow. Returns `{ ok, result? , error? }`. */
    async connect(id, opts = {}) {
      const c = registry.get(id)
      if (grants.isFrozen()) return { ok: false, error: blocked('frozen') }
      if (grants.isDisabled(id)) return { ok: false, error: blocked('disabled') }
      try {
        const result = await c.connect(opts)
        health.set(id, { ...health.get(id), error: null })
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: failure(id, err) }
      }
    },

    /**
     * Disconnect: the adapter lets go, its credentials are deleted, and with
     * `eraseData` its synced documents are erased through `onErase`.
     */
    async disconnect(id, { eraseData = false } = {}) {
      const c = registry.get(id)
      let error = null
      try {
        await c.disconnect({ eraseData })
      } catch (err) {
        error = failure(id, err)
      }
      credentials.deleteAll(id)
      let erased = false
      if (eraseData && typeof onErase === 'function') {
        try {
          await onErase(id)
          erased = true
        } catch (err) {
          error = error ?? failure(id, err)
        }
      }
      if (!error) health.set(id, { error: null })
      return { ok: !error, erased, ...(error ? { error } : {}) }
    },

    /**
     * The card's Test button (task C03). Never throws. Uses the adapter's own
     * `test()` probe when it has one; otherwise reads the first synced item
     * (through the same gate as sync, so it needs the read grant) and keeps
     * nothing. Returns `{ ok, detail }` or `{ ok: false, error }`.
     */
    async test(id) {
      if (!connectors.has(id)) return { ok: false, error: blocked('other') }
      const c = connectors.get(id)
      if (grants.isFrozen()) return { ok: false, error: blocked('frozen') }
      if (grants.isDisabled(id)) return { ok: false, error: blocked('disabled') }
      try {
        if (typeof c.test === 'function') {
          const r = (await c.test()) ?? {}
          health.set(id, { ...health.get(id), error: null })
          const detail = typeof r.detail === 'string' ? cleanLabel(scrubSecrets(r.detail, secretsOf(id))).slice(0, 300) : ''
          return { ok: true, detail: detail || 'Working.' }
        }
        if (typeof c.sync === 'function') {
          const stop = gate(id, 'read')
          if (stop) return { ok: false, error: stop }
          let found = false
          for await (const item of c.sync({})) {
            if (item && typeof item === 'object' && 'text' in item) {
              found = true
              break
            }
          }
          health.set(id, { ...health.get(id), error: null })
          return { ok: true, detail: found ? 'Working: it can read at least one item.' : 'Working, but there is nothing to read yet.' }
        }
        const s = registry.status(id)
        return s.state === 'ok' ? { ok: true, detail: s.detail || 'Working.' } : { ok: false, error: { code: 'other', message: s.detail || ERROR_MESSAGES.other } }
      } catch (err) {
        return { ok: false, error: failure(id, err) }
      }
    },

    /**
     * Erase what JARVIS keeps from this connector (the document store, via
     * `onErase`) without disconnecting it. Works while frozen or switched
     * off: erasing must always be possible.
     */
    async erase(id) {
      registry.get(id)
      if (typeof onErase !== 'function') return { ok: false, erased: false, error: { code: 'other', message: 'There is no local store to erase.' } }
      try {
        await onErase(id)
        return { ok: true, erased: true }
      } catch (err) {
        return { ok: false, erased: false, error: failure(id, err) }
      }
    },

    /** Where credentials are kept: 'keychain' | 'dev-file' | 'memory' | 'unavailable'. */
    credentialBackend: () => credentials.backend,

    /**
     * Pull documents. Never throws. Each document is validated (bad ones are
     * dropped and counted) and its text wrapped as untrusted. The adapter may
     * yield `{ cursor }` checkpoints; the last one is returned so the next
     * sync can resume. It may also yield `{ deleted: '<doc id>' }` when an
     * item is gone at the source (task C96); those come back in `deleted` as
     * `{ connectorId, id }`, tagged with this connector so the store can only
     * remove this connector's own copy. The later of a document and a marker
     * for the same id wins. A kill switch thrown mid-sync stops it at once.
     */
    async sync(id, { since, cursor } = {}) {
      const result = { ok: false, documents: [], deleted: [], dropped: 0, cursor: cursor ?? null }
      if (!connectors.has(id)) return { ...result, error: blocked('other') }
      const c = connectors.get(id)
      const stop = gate(id, 'read')
      if (stop) return { ...result, error: stop }
      if (typeof c.sync !== 'function') return { ...result, ok: true }
      try {
        for await (const item of c.sync({ since, cursor })) {
          const mid = gate(id, 'read')
          if (mid) return { ...result, error: mid }
          if (item && typeof item === 'object' && typeof item.cursor === 'string' && !('text' in item) && !('deleted' in item)) {
            result.cursor = item.cursor
            continue
          }
          if (item && typeof item === 'object' && 'deleted' in item && !('text' in item)) {
            const docId = deletionId(item.deleted)
            if (docId === null) {
              result.dropped++
              continue
            }
            result.documents = result.documents.filter((d) => d.id !== docId)
            if (!result.deleted.some((d) => d.id === docId)) result.deleted.push({ connectorId: id, id: docId })
          } else {
            const n = normaliseDocument(item, { defaultSensitivity: c.defaultSensitivity })
            if (!n.ok) {
              result.dropped++
              continue
            }
            result.deleted = result.deleted.filter((d) => d.id !== n.doc.id)
            result.documents.push(registry.untrustedDocument(id, n.doc))
          }
          if (result.documents.length + result.deleted.length >= maxDocsPerSync) break
        }
      } catch (err) {
        return { ...result, error: failure(id, err) }
      }
      health.set(id, { lastSync: now(), error: null })
      return { ...result, ok: true }
    },

    /** A document as it leaves the registry: text wrapped, labels cleaned, source named. */
    untrustedDocument(id, doc) {
      const out = {
        ...doc,
        connectorId: id,
        text: wrapUntrusted(doc.text, `connector:${id}`),
        untrusted: true,
        travel: travelOf(doc.sensitivity),
      }
      if (doc.title) out.title = cleanLabel(doc.title)
      if (doc.author) out.author = cleanLabel(doc.author)
      return out
    },

    /**
     * Tools offered to brains (plan 38 ToolManifest), only for active
     * connectors and granted capabilities. Write tools are listed as not
     * read-only; the policy engine still decides each call.
     */
    tools() {
      const out = []
      if (grants.isFrozen()) return out
      for (const [id, tools] of toolsOf) {
        if (grants.isDisabled(id)) continue
        const c = connectors.get(id)
        for (const t of tools.values()) {
          if (!grants.has(id, t.capability)) continue
          out.push({
            name: connectorMcpName(id, t.capability, t.name),
            server: CONNECTOR_SERVER,
            description: `${c.name}: ${t.description}`,
            readOnly: t.capability !== 'write',
            risk: t.capability === 'write' ? (c.risk === 'R3' ? 'R3' : 'R2') : c.risk,
            params: t.params ? structuredClone(t.params) : {},
          })
        }
      }
      return out
    },

    /**
     * The policy engine's question about one connector tool (policy.mjs calls
     * this for server `jarvis_connectors`). `tool` is the part after
     * `mcp__jarvis_connectors__`. Returns `{ allow, rule }`; anything unknown
     * is denied.
     */
    policyRule(tool, { allowWrites = false } = {}) {
      const p = parseConnectorTool(tool)
      if (!p) return { allow: false, rule: 'connector-malformed' }
      if (grants.isFrozen()) return { allow: false, rule: 'connector-frozen' }
      const t = toolsOf.get(p.connectorId)?.get(p.tool)
      if (!t || t.capability !== p.capability) return { allow: false, rule: 'connector-unknown' }
      if (grants.isDisabled(p.connectorId)) return { allow: false, rule: 'connector-disabled' }
      if (!grants.has(p.connectorId, p.capability)) return { allow: false, rule: 'connector-not-granted' }
      if (p.capability === 'write') return { allow: allowWrites === true, rule: 'connector-write' }
      return { allow: true, rule: `connector-${p.capability}` }
    },

    /**
     * Run a connector tool and return an MCP-style result with its text
     * wrapped as untrusted. The policy rule is checked again here (the gate
     * in front is not assumed), and a write also needs `approve()` to say yes
     * for this exact call.
     */
    async callTool(name, input, { allowWrites = false } = {}) {
      const p = parseConnectorTool(name)
      const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
      if (!p) return refuse('Unknown connector tool.')
      const rule = registry.policyRule(connectorToolName(p.connectorId, p.capability, p.tool), { allowWrites })
      if (!rule.allow) {
        const code = { 'connector-frozen': 'frozen', 'connector-disabled': 'disabled', 'connector-not-granted': 'not-granted', 'connector-write': 'not-granted' }[rule.rule] ?? 'other'
        return refuse(ERROR_MESSAGES[code])
      }
      if (p.capability === 'write') {
        let ok = false
        try {
          ok = typeof approve === 'function' && (await approve({ connectorId: p.connectorId, tool: p.tool, input })) === true
        } catch {
          ok = false
        }
        if (!ok) return refuse('Not done: the owner did not approve it.')
      }
      const t = toolsOf.get(p.connectorId).get(p.tool)
      try {
        const value = await t.run(input ?? {})
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
        return { content: [{ type: 'text', text: wrapUntrusted(text, `connector:${p.connectorId}`) }] }
      } catch (err) {
        return refuse(failure(p.connectorId, err).message)
      }
    },
  }
  return registry
}
