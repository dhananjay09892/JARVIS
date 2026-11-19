import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSkillManifest, parseSkillManifest, createSkillGate, previewSkill, describePermissions,
  loadSkillDir, loadSkills, toolEffect, isSafePathGrant, MAX_MANIFEST_CHARS,
} from './skill-manifest.mjs'
import { createPolicy } from './policy.mjs'

const base = () => ({
  id: 'focus-mode',
  name: 'Focus mode',
  version: '1.0.0',
  author: 'Test Author',
  description: 'Reads the notes and lists what to focus on.',
  riskTier: 'low',
  permissions: { tools: ['Read'], paths: ['notes/**'] },
  triggers: { phrases: ['start focus mode'] },
  dataUse: 'Reads files under notes/ on this computer. Nothing leaves it.',
  steps: [{ tool: 'Read', input: { file_path: 'notes/today.md' }, label: 'Read the notes' }],
})
const errorsOf = (m) => { const r = checkSkillManifest(m); assert.equal(r.ok, false); return r.errors.join('\n') }
const policy = () => createPolicy({ allowWrites: false })

test('a valid manifest passes and defaults are filled in', () => {
  const r = checkSkillManifest(base())
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  assert.equal(r.value.v, 1)
  assert.deepEqual(r.value.permissions.connectors, {})
  assert.equal(r.value.permissions.spend.maxCostUsd, 0)
  assert.equal(r.value.triggers.schedule, null)
  assert.deepEqual(r.value.inputs, {})
})

test('a step that uses a tool outside the grants is refused', () => {
  const m = base()
  m.steps.push({ tool: 'Bash', input: { command: 'dir' } })
  assert.match(errorsOf(m), /steps\.1\.tool: this tool is not in permissions\.tools/)
})

test('a skill with no permissions cannot have any step', () => {
  const m = base()
  m.permissions = {}
  assert.match(errorsOf(m), /steps\.0\.tool/)
})

test('invalid manifests give clear errors', () => {
  assert.match(errorsOf(null), /\(root\): must be an object/)
  assert.match(errorsOf({ ...base(), id: 'Bad Id' }), /id: skill id must be lowercase/)
  assert.match(errorsOf({ ...base(), version: '1.0' }), /version: must look like 1\.0\.0/)
  assert.match(errorsOf({ ...base(), riskTier: 'extreme' }), /riskTier: must be one of low, medium, high/)
  assert.match(errorsOf({ ...base(), steps: [] }), /steps: a skill needs 1 to 20 steps/)
  assert.match(errorsOf({ ...base(), name: '  ' }), /name: must not be empty/)
  assert.match(errorsOf({ ...base(), v: 2 }), /v: must be 1/)
})

test('an unknown field is refused, so a typo in a permission cannot pass', () => {
  const m = base()
  m.permissions.tool = ['Bash']
  assert.match(errorsOf(m), /permissions: unknown field tool/)
  assert.match(errorsOf({ ...base(), extra: 1 }), /\(root\): unknown field extra/)
})

test('errors never echo file content', () => {
  const secret = 'sk-ant-SECRET-VALUE'
  const m = base()
  m.permissions.connectors = { [secret]: 'read' }
  m.permissions.domains = [secret]
  m.triggers.schedule = secret
  const joined = errorsOf({ ...m, [secret]: 1, steps: [{ tool: secret }] })
  assert.ok(!joined.includes(secret), joined)
})

test('path grants stay inside the workspace', () => {
  for (const ok of ['notes/**', 'a/b.txt', '*.md']) assert.ok(isSafePathGrant(ok), ok)
  for (const bad of ['/etc/passwd', '../x', 'a/../b', 'C:\\x', 'C:/x', '~/x', 'a\\b', '', 'a//b', './a']) assert.equal(isSafePathGrant(bad), false, bad)
  const m = base()
  m.permissions.paths = ['../secrets']
  assert.match(errorsOf(m), /permissions\.paths\.0/)
})

test('domains must be host names', () => {
  for (const bad of ['https://example.com', 'example.com/path', '*', 'localhost', 'a b.com', 'example.com:8080']) {
    const m = base()
    m.riskTier = 'medium'
    m.permissions.domains = [bad]
    assert.match(errorsOf(m), /permissions\.domains\.0/, bad)
  }
  const m = base()
  m.riskTier = 'medium'
  m.permissions.domains = ['example.com', '*.example.org']
  assert.ok(checkSkillManifest(m).ok)
})

test('risk tier must fit what the skill can do', () => {
  const act = base()
  act.permissions.tools = ['Read', 'Bash']
  act.steps.push({ tool: 'Bash', input: { command: 'dir' } })
  assert.match(errorsOf(act), /riskTier: a skill that can act, write or spend cannot be low risk/)
  act.riskTier = 'medium'
  assert.ok(checkSkillManifest(act).ok)

  const net = base()
  net.permissions.domains = ['example.com']
  assert.match(errorsOf(net), /riskTier: a skill that reaches the internet/)

  const write = base()
  write.permissions.connectors = { notion: 'write' }
  assert.match(errorsOf(write), /riskTier/)

  const spend = base()
  spend.riskTier = 'medium'
  spend.permissions.tools = ['Bash']
  spend.permissions.spend = { maxCostUsd: 5 }
  spend.steps = [{ tool: 'Bash', input: { command: 'dir' } }]
  assert.match(errorsOf(spend), /must be high risk/)
})

test('a high-risk skill cannot start unattended', () => {
  const m = base()
  m.riskTier = 'high'
  m.triggers = { schedule: '0 8 * * *' }
  assert.match(errorsOf(m), /triggers\.schedule: a high-risk skill cannot run on a schedule/)
  m.triggers = { events: ['meeting.ended'] }
  assert.match(errorsOf(m), /triggers\.events: a high-risk skill cannot start from an event/)
})

test('triggers are checked', () => {
  const m = base()
  m.triggers = { phrases: ['ok'], schedule: 'daily', events: ['nodot'] }
  const e = errorsOf(m)
  assert.match(e, /triggers\.phrases\.0/)
  assert.match(e, /triggers\.schedule: schedule must be a 5-field cron string/)
  assert.match(e, /triggers\.events\.0/)
})

test('inputs: declared, typed, and used by a step', () => {
  const m = base()
  m.inputs = { topic: { type: 'string', description: 'What to focus on' } }
  assert.match(errorsOf(m), /inputs\.topic: is declared but no step uses it/)
  m.steps[0].input.file_path = 'notes/{{input.topic}}.md'
  const r = checkSkillManifest(m)
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  assert.equal(r.value.inputs.topic.required, true)

  const undeclared = base()
  undeclared.steps[0].input.file_path = '{{input.nope}}'
  assert.match(errorsOf(undeclared), /refers to an input the skill does not declare/)

  const bad = base()
  bad.inputs = { n: { type: 'object', description: 'x' } }
  assert.match(errorsOf(bad), /inputs\.n\.type/)
})

test('steps take plain values only', () => {
  const m = base()
  m.steps[0].input = { nested: { a: 1 } }
  assert.match(errorsOf(m), /steps\.0\.input\.nested: must be text, a number or true\/false/)
})

test('a duplicate tool grant is refused', () => {
  const m = base()
  m.permissions.tools = ['Read', 'Read']
  assert.match(errorsOf(m), /permissions\.tools: duplicate entry/)
})

test('parseSkillManifest: bad JSON, big files and a byte-order mark', () => {
  assert.deepEqual(parseSkillManifest('{nope').errors, ['(file): not valid JSON'])
  assert.deepEqual(parseSkillManifest(5).errors, ['(file): must be text'])
  assert.match(parseSkillManifest(' '.repeat(MAX_MANIFEST_CHARS + 1)).errors[0], /larger than/)
  assert.ok(parseSkillManifest(`﻿${JSON.stringify(base())}`).ok)
})

test('the gate refuses a tool outside the grants, whatever the policy says', () => {
  const p = policy()
  // Glob is read-only for the policy, but this skill never asked for it.
  assert.equal(p.decideTool('Glob'), true)
  const m = checkSkillManifest(base()).value
  const gate = createSkillGate({ manifest: m, policy: p })
  const d = gate.decide({ kind: 'tool', name: 'Glob' })
  assert.equal(d.verdict, 'deny')
  assert.equal(d.rule, 'skill-ungranted')
  assert.equal(gate.decideTool('Glob'), false)
  assert.equal(gate.decideTool('Bash'), false)
})

test('a granted tool is still decided by the policy', () => {
  const m = base()
  m.riskTier = 'medium'
  m.permissions.tools = ['Read', 'Bash']
  m.steps.push({ tool: 'Bash', input: { command: 'dir' } })
  const manifest = checkSkillManifest(m).value
  // Writes off: Read runs, Bash is withheld although the skill asked for it.
  const off = createSkillGate({ manifest, policy: createPolicy({ allowWrites: false }) })
  assert.equal(off.decideTool('Read'), true)
  assert.equal(off.decideTool('Bash'), false)
  assert.equal(off.decide({ kind: 'tool', name: 'Bash' }).rule, 'write-builtin')
  // Writes on: Bash runs because the policy allows it and the skill asked for it.
  const on = createSkillGate({ manifest, policy: createPolicy({ allowWrites: true }) })
  assert.equal(on.decideTool('Bash'), true)
  assert.equal(on.decideTool('Write'), false)
})

test('the kill switch and never-list still apply inside a skill', () => {
  const m = base()
  m.riskTier = 'high'
  m.permissions.tools = ['Read', 'mcp__x__make_outbound_call']
  m.steps = [{ tool: 'mcp__x__make_outbound_call', input: { to: '1' } }]
  const manifest = checkSkillManifest(m).value
  let frozen = false
  const live = createPolicy({ allowWrites: true, isFrozen: () => frozen })
  const gate = createSkillGate({ manifest, policy: live })
  assert.equal(gate.decideTool('Read'), true)
  frozen = true
  assert.equal(gate.decideTool('Read'), false)
})

test('the gate fails closed without a manifest and for non-tool actions', () => {
  const p = policy()
  for (const manifest of [null, undefined, {}, { permissions: {} }]) {
    const gate = createSkillGate({ manifest, policy: p })
    assert.equal(gate.decide({ kind: 'tool', name: 'Read' }).rule, 'skill-unknown')
    assert.equal(gate.decideTool('Read'), false)
  }
  const gate = createSkillGate({ manifest: checkSkillManifest(base()).value, policy: p })
  assert.equal(gate.decide({ kind: 'other', name: 'Read' }).verdict, 'deny')
  assert.equal(gate.decide(undefined).verdict, 'deny')
})

test('a gate cannot be widened by changing the manifest afterwards', () => {
  const manifest = checkSkillManifest(base()).value
  const gate = createSkillGate({ manifest, policy: policy() })
  manifest.permissions.tools.push('Glob')
  assert.equal(gate.decideTool('Glob'), false)
})

test('previewSkill shows what each step would do', () => {
  const m = base()
  m.riskTier = 'medium'
  m.permissions.tools = ['Read', 'Bash']
  m.steps.push({ tool: 'Bash', input: { command: 'dir' }, label: 'List' })
  const rows = previewSkill(checkSkillManifest(m).value, policy())
  assert.deepEqual(rows.map((r) => [r.step, r.tool, r.verdict]), [[1, 'Read', 'allow'], [2, 'Bash', 'deny']])
  assert.equal(rows[1].label, 'List')
})

test('toolEffect follows the policy engine', () => {
  assert.equal(toolEffect('Read'), 'read')
  assert.equal(toolEffect('Bash'), 'action')
  assert.equal(toolEffect('mcp__exa__web_search'), 'read')
  assert.equal(toolEffect('mcp__x__send_mail'), 'action')
})

test('describePermissions lists what is asked in plain words', () => {
  const m = base()
  m.riskTier = 'high'
  m.permissions = {
    tools: ['Read', 'Bash'], connectors: { notion: 'write', gmail: 'read' },
    domains: ['example.com'], paths: ['notes/**'], spend: { maxCostUsd: 2 },
  }
  m.steps = [{ tool: 'Read', input: {} }, { tool: 'Bash', input: { command: 'dir' } }]
  m.triggers = { phrases: ['start focus mode'] }
  const d = describePermissions(checkSkillManifest(m).value)
  const text = d.permissions.join('\n')
  assert.match(text, /look things up with: Read/)
  assert.match(text, /act with: Bash/)
  assert.match(text, /change data in notion/)
  assert.match(text, /read gmail/)
  assert.match(text, /example\.com/)
  assert.match(text, /notes\/\*\*/)
  assert.match(text, /\$2 per run/)
  assert.deepEqual(d.startsOn, ['when you say "start focus mode"'])
  assert.equal(d.riskTier, 'high')

  const none = base()
  none.permissions = { tools: ['Read'] }
  none.triggers = {}
  const n = describePermissions(checkSkillManifest(none).value)
  assert.deepEqual(n.startsOn, ['only when you ask for it by name'])
  assert.ok(describePermissions({ ...checkSkillManifest(none).value, permissions: { tools: [], connectors: {}, domains: [], paths: [], spend: { maxCostUsd: 0 } } }).permissions.includes('Asks for no permissions.'))
})

test('the loader reads packs, reports bad ones and keeps going', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const put = (folder, content) => { mkdirSync(join(root, folder)); writeFileSync(join(root, folder, 'skill.json'), content) }
    put('focus-mode', JSON.stringify(base()))
    put('broken', '{nope')
    put('wrong-name', JSON.stringify(base()))
    mkdirSync(join(root, 'empty'))
    writeFileSync(join(root, 'stray.txt'), 'x')
    const { skills, rejected } = loadSkills(root)
    assert.deepEqual(skills.map((s) => s.id), ['focus-mode'])
    const byFolder = Object.fromEntries(rejected.map((r) => [r.folder, r.errors.join(';')]))
    assert.match(byFolder.broken, /not valid JSON/)
    assert.match(byFolder['wrong-name'], /id: must match the name of the skill folder/)
    assert.match(byFolder.empty, /no skill\.json/)
    assert.deepEqual(loadSkills(join(root, 'missing')), { skills: [], rejected: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the loader refuses a linked skill.json', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    mkdirSync(join(root, 'focus-mode'))
    writeFileSync(join(root, 'real.json'), JSON.stringify(base()))
    try { symlinkSync(join(root, 'real.json'), join(root, 'focus-mode', 'skill.json')) } catch { t.skip('links not allowed here'); return }
    const r = loadSkillDir(join(root, 'focus-mode'), 'focus-mode')
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /plain file/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
