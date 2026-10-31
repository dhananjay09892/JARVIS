/**
 * Setup drop-off metric (plan 29 phase 1, plan 16; Q77).
 *
 * Where do people stop in the first-run wizard, and what does the hardware
 * self-test most often find wrong? Opt-in (JARVIS_SETUP_METRICS, off by
 * default) and local: one small JSON file beside the traces, never sent
 * anywhere.
 *
 * What an event holds, and nothing else:
 *   - a random id for one pass through the wizard (`run`),
 *   - what happened (`kind`): the wizard opened, a step was reached, the
 *     wizard was finished or skipped, or the self-test ended,
 *   - which step (a fixed word from WIZARD_STEPS),
 *   - for the self-test, the ids of what it found wrong (fixed words from
 *     FINDING_IDS, e.g. "mic-muted"). Never audio, levels, device names or
 *     labels: anything not on the lists is dropped, not stored.
 *
 * With the setting off, record() writes nothing and does not touch the file.
 * Turning it off also deletes what was kept (server.mjs calls clear()).
 *
 * Like traces.mjs this uses only Node built-ins, so it can be tested on its own.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The wizard's steps in order, kept in step with src/ui/Settings.tsx (WIZARD_STEPS there). */
export const WIZARD_STEPS = ['hardware', 'claude', 'voice', 'finish']
export const EVENT_KINDS = ['start', 'reach', 'complete', 'skip', 'selftest']
/**
 * Every finding the self-test can report that is not "ok", kept in step with
 * src/lib/selftest.ts (a test checks this). Only these words are stored.
 */
export const FINDING_IDS = [
  'mic-unsupported', 'mic-blocked', 'mic-none', 'mic-busy', 'mic-error',
  'mic-virtual', 'mic-muted', 'mic-wrong-device', 'mic-silent', 'mic-choice-missing',
  'noise-high', 'noise-some', 'voice-quiet', 'voice-buried',
  'speaker-silent', 'echo-high', 'echo-some',
  'camera-unsupported', 'camera-blocked', 'camera-none', 'camera-busy', 'camera-error', 'camera-dark',
]
/** Where the self-test ran: inside the wizard, or from Settings. */
export const SELFTEST_PLACES = ['wizard', 'settings']

const MAX_EVENTS = 2000
const MAX_FINDINGS = 24
const RUN_ID = /^[\w-]{6,64}$/

/** Default location: beside the traces, outside the repository and any build output. */
export function defaultSetupMetricsFile(env = process.env) {
  if (env.JARVIS_SETUP_METRICS_FILE) return env.JARVIS_SETUP_METRICS_FILE
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'JARVIS', 'setup-metrics.json')
}

/** Whether a stored setting value means "on". Off unless explicitly turned on. */
export function setupMetricsOn(value) {
  return value === '1' || value === 'on' || value === 'true'
}

/**
 * Validate and clean one event from the page. Throws on anything malformed;
 * unknown fields are dropped, and so are finding ids not on the list.
 */
export function normaliseSetupEvent(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('event must be an object')
  if (!EVENT_KINDS.includes(input.kind)) throw new Error('unknown kind')
  const run = typeof input.run === 'string' && RUN_ID.test(input.run) ? input.run : null
  if (!run) throw new Error('run id missing or malformed')
  const at = Number.isFinite(input.at) && Math.abs(input.at - now) < 24 * 3600_000 ? Math.round(input.at) : now

  const out = { run, kind: input.kind, at }
  if (input.kind === 'selftest') {
    out.place = SELFTEST_PLACES.includes(input.place) ? input.place : 'settings'
    const ids = Array.isArray(input.findings) ? input.findings : []
    out.findings = [...new Set(ids.filter((id) => FINDING_IDS.includes(id)))].slice(0, MAX_FINDINGS)
    return out
  }
  if (input.kind === 'start') {
    out.step = 'hardware'
    return out
  }
  if (!WIZARD_STEPS.includes(input.step)) throw new Error('unknown step')
  out.step = input.step
  return out
}

/**
 * The numbers Diagnostics shows. One "run" is one pass through the wizard,
 * from opening it to Finish (completed), Skip setup (skipped), or neither
 * (abandoned: the window was closed or reloaded part-way).
 *
 * `leftAt` counts, for runs that did not complete, the furthest step reached:
 * that is where people stop. `selftest.failures` is the most common problems
 * the self-test found, most frequent first.
 */
export function summariseSetup(events) {
  const runs = new Map()
  const tests = []
  for (const e of events) {
    if (e.kind === 'selftest') {
      tests.push(e)
      continue
    }
    let r = runs.get(e.run)
    if (!r) {
      r = { furthest: 0, outcome: 'abandoned' }
      runs.set(e.run, r)
    }
    const i = WIZARD_STEPS.indexOf(e.step)
    if (i > r.furthest) r.furthest = i
    if (e.kind === 'complete') r.outcome = 'completed'
    else if (e.kind === 'skip' && r.outcome !== 'completed') r.outcome = 'skipped'
  }

  const leftAt = Object.fromEntries(WIZARD_STEPS.map((s) => [s, 0]))
  let completed = 0
  let skipped = 0
  let abandoned = 0
  for (const r of runs.values()) {
    if (r.outcome === 'completed') {
      completed++
      continue
    }
    if (r.outcome === 'skipped') skipped++
    else abandoned++
    leftAt[WIZARD_STEPS[r.furthest]]++
  }

  const counts = new Map()
  for (const t of tests) for (const id of t.findings) counts.set(id, (counts.get(id) ?? 0) + 1)
  const failures = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }))

  return {
    runs: runs.size,
    completed,
    skipped,
    abandoned,
    completionRate: runs.size ? Math.round((completed / runs.size) * 100) / 100 : null,
    leftAt,
    selftest: {
      runs: tests.length,
      clean: tests.filter((t) => t.findings.length === 0).length,
      failures,
    },
  }
}

/**
 * The store. `enabled` is asked on every call, so turning the setting off
 * takes effect at once; while it is off nothing is read or written.
 */
export function createSetupMetrics({ enabled, file = defaultSetupMetricsFile(), maxEvents = MAX_EVENTS, now = () => Date.now() } = {}) {
  if (typeof enabled !== 'function') throw new Error('enabled must be a function')

  const load = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(data?.events) ? data.events : []
    } catch {
      return []
    }
  }

  const save = (events) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, events }))
    renameSync(tmp, file)
  }

  return {
    /** Store one event. False when the setting is off (nothing written). Throws on a malformed event. */
    record(input) {
      if (!enabled()) return false
      const event = normaliseSetupEvent(input, { now: now() })
      const events = load()
      events.push(event)
      save(events.slice(-maxEvents))
      return true
    },
    /** The summary, or `{ enabled: false }` while the setting is off. */
    stats() {
      if (!enabled()) return { enabled: false }
      return { enabled: true, ...summariseSetup(load()) }
    },
    /** Delete everything kept. */
    clear() {
      rmSync(file, { force: true })
      rmSync(`${file}.tmp`, { force: true })
    },
    file,
  }
}
