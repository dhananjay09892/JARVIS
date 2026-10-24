/**
 * The policy engine (plan 15): the one place that decides which actions run.
 *
 * Today that means tool calls — which run, and which wait for
 * JARVIS_ALLOW_WRITES — plus the pieces of gating that used to be scattered
 * through server.mjs: whether writes are on at all, which built-ins the SDK is
 * told to withhold, and what a refused call is told. Every agent the bridge
 * starts (the voice session and background workers) asks `createPolicy()`
 * here, through `decideTool`, its PreToolUse hook and its canUseTool callback.
 *
 * It has no dependencies on purpose — nothing here imports the SDK, the
 * settings file or the network — which is what lets policy.test.mjs exercise
 * it table by table. Later phases of plan 15 (roles, standing grants, taint,
 * audit) add inputs to `decide()`; they do not add a second gate elsewhere.
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

// ---------------------------------------------------------------------------
// The never-list (plan 35, NEVER.md).
//
// These rules sit above everything else in this file. They refuse whatever
// JARVIS_ALLOW_WRITES says, whichever server the tool comes from — JARVIS's
// own servers, the read-only allowlist and VETO_EXEMPT included — because a
// limit the owner can switch off with the same switch as "real actions" is not
// a limit. Changing one is a reviewed change to this file and its tests.
//
// Like the rest of the gate they read tool names, which is what decide() is
// given today. A name is a tripwire, not a proof: a browser click on a CAPTCHA
// or a shell command that pays a bill carries no such name. Those paths are
// covered by writes being off by default and by the approval cards; plan 35's
// red-team suite (phase 4) is where they get tested end to end.

const has = (words, set) => words.some((w) => set.has(w))
const both = (words, a, b) => has(words, a) && has(words, b)

/** Rule 1 — spying on people. Words that only name surveillance. */
const SURVEILLANCE_WORDS = new Set([
  'spy', 'spying', 'spyware', 'stalk', 'stalker', 'stalking', 'stalkerware',
  'eavesdrop', 'wiretap', 'keylog', 'keylogger', 'covert', 'covertly', 'snoop',
])
/** Someone other than the owner. `person` and `contact` are left out: they name records. */
const OTHER_PERSON_WORDS = new Set([
  'partner', 'spouse', 'wife', 'husband', 'girlfriend', 'boyfriend', 'employee',
  'employees', 'someone',
])
const WATCH_WORDS = new Set([
  'track', 'tracking', 'locate', 'trace', 'monitor', 'watch', 'record', 'read',
  'intercept', 'messages', 'texts', 'chats', 'inbox', 'calls', 'location',
])
const TRACK_WORDS = new Set(['track', 'tracking', 'locate', 'trace', 'geolocate', 'pinpoint'])
const WHEREABOUTS_WORDS = new Set(['location', 'whereabouts', 'gps', 'position'])

/** Rule 2 — impersonation and cloning a real person. */
const IMPERSONATION_WORDS = new Set([
  'impersonate', 'impersonation', 'impersonating', 'deepfake', 'deepfakes',
  'faceswap', 'spoof', 'spoofing',
])
const CLONE_WORDS = new Set(['clone', 'cloning', 'cloned'])
const LIKENESS_WORDS = new Set(['voice', 'voices', 'face', 'faces', 'likeness', 'person'])
/** `swap_voice` only changes which stock voice speaks; swapping a face is a deepfake. */
const SWAP_WORDS = new Set(['swap', 'swapping'])
const FACE_WORDS = new Set(['face', 'faces'])

/**
 * Rule 3 — moving money. Unambiguous verbs refuse on their own; verbs that
 * also mean something harmless (transfer a file, send a message, charge a
 * battery) refuse only next to a money word, from the tool or its server.
 * A name that begins with a read verb and does nothing else (`list_payments`,
 * `get_trade_history`) is a read and is left to the ordinary rules below.
 */
const MONEY_VERBS = new Set([
  'pay', 'payment', 'payout', 'purchase', 'buy', 'checkout', 'withdraw', 'deposit',
  'refund', 'trade', 'invest', 'sell', 'remit', 'donate',
])
const AMBIGUOUS_MONEY_VERBS = new Set(['transfer', 'send', 'wire', 'charge', 'move', 'order'])
const MONEY_WORDS = new Set([
  'money', 'funds', 'fund', 'cash', 'payment', 'payments', 'crypto', 'bitcoin', 'btc',
  'eth', 'usd', 'inr', 'amount', 'balance', 'invoice', 'bank', 'wallet', 'stock',
  'stocks', 'shares', 'upi', 'stripe', 'paypal', 'razorpay', 'venmo',
])
/** Joins a read to a second action: `check_and_transfer`, `get_then_pay`. */
const JOINERS = new Set(['and', 'then', 'or'])

/** Rule 5 — security checks. */
const SECURITY_BREAK_WORDS = new Set([
  'captcha', 'captchas', 'recaptcha', 'hcaptcha', 'jailbreak', 'bruteforce', 'crack',
])
const EVADE_WORDS = new Set(['bypass', 'circumvent', 'evade', 'defeat', 'brute'])
const SAFEGUARD_WORDS = new Set([
  'captcha', 'security', 'auth', 'authentication', 'login', 'password', 'passwords',
  '2fa', 'mfa', 'otp', 'paywall', 'drm', 'firewall', 'safeguard', 'safeguards',
  'safety', 'verification', 'detection', 'antivirus', 'force', 'filter', 'lock',
])

/** Rule 6 — biometric and health data leaving the machine. */
const BODY_DATA_WORDS = new Set([
  'voiceprint', 'voiceprints', 'faceprint', 'faceprints', 'biometric', 'biometrics',
  'fingerprint', 'fingerprints', 'medical', 'heartrate', 'ecg', 'vitals',
])
/** `health` alone is usually a service health check; next to these it is a person's. */
const HEALTH_WORDS = new Set(['health'])
const HEALTH_DATA_WORDS = new Set(['record', 'records', 'data', 'report', 'history'])
const OUTBOUND_WORDS = new Set([
  'send', 'upload', 'export', 'share', 'post', 'sync', 'publish', 'forward',
  'transmit', 'email', 'tweet',
])

/**
 * The seven never-list rules, in NEVER.md's order. `match(words, serverWords)`
 * is true when a tool name falls under the rule. Rule 4 (orders from content)
 * and rule 7 (the kill switch) are not name rules: rule 4 is the taint guard
 * (taint.mjs) that every PreToolUse hook runs after the gate, and rule 7 is the
 * `isFrozen` input, which refuses everything. Both are still listed here so
 * the list stays one-to-one with the page.
 */
export const NEVER_RULES = Object.freeze([
  {
    n: 1, id: 'never-surveil', title: 'Spy on other people',
    match: (w) =>
      has(w, SURVEILLANCE_WORDS) || both(w, OTHER_PERSON_WORDS, WATCH_WORDS) ||
      both(w, TRACK_WORDS, WHEREABOUTS_WORDS),
  },
  {
    n: 2, id: 'never-impersonate', title: 'Pretend to be someone, or pretend to be human',
    match: (w) =>
      has(w, IMPERSONATION_WORDS) || both(w, CLONE_WORDS, LIKENESS_WORDS) || both(w, SWAP_WORDS, FACE_WORDS),
  },
  {
    n: 3, id: 'never-move-money', title: 'Move your money',
    match: (w, serverWords) => {
      if (READ_VERBS.has(w[0]) && !has(w, JOINERS)) return false
      if (has(w, MONEY_VERBS)) return true
      return has(w, AMBIGUOUS_MONEY_VERBS) && has([...w, ...serverWords], MONEY_WORDS)
    },
  },
  { n: 4, id: 'never-obey-content', title: 'Take orders from a web page, email or file', guard: 'taint.mjs' },
  {
    n: 5, id: 'never-break-security', title: 'Break through security checks',
    match: (w) => has(w, SECURITY_BREAK_WORDS) || both(w, EVADE_WORDS, SAFEGUARD_WORDS),
  },
  {
    n: 6, id: 'never-leak-body-data', title: "Send your body's data where it shouldn't go",
    match: (w) =>
      has(w, OUTBOUND_WORDS) && (has(w, BODY_DATA_WORDS) || both(w, HEALTH_WORDS, HEALTH_DATA_WORDS)),
  },
  { n: 7, id: 'frozen', title: 'Act while you have stopped it', input: 'isFrozen' },
])

/** The never-list rule a tool name falls under, or null. */
export function neverRuleFor(name) {
  if (typeof name !== 'string') return null
  const server = mcpServerOf(name)
  const words = splitToolWords(server ? mcpToolOf(name) : name)
  const serverWords = server ? splitToolWords(server) : []
  if (!words.length) return null
  return NEVER_RULES.find((r) => typeof r.match === 'function' && r.match(words, serverWords)) ?? null
}

/** A kill-switch reading that cannot be taken counts as frozen. */
function frozenNow(isFrozen) {
  try {
    return isFrozen() === true
  } catch {
    return true
  }
}

/**
 * Which rule settles a tool call, and whether it runs.
 *
 * Returns `{ allow, rule }`. The rule is a stable id (see RULE_REASONS) so a
 * decision can be explained, logged and — later — audited without re-deriving
 * it. The order of the checks is the policy; the table in policy.test.mjs pins
 * every branch.
 */
function toolRule(name, { allowWrites, isMemoryTool, isWorkflowTool, isTaskTool, isFrozen, connectorRule }) {
  const writes = (rule) => ({ allow: allowWrites, rule })
  const fixed = (allow, rule) => ({ allow, rule })

  // The never-list first: nothing below, and no switch, can reopen these.
  if (frozenNow(isFrozen)) return fixed(false, 'frozen')
  if (typeof name !== 'string' || name === '') return fixed(false, 'malformed-name')
  const never = neverRuleFor(name)
  if (never) return fixed(false, never.id)
  if (name === 'Task' || name === 'Agent') return writes('subagent')
  if (READ_ONLY_BUILTINS.has(name)) return fixed(true, 'read-only-builtin')
  if (WRITE_BUILTINS.has(name)) return writes('write-builtin')

  const server = mcpServerOf(name)
  if (server) {
    const tool = mcpToolOf(name)
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return fixed(true, 'own-display')

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for. The construction-time
    // switch is `policy.allowWrites`, so it is still this module's call.
    if (server === 'jarvis_chrome') return fixed(true, 'own-browser')
    if (server === 'jarvis_apps') return fixed(tool === 'launch_app', 'own-server-list')
    if (server === 'jarvis_workspace') {
      return fixed(['list_files', 'read_file', 'write_file', 'delete_file'].includes(tool), 'own-server-list')
    }
    if (server === 'jarvis_development') {
      return fixed(['run_command', 'push_branch'].includes(tool), 'own-server-list')
    }
    // Saved memories are local data. These tools can neither act nor approve.
    if (server === 'jarvis_memory') return fixed(isMemoryTool(tool) === true, 'own-server-list')
    // Recipes can only be changed through an approval card, and their action
    // steps ask again on every run.
    if (server === 'jarvis_workflows') return fixed(isWorkflowTool(tool) === true, 'own-server-list')
    // Delegation and progress reports only move text around the board; what a
    // sub-agent may then do is still decided tool by tool, right here.
    if (server === 'jarvis_tasks') return fixed(isTaskTool(tool) === true, 'own-server-list')
    if (server === 'jarvis_task') {
      return fixed(['report_progress', 'ask_owner'].includes(tool), 'own-server-list')
    }

    // Connectors (plans/connectors, task C01). The connector registry knows
    // each connector's tools, grants and kill switches, so it is asked; it
    // answers with one of its own rule ids, and anything else — a missing
    // registry, an answer it cannot give, a throw — is a refusal. A write also
    // needs general writes, which this module passes in rather than trusts.
    if (server === 'jarvis_connectors') return connectorDecision(connectorRule, tool, allowWrites)

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return fixed(true, 'own-camera')

    if (isVetoed(server, tool)) return writes('effectful-name')
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return fixed(true, 'read-only-server')
    return isReadName(tool) ? fixed(true, 'read-name') : writes('no-read-verb')
  }
  return writes('unknown-builtin')
}

/** The rules a connector decision may carry; see bridge/connectors/registry.mjs. */
const CONNECTOR_RULES = new Set([
  'connector-read', 'connector-write', 'connector-subscribe', 'connector-not-granted',
  'connector-disabled', 'connector-frozen', 'connector-unknown', 'connector-malformed',
])

/** Ask the connector registry about one of its tools, failing closed. */
function connectorDecision(connectorRule, tool, allowWrites) {
  let answer
  try {
    answer = connectorRule(tool, { allowWrites })
  } catch {
    return { allow: false, rule: 'connector-unknown' }
  }
  if (!answer || !CONNECTOR_RULES.has(answer.rule)) return { allow: false, rule: 'connector-unknown' }
  // Only the three grant rules can allow, and a write never without general writes.
  const mayAllow = ['connector-read', 'connector-subscribe'].includes(answer.rule)
    || (answer.rule === 'connector-write' && allowWrites)
  return { allow: answer.allow === true && mayAllow, rule: answer.rule }
}

/** Normalise the options every gate takes, failing closed on anything odd. */
function gateOptions({
  allowWrites = false,
  isMemoryTool = () => false,
  isWorkflowTool = () => false,
  isTaskTool = () => false,
  isFrozen = () => false,
  connectorRule = () => ({ allow: false, rule: 'connector-unknown' }),
} = {}) {
  return {
    allowWrites: allowWrites === true,
    isMemoryTool,
    isWorkflowTool,
    isTaskTool,
    // Read on every decision, so the kill switch (plan 15) can freeze a policy
    // that is already built. Anything that isn't a function counts as frozen.
    isFrozen: typeof isFrozen === 'function' ? isFrozen : () => true,
    // The connector registry's policyRule (connectors/registry.mjs). Without
    // one, every connector tool is refused.
    connectorRule: typeof connectorRule === 'function'
      ? connectorRule
      : () => ({ allow: false, rule: 'connector-unknown' }),
  }
}

/**
 * Write one decision to the audit log (audit.mjs), if there is one. The log
 * is told what was decided; it never takes part in deciding, so a sink that
 * throws is reported and the decision stands.
 */
function recordDecision(audit, log, entry) {
  if (typeof audit !== 'function') return
  try {
    audit({ type: 'decision', ...entry })
  } catch (err) {
    log?.error?.('[jarvis] audit failed:', err?.message ?? err)
  }
}

/**
 * Build the bare gate.
 *
 * Everything that varies at runtime is passed in, so the gate itself is pure:
 *   allowWrites     — JARVIS_ALLOW_WRITES, from the environment or settings.
 *   isMemoryTool    — the jarvis_memory tool list (memory-tools.mjs).
 *   isWorkflowTool  — the jarvis_workflows tool list (workflow-tools.mjs).
 *   isTaskTool      — the jarvis_tasks tool list (task-tools.mjs).
 *   isFrozen        — the kill switch (plan 15), read on every decision: true
 *                     refuses everything. Not wired to a switch yet.
 *   connectorRule   — the connector registry's policyRule(tool, { allowWrites })
 *                     for `mcp__jarvis_connectors__…` tools. Default: refuse.
 *
 * Returns decideTool(name) → boolean: true runs the tool, false withholds it.
 * The bridge uses `createPolicy()`, which wraps this; it stays exported for
 * the tests and for callers that only need the yes/no.
 */
export function createToolGate(options) {
  const opts = gateOptions(options)
  return function decideTool(name) {
    return toolRule(name, opts).allow
  }
}

/**
 * Whether general writes are on: JARVIS_ALLOW_WRITES=1 in the environment or
 * in the saved settings. Exactly '1' — anything else, including 'true', is off.
 */
export function writesEnabled({ env = {}, settings = {} } = {}) {
  return env?.JARVIS_ALLOW_WRITES === '1' || settings?.JARVIS_ALLOW_WRITES === '1'
}

/**
 * Built-ins the SDK is told not to offer at all while writes are off, so the
 * model doesn't plan around tools it cannot use. The gate refuses them anyway;
 * this is the belt to its braces.
 */
export const GENERAL_WRITE_TOOLS = Object.freeze([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task',
])

/** Why each rule decided as it did, in words that can be spoken or logged. */
export const RULE_REASONS = Object.freeze({
  'malformed-name': 'The tool name is missing or malformed.',
  'subagent': 'Starting a sub-agent needs general writes.',
  'read-only-builtin': 'A built-in tool that only reads.',
  'write-builtin': 'A built-in tool that writes or runs commands needs general writes.',
  'own-display': "JARVIS's own display and interface controls.",
  'own-browser': "JARVIS's browser tools; acting tools exist only when writes are on.",
  'own-server-list': "JARVIS's own server: only its listed tools run, and effectful ones ask for approval.",
  'own-camera': 'The camera, gated by the browser permission and a visible indicator.',
  'effectful-name': 'The tool name contains an action verb, so it needs general writes.',
  'read-only-server': 'A server on the read-only allowlist.',
  'read-name': 'The tool name begins with a read verb.',
  'no-read-verb': 'The tool name does not begin with a read verb, so it needs general writes.',
  'unknown-builtin': 'An unknown built-in tool needs general writes.',
  'unknown-action': 'Only tool calls are decided by policy so far; anything else is refused.',
  // Connectors (plans/connectors). Each capability is a separate grant.
  'connector-read': 'A connector read the owner granted.',
  'connector-subscribe': 'A connector subscription the owner granted.',
  'connector-write': "A connector write: needs the owner's write grant, general writes, and approval each time.",
  'connector-not-granted': 'The owner has not granted that permission to this connector.',
  'connector-disabled': 'This connector is turned off.',
  'connector-frozen': 'All connectors are frozen by the kill switch.',
  'connector-unknown': 'No connector offers that tool.',
  'connector-malformed': 'The connector tool name is malformed.',
  // The never-list (NEVER.md). No setting turns these off.
  'frozen': 'JARVIS is frozen by the kill switch, so nothing runs.',
  'never-surveil': 'JARVIS never tracks, covertly records or reads the messages of other people.',
  'never-impersonate': "JARVIS never impersonates anyone or clones a real person's voice or face.",
  'never-move-money': 'JARVIS never makes payments, transfers, purchases or trades.',
  'never-break-security': 'JARVIS never solves or bypasses CAPTCHAs or other security checks.',
  'never-leak-body-data': 'JARVIS never sends biometric or health data off this computer.',
  // Not produced by decide(): the PreToolUse hook's verdict when the guard
  // that runs after the gate (the taint check) refuses or cannot finish.
  'guard-refused': 'The gate allowed it, but the safety check after it refused or held it.',
  'guard-failed': 'The safety check after the gate could not finish, so the call was refused.',
})

/**
 * What a refused call is told. Every word of these can end up spoken, so they
 * carry no command to read out — the persona is forbidden from saying one.
 *   hook   — the PreToolUse hook's reason, both agent kinds.
 *   guardFailed — the hook's reason when the guard after the gate throws.
 *   voice  — canUseTool in the voice session.
 *   worker — canUseTool in a background worker.
 */
export const DENY_MESSAGES = Object.freeze({
  hook: 'Use the approved JARVIS workspace and development tools instead.',
  voice:
    'Blocked: general write and command access is disabled. ' +
    'For files in Documents/GitHub, use mcp__jarvis_workspace__list_files, ' +
    'mcp__jarvis_workspace__read_file, and mcp__jarvis_workspace__write_file; ' +
    'those tools allow local file creation and editing without general writes. ' +
    'Do not request broader permissions for workspace file tasks. ' +
    'For commands or GitHub pushes, use mcp__jarvis_development__run_command ' +
    'and wait for browser approval. Other effectful actions are unavailable.',
  worker: 'Blocked. Use the workspace and development tools; commands wait for owner approval.',
  guardFailed: 'Not sent: the safety check could not finish. Tell the owner in one sentence.',
})

/** Seconds a guarded PreToolUse hook may run: longer than an approval card's 90. */
export const PRE_TOOL_USE_GUARD_TIMEOUT_S = 120

/**
 * Build the policy the bridge runs on.
 *
 * Takes the same options as createToolGate. Returns:
 *   allowWrites       — the resolved switch (exactly true or false), which is
 *                       also what decides whether chromeServer builds its
 *                       acting tools.
 *   decide(action)    — a PolicyDecision (plan 38): `{ verdict, reason, rule }`.
 *                       `action` is `{ kind: 'tool', name }`; any other kind is
 *                       denied. `verdict` is 'allow' or 'deny' today — 'ask'
 *                       belongs to later phases (grants, taint), while the
 *                       approval cards still live in the servers that act.
 *   decideTool(name)  — the yes/no form, for the hook and the HUD badge.
 *   disallowedTools() — the SDK's disallowedTools list for this mode.
 *   authorize({ name, input, actor, stage, guard }) — decide one call, with
 *                       the guard, and audit it; resolves to { decision, refusal }.
 *                       What the hook below and the tool bridge share.
 *   preToolUse({ reason, guard, log }) — a PreToolUse hook matcher: the gate
 *                       first, then the optional `guard(toolName, toolInput)`,
 *                       which resolves to null to let the call run or to a
 *                       refusal reason. The taint check (taint.mjs) is the
 *                       guard today. A guard that throws refuses the call.
 *   canUseTool(context, log)  — a canUseTool callback; context is 'voice' or
 *                               'worker' and picks the refusal message.
 *
 * `audit`, if given, is called with one entry per decision the hook or
 * canUseTool takes (see audit.mjs) — the voice or worker that asked, where,
 * the tool name and the verdict, rule and reason. `decide()` and
 * `decideTool()` stay pure: the HUD asks them too, and that is not a call.
 * preToolUse takes an `actor` ('voice' or 'worker') for its entries;
 * canUseTool uses its context.
 */
export function createPolicy(options) {
  const opts = gateOptions(options)
  const audit = typeof options?.audit === 'function' ? options.audit : null

  const decide = (action) => {
    if (action?.kind !== 'tool') {
      return { verdict: 'deny', rule: 'unknown-action', reason: RULE_REASONS['unknown-action'] }
    }
    const { allow, rule } = toolRule(action.name, opts)
    return { verdict: allow ? 'allow' : 'deny', rule, reason: RULE_REASONS[rule] }
  }

  const decideTool = (name) => decide({ kind: 'tool', name }).verdict === 'allow'
  const denyBy = (rule) => ({ verdict: 'deny', rule, reason: RULE_REASONS[rule] })

  /**
   * Decide one tool call and put the decision on the audit trail: the gate,
   * then the optional `guard(name, input)` (the taint check), which resolves
   * to null to let the call run or to a refusal reason; a guard that throws
   * refuses. The PreToolUse hook (agent-CLI brains) and the tool bridge
   * (brains/tool-bridge.mjs, tool-loop brains) both decide through this, so
   * every brain is decided the same way (plan 21 phase 3).
   * Resolves to { decision, refusal }: refusal is null when the call may run,
   * else the words handed back to the model.
   */
  const authorize = async ({
    name, input, actor = 'voice', stage = 'pre-tool-use', guard = null, reason = DENY_MESSAGES.hook, log = console,
  } = {}) => {
    let refusal = null
    const request = { kind: 'tool', name }
    let decision = decide(request)
    if (decision.verdict !== 'allow') {
      refusal = reason
    } else if (guard) {
      try {
        refusal = await guard(name, input)
        if (refusal !== null && refusal !== undefined) decision = denyBy('guard-refused')
      } catch (err) {
        // A check that cannot finish must refuse, never wave the call through.
        log?.error?.('[jarvis] taint check failed:', err)
        refusal = DENY_MESSAGES.guardFailed
        decision = denyBy('guard-failed')
      }
    }
    recordDecision(audit, log, { actor, stage, request, decision })
    return { decision, refusal: refusal ?? null }
  }

  return Object.freeze({
    allowWrites: opts.allowWrites,
    decide,
    decideTool,
    disallowedTools: () => (opts.allowWrites ? [] : [...GENERAL_WRITE_TOOLS]),
    authorize,
    preToolUse: ({ reason = DENY_MESSAGES.hook, guard = null, log = console, actor = 'voice' } = {}) => {
      const hook = async (input) => {
        const { refusal } = await authorize({
          name: input?.tool_name, input: input?.tool_input, actor, stage: 'pre-tool-use', guard, reason, log,
        })
        return refusal === null ? {} : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: refusal,
          },
        }
      }
      // A guard may hold the call on an approval card, which expires after 90
      // seconds; the hook outlasts it so the card, not the hook, is what times out.
      return guard ? { timeout: PRE_TOOL_USE_GUARD_TIMEOUT_S, hooks: [hook] } : { hooks: [hook] }
    },
    // Signature is (toolName, input, options) and it must return a
    // PermissionResult object. Returning a bare boolean silently denies
    // everything, with the tool name arriving undefined.
    canUseTool: (context = 'voice', log = null) => {
      const message = DENY_MESSAGES[context] ?? DENY_MESSAGES.voice
      return async (toolName) => {
        const request = { kind: 'tool', name: toolName }
        const decision = decide(request)
        const ok = decision.verdict === 'allow'
        recordDecision(audit, console, { actor: context === 'worker' ? 'worker' : 'voice', stage: 'can-use-tool', request, decision })
        log?.(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok ? { behavior: 'allow' } : { behavior: 'deny', message }
      }
    },
  })
}
