import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CONTRACTS, TOPICS, checkContract, parseContract, ContractError,
  type ContractName, type Utterance,
} from './contracts.ts'

type Step = { contract: ContractName; value: Record<string, unknown> }
type Scenario = { scenario: string; steps: Step[] }

const fixturesDir = new URL('./fixtures/', import.meta.url)
const load = (file: string): Scenario => JSON.parse(readFileSync(new URL(file, fixturesDir), 'utf8'))
const SCENARIOS = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()

const clone = <T>(v: T): T => structuredClone(v)
const find = (s: Scenario, name: ContractName, i = 0) => s.steps.filter((x) => x.contract === name)[i].value

test('the three plan 38 scenarios have fixtures', () => {
  assert.deepEqual(SCENARIOS, ['morning-briefing.json', 'telegram-approval.json', 'voice-command-tool-call.json'])
})

for (const file of SCENARIOS) {
  test(`every step of ${file} validates`, () => {
    const scenario = load(file)
    assert.ok(scenario.steps.length > 0)
    for (const [i, step] of scenario.steps.entries()) {
      assert.ok(step.contract in CONTRACTS, `step ${i}: unknown contract ${step.contract}`)
      const result = checkContract(step.contract, step.value)
      assert.ok(result.ok, `step ${i} (${step.contract}): ${result.ok ? '' : result.errors.join('; ')}`)
    }
  })
}

test('voice command: one traceId and matching ids run through the turn', () => {
  const s = load('voice-command-tool-call.json')
  const utt = find(s, 'Utterance')
  for (const name of ['TurnContext', 'PolicyRequest'] as const) assert.equal(find(s, name).traceId, utt.traceId)
  assert.equal(find(s, 'BusEvent').traceId, utt.traceId)
  assert.equal(find(s, 'PolicyDecision').requestId, find(s, 'PolicyRequest').id)
  const calls = s.steps.filter((x) => x.contract === 'BrainEvent').map((x) => x.value)
  assert.equal(calls.find((e) => e.t === 'tool_call')?.id, calls.find((e) => e.t === 'tool_result')?.id)
  assert.equal(calls.at(-1)?.t, 'done')
})

test('telegram approval: the reply answers the approval that policy asked for', () => {
  const s = load('telegram-approval.json')
  const decision = find(s, 'PolicyDecision') as { verdict: string; approval: { id: string } }
  assert.equal(decision.verdict, 'ask')
  assert.equal(find(s, 'ChannelMessage').inReplyTo, decision.approval.id)
  assert.equal(find(s, 'ApprovalResolution').approvalId, decision.approval.id)
  assert.equal((find(s, 'PolicyRequest').taint as { privateRead: boolean }).privateRead, true)
})

test('morning briefing: the skip turn names the delivered notification', () => {
  const s = load('morning-briefing.json')
  const ntf = find(s, 'Notification')
  const topics = s.steps.filter((x) => x.contract === 'BusEvent').map((x) => x.value.topic)
  assert.deepEqual(topics, ['notification.created', 'notification.delivered', 'turn.finished'])
  assert.equal((find(s, 'BusEvent', 2).payload as { notificationId: string }).notificationId, ntf.id)
})

test('unknown fields are ignored, so an older reader accepts a newer writer', () => {
  const utt = clone(find(load('voice-command-tool-call.json'), 'Utterance'))
  const result = checkContract('Utterance', { ...utt, addedInV1_3: 'something new' })
  assert.ok(result.ok)
  assert.equal('addedInV1_3' in result.value, false)
})

test('defaults are filled in: an utterance is private unless it says otherwise', () => {
  const utt = find(load('voice-command-tool-call.json'), 'Utterance')
  assert.equal(parseContract('Utterance', utt).sensitivity, 'private')
})

test('a different version is rejected rather than misread', () => {
  const utt = clone(find(load('voice-command-tool-call.json'), 'Utterance'))
  const result = checkContract('Utterance', { ...utt, v: 2 })
  assert.equal(result.ok, false)
})

test('id and ts are required on every top-level object', () => {
  const utt = clone(find(load('voice-command-tool-call.json'), 'Utterance'))
  for (const key of ['id', 'ts', 'v']) {
    const broken: Record<string, unknown> = clone(utt)
    delete broken[key]
    const result = checkContract('Utterance', broken)
    assert.equal(result.ok, false, key)
    if (!result.ok) assert.ok(result.errors.some((e) => e.startsWith(`${key}:`)), result.errors.join('; '))
  }
})

/** [contract, fixture file, mutation, what it breaks]. Each must fail. */
const INVALID: [ContractName, string, (v: Record<string, unknown>) => void, string][] = [
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.traceId = 'not-hex' }, 'traceId format'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.modality = 'telepathy' }, 'modality enum'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.langConfidence = 1.5 }, 'score above 1'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.ts = -1 }, 'negative ts'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.ts = 1.5 }, 'fractional ts'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { v.id = 'has space' }, 'id with whitespace'],
  ['Utterance', 'voice-command-tool-call.json', (v) => { (v.identity as Record<string, unknown>).role = 'admin' }, 'role enum'],
  ['PolicyRequest', 'voice-command-tool-call.json', (v) => { (v.action as Record<string, unknown>).kind = 'shell' }, 'action kind'],
  ['PolicyDecision', 'voice-command-tool-call.json', (v) => { v.verdict = 'maybe' }, 'verdict enum'],
  ['PolicyDecision', 'voice-command-tool-call.json', (v) => { v.reason = '' }, 'empty reason'],
  ['PolicyDecision', 'telegram-approval.json', (v) => { delete v.approval }, "'ask' without an approval"],
  ['ChannelMessage', 'telegram-approval.json', (v) => { delete v.text }, 'no text, audio or image'],
  ['ChannelMessage', 'telegram-approval.json', (v) => { v.channel = 'carrier-pigeon' }, 'channel enum'],
  ['ChannelMessage', 'telegram-approval.json', (v) => { v.text = 'x'.repeat(16_001) }, 'text too long'],
  ['AuditRecord', 'voice-command-tool-call.json', (v) => { v.prevHash = 'abc' }, 'prevHash format'],
  ['Notification', 'morning-briefing.json', (v) => { v.audience = [] }, 'empty audience'],
  ['Notification', 'morning-briefing.json', (v) => { v.urgency = 'meh' }, 'urgency enum'],
  ['Mission', 'telegram-approval.json', (v) => { v.status = 'vibing' }, 'mission status'],
  ['ContextSlice', 'morning-briefing.json', (v) => { delete v.untrusted }, 'untrusted flag required'],
]

for (const [name, file, mutate, what] of INVALID) {
  test(`${name} rejects ${what}`, () => {
    const value = clone(find(load(file), name))
    mutate(value)
    assert.equal(checkContract(name, value).ok, false)
  })
}

test('BrainEvent rejects an unknown event type and a tool_call without args', () => {
  assert.equal(checkContract('BrainEvent', { t: 'telepathy' }).ok, false)
  assert.equal(checkContract('BrainEvent', { t: 'tool_call', id: 'c1', name: 'Read' }).ok, false)
  assert.ok(checkContract('BrainEvent', { t: 'done', reason: 'cancelled' }).ok)
})

test('BusEvent checks the payload against its topic', () => {
  const s = load('voice-command-tool-call.json')
  const event = clone(find(s, 'BusEvent'))
  ;(event.payload as Record<string, unknown>).modality = 'telepathy'
  const result = checkContract('BusEvent', event)
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.some((e) => e.startsWith('payload.modality')), result.errors.join('; '))
  assert.equal(checkContract('BusEvent', { ...clone(find(s, 'BusEvent')), topic: 'made.up' }).ok, false)
})

test('BusEvent topics are the plan 38 list plus the Q32 publishers', () => {
  assert.equal(TOPICS.length, 23)
  for (const t of ['workflow.started', 'workflow.finished', 'task.finished']) assert.ok(TOPICS.includes(t as never), t)
  assert.equal(new Set(TOPICS).size, TOPICS.length)
})

test('parseContract throws a ContractError that names the contract and the fields', () => {
  assert.throws(
    () => parseContract('Identity', { personId: 'x', role: 'owner', confidence: 2, sources: [] }),
    (err: unknown) => err instanceof ContractError && err.contract === 'Identity' && err.message.includes('confidence'),
  )
})

test('errors never echo the rejected value, so they are safe to log', () => {
  const secret = 'sk-live-THIS-SHOULD-NOT-APPEAR'
  const results = [
    checkContract('Identity', { personId: secret, role: secret, confidence: secret, sources: [secret] }),
    checkContract('ChannelMessage', { v: 1, id: 'm', ts: 1, channel: secret, senderId: 's', threadId: 't', text: 1 }),
    checkContract('Utterance', { traceId: secret, id: `${secret} x` }),
  ]
  for (const r of results) {
    assert.equal(r.ok, false)
    if (!r.ok) assert.ok(!r.errors.join('\n').includes(secret), r.errors.join('\n'))
  }
})

test('types and runtime agree: a parsed value is usable as its type', () => {
  const utt: Utterance = parseContract('Utterance', find(load('voice-command-tool-call.json'), 'Utterance'))
  assert.equal(utt.identity.role, 'owner')
})

// Payloads of the bus's first publishers (plan 12 block 1, Q32).
const RUN = {
  runId: 'run-1', workflowId: 'wf-1', name: 'Morning build', trigger: 'schedule',
  status: 'running', stepsTotal: 2, stepsCompleted: 0, startedAt: 1_766_000_000_000,
}
const OUTCOME = { taskId: 't1a2b3c4', title: 'Summarise the report', status: 'done', summary: 'Three points.', endedAt: 1_766_000_000_000 }
const bus = (topic: string, payload: unknown) => ({ v: 1, id: 'ev-1', ts: 1_766_000_000_000, topic, payload })

test('workflow.started and workflow.finished carry a WorkflowRun', () => {
  assert.ok(checkContract('BusEvent', bus('workflow.started', RUN)).ok)
  assert.ok(checkContract('BusEvent', bus('workflow.finished', { ...RUN, status: 'completed', stepsCompleted: 2, finishedAt: 1_766_000_001_000 })).ok)
  assert.equal(checkContract('BusEvent', bus('workflow.started', { ...RUN, trigger: 'cron' })).ok, false)
  assert.equal(checkContract('BusEvent', bus('workflow.finished', { ...RUN, status: 'failed' })).ok, false, 'ended without finishedAt')
  assert.equal(checkContract('BusEvent', bus('workflow.started', { ...RUN, finishedAt: 1 })).ok, false, 'running with finishedAt')
  assert.equal(checkContract('BusEvent', bus('workflow.started', { ...RUN, stepsCompleted: 3 })).ok, false)
  assert.equal(checkContract('BusEvent', bus('workflow.started', { ...RUN, name: '' })).ok, false)
})

test('task.finished carries a TaskOutcome that is private by default', () => {
  const r = checkContract('TaskOutcome', OUTCOME)
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.value.sensitivity, 'private')
  assert.ok(checkContract('BusEvent', bus('task.finished', { ...OUTCOME, status: 'interrupted', costUsd: 0.02, startedAt: 1 })).ok)
  assert.equal(checkContract('BusEvent', bus('task.finished', { ...OUTCOME, status: 'running' })).ok, false, 'not ended')
  assert.equal(checkContract('BusEvent', bus('task.finished', { ...OUTCOME, summary: 'x'.repeat(301) })).ok, false)
  assert.equal(checkContract('BusEvent', bus('task.finished', { ...OUTCOME, costUsd: -1 })).ok, false)
})
