/**
 * The Coder's tools: changes to a repository, made only inside a git
 * worktree of its own.
 *
 * A Coder run (bridge/agents/coder.md) never touches the owner's checkout.
 * `open_worktree` makes a new branch (`jarvis-coder/<task id>`) and checks it
 * out in a folder of the run's own under the JARVIS data folder
 * (`<data>/worktrees/<task id>`). Every other tool works in that folder and
 * nowhere else:
 *
 *   - files: list, read, write and delete, through the same path rules as the
 *     workspace tools (workspace.mjs): relative paths only, no `..`, no links
 *     or junctions, no Git metadata, no environment files;
 *   - git: status and a diff against where the branch started (reads), and a
 *     local commit, with the repository's hooks switched off so a commit never
 *     runs code the run wrote;
 *   - tests: one of the project's own npm scripts (`test`, `test:*`, `lint`,
 *     `typecheck`, `check`). It runs code from the repository, which the run
 *     may have changed, and nothing here is an OS sandbox, so it asks the owner
 *     every time and the card shows the exact script;
 *   - a pull request: pushes the branch and opens a pull request with the
 *     GitHub CLI. That is the one action that leaves the machine. The policy
 *     engine only lets the built-in Coder ask for it, only with general writes
 *     on (policy.mjs), and the owner approves each one on a card that shows the
 *     remote, the branch, the commits and the text. Nothing is ever forced.
 *
 * Git's own credentials do the push; the run never sees them, and commands
 * get a short list of environment variables, not the bridge's.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'
import { workspaceFiles, WORKSPACE_ROOT } from './workspace.mjs'
import { settingsDir } from './settings.mjs'
import { CODER_SERVER, CODER_TOOL_NAMES, CODER_PR_TOOL } from './policy.mjs'

export { CODER_SERVER, CODER_TOOL_NAMES, CODER_PR_TOOL }

/** Where the Coder's worktrees live: the JARVIS data folder, never the owner's checkout. */
export const coderWorktreesDir = (env = process.env) => join(settingsDir(env), 'worktrees')

/** The branch a task's worktree is on. */
export const coderBranch = (taskId) => `jarvis-coder/${taskId}`

/** npm scripts the Coder may ask to run: the project's checks, nothing else. */
export const TEST_SCRIPT = /^(?:test|lint|typecheck|check)(?::[A-Za-z0-9_-]{1,40}){0,3}$/

const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/
const REF = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_OUTPUT = 12_000
const MAX_DIFF = 64 * 1024
const GIT_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 10 * 60_000
const PUSH_TIMEOUT_MS = 120_000

/** Keep the end of long output, where test runners put the summary. */
const tail = (s, n = MAX_OUTPUT) => {
  const text = String(s ?? '')
  return text.length > n ? `…${text.slice(-n)}` : text
}
const head = (s, n) => {
  const text = String(s ?? '')
  return text.length > n ? `${text.slice(0, n)}\n… (cut at ${n} characters)` : text
}
/** A remote URL as a card may show it: never with a user name or password in it. */
export const safeRemoteUrl = (url) => String(url ?? '').trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')

/**
 * The environment a command gets: enough to find the tools and the owner's
 * git settings and credential helper, never the bridge's own variables.
 */
const ENV_KEYS = [
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'USER', 'USERNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK',
]
export function commandEnv(env = process.env) {
  const out = {}
  for (const key of ENV_KEYS) if (typeof env?.[key] === 'string' && env[key]) out[key] = env[key]
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

/**
 * Run a program with arguments (no shell). Resolves to { code, stdout, stderr }
 * whatever the exit code; rejects only when it could not be started.
 */
export function runProgram(file, args, { cwd, env, timeout = GIT_TIMEOUT_MS, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env, shell: false, windowsHide: true, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        if (err.killed) return resolve({ code: 124, stdout: String(stdout ?? ''), stderr: `${stderr ?? ''}\nStopped: it ran too long.` })
        return reject(err)
      }
      resolve({ code: err ? err.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

/**
 * One task's worktree and what the Coder can do in it.
 *
 * @param {object} o
 * @param {string} o.taskId the task this worktree belongs to
 * @param {string} [o.worktreesDir] where worktrees go (coderWorktreesDir())
 * @param {string} [o.workspaceRoot] where the owner's repositories are (WORKSPACE_ROOT)
 * @param {(title: string, details: string) => Promise<boolean>} [o.approve] the run's approval card
 * @param {Function} [o.run] runProgram, injectable for tests
 * @param {object} [o.env] the environment commands are built from
 * @param {string} [o.platform]
 */
export function createCoderWorkspace({
  taskId,
  worktreesDir = coderWorktreesDir(),
  workspaceRoot = WORKSPACE_ROOT,
  approve = async () => false,
  run = runProgram,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Error('A Coder worktree needs a task id.')
  const childEnv = commandEnv(env)
  const branch = coderBranch(taskId)
  const dir = join(worktreesDir, taskId)
  const metaFile = join(worktreesDir, `${taskId}.json`)
  const noHooks = join(worktreesDir, '.no-hooks')
  /** Options that keep a git command from running anything the worktree holds. */
  const safe = ['-c', `core.hooksPath=${noHooks}`, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false']
  let state = null
  let files = null

  const git = async (args, { cwd = dir, timeout = GIT_TIMEOUT_MS, ok = true } = {}) => {
    const r = await run('git', [...safe, ...args], { cwd, env: childEnv, timeout })
    if (ok && r.code !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr || r.stdout, 400).trim()}`)
    return r
  }

  /** The worktree as a previous attempt of this task left it, if there is one. */
  function restore() {
    if (state) return state
    if (!existsSync(metaFile) || !existsSync(dir)) return null
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (meta?.taskId !== taskId || typeof meta.repo !== 'string' || typeof meta.baseSha !== 'string') return null
      state = { repo: meta.repo, repoDir: meta.repoDir, baseRef: meta.baseRef, baseSha: meta.baseSha }
      files = workspaceFiles(dir)
      return state
    } catch {
      return null
    }
  }

  function need() {
    const s = restore()
    if (!s) throw new Error('Open a worktree first with open_worktree.')
    return s
  }

  return {
    taskId,
    branch,
    dir,
    get state() { return restore() ? { ...state, branch, dir } : null },

    /**
     * Make (or reopen) this task's worktree for a repository under the
     * owner's workspace folder. One repository per task.
     */
    async open({ repo, base } = {}) {
      const repoPath = await workspaceFiles(workspaceRoot).directory(String(repo ?? ''))
      const existing = restore()
      if (existing) {
        if (existing.repoDir !== repoPath) throw new Error(`This task already has a worktree for ${existing.repo}; a task works on one repository.`)
        return { repo: existing.repo, branch, base: existing.baseRef, worktree: dir, reopened: true }
      }
      mkdirSync(noHooks, { recursive: true })
      if (inside(realpathSync(worktreesDir), repoPath)) throw new Error('Pick one of your repositories, not a Coder worktree.')
      const top = (await git(['rev-parse', '--show-toplevel'], { cwd: repoPath, ok: false }))
      if (top.code !== 0 || realpathSync(top.stdout.trim()) !== repoPath) {
        throw new Error('That folder is not the top of a git repository.')
      }
      let baseRef = typeof base === 'string' && base.trim() ? base.trim() : ''
      if (!baseRef) {
        const cur = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath, ok: false })
        baseRef = cur.code === 0 ? cur.stdout.trim() : 'HEAD'
      }
      if (!REF.test(baseRef) || baseRef.startsWith('-') || baseRef.endsWith('.lock')) throw new Error('That base branch name is not allowed.')
      const sha = await git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { cwd: repoPath, ok: false })
      if (sha.code !== 0) throw new Error(`There is no branch or commit called ${baseRef} in that repository.`)
      const baseSha = sha.stdout.trim()
      const taken = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath, ok: false })
      if (taken.code === 0) throw new Error(`The branch ${branch} already exists in that repository; JARVIS will not reuse it.`)
      await git(['worktree', 'add', '-b', branch, dir, baseSha], { cwd: repoPath })
      const repoName = relative(workspaceRoot, repoPath).split(/[\\/]/).join('/') || String(repo)
      state = { repo: repoName, repoDir: repoPath, baseRef, baseSha }
      writeFileSync(metaFile, JSON.stringify({ taskId, ...state, branch, createdAt: new Date().toISOString() }, null, 2))
      files = workspaceFiles(dir)
      return { repo: repoName, branch, base: baseRef, worktree: dir, reopened: false }
    },

    async list(path = '.') { need(); return files.list(path) },
    async read(path) { need(); return files.read(path) },
    async write(path, content, expectedSha256) { need(); return files.write(path, content, expectedSha256) },
    async remove(path, expectedSha256) {
      need()
      await files.read(path)
      return files.delete(path, expectedSha256)
    },

    /** Changed files on the branch: committed since the base, and not yet committed. */
    async status() {
      const s = need()
      const st = await git(['status', '--porcelain=v1', '--untracked-files=all'])
      const ahead = await git(['rev-list', '--count', `${s.baseSha}..HEAD`])
      return { branch, base: s.baseRef, commits: Number(ahead.stdout.trim()) || 0, changes: st.stdout.split('\n').filter(Boolean).slice(0, 200) }
    },

    /** The branch against its base, committed or not (new files show in status). */
    async diff() {
      const s = need()
      const stat = await git(['diff', '--no-ext-diff', '--no-textconv', '--stat', s.baseSha])
      const patch = await git(['diff', '--no-ext-diff', '--no-textconv', s.baseSha])
      return { base: s.baseRef, stat: stat.stdout.trim(), patch: head(patch.stdout, MAX_DIFF) }
    },

    /** Commit everything in the worktree on its branch. Local only. */
    async commit(message) {
      need()
      const text = String(message ?? '').trim()
      if (!text) throw new Error('Write a commit message.')
      await git(['add', '-A'])
      const staged = await git(['diff', '--cached', '--quiet'], { ok: false })
      if (staged.code === 0) return { committed: false, note: 'Nothing to commit.' }
      const who = await git(['config', 'user.email'], { ok: false })
      const identity = who.code === 0 && who.stdout.trim() ? [] : ['-c', 'user.name=JARVIS Coder', '-c', 'user.email=jarvis-coder@localhost']
      await git([...identity, 'commit', '--no-verify', '--quiet', '-m', head(text, 2000)])
      const sha = await git(['rev-parse', 'HEAD'])
      return { committed: true, commit: sha.stdout.trim(), branch }
    },

    /** Run one of the project's npm check scripts, once the owner approves it. */
    async test(script = 'test') {
      const s = need()
      const name = String(script ?? 'test').trim() || 'test'
      if (!TEST_SCRIPT.test(name)) throw new Error('Only the project\'s test, lint, typecheck or check scripts can be run.')
      let pkg
      try {
        pkg = JSON.parse((await files.read('package.json')).content)
      } catch {
        throw new Error('Running tests needs a package.json with that script; this repository has none JARVIS can read.')
      }
      const body = pkg?.scripts?.[name]
      if (typeof body !== 'string' || !body.trim()) throw new Error(`package.json has no "${name}" script.`)
      const changed = (await git(['diff', '--quiet', s.baseSha, '--', 'package.json'], { ok: false })).code !== 0
      const command = `npm run ${name}`
      const card = [
        `Repository: ${s.repo} (branch ${branch})`,
        `Worktree: ${dir}`,
        `Command: ${command}`,
        `The script runs: ${head(body, 600)}`,
        ...(changed ? ['Warning: this task changed package.json. Read the script above carefully.'] : []),
        'The Coder may have changed the code this runs. It runs under your account, not in a sandbox.',
      ].join('\n\n')
      if (!await approve('Run the project\'s tests', card)) throw new Error('Running the tests was not approved.')
      const [file, args] = platform === 'win32'
        ? [childEnv.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]
        : ['npm', ['run', name]]
      const r = await run(file, args, { cwd: dir, env: childEnv, timeout: TEST_TIMEOUT_MS })
      return { script: name, passed: r.code === 0, exitCode: r.code, output: tail(`${r.stdout}\n${r.stderr}`.trim()) }
    },

    /**
     * Push the branch and open a pull request, once the owner approves the
     * card. Never forced; refuses uncommitted work and an empty branch.
     */
    async pullRequest({ title, body = '', remote = 'origin', draft = false } = {}) {
      const s = need()
      const heading = String(title ?? '').trim()
      if (!heading) throw new Error('A pull request needs a title.')
      if (!REMOTE.test(String(remote))) throw new Error('That remote name is not allowed.')
      const dirty = await git(['status', '--porcelain=v1', '--untracked-files=all'])
      if (dirty.stdout.trim()) throw new Error('Commit or remove the uncommitted changes first.')
      const log = await git(['log', '--oneline', '--no-decorate', '-n', '20', `${s.baseSha}..HEAD`])
      if (!log.stdout.trim()) throw new Error('There are no commits on this branch to open a pull request for.')
      const url = await git(['remote', 'get-url', remote], { ok: false })
      if (url.code !== 0) throw new Error(`The repository has no remote called ${remote}.`)
      const stat = await git(['diff', '--no-ext-diff', '--shortstat', s.baseSha, 'HEAD'])
      const prBase = s.baseRef === 'HEAD' ? null : (s.baseRef.startsWith(`${remote}/`) ? s.baseRef.slice(remote.length + 1) : s.baseRef)
      const text = head(String(body ?? '').trim(), 4000)
      const card = [
        `Repository: ${s.repo}`,
        `Push to: ${remote} (${safeRemoteUrl(url.stdout)})`,
        `Branch: ${branch} into ${prBase ?? 'the default branch'}`,
        `Commits:\n${log.stdout.trim()}`,
        `Changes: ${stat.stdout.trim() || 'none'}`,
        `Title: ${head(heading, 200)}`,
        `Description:\n${text || '(none)'}`,
        'This pushes the branch and opens a pull request in your name.',
      ].join('\n\n')
      if (!await approve('Open a pull request', card)) throw new Error('The pull request was not approved.')
      await git(['push', '--no-verify', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeout: PUSH_TIMEOUT_MS })
      const args = ['pr', 'create', '--head', branch, '--title', head(heading, 200), '--body', text, ...(prBase ? ['--base', prBase] : []), ...(draft ? ['--draft'] : [])]
      let pr
      try {
        pr = await run('gh', args, { cwd: dir, env: childEnv, timeout: PUSH_TIMEOUT_MS })
      } catch (err) {
        pr = { code: -1, stdout: '', stderr: String(err?.message ?? err) }
      }
      const link = pr.code === 0 ? (pr.stdout.match(/https:\/\/\S+/g) ?? []).at(-1) ?? null : null
      if (link) return { pushed: true, branch, pullRequest: link }
      return {
        pushed: true,
        branch,
        pullRequest: null,
        note: `The branch is pushed, but the pull request could not be opened here (${tail(pr.stderr || pr.stdout, 200).trim() || 'GitHub CLI unavailable'}). Open it on GitHub.`,
      }
    },
  }
}

/**
 * The Coder's MCP server for one run. `workspace` is that run's
 * createCoderWorkspace(); with none (the tool catalogue), every call refuses.
 */
export function coderServer(workspace = null) {
  const handle = (operation) => async (args) => {
    try {
      if (!workspace) throw new Error('The Coder tools only work inside a Coder task.')
      return { content: [{ type: 'text', text: JSON.stringify(await operation(args ?? {})) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Coder: ${err?.message ?? err}` }] }
    }
  }
  const sha = z.string().regex(/^[a-f0-9]{64}$/)
  const defs = {
    open_worktree: tool('open_worktree', `Make this task's own git worktree and branch for one repository in the owner's workspace (${WORKSPACE_ROOT}). Call it first. "repo" is the repository folder relative to the workspace; "base" is the branch to start from (default: the repository's current branch).`,
      { repo: z.string().min(1).max(200), base: z.string().max(100).optional() }, handle(({ repo, base }) => workspace.open({ repo, base }))),
    list_files: tool('list_files', 'List a folder in your worktree (relative path, "." for the top).',
      { path: z.string().default('.') }, handle(({ path }) => workspace.list(path))),
    read_file: tool('read_file', 'Read a text file in your worktree; returns its SHA-256 for editing.',
      { path: z.string() }, handle(({ path }) => workspace.read(path))),
    write_file: tool('write_file', 'Create or change a text file in your worktree. To change a file, pass the SHA-256 from read_file.',
      { path: z.string(), content: z.string(), expectedSha256: sha.optional() }, handle(({ path, content, expectedSha256 }) => workspace.write(path, content, expectedSha256))),
    delete_file: tool('delete_file', 'Delete one text file in your worktree. Read it first and pass its SHA-256.',
      { path: z.string(), expectedSha256: sha }, handle(({ path, expectedSha256 }) => workspace.remove(path, expectedSha256))),
    git_status: tool('git_status', 'What has changed on your branch: commits since the base and uncommitted files.',
      {}, handle(() => workspace.status())),
    git_diff: tool('git_diff', 'Your branch against its base, as a diff.',
      {}, handle(() => workspace.diff())),
    git_commit: tool('git_commit', 'Commit everything in your worktree to your branch, locally. Nothing is pushed.',
      { message: z.string().min(1).max(2000) }, handle(({ message }) => workspace.commit(message))),
    run_tests: tool('run_tests', 'Run one of the project\'s npm scripts (test, test:*, lint, typecheck, check) in your worktree. The owner approves each run.',
      { script: z.string().max(80).default('test') }, handle(({ script }) => workspace.test(script))),
    open_pull_request: tool('open_pull_request', 'Ask the owner to push your branch and open a pull request. Only when the work is committed and the tests pass. Each one needs the owner\'s approval and may be switched off.',
      { title: z.string().min(1).max(200), body: z.string().max(4000).default(''), remote: z.string().max(64).default('origin'), draft: z.boolean().default(false) },
      handle(({ title, body, remote, draft }) => workspace.pullRequest({ title, body, remote, draft }))),
  }
  return createSdkMcpServer({
    name: CODER_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    instructions: 'Work only in your own worktree: open it with open_worktree, then read, edit, run the tests, commit. Paths are relative to the worktree. Running tests and opening a pull request ask the owner each time.',
    tools: CODER_TOOL_NAMES.map((n) => defs[n]),
  })
}
