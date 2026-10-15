import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { applicationPaths, launchApplication } from './apps.mjs'

const env = { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' }

test('only approved applications resolve to fixed executable paths', () => {
  for (const app of ['vscode', 'chrome', 'notepad', 'calculator']) {
    assert.ok(applicationPaths(app, env).every((path) => path.endsWith('.exe')))
  }
  assert.throws(() => applicationPaths('powershell', env), /not approved/)
  assert.throws(() => applicationPaths('chrome --remote-debugging-port=9222', env), /not approved/)
})

test('launch uses no shell and no user-supplied arguments', async () => {
  let released = false
  const result = await launchApplication('vscode', {
    platform: 'win32', env, exists: () => true,
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, applicationPaths('vscode', env)[0])
      assert.deepEqual(args, [])
      assert.equal(options.shell, false)
      const child = new EventEmitter()
      child.unref = () => { released = true }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  assert.ok(released)
  assert.match(result, /does not verify/)
})

test('missing installations and unsupported platforms report errors', async () => {
  await assert.rejects(launchApplication('chrome', {
    platform: 'win32', env, exists: () => false,
  }), /not found/)
  await assert.rejects(launchApplication('notepad', { platform: 'linux' }), /requires Windows/)
})

test('OS launch failures reject rather than report success', async () => {
  await assert.rejects(launchApplication('notepad', {
    platform: 'win32', env, exists: () => true,
    spawnProcess: () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('Access denied')))
      return child
    },
  }), /Access denied/)
})
