import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from './sdk-server.mjs'
import { z } from 'zod'

export const APPROVED_APPS = ['vscode', 'chrome', 'notepad', 'calculator']

export function applicationPaths(app, env) {
  const locations = {
    vscode: [
      [env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'],
      [env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'],
      [env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'],
    ],
    chrome: [
      [env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ],
    notepad: [[env.SystemRoot, 'System32', 'notepad.exe']],
    calculator: [[env.SystemRoot, 'System32', 'calc.exe']],
  }
  if (!APPROVED_APPS.includes(app)) throw new Error('Application is not approved.')
  return locations[app].filter(([root]) => root).map((parts) => join(...parts))
}

export async function launchApplication(app, {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  spawnProcess = spawn,
} = {}) {
  if (platform !== 'win32') throw new Error('Application launching requires Windows.')
  const executable = applicationPaths(app, env).find((path) => exists(path))
  if (!executable) throw new Error(`${app} was not found in its standard Windows installation locations.`)
  await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, [], {
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return `Launch request sent to ${app}. This does not verify that its window is ready.`
}

export function appsServer() {
  return createSdkMcpServer({
    name: 'jarvis_apps',
    version: '1.0.0',
    alwaysLoad: true,
    instructions: 'Launch approved Windows applications only when the user explicitly asks. This tool cannot control their windows or execute commands.',
    tools: [
      tool(
        'launch_app',
        'Open VS Code, Google Chrome, Notepad, or Calculator on this Windows computer. Only launch an app explicitly requested by the user. No file paths, URLs, commands, or arguments are accepted.',
        { app: z.enum(['vscode', 'chrome', 'notepad', 'calculator']) },
        async ({ app }) => {
          try {
            return { content: [{ type: 'text', text: await launchApplication(app) }] }
          } catch (err) {
            console.error('[jarvis] application launch failed:', err)
            return {
              isError: true,
              content: [{ type: 'text', text: `Application launch failed: ${err.message}` }],
            }
          }
        },
      ),
    ],
  })
}
