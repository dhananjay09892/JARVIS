/**
 * Open a web address in the user's own browser (task Q55: Sign in with
 * ChatGPT must use the system browser, never a page inside JARVIS).
 *
 * Only https addresses on hosts the caller allows are opened, and never
 * through a shell: the address is one argument to a stock OS program, so
 * characters like `&` in a query string cannot run anything.
 *
 *   Windows  rundll32 url.dll,FileProtocolHandler <url>
 *   macOS    open <url>
 *   Linux    xdg-open <url>
 */
import { spawn as nodeSpawn } from 'node:child_process'

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  return { cmd: 'xdg-open', args: [url] }
}

/**
 * @param {string} href
 * @param {{ hosts: string[], platform?: string, spawn?: typeof nodeSpawn }} opts
 * @returns {Promise<boolean>} true once the browser program started
 */
export function openUrl(href, { hosts, platform = process.platform, spawn = nodeSpawn }) {
  let u
  try {
    u = new URL(href)
  } catch {
    return Promise.reject(new Error('Not a web address.'))
  }
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) {
    return Promise.reject(new Error(`Only https addresses on ${hosts.join(', ')} are opened.`))
  }
  const { cmd, args } = browserCommand(u.href, platform)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false })
    } catch {
      return resolve(false)
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref?.()
      resolve(true)
    })
  })
}
