import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseDocument, travelOf, connectorProblems, toolProblems, SENSITIVITY_CLASSES } from './interface.mjs'

test('documents are normalised and bounded', () => {
  const { ok, doc } = normaliseDocument({ id: 'm1', text: 'x'.repeat(300_000), createdAt: 5, title: 't'.repeat(900), url: 'https://a.test/1' })
  assert.equal(ok, true)
  assert.equal(doc.text.length, 200_000)
  assert.equal(doc.title.length, 500)
  assert.equal(doc.updatedAt, 5)
  assert.equal(doc.sensitivity, 'personal')
  assert.equal(doc.url, 'https://a.test/1')
  for (const bad of [null, [], { id: 'a\nb', text: '', updatedAt: 1 }, { id: 'a', text: 1, updatedAt: 1 }, { id: 'a', text: '', updatedAt: -1 }]) {
    assert.equal(normaliseDocument(bad).ok, false)
  }
  assert.equal(normaliseDocument({ id: 'a', text: '', updatedAt: 1 }, { defaultSensitivity: 'work' }).doc.sensitivity, 'work')
})

test('sensitivity classes map to how far a document may travel', () => {
  assert.equal(travelOf('public'), 'public')
  assert.equal(travelOf('health'), 'vault')
  assert.equal(travelOf('finance'), 'vault')
  assert.equal(travelOf('messages'), 'private')
  assert.ok(SENSITIVITY_CLASSES.includes('contacts'))
})

test('shape checks name the problem', () => {
  assert.deepEqual(connectorProblems('x'), ['a connector must be an object'])
  assert.ok(connectorProblems({ id: 'a' }).length > 5)
  assert.deepEqual(toolProblems({ name: 'list_x', capability: 'read', description: 'd', run() {} }), [])
  assert.equal(toolProblems({ name: 'list_x', capability: 'admin', description: '', run: 1 }).length, 3)
})
