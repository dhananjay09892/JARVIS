import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillHost } from './skill-host.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'skill-host-'))
  const root = join(dir, 'files')
  mkdirSync(root)
  return { dir, root, host: createSkillHost({ root }), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('writes and reads inside the folder, and greps a file', () => {
  const s = setup()
  s.host.tools.Write({ file_path: 'journal/2026-11-21.md', content: 'Q: one\nA: x\nQ: two' })
  assert.equal(readFileSync(join(s.root, 'journal/2026-11-21.md'), 'utf8').startsWith('Q: one'), true)
  assert.match(s.host.tools.Read({ file_path: 'journal/2026-11-21.md' }), /A: x/)
  assert.equal(s.host.tools.Grep({ pattern: '^Q:', path: 'journal/2026-11-21.md' }), 'Q: one\nQ: two')
  s.done()
})

test('absolute paths, .. and NUL are refused', () => {
  const s = setup()
  for (const p of ['/etc/passwd', '../x', 'a/../../x', 'a\0b', '', 'C:\\Windows\\x']) {
    assert.throws(() => s.host.tools.Read({ file_path: p }), /not allowed|does not exist/, p)
    assert.throws(() => s.host.tools.Write({ file_path: p, content: 'x' }), /not allowed/, p)
  }
  s.done()
})

test('a link that points outside the folder is refused for read and write', () => {
  const s = setup()
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  try { symlinkSync(outside, join(s.root, 'link')) } catch { s.done(); return }
  assert.throws(() => s.host.tools.Read({ file_path: 'link/secret.txt' }), /not allowed/)
  assert.throws(() => s.host.tools.Write({ file_path: 'link/new.txt', content: 'x' }), /not allowed/)
  assert.equal(existsSync(join(outside, 'new.txt')), false)
  s.done()
})

test('limits: bad patterns, large content, missing files', () => {
  const s = setup()
  assert.throws(() => s.host.tools.Grep({ pattern: '(', path: 'a' }), /not valid/)
  assert.throws(() => s.host.tools.Write({ file_path: 'a', content: 'x'.repeat(70_000) }), /too large/)
  assert.throws(() => s.host.tools.Read({ file_path: 'nope.md' }), /does not exist/)
  s.done()
})
