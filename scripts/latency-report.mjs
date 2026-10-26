#!/usr/bin/env node
/**
 * Before/after latency from the local turn traces (plans 05 phase 2 and 16).
 *
 *   npm run latency -- --since 2026-10-27
 *   npm run latency -- --since 2026-10-27T18:00 --file C:\path\to\traces.db
 *
 * Splits the stored traces at `--since` (a date or date-time, local time) and
 * prints turns, median and p95 for end of speech → first token and → first
 * audio on each side, and the change. Without `--since` it prints one summary
 * of everything stored. Reads only timings: traces never hold what was said.
 *
 * Use it to put real numbers on a latency change: run JARVIS for a while on
 * the old build, note the time, update, run a while longer, then split there.
 */
import { pathToFileURL } from 'node:url'
import { openTraces, summarise } from '../bridge/traces.mjs'

/** Split traces into those started before and at-or-after `since` (ms). */
export function splitAt(traces, since) {
  const before = []
  const after = []
  for (const t of traces) (t.startedAt < since ? before : after).push(t)
  return { before, after }
}

const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`)
const delta = (a, b) => (a === null || b === null || a === undefined || b === undefined
  ? '—'
  : `${b - a > 0 ? '+' : ''}${Math.round(b - a)} ms`)

/** The rows worth comparing, from summarise(). */
function rows(s) {
  return [
    ['end of speech → first audio, median', s.latency.median],
    ['end of speech → first audio, p95', s.latency.p95],
    ['end of speech → first token, median', s.stages.firstToken.median],
    ['end of speech → first token, p95', s.stages.firstToken.p95],
  ]
}

/** A plain-text report, Markdown-table shaped so it can be pasted into a PR. */
export function report(traces, since = null) {
  if (since === null) {
    const s = summarise(traces)
    return [
      `Turns: ${s.turns} (${s.latency.n} with audio, ${s.errors} errors, ${s.interrupted} interrupted)`,
      '',
      '| Measure | Value |',
      '|---|---|',
      ...rows(s).map(([label, v]) => `| ${label} | ${ms(v)} |`),
    ].join('\n')
  }
  const { before, after } = splitAt(traces, since)
  const a = summarise(before)
  const b = summarise(after)
  const ra = rows(a)
  const rb = rows(b)
  return [
    `Split at ${new Date(since).toISOString()}`,
    `Before: ${a.turns} turns (${a.latency.n} with audio) · After: ${b.turns} turns (${b.latency.n} with audio)`,
    '',
    '| Measure | Before | After | Change |',
    '|---|---|---|---|',
    ...ra.map(([label, v], i) => `| ${label} | ${ms(v)} | ${ms(rb[i][1])} | ${delta(v, rb[i][1])} |`),
  ].join('\n')
}

/** Parse argv into { since, file, limit }; throws on a bad date. */
export function parseArgs(argv) {
  const out = { since: null, file: undefined, limit: 1000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') {
      const t = Date.parse(argv[++i] ?? '')
      if (!Number.isFinite(t)) throw new Error('--since needs a date, e.g. 2026-10-27 or 2026-10-27T18:00')
      out.since = t
    } else if (a === '--file') {
      out.file = argv[++i]
    } else if (a === '--limit') {
      out.limit = Math.max(1, Math.min(1000, Number(argv[++i]) || 1000))
    }
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { since, file, limit } = parseArgs(process.argv.slice(2))
    const store = openTraces(file ? { file, retentionDays: 0, maxRows: 0 } : { retentionDays: 0, maxRows: 0 })
    try {
      console.log(report(store.recent(limit), since))
    } finally {
      store.close()
    }
  } catch (err) {
    console.error(String(err?.message ?? err))
    process.exitCode = 1
  }
}
