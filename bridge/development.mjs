import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'
import { workspaceFiles, WORKSPACE_ROOT } from './workspace.mjs'

export async function approvedCommand({ cwd, command }, approve, {
  files = workspaceFiles(),
  execute = execFile,
  env = process.env,
} = {}) {
  const directory = await files.directory(cwd)
  if (!await approve('Run Windows command', [
    `Working directory: ${directory}`,
    'This runs under your Windows account, not in a sandbox.',
    'It may change files, install software, access credentials, or push to GitHub.',
    'Approve only if you understand the entire command:',
    command,
  ].join('\n\n'))) throw new Error('Command was not approved.')

  const childEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) childEnv[key] = env[key]
  }
  return new Promise((resolve, reject) => {
    execute(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop';\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`],
      { cwd: directory, env: childEnv, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Command failed (${err.code ?? err.message}).\n${stdout}\n${stderr}`))
        } else {
          resolve({ stdout, stderr, status: 'completed' })
        }
      })
  })
}

export function developmentServer(approve) {
  const run = async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await approvedCommand(args, approve)) }] }
    } catch (err) {
      console.error('[jarvis] approved command failed:', err)
      return { isError: true, content: [{ type: 'text', text: err.message }] }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_development',
    version: '1.0.0',
    alwaysLoad: true,
    instructions: `Run development commands only when needed for the owner's task. Use a relative working directory under ${WORKSPACE_ROOT}. Every command requires a separate approval; never hide extra actions inside a command or bypass approval with other tools. For GitHub pushes use push_branch with an explicit remote and destination branch, not a bare git push or an opaque script.`,
    tools: [
      tool('run_command', 'Request owner approval for an exact PowerShell development command, including builds, installs, Git operations or pushes. No command executes until approved in JARVIS. The working directory is not an OS sandbox. Prefer workspace file tools for edits.',
        { cwd: z.string(), command: z.string().min(1).max(8000) },
        run),
      tool('push_branch', 'Request owner approval to push HEAD from an explicit local repository to an explicit configured remote and destination branch. The complete command and repository path appear on the approval card. Force pushing is not offered.',
        {
          cwd: z.string(),
          remote: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
          branch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
        },
        ({ cwd, remote, branch }) => run({ cwd, command: `git push '${remote}' 'HEAD:${branch}'` })),
    ],
  })
}
