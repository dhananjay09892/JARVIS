import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeBrain } from './claude.mjs'
import { SCENARIOS, runScenario, runConformance, checkStream } from './conformance.mjs'

/**
 * A stand-in for the Agent SDK's query() that plays a conformance script.
 *
 * It does what the real CLI does around a tool call, in the same order:
 * stream the block, send the whole assistant message, skip tools listed in
 * `disallowedTools`, run the PreToolUse hooks, ask canUseTool, and only then
 * run the tool. Every one of those comes from the options the Claude brain
 * built, so the policy engine that refuses a tool here is the real one.
 *
 * After interrupt() it behaves like the SDK too: what was already in flight
 * still arrives, then the turn's one `result`.
 */
function claudeHarness({ bypassPolicy = false, stream = true } = {}) {
  return ({ script, policy }) => {
    const executed = []
    const query = ({ prompt, options }) => {
      let interrupted = false
      let wake = null
      const pieces = (text) => (stream ? text.match(/\S+\s*|\s+/g) ?? [] : [])
      const textDelta = (text) => ({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })
      const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } })

      async function permission(name, args, id) {
        if (bypassPolicy) return null
        if (options.disallowedTools.includes(name)) return `No such tool available: ${name}`
        for (const matcher of options.hooks.PreToolUse) {
          for (const hook of matcher.hooks) {
            const out = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: args })
            if (out?.hookSpecificOutput?.permissionDecision === 'deny') return out.hookSpecificOutput.permissionDecisionReason
          }
        }
        const verdict = await options.canUseTool(name, args, { signal: new AbortController().signal, toolUseID: id })
        return verdict.behavior === 'allow' ? null : verdict.message
      }

      async function* toolStep({ id, name, args, output = '', error }) {
        if (stream) {
          yield { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } } }
        }
        yield assistant([{ type: 'tool_use', id, name, input: args }])
        const refusal = await permission(name, args, id)
        let text = refusal
        if (refusal === null) {
          executed.push(name)
          text = error ?? output
        }
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...((refusal !== null || error) && { is_error: true }) }],
          },
          parent_tool_use_id: null,
        }
      }

      async function* run() {
        yield { type: 'system', subtype: 'init', mcp_servers: [] }
        const turns = typeof prompt === 'string' ? null : prompt[Symbol.asyncIterator]()
        for (const steps of script) {
          if (turns && (await turns.next()).done) return
          interrupted = false
          let usage = { inTokens: 0, outTokens: 0 }
          for (const step of steps) {
            if (step.say !== undefined) {
              for (const piece of pieces(step.say)) yield textDelta(piece)
              yield assistant([{ type: 'text', text: step.say }])
            } else if (step.tool) {
              yield* toolStep(step.tool)
            } else if (step.stall) {
              if (!interrupted) await new Promise((resolve) => { wake = resolve })
            } else if (step.usage) {
              usage = step.usage
            }
          }
          yield {
            type: 'result',
            subtype: interrupted ? 'error_during_execution' : 'success',
            result: '',
            total_cost_usd: 0.001,
            usage: { input_tokens: usage.inTokens, output_tokens: usage.outTokens },
          }
        }
      }

      const it = run()
      return {
        [Symbol.asyncIterator]: () => it,
        async interrupt() {
          interrupted = true
          wake?.()
        },
        close() {
          it.return()
        },
      }
    }

    const brain = createClaudeBrain({ query, status: () => ({}), login() {} })
    return {
      brain,
      executed,
      params: {
        actor: 'voice',
        mcpServers: {},
        systemPrompt: 'You are JARVIS.',
        model: 'claude-test',
        effort: 'low',
        policy,
        guard: async () => null,
        afterTool: { hooks: [async () => ({})] },
        tainted: (name) => name.startsWith('mcp__calendar__'),
      },
    }
  }
}

for (const scenario of SCENARIOS) {
  test(`Claude brain · ${scenario.title}`, async () => {
    await runScenario(scenario, claudeHarness())
  })
}

test('the Claude brain passes the whole suite', async () => {
  const rows = await runConformance(claudeHarness(), { capabilities: createClaudeBrain({ query() {} }).capabilities })
  assert.deepEqual(rows.filter((r) => !r.ok), [])
  assert.deepEqual(rows.map((r) => r.id), [
    'plain-answer', 'one-tool-call', 'denied-tool', 'cancel-mid-stream', 'long-answer', 'tool-error', 'resume',
  ])
})

test('private tool output is marked tainted', async () => {
  const one = SCENARIOS.find((s) => s.id === 'one-tool-call')
  const r = await runScenario(one, claudeHarness())
  assert.equal(r.of(0, 'tool_result')[0].tainted, true)
})

// The suite has to catch broken brains, or passing it means nothing.

/** A brain whose events pass through `transform` (return null to drop one). */
const tampered = (transform, base = claudeHarness()) => async (args) => {
  const h = await base(args)
  const brain = {
    ...h.brain,
    converse(params) {
      const run = h.brain.converse(params)
      return {
        ...run,
        events: (async function* () {
          for await (const e of run.events) {
            const out = transform(e)
            if (out) yield out
          }
        })(),
      }
    },
  }
  return { ...h, brain }
}

const failing = async (id, harness, pattern, options) => {
  const scenario = SCENARIOS.find((s) => s.id === id)
  await assert.rejects(runScenario(scenario, harness, options), pattern)
}

test('the suite fails a brain that runs a tool the policy refused', async () => {
  await failing('denied-tool', claudeHarness({ bypassPolicy: true }), /never run|false/)
})

test('the suite fails a brain that reports a refused tool as a success', async () => {
  await failing('denied-tool', tampered((e) => (e.t === 'tool_result' ? { ...e, ok: true } : e)), /true/)
})

test('the suite fails a brain that speaks the tail of a cancelled answer', async () => {
  await failing('cancel-mid-stream', tampered((e) => (e.t === 'done' ? { t: 'text', delta: ' THE TAIL' } : e)), /done|TAIL|turn/)
})

test('the suite fails a brain that loses a turn boundary', async () => {
  await failing('resume', tampered((e) => (e.t === 'done' ? null : e)), /done|turn/)
})

test('the suite fails a brain that sends an invalid event', async () => {
  await failing('plain-answer', tampered((e) => (e.t === 'usage' ? { ...e, inTokens: -1 } : e)), /not a valid BrainEvent/)
})

test('the suite fails a brain that does not stream a long answer', async () => {
  await failing('long-answer', claudeHarness({ stream: false }), /stream/)
})

test('the suite fails a brain that never finishes', async () => {
  const hung = async (args) => {
    const h = await claudeHarness()(args)
    return {
      ...h,
      brain: { ...h.brain, converse: () => ({ events: (async function* () { await new Promise(() => {}) })(), cancel() {}, close() {} }) },
    }
  }
  await failing('plain-answer', hung, /no done within 50 ms/, { timeoutMs: 50 })
})

test('runConformance reports failures per scenario and skips tool scenarios for a brain without tools', async () => {
  const rows = await runConformance(claudeHarness({ bypassPolicy: true }))
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.id), ['denied-tool'])
  const noTools = await runConformance(claudeHarness(), { capabilities: { tools: false } })
  assert.deepEqual(noTools.filter((r) => r.skipped).map((r) => r.id), ['one-tool-call', 'denied-tool', 'tool-error'])
})

test('checkStream rules', () => {
  const done = { t: 'done', reason: 'complete' }
  assert.throws(() => checkStream([{ t: 'text', delta: 'hi' }], 1), /end on done/)
  assert.throws(() => checkStream([{ t: 'tool_result', id: 'x', ok: true, summary: '', tainted: false }, done], 1), /answers no tool_call/)
  const call = { t: 'tool_call', id: 'c', name: 'Read', args: {} }
  assert.throws(() => checkStream([call, call, done], 1), /repeated/)
  const usage = { t: 'usage', inTokens: 1, outTokens: 1 }
  assert.throws(() => checkStream([usage, usage, done], 1), /more than one usage/)
  assert.equal(checkStream([usage, done, done], 2).length, 2)
})
