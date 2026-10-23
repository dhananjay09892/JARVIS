/**
 * The connector credential store (vetting rule 5: no ambient secrets).
 *
 * One interface for every place a connector's token, key or app password can
 * live:
 *
 *   get(connectorId, key)        → string | null
 *   set(connectorId, key, value) → void
 *   delete(connectorId, key)     → void
 *   deleteAll(connectorId)       → void        disconnect / erase
 *   describe(connectorId)        → { backend, keys: [{ key, set: true }] }   never values
 *   backend                      'keychain' | 'dev-file' | 'memory' | 'unavailable'
 *
 * Adapters never see this store: the registry hands each one a *scoped* view
 * (`scoped(connectorId)`) that can only read and write its own entries, so a
 * Gmail adapter cannot ask for the Notion token.
 *
 * Where secrets actually go:
 *   - The OS keychain, once main task Q20 ("Secrets to the OS keychain") lands.
 *     `createCredentialStore({ keychain })` takes that backend when it exists.
 *   - Until then, nothing — `set()` refuses with a readable error — unless the
 *     developer opts in with JARVIS_DEV_CREDENTIALS=1. Then a clearly marked
 *     DEV-ONLY file store is used: one JSON file outside the repository, file
 *     mode 0600, refused outright if its path is inside the repo. It is not
 *     encrypted; it exists so adapters can be tried before Q20, and the
 *     Settings card says so.
 *   - Tests use the in-memory store.
 *
 * No value is ever logged, put in an error message, or returned by describe();
 * toJSON() and inspection of a store show only key names.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONNECTOR_ID } from './interface.mjs'

const KEY = /^[a-z][a-z0-9_]{0,47}$/
const MAX_VALUE = 16_384

/** The repository root, so the dev store can refuse to write inside it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function checkIds(connectorId, key) {
  if (typeof connectorId !== 'string' || !CONNECTOR_ID.test(connectorId)) throw new Error('Bad connector id for a credential.')
  if (key !== undefined && (typeof key !== 'string' || !KEY.test(key))) throw new Error('Bad credential name.')
}

function checkValue(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('A credential must be a non-empty string.')
  if (value.length > MAX_VALUE) throw new Error('That credential is too long.')
}

/** Add the methods every backend shares on top of a Map-like core. */
function storeOver(backend, core) {
  const store = {
    backend,
    get(connectorId, key) {
      checkIds(connectorId, key)
      return core.get(connectorId, key) ?? null
    },
    set(connectorId, key, value) {
      checkIds(connectorId, key)
      checkValue(value)
      core.set(connectorId, key, value)
    },
    delete(connectorId, key) {
      checkIds(connectorId, key)
      core.delete(connectorId, key)
    },
    deleteAll(connectorId) {
      checkIds(connectorId)
      for (const key of core.keys(connectorId)) core.delete(connectorId, key)
    },
    describe(connectorId) {
      checkIds(connectorId)
      return { backend, keys: core.keys(connectorId).map((key) => ({ key, set: true })) }
    },
    /** A view limited to one connector: what an adapter is given. */
    scoped(connectorId) {
      checkIds(connectorId)
      return Object.freeze({
        backend,
        get: (key) => store.get(connectorId, key),
        set: (key, value) => store.set(connectorId, key, value),
        delete: (key) => store.delete(connectorId, key),
        has: (key) => store.get(connectorId, key) !== null,
        toJSON: () => ({ backend, connectorId }),
      })
    },
    toJSON: () => ({ backend }),
    [Symbol.for('nodejs.util.inspect.custom')]: () => `CredentialStore<${backend}>`,
  }
  return Object.freeze(store)
}

/** In-memory store, for tests and for a session that must not persist anything. */
export function createMemoryCredentialStore() {
  const data = new Map()
  const bucket = (id) => data.get(id) ?? new Map()
  return storeOver('memory', {
    get: (id, key) => data.get(id)?.get(key),
    set: (id, key, value) => data.set(id, bucket(id).set(key, value)),
    delete: (id, key) => data.get(id)?.delete(key),
    keys: (id) => [...(data.get(id)?.keys() ?? [])].sort(),
  })
}

/** The store used before Q20 when the developer has not opted in: holds nothing. */
export function createUnavailableCredentialStore() {
  const refuse = () => {
    throw new Error(
      'Secure credential storage is not available yet (it arrives with the OS keychain, task Q20). ' +
      'Developers can set JARVIS_DEV_CREDENTIALS=1 to use the dev-only store.',
    )
  }
  return storeOver('unavailable', { get: () => null, set: refuse, delete: () => {}, keys: () => [] })
}

/** Default file for the dev-only store: beside settings, outside the repo. */
export function defaultDevCredentialFile(env = process.env) {
  if (env.JARVIS_DEV_CREDENTIALS_FILE) return env.JARVIS_DEV_CREDENTIALS_FILE
  const base = env.JARVIS_HOME
    || (process.platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'JARVIS') : join(homedir(), '.jarvis'))
  return join(base, 'DEV-ONLY-connector-credentials.json')
}

/** True when `file` is inside `root` (or is it). */
export function isInside(root, file) {
  const rel = relative(resolve(root), resolve(file))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * DEV-ONLY file store. Plain JSON, mode 0600, never inside the repository.
 * @param {{ file?: string, repoRoot?: string }} [opts]
 */
export function createDevFileCredentialStore({ file = defaultDevCredentialFile(), repoRoot = REPO_ROOT } = {}) {
  if (isInside(repoRoot, file)) {
    throw new Error('The dev-only credential file must live outside the repository.')
  }
  const read = () => {
    if (!existsSync(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed.connectors === 'object' && parsed.connectors ? parsed.connectors : {}
    } catch {
      // A damaged file is treated as empty rather than half-read; the error
      // must not quote the file, which holds secrets.
      return {}
    }
  }
  const write = (connectors) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const body = JSON.stringify({
      warning: 'DEV-ONLY. Plain-text connector credentials for development before the OS keychain (Q20). Do not copy into a repository.',
      connectors,
    }, null, 2)
    writeFileSync(tmp, body, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows: mode is advisory */ }
    renameSync(tmp, file)
  }
  return storeOver('dev-file', {
    get: (id, key) => read()[id]?.[key],
    set: (id, key, value) => {
      const all = read()
      all[id] = { ...(all[id] ?? {}), [key]: value }
      write(all)
    },
    delete: (id, key) => {
      const all = read()
      if (!all[id] || !(key in all[id])) return
      delete all[id][key]
      if (!Object.keys(all[id]).length) delete all[id]
      write(all)
    },
    keys: (id) => Object.keys(read()[id] ?? {}).sort(),
  })
}

/**
 * Pick the store for this process.
 *   keychain — the Q20 backend: an object with get/set/delete/keys(connectorId).
 *              When given, it always wins.
 *   env      — JARVIS_DEV_CREDENTIALS=1 opts into the dev-only file store.
 * @param {{ keychain?: any, env?: Record<string,string|undefined>, repoRoot?: string }} [opts]
 */
export function createCredentialStore({ keychain = null, env = process.env, repoRoot = REPO_ROOT } = {}) {
  if (keychain) {
    for (const m of ['get', 'set', 'delete', 'keys']) {
      if (typeof keychain[m] !== 'function') throw new Error(`The keychain backend needs ${m}().`)
    }
    return storeOver('keychain', keychain)
  }
  if (env?.JARVIS_DEV_CREDENTIALS === '1') {
    return createDevFileCredentialStore({ file: defaultDevCredentialFile(env), repoRoot })
  }
  return createUnavailableCredentialStore()
}
