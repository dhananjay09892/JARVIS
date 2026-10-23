import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from './task-store.mjs'
import { createTaskManager } from './tasks.mjs'

const silent = { error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const idleAgent = () => (async function* () { await new Promise(() => {}) })()

/** A temp folder, and a way to open stores in it that are all closed before it is removed. */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-tasks-'))
  const opened = []
  const open = () => { const s = openTaskStore({ dir }); opened.push(s); return s }
  return Promise.resolve(fn(open)).finally(() => {
    for (const s of opened) { try { s.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true })
  })
}

test('finished tasks come back after a restart, and a running one is marked interrupted', () => withDir(async (open) => {
  const store = open()
  let runs = 0
  const first = createTaskManager({
    store, log: silent,
    runAgent: () => {
      runs += 1
      return runs === 1
        ? (async function* () { yield { t: 'text', delta: 'all good' }; yield { t: 'usage', inTokens: 1, outTokens: 1, costUsd: 0.01 }; yield { t: 'done', reason: 'complete' } })()
        : idleAgent()
    },
  })
  const done = first.spawn({ title: 'Done one', goal: 'g' }).task.id
  await tick(); await tick()
  const live = first.spawn({ title: 'Still going', goal: 'g' }).task.id
  await tick()
  assert.equal(first.get(live).status, 'running')

  const second = createTaskManager({ store: open(), log: silent, runAgent: idleAgent })
  assert.equal(second.get(done).status, 'done')
  assert.equal(second.get(done).result, 'all good')
  assert.equal(second.get(live).status, 'interrupted')
  assert.match(second.get(live).error, /restarted/)
  assert.equal(second.list().length, 2)
  assert.equal(second.cancel(live).ok, false)

  // The interrupted verdict itself is saved, so a third start does not redo it.
  const third = createTaskManager({ store: open(), log: silent, runAgent: idleAgent })
  assert.equal(third.get(live).status, 'interrupted')
}))

test('dismiss removes an ended task from memory and disk; a live task refuses', () => withDir(async (open) => {
  const store = open()
  const m = createTaskManager({ store, log: silent, runAgent: () => (async function* () { yield { t: 'text', delta: 'x' }; yield { t: 'done', reason: 'complete' } })() })
  const gone = []
  m.subscribe((f) => f.type === 'task_removed' && gone.push(f.id))
  const id = m.spawn({ title: 'a', goal: 'g' }).task.id
  await tick(); await tick()
  assert.equal(m.dismiss(id).ok, true)
  assert.deepEqual(gone, [id])
  assert.equal(m.get(id), null)
  assert.equal(store.load().length, 0)
  assert.equal(m.dismiss('nope').ok, false)

  const idle = createTaskManager({ store, log: silent, runAgent: idleAgent })
  const live = idle.spawn({ title: 'b', goal: 'g' }).task.id
  await tick()
  assert.equal(idle.dismiss(live).ok, false)
}))

test('secrets are filtered before anything is written to disk', () => withDir(async (open) => {
  const store = open()
  const m = createTaskManager({ store, log: silent, runAgent: () => (async function* () { yield { t: 'text', delta: 'key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }; yield { t: 'done', reason: 'complete' } })() })
  m.spawn({ title: 'leak', goal: 'use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })
  await tick(); await tick()
  const raw = JSON.stringify(store.load())
  assert.ok(!raw.includes('abcdefghijklmnopqrstuvwxyz0123456789'))
  assert.ok(raw.includes('[redacted]'))
}))

test('a broken store never stops a task', async () => {
  const store = { save() { throw new Error('disk full') }, load: () => [], remove() {} }
  const m = createTaskManager({ store, log: silent, runAgent: () => (async function* () { yield { t: 'text', delta: 'fine' }; yield { t: 'done', reason: 'complete' } })() })
  const id = m.spawn({ title: 'a', goal: 'g' }).task.id
  await tick(); await tick()
  assert.equal(m.get(id).status, 'done')
})
