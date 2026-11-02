/**
 * One chat turn through the brain (plan 20 phase 2, task Q79; spec §5.1–5.5).
 *
 * The pipeline in index.mjs decides who may talk and what is the request;
 * this module turns that into one brain session and gives back the reply
 * text and how sensitive it is. The bridge (server.mjs) supplies `start`,
 * which builds the session exactly like a voice or worker one: the same
 * policy engine, the taint guard, the PostToolUse hook, actor `chat`.
 *
 * Rules kept here:
 * - The sender's own words are the request. Forwarded or quoted text arrives
 *   already wrapped by `wrapUntrusted` and rides after it, as data.
 * - Taint starts on (the caller builds the tracker with `tainted: true`).
 * - The role's tool scope narrows what the turn may use before the policy
 *   engine is asked: `public-read` (children, guests) gets web search only;
 *   `role` (owner, members) gets what the policy engine allows any session.
 *   Effectful actions stay off unless JARVIS_ALLOW_WRITES is on, exactly as
 *   for voice; a channel never switches them on.
 * - A reply after any tool call is `private` (the turn may have read
 *   something of the owner's), so the reply filter in index.mjs decides
 *   whether it may go out. A reply with no tool calls is `public`.
 * - A turn that runs too long is aborted; the pipeline then says it went
 *   wrong rather than leaving the sender waiting.
 */

/** Tools a `public-read` turn may use. Everything else is refused before the policy engine. */
export const PUBLIC_READ_TOOLS = Object.freeze(['WebSearch'])

export const CHAT_TURN_TIMEOUT_MS = 90_000

export const SCOPE_REFUSAL =
  'Not over chat: this person may only chat and search the web from here. Answer without it, in one or two sentences.'

/**
 * A PreToolUse guard for the role's tool scope, run before `next` (the taint
 * guard). Resolves to null to let the call on, or to a refusal sentence.
 */
export function scopeGuard(toolScope, next = null) {
  return async (name, input) => {
    if (toolScope !== 'role' && !PUBLIC_READ_TOOLS.includes(name)) return SCOPE_REFUSAL
    return next ? next(name, input) : null
  }
}

const CHANNEL_NAMES = { telegram: 'Telegram', sms: 'SMS', whatsapp: 'WhatsApp', signal: 'Signal', email: 'email' }

/**
 * The text the brain is given for a chat turn: a one-line header (who and
 * where, never the raw sender id), the request, then any untrusted blocks.
 */
export function chatPrompt(turn) {
  const where = CHANNEL_NAMES[turn.channel] ?? 'a chat channel'
  const who = turn.identity?.role === 'owner' ? 'the owner' : `a ${turn.identity?.role ?? 'guest'} of the household`
  const parts = [`[Message from ${who}, typed on ${where}.]`]
  if (turn.request) parts.push(turn.request)
  else parts.push('(No message of their own: only the forwarded or quoted content below. Ask what they want done with it.)')
  for (const block of turn.untrusted ?? []) parts.push(block)
  return parts.join('\n\n')
}

/**
 * Build `runTurn` for createChannels.
 *
 * @param {object} deps
 * @param {(turn: object, ctx: { prompt: string, signal: AbortSignal }) => AsyncIterable<object>} deps.start
 *        starts a brain session for the turn and returns its BrainEvents
 * @param {number} [deps.timeoutMs]
 * @param {() => number} [deps.now]
 * @param {(ms: number, outcome: string) => void} [deps.onTurn]  latency metric
 */
export function createChatTurns({ start, timeoutMs = CHAT_TURN_TIMEOUT_MS, now = () => Date.now(), onTurn = () => {} } = {}) {
  if (typeof start !== 'function') throw new Error('chat turns: start is required')
  return async function runTurn(turn) {
    if (turn?.via !== 'chat' || turn.taintStart !== true) throw new Error('chat turns: not a chat turn')
    const began = now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    let text = ''
    let usedTools = false
    let outcome = 'error'
    let failure = null
    try {
      const events = await start(turn, { prompt: chatPrompt(turn), signal: controller.signal })
      for await (const e of events) {
        if (controller.signal.aborted) break
        if (e?.t === 'text') text += e.delta ?? ''
        else if (e?.t === 'tool_start' || e?.t === 'tool_call') usedTools = true
        else if (e?.t === 'error') failure = e.code ?? 'error'
        else if (e?.t === 'done') {
          outcome = e.reason === 'complete' ? 'complete' : e.reason ?? 'error'
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (controller.signal.aborted) outcome = 'timeout'
    onTurn(now() - began, outcome)
    if (outcome !== 'complete') throw new Error(`chat turn ended: ${failure ?? outcome}`)
    return { text: text.trim(), sensitivity: usedTools ? 'private' : 'public' }
  }
}
