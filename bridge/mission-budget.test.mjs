import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskManager } from './tasks.mjs'
import { BUDGET_STOPS, AGENT_REFUSALS } from './agent-runtime.mjs'
import {
  MAX_EXTENSIONS, MISSION_CEILINGS, MISSION_DEFAULTS, createMissionSettings, extendLimit, missionGuard, missionLimits, normaliseScope,
  pathAllowed, scopeGuard, scopeRefusal, withCeilings,
} from './mission-budget.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const settle = async () => { for (let i = 0; i < 6; i++) await tick() }

function fakeRun() {
  const runs = []
  const runAgent = (ctx) => {
    const queue = []
    let wake = null
    const run = { ctx, push: (m) => { queue.push(m); wake?.(); wake = null } }
    runs.push(run)
    return (async function* () {
      for (;;) {
        while (!queue.length) await new Promise((r) => { wake = r })
        const m = queue.shift()
        if (m === null) return
        yield m
      }
    })()
  }
  return { runAgent, runs }
}

const LIMITS = { maxToolCalls: 2, maxMinutes: 5, maxCostUsd: 1, maxTokens: 1000 }
function manager(over = {}) {
  const f = fakeRun()
  const stops = []
  const cards = []
  const m = createTaskManager({
    runAgent: f.runAgent, log: silent, missionDefaults: () => LIMITS, onStop: (e) => stops.push(e),
    costCounts: () => true,
    approveMore: async (title) => { cards.push(title); return over.answer ?? false },
    ...over,
  })
  return { ...f, m, stops, cards }
}

// ---- limits ---------------------------------------------------------------

test('every limit is cut to its ceiling and a missing one becomes the ceiling', () => {
  assert.deepEqual(withCeilings({ maxToolCalls: 5000, maxMinutes: 1, maxCostUsd: -3, maxTokens: 'lots' }),
    { maxToolCalls: 1000, maxMinutes: 1, maxCostUsd: 100, maxTokens: 5_000_000 })
  assert.deepEqual(withCeilings(null), { ...MISSION_CEILINGS })
  assert.deepEqual(missionLimits({ maxToolCalls: 99999 }), { ...MISSION_DEFAULTS, maxToolCalls: 1000 })
})

test('a mission can ask for less than it was given, never more', () => {
  const given = { maxToolCalls: 40, maxMinutes: 30, maxCostUsd: 2, maxTokens: 500_000 }
  assert.deepEqual(missionLimits(given, { maxToolCalls: 5, maxMinutes: 999, maxCostUsd: 0.5 }),
    { maxToolCalls: 5, maxMinutes: 30, maxCostUsd: 0.5, maxTokens: 500_000 })
  assert.equal(missionLimits(given, { maxToolCalls: 0 }).maxToolCalls, 40, 'zero calls is not a way to switch a limit off')
})

test('the settings give the defaults and fall back to the built-in ones on nonsense', () => {
  const read = (v) => (id) => v[id]
  const ok = createMissionSettings({ read: read({ JARVIS_MISSIONS_BUDGET: '10 calls, 5 min, $0.50', JARVIS_MISSIONS_TOKENS: '20000', JARVIS_MISSIONS_OVERSPEND: 'stop' }) })
  assert.deepEqual(ok.defaultLimits(), { maxToolCalls: 10, maxMinutes: 5, maxCostUsd: 0.5, maxTokens: 20000 })
  assert.equal(ok.overspend(), 'stop')
  const bad = createMissionSettings({ read: read({ JARVIS_MISSIONS_BUDGET: 'unlimited', JARVIS_MISSIONS_TOKENS: '99999999999', JARVIS_MISSIONS_OVERSPEND: 'never' }) })
  assert.deepEqual(bad.defaultLimits(), { ...MISSION_DEFAULTS })
  assert.equal(bad.overspend(), 'ask')
  const throws = createMissionSettings({ read: () => { throw new Error('x') } })
  assert.deepEqual(throws.defaultLimits(), { ...MISSION_DEFAULTS })
})

test('more can be allowed twice, and never past the ceiling', () => {
  const start = { maxToolCalls: 40, maxMinutes: 30, maxCostUsd: 2, maxTokens: 500_000 }
  const one = extendLimit(start, start, 'maxToolCalls', 0)
  assert.equal(one.maxToolCalls, 60)
  assert.equal(extendLimit(one, start, 'maxToolCalls', 1).maxToolCalls, 80)
  assert.equal(extendLimit(one, start, 'maxToolCalls', MAX_EXTENSIONS), null)
  const top = { ...start, maxMinutes: MISSION_CEILINGS.maxMinutes }
  assert.equal(extendLimit(top, top, 'maxMinutes', 0), null, 'a limit at its ceiling cannot grow')
  const near = { ...start, maxToolCalls: 990 }
  assert.equal(extendLimit(near, near, 'maxToolCalls', 0).maxToolCalls, 1000)
  assert.equal(extendLimit(start, start, 'maxCostUsd', 0).maxCostUsd, 3)
})

// ---- scope ----------------------------------------------------------------

const root = resolve(tmpdir(), 'mission-root')
test('a scope keeps only well-formed entries, and an empty one narrows nothing', () => {
  assert.equal(normaliseScope(null), null)
  assert.equal(normaliseScope({ allowedPaths: ['relative/dir'], allowedDomains: ['not a host!'], allowedTools: [''] }), null)
  const s = normaliseScope({ allowedTools: ['Read', 'Read'], allowedPaths: [root], allowedDomains: ['https://Example.com/path', 'news.example.org'] })
  assert.deepEqual(s.allowedTools, ['Read'])
  assert.deepEqual(s.allowedPaths, [root])
  assert.deepEqual(s.allowedDomains, ['example.com', 'news.example.org'])
})

test('paths: inside the folder is fine; outside, a sibling prefix and .. are not', () => {
  assert.equal(pathAllowed(resolve(root, 'a', 'b.txt'), [root]), true)
  assert.equal(pathAllowed(root, [root]), true)
  assert.equal(pathAllowed(`${root}-other/x`, [root]), false)
  assert.equal(pathAllowed(resolve(root, '..', 'secret'), [root]), false)
  assert.equal(pathAllowed(`${root}/a/../../secret`, [root]), false)
  assert.equal(pathAllowed('relative', [root]), false)
})

test('the scope refuses tools, paths, domains and shells outside it, and only those', () => {
  const scope = normaliseScope({ allowedTools: ['Read', 'WebFetch'], allowedPaths: [root], allowedDomains: ['example.com'] })
  assert.equal(scopeRefusal(scope, 'Read', { file_path: resolve(root, 'x.md') }), null)
  assert.equal(scopeRefusal(scope, 'Read', { file_path: resolve(root, '..', 'x.md') })?.kind, 'path')
  assert.equal(scopeRefusal(scope, 'Read', { file_path: '../x.md' })?.kind, 'path')
  assert.equal(scopeRefusal(scope, 'Write', { file_path: resolve(root, 'x') })?.kind, 'tool')
  assert.equal(scopeRefusal(scope, 'WebFetch', { url: 'https://docs.example.com/a' }), null)
  assert.equal(scopeRefusal(scope, 'WebFetch', { url: 'https://example.com.evil.net/a' })?.kind, 'domain')
  assert.equal(scopeRefusal(scope, 'WebFetch', { url: 'https://evil.net/?r=example.com' })?.kind, 'domain')
  assert.equal(scopeRefusal(scope, 'WebFetch', { prompt: 'summarise https://evil.net/x' })?.kind, 'domain')
  const shell = normaliseScope({ allowedTools: ['Bash'], allowedPaths: [root] })
  assert.equal(scopeRefusal(shell, 'Bash', { command: 'cat /etc/passwd' })?.kind, 'shell')
  assert.equal(scopeRefusal(null, 'Anything', {}), null)
  assert.equal(scopeRefusal(scope, 'mcp__jarvis_task__report_progress', {}), null, 'progress reports are always allowed')
})

test('the guard answers with the refusal, tells the audit, and otherwise hands on', async () => {
  const heard = []
  const scope = normaliseScope({ allowedTools: ['Read'] })
  const g = scopeGuard(scope, async () => 'next', (r) => heard.push(r))
  assert.equal(await g('Read', {}), 'next')
  assert.match(await g('Write', {}), /outside what this mission may use/)
  assert.deepEqual(heard.map((h) => [h.kind, h.tool]), [['tool', 'Write']])
  const broken = scopeGuard(scope, null, () => { throw new Error('audit down') })
  assert.match(await broken('Write', {}), /outside/)
})

test('the mission guard counts calls, skips progress reports, then checks the scope', async () => {
  const seen = []
  const budget = { toolCall: (n) => { seen.push(n); return null } }
  const g = missionGuard({ budget, scope: normaliseScope({ allowedTools: ['Read'] }), next: async () => null })
  assert.equal(await g('Read', {}), null)
  assert.match(await g('Write', {}), /outside/)
  assert.equal(await g('mcp__jarvis_task__report_progress', {}), null)
  assert.deepEqual(seen, ['Read', 'Write'])
  const over = missionGuard({ budget: { toolCall: async () => AGENT_REFUSALS.budget } })
  assert.equal(await over('Read', {}), AGENT_REFUSALS.budget)
})

// ---- the manager ----------------------------------------------------------

test('a plain mission gets every limit, cut to the ceilings; without defaults it gets none, as before', async () => {
  const a = manager()
  a.m.spawn({ goal: 'x' })
  await tick()
  assert.ok(a.runs[0].ctx.budget, 'a plain mission has a budget')
  assert.deepEqual(a.m.list()[0].limits, LIMITS)
  const b = fakeRun()
  const old = createTaskManager({ runAgent: b.runAgent, log: silent })
  old.spawn({ goal: 'x' })
  await tick()
  assert.equal(b.runs[0].ctx.budget, undefined)
})

test('asking for less lowers the limits; asking for more changes nothing', async () => {
  const { m, runs } = manager()
  m.spawn({ goal: 'x', limits: { maxToolCalls: 1, maxMinutes: 600, maxCostUsd: 50 } })
  await tick()
  assert.deepEqual(m.list()[0].limits, { maxToolCalls: 1, maxMinutes: 5, maxCostUsd: 1, maxTokens: 1000 })
  assert.equal(runs[0].ctx.budget.toolCall(), null)
})

test('tool calls: the one past the limit stops the mission, with the reason and an audit entry', async () => {
  const { m, runs, stops, cards } = manager({ overspend: () => 'stop' })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  const b = runs[0].ctx.budget
  assert.equal(b.toolCall(), null)
  assert.equal(b.toolCall(), null)
  assert.equal(await b.toolCall(), AGENT_REFUSALS.budget)
  const t = m.get(task.id)
  assert.equal(t.status, 'failed')
  assert.equal(t.error, BUDGET_STOPS.toolCalls(2))
  assert.deepEqual(stops.map((s) => s.rule), ['mission-calls'])
  assert.equal(cards.length, 0, 'the setting says stop, so no card')
  assert.equal(runs[0].ctx.signal.aborted, true)
})

test('time: the minutes limit stops the mission', async () => {
  const { m, runs, stops } = manager({ missionDefaults: () => ({ ...LIMITS, maxMinutes: 0.0005 }), overspend: () => 'stop' })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(m.get(task.id).status, 'failed')
  assert.equal(m.get(task.id).error, BUDGET_STOPS.minutes(0.0005))
  assert.equal(runs[0].ctx.signal.aborted, true)
  assert.deepEqual(stops.map((s) => s.rule), ['mission-minutes'])
})

test('cost: a billed mission stops at its cost limit; an unbilled one does not', async () => {
  for (const billed of [true, false]) {
    const { m, runs, stops } = manager({ overspend: () => 'stop', costCounts: () => billed })
    const { task } = m.spawn({ goal: 'x' })
    await tick()
    runs[0].push({ t: 'usage', inTokens: 1, outTokens: 1, costUsd: 1.5 })
    await settle()
    assert.equal(m.get(task.id).status, billed ? 'failed' : 'running')
    if (billed) {
      assert.equal(m.get(task.id).error, BUDGET_STOPS.cost(1))
      assert.deepEqual(stops.map((s) => s.rule), ['mission-cost'])
    }
    m.cancelAll()
  }
})

test('tokens: input and output count together, across usage reports', async () => {
  const { m, runs, stops } = manager({ overspend: () => 'stop' })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  runs[0].push({ t: 'usage', inTokens: 400, outTokens: 100 })
  await settle()
  assert.equal(m.get(task.id).status, 'running')
  assert.equal(m.get(task.id).usage.tokens, 500)
  runs[0].push({ t: 'usage', inTokens: 400, outTokens: 100 })
  await settle()
  assert.equal(m.get(task.id).status, 'failed')
  assert.equal(m.get(task.id).error, BUDGET_STOPS.tokens(1000))
  assert.deepEqual(stops.map((s) => s.rule), ['mission-tokens'])
})

test('ask before spending more: a "yes" lets it carry on and audits it; a "no" stops it', async () => {
  const yes = manager({ answer: true })
  const a = yes.m.spawn({ goal: 'x' }).task
  await tick()
  const b = yes.runs[0].ctx.budget
  b.toolCall(); b.toolCall()
  assert.equal(await b.toolCall(), null, 'the third call waits for the card, then goes ahead')
  assert.equal(yes.cards.length, 1)
  assert.match(yes.cards[0], /limit of 2 tool calls\. Allow more\?/)
  assert.equal(yes.m.get(a.id).limits.maxToolCalls, 3)
  assert.equal(yes.m.get(a.id).extensions, 1)
  assert.equal(yes.m.get(a.id).status, 'running')
  assert.deepEqual(yes.stops.map((s) => s.rule), ['mission-calls-extended'])

  const no = manager({ answer: false })
  const c = no.m.spawn({ goal: 'x' }).task
  await tick()
  const d = no.runs[0].ctx.budget
  d.toolCall(); d.toolCall()
  assert.equal(await d.toolCall(), AGENT_REFUSALS.budget)
  assert.equal(no.m.get(c.id).status, 'failed')
  assert.deepEqual(no.stops.map((s) => s.rule), ['mission-calls'])
})

test('the owner is asked at most twice; then the mission stops', async () => {
  const { m, runs, cards } = manager({ answer: true, missionDefaults: () => ({ ...LIMITS, maxToolCalls: 2 }) })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  const b = runs[0].ctx.budget
  let answer = null
  for (let i = 0; i < 12 && answer === null; i++) answer = await b.toolCall()
  assert.equal(answer, AGENT_REFUSALS.budget)
  assert.equal(cards.length, MAX_EXTENSIONS)
  assert.equal(m.get(task.id).status, 'failed')
  assert.equal(m.get(task.id).limits.maxToolCalls, 4)
})

test('with no way to show a card, a limit is a stop, not an unlimited run', async () => {
  const { m, runs } = manager({ approveMore: null })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  const b = runs[0].ctx.budget
  b.toolCall(); b.toolCall()
  assert.equal(await b.toolCall(), AGENT_REFUSALS.budget)
  assert.equal(m.get(task.id).status, 'failed')
})

test('two calls at the limit at once raise one card', async () => {
  const { m, runs, cards } = manager({ answer: true, missionDefaults: () => ({ ...LIMITS, maxToolCalls: 4 }) })
  m.spawn({ goal: 'x' })
  await tick()
  const b = runs[0].ctx.budget
  for (let i = 0; i < 4; i++) b.toolCall()
  const both = await Promise.all([b.toolCall(), b.toolCall()])
  assert.deepEqual(both, [null, null])
  assert.equal(cards.length, 1)
})

test('a mission started with a scope keeps it on the board and across a restart', async () => {
  const saved = []
  const store = { save: (t) => saved.push(JSON.parse(JSON.stringify(t))), load: () => [], remove() {} }
  const f = fakeRun()
  const m = createTaskManager({ runAgent: f.runAgent, store, log: silent, missionDefaults: () => LIMITS })
  const { task } = m.spawn({ goal: 'x', scope: { allowedPaths: [root], allowedDomains: ['example.com'] } })
  await tick()
  assert.deepEqual(m.get(task.id).scope, { allowedTools: [], allowedPaths: [root], allowedDomains: ['example.com'] })
  assert.deepEqual(f.runs[0].ctx.task.scope.allowedPaths, [root])
  const last = saved.at(-1)
  const again = createTaskManager({ runAgent: fakeRun().runAgent, store: { save() {}, load: () => [last], remove() {} }, log: silent, missionDefaults: () => LIMITS })
  const back = again.get(task.id)
  assert.equal(back.status, 'paused')
  assert.deepEqual(back.scope.allowedPaths, [root])
})

test('scope refusals reach the audit hook the session was given', async () => {
  const { m, runs, stops } = manager()
  m.spawn({ goal: 'x', scope: { allowedTools: ['Read'] } })
  await tick()
  runs[0].ctx.scopeDenied({ kind: 'tool', tool: 'Write', reason: 'no' })
  assert.deepEqual(stops.map((s) => s.rule), ['mission-scope-tool'])
})

test('a pause and resume keeps what the owner allowed, within the ceilings', async () => {
  const { m, runs } = manager({ answer: true })
  const { task } = m.spawn({ goal: 'x' })
  await tick()
  const b = runs[0].ctx.budget
  b.toolCall(); b.toolCall()
  await b.toolCall()
  assert.equal(m.get(task.id).limits.maxToolCalls, 3)
  m.pause(task.id)
  m.resume(task.id)
  await tick()
  assert.equal(m.get(task.id).limits.maxToolCalls, 3)
  assert.equal(m.get(task.id).extensions, 1)
  m.cancelAll()
})
