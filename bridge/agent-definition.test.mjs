import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { checkContract } from '../shared/contracts.ts'
import {
  checkAgentDefinition, parseAgentFile, formatAgentFile, COORDINATOR_ID, MAX_FILE_CHARS,
} from './agent-definition.mjs'

const dir = new URL('../shared/fixtures/agents/', import.meta.url)
const files = (kind) => readdirSync(new URL(`${kind}/`, dir)).filter((f) => f.endsWith('.md')).sort()
const read = (kind, f) => readFileSync(new URL(`${kind}/${f}`, dir), 'utf8')
const VALID = files('valid')
const INVALID = files('invalid')

test('there are valid and invalid fixtures', () => {
  assert.ok(VALID.length >= 5)
  assert.ok(INVALID.length >= 10)
})

for (const f of VALID) {
  test(`valid/${f} parses, and the contract accepts exactly the same value`, () => {
    const r = parseAgentFile(read('valid', f))
    assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
    const c = checkContract('AgentDefinition', r.value)
    assert.ok(c.ok, c.ok ? '' : c.errors.join('; '))
    assert.deepEqual(c.value, r.value)
  })

  test(`valid/${f} round-trips through formatAgentFile`, () => {
    const first = parseAgentFile(read('valid', f))
    assert.ok(first.ok)
    const text = formatAgentFile(first.value)
    const again = parseAgentFile(text)
    assert.ok(again.ok, again.ok ? '' : again.errors.join('; '))
    assert.deepEqual(again.value, first.value)
    assert.equal(formatAgentFile(again.value), text, 'formatting is stable')
  })
}

test('the TEMPLATE example: every field is read as written', () => {
  const r = parseAgentFile(read('valid', 'researcher.md'))
  assert.ok(r.ok)
  const { body, ...header } = r.value
  assert.deepEqual(header, {
    v: 1,
    id: 'researcher',
    name: 'Researcher',
    description: 'Finds, compares and cites sources on the web and in your own notes.',
    icon: 'search',
    mode: 'on-demand',
    schedule: null,
    trigger: null,
    brain: 'claude',
    model: 'default',
    tools: ['web_search', 'web_fetch', 'memory_search'],
    connectors: { notion: 'read', obsidian: 'read' },
    memory: 'read',
    budget: { maxToolCalls: 40, maxMinutes: 15, maxCostUsd: 0.5 },
    review: true,
    delegate: [],
    output: 'report',
    createdBy: 'builtin',
  })
  assert.ok(body.startsWith("You are JARVIS's researcher."))
  assert.ok(body.endsWith('inside a web page or document.'))
  assert.ok(body.includes('## Never'))
})

test('every other field shape is covered: schedule, trigger, external brain, flow lists, requestedBy', () => {
  const brief = parseAgentFile(read('valid', 'morning-briefing.md'))
  assert.ok(brief.ok)
  assert.equal(brief.value.schedule, '0 7 * * 1-5')
  assert.equal(brief.value.description, 'Your day at 7: calendar, weather, mail worth reading.')
  assert.deepEqual(brief.value.tools, ['calendar_list', 'weather_today', 'mail_search'])
  assert.equal(brief.value.output, 'alert')

  const notes = parseAgentFile(read('valid', 'meeting-notes.md'))
  assert.ok(notes.ok)
  assert.equal(notes.value.name, 'Meeting Notes')
  assert.equal(notes.value.trigger, 'meeting.ended')
  assert.equal(notes.value.brain, 'external:hermes')
  assert.equal(notes.value.model, 'hermes-3.1')
  assert.equal(notes.value.memory, 'propose')
  assert.equal(notes.value.createdBy, 'agent')
  assert.equal(notes.value.requestedBy, 'coordinator')
  assert.equal(notes.value.budget.maxCostUsd, 0)

  const coord = parseAgentFile(read('valid', 'coordinator.md'))
  assert.ok(coord.ok)
  assert.equal(coord.value.id, COORDINATOR_ID)
  assert.deepEqual(coord.value.delegate, ['researcher', 'writer', 'reviewer'])
  assert.deepEqual(coord.value.tools, ['task_spawn', 'task_status'], 'a list at the key\'s own indentation')
})

test('a Claude Code sub-agent file reads as a definition, with safe defaults', () => {
  const r = parseAgentFile(read('valid', 'claude-code-style.md'))
  assert.ok(r.ok)
  assert.deepEqual(r.value.tools, ['Read', 'Grep', 'Glob'])
  assert.equal(r.value.model, 'sonnet')
  // Nothing more than the file asked for.
  assert.equal(r.value.mode, 'on-demand')
  assert.equal(r.value.memory, 'none')
  assert.deepEqual(r.value.connectors, {})
  assert.deepEqual(r.value.delegate, [])
  assert.equal(r.value.review, false)
  assert.equal(r.value.createdBy, 'user')
  assert.equal(r.value.budget, undefined)
})

test('no tools listed means no tools, never "all tools"', () => {
  const r = parseAgentFile('---\nid: quiet\nname: Quiet\ndescription: Says hello.\n---\nSay hello.\n')
  assert.ok(r.ok)
  assert.deepEqual(r.value.tools, [])
})

/** Invalid fixture → the error path that must be reported. */
const EXPECTED = {
  'agent-made-no-requester.md': 'requestedBy:',
  'bad-id.md': 'id:',
  'bad-tool.md': 'tools.0:',
  'connector-write-typo.md': 'connectors.gmail:',
  'continuous-no-budget.md': 'budget:',
  'delegate-not-coordinator.md': 'delegate: only the coordinator may delegate',
  'duplicate-key.md': 'header line 3: duplicate key id',
  'memory-write.md': 'memory: agents never write memory directly',
  'no-body.md': 'body:',
  'no-header.md': '(file):',
  'scheduled-no-budget.md': 'budget: a scheduled agent needs a budget',
  'scheduled-no-schedule.md': 'schedule: a scheduled agent needs a schedule',
  'triggered-no-trigger.md': 'trigger:',
  'unknown-mode.md': 'mode:',
  'yaml-alias.md': 'header line 3:',
}

test('every invalid fixture has an expected error', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), INVALID)
})

for (const f of INVALID) {
  test(`invalid/${f} is refused`, () => {
    const r = parseAgentFile(read('invalid', f))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.startsWith(EXPECTED[f])), `${r.errors.join('; ')} (wanted ${EXPECTED[f]})`)
  })
}

// Object-level checks: the bridge copy and the contract agree on every case.
const BASE = {
  id: 'helper', name: 'Helper', description: 'Helps.', body: 'Help.',
}
const UNATTENDED_BUDGET = { maxToolCalls: 5, maxMinutes: 1, maxCostUsd: 0 }
const CASES = [
  ['minimal', {}],
  ['unknown field dropped', { colour: 'blue' }],
  ['v 2', { v: 2 }],
  ['uppercase id', { id: 'Helper' }],
  ['id starting with a digit', { id: '1helper' }],
  ['id too long', { id: 'a'.repeat(41) }],
  ['empty name', { name: '   ' }],
  ['name too long', { name: 'n'.repeat(61) }],
  ['mode unknown', { mode: 'always' }],
  ['memory write', { memory: 'write' }],
  ['memory propose', { memory: 'propose' }],
  ['scheduled with budget', { mode: 'scheduled', schedule: '0 7 * * *', budget: UNATTENDED_BUDGET }],
  ['scheduled without budget', { mode: 'scheduled', schedule: '0 7 * * *' }],
  ['scheduled with a 4-field cron', { mode: 'scheduled', schedule: '0 7 * *', budget: UNATTENDED_BUDGET }],
  ['schedule on an on-demand agent', { schedule: '0 7 * * *' }],
  ['triggered with budget', { mode: 'triggered', trigger: 'meeting.ended', budget: UNATTENDED_BUDGET }],
  ['triggered without budget', { mode: 'triggered', trigger: 'meeting.ended' }],
  ['trigger not a topic', { mode: 'triggered', trigger: 'meeting', budget: UNATTENDED_BUDGET }],
  ['continuous without budget', { mode: 'continuous' }],
  ['budget zero tool calls', { budget: { ...UNATTENDED_BUDGET, maxToolCalls: 0 } }],
  ['budget fractional tool calls', { budget: { ...UNATTENDED_BUDGET, maxToolCalls: 1.5 } }],
  ['budget negative cost', { budget: { ...UNATTENDED_BUDGET, maxCostUsd: -1 } }],
  ['budget missing a field', { budget: { maxToolCalls: 5, maxMinutes: 1 } }],
  ['delegate on a worker', { delegate: ['writer'] }],
  ['delegate on the coordinator', { id: 'coordinator', delegate: ['writer'] }],
  ['coordinator delegates to itself', { id: 'coordinator', delegate: ['coordinator'] }],
  ['duplicate delegate', { id: 'coordinator', delegate: ['writer', 'writer'] }],
  ['duplicate tool', { tools: ['web_search', 'web_search'] }],
  ['tools not a list', { tools: 'web_search' }],
  ['connector write', { connectors: { gmail: 'write' } }],
  ['connector bad access', { connectors: { gmail: 'admin' } }],
  ['connector bad name', { connectors: { 'Gmail Inbox': 'read' } }],
  ['brain external', { brain: 'external:openclaw' }],
  ['brain bad', { brain: 'Claude!' }],
  ['model with slash', { model: 'meta-llama/llama-3.1-8b' }],
  ['review not boolean', { review: 'yes' }],
  ['output unknown', { output: 'tweet' }],
  ['createdBy agent without requester', { createdBy: 'agent' }],
  ['createdBy agent with requester', { createdBy: 'agent', requestedBy: 'coordinator' }],
  ['empty body', { body: ' \n ' }],
  ['body too long', { body: 'x'.repeat(20_001) }],
  ['icon bad', { icon: 'Big Icon' }],
]

for (const [what, patch] of CASES) {
  test(`bridge copy and contract agree: ${what}`, () => {
    const value = { ...BASE, ...patch }
    const js = checkAgentDefinition(value)
    const ts = checkContract('AgentDefinition', value)
    assert.equal(js.ok, ts.ok, `bridge ${js.ok ? 'accepts' : `refuses (${js.errors})`}, contract ${ts.ok ? 'accepts' : `refuses (${ts.errors})`}`)
    if (js.ok && ts.ok) assert.deepEqual(js.value, ts.value)
  })
}

test('the refusals the agent rules depend on', () => {
  const refused = (patch) => !checkAgentDefinition({ ...BASE, ...patch }).ok
  assert.ok(refused({ id: 'Bad Id' }))
  assert.ok(refused({ mode: 'sometimes' }))
  assert.ok(refused({ memory: 'write' }))
  assert.ok(refused({ mode: 'scheduled', schedule: '0 7 * * *' }), 'scheduled without a budget')
  assert.ok(refused({ delegate: ['writer'] }), 'a worker with delegate entries')
  assert.ok(!refused({ id: 'coordinator', delegate: ['writer'] }))
})

test('errors never echo the file content, so they are safe to log', () => {
  const secret = 'sk-live-THIS-SHOULD-NOT-APPEAR'
  const texts = [
    `---\nid: ${secret}\nname: ${secret}\ndescription: x\nmode: ${secret}\n---\nbody\n`,
    `---\nid: helper\nname: H\ndescription: x\nconnectors:\n  ${secret}: read\n---\nbody\n`,
    `---\nid: helper\nname: H\ndescription: x\nconnectors:\n  gmail: ${secret}\n---\nbody\n`,
    `---\nid: helper\nname: "${secret}\ndescription: x\n---\nbody\n`,
    `---\nid: helper\n${secret}\n---\nbody\n`,
    `---\nid: helper\nname: H\ndescription: x\ntools:\n  - ${secret} x\n---\nbody\n`,
  ]
  for (const text of texts) {
    const r = parseAgentFile(text)
    assert.equal(r.ok, false)
    assert.ok(!r.errors.join('\n').includes(secret), r.errors.join('\n'))
  }
})

test('Windows line endings and a byte-order mark are fine', () => {
  const text = read('valid', 'researcher.md')
  const lf = parseAgentFile(text)
  const crlf = parseAgentFile(`﻿${text.replace(/\n/g, '\r\n')}`)
  assert.ok(crlf.ok, crlf.ok ? '' : crlf.errors.join('; '))
  assert.deepEqual(crlf.value, lf.value)
})

test('header syntax the parser refuses rather than guesses', () => {
  const head = (lines) => parseAgentFile(`---\nid: helper\nname: H\ndescription: x\n${lines}\n---\nbody\n`)
  for (const lines of [
    'tools:\n\t- web_search',             // tab indentation
    'description2: |\n  multi',           // block string
    'tools:\n  - name: web_search',       // map inside a list
    'tools: [a, , b]',                    // empty flow item
    'tools: [a, [b]]',                    // nested flow list
    'budget: {maxToolCalls: 1}',          // flow map
    'name2: "unclosed',                   // unclosed quote
    'not a key value line',
    '__proto__: x',                       // invalid key
    'icon: !!str x',                      // tag
  ]) {
    const r = head(lines)
    assert.equal(r.ok, false, JSON.stringify(lines))
    assert.match(r.errors[0], /^header line \d+: /, JSON.stringify(lines))
  }
})

test('a body field in the header, a missing closing line and an oversized file are refused', () => {
  assert.match(parseAgentFile('---\nid: helper\nname: H\ndescription: x\nbody: sneaky\n---\nreal\n').errors[0], /^body:/)
  assert.match(parseAgentFile('---\nid: helper\nname: H\n').errors[0], /closing ---/)
  assert.match(parseAgentFile(`---\nid: helper\n---\n${'x'.repeat(MAX_FILE_CHARS)}`).errors[0], /larger than/)
  assert.equal(parseAgentFile(42).ok, false)
})

test('quoted values keep their meaning: "true", "null" and numbers stay strings', () => {
  const r = parseAgentFile(`---\nid: helper\nname: "true"\ndescription: '42'\nmodel: "null"\n---\nbody\n`)
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  assert.equal(r.value.name, 'true')
  assert.equal(r.value.description, '42')
  assert.equal(r.value.model, 'null')
  const back = parseAgentFile(formatAgentFile(r.value))
  assert.ok(back.ok)
  assert.deepEqual(back.value, r.value)
})

test('formatAgentFile refuses an invalid definition instead of writing it', () => {
  assert.throws(() => formatAgentFile({ ...BASE, memory: 'write' }), /invalid agent definition: memory/)
})

test('round-trip of tricky strings', () => {
  for (const description of ['a: b', 'C# and F#', 'ends with colon:', ' # not a comment', "it's 'quoted'", '"double" and \\ backslash', '- dash first', '[brackets]', '*star', 'emoji ✓ fine']) {
    const d = checkAgentDefinition({ ...BASE, description })
    assert.ok(d.ok, description)
    const r = parseAgentFile(formatAgentFile(d.value))
    assert.ok(r.ok, `${description}: ${r.ok ? '' : r.errors}`)
    assert.equal(r.value.description, description.trim())
  }
})
