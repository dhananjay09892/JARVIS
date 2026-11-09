/**
 * Task A02: the agent registry. Built-in and user folders, every check from
 * TEMPLATE "Checks before an agent is accepted", approval of agent-made
 * definitions, and bad files reported rather than thrown. Temporary folders
 * and fixtures only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAgentRegistry, createToolCatalogue, BUILTIN_AGENTS_DIR, userAgentsDir, agentApprovalsFile, MAX_AGENT_FILES,
} from './agents.mjs'
import { formatAgentFile } from './agent-definition.mjs'
import { BUILTIN_AGENT_CONNECTORS } from './fixtures/agent-connectors.mjs'
import { BRIEFING_SERVER, BRIEFING_TOOL_NAMES, CODER_SERVER, CODER_TOOL_NAMES } from './policy.mjs'

const FIXTURE_BUILTINS = fileURLToPath(new URL('../shared/fixtures/agents/registry/builtin/', import.meta.url))
const quiet = { warn() {} }
const CONNECTORS = [
  { id: 'fake', capabilities: { read: true, write: false } },
  { id: 'notion', capabilities: { read: true, write: true } },
]
const TOOLS = createToolCatalogue({
  servers: { jarvis_tasks: ['task_status', 'task_spawn'], jarvis_memory: ['memory_search'], someones_server: null },
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-agents-'))
  const userDir = join(root, 'agents')
  mkdirSync(userDir)
  const approvalsFile = join(root, 'agent-approvals.json')
  const make = (over = {}) => createAgentRegistry({
    builtinDir: FIXTURE_BUILTINS, userDir, approvalsFile, tools: TOOLS, connectors: CONNECTORS, log: quiet,
    now: () => Date.parse('2026-11-03T12:00:00Z'), ...over,
  })
  const write = (file, text) => writeFileSync(join(userDir, file), text)
  const writeDef = (def, file = `${def.id}.md`) => write(file, formatAgentFile(def))
  return { root, userDir, approvalsFile, make, write, writeDef, done: () => rmSync(root, { recursive: true, force: true }) }
}

const userDef = (over = {}) => ({
  id: 'helper', name: 'Helper', description: 'Helps.', tools: ['Read'], createdBy: 'user', body: 'Help with the goal.', ...over,
})
const refusedFor = (reg, file) => reg.refused().find((r) => r.file === file)

test('the built-in folder ships with the app and every file in it loads', () => {
  const files = readdirSync(BUILTIN_AGENTS_DIR).filter((f) => f.endsWith('.md'))
  assert.ok(files.includes('coordinator.md'))
  // The tools a worker can be given (server.mjs workerCatalogue), as far as built-ins use them.
  const tools = createToolCatalogue({ servers: { jarvis_task: ['report_progress', 'ask_owner'], jarvis_memory: ['list_memories', 'search_memory'], [CODER_SERVER]: [...CODER_TOOL_NAMES], [BRIEFING_SERVER]: [...BRIEFING_TOOL_NAMES] } })
  // The read connectors they name, installed but not granted (the live catalogue has none of their tools).
  const connectors = BUILTIN_AGENT_CONNECTORS
  const reg = createAgentRegistry({ userDir: join(tmpdir(), 'jarvis-agents-missing-dir'), tools, connectors, log: quiet })
  const summary = reg.load()
  assert.deepEqual(reg.refused(), [])
  assert.deepEqual(summary, { loaded: files.length, active: files.length, refused: 0 })
  assert.ok(reg.list().every((a) => a.source === 'builtin' && a.readOnly))
})

test('the user folder and approvals live in the JARVIS data directory', () => {
  const env = { JARVIS_HOME: join(tmpdir(), 'jh') }
  assert.equal(userAgentsDir(env), join(env.JARVIS_HOME, 'agents'))
  assert.equal(agentApprovalsFile(env), join(env.JARVIS_HOME, 'agent-approvals.json'))
})

test('valid built-in and user agents are listed', () => {
  const s = setup()
  try {
    s.writeDef(userDef())
    s.writeDef(userDef({ id: 'notes', name: 'Notes', tools: ['mcp__jarvis_memory__memory_search'], connectors: { notion: 'write' } }))
    const reg = s.make()
    assert.deepEqual(reg.load(), { loaded: 3, active: 3, refused: 0 })
    assert.deepEqual(reg.list().map((a) => [a.id, a.source, a.readOnly]), [
      ['echo', 'builtin', true], ['helper', 'user', false], ['notes', 'user', false],
    ])
    assert.equal(reg.get('echo').body, 'Repeat the goal you are given, word for word, and stop.')
    assert.ok(Object.isFrozen(reg.get('echo')))
    assert.equal(reg.isActive('helper'), true)
    assert.equal(reg.get('nobody'), null)
  } finally { s.done() }
})

test('a file that fails the definition checks is refused with its reasons', () => {
  const s = setup()
  try {
    s.write('broken.md', '---\nid: broken\nname: Broken\ndescription: x\nmemory: write\n---\nBody.\n')
    s.write('nohead.md', 'Just text, no header.')
    const reg = s.make()
    reg.load()
    assert.match(refusedFor(reg, 'broken.md').reasons.join(';'), /memory: agents never write memory directly/)
    assert.match(refusedFor(reg, 'nohead.md').reasons.join(';'), /must start with a --- header/)
    assert.equal(reg.has('broken'), false)
    assert.equal(reg.list().length, 1)
  } finally { s.done() }
})

test('unknown tools are refused against the live tool catalogue', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ id: 'a', tools: ['Read', 'web_teleport'] }))
    s.writeDef(userDef({ id: 'b', tools: ['mcp__jarvis_tasks__task_delete_everything'] }))
    s.writeDef(userDef({ id: 'c', tools: ['mcp__someones_server__anything'] }))
    s.writeDef(userDef({ id: 'd', tools: ['mcp__nobodys_server__anything'] }))
    const reg = s.make()
    reg.load()
    assert.deepEqual(refusedFor(reg, 'a.md').reasons, ['tools.1: no such tool is installed'])
    assert.deepEqual(refusedFor(reg, 'b.md').reasons, ['tools.0: no such tool is installed'])
    // A server whose tool list can't be read counts as installed; one that isn't configured does not.
    assert.equal(reg.has('c'), true)
    assert.deepEqual(refusedFor(reg, 'd.md').reasons, ['tools.0: no such tool is installed'])
  } finally { s.done() }
})

test('the tool catalogue accepts a set, an array or a predicate, and a throwing one refuses', () => {
  const s = setup()
  try {
    s.writeDef(userDef())
    for (const tools of [new Set(['Read', 'mcp__jarvis_tasks__task_status']), ['Read', 'mcp__jarvis_tasks__task_status'], (n) => n === 'Read' || n.startsWith('mcp__jarvis_tasks__')]) {
      const reg = s.make({ tools })
      reg.load()
      assert.equal(reg.summary().refused, 0)
    }
    const reg = s.make({ tools: () => { throw new Error('catalogue down') } })
    reg.load()
    assert.equal(reg.summary().loaded, 0)
    assert.equal(reg.summary().refused, 2)
  } finally { s.done() }
})

test('unknown connectors, and write on a read-only connector, are refused', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ id: 'a', connectors: { spotify: 'read' } }))
    s.writeDef(userDef({ id: 'b', connectors: { fake: 'write' } }))
    const reg = s.make()
    reg.load()
    assert.deepEqual(refusedFor(reg, 'a.md').reasons, ['connectors.spotify: no such connector is installed'])
    assert.deepEqual(refusedFor(reg, 'b.md').reasons, ['connectors.fake: this connector cannot write'])
  } finally { s.done() }
})

test('tools of an installed connector count as installed even before they are granted', () => {
  const s = setup()
  try {
    const connectors = [
      ...CONNECTORS.filter((c) => c.id !== 'notion'),
      { id: 'notion', capabilities: { read: true, write: true }, tools: [{ name: 'search_pages', capability: 'read' }, { name: 'append_block', capability: 'write' }] },
    ]
    s.writeDef(userDef({ id: 'a', tools: ['mcp__jarvis_connectors__notion__read__search_pages'], connectors: { notion: 'read' } }))
    s.writeDef(userDef({ id: 'b', tools: ['mcp__jarvis_connectors__notion__read__delete_everything'], connectors: { notion: 'read' } }))
    s.writeDef(userDef({ id: 'c', tools: ['mcp__jarvis_connectors__notion__write__search_pages'], connectors: { notion: 'write' } }))
    s.writeDef(userDef({ id: 'd', tools: ['mcp__jarvis_connectors__spotify__read__search_songs'] }))
    const reg = s.make({ connectors })
    reg.load()
    assert.equal(reg.has('a'), true, 'a real read tool of an installed connector is accepted')
    assert.deepEqual(refusedFor(reg, 'b.md').reasons, ['tools.0: no such tool is installed'])
    assert.deepEqual(refusedFor(reg, 'c.md').reasons, ['tools.0: no such tool is installed'], 'the capability must match too')
    assert.deepEqual(refusedFor(reg, 'd.md').reasons, ['tools.0: no such tool is installed'])
    // The same rule applies to edits checked before they are written.
    assert.deepEqual(reg.check(userDef({ id: 'e', tools: ['mcp__jarvis_connectors__notion__read__search_pages'], connectors: { notion: 'read' } })), [])
  } finally { s.done() }
})

test('the connector registry itself can be passed, and a failing list() refuses connector agents', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ id: 'a', connectors: { notion: 'read' } }))
    let reg = s.make({ connectors: { list: () => CONNECTORS } })
    reg.load()
    assert.equal(reg.has('a'), true)
    reg = s.make({ connectors: { list: () => { throw new Error('down') } } })
    reg.load()
    assert.equal(reg.has('a'), false)
    assert.equal(reg.has('echo'), false) // echo reads the fake connector
  } finally { s.done() }
})

test('a user file may not shadow a built-in id, and ids are unique', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ id: 'echo' }))
    s.write('helper.md', formatAgentFile(userDef()))
    s.write('helper-copy.md', formatAgentFile(userDef()))
    const reg = s.make()
    reg.load()
    assert.match(refusedFor(reg, 'echo.md').reasons[0], /echo is a built-in agent; copy it under a new id/)
    assert.equal(reg.list().find((a) => a.id === 'echo').source, 'builtin')
    // helper-copy.md sorts first, so it is refused for its name; helper.md loads.
    assert.deepEqual(refusedFor(reg, 'helper-copy.md').reasons, ['id: the file must be named helper.md'])
    assert.equal(reg.has('helper'), true)
  } finally { s.done() }
})

test('two built-in files with one id: the second is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-agents-bi-'))
  try {
    const def = { id: 'twin', name: 'Twin', description: 'x', createdBy: 'builtin', body: 'Do it.' }
    writeFileSync(join(root, 'a.md'), formatAgentFile(def))
    writeFileSync(join(root, 'b.md'), formatAgentFile(def))
    const reg = createAgentRegistry({ builtinDir: root, userDir: join(root, 'none'), approvalsFile: join(root, 'ap.json'), log: quiet })
    reg.load()
    assert.deepEqual(reg.refused().map((r) => [r.file, r.reasons]), [['b.md', ['id: another file already uses twin']]])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('only shipped agents are builtin', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ createdBy: 'builtin' }))
    const reg = s.make()
    reg.load()
    assert.deepEqual(refusedFor(reg, 'helper.md').reasons, ['createdBy: only agents shipped with JARVIS are builtin'])
  } finally { s.done() }
  const root = mkdtempSync(join(tmpdir(), 'jarvis-agents-bi-'))
  try {
    writeFileSync(join(root, 'x.md'), formatAgentFile(userDef({ id: 'x' })))
    const reg = createAgentRegistry({ builtinDir: root, userDir: join(root, 'none'), approvalsFile: join(root, 'ap.json'), log: quiet })
    reg.load()
    assert.deepEqual(reg.refused()[0].reasons, ['createdBy: a built-in agent must say builtin'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an agent-made definition stays inactive until approved, and an edit needs a new approval', () => {
  const s = setup()
  try {
    const made = userDef({ id: 'watcher', createdBy: 'agent', requestedBy: 'coordinator' })
    s.writeDef(made)
    let reg = s.make()
    reg.load()
    assert.equal(reg.has('watcher'), true)
    assert.equal(reg.isActive('watcher'), false)
    assert.equal(reg.list().find((a) => a.id === 'watcher').inactiveReason, 'needs-approval')
    assert.deepEqual(reg.active().map((a) => a.id), ['echo'])

    assert.deepEqual(reg.approve('watcher', { by: 'owner' }), { ok: true, id: 'watcher' })
    assert.equal(reg.isActive('watcher'), true)
    assert.equal(reg.list().find((a) => a.id === 'watcher').inactiveReason, undefined)
    const saved = JSON.parse(readFileSync(s.approvalsFile, 'utf8'))
    assert.equal(saved.approved.watcher.by, 'owner')
    assert.equal(saved.approved.watcher.approvedAt, '2026-11-03T12:00:00.000Z')

    // A restart keeps the approval.
    reg = s.make()
    reg.load()
    assert.equal(reg.isActive('watcher'), true)

    // Changing the file after approval puts it back to waiting.
    s.writeDef({ ...made, tools: ['Read', 'mcp__jarvis_tasks__task_status'] })
    reg.reload()
    assert.equal(reg.isActive('watcher'), false)
  } finally { s.done() }
})

test('approve refuses unknown agents and ones that need no approval', () => {
  const s = setup()
  try {
    s.writeDef(userDef())
    const reg = s.make()
    reg.load()
    assert.deepEqual(reg.approve('nobody'), { ok: false, error: 'no such agent' })
    assert.deepEqual(reg.approve('helper'), { ok: false, error: 'only agent-made definitions need approval' })
  } finally { s.done() }
})

test('a corrupt approvals file approves nothing and does not crash', () => {
  const s = setup()
  try {
    s.writeDef(userDef({ id: 'made', createdBy: 'agent', requestedBy: 'coordinator' }))
    writeFileSync(s.approvalsFile, '{ not json')
    const reg = s.make()
    reg.load()
    assert.equal(reg.isActive('made'), false)
  } finally { s.done() }
})

test('bad files never crash loading, and refusals are logged without file content', () => {
  const s = setup()
  try {
    const secret = 'sk-ant-SECRET-should-never-be-logged-123456'
    s.write('leak.md', `---\nid: ${secret}\nname: x\ndescription: x\n---\nbody`)
    s.write('binary.md', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]).toString('latin1'))
    s.write('huge.md', `---\nid: huge\n---\n${'x'.repeat(70_000)}`)
    s.write('notes.txt', 'ignored, not a definition')
    s.write('.hidden.md', 'ignored, a dotfile')
    mkdirSync(join(s.userDir, 'folder.md'))
    const warnings = []
    const reg = s.make({ log: { warn: (m) => warnings.push(m) } })
    assert.doesNotThrow(() => reg.load())
    assert.deepEqual(reg.refused().map((r) => r.file).sort(), ['binary.md', 'huge.md', 'leak.md'])
    assert.match(refusedFor(reg, 'huge.md').reasons[0], /larger than/)
    assert.equal(warnings.length, 3)
    assert.ok(warnings.every((w) => !w.includes(secret)))
    assert.ok(reg.refused().every((r) => !r.reasons.join(' ').includes(secret)))
    assert.equal(reg.has('echo'), true)
  } finally { s.done() }
})

test('a missing user folder is fine, and folders past the file cap are reported', () => {
  const s = setup()
  try {
    rmSync(s.userDir, { recursive: true })
    const reg = s.make()
    assert.deepEqual(reg.load(), { loaded: 1, active: 1, refused: 0 })
    mkdirSync(s.userDir)
    for (let i = 0; i <= MAX_AGENT_FILES; i++) s.write(`a${String(i).padStart(4, '0')}.md`, 'x')
    reg.reload()
    assert.ok(reg.refused().some((r) => r.file === '(folder)' && /more than 500 files/.test(r.reasons[0])))
    assert.equal(reg.refused().filter((r) => r.file !== '(folder)').length, MAX_AGENT_FILES)
  } finally { s.done() }
})

test('reload picks up new and removed files', () => {
  const s = setup()
  try {
    const reg = s.make()
    reg.load()
    assert.equal(reg.has('helper'), false)
    s.writeDef(userDef())
    reg.reload()
    assert.equal(reg.has('helper'), true)
    rmSync(join(s.userDir, 'helper.md'))
    reg.reload()
    assert.equal(reg.has('helper'), false)
  } finally { s.done() }
})

test('the default tool catalogue knows the SDK built-ins and nothing else', () => {
  const t = createToolCatalogue()
  assert.equal(t.has('Read'), true)
  assert.equal(t.has('Bash'), true)
  assert.equal(t.has('web_search'), false)
  assert.equal(t.has('mcp__jarvis__display'), false)
  assert.equal(t.has(42), false)
  const withServers = createToolCatalogue({ builtins: [], servers: { jarvis: ['display'], 'bad key!': ['x'] }, names: ['own_tool'] })
  assert.deepEqual(withServers.names(), ['mcp__jarvis__display', 'own_tool'])
})
