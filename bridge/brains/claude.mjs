/**
 * The Claude brain (plan 21, phase 1).
 *
 * Everything that is specific to running JARVIS on the Claude Agent SDK lives
 * here: how a session's options are built, how the SDK is started, and how the
 * bundled Claude Code binary reports its status and signs in. The bridge picks
 * a brain from the registry (registry.mjs) and never calls the SDK itself, so a
 * second brain can be added beside this one without touching the turn loop.
 *
 * This is a move, not a redesign: the options below are exactly the ones
 * server.mjs used to build inline, and claude.test.mjs pins them.
 *
 * Two ways in. `converse` (plan 21 phase 2) returns the session as normalised
 * BrainEvents (events.mjs); it is what server.mjs and tasks.mjs read, and what
 * the conformance suite (conformance.mjs) holds every brain to. `startSession`
 * returns the SDK's own Query underneath it; nothing in the bridge reads that
 * directly any more.
 *
 * The SDK's `query` is passed in rather than imported here, so this module and
 * its tests load without the SDK installed. server.mjs hands over the real one.
 */
import { homedir } from 'node:os'
import { claudeStatus, startClaudeLogin } from '../claude-cli.mjs'
import { detailOf, summarise } from './events.mjs'

/** Turn limits per kind of session, unchanged from server.mjs. */
export const MAX_TURNS = Object.freeze({ voice: 24, worker: 40 })

/**
 * The Agent SDK options for one session.
 *
 * Each line here was a deliberate choice in server.mjs; the reasons are kept
 * with them so they move together.
 *
 * @param {object} p
 * @param {object} p.policy        the policy engine (policy.mjs createPolicy)
 * @param {'voice'|'worker'} p.actor  who is asking, for the audit trail and limits
 * @param {object} p.mcpServers    every MCP server this session may use
 * @param {string} p.systemPrompt  the persona
 * @param {string} p.model
 * @param {string} p.effort
 * @param {Function} p.guard       extra PreToolUse check after the gate (the taint guard)
 * @param {Function} p.afterTool   the PostToolUse hook (untrusted labelling, taint)
 * @param {Function} [p.log]       where canUseTool logs its decisions
 * @param {AbortController} [p.abortController]
 * @param {number} [p.maxTurns]    defaults to MAX_TURNS[actor]
 * @param {string} [p.cwd]         defaults to the home directory
 */
export function claudeOptions({
  policy, actor, mcpServers, systemPrompt, model, effort, guard, afterTool, log,
  abortController, maxTurns = MAX_TURNS[actor], cwd = homedir(),
}) {
  if (!policy) throw new Error('claudeOptions needs the policy engine.')
  if (actor !== 'voice' && actor !== 'worker') throw new Error(`Unknown actor: ${actor}`)
  return {
    ...(abortController && { abortController }),
    mcpServers,
    // A plain system prompt, not the claude_code preset. The preset is
    // tuned for a coding agent — verbose, file-oriented, and a large chunk
    // of input tokens on every turn. Replacing it makes the persona stick,
    // keeps answers short enough to speak, and cuts cost per turn.
    systemPrompt,
    // Run from the home directory so project-scoped MCP servers don't shadow
    // the global ones, and so file tools have a sane root.
    cwd,
    // No filesystem settings at all. Left to its default the SDK loads
    // ~/.claude/settings.json and settings.local.json exactly as the CLI
    // does — which on a working machine means a bypassPermissions default
    // and a pile of allow-rules for Bash. Allow-rules are matched before the
    // permission callback, so the policy engine would never even be asked
    // about the tools it most needs to refuse. Empty makes this bridge the
    // only authority. It also stops the global CLAUDE.md riding along on
    // every voice turn, carrying instructions written for a coding agent
    // into a conversation that is meant to be two sentences long.
    //
    // The cost is that MCP servers stop being discovered too, which is why
    // mcpServers above is passed in by hand.
    settingSources: [],
    // Stated explicitly, and it has to be.
    //
    // With no `model` the SDK falls back to its own default, which on one
    // machine resolved to claude-opus-4-8[1m] — not what src/config.ts
    // declares for the browser-direct path, and not anything anyone chose.
    // Normally your own `/model` preference would decide, but that lives in
    // the settings files `settingSources: []` deliberately stops loading, so
    // without this line nothing in the project has a say at all.
    model,
    effort,
    maxTurns,
    permissionMode: 'default',
    disallowedTools: policy.disallowedTools(),
    hooks: {
      // The gate, then the taint check: once a session has read private
      // content, opening, fetching or sending to a destination the owner did
      // not name waits for an approval card (plan 08, phase 2; taint.mjs).
      PreToolUse: [policy.preToolUse({ guard, actor })],
      // Results the bridge does not build itself — built-in tools such as
      // WebFetch, and other people's MCP servers — come back with a note that
      // they are untrusted data (plan 08, phase 2; untrusted.mjs). JARVIS's
      // own browser and page tools wrap their results where they are built.
      // Every result is also noted for taint and for the media proxy.
      PostToolUse: [afterTool],
    },
    // Without this the SDK only emits whole assistant messages, and JARVIS
    // would sit silent until the entire answer was written. Partial events
    // are what let speech start on the first finished sentence.
    includePartialMessages: true,
    // Signature is (toolName, input, options) and it must return a
    // PermissionResult object. Returning a bare boolean silently denies
    // everything, with the tool name arriving undefined.
    //
    // Worth knowing: this is a last gate, not the only one. Calls the CLI
    // has already settled never arrive here — its own classifier waves
    // through a `Bash: echo hello` without asking, and only reaches us for
    // something with a consequence, like a `touch`. So a deny here is
    // reliable; an absence of a call here is not proof nothing ran.
    canUseTool: policy.canUseTool(actor, log),
  }
}

/** How each failed `result` subtype ends the turn. Anything unlisted is an error. */
const RESULT_ENDINGS = Object.freeze({
  error_max_turns: { code: 'max_turns', retryable: false, reason: 'limit' },
  error_max_budget_usd: { code: 'budget', retryable: false, reason: 'limit' },
  error_during_execution: { code: 'execution', retryable: true, reason: 'error' },
  error_max_structured_output_retries: { code: 'structured_output', retryable: false, reason: 'error' },
})

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Turns the Agent SDK's messages into BrainEvents (events.mjs), one session at
 * a time. Pure bookkeeping, no I/O, so it is tested message by message.
 *
 * Where each event comes from, and why:
 * - ready: the SDK's `system` init message, listing the MCP servers. Servers
 *   report 'pending' until first use (they connect lazily), so only the ones
 *   that need sign-in or failed are left out.
 * - tool_start: the partial `content_block_start` of a `tool_use` block. It is
 *   the earliest sign of a tool call, so the HUD can light its badge before
 *   the arguments have streamed. Only id and name are known there.
 * - text: the partial `stream_event` text deltas. They are the only place
 *   spoken text arrives early (see includePartialMessages above). If a build
 *   never streams, the text blocks of whole `assistant` messages are used
 *   instead, so the answer is late but not lost.
 * - tool_call: the `tool_use` blocks of whole `assistant` messages, because
 *   only those carry the complete input; the partial block start has `{}`.
 *   The SDK repeats blocks, so ids are deduplicated.
 * - tool_result: the `tool_result` blocks of `user` messages. A tool refused
 *   by the policy engine comes back here with `is_error`, so it is `ok: false`
 *   and never looks like work that happened.
 * - usage and done: the one `result` per turn. A failed result says why in an
 *   `error` first; a turn the caller cancelled ends `cancelled` whatever the
 *   SDK reports, and any text still in flight after the cancel is dropped, so
 *   the tail of an abandoned answer is never spoken.
 *
 * @param {object} [p]
 * @param {(toolName: string) => boolean} [p.tainted] does this tool's output count as private (taint.mjs)?
 */
export function claudeEventMapper({ tainted = () => false } = {}) {
  let streamed = false // has this session ever streamed a text delta?
  let pending = 0 // turns handed to the SDK and not yet ended; the SDK may read ahead
  let cancelled = false // did the caller cancel the turn in progress?
  const calls = new Map() // tool id → name, for this turn
  const starts = new Set() // tool ids already announced by tool_start, this turn

  const started = () => {
    if (pending === 0) pending = 1
  }
  const endTurn = () => {
    pending = Math.max(0, pending - 1)
    cancelled = false
    calls.clear()
    starts.clear()
  }

  return {
    /** A prompt has been handed to the SDK: a turn is now in progress. */
    begin() {
      pending++
    },

    /** Mark the turn in progress as cancelled. False when there is none. */
    cancel() {
      if (pending === 0) return false
      cancelled = true
      return true
    },

    get open() {
      return pending > 0
    },

    /** The BrainEvents for one SDK message (often none). */
    map(msg) {
      const out = []
      switch (msg?.type) {
        case 'stream_event': {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            streamed = true
            started()
            if (!cancelled) out.push({ t: 'text', delta: ev.delta.text })
          }
          const block = ev?.type === 'content_block_start' ? ev.content_block : null
          if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.name &&
            !starts.has(block.id) && !calls.has(block.id)) {
            starts.add(block.id)
            started()
            out.push({ t: 'tool_start', id: block.id, name: block.name })
          }
          break
        }
        case 'system': {
          if (msg.subtype === 'init') {
            const servers = (Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [])
              .filter((s) => typeof s?.name === 'string' && s.name && s.status !== 'needs-auth' && s.status !== 'failed')
              .map((s) => s.name)
            out.push({ t: 'ready', servers })
          }
          break
        }
        case 'assistant': {
          started()
          for (const block of msg.message?.content ?? msg.content ?? []) {
            if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.name && !calls.has(block.id)) {
              calls.set(block.id, block.name)
              out.push({ t: 'tool_call', id: block.id, name: block.name, args: isRecord(block.input) ? block.input : {} })
            } else if (block?.type === 'text' && block.text && !streamed && !cancelled) {
              out.push({ t: 'text', delta: block.text })
            }
          }
          break
        }
        case 'user': {
          const blocks = msg.message?.content
          if (!Array.isArray(blocks)) break
          for (const block of blocks) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const name = calls.get(block.tool_use_id) ?? ''
            out.push({
              t: 'tool_result',
              id: block.tool_use_id,
              ok: block.is_error !== true,
              summary: summarise(block.content),
              tainted: block.is_error !== true && Boolean(name && tainted(name)),
              detail: detailOf(block.content),
            })
          }
          break
        }
        case 'result': {
          const u = msg.usage
          if (u) {
            const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
            out.push({
              t: 'usage',
              // Cached prompt tokens are still prompt tokens.
              inTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
              outTokens: n(u.output_tokens),
              ...(typeof msg.total_cost_usd === 'number' && msg.total_cost_usd >= 0 && { costUsd: msg.total_cost_usd }),
            })
          }
          if (cancelled) out.push({ t: 'done', reason: 'cancelled' })
          else if (msg.subtype === 'success') out.push({ t: 'done', reason: 'complete' })
          else {
            const end = RESULT_ENDINGS[msg.subtype] ?? { code: String(msg.subtype || 'unknown'), retryable: false, reason: 'error' }
            out.push({ t: 'error', code: end.code, retryable: end.retryable })
            out.push({ t: 'done', reason: end.reason })
          }
          endTurn()
          break
        }
      }
      return out
    },

    /** The stream ended. A turn still open gets its `done`, so nobody waits for ever. */
    end() {
      if (pending === 0) return []
      const out = cancelled
        ? [{ t: 'done', reason: 'cancelled' }]
        : [{ t: 'error', code: 'ended', retryable: true, message: 'The session ended part way through a turn.' },
            { t: 'done', reason: 'error' }]
      endTurn()
      pending = 0
      return out
    },

    /** The stream threw. Whatever was in progress is over. */
    fail(err) {
      const out = [
        { t: 'error', code: 'session_error', retryable: true, message: String(err?.message ?? err) },
        { t: 'done', reason: cancelled ? 'cancelled' : 'error' },
      ]
      endTurn()
      pending = 0
      return out
    },
  }
}

/**
 * What `converse` accepts as a prompt, in the shape the SDK wants. A string is
 * one turn. A list or async iterable is a conversation: each item a string or
 * an SDK user message, handed over one turn at a time.
 */
function sdkPrompt(prompt, mapper) {
  if (typeof prompt === 'string') {
    mapper.begin()
    return prompt
  }
  if (!prompt || (typeof prompt[Symbol.asyncIterator] !== 'function' && typeof prompt[Symbol.iterator] !== 'function')) {
    throw new Error('converse needs a prompt: a string, or an iterable of turns.')
  }
  return (async function* turns() {
    for await (const item of prompt) {
      mapper.begin()
      yield typeof item === 'string'
        ? { type: 'user', message: { role: 'user', content: item }, parent_tool_use_id: null }
        : item
    }
  })()
}

/**
 * Build the Claude brain.
 *
 * @param {object} deps
 * @param {Function} deps.query    the Agent SDK's query()
 * @param {Function} [deps.status] reports { installed, version, loggedIn } (claude-cli.mjs)
 * @param {Function} [deps.login]  starts the browser sign-in (claude-cli.mjs)
 * @param {object}   [deps.env]    environment, to tell an API key from a subscription login
 */
export function createClaudeBrain({ query, status = claudeStatus, login = startClaudeLogin, env = process.env } = {}) {
  if (typeof query !== 'function') throw new Error('The Claude brain needs the Agent SDK query().')
  return Object.freeze({
    id: 'claude',
    label: 'Claude',
    // What this brain can do, for the router and Settings (plan 21). `resume`
    // is false because JARVIS owns conversation history (conversation.mjs),
    // not because the SDK cannot.
    // `toolGate: 'hook'` puts it in agent mode (registry.mjs): the SDK runs
    // tools, but only after the PreToolUse hook and canUseTool built from the
    // policy engine in claudeOptions have allowed them (plan 21 phase 3).
    capabilities: Object.freeze({
      tools: true, streaming: true, resume: false, vision: true, offline: false, toolGate: 'hook',
    }),

    /**
     * Installed and signed in? Never throws. The Claude Code binary bills an
     * ANTHROPIC_API_KEY in its environment ahead of a subscription login, so
     * that is what decides the auth mode (see ADR 001).
     */
    status() {
      const s = status()
      return {
        installed: Boolean(s.installed),
        version: s.version ?? '',
        // Signed in to a Claude account through Anthropic's own flow.
        loggedIn: Boolean(s.loggedIn),
        authenticated: Boolean(s.loggedIn) || Boolean(env.ANTHROPIC_API_KEY),
        authMode: env.ANTHROPIC_API_KEY ? 'apikey' : 'subscription',
      }
    },

    /** Open Anthropic's own sign-in in the browser. JARVIS never sees the credentials. */
    login() {
      login()
    },

    /**
     * Start a session. `prompt` is a string (one task) or an async iterable of
     * user messages (the voice conversation). Returns the SDK's Query: an async
     * iterable of SDK messages with interrupt() and close().
     */
    startSession,

    /**
     * Start a session and read it as BrainEvents (plan 21 phase 2). Takes the
     * same options as startSession, plus `tainted(toolName)` for marking
     * private tool output. `prompt` is a string (one turn) or an iterable or
     * async iterable of turns (strings or SDK user messages).
     *
     * Returns { events, cancel, close }:
     *   events   async iterable of BrainEvents; each turn ends with one `done`
     *   cancel() stops the turn in progress (barge-in); it ends `cancelled`
     *   close()  ends the whole session
     */
    converse({ prompt, tainted, ...options }) {
      const mapper = claudeEventMapper({ tainted })
      const session = startSession({ prompt: sdkPrompt(prompt, mapper), ...options })
      async function* events() {
        try {
          for await (const msg of session) yield* mapper.map(msg)
          yield* mapper.end()
        } catch (err) {
          yield* mapper.fail(err)
        }
      }
      return {
        events: events(),
        async cancel() {
          if (mapper.cancel()) await session.interrupt?.()
        },
        close() {
          session.close?.()
        },
      }
    },
  })

  function startSession({ prompt, ...options }) {
    return query({ prompt, options: claudeOptions(options) })
  }
}
