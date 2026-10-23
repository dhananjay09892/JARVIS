import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-registry-'))
const { REGISTRY, SECTIONS, checkRegistry, isValid, settingDef, settingDefault, settingsSchema } =
  await import('./settings-registry.mjs')
const { updateSettings, publicSettings, setting } = await import('./settings.mjs')

// Plan 39: the tests follow from the registry, so a new entry is tested by
// being declared. Every loop below covers every setting there is.

/** A valid value for a setting that differs from its default. */
function sample(def) {
  if (def.type === 'enum') return def.options.find((o) => o !== def.default)
  if (def.type === 'boolean') return def.default === '1' ? '0' : '1'
  if (def.type === 'secret') return 'test-secret-1234567890'
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
    'ELEVENLABS_API_KEY', 'JARVIS_ALLOW_WRITES', 'JARVIS_AUDIT', 'JARVIS_EFFORT',
    'JARVIS_MODEL', 'JARVIS_TRACES', 'JARVIS_VOICE_ID', 'setupDone',
  ])
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
    assert.deepEqual(def.apply === 'live' ? r.appliedLive : r.needsRestart, [def.id])
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
