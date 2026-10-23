// Checks for the wake-model recipe (Q47) that run without a GPU or Python packages:
// every training input has a commercial-use licence and a row in plans/LICENCES.md,
// nothing excluded is used, the generated configs are current, and the negatives
// cover the near-misses plan 02 asks for.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USES, buildConfig, loadRecipe, render } from './make-configs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { phrases, sources } = loadRecipe()
const inputs = new Map(sources.inputs.map((s) => [s.id, s]))
const licences = readFileSync(join(repo, 'plans', 'LICENCES.md'), 'utf8')
const used = new Set(Object.values(USES).flat())

test('every input has a licence, a decision and a check date', () => {
  assert.equal(inputs.size, sources.inputs.length, 'duplicate ids in sources.json')
  for (const s of sources.inputs) {
    assert.ok(s.id && s.name && s.licence, `${s.id}: id, name and licence are required`)
    assert.equal(typeof s.commercialUse, 'boolean', `${s.id}: commercialUse must be true or false`)
    assert.match(s.checked, /^\d{4}-\d{2}-\d{2}$/, `${s.id}: checked date`)
    if (s.commercialUse) {
      assert.ok(s.attribution, `${s.id}: attribution needed for credits and model cards`)
      assert.ok(s.sources?.length, `${s.id}: say where the licence was checked`)
    }
  }
})

test('every input, used or excluded, has a row in plans/LICENCES.md', () => {
  for (const s of sources.inputs) {
    assert.ok(licences.includes('`' + s.id + '`'), `plans/LICENCES.md has no row for \`${s.id}\``)
  }
  for (const t of sources.tools) {
    assert.ok(licences.includes('`' + t.id + '`'), `plans/LICENCES.md has no row for tool \`${t.id}\``)
  }
})

test('the recipe only uses inputs cleared for commercial use', () => {
  for (const id of used) {
    assert.ok(inputs.has(id), `${id} is used but not in sources.json`)
    assert.equal(inputs.get(id).commercialUse, true, `${id} is used but not cleared for commercial use`)
  }
  const excluded = sources.inputs.filter((s) => !s.commercialUse)
  assert.ok(excluded.length >= 5, 'the known non-commercial inputs stay listed as excluded')
  for (const s of excluded) assert.ok(!used.has(s.id), `${s.id} is excluded but used`)
})

test('configs are generated from phrases.json and current', () => {
  const files = readdirSync(join(here, 'configs')).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(files, phrases.models.map((m) => `${m.model}.json`).sort())
  for (const model of phrases.models) {
    const committed = readFileSync(join(here, 'configs', `${model.model}.json`), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(committed, render(buildConfig(model, phrases)), `${model.model}.json is stale: run node scripts/wake/make-configs.mjs`)
  }
})

test('no config or script points at the non-commercial openWakeWord data', () => {
  const banned = /acav100m|openwakeword_features|validation_set_features|audioset|fma_|fma\/|mit_rirs|MIT_environmental|hey_jarvis/i
  const files = [
    ...readdirSync(join(here, 'configs')).map((f) => join(here, 'configs', f)),
    ...readdirSync(here).filter((f) => /\.(py|mjs)$/.test(f) && !f.endsWith('.test.mjs')).map((f) => join(here, f)),
  ]
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), banned, `${file} mentions an excluded dataset`)
  }
})

test('the three built-in phrases from plan 02 are covered', () => {
  assert.deepEqual(phrases.models.map((m) => m.phrase), ['Hey Tamelo', 'Hey Buddy', 'Hey Friend'])
  for (const m of phrases.models) {
    const word = m.phrase.split(' ')[1].toLowerCase()
    assert.ok(m.say.some((s) => s === m.phrase.toLowerCase()), `${m.model}: the plain spelling is a target`)
    assert.ok(m.sayHindi.length > 0, `${m.model}: Hindi voices say it too`)
    assert.ok(m.negatives.some((n) => n.includes(word) && !n.includes('hey')), `${m.model}: "${word}" without "hey" is a negative`)
  }
})

test('negatives never contain the wake phrase itself', () => {
  for (const m of phrases.models) {
    const targets = m.say.map((s) => s.replace(/[^a-z ]/g, ''))
    const config = buildConfig(m, phrases)
    for (const n of config.custom_negative_phrases) {
      const plain = n.replace(/[^a-z ]/g, '')
      for (const t of targets) assert.ok(!plain.includes(t), `${m.model}: negative "${n}" contains target "${t}"`)
    }
  }
})

test('each model treats the other phrases and other assistants as negatives', () => {
  for (const m of phrases.models) {
    const negatives = buildConfig(m, phrases).custom_negative_phrases
    for (const other of phrases.models.filter((o) => o !== m)) {
      assert.ok(negatives.includes(other.phrase.toLowerCase()), `${m.model}: missing "${other.phrase}"`)
    }
    for (const a of ['hey siri', 'alexa', 'ok google', 'hey jarvis']) assert.ok(negatives.includes(a), `${m.model}: missing "${a}"`)
  }
})

test('Hindi and Gujarati near-misses are in the negatives, especially "tame lo"', () => {
  const tamelo = phrases.models.find((m) => m.model === 'hey_tamelo')
  assert.ok(tamelo.negatives.includes('tame lo'), 'Latin "tame lo" for the English voices')
  assert.ok(tamelo.negativesHindi.includes('तमे लो'), 'Devanagari "tame lo" for the Hindi voices')
  assert.ok(tamelo.gujaratiOriginals.includes('તમે લો'), 'the Gujarati original is recorded')
  for (const m of phrases.models) {
    assert.ok(m.negativesHindi.length >= 5, `${m.model}: at least 5 Hindi/Gujarati negatives`)
    assert.ok(m.negativesHindi.every((n) => /[ऀ-ॿ]/.test(n)), `${m.model}: Hindi-voice negatives are in Devanagari`)
  }
  // Real Gujarati and Hindi speech is part of the negative set.
  for (const id of ['fleurs']) {
    assert.ok(USES.negatives.includes(id))
    assert.ok(inputs.get(id).languages.includes('gu') && inputs.get(id).languages.includes('hi'))
  }
})
