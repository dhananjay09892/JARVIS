// Plan 35 phase 1: the one-page "What JARVIS will never do" (NEVER.md) must
// cover every never-list rule in plan 35, say honestly how far each one is
// enforced today, and be reachable from the README.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** The bullets under "## Never-list" in plan 35. */
function planRules() {
  const plan = read('plans/35-ethics-limits-and-governance.md')
  const section = plan.split(/^## Never-list.*$/m)[1]?.split(/^## /m)[0] ?? ''
  return section.split('\n').filter((l) => l.startsWith('- '))
}

/** The numbered rules on the page, each with its body text. */
function pageRules() {
  const page = read('NEVER.md')
  const parts = page.split(/^### (\d+)\. (.*)$/m)
  const rules = []
  for (let i = 1; i < parts.length; i += 3) {
    rules.push({ n: Number(parts[i]), title: parts[i + 1], body: parts[i + 2].split(/^---$|^## /m)[0] })
  }
  return rules
}

test('the page has one rule for each never-list item in plan 35', () => {
  const plan = planRules()
  assert.ok(plan.length >= 7, `expected the plan 35 never-list, found ${plan.length} items`)
  const rules = pageRules()
  assert.equal(rules.length, plan.length)
  assert.deepEqual(rules.map((r) => r.n), plan.map((_, i) => i + 1))
})

test('each rule says how it is enforced today', () => {
  for (const rule of pageRules()) {
    assert.match(rule.body, /\*\*Today:\*\*/, `rule ${rule.n} (${rule.title}) has no "Today" line`)
  }
})

test('the page covers the subject of every plan 35 rule', () => {
  const page = read('NEVER.md')
  const subjects = [
    /record/i, /track/i, /messages/i,
    /impersonate/i, /voice/i, /\bAI\b/,
    /transfers/i, /trades/i, /advice/i,
    /delete data/i, /spend money/i,
    /CAPTCHA/i, /surveillance/i,
    /biometric/i, /health/i,
    /kill switch/i, /frozen/i,
  ]
  for (const re of subjects) assert.match(page, re)
})

test('the page does not claim the kill switch exists before it does', () => {
  assert.match(read('NEVER.md'), /kill switch is not built yet/i)
})

test('the README links to the page', () => {
  assert.match(read('README.md'), /\]\(NEVER\.md\)/)
})
