import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardParts, parseVoiceAnswer, createInbox } from './approvals-inbox.mjs'
import { createApprovalHub } from './workflows.mjs'
import { taskServer, isTaskTool } from './task-tools.mjs'

test('a mission card is split into mission, agent and action', () => {
  assert.deepEqual(cardParts('Task "Trip planning" (Researcher): Send the email'), { mission: 'Trip planning', agent: 'Researcher', action: 'Send the email' })
  assert.deepEqual(cardParts('Task "Taxes": Run npm test'), { mission: 'Taxes', agent: '', action: 'Run npm test' })
  assert.deepEqual(cardParts('Run a workflow'), { mission: '', agent: '', action: 'Run a workflow' })
})

test('the owner\'s words pick cards by position', () => {
  assert.deepEqual(parseVoiceAnswer('approve the first two', 3), { decision: 'approve', positions: [1, 2] })
  assert.deepEqual(parseVoiceAnswer('Deny the third one.', 3), { decision: 'deny', positions: [3] })
  assert.deepEqual(parseVoiceAnswer('approve the second one', 3), { decision: 'approve', positions: [2] })
  assert.deepEqual(parseVoiceAnswer('approve 1 and 3', 3), { decision: 'approve', positions: [1, 3] })
  assert.deepEqual(parseVoiceAnswer('reject number two', 3), { decision: 'deny', positions: [2] })
  assert.deepEqual(parseVoiceAnswer('approve all', 3), { decision: 'approve', positions: [1, 2, 3] })
  assert.deepEqual(parseVoiceAnswer('yes', 1), { decision: 'approve', positions: [1] })
})

test('unclear, mixed or out-of-range words answer nothing', () => {
  assert.ok(parseVoiceAnswer('what is waiting?', 3).reason)
  assert.ok(parseVoiceAnswer('approve it', 3).reason)
  assert.ok(parseVoiceAnswer('approve the first and deny the second', 3).reason)
  assert.ok(parseVoiceAnswer('approve the fourth', 3).reason)
  assert.ok(parseVoiceAnswer('approve the first two', 0).reason)
  assert.ok(parseVoiceAnswer('', 2).reason)
})

function setup(ownerText) {
  const hub = createApprovalHub({ ttlMs: 60_000 })
  hub.attach(() => {})
  const said = { text: ownerText }
  const inbox = createInbox(hub, { ownerText: () => said.text })
  const results = []
  const ask = (title) => hub.request(title, 'details').then((v) => { results.push([title, v]); return v })
  return { hub, inbox, said, results, ask }
}

test('two missions\' approvals appear in one inbox and are approved by voice', async () => {
  const { hub, inbox, said, ask } = setup('approve the first two')
  const a = ask('Task "Trip" (Researcher): Open the booking site')
  const b = ask('Task "Taxes": Run the export')
  const c = ask('Task "Garden": Order seeds')
  const cards = inbox.list()
  assert.deepEqual(cards.map((x) => [x.position, x.mission, x.action]), [[1, 'Trip', 'Open the booking site'], [2, 'Taxes', 'Run the export'], [3, 'Garden', 'Order seeds']])
  inbox.shownByPage(cards.map((x) => x.id))
  assert.equal(inbox.summary().cards.length, 3)
  const out = inbox.answerByVoice()
  assert.deepEqual(out.answered.map((x) => x.mission), ['Trip', 'Taxes'])
  assert.equal(await a, true)
  assert.equal(await b, true)
  assert.equal(hub.count(), 1)
  // The page redraws with what is left, and the owner's "first" is that card.
  inbox.shownByPage(inbox.list().map((x) => x.id))
  said.text = 'deny the first'
  inbox.answerByVoice()
  assert.equal(await c, false)
})

test('a voice approval never approves a card that is not on screen', async () => {
  const { hub, inbox, ask } = setup('approve all')
  ask('Task "A": one')
  ask('Task "B": two')
  const hidden = ask('Task "C": three')
  const [first, second] = inbox.list()
  // The page shows only two of the three cards.
  inbox.shownByPage([first.id, second.id])
  const out = inbox.answerByVoice()
  assert.equal(out.answered.length, 2)
  assert.equal(hub.count(), 1)
  assert.equal(inbox.summary().waiting, 1)
  let settled = false
  hidden.then(() => { settled = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  // Nothing on screen: nothing answered, even by "approve all".
  inbox.shownByPage([])
  assert.deepEqual(inbox.answerByVoice().answered, [])
  assert.equal(hub.count(), 1)
  hub.cancelAll()
})

test('positions follow the page\'s order, a card closed since is skipped, and ids it never showed are ignored', async () => {
  const { hub, inbox, said, ask } = setup('approve the second')
  const a = ask('Task "A": one')
  const b = ask('Task "B": two')
  const [ca, cb] = inbox.list()
  inbox.shownByPage(['approval-not-in-hub', cb.id, ca.id])
  assert.equal(inbox.summary().cards.map((c) => c.position).join(), '2,3')
  inbox.answerByVoice()
  assert.equal(await b, true)
  said.text = 'approve the first'
  assert.deepEqual(inbox.answerByVoice().answered, [])
  said.text = 'approve the third'
  inbox.answerByVoice()
  assert.equal(await a, true)
})

test('the answer comes from the owner\'s words, not from the caller', async () => {
  const { hub, inbox, said, ask } = setup('what needs my approval?')
  const p = ask('Task "A": one')
  inbox.shownByPage(inbox.list().map((c) => c.id))
  // The voice session may use both tools, and neither takes an argument that could steer the answer.
  assert.ok(isTaskTool('list_approvals') && isTaskTool('answer_approvals'))
  assert.doesNotThrow(() => taskServer({ list: () => [], get: () => null }, { inbox }))
  // No owner approve/deny words: nothing happens.
  assert.deepEqual(inbox.answerByVoice().answered, [])
  assert.equal(hub.count(), 1)
  said.text = 'ok'
  assert.deepEqual(inbox.answerByVoice().answered, [])
  hub.cancelAll()
  assert.equal(await p, false)
})
