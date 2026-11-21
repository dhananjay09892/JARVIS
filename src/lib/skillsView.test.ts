import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skillStatsText } from './skillsView.ts'

test('skillStatsText is null until a skill has run, then says what happened', () => {
  assert.equal(skillStatsText(undefined), null)
  assert.equal(skillStatsText({ runs: 0 }), null)
  assert.equal(skillStatsText({ runs: 1, steps: 2 }), '1 run · 2 steps')
  assert.equal(
    skillStatsText({ runs: 3, steps: 5, waiting: 1, refused: 1, failed: 2 }),
    '3 runs · 5 steps · 1 waiting for allow actions · 1 refused · 2 failed',
  )
})
