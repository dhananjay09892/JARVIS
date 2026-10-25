/**
 * Turns and errors per brain (plan 16 metric for plans 21 and 25; task Q54).
 *
 * The bridge passes every session's BrainEvents through `observe()`, which
 * counts, per brain and actor, how many turns ended and how: complete,
 * cancelled (barge-in), stopped at a limit, or failed, and the error codes
 * that ended them. Counts only: never text, tool names, arguments or keys.
 * Kept in memory since the bridge started; `GET /brains/stats` serves the
 * snapshot to Diagnostics.
 */

const REASONS = ['complete', 'cancelled', 'limit', 'error']
// An error code becomes a counter name only if it looks like one.
const CODE = /^[a-z][a-z0-9_]{0,31}$/

export function createBrainMetrics({ now = () => Date.now() } = {}) {
  const since = new Date(now()).toISOString()
  const rows = new Map() // `${brain}/${actor}` → counters

  const row = (brain, actor) => {
    const k = `${brain}/${actor}`
    let r = rows.get(k)
    if (!r) {
      r = { brain, actor, turns: 0, complete: 0, cancelled: 0, limit: 0, error: 0, errors: {} }
      rows.set(k, r)
    }
    return r
  }

  return {
    /**
     * A session's events, counted as they pass. The session object is
     * otherwise unchanged (cancel and close go to the original).
     */
    observe(brainId, actor, run) {
      const id = String(brainId)
      const who = actor === 'worker' ? 'worker' : 'voice'
      async function* events() {
        let failure = null
        for await (const e of run.events) {
          if (e?.t === 'error') failure = CODE.test(e.code) ? e.code : 'other'
          if (e?.t === 'done') {
            const r = row(id, who)
            r.turns++
            const reason = REASONS.includes(e.reason) ? e.reason : 'error'
            r[reason]++
            if (failure && reason !== 'complete' && reason !== 'cancelled') r.errors[failure] = (r.errors[failure] ?? 0) + 1
            failure = null
          }
          yield e
        }
      }
      return { ...run, events: events() }
    },

    /** Every brain's counters, for Diagnostics. */
    snapshot() {
      return {
        since,
        brains: [...rows.values()].map((r) => ({ ...r, errors: { ...r.errors } })),
      }
    },
  }
}
