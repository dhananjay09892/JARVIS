import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalQueue } from './approvals.mjs'

function fixture(timeoutMs = 1000) {
  const frames = []
  let online = true
  const queue = approvalQueue({ send: (frame) => frames.push(frame), connected: () => online, timeoutMs })
  return { queue, frames, disconnect: () => { online = false; queue.cancel() } }
}

test('exact pending IDs require a boolean approval and can execute only once', async () => {
  const { queue, frames } = fixture()
  const approved = queue.request('Command', 'npm test')
  const rejected = queue.request('Delete', 'repo\\main.js')
  assert.equal(queue.reply('fabricated', true), false)
  assert.equal(queue.reply(frames[0].id, true), true)
  assert.equal(queue.reply(frames[0].id, true), false)
  const deleteId = frames.find((frame) => frame.title === 'Delete').id
  queue.reply(deleteId, 'true')
  assert.equal(await approved, true)
  assert.equal(await rejected, false)
})

test('reject, timeout, interrupt, disconnected and stale requests fail closed', async () => {
  const { queue, frames, disconnect } = fixture(10)
  const denied = queue.request('Command', 'git push')
  queue.reply(frames[0].id, false)
  assert.equal(await denied, false)
  const expired = queue.request('Command', 'npm install')
  const expiredId = frames.at(-1).id
  assert.equal(await expired, false)
  assert.equal(queue.reply(expiredId, true), false)
  const interrupted = queue.request('Command', 'node script.js')
  queue.cancel()
  assert.equal(await interrupted, false)
  const dropped = queue.request('Command', 'npm test')
  disconnect()
  assert.equal(await dropped, false)
  assert.equal(await queue.request('Command', 'never runs'), false)
})
