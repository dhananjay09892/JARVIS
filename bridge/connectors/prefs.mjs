/**
 * The owner's choices about synced documents (task C95), set on the Settings →
 * Connectors card and kept beside the grants in connectors.json (no secrets):
 *
 *   - allowVault: may the brain read health and finance documents? Off by
 *     default: the default brain is a cloud model and plan 38 keeps the vault
 *     on this device. The documents connector asks `allowVault()` on every call.
 *   - retention per sensitivity class and per connector, in days. A change is
 *     applied to the document store at once (a shorter one prunes now).
 *
 * The store also keeps per-connector retention in its own table; this module
 * is the source of truth and lines the store up with it at startup.
 */
import { CONNECTOR_ID, SENSITIVITY_CLASSES } from './interface.mjs'
import { DEFAULT_RETENTION_DAYS } from './store.mjs'

export const MAX_RETENTION_DAYS = 3650

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const validDays = (v) => Number.isInteger(v) && v > 0 && v <= MAX_RETENTION_DAYS

/**
 * Saved preferences, cleaned: unknown classes, bad ids and bad numbers are
 * dropped, so a hand-edited file can never widen anything by accident.
 * @returns {{ allowVault: boolean, classes: Record<string, number>, connectors: Record<string, number> }}
 */
export function normaliseDocumentPrefs(raw) {
  const out = { allowVault: false, classes: {}, connectors: {} }
  if (!isObject(raw)) return out
  out.allowVault = raw.allowVault === true
  if (isObject(raw.classes)) {
    for (const [k, v] of Object.entries(raw.classes)) {
      if (SENSITIVITY_CLASSES.includes(k) && validDays(v)) out.classes[k] = v
    }
  }
  if (isObject(raw.connectors)) {
    for (const [k, v] of Object.entries(raw.connectors)) {
      if (CONNECTOR_ID.test(k) && validDays(v)) out.connectors[k] = v
    }
  }
  return out
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.mjs').openDocumentStore> | null,
 *   initial?: unknown,                       what connectors.json held
 *   persist?: (prefs: object) => void,       save the preferences
 *   log?: Pick<Console, 'error'>,
 * }} opts
 */
export function createDocumentPrefs({ store = null, initial = null, persist = null, log = console } = {}) {
  const prefs = normaliseDocumentPrefs(initial)

  const save = () => {
    if (typeof persist !== 'function') return
    try {
      persist(snapshot())
    } catch (err) {
      log?.error?.('[jarvis] could not save document preferences:', err?.message ?? err)
    }
  }
  const snapshot = () => structuredClone(prefs)

  /** Line the store up with the saved choices (startup). */
  const apply = () => {
    if (!store) return
    for (const cls of SENSITIVITY_CLASSES) {
      const want = prefs.classes[cls] ?? null
      if (store.retention().classes[cls] !== (want ?? DEFAULT_RETENTION_DAYS[cls])) store.setClassRetention(cls, want)
    }
    const current = store.retention().connectors
    for (const id of Object.keys(current)) {
      if (!(id in prefs.connectors)) store.setRetention(id, null)
    }
    for (const [id, days] of Object.entries(prefs.connectors)) {
      if (current[id] !== days) store.setRetention(id, days)
    }
  }
  apply()

  return {
    available: () => Boolean(store),
    snapshot,
    allowVault: () => prefs.allowVault === true,

    /** Days in force for a class (owner's choice or the default). */
    classDays: (cls) => prefs.classes[cls] ?? DEFAULT_RETENTION_DAYS[cls],
    /** A connector's own retention, or null when it follows the classes. */
    connectorDays: (id) => prefs.connectors[id] ?? null,

    setVault(allow) {
      prefs.allowVault = allow === true
      save()
    },

    /** Returns how many documents a shorter retention removed. */
    setClassRetention(cls, days) {
      if (!SENSITIVITY_CLASSES.includes(cls)) throw new Error(`Unknown sensitivity class: ${String(cls)}`)
      if (days !== null && !validDays(days)) throw new Error('Retention must be 1 to 3650 days, or null.')
      const removed = store ? store.setClassRetention(cls, days) : 0
      if (days === null || days === DEFAULT_RETENTION_DAYS[cls]) delete prefs.classes[cls]
      else prefs.classes[cls] = days
      save()
      return removed
    },

    setConnectorRetention(id, days) {
      if (typeof id !== 'string' || !CONNECTOR_ID.test(id)) throw new Error(`Bad connector id: ${String(id)}`)
      if (days !== null && !validDays(days)) throw new Error('Retention must be 1 to 3650 days, or null.')
      const removed = store ? store.setRetention(id, days) : 0
      if (days === null) delete prefs.connectors[id]
      else prefs.connectors[id] = days
      save()
      return removed
    },

    /** Document counts per connector (no text), or {} without a store. */
    stats: () => (store ? store.stats() : {}),

    /** What the Settings card shows. */
    view() {
      return {
        available: Boolean(store),
        allowVault: prefs.allowVault === true,
        retention: {
          defaults: { ...DEFAULT_RETENTION_DAYS },
          classes: Object.fromEntries(SENSITIVITY_CLASSES.map((c) => [c, prefs.classes[c] ?? DEFAULT_RETENTION_DAYS[c]])),
          connectors: { ...prefs.connectors },
        },
      }
    },
  }
}
