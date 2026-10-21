/**
 * Where finished and in-flight tasks are remembered across a bridge restart.
 *
 * Only what the board shows is stored — title, goal, steps, log, result — never
 * anything a running agent holds in memory. Text is run through the same
 * secret filter as memory before it touches disk, so a token an agent happened
 * to read does not end up in a database. A task that was still running when the
 * bridge stopped is not resumed (its agent is gone); the manager marks it
 * interrupted on the next start.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { redact, defaultMemoryDir } from './memory.mjs'

const clean = (s) => redact(s).text

/** The snapshot with every free-text field filtered. */
function scrub(t) {
  return {
    ...t,
    title: clean(t.title),
    goal: clean(t.goal),
    note: clean(t.note),
    question: clean(t.question),
    result: clean(t.result),
    error: clean(t.error),
    steps: t.steps.map((s) => ({ ...s, label: clean(s.label) })),
    log: t.log.map((l) => ({ ...l, text: clean(l.text) })),
  }
}

export function openTaskStore({ file, dir = defaultMemoryDir() } = {}) {
  let path = file
  if (!path) {
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'jarvis-tasks.sqlite')
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    );
  `)
  const upsert = db.prepare(`
    INSERT INTO tasks (id, created_at, body) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body
  `)
  const all = db.prepare('SELECT body FROM tasks ORDER BY created_at')
  const del = db.prepare('DELETE FROM tasks WHERE id = ?')
  return {
    path,
    save(task, createdAt) {
      upsert.run(task.id, createdAt, JSON.stringify(scrub(task)))
    },
    load() {
      return all.all().flatMap((r) => {
        try { return [JSON.parse(r.body)] } catch { return [] }
      })
    },
    remove: (id) => void del.run(id),
    close: () => db.close(),
  }
}
