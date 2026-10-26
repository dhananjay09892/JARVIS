/**
 * The OpenAI-compatible brain (plan 25, phase 1).
 *
 * One adapter for every provider that speaks the OpenAI Chat Completions
 * wire format (OpenAI itself, and later OpenRouter, Groq, vLLM, LM Studio and
 * the rest, plan 25 phase 3). What differs between them lives in a small
 * profile: base URL, how the key is sent, a default model and capability
 * flags. Only the OpenAI profile exists so far.
 *
 * This is a tool-loop brain (`toolGate: 'loop'`, registry.mjs): the model only
 * proposes tool calls. JARVIS runs the loop here, and every proposed call goes
 * through `params.tools`, the policy-gated tool bridge (tool-bridge.mjs) the
 * registry builds for the session. The adapter never sees a tool handler, so
 * it cannot run a tool around the policy engine; the registry also checks
 * every `tool_result` it reports against what the bridge decided.
 *
 * The API key is fetched from `getKey()` when a request is made and is only
 * ever put in that request's header. It runs in the bridge, never in the
 * browser (plan 25 "Keys"), is never logged, and is scrubbed from provider
 * error messages. A non-loopback base URL must be https, so a key is never
 * sent in the clear.
 *
 * The OpenAI profile has a second way to pay (ADR 001, task Q43): Sign in
 * with ChatGPT (`auth: 'chatgpt'`), which uses the user's own ChatGPT plan.
 * SIWC tokens are only good for the Responses API, so that mode speaks the
 * Responses wire format (`POST /v1/responses`, `store: false`, streamed)
 * instead of Chat Completions; the tool loop, the policy gate and the events
 * are the same. The access token comes from siwc.mjs per request; a
 * background (worker) turn needs the user's express consent first. A
 * plan-usage error stops the turn with its own code and never falls back to
 * an API key on its own (OpenAI: "must not silently switch to another
 * billing path").
 *
 * `fetch` is passed in (defaulting to Node's), so the tests drive the whole
 * adapter against a local mock server and no paid key is needed.
 */
import { MANAGE_USAGE_URL, SiwcError } from './siwc.mjs'

/** Most model requests in one turn (each tool round is one). */
export const MAX_STEPS = Object.freeze({ voice: 8, worker: 24 })

/** How long one model request may stay silent before it counts as hung. */
export const REQUEST_TIMEOUT_MS = 120_000

/** Most characters of one tool's output handed back to the model. */
export const TOOL_OUTPUT_MAX = 20_000

/**
 * Provider profiles. A profile is data, not code, so later ones (and a
 * user-made one from Settings, plan 25 phase 3) are just more entries.
 *
 *   baseUrl       the `/v1` root; chat completions are at `${baseUrl}/chat/completions`
 *   auth          'bearer' → `Authorization: Bearer <key>`; 'none' → no key (local servers)
 *   defaultModel  used when the session names none; the user can override it
 *   capabilities  what the router and Settings may assume (plan 21)
 */
export const PROFILES = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI (API key)',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    defaultModel: 'gpt-5-mini',
    capabilities: Object.freeze({ tools: true, streaming: true, vision: true, parallelTools: true }),
    // Sign in with ChatGPT is offered for this profile (Q43). Its token is
    // for api.openai.com's Responses API only.
    siwc: true,
  }),
})

/** Ways to pay for a profile: its own key, or (OpenAI only) the user's ChatGPT plan. */
export const AUTH_MODES = Object.freeze(['apikey', 'chatgpt'])

/**
 * How a Responses API error code ends the turn. The codes are OpenAI's SIWC
 * plan-usage errors ("Errors and recovery", checked 2026-10-25). None of them
 * switches to another billing path.
 */
export const RESPONSES_ERRORS = Object.freeze({
  subscription_sharing_usage_limit_exceeded: Object.freeze({
    code: 'usage_limit', retryable: false,
    message: `The ChatGPT plan usage for JARVIS has reached its limit. Check or change it in ChatGPT settings → Usage (${MANAGE_USAGE_URL}).`,
  }),
  subscription_sharing_user_not_eligible: Object.freeze({
    code: 'not_eligible', retryable: false,
    message: 'ChatGPT plan usage is not available for this account or workspace. Use an API key instead, or ask the workspace admin.',
  }),
  subscription_sharing_usage_unavailable: Object.freeze({ code: 'provider', retryable: true, message: 'OpenAI could not check the plan usage just now. Try again in a moment.' }),
  subscription_sharing_user_unavailable: Object.freeze({ code: 'provider', retryable: true, message: 'OpenAI could not serve this account just now. Try again in a moment.' }),
  subscription_sharing_unsupported_capability: Object.freeze({ code: 'request', retryable: false, message: 'ChatGPT plan usage does not support part of this request' }),
  subscription_sharing_route_not_supported: Object.freeze({ code: 'request', retryable: false, message: 'ChatGPT plan usage does not support this request route.' }),
  subscription_sharing_invalid_user: Object.freeze({ code: 'auth', retryable: false, message: 'OpenAI did not accept the ChatGPT sign-in. Sign in again from Settings → Brains.' }),
  chatpass_v2_scope_not_authorized: Object.freeze({ code: 'auth', retryable: false, message: 'This ChatGPT sign-in does not allow plan usage. Sign in again and allow plan usage.' }),
  chatpass_v2_invalid_authorization_context: Object.freeze({ code: 'auth', retryable: false, message: 'This ChatGPT sign-in does not allow plan usage. Sign in again and allow plan usage.' }),
})

/** A Responses API error (`{ code, message, param }`) as a BrainEvent error. */
export function responsesError(err, status = 0, key = null) {
  const code = typeof err?.code === 'string' ? err.code : null
  const known = code ? RESPONSES_ERRORS[code] : null
  if (known) {
    const param = typeof err.param === 'string' && code === 'subscription_sharing_unsupported_capability' ? `: ${scrub(err.param).slice(0, 80)}.` : ''
    return { code: known.code, retryable: known.retryable, message: `${known.message}${param}` }
  }
  const message = typeof err?.message === 'string' ? err.message : typeof err?.detail === 'string' ? err.detail : status ? `HTTP ${status}` : 'The provider reported an error.'
  return { ...(status ? httpError(status) : { code: 'provider', retryable: true }), message: scrub(message, key) }
}

/** A sign-in problem as a BrainEvent error. */
function siwcBrainError(err) {
  const code = err.code === 'consent_needed' ? 'consent_needed' : err.code === 'network' ? 'network' : 'auth'
  return { code, retryable: Boolean(err.retryable), message: err.message }
}

// Same rule as `Id` in shared/contracts.ts and events.mjs.
const ID = /^[^\s\u0000-\u001f]{1,128}$/
// Function names the OpenAI API accepts.
const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)

/** Is this base URL safe to send a key to? https anywhere, http only to this machine. */
export function checkBaseUrl(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('The brain base URL is not a valid URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.href.replace(/\/+$/, '')
  throw new Error('The brain base URL must use https (plain http is allowed only for this computer).')
}

/** A provider message with the key, and anything shaped like a key, taken out. */
export function scrub(text, key) {
  let out = String(text ?? '')
  if (key) out = out.split(key).join('[key]')
  return out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_*-]{6,}/g, '[key]').slice(0, 300)
}

/** How an HTTP failure ends the turn. */
export function httpError(status) {
  if (status === 401 || status === 403) return { code: 'auth', retryable: false }
  if (status === 429) return { code: 'rate_limit', retryable: true }
  if (status === 408 || status >= 500) return { code: 'provider', retryable: true }
  return { code: 'request', retryable: false }
}

/**
 * Server-sent events from a fetch Response body, as parsed `data:` payloads.
 * Stops at `[DONE]`. Lines that are not JSON are skipped, not fatal: some
 * compatible servers send keep-alive comments.
 */
export async function* sseData(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let cut
    while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data)
      } catch {
        // not JSON: ignore
      }
    }
  }
}

/**
 * The OpenAI function definitions for the tools the bridge offers. `specs`
 * maps a tool name to `{ description, parameters }` (JSON Schema); a tool
 * without a spec still gets a permissive one. Names the API would reject are
 * left out rather than renamed, so a call always names a real tool.
 */
export function toolDefinitions(names, specs = {}) {
  return names
    .filter((name) => FUNCTION_NAME.test(name))
    .map((name) => {
      const spec = isRecord(specs[name]) ? specs[name] : {}
      return {
        type: 'function',
        function: {
          name,
          ...(typeof spec.description === 'string' && { description: spec.description }),
          parameters: isRecord(spec.parameters) ? spec.parameters : { type: 'object', properties: {} },
        },
      }
    })
}

/**
 * The same tools in the Responses API's flat shape. `strict: false`, because
 * the Responses API otherwise holds a schema to strict mode, which the
 * bridge's permissive schemas do not meet.
 */
export function responsesToolDefinitions(names, specs = {}) {
  return toolDefinitions(names, specs).map(({ function: f }) => ({ type: 'function', ...f, strict: false }))
}

/**
 * The adapter's history (Chat Completions messages) as Responses API input:
 * the system prompt becomes `instructions`; tool calls and results become
 * `function_call` and `function_call_output` items with matching call ids.
 * With `store: false` nothing is kept on OpenAI's side, so the whole
 * conversation goes with every request.
 */
export function responsesInput(history) {
  const system = []
  const input = []
  for (const m of history) {
    if (m.role === 'system') system.push(m.content)
    else if (m.role === 'user') input.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const c of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments })
    } else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
  }
  return { ...(system.length && { instructions: system.join('\n\n') }), input }
}

/**
 * Build an OpenAI-compatible brain.
 *
 * @param {object} deps
 * @param {object} [deps.profile]  a PROFILES entry, or one shaped like it (default: OpenAI)
 * @param {object} [deps.overrides] baseUrl / defaultModel the user has set
 * @param {() => (string|null|Promise<string|null>)} [deps.getKey] the API key, from the keychain
 * @param {() => boolean} [deps.hasKey] is a key stored? (for status(); never returns the key)
 * @param {'apikey'|'chatgpt'} [deps.auth] how this brain is paid for (default: its key)
 * @param {object} [deps.siwc]   the Sign in with ChatGPT client (siwc.mjs), for auth 'chatgpt'
 * @param {typeof fetch} [deps.fetch]
 * @param {number} [deps.timeoutMs]
 * @param {object} [deps.log]
 */
export function createOpenAICompatibleBrain({
  profile = PROFILES.openai, overrides = {}, getKey = () => null, hasKey = () => false,
  auth = 'apikey', siwc = null,
  fetch: fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = console,
} = {}) {
  if (!profile || typeof profile.id !== 'string') throw new Error('The OpenAI-compatible brain needs a profile.')
  if (typeof fetchImpl !== 'function') throw new Error('The OpenAI-compatible brain needs fetch().')
  if (!AUTH_MODES.includes(auth)) throw new Error(`Unknown brain auth mode: ${auth}.`)
  const chatgpt = auth === 'chatgpt'
  if (chatgpt && !profile.siwc) throw new Error(`Sign in with ChatGPT is not offered for the ${profile.id} profile.`)
  if (chatgpt && (!siwc || typeof siwc.accessToken !== 'function')) throw new Error('Sign in with ChatGPT needs its sign-in client.')
  const baseUrl = checkBaseUrl(overrides.baseUrl ?? profile.baseUrl)
  if (chatgpt) {
    // The plan-usage token is for OpenAI's own API; it never goes anywhere
    // else (a loopback URL is allowed for the tests' mock server).
    const u = new URL(baseUrl)
    if (baseUrl !== PROFILES.openai.baseUrl && u.protocol !== 'http:') throw new Error('Sign in with ChatGPT only works with api.openai.com.')
  }
  const defaultModel = overrides.defaultModel ?? profile.defaultModel
  const needsKey = !chatgpt && profile.auth !== 'none'
  const wire = chatgpt ? 'responses' : 'chat'

  return Object.freeze({
    id: profile.id,
    label: chatgpt ? 'OpenAI (Sign in with ChatGPT)' : profile.label,
    // `resume` is false: JARVIS owns history across sessions (conversation.mjs);
    // within one session the adapter keeps the turns itself.
    capabilities: Object.freeze({
      tools: Boolean(profile.capabilities?.tools),
      streaming: true,
      resume: false,
      vision: Boolean(profile.capabilities?.vision),
      offline: false,
      ...(profile.capabilities?.tools && { toolGate: 'loop' }),
    }),

    /** Configured? Never throws and never returns the key. */
    status() {
      if (chatgpt) {
        let s = null
        try {
          s = siwc.status()
        } catch {
          s = null
        }
        return {
          installed: true,
          version: '',
          authenticated: Boolean(s?.planUsage),
          authMode: 'chatgpt',
          baseUrl,
          model: defaultModel,
          account: s?.account ?? null,
          backgroundConsent: Boolean(s?.backgroundConsent),
          manageUsageUrl: MANAGE_USAGE_URL,
        }
      }
      let stored = false
      try {
        stored = Boolean(hasKey())
      } catch {
        stored = false
      }
      return {
        installed: true,
        version: '',
        authenticated: needsKey ? stored : true,
        authMode: needsKey ? 'apikey' : 'none',
        baseUrl,
        model: defaultModel,
      }
    },

    /** There is no raw provider session to hand out: converse() is the session. */
    startSession(params) {
      return this.converse(params)
    },

    /**
     * Run a conversation as BrainEvents.
     *
     * @param {object} p
     * @param {string|Iterable<string>|AsyncIterable<string>} p.prompt  one turn, or a turn at a time
     * @param {string} [p.systemPrompt]
     * @param {string} [p.model]
     * @param {'voice'|'worker'} [p.actor]
     * @param {object} [p.tools]      the tool bridge (registry.mjs builds it); absent → no tools
     * @param {object} [p.toolSpecs]  tool name → { description, parameters }
     * @param {boolean} [p.readOnly]
     * @param {number} [p.maxSteps]
     */
    converse({ prompt, systemPrompt, model = defaultModel, actor = 'voice', tools = null, toolSpecs = {}, readOnly = false, maxSteps } = {}) {
      const turns = turnSource(prompt)
      const steps = maxSteps ?? MAX_STEPS[actor] ?? MAX_STEPS.voice
      const bridge = !readOnly && tools && typeof tools.run === 'function' && typeof tools.offered === 'function' ? tools : null
      const history = systemPrompt ? [{ role: 'system', content: systemPrompt }] : []
      const usedIds = new Set() // tool call ids this session, so none repeats
      let turnNo = 0
      let controller = null // the request in flight
      let cancelled = false // was the turn in progress cancelled?
      let inTurn = false
      let closed = false

      async function* turn(text) {
        turnNo++
        inTurn = true
        cancelled = false
        history.push({ role: 'user', content: text })
        // Read once, so a model change between turns never lands mid-turn.
        const turnModel = model
        const usage = { inTokens: 0, outTokens: 0, seen: false }
        const endUsage = () => (usage.seen ? [{ t: 'usage', inTokens: usage.inTokens, outTokens: usage.outTokens }] : [])
        let callNo = 0

        for (let step = 0; ; step++) {
          if (cancelled) return yield* [...endUsage(), { t: 'done', reason: 'cancelled' }]
          if (step >= steps) {
            return yield* [...endUsage(), { t: 'error', code: 'max_steps', retryable: false, message: `Stopped after ${steps} model requests in one turn.` }, { t: 'done', reason: 'limit' }]
          }
          const names = bridge ? bridge.offered() : []
          let body
          if (wire === 'responses') {
            const offered = responsesToolDefinitions(names, toolSpecs)
            body = { model: turnModel, ...responsesInput(history), stream: true, store: false, ...(offered.length && { tools: offered }) }
          } else {
            const offered = toolDefinitions(names, toolSpecs)
            body = {
              model: turnModel,
              messages: history,
              stream: true,
              stream_options: { include_usage: true },
              ...(offered.length && { tools: offered }),
            }
          }

          let reply
          try {
            reply = yield* request(body, usage)
          } catch (err) {
            if (cancelled) return yield* [...endUsage(), { t: 'done', reason: 'cancelled' }]
            const e = err?.brainError ?? { code: 'network', retryable: true, message: scrub(err?.message ?? err) }
            return yield* [...endUsage(), { t: 'error', ...e }, { t: 'done', reason: 'error' }]
          }
          if (cancelled) return yield* [...endUsage(), { t: 'done', reason: 'cancelled' }]

          const calls = reply.calls
          if (calls.length === 0) {
            history.push({ role: 'assistant', content: reply.text })
            if (reply.finish === 'incomplete') {
              return yield* [...endUsage(), { t: 'error', code: 'incomplete', retryable: false, message: 'The model stopped before finishing the answer.' }, { t: 'done', reason: 'error' }]
            }
            if (reply.finish === 'length') {
              return yield* [...endUsage(), { t: 'error', code: 'max_tokens', retryable: false, message: 'The answer hit the model\'s length limit.' }, { t: 'done', reason: 'limit' }]
            }
            return yield* [...endUsage(), { t: 'done', reason: 'complete' }]
          }

          // Give every call an id that is valid and unique in the session, and
          // use the same id in the history the model sees next.
          for (const c of calls) {
            if (!ID.test(c.id) || usedIds.has(c.id)) c.id = `call-${turnNo}-${++callNo}`
            usedIds.add(c.id)
          }
          history.push({
            role: 'assistant',
            content: reply.text || null,
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs } })),
          })

          for (const c of calls) {
            if (cancelled) break
            if (c.args === null) {
              // Not valid JSON: nothing to decide or run. The model is told, and
              // the step limit bounds a model that keeps getting it wrong.
              log?.warn?.(`[jarvis] brain ${profile.id}: tool call ${c.name} had invalid arguments; not run`)
              history.push({ role: 'tool', tool_call_id: c.id, content: 'Error: the arguments were not valid JSON. Nothing was run.' })
              continue
            }
            yield { t: 'tool_call', id: c.id, name: c.name, args: c.args }
            if (!bridge) {
              // Never offered tools, yet asked for one: the registry stops the turn on this event.
              history.push({ role: 'tool', tool_call_id: c.id, content: 'Error: no tools are available.' })
              continue
            }
            const result = await bridge.run({ id: c.id, name: c.name, args: c.args })
            // Only the event's own fields go on; the full output is for the model alone.
            const { t, id, ok, summary, tainted, detail } = result
            yield { t, id, ok, summary, tainted, ...(detail !== undefined && { detail }) }
            const content = typeof result.content === 'string' ? result.content : (detail ?? summary)
            history.push({
              role: 'tool',
              tool_call_id: c.id,
              content: `${ok ? '' : 'Error: '}${content.length > TOOL_OUTPUT_MAX ? `${content.slice(0, TOOL_OUTPUT_MAX - 1)}…` : content}`,
            })
          }
        }
      }

      /** One streamed model request. Yields text (and tool_start) events; returns the reply. */
      async function* request(body, usage) {
        controller = new AbortController()
        let timedOut = false
        let timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
        const pet = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        }
        let key = null
        try {
          if (needsKey) {
            key = await getKey()
            if (!key) throw Object.assign(new Error('no key'), { brainError: { code: 'auth', retryable: false, message: 'No API key is stored for this brain.' } })
          }
          const send = async () => {
            if (chatgpt) key = await planToken(false)
            try {
              return await fetchImpl(`${baseUrl}/${wire === 'responses' ? 'responses' : 'chat/completions'}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key && { authorization: `Bearer ${key}` }) },
                body: JSON.stringify(body),
                signal: controller.signal,
              })
            } catch (err) {
              if (timedOut) throw Object.assign(err, { brainError: { code: 'timeout', retryable: true, message: 'The model did not answer in time.' } })
              throw Object.assign(err, { brainError: { code: 'network', retryable: true, message: scrub(err?.message, key) } })
            }
          }
          /** The plan token for this request; `force` refreshes it first. */
          const planToken = async (force) => {
            try {
              return await siwc.accessToken({ background: actor === 'worker', force })
            } catch (err) {
              if (err instanceof SiwcError) throw Object.assign(new Error(err.code), { brainError: siwcBrainError(err) })
              throw err
            }
          }
          let res = await send()
          if (chatgpt && res.status === 401) {
            // OpenAI: ask the user to sign in again only after a terminal
            // refresh error, so refresh once and try once more.
            try {
              await res.body?.cancel()
            } catch {
              // already closed
            }
            key = await planToken(true)
            res = await send()
          }
          if (!res.ok) {
            let j = null
            try {
              j = await res.json()
            } catch {
              // no JSON body
            }
            if (wire === 'responses') {
              const e = responsesError(isRecord(j?.error) ? j.error : j, res.status, key)
              throw Object.assign(new Error(e.message), { brainError: e })
            }
            const message = typeof j?.error?.message === 'string' ? j.error.message : `HTTP ${res.status}`
            throw Object.assign(new Error(message), { brainError: { ...httpError(res.status), message: scrub(message, key) } })
          }
          if (wire === 'responses') return yield* readResponses(res, usage, pet, () => timedOut, key)

          let text = ''
          let finish = null
          const parts = new Map() // tool call index → { id, name, rawArgs, started }
          try {
            for await (const chunk of sseData(res.body)) {
              pet()
              if (isRecord(chunk?.usage)) {
                usage.seen = true
                usage.inTokens += count(chunk.usage.prompt_tokens)
                usage.outTokens += count(chunk.usage.completion_tokens)
              }
              if (isRecord(chunk?.error)) {
                const message = typeof chunk.error.message === 'string' ? chunk.error.message : 'The provider reported an error.'
                throw Object.assign(new Error(message), { brainError: { code: 'provider', retryable: true, message: scrub(message, key) } })
              }
              const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null
              if (!choice) continue
              const delta = choice.delta ?? {}
              const said = typeof delta.content === 'string' ? delta.content : typeof delta.refusal === 'string' ? delta.refusal : ''
              if (said) {
                text += said
                if (!cancelled) yield { t: 'text', delta: said }
              }
              for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
                const index = Number.isInteger(tc?.index) ? tc.index : parts.size
                const part = parts.get(index) ?? { id: '', name: '', rawArgs: '', started: false }
                if (typeof tc.id === 'string' && tc.id) part.id = tc.id
                if (typeof tc.function?.name === 'string') part.name += tc.function.name
                if (typeof tc.function?.arguments === 'string') part.rawArgs += tc.function.arguments
                parts.set(index, part)
                if (!part.started && part.name && ID.test(part.id) && !usedIds.has(part.id) && !cancelled) {
                  part.started = true
                  yield { t: 'tool_start', id: part.id, name: part.name }
                }
              }
              if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
            }
          } catch (err) {
            if (err?.brainError) throw err
            if (timedOut) throw Object.assign(err, { brainError: { code: 'timeout', retryable: true, message: 'The model stopped answering.' } })
            throw Object.assign(err, { brainError: { code: 'stream', retryable: true, message: scrub(err?.message, key) } })
          }

          const calls = [...parts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, p]) => p)
            .filter((p) => p.name)
            .map((p) => {
              let args = null
              try {
                const parsed = p.rawArgs.trim() ? JSON.parse(p.rawArgs) : {}
                args = isRecord(parsed) ? parsed : null
              } catch {
                args = null
              }
              return { id: p.id, name: p.name, rawArgs: p.rawArgs || '{}', args }
            })
          // A tool_start whose id is later replaced would point at nothing; that
          // only happens for a provider id that was invalid or repeated, which
          // never got a tool_start above.
          return { text, calls, finish }
        } finally {
          clearTimeout(timer)
          controller = null
        }
      }

      /**
       * A streamed Responses API reply (Sign in with ChatGPT). Text comes as
       * `response.output_text.delta`; a tool call as a `function_call` output
       * item whose arguments stream in `response.function_call_arguments.*`.
       * Only `response.completed` (or `response.incomplete`) ends it well:
       * `response.failed`, an `error` event or a stream that just stops is a
       * failure (OpenAI: usage-limit errors can arrive mid-stream).
       */
      async function* readResponses(res, usage, pet, timedOut, key) {
        let text = ''
        let finish = null
        const parts = new Map() // output index → { id, name, rawArgs, started }
        const fail = (e) => Object.assign(new Error(e.message), { brainError: e })
        const addUsage = (u) => {
          if (!isRecord(u)) return
          usage.seen = true
          usage.inTokens += count(u.input_tokens)
          usage.outTokens += count(u.output_tokens)
        }
        try {
          for await (const ev of sseData(res.body)) {
            pet()
            const type = typeof ev?.type === 'string' ? ev.type : ''
            if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
              const said = typeof ev.delta === 'string' ? ev.delta : ''
              if (said) {
                text += said
                if (!cancelled) yield { t: 'text', delta: said }
              }
            } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
              const item = ev.item
              if (item?.type !== 'function_call') continue
              const index = Number.isInteger(ev.output_index) ? ev.output_index : parts.size
              const part = parts.get(index) ?? { id: '', name: '', rawArgs: '', started: false }
              if (typeof item.call_id === 'string' && item.call_id) part.id = item.call_id
              if (typeof item.name === 'string' && item.name) part.name = item.name
              if (typeof item.arguments === 'string' && (type === 'response.output_item.done' || !part.rawArgs)) part.rawArgs = item.arguments
              parts.set(index, part)
              if (!part.started && part.name && ID.test(part.id) && !usedIds.has(part.id) && !cancelled) {
                part.started = true
                yield { t: 'tool_start', id: part.id, name: part.name }
              }
            } else if (type === 'response.function_call_arguments.delta') {
              const part = parts.get(ev.output_index)
              if (part && typeof ev.delta === 'string') part.rawArgs += ev.delta
            } else if (type === 'response.function_call_arguments.done') {
              const part = parts.get(ev.output_index)
              if (part && typeof ev.arguments === 'string') part.rawArgs = ev.arguments
            } else if (type === 'response.completed') {
              addUsage(ev.response?.usage)
              finish = 'stop'
            } else if (type === 'response.incomplete') {
              addUsage(ev.response?.usage)
              finish = ev.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'incomplete'
            } else if (type === 'response.failed') {
              addUsage(ev.response?.usage)
              throw fail(responsesError(ev.response?.error, 0, key))
            } else if (type === 'error') {
              throw fail(responsesError(isRecord(ev.error) ? ev.error : ev, 0, key))
            }
            if (finish) break
          }
        } catch (err) {
          if (err?.brainError) throw err
          if (timedOut()) throw Object.assign(err, { brainError: { code: 'timeout', retryable: true, message: 'The model stopped answering.' } })
          throw Object.assign(err, { brainError: { code: 'stream', retryable: true, message: scrub(err?.message, key) } })
        }
        if (!finish) {
          if (cancelled) return { text, calls: [], finish: null }
          throw fail({ code: 'stream', retryable: true, message: 'The answer stopped before OpenAI said it was complete.' })
        }
        const calls = [...parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, p]) => p)
          .filter((p) => p.name)
          .map((p) => {
            let args = null
            try {
              const parsed = p.rawArgs.trim() ? JSON.parse(p.rawArgs) : {}
              args = isRecord(parsed) ? parsed : null
            } catch {
              args = null
            }
            return { id: p.id, name: p.name, rawArgs: p.rawArgs || '{}', args }
          })
        return { text, calls, finish }
      }

      async function* events() {
        try {
          for await (const text of turns) {
            if (closed) return
            yield* turn(text)
            inTurn = false
            if (closed) return
          }
        } finally {
          inTurn = false
        }
      }

      return {
        events: events(),
        /** Stop the turn in progress (barge-in). It ends `cancelled`; the rest of the answer is dropped. */
        async cancel() {
          if (!inTurn) return
          cancelled = true
          controller?.abort()
        },
        /**
         * The model for the next turn (fast/deep routing, plan 06 phase 2).
         * Takes effect from the next request; a turn in progress keeps its model.
         */
        async setModel(next) {
          if (typeof next !== 'string' || !next) return false
          model = next
          return true
        },
        /** End the session. */
        close() {
          closed = true
          cancelled = true
          controller?.abort()
        },
      }
    },
  })
}

/** A prompt as an async iterable of turn texts. */
function turnSource(prompt) {
  if (typeof prompt === 'string') return [prompt]
  if (prompt && (typeof prompt[Symbol.asyncIterator] === 'function' || typeof prompt[Symbol.iterator] === 'function')) {
    return (async function* () {
      for await (const item of prompt) {
        if (typeof item === 'string') yield item
        else if (typeof item?.message?.content === 'string') yield item.message.content
        else throw new Error('Each turn must be a string.')
      }
    })()
  }
  throw new Error('converse needs a prompt: a string, or an iterable of turns.')
}
