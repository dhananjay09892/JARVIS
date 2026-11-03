import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('installer ships the GPL-3.0 text and the eSpeak NG source notice', () => {
  assert.match(read('installer/licences/GPL-3.0.txt'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  const notice = read('installer/licences/ESPEAK-NG-NOTICE.txt')
  assert.match(notice, /github\.com\/espeak-ng\/espeak-ng/)
  assert.match(notice, /github\.com\/xenova\/phonemizer\.js/)
  assert.match(notice, /phonemizer 1\.2\.1/)
})

test('package script stages the licences and Node LICENSE', () => {
  const s = read('scripts/package.mjs')
  assert.match(s, /installer\/licences/)
  assert.match(s, /join\(stage, 'node', 'LICENSE'\)/)
})

test('CREDITS.md points at the shipped GPL text', () => {
  assert.match(read('CREDITS.md'), /licences\/GPL-3\.0\.txt/)
})
