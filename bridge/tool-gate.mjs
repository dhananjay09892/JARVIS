/**
 * The permission gate: which tool calls run, and which wait for
 * JARVIS_ALLOW_WRITES.
 *
 * This used to live inline in server.mjs. It is the bridge's main safety
 * function, so it now sits on its own with no dependencies — nothing here
 * imports the SDK, the settings file or the network — which is what lets
 * tool-gate.test.mjs exercise it table by table. Plan 15 grows this into the
 * full policy engine; until then this is the policy.
 *
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 */

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: the first word of its
 *      name must be a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
export const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Read verbs, matched as whole words against the FIRST word of the tool name.
 *
 * This was a prefix regex, `^(get|list|read|…|check…)`, and a prefix reads the
 * spelling rather than the verb: `checkout_cart` began with "check" and ran in
 * read-only mode. Whole words fix that — `checkout` is not `check`.
 *
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
export const READ_VERBS = new Set([
  'get', 'list', 'read', 'search', 'find', 'query', 'fetch', 'check',
  'describe', 'inspect', 'show', 'view', 'explain', 'screenshot',
])

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle, and `sendmail` hides it with no separator at
 * all. `download` is here because it writes a file even though it sounds like
 * a read. This substring veto is deliberately kept as it was: the word rules
 * below add to it, they never replace it.
 */
export const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Action verbs matched as whole words anywhere in the name.
 *
 * These are too short or too common to match as substrings (`set` is inside
 * `dataset`, `run` inside `truncate`), so they only count as separate words.
 * Any one of them withholds the tool, even when the name begins with a read
 * verb: `read_and_archive` reads, then archives.
 *
 * The cost is that a read whose noun happens to be one of these words —
 * `get_order`, `list_share_links` — is withheld too. That is the side to err
 * on: a wrongly withheld read costs a sentence ("I need writes for that"), a
 * wrongly allowed action can't be taken back. Per-tool overrides belong in the
 * policy engine (plan 15), not in loosening this list.
 */
export const ACTION_WORDS = new Set([
  // The list from IMPROVEMENT_PLAN.md #3.
  'archive', 'move', 'share', 'forward', 'reply', 'order', 'checkout',
  'transfer', 'approve', 'merge', 'submit', 'upload', 'run', 'set', 'cancel',
  // Money, access and machines: verbs that are almost never a noun in a
  // read tool's name, so adding them costs no legitimate reads.
  'purchase', 'refund', 'withdraw', 'deposit', 'invite', 'grant', 'revoke',
  'authorize', 'subscribe', 'unsubscribe', 'execute', 'exec', 'kill',
  'reboot', 'shutdown', 'restart', 'reset', 'unlock', 'dial', 'rename',
  'modify', 'insert', 'erase', 'wipe', 'truncate',
])

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
export const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/**
 * A tool name as lower-case words. Splits on `_`, `-`, `.`, `/`, spaces and
 * camelCase humps, so `read_and_archive`, `Bulk-Edit-Events`, `checkoutCart`
 * and `HTTPRequest` all come apart the way a reader would split them.
 */
export function splitToolWords(tool) {
  return String(tool)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

/** True when the tool's name trips the veto (and isn't exempted from it). */
export function isVetoed(server, tool) {
  if (VETO_EXEMPT.has(`${server}__${tool}`)) return false
  if (EFFECTFUL_VERB.test(tool)) return true
  return splitToolWords(tool).some((word) => ACTION_WORDS.has(word))
}

/** True when the name argues for itself as a read: it begins with a read verb. */
export function isReadName(tool) {
  const [first] = splitToolWords(tool)
  return first !== undefined && READ_VERBS.has(first)
}

/**
 * Build the gate.
 *
 * Everything that varies at runtime is passed in, so the gate itself is pure:
 *   allowWrites     — JARVIS_ALLOW_WRITES, from the environment or settings.
 *   isMemoryTool    — the jarvis_memory tool list (memory-tools.mjs).
 *   isWorkflowTool  — the jarvis_workflows tool list (workflow-tools.mjs).
 *   isTaskTool      — the jarvis_tasks tool list (task-tools.mjs).
 *
 * Returns decideTool(name) → boolean: true runs the tool, false withholds it.
 */
export function createToolGate({
  allowWrites = false,
  isMemoryTool = () => false,
  isWorkflowTool = () => false,
  isTaskTool = () => false,
} = {}) {
  const ALLOW_WRITES = allowWrites === true

  return function decideTool(name) {
    if (typeof name !== 'string' || name === '') return false
    if (name === 'Task' || name === 'Agent') return ALLOW_WRITES
    if (READ_ONLY_BUILTINS.has(name)) return true
    if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

    const server = mcpServerOf(name)
    if (server) {
      // The HUD, and the interface controls beside it. Both run in this process
      // and draw on our own screen, so neither is something to withhold —
      // without them JARVIS has no display at all. They also have to be named
      // here rather than left to the verb rules below, which read `ui_theme` as
      // a write and would hold the whole surface back behind ALLOW_WRITES.
      if (server === 'jarvis' || server === 'jarvis_ui') return true

      // The browser server gates itself, at construction: chromeServer() only
      // builds the acting tools — click, type, form input, close tab — when
      // ALLOW_WRITES is set, so anything that reaches here at all is something
      // the same policy has already permitted. Deciding it a second time by
      // reading verbs out of the name would only get it wrong: `chrome_navigate`
      // begins with no read verb and would fall to the write branch, which would
      // withhold the one tool the whole server is for.
      if (server === 'jarvis_chrome') return true
      if (server === 'jarvis_apps') return mcpToolOf(name) === 'launch_app'
      if (server === 'jarvis_workspace') {
        return ['list_files', 'read_file', 'write_file', 'delete_file'].includes(mcpToolOf(name))
      }
      if (server === 'jarvis_development') return ['run_command', 'push_branch'].includes(mcpToolOf(name))
      // Saved memories are local data. These tools can neither act nor approve.
      if (server === 'jarvis_memory') return isMemoryTool(mcpToolOf(name))
      // Recipes can only be changed through an approval card, and their action
      // steps ask again on every run.
      if (server === 'jarvis_workflows') return isWorkflowTool(mcpToolOf(name))
      // Delegation and progress reports only move text around the board; what a
      // sub-agent may then do is still decided tool by tool, right here.
      if (server === 'jarvis_tasks') return isTaskTool(mcpToolOf(name))
      if (server === 'jarvis_task') return ['report_progress', 'ask_owner'].includes(mcpToolOf(name))

      // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
      // and the real gate is the browser's own camera permission plus an
      // indicator the user can see for as long as it is live.
      if (server === 'jarvis_eyes') return true

      const tool = mcpToolOf(name)
      if (isVetoed(server, tool)) return ALLOW_WRITES
      // The session tools this bridge is developed inside count as read-only too.
      if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
      return isReadName(tool) ? true : ALLOW_WRITES
    }
    return ALLOW_WRITES
  }
}
