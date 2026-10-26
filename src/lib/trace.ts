import { BRIDGE_HTTP_URL } from '../config'

/**
 * Turn tracing (plans 16 + 05): one timing record per turn, so latency is a
 * number rather than a feeling.
 *
 * The voice loop and the speaker report moments as they happen — end of
 * speech, transcript back, first tool, first token, first audio — and the turn
 * owner (App.respond) opens and closes the trace. A finished trace is posted
 * to the bridge, which stores it locally (bridge/traces.mjs) and answers
 * Diagnostics with rolling median and p95.
 *
 * Timings, route, tool names and a short error only. Never what was said or
 * answered, never audio.
 *
 * All times are performance.now() milliseconds, stored relative to the turn's
 * start, so stages before the start (end of speech, transcription) are negative.
 */

export type Stage = 'speechEnd' | 'transcribed' | 'firstTool' | 'firstToken' | 'firstAudio' | 'end'
/** 'reflex' turns were answered on the page with no model call (plan 06 phase 1). */
export type Route = 'bridge' | 'direct' | 'reflex'
export type Outcome = 'ok' | 'error' | 'interrupted'

export type TurnTrace = {
  id: string
  startedAt: number
  route: Route
  outcome: Outcome
  stt?: string
  tts?: string
  /** For route 'reflex': which family answered (stop, time, timer…). Never the words. */
  reflex?: string
  marks: Partial<Record<Stage, number>>
  tools: string[]
  error?: string
}

/** A moment noted before the turn opened is only used if it is this recent. */
const PENDING_MAX_MS = 30_000
const LOCAL_WINDOW = 50

let pendingSpeechEnd = 0
let pendingTranscribed = 0

let active: { trace: TurnTrace; t0: number } | null = null

/** Latencies of recent completed turns, kept so Diagnostics works without the bridge. */
const recentLatencies: number[] = []

export const traceDiag = {
  /** The last finished turn, or null. */
  last: null as TurnTrace | null,
  /** End of speech → first audio for the last finished turn, in ms. */
  lastLatencyMs: null as number | null,
  /** Rolling median/p95 over this page's recent turns. */
  localMedianMs: null as number | null,
  localP95Ms: null as number | null,
  /** Turns recorded since load. */
  turns: 0,
  /** Posts the bridge refused or that failed to arrive. */
  postFailures: 0,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__trace = traceDiag
}

const now = () => performance.now()

/** The voice loop heard the end of a speech segment. */
export function noteSpeechEnd(): void {
  pendingSpeechEnd = now()
}

/** A transcript came back from speech-to-text. */
export function noteTranscribed(): void {
  pendingTranscribed = now()
}

const fresh = (t: number, at: number) => (t && at - t >= 0 && at - t < PENDING_MAX_MS ? t : 0)

/**
 * Open a trace for a new turn. A turn still open is closed first as
 * interrupted — a new turn only starts over an old one when the user talked
 * over it.
 */
export function beginTurn(route: Route, info: { stt?: string; tts?: string; reflex?: string } = {}): void {
  if (active) endTurn('interrupted')
  const t0 = now()
  const trace: TurnTrace = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    route,
    outcome: 'ok',
    stt: info.stt,
    tts: info.tts,
    ...(info.reflex ? { reflex: info.reflex } : {}),
    marks: {},
    tools: [],
  }
  const speechEnd = fresh(pendingSpeechEnd, t0)
  const transcribed = fresh(pendingTranscribed, t0)
  if (speechEnd) trace.marks.speechEnd = Math.round(speechEnd - t0)
  // Only meaningful as part of the same utterance: after its speech ended.
  if (transcribed && (!speechEnd || transcribed >= speechEnd)) {
    trace.marks.transcribed = Math.round(transcribed - t0)
  }
  pendingSpeechEnd = 0
  pendingTranscribed = 0
  active = { trace, t0 }
}

/** Record the first time a stage happens in the open turn. Later calls are ignored. */
export function mark(stage: Exclude<Stage, 'end' | 'speechEnd' | 'transcribed'>): void {
  if (!active || active.trace.marks[stage] !== undefined) return
  active.trace.marks[stage] = Math.round(now() - active.t0)
}

/** A tool ran in the open turn. Names only, never arguments. */
export function noteTool(name: string): void {
  if (!active) return
  mark('firstTool')
  if (active.trace.tools.length < 32 && /^[\w.:-]{1,128}$/.test(name)) active.trace.tools.push(name)
}

function percentile(values: number[], p: number): number | null {
  const xs = [...values].sort((a, b) => a - b)
  if (!xs.length) return null
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))]
}

/** Close the open turn and send it to the bridge. Safe to call when none is open. */
export function endTurn(outcome: Outcome, error?: string): void {
  if (!active) return
  const { trace, t0 } = active
  active = null
  trace.outcome = outcome
  trace.marks.end = Math.round(now() - t0)
  if (error) trace.error = error.slice(0, 200)

  const { firstAudio, speechEnd } = trace.marks
  const latency = firstAudio === undefined ? null : firstAudio - (speechEnd ?? 0)
  traceDiag.last = trace
  traceDiag.turns++
  if (outcome === 'ok') traceDiag.lastLatencyMs = latency
  // Reflex turns (no model) are counted apart, so they don't flatter the model's number.
  if (outcome === 'ok' && latency !== null && trace.route !== 'reflex') {
    recentLatencies.push(latency)
    if (recentLatencies.length > LOCAL_WINDOW) recentLatencies.shift()
    traceDiag.localMedianMs = percentile(recentLatencies, 50)
    traceDiag.localP95Ms = percentile(recentLatencies, 95)
  }

  // Best effort, off the voice path. A missing bridge costs a trace, nothing more.
  void fetch(`${BRIDGE_HTTP_URL}/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(trace),
    keepalive: true,
  })
    .then((res) => {
      if (!res.ok && res.status !== 204) traceDiag.postFailures++
    })
    .catch(() => {
      traceDiag.postFailures++
    })
}

export type TraceStats = {
  enabled: boolean
  window?: number
  turns?: number
  errors?: number
  interrupted?: number
  latency?: { n: number; median: number | null; p95: number | null }
  /** Turns per route; older bridges omit it. */
  routes?: Partial<Record<Route, number>>
  /** Reflex turns (no model call): how many, and end of speech → first audio. */
  reflex?: { turns: number; modelCalls: number; latency: { n: number; median: number | null; p95: number | null } }
}

/** Rolling numbers from the bridge's trace store; null if it can't be reached. */
export async function fetchTraceStats(size = 50): Promise<TraceStats | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/traces/stats?window=${size}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return (await res.json()) as TraceStats
  } catch {
    return null
  }
}
