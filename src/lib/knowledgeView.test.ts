import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addFolder, folderProblem, foundShare, knowledgeStatsText, parseFolders, removeFolder, serialiseFolders, setFolderCloud } from './knowledgeView.ts'
// @ts-expect-error plain JS bridge module, no type declarations
import { parseSources } from '../../bridge/knowledge-base.mjs'
// @ts-expect-error plain JS bridge module, no type declarations
import { REGISTRY } from '../../bridge/settings-registry.mjs'

test('folders parse and serialise the way the bridge does', () => {
  const value = 'C:\\Notes;C:\\Work\\Docs|cloud;/home/me/log'
  assert.deepEqual(parseFolders(value), parseSources(value))
  assert.equal(serialiseFolders(parseFolders(value)), value)
  assert.deepEqual(parseFolders('none'), [])
  assert.deepEqual(parseFolders(undefined), [])
  assert.equal(serialiseFolders([]), 'none')
})

test('a folder is added restricted, and cloud is a separate choice', () => {
  const list = addFolder([], ' C:\\Notes ')
  assert.deepEqual(list, [{ path: 'C:\\Notes', cloud: false }])
  assert.equal(serialiseFolders(list), 'C:\\Notes')
  assert.equal(serialiseFolders(setFolderCloud(list, 'C:\\Notes', true)), 'C:\\Notes|cloud')
  assert.deepEqual(removeFolder(list, 'C:\\Notes'), [])
})

test('bad folder paths are refused with a reason', () => {
  const have = parseFolders('C:\\Notes')
  assert.match(folderProblem('', have) ?? '', /full path/)
  assert.match(folderProblem('notes', have) ?? '', /full path/)
  assert.match(folderProblem('C:\\a;b', have) ?? '', /full path/)
  assert.match(folderProblem('C:\\Notes', have) ?? '', /already/)
  assert.equal(folderProblem('C:\\Other', have), null)
})

test('everything the screen saves passes the bridge setting validation', () => {
  const def = (REGISTRY as { id: string; pattern?: RegExp }[]).find((s) => s.id === 'JARVIS_KNOWLEDGE_FOLDERS')!
  for (const v of [serialiseFolders([]), serialiseFolders([{ path: 'C:\\Notes', cloud: true }, { path: '/home/me/docs', cloud: false }])]) {
    assert.ok(def.pattern!.test(v), v)
  }
})

test('the counts line shows counts only', () => {
  assert.equal(knowledgeStatsText(null), 'off')
  assert.equal(knowledgeStatsText({ enabled: false }), 'off')
  assert.equal(knowledgeStatsText({ enabled: true, files: 3, passages: 40, sources: 2 }), '3 files · 40 passages · 2 folders')
  assert.equal(
    knowledgeStatsText({ enabled: true, files: 3, passages: 40, sources: 2, queries: 4, found: 3, restrictedWithheld: 2 }),
    '3 files · 40 passages · 2 folders · 4 questions, 75% answered · 2 kept from the brain',
  )
  assert.equal(foundShare({ queries: 0, found: 0 }), null)
})
