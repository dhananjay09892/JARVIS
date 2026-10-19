import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink, link, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceFiles } from './workspace.mjs'

test('workspace files are scoped and edits require a matching version', async () => {
  // realpath: some runners hand out 8.3 short temp paths (RUNNER~1) that the code resolves to long ones.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'jarvis-workspace-test-')))
  const root = join(temporary, 'workspace')
  const outside = join(temporary, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const files = workspaceFiles(root)
  try {
    await files.write('src\\hello.txt', 'hello')
    const read = await files.read('src\\hello.txt')
    assert.equal(read.content, 'hello')
    assert.equal(read.sha256.length, 64)
    await assert.rejects(files.write('src\\hello.txt', 'overwrite'), /EEXIST/)
    await files.write('src\\hello.txt', 'hi', read.sha256)
    assert.equal((await files.read('src\\hello.txt')).content, 'hi')
    await assert.rejects(files.write('src\\hello.txt', 'stale', read.sha256), /File changed/)
    assert.deepEqual(await files.list(), [{ name: 'src', kind: 'directory' }])
    for (const path of ['..\\outside\\escape.txt', 'C:\\escape.txt', '.git\\config', '.ENV.local', 'file.txt:stream', 'NUL.txt', 'folder.\\file']) {
      await assert.rejects(files.write(path, 'bad'), /relative workspace path/)
    }
    await assert.rejects(files.write('huge.txt', 'a'.repeat(256 * 1024 + 1)), /256 KiB/)
    await files.write('empty.txt', '')
    assert.equal((await files.read('empty.txt')).content, '')
    await writeFile(join(outside, 'private.txt'), 'outside')
    await symlink(outside, join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(files.read('junction\\private.txt'), /links and junctions/)
    await assert.rejects(files.write('junction\\new.txt', 'bad'), /links and junctions/)
    await link(join(outside, 'private.txt'), join(root, 'hard.txt'))
    await assert.rejects(files.read('hard.txt'), /hard-linked/)
    await assert.rejects(files.write('hard.txt', 'bad', read.sha256), /hard-linked/)
    assert.equal(await files.directory('src'), join(root, 'src'))
    await assert.rejects(files.directory('..\\outside'), /relative workspace path/)
    const current = await files.read('src\\hello.txt')
    await assert.rejects(files.delete('src\\hello.txt', read.sha256), /File changed/)
    await assert.rejects(files.delete('hard.txt', current.sha256), /ordinary text files/)
    await assert.rejects(files.delete('src', current.sha256), /ordinary text files/)
    await files.delete('src\\hello.txt', current.sha256)
    await assert.rejects(files.read('src\\hello.txt'), /ENOENT/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
