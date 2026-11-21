/**
 * Skill runner (plan 19, phase 4): runs an installed skill's steps when its
 * phrase is said, and nothing else.
 *
 * Declarative steps go one by one through two gates: the skill's own gate
 * (skill-manifest.mjs `createSkillGate`: only tools the manifest asked for)
 * and then the policy engine (`policy.authorize`, which writes the audit
 * entry). A step the policy will not run, for example a write while "allow
 * actions" is off, is reported as waiting and is not run; later steps still
 * go through their own checks. A skill with a `script` runs in the sandbox
 * (skill-sandbox.mjs), whose `call()` bridge asks the same two gates.
 *
 * The runner never grants anything. It runs a skill only when the skill is
 * installed, switched on, not paused and the kill switch is off. Tool results
 * are returned as untrusted data for the model to read, never as instructions.
 * Messages are short and never echo tool input.
 *
 * Counts (`stats()`) are numbers only, for Diagnostics.
 */
import { createSkillGate } from './skill-manifest.mjs'
import { matchSkill, resolveSteps } from './skill-registry.mjs'
import { readSkillScript, runSkillScript } from './skill-sandbox.mjs'

const MAX_RESULT_CHARS = 4000
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const textOf = (out) => {
  const s = typeof out === 'string' ? out : Array.isArray(out)
    ? out.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n')
    : out == null ? '' : JSON.stringify(out)
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…` : s
}

/**
 * @param {object} o
 * @param {object} o.registry   createSkillRegistry()
 * @param {object} o.switches   createSkillSwitches()
 * @param {object} o.policy     a policy view with `authorize`
 * @param {Record<string, (input: object) => unknown>} [o.tools]  tool name → handler
 * @param {(entry: object) => void} [o.audit]
 * @param {'voice'|'worker'|'chat'} [o.actor]
 * @param {object} [o.log]
 */
export function createSkillRunner({ registry, switches, policy, tools = {}, audit = null, actor = 'voice', log = console } = {}) {
  if (!registry || !switches || typeof policy?.authorize !== 'function') throw new Error('skill runner: registry, switches and policy are needed')
  const counts = { runs: 0, steps: 0, waiting: 0, refused: 0, failed: 0, blocked: 0 }
  const note = (entry) => { try { audit?.(entry) } catch { /* auditing never breaks a run */ } }

  /** One tool call, through the skill's gate and then the policy. */
  async function callTool(manifest, gate, name, input) {
    const request = { kind: 'tool', name }
    const skillDecision = gate.decide(request)
    if (skillDecision.rule === 'skill-ungranted' || skillDecision.rule === 'skill-unknown') {
      note({ type: 'decision', actor, stage: 'tool-bridge', request, decision: skillDecision })
      return { status: 'refused', reason: skillDecision.reason }
    }
    const { decision, refusal } = await policy.authorize({ name, input, actor, stage: 'tool-bridge', log })
    if (refusal !== null) {
      // "ask" or a write rule means the owner has not switched the effect on.
      const waiting = decision?.verdict === 'ask' || /write|effect|no-read-verb/i.test(decision?.rule ?? '')
      return waiting
        ? { status: 'waiting', reason: 'Waiting: turn on "allow actions" in Settings to let this step run.' }
        : { status: 'refused', reason: typeof decision?.reason === 'string' ? decision.reason : 'The policy did not allow this step.' }
    }
    const handler = tools[name]
    if (typeof handler !== 'function') return { status: 'failed', reason: `${name} is not available to skills here.` }
    try {
      const out = await handler(input)
      note({ type: 'result', actor, request, result: { error: false } })
      return { status: 'ran', output: textOf(out) }
    } catch (err) {
      note({ type: 'result', actor, request, result: { error: true } })
      return { status: 'failed', reason: typeof err?.message === 'string' ? err.message.slice(0, 200) : 'The tool failed.' }
    }
  }

  /** Run an installed skill by id. Never throws. */
  async function run(id, inputs = {}) {
    const state = switches.state(id)
    if (!state.on) { counts.blocked++; return { ok: false, id, blocked: true, reason: state.reason } }
    const skill = registry.get(id)
    if (!skill) return { ok: false, id, reason: `${id} is not installed.` }
    const { manifest } = skill
    counts.runs++
    const gate = createSkillGate({ manifest, policy })
    const given = isRecord(inputs) ? inputs : {}

    if (manifest.script !== undefined) {
      const script = readSkillScript(skill.dir, manifest)
      if (!script.ok) { counts.failed++; return { ok: false, id, reason: 'The skill script could not be read.' } }
      const outcome = await runSkillScript({
        manifest, source: script.source, policy, input: given,
        invokeTool: async (name, args) => {
          const r = await callTool(manifest, gate, name, args)
          counts.steps++
          if (r.status !== 'ran') { counts[r.status === 'waiting' ? 'waiting' : r.status === 'refused' ? 'refused' : 'failed']++; throw new Error(r.reason) }
          return r.output
        },
        onEvent: (e) => e.verdict === 'deny' && note({ type: 'decision', actor, stage: 'tool-bridge', request: { kind: 'tool', name: e.tool ?? '' }, decision: { verdict: e.verdict === 'allow' ? 'allow' : 'deny', rule: e.rule ?? 'skill-script', reason: '' } }),
      })
      if (!outcome.ok) counts.failed++
      return outcome.ok ? { ok: true, id, name: manifest.name, script: true, value: outcome.value } : { ok: false, id, name: manifest.name, reason: outcome.error }
    }

    const filled = resolveSteps(manifest, given)
    if (!filled.ok) {
      const missing = filled.errors.filter((e) => e.endsWith(': needed')).map((e) => e.replace(/^inputs\./, '').replace(/: needed$/, ''))
      return { ok: false, id, name: manifest.name, needsInput: missing, reason: missing.length ? `I need: ${missing.join(', ')}.` : filled.errors.join('; ') }
    }
    const steps = []
    for (const s of filled.steps) {
      const r = await callTool(manifest, gate, s.tool, s.input)
      counts.steps++
      if (r.status === 'waiting') counts.waiting++
      else if (r.status === 'refused') counts.refused++
      else if (r.status === 'failed') counts.failed++
      steps.push({ label: s.label, tool: s.tool, ...r })
    }
    return { ok: steps.every((s) => s.status === 'ran'), id, name: manifest.name, steps }
  }

  /** Whole-utterance match among skills that are on; null when none fires. */
  function match(utterance) {
    return matchSkill(registry.list().filter((s) => s.manifest), utterance, switches)
  }

  return Object.freeze({ run, match, stats: () => ({ ...counts }) })
}
