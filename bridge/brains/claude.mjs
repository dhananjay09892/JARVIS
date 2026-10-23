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
 * server.mjs used to build inline, and claude.test.mjs pins them. Normalising
 * the SDK's stream into BrainEvents is the next step (plan 21 phase 2, Q17);
 * until then the caller still reads the SDK's own message shapes.
 *
 * The SDK's `query` is passed in rather than imported here, so this module and
 * its tests load without the SDK installed. server.mjs hands over the real one.
 */
import { homedir } from 'node:os'
import { claudeStatus, startClaudeLogin } from '../claude-cli.mjs'

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
    capabilities: Object.freeze({
      tools: true, streaming: true, resume: false, vision: true, offline: false,
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
    startSession({ prompt, ...options }) {
      return query({ prompt, options: claudeOptions(options) })
    },
  })
}
