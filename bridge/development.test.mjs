import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedCommand } from './development.mjs'

const files = { directory: async (path) => {
  if (path !== 'repo') throw new Error('Path escapes the workspace.')
  return 'C:\\workspace\\repo'
} }
const env = { SystemRoot: 'C:\\Windows', PATH: 'tools', ANTHROPIC_API_KEY: 'private-test-value' }

test('command rejection and invalid working directories cannot execute', async () => {
  let executed = false
  const execute = () => { executed = true }
  await assert.rejects(approvedCommand({ cwd: 'repo', command: 'git push origin main' },
    async () => false, { files, env, execute }), /not approved/)
  await assert.rejects(approvedCommand({ cwd: '..', command: 'npm test' },
    async () => true, { files, env, execute }), /escapes/)
  assert.equal(executed, false)
})

test('approval binds the exact command and cwd; shell and bridge secrets are excluded', async () => {
  let executions = 0
  const command = 'git push origin feature'
  const result = await approvedCommand({ cwd: 'repo', command }, async (title, details) => {
    assert.equal(title, 'Run Windows command')
    assert.ok(details.includes('C:\\workspace\\repo'))
    assert.ok(details.endsWith(command))
    return true
  }, { files, env, execute: (executable, args, options, callback) => {
    executions++
    assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.ok(args.at(-1).includes(command))
    assert.equal(options.shell, false)
    assert.equal(options.cwd, 'C:\\workspace\\repo')
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
    callback(null, 'done', '')
  } })
  assert.equal(executions, 1)
  assert.equal(result.stdout, 'done')
})

test('approval errors and execution errors propagate rather than claiming success', async () => {
  await assert.rejects(approvedCommand({ cwd: 'repo', command: 'npm test' },
    async () => { throw new Error('disconnected') }, { files, env }), /disconnected/)
  await assert.rejects(approvedCommand({ cwd: 'repo', command: 'npm test' },
    async () => true, { files, env, execute: (_exe, _args, _options, callback) =>
      callback(Object.assign(new Error('failed'), { code: 1 }), '', 'test failed') }), /test failed/)
})

test('Windows execution returns real output and nonzero native exits fail', { skip: process.platform !== 'win32' }, async () => {
  const options = { files: { directory: async () => process.cwd() } }
  const result = await approvedCommand({ cwd: '.', command: '[Console]::Write("jarvis-command-test")' }, async () => true, options)
  assert.equal(result.stdout, 'jarvis-command-test')
  await assert.rejects(approvedCommand({ cwd: '.', command: 'cmd.exe /c exit 7' }, async () => true, options), /Command failed \(7\)/)
})
