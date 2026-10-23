import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkBrainEvent, summarise, BRAIN_EVENT_TYPES, DONE_REASONS } from './events.mjs'
import { checkContract } from '../../shared/contracts.ts'

const VALID = [
  { t: 'ready', servers: [] },
  { t: 'ready', servers: ['gmail', 'jarvis'] },
  { t: 'tool_start', id: 'toolu_01', name: 'mcp__calendar__list_events' },
  { t: 'text', delta: 'At your service.' },
  { t: 'text', delta: '' },
  { t: 'tool_call', id: 'toolu_01', name: 'mcp__calendar__list_events', args: { day: 'today' } },
  { t: 'tool_call', id: 'c', name: 'Read', args: {} },
  { t: 'tool_result', id: 'toolu_01', ok: true, summary: '2 events', tainted: true },
  { t: 'tool_result', id: 'toolu_01', ok: false, summary: '', tainted: false },
  { t: 'tool_result', id: 'toolu_01', ok: true, summary: '{"bytes":1}', tainted: false, detail: '{"bytes":1,"sha256":"aa"}' },
  { t: 'usage', inTokens: 0, outTokens: 0 },
  { t: 'usage', inTokens: 1820, outTokens: 41, costUsd: 0.006 },
  { t: 'error', code: 'max_turns', retryable: false },
  { t: 'error', code: 'session_error', retryable: true, message: 'socket closed' },
  ...DONE_REASONS.map((reason) => ({ t: 'done', reason })),
]

const INVALID = [
  { t: 'ready' },
  { t: 'ready', servers: 'gmail' },
  { t: 'ready', servers: [''] },
  { t: 'tool_start', id: 'c1' },
  { t: 'tool_start', id: 'has space', name: 'Read' },
  { t: 'tool_result', id: 'c1', ok: true, summary: '', tainted: false, detail: 5 },
  { t: 'tool_result', id: 'c1', ok: true, summary: '', tainted: false, detail: 'x'.repeat(2001) },
  null,
  [],
  'done',
  { t: 'telepathy' },
  { t: 'text' },
  { t: 'text', delta: 5 },
  { t: 'tool_call', id: 'c1', name: 'Read' },
  { t: 'tool_call', id: 'c1', name: '', args: {} },
  { t: 'tool_call', id: 'has space', name: 'Read', args: {} },
  { t: 'tool_call', id: '', name: 'Read', args: {} },
  { t: 'tool_call', id: 'x'.repeat(129), name: 'Read', args: {} },
  { t: 'tool_call', id: 'c1', name: 'Read', args: [] },
  { t: 'tool_result', id: 'c1', ok: 'yes', summary: '', tainted: false },
  { t: 'tool_result', id: 'c1', ok: true, summary: '' },
  { t: 'usage', inTokens: -1, outTokens: 0 },
  { t: 'usage', inTokens: 1.5, outTokens: 0 },
  { t: 'usage', inTokens: 1, outTokens: 0, costUsd: -0.1 },
  { t: 'error', code: '', retryable: true },
  { t: 'error', code: 'x' },
  { t: 'error', code: 'x', retryable: true, message: 7 },
  { t: 'done' },
  { t: 'done', reason: 'finished' },
]

test('valid events pass', () => {
  for (const e of VALID) assert.ok(checkBrainEvent(e).ok, JSON.stringify(e))
  assert.deepEqual([...new Set(VALID.map((e) => e.t))].sort(), [...BRAIN_EVENT_TYPES].sort())
})

test('invalid events fail with errors that never echo the value', () => {
  for (const e of INVALID) {
    const r = checkBrainEvent(e)
    assert.equal(r.ok, false, JSON.stringify(e))
    assert.ok(r.errors.length > 0)
    for (const line of r.errors) assert.doesNotMatch(line, /socket closed|telepathy|finished|has space/)
  }
})

test('the bridge copy agrees with the BrainEvent contract in shared/contracts.ts', () => {
  for (const e of [...VALID, ...INVALID]) {
    assert.equal(checkBrainEvent(e).ok, checkContract('BrainEvent', e).ok, `disagree on ${JSON.stringify(e)}`)
  }
})

test('the plan 38 fixture events pass the bridge copy too', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../shared/fixtures/voice-command-tool-call.json', import.meta.url), 'utf8'))
  const events = fixture.steps.filter((s) => s.contract === 'BrainEvent').map((s) => s.value)
  assert.ok(events.length >= 4)
  for (const e of events) assert.ok(checkBrainEvent(e).ok, JSON.stringify(e))
})

test('summarise keeps the first line, bounded', () => {
  assert.equal(summarise('2 events\nstand-up 10:00'), '2 events')
  assert.equal(summarise([{ type: 'text', text: '  ENOENT: no such file  ' }, { type: 'image' }]), 'ENOENT: no such file')
  assert.equal(summarise(['a', 'b']), 'a b')
  assert.equal(summarise(undefined), '')
  assert.equal(summarise({ type: 'text' }), '')
  const long = summarise('x'.repeat(500))
  assert.equal(long.length, 160)
  assert.ok(long.endsWith('…'))
})
