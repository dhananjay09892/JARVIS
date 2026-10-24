/**
 * Settings → Connectors (task C03; plan 39 section 6): the HTTP routes the
 * Settings card talks to, kept apart from server.mjs so they can be tested
 * with the fake connector and no network.
 *
 *   GET  /connectors                       every card: status, scopes, "what it can see", last sync
 *   POST /connectors/freeze                { frozen: true } | { frozen: false, confirm: true }
 *   POST /connectors/:id/connect           the connect pattern's fields (see CONNECT_BODY)
 *   POST /connectors/:id/test              the Test button
 *   POST /connectors/:id/disconnect        { eraseData?: boolean }
 *   POST /connectors/:id/erase             { confirm: true }  erase local data, stay connected
 *   POST /connectors/:id/enabled           { enabled: boolean }  the per-connector kill switch
 *   POST /connectors/:id/grants            { capability, granted, confirm? }  write needs confirm
 *   POST /connectors/:id/retention         { days: number|null, confirm? }  shorter needs confirm
 *   POST /connectors/vault                 { allow: boolean, confirm? }  allow needs confirm
 *   POST /connectors/retention             { class, days: number|null, confirm? }  shorter needs confirm
 *
 * GET also carries `documents` (the vault switch and retention, task C95), a
 * document count on each card, and `health`, the plan 16 connector-health
 * metric (how many cards are in `attention` or `error`).
 *
 * Rules this module keeps:
 *   - Tokens go only to the adapter's connect(), which stores them through the
 *     credential store. They are never written to settings, logged, or sent
 *     back: every response is scrubbed of the pasted value.
 *   - Cards carry no secrets: credential *names* and "set", never values.
 *   - Turning things on that widen access (unfreeze, the write grant) needs an
 *     explicit `confirm: true`; turning things off never does.
 *   - A write grant still isn't enough to write: the policy engine also wants
 *     general writes (JARVIS_ALLOW_WRITES) and an approval for each call.
 *   - Grants and switches are saved through `persist` (no secrets in them), so
 *     they survive a restart; see createGrantsFile below.
 *
 * `handle()` returns `{ status, body }`, or null for a path that is not ours.
 * The server checks the Origin before calling it for anything but GET.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CAPABILITIES, CONNECTOR_ID, SENSITIVITY_CLASSES } from './interface.mjs'
import { ERROR_MESSAGES } from './http.mjs'
import { scrubSecrets } from './registry.mjs'
import { validDays } from './prefs.mjs'
import { DEFAULT_RETENTION_DAYS } from './store.mjs'

const MAX_TOKEN = 16_384
const MAX_PATH = 1024

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ok = (body) => ({ status: 200, body: { ok: true, ...body } })
const bad = (reason, status = 400) => ({ status, body: { ok: false, reason } })

/**
 * The fields each connect pattern may send, checked and copied so nothing else
 * reaches an adapter. Returns `{ opts }` or `{ error }`.
 */
export const CONNECT_BODY = Object.freeze({
  token(body) {
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) return { error: 'Paste the token or key first.' }
    if (token.length > MAX_TOKEN) return { error: 'That token is too long.' }
    return { opts: { token }, secrets: [token] }
  },
  local(body) {
    if (body.confirmed !== true) return { error: 'Confirm that JARVIS may read this first.' }
    const opts = { confirmed: true }
    if (body.path !== undefined) {
      if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > MAX_PATH || /[\u0000-\u001f]/.test(body.path)) {
        return { error: 'That folder path is not valid.' }
      }
      opts.path = body.path.trim()
    }
    return { opts }
  },
  oauth: () => ({ opts: {} }),
  none: () => ({ opts: {} }),
})

/**
 * What a connect() result may tell the page: an account label, an https link
 * to open for a guided sign-in, a short note. Everything else is dropped.
 */
export function connectResultForPage(result, secrets = []) {
  const out = {}
  if (!isObject(result)) return out
  const clean = (s, max) => scrubSecrets(String(s), secrets).replace(/[\r\n\u0000-\u001f]+/g, ' ').slice(0, max)
  if (typeof result.account === 'string' && result.account) out.account = clean(result.account, 100)
  if (typeof result.detail === 'string' && result.detail) out.detail = clean(result.detail, 300)
  if (typeof result.url === 'string' && result.url.length <= 2048) {
    try {
      const u = new URL(result.url)
      if (u.protocol === 'https:' && !u.username && !u.password) out.url = u.href
    } catch {
      /* not a link: dropped */
    }
  }
  return out
}

/**
 * Plan 16's connector-health metric: how many registered connectors are in
 * each state, and how many need the owner (`attention` or `error`). Counted
 * from the cards, so it is what Settings shows. Target: 0 needing attention.
 * @param {{ id: string, status: { state: string }, disabled?: boolean }[]} cards
 */
export function connectorHealth(cards, { frozen = false } = {}) {
  const out = { total: 0, ok: 0, attention: 0, error: 0, disconnected: 0, off: 0, needsAttention: 0, ids: [] }
  for (const c of cards ?? []) {
    out.total++
    const state = c?.status?.state
    if (['ok', 'attention', 'error', 'disconnected'].includes(state)) out[state]++
    if (c?.disabled) out.off++
    if (state === 'attention' || state === 'error') {
      out.needsAttention++
      out.ids.push(c.id)
    }
  }
  out.frozen = frozen === true
  return out
}

/** One card, as the page sees it. registry.list() already holds no secrets. */
function card(summary, backend, docs = null) {
  const extra = {}
  if (docs) {
    const stats = docs.stats()[summary.id]
    extra.documents = summary.erasable
      ? { count: stats?.total ?? 0, classes: stats?.classes ?? {}, retentionDays: docs.connectorDays(summary.id) }
      : null
  }
  return { ...summary, credentialBackend: backend, ...extra }
}

/**
 * @param {{
 *   registry: ReturnType<typeof import('./registry.mjs').createConnectorRegistry>,
 *   persist?: (snapshot: object) => void,     save grants and switches
 *   documents?: ReturnType<typeof import('./prefs.mjs').createDocumentPrefs> | null,
 *   log?: Pick<Console, 'warn' | 'error'>,
 * }} opts
 */
export function createConnectorRoutes({ registry, persist = null, documents = null, log = console }) {
  const save = () => {
    if (typeof persist !== 'function') return
    try {
      persist(registry.grants.snapshot())
    } catch (err) {
      log?.error?.('[jarvis] could not save connector switches:', err?.message ?? err)
    }
  }

  const cards = () => {
    const backend = registry.credentialBackend()
    const list = registry.list().map((s) => card(s, backend, documents))
    const frozen = registry.grants.isFrozen()
    return {
      frozen,
      credentialBackend: backend,
      connectors: list,
      failures: registry.failures(),
      documents: documents ? documents.view() : null,
      health: connectorHealth(list, { frozen }),
    }
  }
  const one = (id) => card(registry.list().find((c) => c.id === id), registry.credentialBackend(), documents)

  /** `days` from a body: a whole number of days, or null for "the default". */
  const daysOf = (body) => {
    if (body.days === null) return { days: null }
    if (!validDays(body.days)) return { error: 'Keep documents for 1 to 3650 whole days, or choose the default.' }
    return { days: body.days }
  }
  const noStore = () => bad('Synced documents are not available on this computer.', 409)
  /** A store failure (disk, lock) becomes a plain 500, never a thrown request. */
  const guarded = (what, fn) => {
    try {
      return fn()
    } catch (err) {
      log?.error?.(`[jarvis] connector ${what}:`, scrubSecrets(err?.message ?? String(err)))
      return { status: 500, body: { ok: false, reason: ERROR_MESSAGES.other } }
    }
  }

  /** What the page sees after any change: the changed card and the freeze. */
  const after = (id, extra = {}) => ok({ ...extra, frozen: registry.grants.isFrozen(), connector: one(id) })

  const actions = {
    async connect(id, body) {
      const c = registry.list().find((x) => x.id === id)
      const parse = CONNECT_BODY[c.pattern] ?? CONNECT_BODY.none
      const { opts, error, secrets = [] } = parse(body)
      if (error) return bad(error)
      const r = await registry.connect(id, opts)
      if (!r.ok) return { status: 200, body: { ok: false, reason: scrubSecrets(r.error.message, secrets), code: r.error.code, connector: one(id) } }
      return after(id, { result: connectResultForPage(r.result, secrets) })
    },
    async test(id) {
      const r = await registry.test(id)
      if (!r.ok) return { status: 200, body: { ok: false, reason: r.error.message, code: r.error.code, connector: one(id) } }
      return after(id, { detail: r.detail })
    },
    async disconnect(id, body) {
      if (body.eraseData !== undefined && typeof body.eraseData !== 'boolean') return bad('eraseData must be true or false.')
      const r = await registry.disconnect(id, { eraseData: body.eraseData === true })
      if (!r.ok) return { status: 200, body: { ok: false, reason: r.error.message, code: r.error.code, erased: r.erased, connector: one(id) } }
      return after(id, { erased: r.erased })
    },
    async erase(id, body) {
      if (body.confirm !== true) return bad('Confirm that you want this connector’s data erased.')
      const r = await registry.erase(id)
      if (!r.ok) return { status: 200, body: { ok: false, reason: r.error.message, erased: false, connector: one(id) } }
      return after(id, { erased: true })
    },
    async enabled(id, body) {
      if (typeof body.enabled !== 'boolean') return bad('enabled must be true or false.')
      if (body.enabled) registry.grants.enable(id)
      else registry.grants.disable(id)
      save()
      return after(id)
    },
    async grants(id, body) {
      const { capability, granted } = body
      if (!CAPABILITIES.includes(capability)) return bad('Unknown permission.')
      if (typeof granted !== 'boolean') return bad('granted must be true or false.')
      if (granted) {
        if (capability === 'write' && body.confirm !== true) {
          return bad('Letting a connector make changes needs your confirmation.')
        }
        const c = registry.list().find((x) => x.id === id)
        if (c.capabilities[capability] !== true) return bad(`This connector cannot ${capability}.`)
        registry.grants.grant(id, capability)
      } else {
        registry.grants.revoke(id, capability)
      }
      save()
      return after(id)
    },
    async retention(id, body) {
      if (!documents?.available()) return noStore()
      const c = registry.list().find((x) => x.id === id)
      if (!c.erasable) return bad('This connector keeps no documents.')
      const { days, error } = daysOf(body)
      if (error) return bad(error)
      // A shorter time, the first one set, or going back to the class
      // defaults can each delete documents at once.
      const current = documents.connectorDays(id)
      const mayDelete = days === null ? current !== null : current === null || days < current
      if (mayDelete && body.confirm !== true) {
        return bad('A shorter retention deletes older documents now; confirm first.')
      }
      const removed = documents.setConnectorRetention(id, days)
      return after(id, { removed })
    },
  }

  return {
    /**
     * @param {{ method: string, path: string, body?: unknown }} req
     * @returns {Promise<{ status: number, body: object } | null>}
     */
    async handle({ method, path, body }) {
      if (path !== '/connectors' && !path.startsWith('/connectors/')) return null
      if (path === '/connectors') {
        if (method !== 'GET') return bad('Use GET.', 405)
        return { status: 200, body: cards() }
      }
      if (method !== 'POST') return bad('Use POST.', 405)
      const input = body === undefined || body === null ? {} : body
      if (!isObject(input)) return bad('Send a JSON object.')

      if (path === '/connectors/vault') {
        if (!documents?.available()) return noStore()
        if (typeof input.allow !== 'boolean') return bad('allow must be true or false.')
        if (input.allow && input.confirm !== true) {
          return bad('Letting the brain read health and finance documents needs your confirmation.')
        }
        return guarded('vault', () => {
          documents.setVault(input.allow)
          return ok({ documents: documents.view() })
        })
      }

      if (path === '/connectors/retention') {
        if (!documents?.available()) return noStore()
        if (!SENSITIVITY_CLASSES.includes(input.class)) return bad('Unknown kind of document.')
        const { days, error } = daysOf(input)
        if (error) return bad(error)
        const next = days ?? DEFAULT_RETENTION_DAYS[input.class]
        if (next < documents.classDays(input.class) && input.confirm !== true) {
          return bad('A shorter retention deletes older documents now; confirm first.')
        }
        return guarded('retention', () => ok({ removed: documents.setClassRetention(input.class, days), documents: documents.view() }))
      }

      if (path === '/connectors/freeze') {
        if (typeof input.frozen !== 'boolean') return bad('frozen must be true or false.')
        if (input.frozen) registry.grants.freezeAll()
        else {
          if (input.confirm !== true) return bad('Unfreezing every connector needs your confirmation.')
          registry.grants.unfreezeAll()
        }
        save()
        return ok({ frozen: registry.grants.isFrozen() })
      }

      const m = /^\/connectors\/([^/]+)\/([a-z]+)$/.exec(path)
      if (!m) return bad('Not found.', 404)
      const [, id, action] = m
      if (!CONNECTOR_ID.test(id) || !registry.has(id)) return bad('No connector called that.', 404)
      const run = Object.hasOwn(actions, action) ? actions[action] : null
      if (!run) return bad('Not found.', 404)
      try {
        return await run(id, input)
      } catch (err) {
        // Grants throw only on programming errors; never echo adapter text.
        log?.error?.(`[jarvis] connector ${id} ${action}:`, scrubSecrets(err?.message ?? String(err)))
        return { status: 500, body: { ok: false, reason: ERROR_MESSAGES.other } }
      }
    },
  }
}

/**
 * Where grants, kill switches and document preferences are kept between runs:
 * a small JSON file beside settings. No secrets in it — only which connector
 * may read, write or subscribe, which are switched off, the freeze, whether
 * health and finance documents may reach the brain, and retention days.
 * `save()` and `saveDocuments()` each replace only their own part.
 * @param {string} file
 */
export function createGrantsFile(file) {
  const read = () => {
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return isObject(parsed) && parsed.v === 1 ? parsed : null
    } catch {
      return null
    }
  }
  const write = (patch) => {
    const current = read() ?? {}
    const next = { v: 1, grants: current.grants ?? null, documents: current.documents ?? null, ...patch }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows: mode is advisory */ }
    renameSync(tmp, file)
  }
  return {
    file,
    load: () => read()?.grants ?? null,
    loadDocuments: () => read()?.documents ?? null,
    save: (snapshot) => write({ grants: snapshot }),
    saveDocuments: (prefs) => write({ documents: prefs }),
  }
}
