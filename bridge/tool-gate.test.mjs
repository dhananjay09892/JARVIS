import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createToolGate, splitToolWords, isReadName, isVetoed, mcpServerOf, mcpToolOf,
} from './tool-gate.mjs'

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
