import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeSupported, nodeProblem, MIN_NODE_TEXT } from '../scripts/node-version.mjs'

test('Node 22.13 and newer are supported, older ones are not', () => {
  for (const ok of ['22.13.0', '22.13.1', 'v22.14.0', '22.20.3', '23.0.0', '24.8.0', '30.1.2']) {
    assert.equal(nodeSupported(ok), true, ok)
  }
  for (const bad of ['20.19.0', '21.7.3', '22.12.9', 'v22.0.0', '18.20.4']) {
    assert.equal(nodeSupported(bad), false, bad)
  }
})

test('the running Node (which the tests need anyway) passes', () => {
  assert.equal(nodeSupported(), true)
})

test('the message names the requirement and the version found', () => {
  const text = nodeProblem('20.11.0')
  assert.match(text, new RegExp(MIN_NODE_TEXT.replace('.', '\\.')))
  assert.match(text, /20\.11\.0/)
})
