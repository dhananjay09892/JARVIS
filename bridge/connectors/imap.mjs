/**
 * Generic IMAP mail (task C20; plans/connectors/openjarvis/data-connectors/imap).
 *
 * Read mail from any IMAP provider that offers implicit TLS (Fastmail,
 * iCloud, Yahoo, a self-hosted server) with a username and an app password.
 * Built on the shared read-only reader (imap-reader.mjs): the inbox opened
 * with EXAMINE, bodies fetched with BODY.PEEK, no command that changes mail.
 *
 * What this adapter adds on top of the reader:
 *   - a server field ("host" or "host:port"; port 993 by default), or a known
 *     provider's host filled in from the address (KNOWN_PROVIDERS);
 *   - TLS only: port 143 (plain IMAP / STARTTLS) is refused with a clear
 *     message, and the reader never downgrades;
 *   - the SSRF rule OpenJarvis also keeps: the host may not be, or resolve
 *     to, a private, loopback, link-local or local-only address (bridge/net.mjs
 *     `blockedAddress`). Checked before connecting, and again on the real
 *     socket's own DNS lookup (`guardedLookup`), so a host cannot re-point
 *     itself at the LAN between the check and the connection;
 *   - egress (vetting rule 7): the one host the owner typed is this
 *     connector's whole allow-list; the reader refuses any other.
 *
 * An app password opens the whole mailbox (IMAP has no read-only scope), so
 * the card says so. This adapter only ever reads.
 *
 * Provider facts checked on 2026-11-01 against the providers' own help pages
 * (Fastmail, Apple; Yahoo through its documented settings): see the README.
 *
 * Credentials (its own scoped view): `host`, `port`, `username`, `password`.
 * Stored only after a test login succeeds, so a wrong password or a bad host
 * stores nothing.
 */
import tls from 'node:tls'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { ConnectorError } from './http.mjs'
import { createImapReader, mailToDocument, IMAP_TLS_PORT } from './imap-reader.mjs'
import { blockedAddress, blockedHostname, guardedLookup } from '../net.mjs'

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** Plain IMAP and STARTTLS. JARVIS only speaks implicit TLS. */
const PLAIN_PORTS = new Set([143])
const DEFAULT_TIMEOUT = 30_000

/**
 * Providers whose IMAP host JARVIS can fill in from the address, and the
 * app-password page to point at. Only implicit-TLS hosts on port 993.
 * `user: 'local'` means the provider wants the part before the @ (iCloud).
 */
export const KNOWN_PROVIDERS = Object.freeze({
  'fastmail.com': { name: 'Fastmail', host: 'imap.fastmail.com', appPassword: 'Settings → Privacy & Security → Manage app passwords' },
  'icloud.com': { name: 'iCloud Mail', host: 'imap.mail.me.com', user: 'local', appPassword: 'account.apple.com → Sign-In and Security → App-Specific Passwords' },
  'me.com': { name: 'iCloud Mail', host: 'imap.mail.me.com', user: 'local', appPassword: 'account.apple.com → Sign-In and Security → App-Specific Passwords' },
  'mac.com': { name: 'iCloud Mail', host: 'imap.mail.me.com', user: 'local', appPassword: 'account.apple.com → Sign-In and Security → App-Specific Passwords' },
  'yahoo.com': { name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', appPassword: 'Yahoo Account Security → Generate app password' },
})

/** Addresses with their own JARVIS connector, so the owner is pointed there. */
const ELSEWHERE = Object.freeze({
  'gmail.com': 'Gmail: use the Gmail (simple: app password) or Gmail (API) connector instead.',
  'googlemail.com': 'Gmail: use the Gmail (simple: app password) or Gmail (API) connector instead.',
  'outlook.com': 'Outlook.com: use the Outlook connector instead (Microsoft no longer accepts passwords over IMAP).',
  'hotmail.com': 'Outlook.com: use the Outlook connector instead (Microsoft no longer accepts passwords over IMAP).',
  'live.com': 'Outlook.com: use the Outlook connector instead (Microsoft no longer accepts passwords over IMAP).',
})

const domainOf = (user) => {
  const at = String(user ?? '').lastIndexOf('@')
  return at > 0 ? String(user).slice(at + 1).toLowerCase() : ''
}

/** App passwords are often shown in groups; spaces are never part of one. */
export const cleanPassword = (s) => String(s ?? '').replace(/\s+/g, '')

/**
 * Parse the server field: "host", "host:port". Returns `{ host, port }` or
 * throws `auth` with a plain-words reason (the card shows it).
 */
export function parseServer(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  const bad = (detail) => new ConnectorError('setup-needed', { detail })
  if (!s) throw bad('enter the IMAP server, e.g. imap.example.com')
  if (s.startsWith('[') || (s.match(/:/g) ?? []).length > 1) throw bad('IPv6 addresses are not supported; use the server name')
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s)
  if (!m) throw bad('the server should look like imap.example.com or imap.example.com:993')
  const host = m[1].replace(/\.$/, '')
  const port = m[2] === undefined ? IMAP_TLS_PORT : Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('the port must be a number from 1 to 65535')
  if (PLAIN_PORTS.has(port)) throw bad('port 143 is plain IMAP or STARTTLS; JARVIS only connects over TLS (usually port 993)')
  if (IPV4.test(host)) {
    if (isIP(host) !== 4) throw bad('that is not a valid IP address')
  } else if (!HOSTNAME.test(host)) {
    throw bad('that is not a valid server name')
  }
  return { host, port }
}

/** Refuse local-only names and private address literals, before any DNS. */
function refuseLocal(host) {
  if (blockedHostname(host) || (isIP(host) && blockedAddress(host))) {
    throw new ConnectorError('egress', { detail: `refusing ${host}: a private or local address` })
  }
}

/**
 * Resolve the host and refuse it when any answer is private (vetting rule 7,
 * SSRF). Unknown host: `offline` with "not found".
 * @param {string} host
 * @param {typeof dnsLookup} lookup
 */
export async function vetImapHost(host, lookup = dnsLookup) {
  refuseLocal(host)
  if (isIP(host)) return Promise.resolve([host])
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, addresses) => {
      if (err) {
        reject(new ConnectorError('offline', { detail: `IMAP server ${host} not found (${err.code ?? 'DNS error'})` }))
        return
      }
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map((a) => a?.address ?? a)
      if (!list.length) {
        reject(new ConnectorError('offline', { detail: `IMAP server ${host} has no address` }))
        return
      }
      const priv = list.find((a) => blockedAddress(a))
      if (priv) {
        reject(new ConnectorError('egress', { detail: `refusing ${host}: it resolves to the private address ${priv}` }))
        return
      }
      resolve(list)
    })
  })
}

/**
 * The production opener: TLS 1.2+, certificate checked against the host
 * name, and the socket's own DNS lookup guarded (no rebinding window).
 */
export function guardedTlsSocket({ host, port, timeoutMs = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    try {
      refuseLocal(host)
    } catch (err) {
      reject(err)
      return
    }
    const sock = tls.connect({
      host, port, minVersion: 'TLSv1.2', lookup: guardedLookup,
      ...(isIP(host) ? {} : { servername: host }),
    })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(Object.assign(new Error('TLS connect timed out'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    sock.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      if (err?.code === 'EBLOCKEDADDRESS') reject(new ConnectorError('egress', { detail: err.message }))
      else reject(err)
    })
  })
}

const IMAP_SEES = [
  'Your inbox: sender, recipients, date, subject and the text of each message.',
  'Attachment names and types (attachments themselves are never opened).',
  'Read-only in JARVIS: it never sends, deletes, moves, flags or marks mail as read.',
  'Note: an app password unlocks your whole mailbox. Use an app password, not your main password, so you can revoke it.',
  'Only your inbox is synced (not sent, drafts, spam or trash).',
]

/**
 * One fetched message to a document. A UID is only unique on one server and
 * under one UIDVALIDITY, so the id is `<host>/<uidvalidity>-<uid>`.
 */
export function imapDocument(msg, host) {
  const uv = /^\d{1,10}$/.test(String(msg.uidValidity ?? '')) ? String(msg.uidValidity) : '0'
  return mailToDocument(msg, { id: `${host}/${uv}-${msg.uid}`, meta: { server: host } })
}

/**
 * The sync cursor is the reader's, tied to the server it came from: after
 * reconnecting to a different server, an old cursor is ignored (full sync).
 */
export const imapServerCursor = (server, inner) => JSON.stringify({ v: 1, s: server, c: inner })
export function readServerCursor(cursor, server) {
  if (typeof cursor !== 'string' || cursor.length > 50_000) return undefined
  try {
    const c = JSON.parse(cursor)
    return c?.v === 1 && c.s === server && typeof c.c === 'string' ? c.c : undefined
  } catch {
    return undefined
  }
}

/**
 * The generic IMAP connector factory.
 * @param {{ openSocket?: Function, lookup?: typeof dnsLookup, maxPerSync?: number, maxInitial?: number, timeoutMs?: number }} [opts]
 */
export function imapConnector({ openSocket = guardedTlsSocket, lookup = dnsLookup, maxPerSync = 50, maxInitial = 500, timeoutMs } = {}) {
  return Object.freeze({
    id: 'imap',
    /** @param {{ credentials: any, sleep: (ms: number) => Promise<void>, now: () => number }} ctx */
    create({ credentials, sleep, now }) {
      let lastSync
      const readerFor = (host, port) => createImapReader({
        host, port, allowedHosts: [host], openSocket, sleep, mailbox: 'inbox',
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      const saved = () => {
        const host = credentials.get('host')
        const port = Number(credentials.get('port') ?? IMAP_TLS_PORT)
        const user = credentials.get('username')
        const pass = credentials.get('password')
        if (!host || !user || !pass) throw new ConnectorError('not-connected')
        return { host, port, user, pass }
      }
      /** Saved settings, the host vetted again (DNS may have changed since connect). */
      const ready = async () => {
        const c = saved()
        const { host, port } = parseServer(`${c.host}:${c.port}`)
        await vetImapHost(host, lookup)
        return { ...c, host, port, reader: readerFor(host, port) }
      }

      return {
        id: 'imap',
        name: 'Email (IMAP)',
        kind: 'data',
        auth: 'token',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'messages',
        setup: {
          sees: IMAP_SEES,
          scopes: ['IMAP over TLS to the server you enter, read-only use: EXAMINE and BODY.PEEK'],
          steps: [
            'Find your provider\'s IMAP server (Fastmail, iCloud and Yahoo are filled in for you).',
            'Create an app password in your provider\'s security settings (name it "JARVIS").',
            'Enter your username (usually your email address), the server if asked, and the app password.',
            'Only TLS is used (port 993 unless your provider says otherwise); plain IMAP is refused.',
            'Gmail or Outlook? Use their own connectors instead.',
          ],
          tokenLabel: 'app password',
          accountLabel: 'Username (usually your email address)',
          serverLabel: 'IMAP server (e.g. imap.example.com or imap.example.com:993)',
          testQuestion: 'Any new mail in my inbox today?',
        },

        /** Paste pattern: `{ token, account, server? }`. Stores nothing unless the login works. */
        async connect({ token, account, server } = {}) {
          const user = String(account ?? '').trim()
          const pass = cleanPassword(token)
          if (!user || user.length > 254 || /[\s\u0000-\u001f]/.test(user)) throw new ConnectorError('auth', { detail: 'enter your username' })
          if (pass.length < 4 || pass.length > 256) throw new ConnectorError('auth', { detail: 'the app password has the wrong length' })
          const domain = domainOf(user)
          const known = KNOWN_PROVIDERS[domain]
          if (!server && ELSEWHERE[domain]) throw new ConnectorError('auth', { detail: ELSEWHERE[domain] })
          const { host, port } = parseServer(server || known?.host || '')
          await vetImapHost(host, lookup)
          const reader = readerFor(host, port)
          // iCloud wants the name before the @ (Apple: "if that fails, try the full address").
          const tries = known?.user === 'local' && host === known.host ? [user.slice(0, user.lastIndexOf('@')), user] : [user]
          let used
          for (const [i, u] of tries.entries()) {
            try {
              await reader.check({ user: u, pass })
              used = u
              break
            } catch (err) {
              if (!(err instanceof ConnectorError && err.code === 'auth' && i < tries.length - 1)) throw err
            }
          }
          credentials.set('host', host)
          credentials.set('port', String(port))
          credentials.set('username', used)
          credentials.set('password', pass)
          lastSync = undefined
          const where = port === IMAP_TLS_PORT ? host : `${host}:${port}`
          return { account: `${used} on ${where}`, detail: `Connected to ${known?.name ?? where} over IMAP (TLS). JARVIS only reads.` }
        },

        async disconnect() {
          for (const k of ['password', 'username', 'port', 'host']) credentials.delete(k)
          lastSync = undefined
        },

        status() {
          if (!credentials.has('host') || !credentials.has('username') || !credentials.has('password')) {
            return { state: 'disconnected', detail: 'Not connected' }
          }
          const s = { state: 'ok', detail: `Connected to ${credentials.get('host')} over IMAP (read-only use)` }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          const { user, pass, host, reader } = await ready()
          await reader.check({ user, pass })
          return { detail: 'IMAP works: reading the inbox, read-only.' }
        },

        async *sync({ since, cursor } = {}) {
          const { user, pass, host, port, reader } = await ready()
          const server = `${host}:${port}`
          const inner = readServerCursor(cursor, server)
          for await (const item of reader.sync({ user, pass, cursor: inner, since, perSync: maxPerSync, maxInitial })) {
            if (item.cursor) {
              yield { cursor: imapServerCursor(server, item.cursor) }
              continue
            }
            yield imapDocument(item.message, host)
          }
          lastSync = now()
        },
      }
    },
  })
}
