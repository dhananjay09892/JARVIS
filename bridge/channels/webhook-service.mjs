/**
 * The webhook sender inside the bridge (task C103; plan 20). webhook.mjs is
 * the sender (C47); this module is what server.mjs holds:
 *
 * - a small target list on disk (name, https URL, pre-approve flag; no
 *   secrets, so it can sit beside the other settings),
 * - the signing secret per target, generated here, shown to the owner once and
 *   kept only in the OS keychain under `secretNameFor(id)`,
 * - the sender wired to the HUD approvals queue, the kill switch and the audit
 *   log,
 * - the Settings → Channels routes (`/channels/webhook/*`) and the one
 *   `send_webhook` tool, which the policy engine treats as effectful.
 *
 * What the HTTP side returns names a target by id, name and host only: the
 * URL's path and query often carry a token, so they never come back. The
 * secret comes back exactly once, in the answer to "add".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { renameWithRetry } from '../atomic-rename.mjs'
import { createSdkMcpServer, tool } from '../sdk-server.mjs'
import { WEBHOOK_SERVER, WEBHOOK_SEND_TOOL } from '../policy.mjs'
import { CHANNEL_ID, MAX_TEXT_CHARS, createWebhookSender, generateSecret, normaliseTarget, secretNameFor } from './webhook.mjs'

export { WEBHOOK_SERVER, WEBHOOK_SEND_TOOL }
export const MAX_TARGETS = 20
export const TEST_TEXT = 'Test message from JARVIS. If you can read this, the webhook works.'

const slug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)

/**
 * The target list: a JSON file written atomically. A damaged or missing file
 * reads as an empty list (nothing can be sent), never as an error.
 */
export function openTargetStore({ file }) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return (Array.isArray(data?.targets) ? data.targets : []).map(normaliseTarget).filter(Boolean)
    } catch {
      return []
    }
  }
  const write = (targets) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ targets: targets.map(({ id, name, url, preApproved }) => ({ id, name, url, preApproved })) }, null, 2), { mode: 0o600 })
    renameWithRetry(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // not every file system has modes
    }
  }
  return {
    list: read,
    get: (id) => read().find((t) => t.id === id) ?? null,
    /** Add a target. Throws a readable error for anything we will not send to. */
    add({ name, url, preApproved = false }) {
      const targets = read()
      if (targets.length >= MAX_TARGETS) throw new Error(`At most ${MAX_TARGETS} webhook targets.`)
      const base = slug(name)
      if (!base) throw new Error('Give the target a name.')
      let id = base
      for (let n = 2; targets.some((t) => t.id === id); n++) id = `${base.slice(0, 36)}-${n}`
      const clean = normaliseTarget({ id, name: String(name).trim(), url, preApproved: preApproved === true })
      if (!clean) throw new Error('That address is not allowed: it must be a public https address with no user name or password.')
      write([...targets, clean])
      return clean
    },
    remove(id) {
      const targets = read()
      const rest = targets.filter((t) => t.id !== id)
      if (rest.length === targets.length) return false
      write(rest)
      return true
    },
    exists: () => existsSync(file),
  }
}

/** What the screen and the tool may know about a target. No path, no query. */
const view = (t, secretSet) => ({ id: t.id, name: t.name, host: t.host, preApproved: t.preApproved, secretSet })

/**
 * @param {object} deps
 * @param {{ list(): object[], get(id: string): object|null, add(t: object): object, remove(id: string): boolean }} deps.store
 * @param {{ get(name: string): string|null, set(name: string, value: string): void, delete(name: string): void, available?: boolean }} deps.vault
 * @param {(title: string, details: string) => Promise<boolean>} [deps.requestApproval]  the HUD approvals queue
 * @param {() => boolean} [deps.isFrozen]
 * @param {(entry: object) => void} [deps.audit]  an auditSink
 * @param {object} [deps.senderDeps]  `post`, `sleep`, `now`, `limits` (tests pass fakes)
 */
export function createWebhookService({ store, vault, requestApproval, isFrozen = () => false, audit = () => {}, senderDeps = {}, log = console } = {}) {
  if (!store) throw new Error('webhook: store is required')
  if (!vault) throw new Error('webhook: vault is required')

  const approve = async (ask) => {
    if (typeof requestApproval !== 'function') return false
    const details = `Target: ${ask.name} (${ask.host})\nLength: ${ask.length} characters\n\n${ask.preview}`
    return (await requestApproval('Send a webhook message', details)) === true
  }
  const sender = createWebhookSender({
    getTargets: () => store.list(),
    getSecret: (name) => vault.get(name) ?? undefined,
    approve,
    isFrozen,
    // The sender's rows name a target id; the audit trail knows it as the binding.
    audit: (e) => {
      try {
        audit({ type: 'channel', actor: 'system', state: e.state, channel: CHANNEL_ID, bindingId: e.targetId, rule: e.rule, length: e.length })
      } catch (err) {
        log?.warn?.('[jarvis] webhook audit failed:', err?.message ?? err)
      }
    },
    log,
    ...senderDeps,
  })

  const secretSet = (id) => {
    try {
      return typeof vault.get(secretNameFor(id)) === 'string'
    } catch {
      return false
    }
  }
  const targets = () => store.list().map((t) => view(t, secretSet(t.id)))
  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } })
  const no = (status, reason) => ({ status, body: { ok: false, reason } })

  /** Add a target and make its secret. The secret is in the answer once and nowhere else. */
  function add(body) {
    if (vault.available === false) return no(409, 'The keychain is not available, so the signing secret cannot be stored.')
    let target
    try {
      target = store.add({ name: body?.name, url: body?.url, preApproved: body?.preApproved === true })
    } catch (err) {
      return no(400, String(err?.message ?? 'Could not add that target.').slice(0, 200))
    }
    const secret = generateSecret()
    try {
      vault.set(secretNameFor(target.id), secret)
    } catch {
      store.remove(target.id)
      return no(500, 'Could not store the signing secret in the keychain, so the target was not added.')
    }
    return ok({ target: view(target, true), secret })
  }

  function remove(id) {
    if (typeof id !== 'string' || !store.get(id)) return no(404, 'No such target.')
    store.remove(id)
    try {
      vault.delete(secretNameFor(id))
    } catch {
      // the target is gone, so the secret can no longer be used
    }
    return ok()
  }

  const REASONS = {
    frozen: 'JARVIS is frozen.',
    'unlisted-target': 'No such target.',
    'no-secret': 'The signing secret is missing. Remove the target and add it again.',
    'not-approved': 'The send was not approved.',
    'day-cap': 'The daily limit for this target is used up.',
    'minute-cap': 'Too many messages for this target in a minute.',
    'blocked-address': 'That address is not allowed.',
    'rejected-by-receiver': 'The receiver refused the message.',
    unreachable: 'The receiver did not answer.',
  }

  async function test(id) {
    if (typeof id !== 'string' || !store.get(id)) return no(404, 'No such target.')
    const r = await sender.send(id, { text: TEST_TEXT, sensitivity: 'public', kind: 'message' })
    return r.ok ? ok({ outcome: r.outcome, attempts: r.attempts }) : no(502, REASONS[r.outcome] ?? 'The send did not work.')
  }

  /** The Settings → Channels routes. Returns `{ status, body }`, or null for a path that is not ours. */
  async function handle({ method, path, body = {} }) {
    if (!path.startsWith('/channels/webhook/')) return null
    const action = path.slice('/channels/webhook/'.length)
    if (method === 'GET' && action === 'targets') return ok({ targets: targets() })
    if (method !== 'POST') return null
    switch (action) {
      case 'add':
        return add(body)
      case 'remove':
        return remove(body?.id)
      case 'test':
        return test(body?.id)
      default:
        return null
    }
  }

  /** The `send_webhook` tool's handler: a target id and public text; the sender decides the rest. */
  async function sendTool({ target, text }) {
    const r = await sender.send(target, { text, sensitivity: 'public', kind: 'message' })
    return r.ok ? { sent: true, attempts: r.attempts } : { sent: false, reason: REASONS[r.outcome] ?? r.outcome }
  }

  /**
   * `{ jarvis_webhook }` for a session, or nothing when no target exists, so a
   * session with no webhooks is never offered the tool.
   */
  function toolServer() {
    const list = targets()
    if (!list.length) return {}
    const names = list.map((t) => `${t.id} (${t.name})`).join(', ')
    return {
      [WEBHOOK_SERVER]: createSdkMcpServer({
        name: WEBHOOK_SERVER,
        version: '1.0.0',
        instructions: `send_webhook posts one short message to a webhook the owner added. Targets: ${names}. Only public text may be sent; private and vault content never leaves this way. Each send asks the owner unless that target is pre-approved. What the receiver answers is never shown.`,
        tools: [
          tool(
            WEBHOOK_SEND_TOOL,
            'Send one short public text message to one of the owner\'s webhook targets, by its id. Asks the owner first unless the target is pre-approved. Never include private or health or finance details.',
            { target: z.string().min(1).max(40), text: z.string().min(1).max(MAX_TEXT_CHARS) },
            async (args) => {
              const out = await sendTool(args)
              return { ...(out.sent ? {} : { isError: true }), content: [{ type: 'text', text: JSON.stringify(out) }] }
            },
          ),
        ],
      }),
    }
  }

  return { handle, targets, add, remove, test, sendTool, toolServer, health: () => sender.health() }
}
