import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-language-'))
const { PROFILE_DEFAULTS, languagePreface, readLanguageProfile, replyLanguage, scriptLanguage } =
  await import('./language-profile.mjs')
const { settingDef } = await import('./settings-registry.mjs')
const { setting, updateSettings, useSecretVault } = await import('./settings.mjs')
const { createVault, memoryBackend } = await import('./secrets.mjs')
useSecretVault(createVault(memoryBackend()))

const profile = (over) => readLanguageProfile((id) => over[id])

test('the profile is four person-scoped, live settings in the Languages section', () => {
  for (const id of ['JARVIS_LANG_PRIMARY', 'JARVIS_LANG_SECONDARY', 'JARVIS_REPLY_LANGUAGE', 'JARVIS_TEXT_SCRIPT']) {
    const d = settingDef(id)
    assert.ok(d, id)
    assert.equal(d.section, 'languages')
    assert.equal(d.scope, 'person')
    assert.equal(d.apply, 'live')
    assert.equal(d.type, 'enum')
  }
  assert.equal(settingDef('JARVIS_LANG_PRIMARY').default, PROFILE_DEFAULTS.primary)
  assert.equal(settingDef('JARVIS_LANG_SECONDARY').default, PROFILE_DEFAULTS.secondary)
  assert.equal(settingDef('JARVIS_REPLY_LANGUAGE').default, PROFILE_DEFAULTS.reply)
  assert.equal(settingDef('JARVIS_TEXT_SCRIPT').default, PROFILE_DEFAULTS.script)
})

test('defaults keep today\'s behaviour: understand all three, answer in English', () => {
  const p = readLanguageProfile()
  assert.deepEqual({ ...p }, { ...PROFILE_DEFAULTS })
  const pre = languagePreface(p, 'tame kem cho?')
  assert.match(pre, /^Reply in English\./)
  assert.match(pre, /English, Gujarati, or Hindi/)
})

test('bad or missing values fall back field by field; a reader that throws is survived', () => {
  const p = profile({ JARVIS_LANG_PRIMARY: 'fr', JARVIS_REPLY_LANGUAGE: 'mirror', JARVIS_TEXT_SCRIPT: 'klingon' })
  assert.equal(p.primary, 'en')
  assert.equal(p.reply, 'mirror')
  assert.equal(p.script, 'native')
  assert.deepEqual({ ...readLanguageProfile(() => { throw new Error('db gone') }) }, { ...PROFILE_DEFAULTS })
  // A second language equal to the first means none.
  assert.equal(profile({ JARVIS_LANG_PRIMARY: 'gu', JARVIS_LANG_SECONDARY: 'gu' }).secondary, 'none')
})

test('script detection names Gujarati and Devanagari, and leaves Latin letters undecided', () => {
  assert.equal(scriptLanguage('તમે કેમ છો?'), 'gu')
  assert.equal(scriptLanguage('आज मौसम कैसा है?'), 'hi')
  assert.equal(scriptLanguage('What time is it?'), null)
  // Romanised Hindi/Gujarati looks like English to letters alone.
  assert.equal(scriptLanguage('Jarvis, kal ka meeting kitne baje che?'), null)
  // Mostly Devanagari with an English word still reads as Hindi.
  assert.equal(scriptLanguage('मेरा meeting कब है'), 'hi')
  assert.equal(scriptLanguage(''), null)
  assert.equal(scriptLanguage('12:30 ?!'), null)
  assert.equal(scriptLanguage(undefined), null)
})

test('reply policy: main language, always one language, or mirror', () => {
  assert.equal(replyLanguage(profile({ JARVIS_LANG_PRIMARY: 'gu' }), 'What time is it?'), 'gu')
  assert.equal(replyLanguage(profile({ JARVIS_LANG_PRIMARY: 'gu', JARVIS_REPLY_LANGUAGE: 'hi' }), 'તમે કેમ છો?'), 'hi')
  const mirror = profile({ JARVIS_LANG_PRIMARY: 'en', JARVIS_REPLY_LANGUAGE: 'mirror' })
  assert.equal(replyLanguage(mirror, 'તમે કેમ છો?'), 'gu')
  assert.equal(replyLanguage(mirror, 'आज मौसम कैसा है?'), 'hi')
  assert.equal(replyLanguage(mirror, 'kal ka meeting kitne baje che?'), null)
})

test('the preface names the reply language and script the profile asks for', () => {
  const gu = languagePreface(profile({ JARVIS_LANG_PRIMARY: 'gu' }), 'What time is it?')
  assert.match(gu, /^Reply in Gujarati, written in Gujarati script\./)

  const hiRoman = languagePreface(profile({ JARVIS_LANG_PRIMARY: 'hi', JARVIS_TEXT_SCRIPT: 'roman' }), 'hello')
  assert.match(hiRoman, /^Reply in Hindi, written in Latin letters \(romanised Hindi\), not Devanagari script\./)

  const always = languagePreface(profile({ JARVIS_LANG_PRIMARY: 'gu', JARVIS_REPLY_LANGUAGE: 'en' }), 'તમે કેમ છો?')
  assert.match(always, /^Reply in English\./)

  const mirror = profile({ JARVIS_LANG_PRIMARY: 'gu', JARVIS_LANG_SECONDARY: 'en', JARVIS_REPLY_LANGUAGE: 'mirror' })
  assert.match(languagePreface(mirror, 'आज मौसम कैसा है?'), /^Reply in Hindi, written in Devanagari script \(the language of this message\)\./)
  const unsure = languagePreface(mirror, 'kal ka meeting kitne baje che?')
  assert.match(unsure, /^Reply in the language the user used in this message/)
  assert.match(unsure, /if you cannot tell, reply in Gujarati, written in Gujarati script\./)
  assert.match(unsure, /mainly speaks Gujarati and also English/)
  // Every preface fits in the bridge's preface budget.
  for (const p of [gu, hiRoman, always, unsure]) assert.ok(p.length < 1000)
})

test('the reply language follows the saved profile, and a change applies to the next turn', () => {
  const now = () => languagePreface(readLanguageProfile(setting), 'What time is it?')
  assert.match(now(), /^Reply in English\./)
  updateSettings({ JARVIS_LANG_PRIMARY: 'hi' })
  assert.match(now(), /^Reply in Hindi, written in Devanagari script\./)
  updateSettings({ JARVIS_TEXT_SCRIPT: 'roman' })
  assert.match(now(), /^Reply in Hindi, written in Latin letters/)
  updateSettings({ JARVIS_REPLY_LANGUAGE: 'gu' })
  assert.match(now(), /^Reply in Gujarati, written in Latin letters/)
  // The API refuses values outside the profile.
  assert.throws(() => updateSettings({ JARVIS_REPLY_LANGUAGE: 'fr' }), /invalid value/)
  updateSettings({ JARVIS_LANG_PRIMARY: '', JARVIS_TEXT_SCRIPT: '', JARVIS_REPLY_LANGUAGE: '' })
  assert.match(now(), /^Reply in English\./)
})

test('the bridge adds the profile to every turn, and the page no longer forces English there', () => {
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(server, /languagePreface\(readLanguageProfile\(setting\), msg\.text\)/)
  const brain = readFileSync(new URL('../src/lib/brain.ts', import.meta.url), 'utf8')
  // The page adds only its own context (what quick commands did, Q75), never a language line.
  assert.match(brain, /if \(usingBridge\) return bridge\.ask\(prompt, handlers, context\)/)
})
