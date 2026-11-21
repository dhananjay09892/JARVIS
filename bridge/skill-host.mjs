/**
 * The tools a skill's steps can call on this computer (plan 19, phase 4):
 * `Read`, `Grep` and `Write`, confined to one folder, `<settings>/skill-files/`.
 * A skill's relative paths ("notes/today.md") mean paths under that folder.
 *
 * The folder is the only place skills touch. A path is refused when it is
 * absolute, has a `..`, a NUL, or resolves (through a link) outside the
 * folder. Writes make the folder as needed, write one file of at most 64 KB
 * and never overwrite outside it. Whether a write runs at all is the policy
 * engine's decision, made before a handler is reached (skill-runner.mjs).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { settingsDir } from './settings.mjs'

export const skillFilesDir = (env = process.env) => join(settingsDir(env), 'skill-files')
const MAX_READ = 64 * 1024
const MAX_MATCHES = 200

export function createSkillHost({ root = skillFilesDir() } = {}) {
  const base = resolve(root)
  const inside = (p) => p === base || p.startsWith(base + sep)

  function locate(rel, { mustExist }) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('That path is not allowed for skills.')
    const full = resolve(base, rel)
    if (!inside(full)) throw new Error('That path is not allowed for skills.')
    if (existsSync(full)) {
      if (!inside(realpathSync(full))) throw new Error('That path is not allowed for skills.')
    } else if (mustExist) {
      throw new Error('That file does not exist.')
    }
    return full
  }

  const readText = (rel) => {
    const full = locate(rel, { mustExist: true })
    if (!statSync(full).isFile()) throw new Error('That is not a file.')
    return readFileSync(full, 'utf8').slice(0, MAX_READ)
  }

  return {
    root: base,
    tools: {
      Read: (i) => readText(i.file_path),
      Grep: (i) => {
        if (typeof i.pattern !== 'string' || i.pattern.length > 200) throw new Error('Give a short pattern.')
        let re
        try { re = new RegExp(i.pattern) } catch { throw new Error('That pattern is not valid.') }
        const lines = readText(i.path ?? i.file_path).split('\n')
        return lines.filter((l) => re.test(l)).slice(0, MAX_MATCHES).join('\n')
      },
      Write: (i) => {
        if (typeof i.content !== 'string' || i.content.length > MAX_READ) throw new Error('The content is too large.')
        const full = locate(i.file_path, { mustExist: false })
        mkdirSync(dirname(full), { recursive: true })
        // The folder may have been made through a link since the check above.
        if (!inside(realpathSync(dirname(full)))) throw new Error('That path is not allowed for skills.')
        writeFileSync(full, i.content)
        return `Saved ${i.file_path}.`
      },
    },
  }
}
