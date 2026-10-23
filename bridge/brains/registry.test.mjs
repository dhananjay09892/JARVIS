import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrainRegistry } from './registry.mjs'

const brain = (over = {}) => ({
  id: 'claude',
  label: 'Claude',
  capabilities: { tools: true, streaming: true },
  status: () => ({ installed: true }),
  startSession: () => ({}),
  ...over,
})

test('register, get, list and default', () => {
  const brains = createBrainRegistry()
  const claude = brains.register(brain())
  const other = brains.register(brain({ id: 'mock-brain', label: 'Mock' }))
  assert.equal(brains.get('claude'), claude)
  assert.equal(brains.get('mock-brain'), other)
  assert.equal(brains.default(), claude)
  assert.equal(brains.has('claude'), true)
  assert.equal(brains.has('gemini'), false)
  assert.deepEqual(brains.list(), [
    { id: 'claude', label: 'Claude', capabilities: { tools: true, streaming: true } },
    { id: 'mock-brain', label: 'Mock', capabilities: { tools: true, streaming: true } },
  ])
})

test('unknown ids throw instead of falling back to another brain', () => {
  const brains = createBrainRegistry()
  assert.throws(() => brains.get('claude'), /No brain called claude/)
  assert.throws(() => brains.default(), /No brain called claude/)
  const custom = createBrainRegistry({ defaultId: 'mock' })
  custom.register(brain())
  assert.throws(() => custom.default(), /No brain called mock/)
})

test('duplicates and malformed brains are rejected', () => {
  const brains = createBrainRegistry()
  brains.register(brain())
  assert.throws(() => brains.register(brain()), /already registered/)
  assert.throws(() => brains.register(null), /object/)
  assert.throws(() => brains.register(brain({ id: 'Bad Id' })), /Bad brain id/)
  assert.throws(() => brains.register(brain({ id: 'x', label: '' })), /label/)
  assert.throws(() => brains.register(brain({ id: 'y', capabilities: null })), /capabilities/)
  assert.throws(() => brains.register(brain({ id: 'z', status: undefined })), /status\(\)/)
  assert.throws(() => brains.register(brain({ id: 'w', startSession: 'no' })), /startSession\(\)/)
  assert.deepEqual(brains.list().map((b) => b.id), ['claude'])
})
