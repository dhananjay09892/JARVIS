import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeBrain } from './claude.mjs'
import { createBrainRegistry, POLICY_BYPASS } from './registry.mjs'
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
    'plain-answer', 'one-tool-call', 'denied-tool', 'write-tools-refused', 'cancel-mid-stream', 'long-answer', 'tool-error', 'resume',
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
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.id), ['denied-tool', 'write-tools-refused'])
  const noTools = await runConformance(claudeHarness(), { capabilities: { tools: false } })
  assert.deepEqual(noTools.filter((r) => r.skipped).map((r) => r.id), ['one-tool-call', 'denied-tool', 'write-tools-refused', 'tool-error'])
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

// Plan 21 phase 3: the policy contract, on every brain, through the registry.

/** A harness whose brain is the one the registry hands out, in that brain's tool mode. */
const registered = (base) => async (args) => {
  const h = await base(args)
  const brain = createBrainRegistry({ log: null }).register(h.brain)
  return { ...h, brain }
}

/**
 * A reference tool-loop brain (toolGate 'loop'): a model that only proposes
 * calls. It plays the script and runs every call through `params.tools`, the
 * tool bridge the registry gives it. `cheat` makes it run its own handler
 * instead and report success, which the registry must catch.
 */
function loopHarness({ cheat = false, gate = 'loop' } = {}) {
  return ({ script, policy }) => {
    const executed = []
    const steps = script.flat().filter((s) => s.tool).map((s) => s.tool)
    const tools = Object.fromEntries(steps.map((t) => [t.name, async () => {
      executed.push(t.name)
      if (t.error) throw new Error(t.error)
      return t.output ?? ''
    }]))
    const brain = {
      id: 'mock-loop',
      label: 'Mock tool loop',
      capabilities: { tools: gate !== undefined, streaming: true, ...(gate && { toolGate: gate }) },
      status: () => ({ installed: true }),
      startSession() {
        throw new Error('not used')
      },
      converse({ prompt, tools: bridge }) {
        let cancelled = false
        let wake = null
        const turns = typeof prompt === 'string' ? [prompt] : prompt
        async function* events() {
          for (const [n] of turns.entries()) {
            cancelled = false
            for (const step of script[n] ?? []) {
              if (step.say !== undefined) {
                for (const piece of step.say.match(/\S+\s*|\s+/g) ?? []) if (!cancelled) yield { t: 'text', delta: piece }
              } else if (step.tool && !cancelled) {
                const { id, name, args } = step.tool
                yield { t: 'tool_start', id, name }
                yield { t: 'tool_call', id, name, args }
                if (cheat) {
                  await tools[name]()
                  yield { t: 'tool_result', id, ok: true, summary: step.tool.output ?? '', tainted: false }
                } else {
                  yield await bridge.run({ id, name, args })
                }
              } else if (step.stall && !cancelled) {
                await new Promise((resolve) => { wake = resolve })
              } else if (step.usage && !cancelled) {
                yield { t: 'usage', ...step.usage }
              }
            }
            yield { t: 'done', reason: cancelled ? 'cancelled' : 'complete' }
          }
        }
        return {
          events: events(),
          async cancel() {
            cancelled = true
            wake?.()
          },
          close() {},
        }
      },
    }
    return { brain, executed, params: { actor: 'voice', policy, mcpServers: { secret: {} }, tools, guard: async () => null } }
  }
}

test('every brain kind passes the whole suite through the registry', async () => {
  const claude = await runConformance(registered(claudeHarness()), { capabilities: createClaudeBrain({ query() {} }).capabilities })
  assert.deepEqual(claude.filter((r) => !r.ok), [], 'Claude in agent mode')
  assert.equal(claude.filter((r) => r.skipped).length, 0)
  const loop = await runConformance(registered(loopHarness()))
  assert.deepEqual(loop.filter((r) => !r.ok), [], 'a tool-loop brain')
  assert.equal(loop.filter((r) => r.skipped).length, 0)
  // A brain with no pre-execution hook runs read-only: no tool scenarios, and
  // the rest still pass.
  const readOnly = await runConformance(registered(loopHarness({ gate: undefined })), { capabilities: { tools: false } })
  assert.deepEqual(readOnly.filter((r) => !r.ok), [])
  assert.deepEqual(readOnly.filter((r) => r.skipped).map((r) => r.id), ['one-tool-call', 'denied-tool', 'write-tools-refused', 'tool-error'])
})

test('the registry stops a Claude brain whose provider ran a tool without the hook', async () => {
  const scenario = SCENARIOS.find((s) => s.id === 'denied-tool')
  await assert.rejects(runScenario(scenario, registered(claudeHarness({ bypassPolicy: true }))))
  // And says why: the turn ends with a policy_bypass error, not a success.
  const h = await registered(claudeHarness({ bypassPolicy: true }))({ script: scenario.script, policy: (await import('../policy.mjs')).createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false }) })
  const seen = []
  for await (const e of h.brain.converse({ prompt: scenario.prompt, ...h.params }).events) {
    seen.push(e)
    if (e.t === 'done') break
  }
  assert.deepEqual(seen.filter((e) => e.t === 'error').map((e) => e.code), [POLICY_BYPASS])
  assert.equal(seen.at(-1).reason, 'error')
  assert.equal(seen.some((e) => e.t === 'tool_result' && e.ok), false, 'the bypassed result is not passed on as work done')
  assert.equal(seen.some((e) => e.t === 'text'), false, 'the rest of the turn is dropped')
})

test('the registry stops a tool-loop brain that runs a tool around the bridge', async () => {
  for (const id of ['one-tool-call', 'denied-tool']) {
    const scenario = SCENARIOS.find((s) => s.id === id)
    await assert.rejects(runScenario(scenario, registered(loopHarness({ cheat: true }))))
  }
})

test('a tool-loop brain never sees MCP servers, handlers or the policy engine', async () => {
  let given = null
  const brain = createBrainRegistry({ log: null }).register({
    id: 'peek', label: 'Peek', capabilities: { tools: true, toolGate: 'loop' }, status: () => ({}), startSession() {},
    converse(params) {
      given = params
      return { events: (async function* () { yield { t: 'done', reason: 'complete' } })(), cancel() {}, close() {} }
    },
  })
  const policy = (await import('../policy.mjs')).createPolicy({ allowWrites: false, isMemoryTool: () => false, isWorkflowTool: () => false, isTaskTool: () => false })
  brain.converse({ prompt: 'hi', actor: 'worker', policy, mcpServers: { a: {} }, tools: { Read: async () => 'x', Bash: async () => 'y' }, guard: async () => null, afterTool: {}, model: 'm' })
  assert.deepEqual(Object.keys(given).sort(), ['actor', 'model', 'prompt', 'tools'])
  assert.deepEqual(given.tools.offered(), ['Read'], 'only what the policy allows is offered')
  assert.equal(typeof given.tools.run, 'function')
})
