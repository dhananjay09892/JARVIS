// Agents phase A1 (A06): the Mission Board names the agent that runs each task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missionAgent } from './missionAgent.ts'

test('a task run by a named agent is tagged with the agent name', () => {
  assert.deepEqual(missionAgent({ title: 'Compare three desks', agentName: 'Researcher' }), {
    label: 'RESEARCHER', title: 'Run by the Researcher agent', aria: 'Compare three desks, by Researcher',
  })
})

test('a plain task, or a blank name, gets no tag', () => {
  assert.equal(missionAgent({ title: 'Tidy downloads' }), null)
  assert.equal(missionAgent({ title: 'Tidy downloads', agentName: '   ' }), null)
})
