import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createToolGate, createPolicy, writesEnabled, splitToolWords, isReadName, isVetoed,
  mcpServerOf, mcpToolOf, GENERAL_WRITE_TOOLS, DENY_MESSAGES, RULE_REASONS,
  PRE_TOOL_USE_GUARD_TIMEOUT_S,
} from './policy.mjs'

const own = {
  isMemoryTool: (t) => ['remember', 'recall', 'forget'].includes(t),
  isWorkflowTool: (t) => ['list_workflows', 'propose_workflow'].includes(t),
  isTaskTool: (t) => ['delegate_task', 'list_tasks'].includes(t),
}
const readOnly = createToolGate({ ...own, allowWrites: false })
const writes = createToolGate({ ...own, allowWrites: true })

/**
 * [tool name, runs in read-only mode?]. Every case is also checked with
 * writes on, where everything except unknown own-server tools must run.
 */
const CASES = [
  // Built-ins.
  ['Read', true], ['Glob', true], ['Grep', true], ['WebFetch', true], ['WebSearch', true],
  ['TodoWrite', true], ['ToolSearch', true], ['ListMcpResources', true],
  ['ListMcpResourcesTool', true], ['ReadMcpResource', true], ['ReadMcpResourceTool', true],
  ['BashOutput', true], ['TaskOutput', true],
  ['Task', false], ['Agent', false],
  ['Bash', false], ['Write', false], ['Edit', false], ['MultiEdit', false],
  ['NotebookEdit', false], ['KillShell', false], ['TaskStop', false],
  ['SomeNewBuiltin', false],

  // JARVIS's own servers.
  ['mcp__jarvis__show_panel', true], ['mcp__jarvis_ui__ui_theme', true],
  ['mcp__jarvis_chrome__chrome_navigate', true], ['mcp__jarvis_eyes__look', true],
  ['mcp__jarvis_apps__launch_app', true], ['mcp__jarvis_apps__uninstall_app', false],
  ['mcp__jarvis_workspace__list_files', true], ['mcp__jarvis_workspace__read_file', true],
  ['mcp__jarvis_workspace__write_file', true], ['mcp__jarvis_workspace__delete_file', true],
  ['mcp__jarvis_workspace__chmod_file', false],
  ['mcp__jarvis_development__run_command', true], ['mcp__jarvis_development__push_branch', true],
  ['mcp__jarvis_development__force_push', false],
  ['mcp__jarvis_memory__remember', true], ['mcp__jarvis_memory__export_all', false],
  ['mcp__jarvis_workflows__list_workflows', true], ['mcp__jarvis_workflows__run_now', false],
  ['mcp__jarvis_tasks__delegate_task', true], ['mcp__jarvis_tasks__wipe_board', false],
  ['mcp__jarvis_task__report_progress', true], ['mcp__jarvis_task__ask_owner', true],
  ['mcp__jarvis_task__approve_self', false],

  // Plain reads on unknown servers.
  ['mcp__gcal__list_events', true], ['mcp__gcal__get_event', true],
  ['mcp__gmail__search_threads', true], ['mcp__gmail__read_message', true],
  ['mcp__notion__query_database', true], ['mcp__files__find_files', true],
  ['mcp__github__fetch_issue', true], ['mcp__adb__list_devices', true],
  ['mcp__adb__screenshot', true], ['mcp__docs__describe_table', true],
  ['mcp__x__inspect_element', true], ['mcp__x__show_status', true],
  ['mcp__x__view_page', true], ['mcp__x__explain_plan', true],
  ['mcp__x__check_status', true], ['mcp__x__getUser', true],
  ['mcp__x__listDevices', true], ['mcp__x__Get-Calendar-Events', true],
  ['mcp__x__search', true], ['mcp__x__get_subscription_status', true],
  ['mcp__x__list_runs_summary', true], ['mcp__x__get_dataset', true],

  // No read verb first: withheld.
  ['mcp__adb__install_apk', false], ['mcp__x__make_outbound_call', false],
  ['mcp__x__ping', false], ['mcp__x__do_thing', false], ['mcp__x__summarize', false],
  ['mcp__x__take_screenshot', false],

  // The IMPROVEMENT_PLAN #3 defects: a read verb as a prefix of a longer word.
  ['mcp__shop__checkout_cart', false], ['mcp__shop__checkoutCart', false],
  ['mcp__shop__checkout', false], ['mcp__x__getaway_booking', false],
  ['mcp__x__listen_and_record', false], ['mcp__x__readdress_parcel', false],
  ['mcp__x__showcase_publish', false], ['mcp__x__finder_open', false],
  ['mcp__x__querystring_set', false], ['mcp__x__viewport_resize', false],
  ['mcp__x__fetchandexecute', false], ['mcp__x__listdevices', false],

  // A read verb first, an action later: withheld.
  ['mcp__mail__read_and_archive', false], ['mcp__mail__read_and_forward', false],
  ['mcp__mail__get_and_reply', false], ['mcp__files__list_and_move', false],
  ['mcp__files__find_and_share', false], ['mcp__files__search_and_upload', false],
  ['mcp__shop__get_and_order', false], ['mcp__bank__check_and_transfer', false],
  ['mcp__gh__list_and_merge', false], ['mcp__gh__get_and_approve', false],
  ['mcp__forms__fetch_and_submit', false], ['mcp__ci__get_and_run', false],
  ['mcp__x__get_and_set_flag', false], ['mcp__cal__find_and_cancel', false],
  ['mcp__bank__list_and_withdraw', false], ['mcp__x__get_then_execute', false],
  ['mcp__x__readAndArchive', false], ['mcp__x__Search-And-Delete', false],
  ['mcp__x__get_or_create', false], ['mcp__x__list_and_purchase', false],
  ['mcp__x__check_and_unlock', false], ['mcp__x__get_reset_link', false],

  // The substring veto, unchanged: effectful verbs hidden inside a name.
  ['mcp__x__sendmail', false], ['mcp__x__Bulk-Edit-Events', false],
  ['mcp__x__get_and_delete', false], ['mcp__x__list_downloads', false],
  ['mcp__x__fetch_update', false], ['mcp__x__get_post', false],

  // Allowlisted generation/search servers: run, unless the veto fires.
  ['mcp__higgsfield__generate_image', true], ['mcp__heygen__generate_avatar_video', true],
  ['mcp__elevenlabs__text_to_speech', true], ['mcp__elevenlabs__list_voices', true],
  ['mcp__exa__web_search_exa', true], ['mcp__exa__deep_researcher_start', true],
  ['mcp__serper__google_search', true], ['mcp__mcp-registry__search', true],
  ['mcp__Microsoft_Clarity__query-analytics-dashboard', true],
  ['mcp__elevenlabs__make_outbound_call', false], ['mcp__higgsfield__delete_character', false],
  ['mcp__higgsfield__create_character', false], ['mcp__higgsfield__edit_image', false],
  ['mcp__lottie-search__download_lottie', false], ['mcp__heygen__upload_asset', false],
  ['mcp__elevenlabs__transfer_to_number', false],

  // The exemptions are server-scoped and do not leak.
  ['mcp__openrouter__send-message', true], ['mcp__openrouter__send-feedback', true],
  ['mcp__gmail__send-message', false], ['mcp__openrouter__send-email', false],

  // Session tools the bridge is developed inside.
  ['mcp__ccd_session__list_files', true], ['mcp__ccd_session_x__mark_done', true],
  ['mcp__ccd_session__delete_session', false],

  // Malformed names never run in read-only mode.
  ['', false], ['mcp__', false], ['mcp__x__', false], ['mcp__x', false],
]

test('gate table: read-only mode', () => {
  assert.ok(CASES.length >= 100, `the gate suite should keep at least 100 cases (has ${CASES.length})`)
  const wrong = CASES.filter(([name, expected]) => readOnly(name) !== expected)
  assert.deepEqual(wrong.map(([n, e]) => `${n} expected ${e}`), [])
})

test('gate table: with writes on, everything runs except own-server tools that do not exist', () => {
  for (const [name] of CASES) {
    const ownServer = /^mcp__jarvis(_[a-z]+)?__/.test(name)
    if (ownServer || name === '' ) continue
    assert.equal(writes(name), true, name)
  }
  // Own servers stay closed lists even with writes on.
  assert.equal(writes('mcp__jarvis_apps__uninstall_app'), false)
  assert.equal(writes('mcp__jarvis_development__force_push'), false)
  assert.equal(writes(''), false)
})

test('allowWrites must be exactly true; truthy strings do not open the gate', () => {
  for (const allowWrites of ['1', 'true', 1, {}, undefined, null]) {
    const gate = createToolGate({ ...own, allowWrites })
    assert.equal(gate('Bash'), false, String(allowWrites))
  }
})

test('defaults deny own-server tools when predicates are missing', () => {
  const gate = createToolGate()
  assert.equal(gate('mcp__jarvis_memory__remember'), false)
  assert.equal(gate('Read'), true)
  assert.equal(gate(undefined), false)
  assert.equal(gate(42), false)
})

test('splitToolWords splits on separators and camelCase', () => {
  assert.deepEqual(splitToolWords('read_and_archive'), ['read', 'and', 'archive'])
  assert.deepEqual(splitToolWords('Bulk-Edit-Events'), ['bulk', 'edit', 'events'])
  assert.deepEqual(splitToolWords('checkoutCart'), ['checkout', 'cart'])
  assert.deepEqual(splitToolWords('getHTTPResponse'), ['get', 'http', 'response'])
  assert.deepEqual(splitToolWords('a.b/c d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(splitToolWords(''), [])
})

test('isReadName reads the first word, not a prefix', () => {
  assert.equal(isReadName('check_status'), true)
  assert.equal(isReadName('checkout'), false)
  assert.equal(isReadName('and_get'), false)
  assert.equal(isReadName(''), false)
})

test('isVetoed honours exemptions only for their own server', () => {
  assert.equal(isVetoed('openrouter', 'send-message'), false)
  assert.equal(isVetoed('other', 'send-message'), true)
  assert.equal(isVetoed('x', 'get_dataset'), false)
  assert.equal(isVetoed('x', 'set_dataset'), true)
})

test('mcp name parsing', () => {
  assert.equal(mcpServerOf('mcp__srv__tool'), 'srv')
  assert.equal(mcpServerOf('Read'), null)
  assert.equal(mcpToolOf('mcp__x__a__b'), 'a__b')
})

// ---------------------------------------------------------------------------
// The policy engine around the gate (plan 15, phase 1).

const readOnlyPolicy = createPolicy({ ...own, allowWrites: false })
const writesPolicy = createPolicy({ ...own, allowWrites: true })

test('policy.decideTool agrees with the gate on every case, in both modes', () => {
  for (const [name] of CASES) {
    assert.equal(readOnlyPolicy.decideTool(name), readOnly(name), `read-only: ${name}`)
    assert.equal(writesPolicy.decideTool(name), writes(name), `writes: ${name}`)
  }
})

test('policy.decide returns a PolicyDecision with a known rule and a reason', () => {
  for (const [name, expected] of CASES) {
    const d = readOnlyPolicy.decide({ kind: 'tool', name })
    assert.equal(d.verdict, expected ? 'allow' : 'deny', name)
    assert.ok(Object.hasOwn(RULE_REASONS, d.rule), `${name}: unknown rule ${d.rule}`)
    assert.equal(d.reason, RULE_REASONS[d.rule])
    assert.equal(typeof d.reason, 'string')
  }
})

test('policy.decide names the rule that settled each call', () => {
  const rule = (name, p = readOnlyPolicy) => p.decide({ kind: 'tool', name }).rule
  assert.equal(rule('Read'), 'read-only-builtin')
  assert.equal(rule('Bash'), 'write-builtin')
  assert.equal(rule('Agent'), 'subagent')
  assert.equal(rule('SomeNewBuiltin'), 'unknown-builtin')
  assert.equal(rule('mcp__jarvis__display'), 'own-display')
  assert.equal(rule('mcp__jarvis_chrome__chrome_navigate'), 'own-browser')
  assert.equal(rule('mcp__jarvis_eyes__look'), 'own-camera')
  assert.equal(rule('mcp__jarvis_apps__uninstall_app'), 'own-server-list')
  assert.equal(rule('mcp__x__make_outbound_call'), 'effectful-name')
  assert.equal(rule('mcp__exa__web_search_exa'), 'read-only-server')
  assert.equal(rule('mcp__gcal__list_events'), 'read-name')
  assert.equal(rule('mcp__x__ping'), 'no-read-verb')
  assert.equal(rule(''), 'malformed-name')
  // The same rule settles the call with writes on; only the verdict moves.
  assert.equal(rule('mcp__x__make_outbound_call', writesPolicy), 'effectful-name')
  assert.equal(writesPolicy.decide({ kind: 'tool', name: 'mcp__x__make_outbound_call' }).verdict, 'allow')
})

test('policy.decide refuses anything that is not a tool call', () => {
  for (const action of [undefined, null, {}, { kind: 'device', name: 'unlock' },
    { kind: 'spend', name: 'Read' }, { name: 'Read' }, 'Read']) {
    for (const p of [readOnlyPolicy, writesPolicy]) {
      const d = p.decide(action)
      assert.equal(d.verdict, 'deny', JSON.stringify(action))
      assert.equal(d.rule, 'unknown-action')
    }
  }
})

test('policy.allowWrites is exactly true or false', () => {
  assert.equal(readOnlyPolicy.allowWrites, false)
  assert.equal(writesPolicy.allowWrites, true)
  for (const allowWrites of ['1', 'true', 1, {}, undefined, null]) {
    const p = createPolicy({ ...own, allowWrites })
    assert.equal(p.allowWrites, false, String(allowWrites))
    assert.equal(p.decideTool('Bash'), false, String(allowWrites))
  }
  assert.equal(createPolicy().decideTool('mcp__jarvis_memory__remember'), false)
})

test('the policy object cannot be altered after it is built', () => {
  assert.ok(Object.isFrozen(readOnlyPolicy))
  assert.throws(() => { 'use strict'; readOnlyPolicy.allowWrites = true })
  assert.ok(Object.isFrozen(GENERAL_WRITE_TOOLS))
  assert.ok(Object.isFrozen(DENY_MESSAGES))
})

test('writesEnabled reads exactly "1" from the environment or the settings', () => {
  assert.equal(writesEnabled(), false)
  assert.equal(writesEnabled({ env: { JARVIS_ALLOW_WRITES: '1' } }), true)
  assert.equal(writesEnabled({ settings: { JARVIS_ALLOW_WRITES: '1' } }), true)
  assert.equal(writesEnabled({ env: { JARVIS_ALLOW_WRITES: '0' }, settings: { JARVIS_ALLOW_WRITES: '1' } }), true)
  for (const v of ['0', 'true', 'yes', ' 1', '1 ', 1, true, '']) {
    assert.equal(writesEnabled({ env: { JARVIS_ALLOW_WRITES: v }, settings: { JARVIS_ALLOW_WRITES: v } }), false, String(v))
  }
  assert.equal(writesEnabled({ env: null, settings: null }), false)
})

test('disallowedTools withholds the general write built-ins only while writes are off', () => {
  assert.deepEqual(readOnlyPolicy.disallowedTools(),
    ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'])
  assert.deepEqual(writesPolicy.disallowedTools(), [])
  // A fresh copy each time, so a caller cannot edit the policy's list.
  readOnlyPolicy.disallowedTools().push('Read')
  assert.ok(!readOnlyPolicy.disallowedTools().includes('Read'))
  // Everything withheld here is also refused by the gate itself.
  for (const name of GENERAL_WRITE_TOOLS) assert.equal(readOnlyPolicy.decideTool(name), false, name)
})

test('preToolUse allows by returning nothing and denies with the hook message', async () => {
  const matcher = readOnlyPolicy.preToolUse()
  assert.deepEqual(Object.keys(matcher), ['hooks'], 'no guard, no timeout override')
  const [hook] = matcher.hooks
  assert.deepEqual(await hook({ tool_name: 'Read' }), {})
  assert.deepEqual(await hook({ tool_name: 'Bash' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_MESSAGES.hook,
    },
  })
  const [custom] = readOnlyPolicy.preToolUse({ reason: 'nope' }).hooks
  assert.equal((await custom({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecisionReason, 'nope')
  assert.equal((await hook(undefined)).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal((await hook({})).hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(await writesPolicy.preToolUse().hooks[0]({ tool_name: 'Bash' }), {})
})

test('preToolUse runs the guard only after the gate allows, and refuses if it throws', async () => {
  const calls = []
  const guard = async (name, input) => {
    calls.push([name, input])
    return input?.url === 'https://evil.example/' ? 'held for approval' : null
  }
  const matcher = readOnlyPolicy.preToolUse({ guard })
  assert.equal(matcher.timeout, PRE_TOOL_USE_GUARD_TIMEOUT_S)
  assert.ok(PRE_TOOL_USE_GUARD_TIMEOUT_S > 90, 'must outlast the 90 s approval card')
  const [hook] = matcher.hooks

  // The gate refuses first; the guard is never asked.
  assert.equal((await hook({ tool_name: 'Bash', tool_input: {} })).hookSpecificOutput.permissionDecisionReason,
    DENY_MESSAGES.hook)
  assert.deepEqual(calls, [])

  // Gate allows, guard allows.
  assert.deepEqual(await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://ok.example/' } }), {})
  // Gate allows, guard refuses with its own reason.
  assert.equal((await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://evil.example/' } }))
    .hookSpecificOutput.permissionDecisionReason, 'held for approval')
  assert.deepEqual(calls.map(([n]) => n), ['WebFetch', 'WebFetch'])

  // A guard that throws refuses, and says so in the log.
  const errors = []
  const [broken] = readOnlyPolicy.preToolUse({
    guard: async () => { throw new Error('boom') },
    log: { error: (...a) => errors.push(a) },
  }).hooks
  assert.equal((await broken({ tool_name: 'Read', tool_input: {} })).hookSpecificOutput.permissionDecisionReason,
    DENY_MESSAGES.guardFailed)
  assert.equal(errors.length, 1)
})

test('canUseTool returns PermissionResult objects with the message for its context', async () => {
  const lines = []
  const voice = readOnlyPolicy.canUseTool('voice', (line) => lines.push(line))
  assert.deepEqual(await voice('Read'), { behavior: 'allow' })
  assert.deepEqual(await voice('Bash'), { behavior: 'deny', message: DENY_MESSAGES.voice })
  assert.deepEqual(lines, ['[jarvis] tool Read -> allow', '[jarvis] tool Bash -> deny'])

  const worker = readOnlyPolicy.canUseTool('worker')
  assert.deepEqual(await worker('Bash'), { behavior: 'deny', message: DENY_MESSAGES.worker })
  assert.deepEqual(await worker(undefined), { behavior: 'deny', message: DENY_MESSAGES.worker })
  // An unknown context falls back to the voice wording, never to allow.
  assert.deepEqual(await readOnlyPolicy.canUseTool('nonsense')('Bash'),
    { behavior: 'deny', message: DENY_MESSAGES.voice })
  assert.deepEqual(await writesPolicy.canUseTool('worker')('Bash'), { behavior: 'allow' })
})

test('refusal messages can be spoken: no shell commands or env-var names in them', () => {
  for (const [context, message] of Object.entries(DENY_MESSAGES)) {
    assert.doesNotMatch(message, /JARVIS_ALLOW_WRITES|npm |node |set /, context)
  }
})

/**
 * The wiring, pinned by reading server.mjs. Plan 15's metric is that 100 % of
 * tool paths go through policy; until the brains sit behind a registry (plan
 * 21) this is how a test enforces it. Each check names the shortcut it forbids.
 */
test('server.mjs routes every tool path through policy.mjs', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const count = (re) => (src.match(re) ?? []).length

  // One policy, built from policy.mjs; no second gate and no old import.
  assert.match(src, /import \{[^}]*createPolicy[^}]*\} from '\.\/policy\.mjs'/)
  assert.equal(count(/createPolicy\(/g), 1)
  assert.doesNotMatch(src, /tool-gate\.mjs|createToolGate|permissionDecision:/)
  // The write switch is computed by the policy module, not inline.
  assert.doesNotMatch(src, /JARVIS_ALLOW_WRITES\s*===/)
  assert.match(src, /writesEnabled\(\{ env: process\.env, settings: readSettings\(\) \}\)/)

  // Every agent the bridge starts: each query() has all three hooks into policy.
  const agents = count(/\bquery\(\{/g)
  assert.ok(agents >= 2, 'expected the voice session and the task worker')
  assert.equal(count(/canUseTool:/g), agents, 'one canUseTool per agent')
  assert.equal(count(/canUseTool: policy\.canUseTool\(/g), agents, 'canUseTool must come from policy')
  assert.equal(count(/disallowedTools:/g), agents, 'one disallowedTools per agent')
  assert.equal(count(/disallowedTools: policy\.disallowedTools\(\)/g), agents)
  assert.equal(count(/PreToolUse:/g), agents, 'one PreToolUse hook per agent')
  assert.equal(count(/PreToolUse: \[policy\.preToolUse\(/g), agents, 'the PreToolUse matcher must come from policy')
  // Each agent's hook also runs the taint guard (plan 08) after the gate.
  assert.equal(count(/policy\.preToolUse\(\{ guard: taintGuard\(/g), agents)

  // The browser builds its acting tools from the same switch.
  assert.match(src, /chromeServer\(\{ allowWrites: policy\.allowWrites \}\)/)
  // No permission shortcuts that would skip the callback.
  assert.equal(count(/permissionMode: 'default'/g), agents, "every agent runs in permissionMode 'default'")
  assert.equal(count(/permissionMode:/g), agents)
  assert.doesNotMatch(src, /\ballowedTools:|allowDangerouslySkipPermissions/)
})
