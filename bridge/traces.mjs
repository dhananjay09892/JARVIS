/**
 * Turn traces: one record per conversational turn, so "it feels slow" becomes
 * a number (plans 16 component 1 and 05 phase 1).
 *
 * The page times each turn — end of speech, transcript, first tool, first
 * token, first audio — and posts one trace when the turn ends. This module
 * validates it, keeps it in a local SQLite file, and answers with rolling
 * median and p95 latency for the Diagnostics panel.
 *
 * What a trace never holds: what was said, what was answered, audio, or tool
 * arguments. Only stage timings, the route and model, tool *names*, and a
 * short error string that is run through the same secret filter as memory.
 * Nothing here leaves the machine, and old traces are pruned on open and on
 * every write (by age and by count).
 *
 * Like memory.mjs this uses only Node built-ins, so it can be tested on its own.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from './memory.mjs'

/**
 * Stages the page may report, as milliseconds relative to the moment the turn
 * started (the transcript being handed to the brain). Earlier stages — end of
 * speech, transcription — are negative.
 */
export const STAGES = ['speechEnd', 'transcribed', 'firstTool', 'firstToken', 'firstAudio', 'end']
/** 'reflex': answered on the page with no model call (plan 06 phase 1). */
export const ROUTES = ['bridge', 'direct', 'reflex']
/** Reflex families a reflex trace may name; kept in step with src/lib/reflex.ts. */
export const REFLEXES = ['stop', 'time', 'date', 'repeat', 'volume', 'timer']
export const OUTCOMES = ['ok', 'error', 'interrupted']

const MAX_TOOLS = 32
const MAX_ERROR = 200
const MIN_OFFSET = -120_000
const MAX_OFFSET = 30 * 60_000

/** Default location: beside memory, outside the repository and any build output. */
export function defaultTraceDir(env = process.env) {
  if (env.JARVIS_TRACE_DIR) return env.JARVIS_TRACE_DIR
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'JARVIS', 'traces')
}

const shortWord = (v, re = /^[\w.:-]{1,80}$/) => (typeof v === 'string' && re.test(v) ? v : null)

/**
 * Validate and clean a trace from the page. Throws on anything malformed
 * rather than storing a half-understood record; unknown fields are dropped.
 */
export function normaliseTrace(input, { model = null, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('trace must be an object')
  const id = shortWord(input.id, /^[\w-]{1,64}$/)
  if (!id) throw new Error('trace id missing or malformed')
  if (!ROUTES.includes(input.route)) throw new Error('unknown route')
  if (!OUTCOMES.includes(input.outcome)) throw new Error('unknown outcome')

  const marks = {}
  const raw = input.marks && typeof input.marks === 'object' ? input.marks : {}
  for (const stage of STAGES) {
    const v = raw[stage]
    if (v === undefined || v === null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_OFFSET || v > MAX_OFFSET) {
      throw new Error(`stage ${stage} out of range`)
    }
    marks[stage] = Math.round(v)
  }
  if (marks.end === undefined) throw new Error('trace has no end')

  const tools = Array.isArray(input.tools)
    ? input.tools.filter((t) => shortWord(t, /^[\w.:-]{1,128}$/)).slice(0, MAX_TOOLS)
    : []

  const error = typeof input.error === 'string' && input.error
    ? redact(input.error).text.slice(0, MAX_ERROR)
    : null

  const startedAt = Number.isFinite(input.startedAt) && Math.abs(input.startedAt - now) < 24 * 3600_000
    ? Math.round(input.startedAt)
    : now

  return {
    id,
    startedAt,
    route: input.route,
    outcome: input.outcome,
    model: shortWord(input.model) ?? shortWord(model),
    stt: shortWord(input.stt, /^[\w-]{1,32}$/),
    tts: shortWord(input.tts, /^[\w-]{1,32}$/),
    // Only on reflex turns, and only a known family: never free text.
    ...(input.route === 'reflex' && REFLEXES.includes(input.reflex) ? { reflex: input.reflex } : {}),
    marks,
    tools,
    error,
  }
}

/**
 * The headline number: end of speech → first audio, the KPI in plan 16
 * ("median end-of-speech→first audio ≤ 1.0 s"). A turn started without speech
 * (Space bar, typed) measures from the turn start instead. Null when no audio
 * played (an error, or an interruption before he spoke).
 */
export function latencyOf(trace) {
  const { firstAudio, speechEnd } = trace.marks
  if (firstAudio === undefined) return null
  return firstAudio - (speechEnd ?? 0)
}

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const rank = Math.ceil((p / 100) * xs.length)
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))]
}

/** Median and p95 of one stage across traces, measured from end of speech. */
function stageSummary(traces, stage) {
  const xs = []
  for (const t of traces) {
    const v = t.marks[stage]
    if (v !== undefined) xs.push(v - (t.marks.speechEnd ?? 0))
  }
  return { n: xs.length, median: percentile(xs, 50), p95: percentile(xs, 95) }
}

const latencySummary = (traces) => {
  const xs = traces.filter((t) => t.outcome === 'ok').map(latencyOf).filter((v) => v !== null)
  return { n: xs.length, median: percentile(xs, 50), p95: percentile(xs, 95) }
}

/**
 * Rolling summary over the given traces (newest first or any order).
 *
 * The headline latency is for turns that reached a model. Reflex turns (no
 * model call) are reported apart under `reflex`, so answering "what time is
 * it" instantly does not make the model look faster than it is.
 */
export function summarise(traces) {
  const model = traces.filter((t) => t.route !== 'reflex')
  const reflex = traces.filter((t) => t.route === 'reflex')
  const routes = {}
  for (const r of ROUTES) routes[r] = traces.filter((t) => t.route === r).length
  return {
    turns: traces.length,
    errors: traces.filter((t) => t.outcome === 'error').length,
    interrupted: traces.filter((t) => t.outcome === 'interrupted').length,
    latency: latencySummary(model),
    stages: {
      transcribed: stageSummary(model, 'transcribed'),
      firstToken: stageSummary(model, 'firstToken'),
      firstAudio: stageSummary(model, 'firstAudio'),
    },
    routes,
    reflex: {
      turns: reflex.length,
      // The proof a reflex skipped the model: none of its turns has a first token.
      modelCalls: reflex.filter((t) => t.marks.firstToken !== undefined).length,
      latency: latencySummary(reflex),
    },
  }
}

/**
 * Open (and create) the trace store.
 *   retentionDays  traces older than this are deleted (default 14; 0 keeps all)
 *   maxRows        never keep more than this many traces (default 5000)
 */
export function openTraces({
  file,
  dir = defaultTraceDir(),
  retentionDays = 14,
  maxRows = 5000,
  clock = () => Date.now(),
} = {}) {
  let path = file
  if (!path) {
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'traces.db')
  }
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    data TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS traces_started ON traces (started_at)')

  const stmt = {
    put: db.prepare('INSERT OR REPLACE INTO traces (id, started_at, outcome, data) VALUES (?, ?, ?, ?)'),
    recent: db.prepare('SELECT data FROM traces ORDER BY started_at DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM traces'),
    pruneAge: db.prepare('DELETE FROM traces WHERE started_at < ?'),
    pruneCount: db.prepare(
      'DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY started_at DESC LIMIT ?)',
    ),
  }

  const prune = () => {
    if (retentionDays > 0) stmt.pruneAge.run(clock() - retentionDays * 24 * 3600_000)
    if (maxRows > 0) stmt.pruneCount.run(maxRows)
  }
  prune()

  return {
    /** Validate and store one trace. Returns the stored record. */
    record(input, opts = {}) {
      const trace = normaliseTrace(input, { ...opts, now: clock() })
      stmt.put.run(trace.id, trace.startedAt, trace.outcome, JSON.stringify(trace))
      prune()
      return trace
    },
    /** The newest traces, newest first. */
    recent(limit = 50) {
      const n = Math.max(1, Math.min(1000, Math.floor(limit) || 50))
      return stmt.recent.all(n).map((row) => JSON.parse(row.data))
    },
    /** Rolling summary over the last `window` turns. */
    stats(window = 50) {
      return { window, ...summarise(this.recent(window)) }
    },
    count() {
      return stmt.count.get().n
    },
    close() {
      db.close()
    },
  }
}
