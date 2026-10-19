/**
 * Locate and drive the Claude Code binary.
 *
 * The Agent SDK ships a platform binary as an optional dependency
 * (@anthropic-ai/claude-agent-sdk-win32-x64 and friends), so an installed
 * JARVIS carries its own Claude Code and the user only has to sign in. A
 * `claude` already on PATH is the fallback for source checkouts.
 */
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)

export function claudeBinary() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`
  try {
    return require.resolve(pkg)
  } catch {
    return null
  }
}

const bin = () => claudeBinary() ?? 'claude'
const viaShell = () => bin() === 'claude' && process.platform === 'win32'

/** { installed, version, loggedIn } — never throws. */
export function claudeStatus() {
  const out = { installed: false, version: '', loggedIn: false }
  try {
    const v = spawnSync(bin(), ['--version'], { encoding: 'utf8', timeout: 15000, shell: viaShell() })
    out.installed = v.status === 0
    out.version = (v.stdout ?? '').trim()
    if (!out.installed) return out
    const a = spawnSync(bin(), ['auth', 'status'], { encoding: 'utf8', timeout: 15000, shell: viaShell() })
    out.loggedIn = Boolean(JSON.parse(a.stdout || '{}').loggedIn)
  } catch {
    /* report what we have */
  }
  return out
}

/** Start the browser sign-in flow. Returns immediately; the user finishes in the browser. */
export function startClaudeLogin() {
  const child = spawn(bin(), ['auth', 'login'], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    shell: viaShell(),
  })
  child.on('error', () => {})
  child.unref()
}
