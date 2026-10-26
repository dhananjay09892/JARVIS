/**
 * Warm the connection to the cloud voice before the first sentence needs it
 * (plan 05 phase 2, "keep connections warm").
 *
 * Node's fetch keeps connections to a host alive only for a few seconds after
 * the last request. Turns are usually further apart than that, so the first
 * sentence of nearly every answer paid for DNS, TCP and TLS to ElevenLabs on
 * top of the speech itself. The page now asks for a warm-up as a turn starts;
 * the model takes at least as long to write a first sentence as the handshake
 * takes, so by the time /tts is called the connection is already open and is
 * reused from the pool.
 *
 * The warm-up is a HEAD request to the API's root with no key, no text and no
 * body: nothing about the user or the conversation leaves the machine. It never
 * throws, and is throttled so a burst of turns opens one connection, not many.
 */

export const WARM_URL = 'https://api.elevenlabs.io/'

/** Within this long of the last warm-up the pooled connection is still open. */
export const WARM_INTERVAL_MS = 2_000

/** A warm-up that takes longer than this is not helping anyone; let it go. */
export const WARM_TIMEOUT_MS = 3_000

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {string}  [deps.url]
 * @param {number}  [deps.intervalMs]
 * @param {number}  [deps.timeoutMs]
 * @param {() => number} [deps.clock]
 */
export function createVoiceWarmer({
  fetch: doFetch = globalThis.fetch,
  url = WARM_URL,
  intervalMs = WARM_INTERVAL_MS,
  timeoutMs = WARM_TIMEOUT_MS,
  clock = () => Date.now(),
} = {}) {
  let last = -Infinity
  let inFlight = null
  const counts = { warmed: 0, skipped: 0, failed: 0 }

  return {
    /**
     * Open (or refresh) the pooled connection. Resolves to 'warmed',
     * 'skipped' (one is in flight or was made a moment ago) or 'failed'.
     */
    warm() {
      const now = clock()
      if (inFlight || now - last < intervalMs) {
        counts.skipped++
        return Promise.resolve('skipped')
      }
      last = now
      inFlight = (async () => {
        try {
          const res = await doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
          // A connection only goes back to the pool once its response is read.
          await res.body?.cancel?.()
          counts.warmed++
          return 'warmed'
        } catch {
          counts.failed++
          return 'failed'
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    },
    /** For Diagnostics and tests. */
    stats() {
      return { ...counts }
    },
  }
}
