/**
 * Rename a freshly written temp file over the real one, for "write a temp
 * file, then rename" saves.
 *
 * On Windows the rename is refused (EPERM, EBUSY or EACCES) for a moment when
 * another program has the new file or the old one open: an antivirus scan, the
 * search indexer, a backup tool. The file is fine a few milliseconds later, so
 * the rename is tried again a few times over a short, bounded time. This is
 * the approach graceful-fs takes, kept synchronous because every caller saves
 * synchronously.
 *
 * - Only on Windows. Elsewhere the rename runs once.
 * - Only those three error codes. Anything else is thrown at once.
 * - When the tries are used up, the first error is thrown, unchanged.
 *
 * The total wait is at most 150 ms with the defaults (10 + 20 + 30 + 40 + 50).
 */
import { renameSync } from 'node:fs'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const DEFAULT_RETRIES = 5
const DEFAULT_STEP_MS = 10

const waitCell = new Int32Array(new SharedArrayBuffer(4))
/** Block this thread for `ms` milliseconds. */
function sleepSync(ms) {
  Atomics.wait(waitCell, 0, 0, ms)
}

/**
 * @param {string} from  the temp file
 * @param {string} to    the file it replaces
 * @param {object} [options]
 * @param {number} [options.retries]   extra tries after the first refusal (default 5)
 * @param {number} [options.stepMs]    the n-th wait is n × stepMs (default 10)
 * @param {string} [options.platform]  for tests; defaults to process.platform
 * @param {(from: string, to: string) => void} [options.rename]  for tests
 * @param {(ms: number) => void} [options.sleep]                 for tests
 */
export function renameWithRetry(from, to, {
  retries = DEFAULT_RETRIES,
  stepMs = DEFAULT_STEP_MS,
  platform = process.platform,
  rename = renameSync,
  sleep = sleepSync,
} = {}) {
  if (platform !== 'win32') return rename(from, to)
  let first
  for (let attempt = 0; ; attempt++) {
    try {
      return rename(from, to)
    } catch (err) {
      if (!RETRY_CODES.has(err?.code)) throw err
      first ??= err
      if (attempt >= retries) throw first
      sleep((attempt + 1) * stepMs)
    }
  }
}
