/**
 * Gmail over IMAP with an app password (task C09;
 * plans/connectors/openjarvis/data-connectors/gmail_imap).
 *
 * The simple Gmail setup: no Google Cloud project, just the Gmail address and
 * a 16-character app password (which needs 2-Step Verification). Built on the
 * shared read-only IMAP reader (imap-reader.mjs): TLS to imap.gmail.com:993
 * only, the All Mail mailbox opened with EXAMINE, bodies fetched with
 * BODY.PEEK so nothing is marked read, and no command that changes mail.
 *
 * Facts checked against Google's documentation on 2026-10-26:
 *   - imap.gmail.com, port 993, SSL/TLS. Since January 2025 IMAP is always
 *     on for personal accounts (the Enable IMAP toggle is gone); Workspace
 *     admins can still turn it off, and can disable app passwords.
 *   - Gmail's IMAP extensions: X-GM-MSGID and X-GM-THRID are 64-bit ids in
 *     decimal, the same ids (in hex) as the Gmail API and web interface, so
 *     documents here get the Gmail API message id and a working web link.
 *     X-GM-LABELS lists labels; "[Gmail]/All Mail" carries the special-use
 *     \All flag (spam and trash are not in it). Drafts are skipped by label.
 *
 * An app password opens the whole mailbox (IMAP has no read-only scope), so
 * the card says so and points to the read-only Gmail (API) connector as the
 * narrower choice. This adapter itself only ever reads.
 *
 * Credentials (its own scoped view): `address`, `app_password`. They are
 * stored only after a test login succeeds, so a wrong password stores nothing.
 */
import { ConnectorError } from './http.mjs'
import { createImapReader, mailToDocument, tlsSocket } from './imap-reader.mjs'

export const GMAIL_IMAP_HOST = 'imap.gmail.com'
export const GMAIL_IMAP_PORT = 993

const ADDRESS = /^[^\s@"<>()\\,;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/
const DRAFT_LABELS = new Set(['\\draft', '\\drafts'])

/** Google shows app passwords in four groups of four; spaces are not part of it. */
export const cleanAppPassword = (s) => String(s ?? '').replace(/\s+/g, '')

const GMAIL_IMAP_SEES = [
  'Your Gmail messages (All Mail): sender, recipients, date, subject and the text of each message.',
  'Attachment names and types (attachments themselves are never opened).',
  'Read-only in JARVIS: it never sends, deletes, moves, labels or marks mail as read.',
  'Note: an app password unlocks your whole mailbox. The Gmail (API) connector can be limited to read-only access, if you can do its Google Cloud setup.',
  'Drafts, spam and trash are not synced.',
]

/** One fetched message to a document, or null to skip it (drafts). */
export function gmailImapDocument(msg) {
  const labels = msg.gmail?.labels ?? []
  if (labels.some((l) => DRAFT_LABELS.has(l.toLowerCase()))) return null
  const msgid = msg.gmail?.msgid
  const thrid = msg.gmail?.thrid
  // Gmail's own message id when the server gives it (same as the Gmail API); else the UID.
  const id = msgid && /^[0-9a-f]{1,16}$/.test(msgid) ? msgid : `uid-${msg.uid}`
  const link = thrid && /^[0-9a-f]{1,16}$/.test(thrid) ? thrid : msgid
  return mailToDocument(msg, {
    id,
    url: link ? `https://mail.google.com/mail/u/0/#all/${link}` : undefined,
    meta: {
      ...(thrid ? { threadId: thrid } : {}),
      labels: labels.map((l) => l.replace(/[\u0000-\u001f,]/g, ' ')).slice(0, 20).join(','),
    },
  })
}

/**
 * The Gmail (IMAP) connector factory.
 * @param {{ openSocket?: Function, maxPerSync?: number, maxInitial?: number, timeoutMs?: number }} [opts]
 */
export function gmailImapConnector({ openSocket = tlsSocket, maxPerSync = 50, maxInitial = 500, timeoutMs } = {}) {
  return Object.freeze({
    id: 'gmail_imap',
    /** @param {{ credentials: any, sleep: (ms: number) => Promise<void>, now: () => number }} ctx */
    create({ credentials, sleep, now }) {
      const reader = createImapReader({
        host: GMAIL_IMAP_HOST,
        port: GMAIL_IMAP_PORT,
        allowedHosts: [GMAIL_IMAP_HOST],
        openSocket,
        sleep,
        mailbox: 'all',
        gmail: true,
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      let lastSync
      const creds = () => {
        const user = credentials.get('address')
        const pass = credentials.get('app_password')
        if (!user || !pass) throw new ConnectorError('not-connected')
        return { user, pass }
      }

      return {
        id: 'gmail_imap',
        name: 'Gmail (simple: app password)',
        kind: 'data',
        auth: 'token',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'messages',
        setup: {
          sees: GMAIL_IMAP_SEES,
          scopes: ['IMAP (imap.gmail.com, TLS), read-only use: EXAMINE and BODY.PEEK'],
          steps: [
            'Turn on 2-Step Verification for your Google account.',
            'Create an app password at myaccount.google.com/apppasswords (name it "JARVIS").',
            'Enter your Gmail address and paste the 16-character app password here.',
            'Work or school account? Your admin may have turned off IMAP or app passwords.',
          ],
          tokenLabel: 'Google app password',
          accountLabel: 'Gmail address',
          helpUrl: 'https://myaccount.google.com/apppasswords',
          testQuestion: 'Any new mail from the bank this week?',
        },

        /** Paste pattern: `{ token: app password, account: address }`. Stores nothing unless the login works. */
        async connect({ token, account } = {}) {
          const address = String(account ?? '').trim()
          const pass = cleanAppPassword(token)
          if (!ADDRESS.test(address) || address.length > 254) {
            throw new ConnectorError('auth', { detail: 'not an email address' })
          }
          if (pass.length < 8 || pass.length > 256) throw new ConnectorError('auth', { detail: 'app password has the wrong length' })
          await reader.check({ user: address, pass })
          credentials.set('address', address)
          credentials.set('app_password', pass)
          lastSync = undefined
          return { account: address, detail: 'Connected to Gmail over IMAP. JARVIS only reads.' }
        },

        async disconnect() {
          credentials.delete('app_password')
          credentials.delete('address')
          lastSync = undefined
        },

        status() {
          if (!credentials.has('address') || !credentials.has('app_password')) {
            return { state: 'disconnected', detail: 'Not connected' }
          }
          const s = { state: 'ok', detail: 'Connected to Gmail over IMAP (read-only use)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          const { mailbox } = await reader.check(creds())
          return { detail: `Gmail (IMAP) works: reading ${mailbox === 'INBOX' ? 'the inbox' : 'All Mail'}, read-only.` }
        },

        async *sync({ since, cursor } = {}) {
          const { user, pass } = creds()
          for await (const item of reader.sync({ user, pass, cursor, since, perSync: maxPerSync, maxInitial })) {
            if (item.cursor) {
              yield { cursor: item.cursor }
              continue
            }
            const doc = gmailImapDocument(item.message)
            if (doc) yield doc
          }
          lastSync = now()
        },
      }
    },
  })
}
