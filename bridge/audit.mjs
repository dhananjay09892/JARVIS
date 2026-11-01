/**
 * The audit log, v1 (plan 15 phase 5, storage only): an append-only local
 * record of what the policy engine was asked, what it decided, which approval
 * cards were shown and how they were answered, and which tool calls came back.
 *
 * Tamper-evident, not tamper-proof. Every entry carries the hash of the one
 * before it and a SHA-256 over its own contents, so editing, deleting or
 * reordering an entry breaks the chain and `verify()` names the first entry
 * that no longer fits. SQLite triggers refuse UPDATE and DELETE so nothing in
 * the bridge can rewrite history by accident. What v1 cannot catch, and says
 * so: someone who drops the triggers and recomputes every hash after their
 * edit, or who cuts entries off the end. Both need an anchor kept outside this
 * file (a signed head hash), which belongs with the privacy centre (phase 8).
 *
 * What an entry never holds: tool arguments, tool results, what was said or
 * answered. Only tool *names*, the policy rule and its reason, who asked
 * (voice session or background worker), approval titles run through the same
 * secret filter as memory, and whether a call came back with an error. The
 * file stays on this machine. There is no retention pruning: deleting old
 * entries would break the chain, so that waits for checkpointing too.
 *
 * Like traces.mjs this uses only Node built-ins, so it can be tested on its own.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from './memory.mjs'

/**
 * The kinds of entry. A policy decision, an approval card, a tool result, and
 * a message on a channel (plan 20: received, rejected, sent or failed).
 */
export const ENTRY_TYPES = ['decision', 'approval', 'result', 'channel']
/** Who asked: the voice session, a background worker, or a chat channel (plan 20). */
export const ACTORS = ['voice', 'worker', 'system', 'chat']
/** What happened to a channel message. Content is never logged, only ids, lengths and the rule. */
export const CHANNEL_STATES = ['received', 'rejected', 'sent', 'failed']
/** Where in a tool call the decision was taken. */
export const STAGES = ['pre-tool-use', 'can-use-tool', 'tool-bridge']
export const VERDICTS = ['allow', 'ask', 'deny']

/** prevHash of the first entry. */
export const GENESIS = '0'.repeat(64)

const MAX_TEXT = 200

/** Default location: beside memory and traces, outside the repository. */
export function defaultAuditDir(env = process.env) {
  if (env.JARVIS_AUDIT_DIR) return env.JARVIS_AUDIT_DIR
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'JARVIS', 'audit')
}

const word = (v, re = /^[\w.:-]{1,128}$/) => (typeof v === 'string' && re.test(v) ? v : null)
const text = (v) => (typeof v === 'string' && v ? redact(v).text.slice(0, MAX_TEXT) : null)
const oneOf = (list, v, what) => {
  if (!list.includes(v)) throw new Error(`unknown ${what}`)
  return v
}

/**
 * JSON with object keys sorted, so the same entry always hashes the same
 * whatever order its fields were built in.
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** SHA-256 (hex) over an entry, which includes its seq and prevHash. */
export function hashEntry(entry) {
  return createHash('sha256').update(canonical(entry)).digest('hex')
}

/** The tool request, by name only. Anything else about the call stays out. */
function toolRequest(request) {
  if (!request || request.kind !== 'tool') return { kind: 'other' }
  return { kind: 'tool', name: word(request.name) ?? '[malformed]' }
}

/**
 * Validate and clean an entry before it is chained. Throws on anything that
 * does not say what kind of entry it is; unknown fields are dropped.
 */
export function normaliseEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('entry must be an object')
  const type = oneOf(ENTRY_TYPES, input.type, 'entry type')
  const entry = { type, actor: oneOf(ACTORS, input.actor ?? 'system', 'actor') }

  if (type === 'decision') {
    entry.stage = oneOf(STAGES, input.stage, 'stage')
    entry.request = toolRequest(input.request)
    const d = input.decision ?? {}
    entry.decision = {
      verdict: oneOf(VERDICTS, d.verdict, 'verdict'),
      rule: word(d.rule, /^[\w-]{1,64}$/) ?? 'unknown',
      reason: text(d.reason),
    }
  } else if (type === 'approval') {
    entry.approvalId = word(input.approvalId, /^[\w-]{1,64}$/)
    entry.state = oneOf(['requested', 'resolved'], input.state, 'approval state')
    if (entry.state === 'requested') entry.title = text(input.title)
    else entry.approved = input.approved === true
  } else if (type === 'channel') {
    entry.state = oneOf(CHANNEL_STATES, input.state, 'channel state')
    entry.channel = word(input.channel, /^[a-z][\w-]{0,31}$/) ?? 'unknown'
    // Who: a binding id for a known sender, or a short hash for anyone else.
    // Never the raw sender id of a stranger, never the message.
    const bindingId = word(input.bindingId, /^[\w-]{1,64}$/)
    if (bindingId) entry.bindingId = bindingId
    else entry.senderHash = word(input.senderHash, /^[0-9a-f]{16}$/) ?? 'unknown'
    entry.rule = word(input.rule, /^[\w-]{1,64}$/) ?? 'unknown'
    entry.length = Number.isInteger(input.length) && input.length >= 0 ? input.length : 0
  } else {
    entry.request = toolRequest(input.request)
    entry.result = { error: input.result?.error === true }
  }
  return entry
}

/**
 * Walk entries in seq order and check the chain. Returns
 * `{ ok: true, count }`, or `{ ok: false, count, brokenAt, problem }` naming
 * the first seq that does not fit.
 */
export function verifyRows(rows) {
  let prev = GENESIS
  let expected = 1
  for (const row of rows) {
    const fail = (problem) => ({ ok: false, count: rows.length, brokenAt: row.seq, problem })
    if (row.seq !== expected) return fail(`expected entry ${expected}, found ${row.seq}`)
    let entry
    try {
      entry = JSON.parse(row.data)
    } catch {
      return fail('entry is not valid JSON')
    }
    if (entry.seq !== row.seq || entry.ts !== row.ts || entry.type !== row.type) return fail('entry does not match its row')
    if (entry.prevHash !== prev || row.prev_hash !== prev) return fail('chain broken: previous hash does not match')
    if (hashEntry(entry) !== row.hash) return fail('entry altered: hash does not match')
    prev = row.hash
    expected += 1
  }
  return { ok: true, count: rows.length }
}

/**
 * Open (and create) the audit log. `file` overrides the default location;
 * `clock` is for tests.
 */
export function openAudit({ file, dir = defaultAuditDir(), clock = () => Date.now() } = {}) {
  let path = file
  if (!path) {
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'audit.db')
  }
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)')
  // Append-only, enforced by the database rather than by good intentions.
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END`)

  const stmt = {
    head: db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1'),
    put: db.prepare('INSERT INTO audit (seq, ts, type, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)'),
    all: db.prepare('SELECT seq, ts, type, data, prev_hash, hash FROM audit ORDER BY seq'),
    recent: db.prepare('SELECT data FROM audit ORDER BY seq DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM audit'),
  }

  return {
    path,
    /** Validate, chain and store one entry. Returns the stored entry. */
    append(input) {
      const body = normaliseEntry(input)
      const head = stmt.head.get()
      const entry = {
        seq: (head?.seq ?? 0) + 1,
        ts: clock(),
        ...body,
        prevHash: head?.hash ?? GENESIS,
      }
      const hash = hashEntry(entry)
      stmt.put.run(entry.seq, entry.ts, entry.type, JSON.stringify(entry), entry.prevHash, hash)
      return { ...entry, hash }
    },
    /** Check the whole chain. See verifyRows. */
    verify() {
      return verifyRows(stmt.all.all())
    },
    /** The newest entries, newest first. */
    recent(limit = 50) {
      const n = Math.max(1, Math.min(1000, Math.floor(limit) || 50))
      return stmt.recent.all(n).map((row) => JSON.parse(row.data))
    },
    count() {
      return stmt.count.get().n
    },
    close() {
      db.close()
    },
  }
}

/**
 * The function the policy engine and the bridge write through. A store that
 * is missing or fails never changes a decision — the call is decided exactly
 * as it would be without the log — but a failure is reported, never swallowed.
 */
export function auditSink(store, log = console) {
  if (!store) return () => {}
  return (entry) => {
    try {
      store.append(entry)
    } catch (err) {
      log?.error?.('[jarvis] audit entry not written:', err?.message ?? err)
    }
  }
}

/**
 * Wrap an approval function `(title, details) => Promise<boolean>` so the card
 * and its answer are both logged. `details` is never written: it can hold the
 * command or file contents the card is asking about.
 */
export function auditedApprove(approve, sink, actor) {
  if (!sink) return approve
  return async (title, details) => {
    const approvalId = randomUUID()
    sink({ type: 'approval', actor, approvalId, state: 'requested', title })
    let approved = false
    try {
      // The answer is passed back exactly as given; only the log reads it.
      const answer = await approve(title, details)
      approved = answer === true
      return answer
    } finally {
      sink({ type: 'approval', actor, approvalId, state: 'resolved', approved })
    }
  }
}
