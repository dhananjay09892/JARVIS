// Agents phase A1 (A06): the Mission Board names the agent that runs each task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missionAgent, missionRows } from './missionAgent.ts'

test('a task run by a named agent is tagged with the agent name', () => {
  assert.deepEqual(missionAgent({ title: 'Compare three desks', agentName: 'Researcher' }), {
    label: 'RESEARCHER', title: 'Run by the Researcher agent', aria: 'Compare three desks, by Researcher',
  })
})

test('a plain task, or a blank name, gets no tag', () => {
  assert.equal(missionAgent({ title: 'Tidy downloads' }), null)
  assert.equal(missionAgent({ title: 'Tidy downloads', agentName: '   ' }), null)
})

// Agents phase A4 (A13): a team run is tagged with the team, not the Coordinator.
test('a team run is tagged with the team name', () => {
  assert.deepEqual(missionAgent({ title: 'Standing desks', agentName: 'Coordinator', team: { id: 'research', name: 'Research team' } }), {
    label: 'RESEARCH TEAM', title: 'Run by the Research team', aria: 'Standing desks, by the Research team',
  })
})

// Agents phase A4 (A12): a task another agent started sits under the task that started it.
test('children are nested under their parent, oldest first; parents stay newest first', () => {
  const tasks = [
    { id: 'a', createdAt: 1 },
    { id: 'b', createdAt: 5 },
    { id: 'a2', createdAt: 4, parentId: 'a' },
    { id: 'a1', createdAt: 3, parentId: 'a' },
    { id: 'orphan', createdAt: 2, parentId: 'gone' },
  ]
  assert.deepEqual(missionRows(tasks).map((r) => [r.task.id, r.nested]), [
    ['b', false], ['orphan', false], ['a', false], ['a1', true], ['a2', true],
  ])
})

test('a task naming itself as parent is not nested', () => {
  assert.deepEqual(missionRows([{ id: 'x', createdAt: 1, parentId: 'x' }]).map((r) => r.nested), [false])
})
