import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSkillRegistry, createSkillSwitches, matchSkill, resolveSteps, permissionChanges,
  compareVersions, listFirstPartyPacks, SKILL_SETTINGS,
} from './skill-registry.mjs'
import { loadSkillDir, previewSkill, createSkillGate } from './skill-manifest.mjs'
import { createPolicy } from './policy.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'skills-'))
const base = (over = {}) => ({
  id: 'demo', name: 'Demo', version: '1.0.0', author: 'Test', description: 'A demo.', riskTier: 'low',
  permissions: { tools: ['Read'], paths: ['notes/**'] }, dataUse: 'Reads notes.',
  steps: [{ tool: 'Read', input: { file_path: 'notes/a.md' } }], ...over,
})
function pack(manifest, extra = {}) {
  const dir = tmp()
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest))
  for (const [f, t] of Object.entries(extra)) writeFileSync(join(dir, f), t)
  return dir
}
const policy = createPolicy({ allowWrites: false })
const reg = () => createSkillRegistry({ root: tmp(), policy, now: () => new Date('2026-11-20T10:00:00Z') })

test('review shows the permission screen, preview and review id', () => {
  const r = reg().review(pack(base()))
  assert.equal(r.ok, true)
  assert.match(r.reviewId, /^[0-9a-f]{64}$/)
  assert.ok(r.screen.permissions.some((l) => l.includes('Read')))
  assert.equal(r.steps[0].verdict, 'allow')
  assert.equal(r.installedVersion, null)
})

test('install is refused without approval of the exact files', () => {
  const g = reg(); const dir = pack(base())
  assert.equal(g.install(dir).needsReview, true)
  const { reviewId } = g.review(dir)
  assert.equal(g.install(dir, { approve: 'nope' }).ok, false)
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(base({ description: 'Changed after review.' })))
  assert.equal(g.install(dir, { approve: reviewId }).needsReview, true, 'edited after review')
  assert.deepEqual(g.list(), [])
})

test('an invalid pack is rejected at review with the manifest errors', () => {
  const r = reg().review(pack(base({ steps: [{ tool: 'Bash', input: {} }] })))
  assert.equal(r.ok, false)
  assert.match(r.errors.join(), /not in permissions\.tools/)
})

test('install, list, and the pack is a copy', () => {
  const g = reg(); const dir = pack(base())
  const r = g.install(dir, { approve: g.review(dir).reviewId })
  assert.deepEqual([r.ok, r.id, r.version, r.updatedFrom], [true, 'demo', '1.0.0', null])
  rmSync(dir, { recursive: true })
  const [s] = g.list()
  assert.equal(s.id, 'demo'); assert.equal(s.manifest.name, 'Demo'); assert.equal(s.canRollBack, false)
  assert.ok(existsSync(join(g.root, 'demo', '1.0.0', 'skill.json')))
})

test('a script is copied with the pack and covered by the review id', () => {
  const g = reg()
  const m = base({ riskTier: 'medium', script: 'main.js', steps: undefined })
  const a = pack(m, { 'main.js': 'return 1' }); const b = pack(m, { 'main.js': 'return 2' })
  assert.notEqual(g.review(a).reviewId, g.review(b).reviewId)
  assert.equal(g.install(a, { approve: g.review(a).reviewId }).ok, true)
  assert.equal(readFileSync(join(g.root, 'demo', '1.0.0', 'main.js'), 'utf8'), 'return 1')
})

test('update shows what changed, keeps the old version, and rollback restores it', () => {
  const g = reg()
  const v1 = pack(base()); g.install(v1, { approve: g.review(v1).reviewId })
  const v2 = pack(base({ version: '1.1.0', riskTier: 'medium', permissions: { tools: ['Read', 'Write'], paths: ['notes/**'] } }))
  const rev = g.review(v2)
  assert.equal(rev.installedVersion, '1.0.0')
  assert.ok(rev.changes.some((c) => c.includes('Write')))
  assert.ok(rev.changes.some((c) => c.includes('Risk went up')))
  const u = g.install(v2, { approve: rev.reviewId })
  assert.deepEqual([u.ok, u.updatedFrom], [true, '1.0.0'])
  assert.equal(g.list()[0].version, '1.1.0'); assert.equal(g.list()[0].canRollBack, true)
  const rb = g.rollback('demo')
  assert.equal(rb.ok, true)
  assert.equal(g.list()[0].version, '1.0.0')
  assert.equal(g.list()[0].pinned, true, 'a rollback stays put')
  assert.equal(g.rollback('demo').ok, false, 'nothing earlier left')
})

test('a pinned skill is not updated until it is unpinned; older and same versions are refused', () => {
  const g = reg()
  const v1 = pack(base()); g.install(v1, { approve: g.review(v1).reviewId })
  g.pin('demo')
  const v2 = pack(base({ version: '1.0.1' }))
  assert.match(g.install(v2, { approve: g.review(v2).reviewId }).errors[0], /pinned/)
  g.unpin('demo')
  assert.equal(g.install(v2, { approve: g.review(v2).reviewId }).ok, true)
  assert.match(g.install(v1, { approve: g.review(v1).reviewId }).errors[0], /older/)
  assert.match(g.install(v2, { approve: g.review(v2).reviewId }).errors[0], /already installed/)
})

test('only the last few versions are kept for rollback', () => {
  const g = reg()
  for (let i = 0; i < 6; i++) { const d = pack(base({ version: `1.${i}.0` })); assert.ok(g.install(d, { approve: g.review(d).reviewId }).ok) }
  assert.ok(!existsSync(join(g.root, 'demo', '1.0.0')))
  assert.ok(existsSync(join(g.root, 'demo', '1.2.0')))
  assert.equal(g.rollback('demo').ok, true)
  assert.equal(g.list()[0].version, '1.4.0')
})

test('remove deletes the pack; unknown ids are reported', () => {
  const g = reg(); const d = pack(base()); g.install(d, { approve: g.review(d).reviewId })
  assert.equal(g.remove('demo').ok, true)
  assert.deepEqual(g.list(), []); assert.ok(!existsSync(join(g.root, 'demo')))
  for (const f of ['remove', 'pin', 'unpin', 'rollback']) assert.equal(g[f]('nope').ok, false)
})

test('a damaged registry file reads as empty and an edited pack shows as broken', () => {
  const g = reg(); const d = pack(base()); g.install(d, { approve: g.review(d).reviewId })
  writeFileSync(join(g.root, 'demo', '1.0.0', 'skill.json'), '{bad')
  assert.ok(g.list()[0].broken)
  assert.equal(g.get('demo'), null)
  writeFileSync(join(g.root, 'registry.json'), 'not json')
  assert.deepEqual(g.list(), [])
})

test('switches: per-skill off, pause and kill switch', () => {
  const vals = {}
  let frozen = false
  const sw = createSkillSwitches({ read: (k) => vals[k], frozen: () => frozen })
  assert.equal(sw.isOn('demo'), true)
  vals[SKILL_SETTINGS.switches] = 'demo=off,other=on'
  assert.equal(sw.isOn('demo'), false); assert.equal(sw.isOn('other'), true)
  assert.match(sw.state('demo').reason, /switched off/)
  vals[SKILL_SETTINGS.switches] = 'none'; vals[SKILL_SETTINGS.paused] = '1'
  assert.equal(sw.isOn('other'), false)
  vals[SKILL_SETTINGS.paused] = '0'; frozen = true
  assert.match(sw.state('other').reason, /kill switch/)
  const broken = createSkillSwitches({ read: () => undefined, frozen: () => { throw new Error('x') } })
  assert.equal(broken.isOn('demo'), false, 'an unreadable kill switch counts as frozen')
})

test('matchSkill needs the whole phrase and respects switches', () => {
  const skills = [{ manifest: loadSkillDir(pack(base({ triggers: { phrases: ['start demo'] } }))).value }]
  assert.deepEqual(matchSkill(skills, 'Start demo.'), { id: 'demo' })
  assert.equal(matchSkill(skills, 'please do not start demo today'), null)
  const off = createSkillSwitches({ read: () => 'demo=off' })
  assert.equal(matchSkill(skills, 'start demo', off), null)
})

test('resolveSteps fills inputs and holds results to the path grants', () => {
  const m = loadSkillDir(pack(base({
    inputs: { name: { type: 'string', description: 'A file name.' } },
    steps: [{ tool: 'Read', input: { file_path: 'notes/{{input.name}}.md' } }],
  }))).value
  assert.equal(resolveSteps(m, { name: 'x' }).steps[0].input.file_path, 'notes/x.md')
  assert.equal(resolveSteps(m, { name: '../x' }).ok, false)
  assert.equal(resolveSteps(m, { name: 'a/../../x' }).ok, false)
  assert.equal(resolveSteps(m, {}).ok, false)
  assert.equal(resolveSteps(m, { name: 5 }).ok, false)
  assert.equal(resolveSteps(m, { name: 'x', extra: 1 }).ok, false)
})

test('permissionChanges and compareVersions', () => {
  assert.deepEqual(permissionChanges(null, {}), [])
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
})

// ---- the first-party packs ----

const PACKS_DIR = fileURLToPath(new URL('./skills/', import.meta.url))
const packs = listFirstPartyPacks(PACKS_DIR)

test('three first-party packs ship, and each loads cleanly', () => {
  assert.deepEqual(packs.map((p) => p.name), ['daily-journal', 'focus-mode', 'study-buddy'])
  for (const p of packs) {
    const l = loadSkillDir(p.dir, p.name)
    assert.ok(l.ok, l.ok ? '' : l.errors.join('; '))
    assert.equal(l.value.author, 'JARVIS')
  }
})

test('first-party packs install through the review, and install leaves no findings', () => {
  const g = reg()
  for (const p of packs) {
    const r = g.review(p.dir)
    assert.ok(r.ok); assert.deepEqual(r.findings, [], p.name)
    assert.equal(g.install(p.dir, { approve: r.reviewId }).ok, true)
  }
  assert.equal(g.list().length, 3)
})

for (const p of packs) {
  const manifest = loadSkillDir(p.dir, p.name).value
  const cases = JSON.parse(readFileSync(join(p.dir, 'tests.json'), 'utf8'))
  for (const c of cases) {
    test(`${p.name}: "${c.utterance}" ${c.expect.refused ? 'is refused' : 'does what is expected'}`, () => {
      assert.deepEqual(matchSkill([{ manifest }], c.utterance), { id: p.name }, 'the utterance starts the skill')
      const r = resolveSteps(manifest, c.inputs)
      if (c.expect.refused) return assert.equal(r.ok, false)
      assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
      assert.deepEqual(r.steps.map((s) => s.tool), c.expect.tools)
      assert.deepEqual(r.steps.map((s) => s.input.file_path ?? s.input.path), c.expect.files)
    })
  }
}

test('pack steps: reading packs run now, the journal waits for "allow actions"', () => {
  const verdicts = Object.fromEntries(packs.map((p) => [p.name, previewSkill(loadSkillDir(p.dir, p.name).value, policy).map((s) => s.verdict)]))
  assert.deepEqual(verdicts['focus-mode'], ['allow', 'allow'])
  assert.deepEqual(verdicts['study-buddy'], ['allow', 'allow'])
  assert.notEqual(verdicts['daily-journal'][0], 'allow')
  assert.equal(loadSkillDir(packs[0].dir).value.riskTier, 'medium')
})

test('a pack cannot use a tool it did not ask for', () => {
  const m = loadSkillDir(packs.find((p) => p.name === 'focus-mode').dir).value
  const gate = createSkillGate({ manifest: m, policy: createPolicy({ allowWrites: true }) })
  assert.equal(gate.decideTool('Write'), false)
  assert.equal(gate.decideTool('Bash'), false)
})
