import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-registry-'))
const { REGISTRY, SECTIONS, checkRegistry, isValid, settingDef, settingDefault, settingsSchema } =
  await import('./settings-registry.mjs')
const { updateSettings, publicSettings, setting, useSecretVault } = await import('./settings.mjs')
const { createVault, memoryBackend } = await import('./secrets.mjs')
// Secrets go to the OS store; the tests use an in-memory one (Q20).
useSecretVault(createVault(memoryBackend()))

// Plan 39: the tests follow from the registry, so a new entry is tested by
// being declared. Every loop below covers every setting there is.

/** A valid value for a setting that differs from its default. */
function sample(def) {
  if (def.type === 'enum') return def.options.find((o) => o !== def.default)
  if (def.type === 'boolean') return def.default === '1' ? '0' : '1'
  if (def.type === 'secret') {
    const v = ['test-secret-1234567890', 'sk-ant-test-secret-1234567890'].find((x) => isValid(def, x))
    assert.ok(v, `no sample for ${def.id}`)
    return v
  }
  // A string: the default with a suffix still fits the shapes used today.
  const v = `${def.default}-x`.slice(-40)
  assert.ok(isValid(def, v), `no sample for ${def.id}`)
  return v
}

test('the registry passes its own rules', () => {
  assert.deepEqual(checkRegistry(REGISTRY), [])
  assert.ok(Object.isFrozen(REGISTRY) && REGISTRY.every(Object.isFrozen))
})

test('every setting that existed before the registry is declared', () => {
  const ids = REGISTRY.map((d) => d.id).sort()
  assert.deepEqual(ids, [
    'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'JARVIS_ALLOW_WRITES', 'JARVIS_AUDIT', 'JARVIS_CLAUDE_AUTH', 'JARVIS_EFFORT',
    'JARVIS_MODEL', 'JARVIS_TRACES', 'JARVIS_VOICE_ID',
    'JARVIS_WAKE_SENSITIVITY', 'JARVIS_WAKE_WORD', 'setupDone',
  ])
})

test('Claude runs on the subscription by default; an API key is an opt-in secret (ADR 001, Q42)', () => {
  const mode = settingDef('JARVIS_CLAUDE_AUTH')
  assert.equal(mode.section, 'brains')
  assert.equal(mode.type, 'enum')
  assert.deepEqual(mode.options, ['subscription', 'apikey'])
  assert.equal(mode.default, 'subscription')
  const key = settingDef('ANTHROPIC_API_KEY')
  assert.equal(key.secret, true, 'the key goes to the OS keychain, never the settings table')
  assert.equal(key.default, '')
  assert.equal(key.risk, 'sensitive')
  assert.equal(isValid(key, 'sk-ant-api03-' + 'a'.repeat(40)), true)
  for (const bad of ['', 'sk-ant-short', 'not-a-key-at-all-0123456789', 'sk-ant-api03-has space here!!']) {
    assert.equal(isValid(key, bad), false, bad)
  }
})

test('the offline wake word is on by default and can be turned off (plan 02)', () => {
  const wake = settingDef('JARVIS_WAKE_WORD')
  assert.equal(wake.default, 'offline')
  assert.deepEqual([...wake.options], ['offline', 'cloud'])
  assert.equal(wake.section, 'voice')
  const sens = settingDef('JARVIS_WAKE_SENSITIVITY')
  assert.equal(sens.default, 'medium')
  assert.deepEqual([...sens.options], ['low', 'medium', 'high'])
})

test('checkRegistry catches broken entries', () => {
  const good = { ...settingDef('JARVIS_EFFORT') }
  const cases = [
    [{ ...good, section: 'nowhere' }, /unknown section/],
    [{ ...good, help: ' ' }, /missing help/],
    [{ ...good, label: '' }, /missing label/],
    [{ ...good, default: 'max' }, /default does not validate/],
    [{ ...good, options: [] }, /enum needs options/],
    [{ ...good, risk: 'fine' }, /unknown risk/],
    [{ ...good, apply: 'later' }, /unknown apply/],
    [{ ...good, scope: 'room' }, /unknown scope/],
    [{ ...good, visibleIn: 'hidden' }, /unknown visibleIn/],
    [{ ...good, type: 'number' }, /unknown type/],
    [{ ...good, type: 'string', pattern: undefined }, /needs a pattern/],
    [{ ...settingDef('ELEVENLABS_API_KEY'), default: 'abcdefgh1234' }, /a secret has no default/],
    [{ ...good, id: 'bad id' }, /bad id/],
  ]
  for (const [entry, re] of cases) assert.match(checkRegistry([entry]).join('; '), re, JSON.stringify(entry))
  assert.match(checkRegistry([good, good]).join('; '), /duplicate id/)
})

test('safe defaults: real actions are off, and only the writes switch is dangerous', () => {
  assert.equal(settingDefault('JARVIS_ALLOW_WRITES'), '0')
  assert.deepEqual(REGISTRY.filter((d) => d.risk === 'dangerous').map((d) => d.id), ['JARVIS_ALLOW_WRITES'])
  assert.equal(settingDefault('ELEVENLABS_API_KEY'), undefined)
})

for (const def of REGISTRY) {
  test(`${def.id}: saves, reads back, clears, and rejects bad values`, () => {
    const v = sample(def)
    const r = updateSettings({ [def.id]: v })
    assert.deepEqual(r.changed, [def.id])
    const when = { live: r.appliedLive, reconnect: r.nextConversation, restart: r.needsRestart }
    assert.deepEqual(when[def.apply], [def.id])
    assert.deepEqual(r.restartPending, def.apply === 'restart' ? [def.id] : [])
    assert.equal(setting(def.id), v)
    const pub = publicSettings()
    if (def.secret) {
      assert.equal(pub[`${def.id}_set`], true)
      assert.equal(def.id in pub, false)
      assert.equal(JSON.stringify(pub).includes(v), false)
    } else {
      assert.equal(pub[def.id], v)
    }
    assert.throws(() => updateSettings({ [def.id]: 'not valid at all!' }), /invalid value/)
    assert.throws(() => updateSettings({ [def.id]: 7 }), /invalid value/)
    assert.equal(setting(def.id), v, 'a rejected patch must not change the stored value')
    updateSettings({ [def.id]: '' })
    assert.equal(setting(def.id), undefined)
  })
}

test('the schema covers every setting and every section, and carries no values', () => {
  updateSettings({ ELEVENLABS_API_KEY: 'schema-secret-abcdef', JARVIS_MODEL: 'claude-test-9' })
  const schema = settingsSchema()
  const text = JSON.stringify(schema)
  assert.equal(schema.v, 1)
  assert.deepEqual(schema.settings.map((s) => s.id), REGISTRY.map((d) => d.id))
  assert.deepEqual(schema.sections.map((s) => s.id), SECTIONS.map((s) => s.id))
  assert.equal(text.includes('schema-secret-abcdef'), false)
  assert.equal(text.includes('claude-test-9'), false)
  for (const s of schema.settings) {
    for (const k of ['section', 'label', 'help', 'type', 'default', 'scope', 'risk', 'apply', 'visibleIn', 'secret']) {
      assert.ok(k in s, `${s.id} is missing ${k} in the schema`)
    }
    if (s.pattern) assert.doesNotThrow(() => new RegExp(s.pattern))
  }
  // It is plain JSON: what the page gets is what the bridge holds.
  assert.deepEqual(JSON.parse(text), schema)
  updateSettings({ ELEVENLABS_API_KEY: '', JARVIS_MODEL: '' })
})

test('the bridge serves the schema and PATCH, and takes its defaults from the registry', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(src, /pathname === '\/settings\/schema' && req\.method === 'GET'/)
  assert.match(src, /req\.method === 'PATCH' \|\| req\.method === 'POST'/)
  assert.match(src, /'access-control-allow-methods': 'GET, POST, PATCH'/)
  for (const id of ['JARVIS_MODEL', 'JARVIS_EFFORT', 'JARVIS_VOICE_ID']) {
    assert.match(src, new RegExp(`setting\\('${id}'\\) \\?\\? settingDefault\\('${id}'\\)`))
  }
  // The write path keeps its Origin rule: scripts without one are refused.
  const route = src.slice(src.indexOf("if (requestUrl.pathname === '/settings') {"))
  assert.match(route.slice(0, 600), /if \(!origin\) \{\s*res\.writeHead\(403/)
})

test('the page keeps its own copy of the shapes it reads in step with the registry', () => {
  const ts = readFileSync(new URL('../src/lib/settings.ts', import.meta.url), 'utf8')
  for (const d of REGISTRY) assert.ok(ts.includes(d.secret ? `${d.id}_set` : d.id), `${d.id} missing from PublicSettings`)
})

test('live apply: only settings read once at start wait for a restart (plan 39 phase 4)', () => {
  const by = (apply) => REGISTRY.filter((d) => d.apply === apply).map((d) => d.id).sort()
  assert.deepEqual(by('live'), ['ELEVENLABS_API_KEY', 'JARVIS_TRACES', 'JARVIS_VOICE_ID', 'setupDone'])
  assert.deepEqual(by('reconnect'), ['ANTHROPIC_API_KEY', 'JARVIS_CLAUDE_AUTH', 'JARVIS_EFFORT', 'JARVIS_MODEL'])
  // The writes switch stays restart-only until the Safety section (phase 5)
  // adds confirmation for dangerous changes; the audit log stays on until then too.
  assert.deepEqual(by('restart'), ['JARVIS_ALLOW_WRITES', 'JARVIS_AUDIT', 'JARVIS_WAKE_SENSITIVITY', 'JARVIS_WAKE_WORD'])
})
