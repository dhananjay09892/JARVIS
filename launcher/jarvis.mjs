/**
 * The installed app's entry point (started by JARVIS.vbs, no console window).
 *
 * Starts the bridge if it is not already running, waits until it answers, then
 * opens JARVIS in its own Chrome/Edge app window with a private browser profile
 * (so the microphone permission is remembered). When that window is closed the
 * bridge it started is stopped again. When the bridge exits to apply settings
 * (the Settings "Restart" button, plan 39 phase 4) it is started again.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 8787 // the UI's CSP and default bridge address are built around this
const ORIGIN = `http://localhost:${PORT}`
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.JARVIS_HOME || join(process.env.APPDATA || '', 'JARVIS')
const logDir = join(dataDir, 'logs')
mkdirSync(logDir, { recursive: true })

function alertUser(message) {
  const text = message.replace(/'/g, "''")
  const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'JARVIS')`
  spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true })
}

const healthy = async () => {
  try {
    return (await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

function findBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  const candidates = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']
  for (const rel of candidates) {
    for (const root of roots) if (existsSync(join(root, rel))) return join(root, rel)
  }
  return null
}

/** Keep in step with RESTART_EXIT_CODE in bridge/restart.mjs. */
const RESTART_EXIT_CODE = 75

let bridge = null
function startBridge() {
  const log = openSync(join(logDir, 'bridge.log'), 'a')
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: appDir,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // JARVIS_SUPERVISED: this launcher starts the bridge again after a restart.
    env: { ...process.env, JARVIS_BRIDGE_PORT: String(PORT), JARVIS_SUPERVISED: '1' },
  })
  child.on('exit', (code) => {
    if (bridge !== child) return
    bridge = code === RESTART_EXIT_CODE ? startBridge() : null
  })
  return child
}

if (!(await healthy())) {
  bridge = startBridge()
  let up = false
  for (let i = 0; i < 60 && !up && bridge; i++) {
    up = await healthy()
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  if (!up) {
    bridge?.kill()
    alertUser(`JARVIS could not start. Details are in ${join(logDir, 'bridge.log')}`)
    process.exit(1)
  }
}

const browser = findBrowser()
if (!browser) {
  // No Chrome/Edge in the usual places: use the default browser and keep the bridge up.
  spawn('cmd', ['/c', 'start', '', ORIGIN], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  process.exit(0)
}

const started = Date.now()
const win = spawn(
  browser,
  [
    `--app=${ORIGIN}`,
    `--user-data-dir=${join(dataDir, 'browser')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
  ],
  { stdio: 'ignore' },
)
win.on('exit', () => {
  // A very early exit means the browser handed off to another process; leave the bridge running.
  if (bridge && Date.now() - started > 5000) bridge.kill()
  process.exit(0)
})
