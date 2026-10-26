/**
 * A connector's own settings on its Settings → Connectors card (task C97; the
 * first user is Google Drive's folder allow-list and shared-drive switch).
 * Kept in connectors.json beside the grants (no secrets in it).
 *
 * Each connector that has settings gives a definition:
 *   {
 *     fields:   [{ key, type: 'list' | 'boolean', label, help?, max? }],  what the card shows
 *     defaults: { … },                                                  values when nothing is saved
 *     check(raw)     → { values } | { error }   strict: the card's input
 *     normalise(raw) → values                   lenient: a saved file; bad entries dropped
 *   }
 * Values only ever narrow or widen what a connector reads; they never hold a
 * token. A hand-edited file is cleaned by `normalise`, so it cannot smuggle
 * anything else in.
 */
import { CONNECTOR_ID } from './interface.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Same values? (Settings are small JSON: lists of ids and switches.) */
export const sameOptions = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * @param {{
 *   definitions: Record<string, { fields: object[], defaults: object, check: (raw: unknown) => { values?: object, error?: string }, normalise: (raw: unknown) => object }>,
 *   initial?: unknown,                    what connectors.json held
 *   persist?: (all: object) => void,      save every connector's settings
 *   log?: Pick<Console, 'error'>,
 * }} opts
 */
export function createConnectorOptions({ definitions = {}, initial = null, persist = null, log = console } = {}) {
  const defs = new Map(Object.entries(definitions).filter(([id, d]) => CONNECTOR_ID.test(id) && isObject(d)
    && typeof d.check === 'function' && typeof d.normalise === 'function'))
  const values = new Map()
  for (const [id, def] of defs) {
    const saved = isObject(initial) && isObject(initial[id]) ? initial[id] : null
    values.set(id, def.normalise(saved ?? def.defaults))
  }

  const snapshot = () => Object.fromEntries([...values].map(([id, v]) => [id, structuredClone(v)]))
  const save = () => {
    if (typeof persist !== 'function') return
    try {
      persist(snapshot())
    } catch (err) {
      log?.error?.('[jarvis] could not save connector settings:', err?.message ?? err)
    }
  }

  return {
    has: (id) => defs.has(id),
    /** The settings in force for a connector (a copy), or null when it has none. */
    get: (id) => (values.has(id) ? structuredClone(values.get(id)) : null),
    /** Check the card's input: `{ values }` cleaned, or `{ error }` in plain words. */
    check(id, raw) {
      const def = defs.get(id)
      if (!def) return { error: 'This connector has no settings.' }
      const r = def.check(raw)
      if (!r || r.error || !isObject(r.values)) return { error: r?.error ?? 'Those settings are not valid.' }
      return { values: def.normalise(r.values) }
    },
    /** Would these (checked) values change anything? */
    changed: (id, next) => !sameOptions(values.get(id), next),
    set(id, next) {
      const def = defs.get(id)
      if (!def) throw new Error(`No settings for connector: ${String(id)}`)
      values.set(id, def.normalise(next))
      save()
      return structuredClone(values.get(id))
    },
    /** What the card shows: the fields and the current values; null when none. */
    view(id) {
      const def = defs.get(id)
      if (!def) return null
      return { fields: structuredClone(def.fields), values: structuredClone(values.get(id)) }
    },
    snapshot,
  }
}
