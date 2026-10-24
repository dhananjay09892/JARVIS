import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import {
  ACCOUNT, SERVICE, connectorKeychain, createVault, dpapiBackend, macKeychainBackend,
  memoryBackend, pickBackend, secretToolBackend,
} from './secrets.mjs'
import { createCredentialStore } from './connectors/credentials.mjs'

const SECRET = 'sk-test-0123456789abcdefSECRET'
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-secrets-'))

/**
 * A fake OS tool. Records every call and keeps one stored item, "protecting"
 * it with a reversible transform so a test can tell whether plain text leaked.
 */
function fakeTools({ status = 0 } = {}) {
  const calls = []
  let stored = null
  const scramble = (b64) => Buffer.from(b64, 'base64').reverse().toString('base64')
  const run = (cmd, args, input = '') => {
    calls.push({ cmd, args, input })
    if (status !== 0) return { status, stdout: `echo ${input}`, missing: false }
    if (cmd === 'powershell.exe') {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
      // Protect and Unprotect are both the same reversible scramble here.
      if (/::(Protect|Unprotect)\(/.test(script)) return { status: 0, stdout: scramble(input.trim()), missing: false }
    }
    if (cmd === 'secret-tool') {
      if (args[0] === '--version') return { status: 0, stdout: 'secret-tool 0.21', missing: false }
      if (args[0] === 'store') { stored = input; return { status: 0, stdout: '', missing: false } }
      if (args[0] === 'lookup') return stored ? { status: 0, stdout: `${stored}\n`, missing: false } : { status: 1, stdout: '', missing: false }
      if (args[0] === 'clear') { stored = null; return { status: 0, stdout: '', missing: false } }
    }
    if (cmd === 'security') {
      if (args[0] === '-i') {
        const hex = /-X ([0-9a-f]+)/.exec(input)[1]
        stored = Buffer.from(hex, 'hex').toString('utf8')
        return { status: 0, stdout: '', missing: false }
      }
      if (args[0] === 'find-generic-password') return stored ? { status: 0, stdout: `${stored}\n`, missing: false } : { status: 44, stdout: '', missing: false }
      if (args[0] === 'delete-generic-password') { stored = null; return { status: 0, stdout: '', missing: false } }
    }
    return { status: 127, stdout: '', missing: true }
  }
  return { run, calls, stored: () => stored }
}

/** The secret must never be on any command line, in any form we write. */
function assertNotOnCommandLines(calls) {
  const b64 = Buffer.from(SECRET).toString('base64')
  for (const c of calls) {
    const line = c.args.join(' ')
    const decoded = c.cmd === 'powershell.exe' ? Buffer.from(c.args.at(-1), 'base64').toString('utf16le') : ''
    for (const text of [line, decoded]) {
      assert.equal(text.includes(SECRET), false, `${c.cmd} got the secret on its command line`)
      assert.equal(text.includes(b64), false, `${c.cmd} got the encoded secret on its command line`)
    }
  }
}

test('vault: set, get, delete, names, reload; values never in JSON or inspect', () => {
  const backend = memoryBackend()
  const v = createVault(backend)
  assert.equal(v.available, true)
  assert.equal(v.get('settings/A'), null)
  v.set('settings/A', SECRET)
  v.set('connector/gmail/token', 'tok-12345678')
  assert.equal(v.get('settings/A'), SECRET)
  assert.deepEqual(v.names('connector/'), ['connector/gmail/token'])
  const again = createVault(backend)
  assert.equal(again.get('settings/A'), SECRET, 'a new vault reads what the backend kept')
  assert.equal(JSON.stringify(v).includes(SECRET), false)
  assert.equal(inspect(v).includes(SECRET), false)
  v.delete('settings/A')
  v.delete('settings/A') // deleting twice is fine
  again.reload()
  assert.equal(again.get('settings/A'), null)
  v.delete('connector/gmail/token')
  assert.equal(backend.load(), null, 'an empty vault is cleared from the OS, not saved as {}')
  assert.throws(() => v.set('bad name!', 'x'), /Bad secret name/)
  assert.throws(() => v.set('settings/A', ''), /non-empty/)
  assert.throws(() => v.set('settings/A', 'x'.repeat(20_000)), /too long/)
})

test('vault without a backend reads nothing and refuses to save, never falling back to plain text', () => {
  const v = createVault(null)
  assert.equal(v.available, false)
  assert.equal(v.backend, 'unavailable')
  assert.equal(v.get('settings/A'), null)
  assert.deepEqual(v.names(), [])
  assert.throws(() => v.set('settings/A', SECRET), /No secure storage/)
  assert.doesNotThrow(() => v.delete('settings/A'))
})

test('an unreadable vault is reported without quoting its contents', () => {
  const v = createVault({ name: 'memory', label: 'x', load: () => `not json ${SECRET}`, save() {}, clear() {} })
  assert.throws(() => v.get('settings/A'), (err) => !err.message.includes(SECRET) && /unreadable/.test(err.message))
})

test('Windows: DPAPI keeps only ciphertext on disk and never puts the secret on a command line', () => {
  const dir = tmp()
  const file = join(dir, 'secrets.dpapi')
  const tools = fakeTools()
  const v = createVault(dpapiBackend({ file, run: tools.run }))
  v.set('settings/ELEVENLABS_API_KEY', SECRET)
  assert.ok(existsSync(file))
  const disk = readFileSync(file, 'utf8')
  assert.equal(disk.includes(SECRET), false)
  assert.equal(Buffer.from(disk, 'base64').toString('utf8').includes(SECRET), false)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(existsSync(`${file}.tmp`), false)
  const reopened = createVault(dpapiBackend({ file, run: tools.run }))
  assert.equal(reopened.get('settings/ELEVENLABS_API_KEY'), SECRET)
  // The script uses CurrentUser scope with our entropy, reads stdin, and is passed encoded.
  const script = Buffer.from(tools.calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /DataProtectionScope\]::CurrentUser/)
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/)
  assert.deepEqual(tools.calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assertNotOnCommandLines(tools.calls)
  reopened.delete('settings/ELEVENLABS_API_KEY')
  assert.equal(existsSync(file), false)
})

test('Windows: a DPAPI failure names the exit code, not the data', () => {
  const dir = tmp()
  const tools = fakeTools({ status: 1 })
  const v = createVault(dpapiBackend({ file: join(dir, 'secrets.dpapi'), run: tools.run }))
  assert.throws(() => v.set('settings/A', SECRET), (err) => /dpapi: exit code 1/.test(err.message) && !err.message.includes(SECRET))
  assert.equal(existsSync(join(dir, 'secrets.dpapi')), false)
})

test('Linux: secret-tool gets the vault on stdin under service/account attributes', () => {
  const tools = fakeTools()
  const v = createVault(secretToolBackend({ run: tools.run }))
  v.set('settings/A', SECRET)
  const store = tools.calls.find((c) => c.args[0] === 'store')
  assert.deepEqual(store.args.slice(-4), ['service', SERVICE, 'account', ACCOUNT])
  assert.equal(createVault(secretToolBackend({ run: tools.run })).get('settings/A'), SECRET)
  assertNotOnCommandLines(tools.calls)
  v.delete('settings/A')
  assert.equal(tools.stored(), null)
})

test('macOS: the Keychain item is written through security -i on stdin, hex-encoded', () => {
  const tools = fakeTools()
  const v = createVault(macKeychainBackend({ run: tools.run }))
  assert.equal(v.get('settings/A'), null, 'item not found (44) is an empty vault')
  v.set('settings/A', SECRET)
  const add = tools.calls.find((c) => c.args[0] === '-i')
  assert.deepEqual(add.args, ['-i'])
  assert.equal(add.input.includes(SECRET), false, 'even stdin carries it encoded')
  assert.equal(createVault(macKeychainBackend({ run: tools.run })).get('settings/A'), SECRET)
  assertNotOnCommandLines(tools.calls)
})

test('pickBackend: DPAPI on Windows, Keychain on macOS, secret-tool on Linux only if installed', () => {
  const tools = fakeTools()
  assert.equal(pickBackend({ platform: 'win32', file: 'x', run: tools.run }).name, 'dpapi')
  assert.equal(pickBackend({ platform: 'darwin', file: 'x', run: tools.run }).name, 'macos-keychain')
  assert.equal(pickBackend({ platform: 'linux', file: 'x', run: tools.run }).name, 'secret-service')
  const none = () => ({ status: null, stdout: '', missing: true })
  assert.equal(pickBackend({ platform: 'linux', file: 'x', run: none }), null)
})

test('connector credentials use the vault as their keychain, one connector per prefix', () => {
  const v = createVault(memoryBackend())
  const store = createCredentialStore({ keychain: connectorKeychain(v), env: {} })
  assert.equal(store.backend, 'keychain')
  store.set('gmail', 'refresh_token', 'gmail-token-123456')
  store.set('notion', 'api_token', 'notion-token-123456')
  assert.equal(v.get('connector/gmail/refresh_token'), 'gmail-token-123456')
  assert.deepEqual(store.describe('gmail').keys, [{ key: 'refresh_token', set: true }])
  assert.equal(store.scoped('gmail').get('api_token'), null, 'one connector cannot read another\'s token')
  store.deleteAll('gmail')
  assert.deepEqual(v.names(), ['connector/notion/api_token'])
})
