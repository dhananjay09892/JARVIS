import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSkillScript, checkCallArguments, pathAllowed, hostAllowed, readSkillScript } from './skill-sandbox.mjs'
import { checkSkillManifest } from './skill-manifest.mjs'
import { createPolicy } from './policy.mjs'

const manifest = (over = {}) => {
  const r = checkSkillManifest({
    id: 'scripted', name: 'Scripted', version: '1.0.0', author: 'Test', description: 'A scripted skill.',
    riskTier: 'medium', script: 'main.js', dataUse: 'Reads notes on this computer.',
    permissions: { tools: ['Read', 'WebFetch'], paths: ['notes/**', 'todo.md'], domains: ['example.com', '*.example.org'] },
    ...over,
  })
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  return r.value
}
const policy = () => createPolicy({ allowWrites: false })
const run = (source, extra = {}) => runSkillScript({ manifest: manifest(), source, policy: policy(), invokeTool: async (t, i) => ({ tool: t, input: i }), ...extra })

test('a script gets its input and returns JSON', async () => {
  const r = await run('return { double: input.n * 2 }', { input: { n: 21 } })
  assert.deepEqual(r, { ok: true, value: { double: 42 }, calls: 0 })
})

test('a granted tool call inside the allow-lists reaches the host', async () => {
  const seen = []
  const r = await run('return await call("Read", { file_path: "notes/today.md" })', {
    invokeTool: async (t, i) => { seen.push([t, i]); return 'file text' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.value, 'file text')
  assert.deepEqual(seen, [['Read', { file_path: 'notes/today.md' }]])
})

test('a tool outside the grants is refused and never reaches the host', async () => {
  let reached = false
  const r = await run('try { await call("Bash", { command: "dir" }) } catch (e) { return e.message }', { invokeTool: async () => { reached = true } })
  assert.equal(reached, false)
  assert.match(r.value, /did not ask for this tool/)
})

test('a granted tool is still decided by the policy engine', async () => {
  const gated = { decide: () => ({ verdict: 'deny', rule: 'kill-switch', reason: 'stopped' }) }
  let reached = false
  const r = await run('try { await call("Read", { file_path: "todo.md" }) } catch (e) { return e.message }', { policy: gated, invokeTool: async () => { reached = true } })
  assert.equal(reached, false)
  assert.equal(r.value, 'stopped')
})

test('file arguments outside the path list are refused', async () => {
  for (const bad of ['../secrets.txt', '/etc/passwd', 'C:\\\\Windows\\\\win.ini', 'notes/../../x', 'other/file.md', '~/x']) {
    const r = await run(`try { await call("Read", { file_path: ${JSON.stringify(bad)} }); return "ran" } catch (e) { return e.message }`)
    assert.match(r.value, /outside the folders/, bad)
  }
})

test('web addresses must be http(s) to a listed host', async () => {
  const t = (url) => run(`try { await call("WebFetch", { url: ${JSON.stringify(url)} }); return "ran" } catch (e) { return e.message }`).then((r) => r.value)
  assert.equal(await t('https://example.com/a'), 'ran')
  assert.equal(await t('https://x.example.org/a'), 'ran')
  assert.match(await t('https://evil.test/a'), /not a website/)
  assert.match(await t('https://example.com.evil.test/'), /not a website/)
  assert.match(await t('https://example.org/'), /not a website/)
  assert.match(await t('file:///etc/passwd'), /http or https/)
  assert.match(await t('https://user:pw@example.com/'), /login/)
  assert.match(await t('nonsense'), /not a web address/)
})

test('path and host matching', () => {
  assert.ok(pathAllowed('notes/a/b.md', ['notes/**']))
  assert.ok(pathAllowed('todo.md', ['todo.md']))
  assert.ok(!pathAllowed('notes', ['notes/**']))
  assert.ok(!pathAllowed('notesx/a', ['notes/**']))
  assert.ok(pathAllowed('notes/a.md', ['notes/*.md']))
  assert.ok(!pathAllowed('notes/a/b.md', ['notes/*.md']))
  assert.ok(hostAllowed('a.example.org', ['*.example.org']))
  assert.ok(!hostAllowed('example.org', ['*.example.org']))
  assert.equal(checkCallArguments(manifest(), { url: 'https://example.com', nested: { path: '../x' } }), 'path is outside the folders this skill may use')
})

test('a script that runs past the deadline is killed', async () => {
  const t0 = Date.now()
  const r = await run('while (true) {}', { timeoutMs: 400 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'timeout')
  assert.ok(Date.now() - t0 < 5000)
})

test('a script that waits forever on a slow tool is stopped at the deadline', async () => {
  const r = await run('return await call("Read", { file_path: "todo.md" })', { timeoutMs: 300, invokeTool: () => new Promise(() => {}) })
  assert.equal(r.reason, 'timeout')
})

test('a loop of tool calls stops at the call limit', async () => {
  let n = 0
  const r = await run('while (true) await call("Read", { file_path: "todo.md" })', { maxCalls: 5, invokeTool: async () => { n++; return 1 } })
  assert.equal(r.reason, 'call-limit')
  assert.equal(n, 5)
})

test('a burst of parallel calls is counted too', async () => {
  const r = await run('await Promise.all(Array.from({ length: 1000 }, () => call("Read", { file_path: "todo.md" })))', { maxCalls: 10 })
  assert.equal(r.reason, 'call-limit')
})

test('a huge answer is refused', async () => {
  const r = await run('return "x".repeat(100000)')
  assert.equal(r.reason, 'output-too-large')
})

test('a huge tool result is not handed to the script', async () => {
  const r = await run('try { await call("Read", { file_path: "todo.md" }) } catch (e) { return e.message }', { invokeTool: async () => 'y'.repeat(200000) })
  assert.match(r.value, /too large/)
})

test('a throwing script reports a short error; a tool error is passed on as text', async () => {
  const a = await run('throw new Error("boom")')
  assert.deepEqual([a.ok, a.reason, a.error], [false, 'script-error', 'boom'])
  const b = await run('try { await call("Read", { file_path: "todo.md" }) } catch (e) { return e.message }', { invokeTool: async () => { throw new Error('disk gone') } })
  assert.equal(b.value, 'disk gone')
})

test('with no host, every call is refused', async () => {
  const r = await runSkillScript({ manifest: manifest(), source: 'try { await call("Read", { file_path: "todo.md" }) } catch (e) { return e.message }', policy: policy() })
  assert.match(r.value, /not available/)
})

test('audit events record allowed and refused calls', async () => {
  const events = []
  await run('try { await call("Bash", {}) } catch {} ; await call("Read", { file_path: "todo.md" })', { onEvent: (e) => events.push(e) })
  assert.deepEqual(events.map((e) => [e.tool, e.verdict, e.rule]), [['Bash', 'deny', 'skill-ungranted'], ['Read', 'allow', undefined]])
})

test('invalid runs are rejected before anything starts', async () => {
  const r = await runSkillScript({ manifest: null, source: 'return 1', policy: policy() })
  assert.equal(r.reason, 'invalid')
  const c = {}; c.c = c
  const s = await run('return 1', { input: c })
  assert.equal(s.reason, 'invalid')
})

test('the manifest accepts a script and refuses a low-risk or malformed one', () => {
  const base = { id: 's', name: 'S', version: '1.0.0', author: 'A', description: 'd', dataUse: 'none', riskTier: 'medium', script: 'main.js' }
  assert.equal(checkSkillManifest(base).ok, true)
  assert.match(checkSkillManifest({ ...base, riskTier: 'low' }).errors.join(), /script cannot be low risk/)
  assert.match(checkSkillManifest({ ...base, script: '../main.js' }).errors.join(), /script:/)
  assert.match(checkSkillManifest({ ...base, script: 'main.sh' }).errors.join(), /script:/)
  assert.match(checkSkillManifest({ ...base, script: undefined }).errors.join(), /steps/)
})

test('readSkillScript reads a plain file inside the folder only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'))
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'main.js'), 'return 1')
    writeFileSync(join(dir, 'outside.js'), 'return 2')
    const m = manifest()
    assert.deepEqual(readSkillScript(dir, m), { ok: true, source: 'return 1' })
    assert.match(readSkillScript(dir, { ...m, script: 'nope.js' }).error, /missing/)
    assert.match(readSkillScript(dir, { ...m, script: undefined }).error, /no script/)
    const other = mkdtempSync(join(tmpdir(), 'skill-out-'))
    writeFileSync(join(other, 'secret.js'), 'return "s"')
    try {
      symlinkSync(join(other, 'secret.js'), join(dir, 'link.js'))
      assert.match(readSkillScript(dir, { ...m, script: 'link.js' }).error, /plain file/)
    } catch (e) { if (e.code !== 'EPERM') throw e } finally { rmSync(other, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
