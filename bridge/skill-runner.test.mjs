import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillRegistry, createSkillSwitches, listFirstPartyPacks } from './skill-registry.mjs'
import { createSkillRunner } from './skill-runner.mjs'
import { createSkillRoutes } from './skill-routes.mjs'
import { createPolicy } from './policy.mjs'

const PACKS = fileURLToPath(new URL('./skills/', import.meta.url))
const quiet = { warn() {}, log() {}, error() {} }

function setup({ allowWrites = false, frozen = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-run-'))
  const policy = createPolicy({ allowWrites, isFrozen: () => frozen })
  const registry = createSkillRegistry({ root: join(root, 'skills'), policy })
  const values = {}
  const state = { frozen, audit: [], calls: [], saves: [] }
  const switches = createSkillSwitches({ read: (k) => values[k], frozen: () => state.frozen })
  const tools = {
    Read: (i) => { state.calls.push(['Read', i.file_path]); return `contents of ${i.file_path}` },
    Write: (i) => { state.calls.push(['Write', i.file_path]); return 'ok' },
    Grep: (i) => { state.calls.push(['Grep', i.path ?? i.file_path]); return 'match' },
  }
  const runner = createSkillRunner({ registry, switches, policy, tools, audit: (e) => state.audit.push(e), log: quiet })
  const routes = createSkillRoutes({
    registry, switches, packsDir: PACKS, read: (k) => values[k],
    saveSettings: (p) => { state.saves.push(p); Object.assign(values, p) },
    gate: () => (state.frozen ? 'JARVIS is frozen.' : null), stats: runner.stats,
  })
  const call = (method, path, body) => routes.handle({ method, path, body })
  const install = (name) => {
    const rv = call('POST', '/skills/review', { pack: name }).body
    return call('POST', '/skills/install', { pack: name, approve: rv.reviewId })
  }
  return { root, registry, runner, routes, call, install, state, values, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('review then install a first-party pack from the routes, then it is listed', () => {
  const s = setup()
  const rv = s.call('POST', '/skills/review', { pack: 'focus-mode' })
  assert.equal(rv.status, 200)
  assert.match(rv.body.reviewId, /^[0-9a-f]{64}$/)
  assert.equal(s.call('POST', '/skills/install', { pack: 'focus-mode' }).status, 400, 'no approval, no install')
  assert.equal(s.install('focus-mode').status, 200)
  const list = s.call('GET', '/skills').body
  assert.equal(list.installed[0].id, 'focus-mode')
  assert.equal(list.installed[0].on, true)
  assert.equal(list.packs.find((p) => p.name === 'focus-mode').installedVersion, '1.0.0')
  assert.equal(list.packs.length, 3)
  s.done()
})

test('the page can only name a first-party pack, never a folder', () => {
  const s = setup()
  for (const pack of ['../x', '/etc', 'nope', 7, undefined]) assert.equal(s.call('POST', '/skills/review', { pack }).status, 404)
  s.done()
})

test('saying the phrase runs the read-only pack through the policy and tools', async () => {
  const s = setup()
  s.install('focus-mode')
  const m = s.runner.match('Start focus mode!')
  assert.deepEqual(m, { id: 'focus-mode' })
  const r = await s.runner.run(m.id)
  assert.equal(r.ok, true)
  assert.deepEqual(r.steps.map((x) => x.status), ['ran', 'ran'])
  assert.deepEqual(s.state.calls, [['Read', 'notes/today.md'], ['Read', 'notes/tasks.md']])
  assert.ok(s.state.audit.some((e) => e.type === 'result'), 'results are audited')
  assert.equal(s.runner.stats().runs, 1)
  s.done()
})

test('a write step waits while allow actions is off and runs when it is on', async () => {
  const off = setup({ allowWrites: false })
  off.install('daily-journal')
  const w = await off.runner.run('daily-journal', { date: '2026-11-21', entry: 'hello' })
  assert.equal(w.ok, false)
  assert.equal(w.steps[0].status, 'waiting')
  assert.match(w.steps[0].reason, /allow actions/)
  assert.deepEqual(off.state.calls, [], 'the write never ran')
  assert.equal(off.runner.stats().waiting, 1)
  off.done()

  const on = setup({ allowWrites: true })
  on.install('daily-journal')
  const r = await on.runner.run('daily-journal', { date: '2026-11-21', entry: 'hello' })
  assert.equal(r.ok, true)
  assert.deepEqual(on.state.calls, [['Write', 'journal/2026-11-21.md']])
  on.done()
})

test('missing inputs are asked for, nothing runs', async () => {
  const s = setup({ allowWrites: true })
  s.install('daily-journal')
  const r = await s.runner.run('daily-journal', {})
  assert.deepEqual(r.needsInput.sort(), ['date', 'entry'])
  assert.deepEqual(s.state.calls, [])
  s.done()
})

test('switch off, pause all and kill switch each stop a skill; the router saves the switch', async () => {
  const s = setup()
  s.install('focus-mode')
  assert.equal(s.call('POST', '/skills/focus-mode/enabled', { enabled: false }).status, 200)
  assert.equal(s.values.JARVIS_SKILL_SWITCHES, 'focus-mode=off')
  assert.equal(s.runner.match('focus mode'), null, 'a switched-off skill does not match')
  const blocked = await s.runner.run('focus-mode')
  assert.equal(blocked.blocked, true)
  s.call('POST', '/skills/focus-mode/enabled', { enabled: true })
  assert.equal(s.values.JARVIS_SKILL_SWITCHES, 'none')
  s.call('POST', '/skills/paused', { paused: true })
  assert.equal((await s.runner.run('focus-mode')).blocked, true)
  assert.equal(s.call('GET', '/skills').body.paused, true)
  s.call('POST', '/skills/paused', { paused: false })
  assert.equal((await s.runner.run('focus-mode')).ok, true)
  s.state.frozen = true
  assert.equal((await s.runner.run('focus-mode')).blocked, true)
  assert.equal(s.call('POST', '/skills/focus-mode/pin').status, 423, 'no changes while frozen')
  s.done()
})

test('pin, roll back and remove through the routes', () => {
  const s = setup()
  s.install('focus-mode')
  assert.equal(s.call('POST', '/skills/focus-mode/pin').body.snapshot.installed[0].pinned, true)
  assert.equal(s.call('POST', '/skills/focus-mode/unpin').body.snapshot.installed[0].pinned, false)
  assert.equal(s.call('POST', '/skills/focus-mode/rollback').status, 400, 'nothing earlier')
  assert.equal(s.call('POST', '/skills/focus-mode/remove', {}).status, 400, 'needs confirm')
  assert.equal(s.call('POST', '/skills/focus-mode/remove', { confirm: true }).body.snapshot.installed.length, 0)
  assert.equal(s.call('POST', '/skills/ghost/pin').status, 404)
  s.done()
})

test('a skill cannot use a tool it did not ask for, even if its steps are edited on disk', async () => {
  const s = setup({ allowWrites: true })
  s.install('focus-mode')
  const dir = s.registry.get('focus-mode').dir
  const j = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'skill.json'), 'utf8'))
  j.steps = [{ tool: 'Write', input: { file_path: 'notes/x.md', content: 'x' } }]
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(j))
  const r = await s.runner.run('focus-mode')
  assert.equal(r.ok, false)
  assert.deepEqual(s.state.calls, [])
  s.done()
})

test('every first-party pack passes its test utterances end to end', async () => {
  const { readFileSync } = await import('node:fs')
  for (const p of listFirstPartyPacks(PACKS)) {
    const s = setup({ allowWrites: true })
    s.install(p.name)
    for (const t of JSON.parse(readFileSync(join(p.dir, 'tests.json'), 'utf8'))) {
      const m = s.runner.match(t.utterance)
      assert.equal(m?.id, p.name, `${p.name}: "${t.utterance}" matches`)
      s.state.calls.length = 0
      const r = await s.runner.run(m.id, t.inputs)
      if (t.expect.refused) {
        assert.equal(r.ok, false, `${p.name}: refused`)
        assert.deepEqual(s.state.calls, [])
        continue
      }
      assert.equal(r.ok, true, `${p.name}: runs`)
      assert.deepEqual(s.state.calls.map((c) => c[0]), t.expect.tools)
      assert.deepEqual(s.state.calls.map((c) => c[1]), t.expect.files)
    }
    s.done()
  }
})
