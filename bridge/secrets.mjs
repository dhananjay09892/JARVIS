/**
 * Secrets in the operating system's own protected storage (plan 39 phase 3, task Q20).
 *
 * API keys and connector tokens never go into the settings database or any
 * other plain file. They live in one small "vault" — a JSON object of
 * name → value — that is handed to the OS to protect:
 *
 *   Windows  DPAPI (CurrentUser scope, the same protection Windows uses for
 *            saved browser passwords). The encrypted blob is kept beside the
 *            settings as `secrets.dpapi`; only this Windows account can open it.
 *   macOS    the login Keychain, one generic password (service "jarvis").
 *   Linux    the Secret Service (GNOME Keyring / KWallet) through `secret-tool`.
 *
 * When none of these is available (a Linux box without `secret-tool`, say),
 * the vault is "unavailable": reads return nothing and saving a secret fails
 * with a readable message. Nothing ever falls back to plain text. Environment
 * variables keep working, so a developer's shell still wins.
 *
 * Every backend runs a stock OS tool. The secret travels on that tool's
 * standard input or output, never on its command line (where other programs
 * could read it from the process list), and no value is ever put in an error
 * message, a log line or JSON output.
 *
 * Vault interface:
 *   get(name) → string | null      set(name, value)      delete(name)
 *   names(prefix?) → string[]      reload()              backend, available
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const NAME = /^[A-Za-z][\w./:-]{0,159}$/
const MAX_VALUE = 16_384
/** Service and account under which the vault is filed on macOS and Linux. */
export const SERVICE = 'jarvis'
export const ACCOUNT = 'vault'

/**
 * Run a program with `input` on stdin. Returns { status, stdout, missing }.
 * stderr is dropped on purpose: some tools echo their input there.
 */
export function runTool(cmd, args, input = '') {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '', missing: r.error?.code === 'ENOENT' }
}

function fail(backend, what, r) {
  const why = r?.missing ? 'the tool is not installed' : `exit code ${r?.status ?? 'unknown'}`
  return new Error(`Could not ${what} the secret store (${backend}: ${why}).`)
}

// ---------------------------------------------------------------- Windows

/** Fixed extra entropy, so another program's DPAPI blob is never mistaken for ours. */
const DPAPI_ENTROPY = 'JARVIS-secrets-v1'

function psScript(op) {
  // Reads base64 on stdin, writes base64 on stdout. No data in the script itself.
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$e = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    '$d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$o = [Security.Cryptography.ProtectedData]::${op}($d, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($o))',
  ].join('; ')
}

/** PowerShell's -EncodedCommand takes the script as base64 of UTF-16LE. */
export function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * DPAPI through Windows PowerShell 5.1 (present on every supported Windows).
 * @param {{ file: string, run?: typeof runTool, shell?: string }} opts
 */
export function dpapiBackend({ file, run = runTool, shell = 'powershell.exe' }) {
  const ps = (op, input) => run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(psScript(op))], input)
  return {
    name: 'dpapi',
    label: 'Windows protected storage (DPAPI)',
    load() {
      if (!existsSync(file)) return null
      const blob = readFileSync(file, 'utf8').trim()
      if (!blob) return null
      const r = ps('Unprotect', blob)
      if (r.status !== 0) throw fail('dpapi', 'open', r)
      return Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
    },
    save(text) {
      const r = ps('Protect', Buffer.from(text, 'utf8').toString('base64'))
      if (r.status !== 0 || !r.stdout.trim()) throw fail('dpapi', 'save to', r)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, r.stdout.trim(), { mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* Windows: the folder is per-user */ }
      renameSync(tmp, file)
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}

// ---------------------------------------------------------------- macOS

/**
 * The login Keychain through `security`. Commands go in on stdin (`security -i`)
 * so the value is never on a command line; it is stored hex-encoded (-X) and
 * holds base64, so `find-generic-password -w` always prints it back verbatim.
 */
export function macKeychainBackend({ run = runTool } = {}) {
  return {
    name: 'macos-keychain',
    label: 'macOS Keychain',
    load() {
      const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
      if (r.missing) throw fail('macos-keychain', 'open', r)
      if (r.status === 44) return null // errSecItemNotFound
      if (r.status !== 0) throw fail('macos-keychain', 'open', r)
      return Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
    },
    save(text) {
      const hex = Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8').toString('hex')
      const r = run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "JARVIS secrets" -X ${hex}\n`)
      if (r.status !== 0) throw fail('macos-keychain', 'save to', r)
    },
    clear() {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
    },
  }
}

// ---------------------------------------------------------------- Linux

/** The freedesktop Secret Service through `secret-tool` (libsecret). */
export function secretToolBackend({ run = runTool } = {}) {
  const attrs = ['service', SERVICE, 'account', ACCOUNT]
  return {
    name: 'secret-service',
    label: 'system keyring (Secret Service)',
    load() {
      const r = run('secret-tool', ['lookup', ...attrs])
      if (r.missing) throw fail('secret-service', 'open', r)
      if (r.status !== 0 || !r.stdout.trim()) return null // exit 1: nothing stored
      return Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
    },
    save(text) {
      const r = run('secret-tool', ['store', '--label=JARVIS secrets', ...attrs], Buffer.from(text, 'utf8').toString('base64'))
      if (r.status !== 0) throw fail('secret-service', 'save to', r)
    },
    clear() {
      run('secret-tool', ['clear', ...attrs])
    },
  }
}

/** Keeps the vault in this process only. For tests; nothing survives a restart. */
export function memoryBackend() {
  let text = null
  return {
    name: 'memory',
    label: 'memory only (not saved)',
    load: () => text,
    save: (t) => { text = t },
    clear: () => { text = null },
  }
}

/**
 * The backend for this computer, or null when there is none.
 * @param {{ platform?: string, file: string, run?: typeof runTool }} opts
 */
export function pickBackend({ platform = process.platform, file, run = runTool }) {
  if (platform === 'win32') return dpapiBackend({ file, run })
  if (platform === 'darwin') return macKeychainBackend({ run })
  // Linux and the rest: only if secret-tool exists. `--version` touches no secrets.
  const probe = run('secret-tool', ['--version'])
  return probe.missing ? null : secretToolBackend({ run })
}

// ---------------------------------------------------------------- the vault

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Bad secret name.')
}

/**
 * A vault over one backend. The decrypted object is cached in this process
 * after the first read; `reload()` reads it from the OS again.
 * @param {ReturnType<typeof memoryBackend> | null} backend
 */
export function createVault(backend) {
  let data = null

  const load = () => {
    if (data) return data
    if (!backend) return (data = {})
    const text = backend.load()
    let parsed = {}
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Never quote the text: it is the secrets.
        throw new Error(`The secret store (${backend.name}) holds something unreadable.`)
      }
    }
    data = parsed && typeof parsed.secrets === 'object' && parsed.secrets ? { ...parsed.secrets } : {}
    return data
  }

  const save = (next) => {
    if (!backend) {
      throw new Error('No secure storage for secrets was found on this computer, so the key was not saved. ' +
        'Set it as an environment variable instead, or install the system keyring (secret-tool).')
    }
    if (Object.keys(next).length) backend.save(JSON.stringify({ v: 1, secrets: next }))
    else backend.clear()
    data = next
  }

  const vault = {
    backend: backend?.name ?? 'unavailable',
    label: backend?.label ?? 'not available',
    available: Boolean(backend),
    get(name) {
      checkName(name)
      return Object.hasOwn(load(), name) ? load()[name] : null
    },
    set(name, value) {
      checkName(name)
      if (typeof value !== 'string' || !value.length) throw new Error('A secret must be a non-empty string.')
      if (value.length > MAX_VALUE) throw new Error('That secret is too long.')
      save({ ...load(), [name]: value })
    },
    delete(name) {
      checkName(name)
      const cur = load()
      if (!Object.hasOwn(cur, name)) return
      const next = { ...cur }
      delete next[name]
      save(next)
    },
    names(prefix = '') {
      return Object.keys(load()).filter((n) => n.startsWith(prefix)).sort()
    },
    reload() {
      data = null
      load()
    },
    toJSON: () => ({ backend: vault.backend }),
    [Symbol.for('nodejs.util.inspect.custom')]: () => `SecretVault<${vault.backend}>`,
  }
  return Object.freeze(vault)
}

/**
 * The connector credential store's keychain backend (bridge/connectors/credentials.mjs):
 * get/set/delete/keys per connector, filed in the vault as `connector/<id>/<key>`.
 */
export function connectorKeychain(vault) {
  const name = (id, key) => `connector/${id}/${key}`
  return {
    get: (id, key) => vault.get(name(id, key)) ?? undefined,
    set: (id, key, value) => vault.set(name(id, key), value),
    delete: (id, key) => vault.delete(name(id, key)),
    keys: (id) => vault.names(`connector/${id}/`).map((n) => n.slice(`connector/${id}/`.length)),
  }
}
