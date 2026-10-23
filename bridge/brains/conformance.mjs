/**
 * The brain conformance suite (plan 21, phase 2).
 *
 * Scripted scenarios every brain must pass before JARVIS will use it: a plain
 * answer, one tool call, a denied tool, cancel mid-stream, a long answer, a
 * tool error and a second turn in the same session. The suite only ever sees
 * BrainEvents (events.mjs), so the same scenarios hold every brain to the same
 * behaviour whatever its vendor's stream looks like.
 *
 * The suite brings the policy engine, not the brain: every scenario runs with
 * the bridge's real policy (policy.mjs) with writes off, as a new brain starts
 * (plan 21 "Safety rules"). A tool the policy refuses must come back as a
 * failed `tool_result` and must never run.
 *
 * Each brain supplies a harness: a function that, given a scenario's neutral
 * `script` and the policy, returns
 *   { brain, params, executed }
 * where `brain.converse({ prompt, ...params })` plays the script through the
 * brain's own adapter against a stand-in for its provider, and `executed` is
 * the list of tool names that actually ran. The stand-in must ask the policy
 * through the same hooks the real provider does, so a refusal is the policy's
 * and not the harness's.
 *
 * A script is a list of turns; each turn a list of steps:
 *   { say: 'text' }                                  the model speaks (streamed in pieces)
 *   { tool: { id, name, args, output? , error? } }   the model asks for a tool;
 *                                                    if allowed it runs and returns
 *                                                    `output`, or fails with `error`
 *   { stall: true }                                  the model pauses until interrupted
 *   { usage: { inTokens, outTokens } }               what the turn cost
 *
 * runConformance() runs them all and reports per scenario, so the same suite
 * can feed a pass rate (plan 21 "Metrics") and a later "test this brain"
 * button. conformance.test.mjs holds the Claude brain to it.
 */
import assert from 'node:assert/strict'
import { createPolicy } from '../policy.mjs'
import { checkBrainEvent } from './events.mjs'

/** How long a scenario may take before the brain counts as hung. */
export const SCENARIO_TIMEOUT_MS = 2000

const LONG_ANSWER = Array.from({ length: 60 }, (_, i) =>
  `Point ${i + 1}: the suit's power draw is nominal and the arc reactor holds at ${90 + (i % 10)} percent. `,
).join('')

const usage = { usage: { inTokens: 120, outTokens: 30 } }

export const SCENARIOS = Object.freeze([
  {
    id: 'plain-answer',
    title: 'A plain answer streams text and ends complete',
    prompt: 'Hello, JARVIS.',
    script: [[{ say: 'At your service, sir.' }, usage]],
    check(r) {
      assert.equal(r.text(0), 'At your service, sir.')
      assert.equal(r.of(0, 'tool_call').length, 0)
      assert.equal(r.done(0), 'complete')
      assert.deepEqual(r.of(0, 'usage').map(({ inTokens, outTokens }) => [inTokens, outTokens]), [[120, 30]])
    },
  },
  {
    id: 'one-tool-call',
    title: 'One allowed tool call runs once and its result comes back',
    needs: 'tools',
    prompt: 'What is on my calendar today?',
    script: [[
      { tool: { id: 'call-1', name: 'mcp__calendar__list_events', args: { day: '2026-10-23' }, output: '2 events\nstand-up 10:00; dentist 16:30' } },
      { say: 'Two things today: stand-up at ten and the dentist at half four.' },
      usage,
    ]],
    check(r) {
      const [call] = r.of(0, 'tool_call')
      assert.equal(r.of(0, 'tool_call').length, 1)
      assert.equal(call.name, 'mcp__calendar__list_events')
      assert.deepEqual(call.args, { day: '2026-10-23' })
      const [result] = r.of(0, 'tool_result')
      assert.equal(result.id, call.id)
      assert.equal(result.ok, true)
      assert.equal(result.summary, '2 events')
      assert.deepEqual(r.executed, ['mcp__calendar__list_events'])
      // The answer comes after the result it is based on.
      assert.ok(r.turns[0].indexOf(result) < r.turns[0].findIndex((e) => e.t === 'text'))
      assert.equal(r.done(0), 'complete')
    },
  },
  {
    id: 'denied-tool',
    title: 'A tool the policy refuses never runs and comes back failed',
    needs: 'tools',
    prompt: 'Email the board that I quit.',
    script: [[
      { tool: { id: 'call-1', name: 'mcp__gmail__send_email', args: { to: 'board@example.com', body: 'I quit.' }, output: 'sent' } },
      { say: 'I am not able to send email, sir.' },
      usage,
    ]],
    check(r) {
      const [call] = r.of(0, 'tool_call')
      assert.equal(call.name, 'mcp__gmail__send_email')
      const [result] = r.of(0, 'tool_result')
      assert.equal(result.id, call.id)
      assert.equal(result.ok, false)
      assert.equal(result.tainted, false)
      assert.deepEqual(r.executed, [], 'a refused tool must never run')
      // The refusal is the policy engine's, and it is on the audit trail.
      assert.ok(
        r.audit.some((e) => e.request?.name === 'mcp__gmail__send_email' && e.decision?.verdict === 'deny'),
        'the policy engine was not asked',
      )
      assert.equal(r.done(0), 'complete')
    },
  },
  {
    id: 'cancel-mid-stream',
    title: 'Cancel mid-stream ends the turn cancelled and drops the tail',
    prompt: 'Tell me a long story.',
    script: [[{ say: 'Once upon a time,' }, { stall: true }, { say: ' THE TAIL THAT MUST NOT BE SPOKEN.' }, usage]],
    // Barge-in: cancel as soon as the first words arrive.
    async onEvent(e, run, seen) {
      if (e.t === 'text' && seen.filter((x) => x.t === 'text').length === 1) await run.cancel()
    },
    check(r) {
      assert.equal(r.done(0), 'cancelled')
      assert.match(r.text(0), /^Once/)
      assert.doesNotMatch(r.text(0), /TAIL/)
    },
  },
  {
    id: 'long-answer',
    title: 'A long answer streams in order, in many pieces, without loss',
    prompt: 'Give me the full suit diagnostics.',
    script: [[{ say: LONG_ANSWER }, usage]],
    check(r) {
      assert.equal(r.text(0), LONG_ANSWER)
      assert.ok(r.of(0, 'text').length > 10, 'a long answer must stream, not arrive in one piece')
      assert.equal(r.done(0), 'complete')
    },
  },
  {
    id: 'tool-error',
    title: 'A tool that fails comes back failed and the turn still completes',
    needs: 'tools',
    prompt: 'Read my shopping list.',
    script: [[
      { tool: { id: 'call-1', name: 'Read', args: { file_path: '/home/tony/shopping.txt' }, error: 'ENOENT: no such file or directory' } },
      { say: 'I could not find your shopping list, sir.' },
      usage,
    ]],
    check(r) {
      const [result] = r.of(0, 'tool_result')
      assert.equal(result.ok, false)
      assert.match(result.summary, /ENOENT/)
      assert.deepEqual(r.executed, ['Read'], 'the tool was allowed, so it ran')
      assert.equal(r.text(0), 'I could not find your shopping list, sir.')
      assert.equal(r.done(0), 'complete')
    },
  },
  {
    id: 'resume',
    title: 'A second turn in the same session keeps to its own turn',
    prompt: ['Say alpha.', 'Say bravo.'],
    script: [[{ say: 'ALPHA' }, usage], [{ say: 'BRAVO' }, usage]],
    check(r) {
      assert.equal(r.turns.length, 2)
      assert.equal(r.text(0), 'ALPHA')
      assert.equal(r.text(1), 'BRAVO')
      assert.equal(r.done(0), 'complete')
      assert.equal(r.done(1), 'complete')
    },
  },
])

/**
 * Rules every scenario's stream must keep, whatever the scenario:
 * every event valid; the stream ends on a `done`; one `done` per turn;
 * at most one `usage` per turn, before its `done`; tool_call ids unique in a
 * turn; every tool_result answers a tool_call made earlier in the same turn.
 */
export function checkStream(events, turnCount) {
  for (const [i, e] of events.entries()) {
    const c = checkBrainEvent(e)
    assert.ok(c.ok, `event ${i} is not a valid BrainEvent: ${c.ok ? '' : c.errors.join('; ')}`)
  }
  const turns = splitTurns(events)
  assert.equal(events.at(-1)?.t, 'done', 'the stream must end on done')
  assert.equal(turns.length, turnCount, `expected ${turnCount} turn(s), each ending in one done`)
  for (const [n, turn] of turns.entries()) {
    assert.ok(turn.filter((e) => e.t === 'usage').length <= 1, `turn ${n}: more than one usage`)
    const calls = new Set()
    for (const e of turn) {
      if (e.t === 'tool_call') {
        assert.ok(!calls.has(e.id), `turn ${n}: tool_call ${e.id} repeated`)
        calls.add(e.id)
      }
      if (e.t === 'tool_result') assert.ok(calls.has(e.id), `turn ${n}: tool_result ${e.id} answers no tool_call`)
    }
  }
  return turns
}

function splitTurns(events) {
  const turns = []
  let current = []
  for (const e of events) {
    current.push(e)
    if (e.t === 'done') {
      turns.push(current)
      current = []
    }
  }
  return turns
}

const none = () => false

/** Run one scenario against a brain's harness. Throws an assertion error on failure. */
export async function runScenario(scenario, makeHarness, { timeoutMs = SCENARIO_TIMEOUT_MS } = {}) {
  const audit = []
  const policy = createPolicy({
    allowWrites: false, isMemoryTool: none, isWorkflowTool: none, isTaskTool: none,
    audit: (e) => audit.push(e),
  })
  const harness = await makeHarness({ script: scenario.script, policy })
  const run = harness.brain.converse({ prompt: scenario.prompt, ...harness.params })
  const turnCount = scenario.script.length
  const events = []

  const collect = (async () => {
    let dones = 0
    for await (const e of run.events) {
      events.push(e)
      if (scenario.onEvent) await scenario.onEvent(e, run, events)
      if (e.t === 'done' && ++dones === turnCount) break
    }
  })()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${scenario.id}: no done within ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([collect, timeout])
  } finally {
    clearTimeout(timer)
    run.close()
  }

  const turns = checkStream(events, turnCount)
  const result = {
    events,
    turns,
    executed: harness.executed,
    audit,
    of: (n, t) => turns[n].filter((e) => e.t === t),
    text: (n) => turns[n].filter((e) => e.t === 'text').map((e) => e.delta).join(''),
    done: (n) => turns[n].at(-1).reason,
  }
  scenario.check(result)
  return result
}

/**
 * Run every scenario. A scenario that needs tools is skipped for a brain
 * without them (`capabilities.tools`), and that brain stays out of tool use.
 * Resolves to one row per scenario: { id, title, ok, skipped?, error? }.
 */
export async function runConformance(makeHarness, { capabilities = { tools: true } } = {}) {
  const rows = []
  for (const scenario of SCENARIOS) {
    if (scenario.needs && !capabilities[scenario.needs]) {
      rows.push({ id: scenario.id, title: scenario.title, ok: true, skipped: true })
      continue
    }
    try {
      await runScenario(scenario, makeHarness)
      rows.push({ id: scenario.id, title: scenario.title, ok: true })
    } catch (err) {
      rows.push({ id: scenario.id, title: scenario.title, ok: false, error: String(err?.message ?? err) })
    }
  }
  return rows
}
