import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missionRows, type MissionStats } from './missionStats.ts'

const base: MissionStats = { missions: 0, open: 0, done: 0, failed: 0, cancelled: 0 }

test('no finished missions: says so and shows no rates', () => {
  const rows = missionRows({ ...base, open: 2 })
  assert.equal(rows.length, 1)
  assert.match(rows[0].v, /none finished yet · 2 open/)
  assert.equal(rows[0].bad, false)
})

test('success rate, help rate and cost per mission are shown', () => {
  const rows = missionRows({ ...base, missions: 5, done: 3, failed: 1, open: 1, successRate: 0.75, helpRate: 0.5, avgCostUsd: 0.0421 })
  assert.match(rows[0].v, /3 of 4 succeeded \(75%\)/)
  assert.equal(rows[0].bad, true)
  assert.deepEqual(rows[1], { k: 'needed your help', v: '50%' })
  assert.deepEqual(rows[2], { k: 'cost per mission', v: '$0.042' })
})

test('a healthy rate is not flagged; scheduled count is shown', () => {
  const rows = missionRows({ ...base, done: 9, failed: 1, successRate: 0.9, helpRate: 0, avgCostUsd: 0.5, scheduled: { total: 3, on: 2 } })
  assert.equal(rows[0].bad, false)
  assert.deepEqual(rows[2], { k: 'cost per mission', v: '$0.50' })
  assert.deepEqual(rows[3], { k: 'scheduled missions', v: '2 on of 3' })
})
