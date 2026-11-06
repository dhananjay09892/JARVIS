// Agents phase A3 (A10): the Agents screen's helpers, and its edits and
// switches round-tripping through the bridge's agent routes against a
// temporary data folder. No network, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PAGE_SIZE,
  budgetText,
  connectorsText,
  costText,
  definitionPatch,
  filterAgents,
  fromTemplate,
  isAgentId,
  isUnused,
  modeText,
  pageOf,
  readBudget,
  replyText,
  reviewChoice,
  successText,
  suggestCopyId,
  suggestNewId,
  type AgentCard,
  type AgentDetail,
  type AgentStats,
  type AgentTemplate,
} from './agentsView.ts'
// @ts-expect-error plain JS bridge modules, no type declarations
import { createAgentRegistry, createToolCatalogue } from '../../bridge/agents.mjs'
// @ts-expect-error plain JS bridge modules, no type declarations
import { createAgentSettings } from '../../bridge/agent-settings.mjs'
// @ts-expect-error plain JS bridge modules, no type declarations
import { createAgentRoutes } from '../../bridge/agent-routes.mjs'

const DAY = 24 * 60 * 60 * 1000
const STATS: AgentStats = { runs: 0, done: 0, failed: 0, cancelled: 0, active: 0, successRate: null, minutes: 0, costUsd: 0, lastRunAt: null }

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: 'a',
  name: 'A',
  description: 'Does a.',
  mode: 'on-demand',
  source: 'user',
  readOnly: false,
  createdBy: 'user',
  active: true,
  icon: null,
  switchedOn: true,
  runsUnasked: false,
  tools: 1,
  connectors: 0,
  review: false,
  stats: STATS,
  ...over,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('the roster pages past 50 and clamps the page number', () => {
  const many = Array.from({ length: 120 }, (_, i) => i)
  assert.equal(PAGE_SIZE, 50)
  assert.deepEqual(pageOf(many, 0).items.length, 50)
  assert.equal(pageOf(many, 0).pages, 3)
  assert.deepEqual(pageOf(many, 2).items, many.slice(100))
  assert.equal(pageOf(many, 9).page, 2)
  assert.equal(pageOf(many, -3).page, 0)
  assert.equal(pageOf(many, Number.NaN).page, 0)
  assert.deepEqual(pageOf([], 0), { items: [], page: 0, pages: 1 })
})

test('the search matches name, id or description and the roster is sorted by name', () => {
  const list = [card({ id: 'writer', name: 'Writer' }), card({ id: 'coder', name: 'Coder', description: 'Writes code.' }), card({ id: 'z', name: 'Archivist' })]
  assert.deepEqual(filterAgents(list, '').map((a) => a.id), ['z', 'coder', 'writer'])
  assert.deepEqual(filterAgents(list, 'WRIT').map((a) => a.id), ['coder', 'writer'])
  assert.deepEqual(filterAgents(list, 'coder').map((a) => a.id), ['coder'])
  assert.deepEqual(filterAgents(list, 'nothing'), [])
})

test('the unused hint shows after 30 days without a run, and never without a recorded run', () => {
  const now = 1_000 * DAY
  assert.equal(isUnused({ lastRunAt: now - 31 * DAY }, now), true)
  assert.equal(isUnused({ lastRunAt: now - 29 * DAY }, now), false)
  assert.equal(isUnused({ lastRunAt: null }, now), false)
})

test('modes, budgets, success, cost and connectors read as words', () => {
  assert.equal(modeText({ mode: 'on-demand', schedule: null, trigger: null }), 'when you ask')
  assert.equal(modeText({ mode: 'scheduled', schedule: '0 7 * * *', trigger: null }), 'on a schedule (0 7 * * *)')
  assert.equal(modeText({ mode: 'triggered', schedule: null, trigger: 'meeting.ended' }), 'when something happens (meeting.ended)')
  assert.equal(budgetText(undefined), 'the default budget')
  assert.equal(budgetText({ maxToolCalls: 1, maxMinutes: 5, maxCostUsd: 0.5 }), '1 tool call, 5 min, $0.50')
  assert.equal(successText(STATS), 'no finished runs')
  assert.equal(successText({ ...STATS, successRate: 0.667 }), '67% succeeded')
  assert.equal(costText(0), '$0')
  assert.equal(costText(null), '$0')
  assert.equal(costText(0.004), '<$0.01')
  assert.equal(costText(1.234), '$1.23')
  assert.equal(connectorsText({}), 'none')
  assert.equal(connectorsText({ notion: 'write', fake: 'read' }), 'notion (write), fake (read)')
})

test('copy ids are free and valid', () => {
  assert.equal(suggestCopyId('writer', []), 'writer-copy')
  assert.equal(suggestCopyId('writer', ['writer-copy']), 'writer-copy-2')
  assert.equal(suggestCopyId('writer', ['writer-copy', 'writer-copy-2']), 'writer-copy-3')
  const long = 'a'.repeat(40)
  assert.ok(isAgentId(suggestCopyId(long, [])))
  assert.ok(isAgentId(suggestCopyId(long, [`${'a'.repeat(35)}-copy`])))
  assert.equal(isAgentId('Bad Id'), false)
})

test('a budget is read from the form or refused with a reason', () => {
  assert.deepEqual(readBudget('10', '5', '0.5'), { budget: { maxToolCalls: 10, maxMinutes: 5, maxCostUsd: 0.5 } })
  assert.ok('error' in readBudget('0', '5', '1'))
  assert.ok('error' in readBudget('1.5', '5', '1'))
  assert.ok('error' in readBudget('10', '0', '1'))
  assert.ok('error' in readBudget('10', '2000', '1'))
  assert.ok('error' in readBudget('10', '5', ''))
  assert.ok('error' in readBudget('10', '5', '101'))
})

test('a refused change reads as its reason and a few of the checker reasons, clipped', () => {
  assert.equal(replyText({ ok: false }), 'That did not work.')
  assert.equal(replyText({ ok: false, reason: 'No.' }), 'No.')
  const r = replyText({ ok: false, reason: 'Not valid.', reasons: Array.from({ length: 20 }, (_, i) => `r${i}`) })
  assert.equal(r, `Not valid. ${Array.from({ length: 8 }, (_, i) => `r${i}`).join('; ')}`)
  assert.ok(replyText({ ok: false, reason: 'x'.repeat(1000) }).length <= 200)
})

test('a structured edit copies tools, connectors and delegation as they are and keeps the reviewer default', () => {
  const definition = {
    v: 1, id: 'h', name: 'H', description: 'Helps.', mode: 'on-demand' as const, schedule: null, trigger: null, brain: 'claude', model: 'default',
    tools: ['Read'], connectors: { fake: 'read' as const }, memory: 'none' as const, review: false, delegate: [], output: 'report',
    createdBy: 'user' as const, body: 'Help.',
  }
  const followsDefault = { definition, file: '---\nid: h\n---\n\nHelp.\n' }
  assert.equal(reviewChoice(followsDefault), 'default')
  const p = definitionPatch(followsDefault, { name: '  Helper ' })
  assert.equal(p.name, 'Helper')
  assert.equal('review' in p, false)
  assert.equal('v' in p, false)
  assert.equal('budget' in p, false)
  assert.deepEqual(p.tools, ['Read'])
  assert.deepEqual(p.connectors, { fake: 'read' })
  assert.deepEqual(p.delegate, [])

  const setOff = { definition, file: '---\nid: h\nreview: false\n---\n\nHelp.\n' }
  assert.equal(reviewChoice(setOff), 'off')
  assert.equal(definitionPatch(setOff, {}).review, false)
  assert.equal('review' in definitionPatch(setOff, { review: 'default' }), false)
  assert.equal(definitionPatch(followsDefault, { review: 'on' }).review, true)

  const budget = { maxToolCalls: 3, maxMinutes: 2, maxCostUsd: 0 }
  const withBudget = { definition: { ...definition, budget }, file: followsDefault.file }
  assert.deepEqual(definitionPatch(withBudget, {}).budget, budget)
  assert.equal('budget' in definitionPatch(withBudget, { budget: null }), false)
  assert.deepEqual(definitionPatch(followsDefault, { budget }).budget, budget)
})

// ---------------------------------------------------------------------------
// Round trips through the bridge's routes
// ---------------------------------------------------------------------------

const FIXTURE_BUILTINS = fileURLToPath(new URL('../../shared/fixtures/agents/registry/builtin/', import.meta.url))
const quiet = { warn() {}, log() {}, error() {} }

type Reply = { status: number; body: Record<string, any> }

function bridge(tasks: object[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-agents-screen-'))
  const userDir = join(root, 'agents')
  mkdirSync(userDir)
  const registry = createAgentRegistry({
    builtinDir: FIXTURE_BUILTINS,
    userDir,
    approvalsFile: join(root, 'agent-approvals.json'),
    tools: createToolCatalogue({ servers: { jarvis_tasks: ['task_status'] } }),
    connectors: [{ id: 'fake', capabilities: { read: true, write: false } }],
    log: quiet,
  })
  registry.load()
  const values: Record<string, string> = {}
  const settings = createAgentSettings({ read: (k: string) => values[k], frozen: () => false })
  const routes = createAgentRoutes({
    registry,
    settings,
    saveSettings: (patch: Record<string, string>) => Object.assign(values, patch),
    tasks: { list: () => tasks },
    log: quiet,
  })
  const call = (method: string, path: string, body?: unknown): Reply => routes.handle({ method, path, body })
  return { call, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('the roster from the API fits the screen: cards, pages and the unused hint', () => {
  const now = Date.now()
  const b = bridge([{ id: 't1', title: 'old', agentId: 'echo', status: 'done', createdAt: now - 40 * DAY, startedAt: now - 40 * DAY, endedAt: now - 40 * DAY + 60_000 }])
  try {
    const list = b.call('GET', '/agents').body
    assert.equal(list.ok, true)
    const roster = filterAgents(list.agents as AgentCard[], '')
    const echo = roster.find((a) => a.id === 'echo')!
    assert.equal(echo.readOnly, true)
    assert.equal(modeText({ mode: echo.mode, schedule: null, trigger: null }), 'when you ask')
    assert.equal(echo.stats.runs, 1)
    assert.equal(successText(echo.stats), '100% succeeded')
    assert.equal(isUnused(echo.stats, now), true)
    assert.equal(pageOf(roster, 0).items.length, roster.length)
  } finally {
    b.done()
  }
})

test('switches, copies, edits and deletes round-trip through the routes', () => {
  const b = bridge()
  try {
    // Switch the built-in off and on again.
    assert.equal(b.call('POST', '/agents/echo/enabled', { enabled: false }).body.switchedOn, false)
    assert.equal(b.call('GET', '/agents').body.agents.find((a: AgentCard) => a.id === 'echo').switchedOn, false)
    assert.equal(b.call('POST', '/agents/echo/enabled', { enabled: true }).body.switchedOn, true)

    // Copy it under a suggested id; the copy is the owner's and editable.
    const ids = b.call('GET', '/agents').body.agents.map((a: AgentCard) => a.id)
    const copyId = suggestCopyId('echo', ids)
    const copied = b.call('POST', `/agents/echo/copy`, { id: copyId })
    assert.equal(copied.status, 201)
    assert.equal(copied.body.agent.readOnly, false)

    // A structured edit: new name, review on, own budget; it reads back the same.
    const detail = b.call('GET', `/agents/${copyId}`).body as AgentDetail
    const patch = definitionPatch(detail, { name: 'Echo two', review: 'on', budget: { maxToolCalls: 4, maxMinutes: 3, maxCostUsd: 0.25 } })
    const saved = b.call('POST', `/agents/${copyId}/update`, { definition: patch })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const after = b.call('GET', `/agents/${copyId}`).body as AgentDetail
    assert.equal(after.definition.name, 'Echo two')
    assert.equal(reviewChoice(after), 'on')
    assert.equal(budgetText(after.definition.budget), '4 tool calls, 3 min, $0.25')
    assert.deepEqual(after.definition.tools, detail.definition.tools)

    // Back to the reviewer default and no own budget.
    const back = b.call('POST', `/agents/${copyId}/update`, { definition: definitionPatch(after, { review: 'default', budget: null }) })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    const again = b.call('GET', `/agents/${copyId}`).body as AgentDetail
    assert.equal(reviewChoice(again), 'default')
    assert.equal(again.definition.budget, undefined)

    // A file edit round-trips as written.
    const file = again.file.replace('name: Echo two', 'name: Echo three')
    assert.equal(b.call('POST', `/agents/${copyId}/update`, { file }).status, 200)
    assert.equal((b.call('GET', `/agents/${copyId}`).body as AgentDetail).file, file)

    // A wider edit is refused with reasons the screen can show, and nothing changes.
    const wider = b.call('POST', `/agents/${copyId}/update`, { definition: { ...patch, tools: ['Read', 'mcp__nope__anything'], connectors: { fake: 'write' } } })
    assert.notEqual(wider.status, 200)
    assert.ok(replyText({ ok: false, ...wider.body }).length > 0)
    assert.equal((b.call('GET', `/agents/${copyId}`).body as AgentDetail).definition.tools.includes('mcp__nope__anything'), false)

    // Built-ins stay read-only; the copy deletes.
    assert.equal(b.call('POST', '/agents/echo/update', { file }).status, 403)
    assert.equal(b.call('POST', `/agents/${copyId}/delete`, { confirm: true }).body.deleted, true)
    assert.equal(b.call('GET', `/agents/${copyId}`).status, 404)
  } finally {
    b.done()
  }
})

// A11: new agents from a template.

test('a template becomes the owner\'s own agent: new id and name, made by the owner, never delegating', () => {
  const t = {
    definition: { v: 1, id: 'coordinator', name: 'Coordinator', description: 'd', mode: 'on-demand' as const, delegate: ['writer'], createdBy: 'builtin' as const, requestedBy: 'x', body: 'b' },
  }
  const out = fromTemplate(t, ' my-coord ', ' Mine ')
  assert.equal(out.id, 'my-coord')
  assert.equal(out.name, 'Mine')
  assert.equal(out.createdBy, 'user')
  assert.deepEqual(out.delegate, [])
  assert.equal('requestedBy' in out, false)
  assert.equal('v' in out, false)
  assert.equal(fromTemplate(t, 'x', '  ').name, 'Coordinator')
})

test('a new id comes from the name and is free', () => {
  assert.equal(suggestNewId('Daily check', []), 'daily-check')
  assert.equal(suggestNewId('Daily check', ['daily-check']), 'daily-check-2')
  assert.equal(suggestNewId('42!!', []), 'my-agent')
  assert.ok(isAgentId(suggestNewId('A'.repeat(80), [])))
})

test('every template from the API creates a valid agent of the owner\'s through the routes', async () => {
  const b = bridge()
  try {
    const templates = ((await b.call('GET', '/agents/templates')).body.templates) as AgentTemplate[]
    assert.ok(templates.length >= 2)
    for (const t of templates) {
      const id = suggestNewId(`${t.name} mine`, [])
      const r = await b.call('POST', '/agents', { definition: fromTemplate(t, id, `${t.name} (mine)`) })
      assert.equal(r.status, 201, `${t.id}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.agent.createdBy, 'user')
      assert.equal(r.body.agent.active, true)
      assert.equal(r.body.agent.switchedOn, t.mode === 'on-demand', 'anything that runs unasked starts off')
    }
  } finally { b.done() }
})
