/**
 * "Is there a newer JARVIS?" — compares the installed version with the latest
 * GitHub release. Notification only: nothing is downloaded or installed here.
 *
 * The request goes from this process to api.github.com and carries nothing about
 * the user. It never throws: offline, rate-limited or malformed answers all
 * mean "no update to show". Set JARVIS_UPDATE_CHECK=off to disable it entirely.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const REPO = 'dhananjay09892/JARVIS'
const TTL_MS = 6 * 60 * 60 * 1000

export function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** Parse "v1.2.3" / "1.2.3-beta" into [1, 2, 3]; null when it is not a version. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

let cached = null

export async function checkForUpdate({ fetchImpl = fetch, now = Date.now() } = {}) {
  const current = installedVersion()
  const none = { current, latest: current, updateAvailable: false, url: null, downloadUrl: null }
  if (process.env.JARVIS_UPDATE_CHECK === 'off') return { ...none, disabled: true }
  if (cached && now - cached.at < TTL_MS) return cached.value
  let value = none
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'jarvis-update-check' },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const release = await res.json()
      const latest = String(release.tag_name ?? '')
      if (parseVersion(latest) && isNewer(latest, current)) {
        value = {
          current,
          latest: latest.replace(/^v/, ''),
          updateAvailable: true,
          url: `https://github.com/${REPO}/releases/latest`,
          downloadUrl: `https://github.com/${REPO}/releases/latest/download/JARVIS-Setup.exe`,
        }
      }
    }
  } catch {
    /* offline or blocked: show nothing */
  }
  cached = { at: now, value }
  return value
}

/** Test hook. */
export const _resetUpdateCache = () => {
  cached = null
}
