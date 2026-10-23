import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import {
  createCredentialStore, createMemoryCredentialStore, createDevFileCredentialStore,
  defaultDevCredentialFile, isInside, REPO_ROOT,
} from './credentials.mjs'

test('memory store: set, get, describe without values, delete, deleteAll', () => {
  const s = createMemoryCredentialStore()
  s.set('notion', 'api_token', 'secret-1')
  s.set('notion', 'workspace', 'w')
  assert.equal(s.get('notion', 'api_token'), 'secret-1')
  assert.equal(s.get('gmail', 'api_token'), null)
  assert.deepEqual(s.describe('notion'), { backend: 'memory', keys: [{ key: 'api_token', set: true }, { key: 'workspace', set: true }] })
  s.delete('notion', 'workspace')
  s.deleteAll('notion')
  assert.deepEqual(s.describe('notion').keys, [])
  assert.ok(!JSON.stringify(s).includes('secret'))
  assert.ok(!inspect(s).includes('secret'))
})

test('ids, names and values are checked', () => {
  const s = createMemoryCredentialStore()
  assert.throws(() => s.set('Bad', 'k', 'v'), /connector id/)
  assert.throws(() => s.set('ok', '../k', 'v'), /credential name/)
  assert.throws(() => s.set('ok', 'k', ''), /non-empty/)
  assert.throws(() => s.set('ok', 'k', 'x'.repeat(20_000)), /too long/)
})

test('without the keychain or an opt-in, nothing can be stored', () => {
  const s = createCredentialStore({ env: {} })
  assert.equal(s.backend, 'unavailable')
  assert.throws(() => s.set('notion', 'api_token', 'x'), /Q20/)
  assert.equal(s.get('notion', 'api_token'), null)
})

test('a keychain backend wins when there is one', () => {
  const data = new Map()
  const keychain = {
    get: (id, k) => data.get(`${id}/${k}`),
    set: (id, k, v) => data.set(`${id}/${k}`, v),
    delete: (id, k) => data.delete(`${id}/${k}`),
    keys: (id) => [...data.keys()].filter((x) => x.startsWith(`${id}/`)).map((x) => x.split('/')[1]),
  }
  const s = createCredentialStore({ keychain, env: { JARVIS_DEV_CREDENTIALS: '1' } })
  assert.equal(s.backend, 'keychain')
  s.set('notion', 'api_token', 'k')
  assert.equal(s.get('notion', 'api_token'), 'k')
  assert.throws(() => createCredentialStore({ keychain: { get() {} } }), /needs set/)
})

test('dev-only file store: outside the repo, mode 0600, clearly marked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-creds-'))
  const file = join(dir, 'nested', 'DEV-ONLY-connector-credentials.json')
  const s = createCredentialStore({ env: { JARVIS_DEV_CREDENTIALS: '1', JARVIS_DEV_CREDENTIALS_FILE: file } })
  assert.equal(s.backend, 'dev-file')
  s.set('notion', 'api_token', 'dev-secret')
  assert.equal(s.get('notion', 'api_token'), 'dev-secret')
  const body = JSON.parse(readFileSync(file, 'utf8'))
  assert.match(body.warning, /DEV-ONLY/)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  s.deleteAll('notion')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).connectors, {})
  assert.equal(existsSync(`${file}.tmp`), false)
})

test('dev-only file store refuses a path inside the repository', () => {
  assert.throws(() => createDevFileCredentialStore({ file: join(REPO_ROOT, 'creds.json') }), /outside the repository/)
  assert.throws(
    () => createCredentialStore({ env: { JARVIS_DEV_CREDENTIALS: '1', JARVIS_DEV_CREDENTIALS_FILE: join(REPO_ROOT, 'bridge', 'x.json') } }),
    /outside the repository/,
  )
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

test('a damaged dev file reads as empty without quoting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-creds-'))
  const file = join(dir, 'c.json')
  const s = createDevFileCredentialStore({ file })
  s.set('notion', 'api_token', 'v')
  writeFileSync(file, '{not json "api_token": "v"')
  assert.equal(s.get('notion', 'api_token'), null)
  assert.deepEqual(s.describe('notion').keys, [])
})

test('default dev file sits under the JARVIS home, not the repo', () => {
  const f = defaultDevCredentialFile({ JARVIS_HOME: '/home/u/.jarvis' })
  assert.equal(f, join('/home/u/.jarvis', 'DEV-ONLY-connector-credentials.json'))
  assert.equal(isInside(REPO_ROOT, defaultDevCredentialFile({})), false)
})
