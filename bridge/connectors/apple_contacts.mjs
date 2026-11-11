/**
 * Apple Contacts data connector (task C36; macOS local database, read-only).
 *
 * Same grant-local-access pattern as Apple Calendar (task C29): the owner
 * reads what is read and why Full Disk Access is needed, ticks consent, and
 * JARVIS reads the Contacts app's own database through the shared macOS helper
 * (macos-local.mjs): a private snapshot copy opened read-only, never the live
 * file, never written. Off macOS it reports itself unavailable.
 *
 * Why the database and not the Contacts framework / AppleScript: those need a
 * signed native helper or a shell with Automation rights; the database needs
 * only the Full Disk Access the other Apple connectors share. Written fresh;
 * no OpenJarvis code is reused.
 *
 * Database facts (Apple does not document the schema; checked against
 * community references and the OpenJarvis reference on 2026-11-11, and
 * verified at run time so an unknown layout fails clearly instead of guessing):
 *   - the local address book is
 *     ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb and each
 *     synced account (iCloud, Exchange, Google…) has its own copy under
 *     AddressBook/Sources/<id>/AddressBook-v22.abcddb. All are read.
 *   - people (and groups) are rows of ZABCDRECORD: ZFIRSTNAME, ZMIDDLENAME,
 *     ZLASTNAME, ZNICKNAME, ZORGANIZATION, ZJOBTITLE, ZDEPARTMENT, ZUNIQUEID,
 *     ZMODIFICATIONDATE (Core Data seconds since 2001-01-01 UTC). Groups have
 *     none of the person name fields and are skipped.
 *   - ZABCDEMAILADDRESS (ZADDRESS) and ZABCDPHONENUMBER (ZFULLNUMBER) point at
 *     their record with ZOWNER and carry ZLABEL like `_$!<Mobile>!$_`.
 *
 * Kept minimal on purpose, like Google Contacts (task C18): names, nicknames,
 * emails, phones and work. Not addresses, birthdays, notes, photos, social
 * profiles, URLs or relations.
 *
 * Mapping (plan 38 Document): `contact:<ZUNIQUEID>` (the same person in two
 * accounts gives two documents only when the ids differ), title = display
 * name, sensitivity `personal`. At most 10 000 contacts and 20 accounts.
 *
 * Sync: the cursor is a hash of every database's size and modified time (and
 * its -wal's), so nothing is re-read until Contacts changed. Every document is
 * upserted by id. Contacts deleted since the last sync are not reported (a
 * snapshot has no change log); they leave with the retention setting or
 * "erase synced data". Fetched text is untrusted data (wrapped by the
 * registry); no live tool is offered.
 */
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConnectorError } from './http.mjs'
import { accessError, columnsOf, ensureMac, explainAccess, findDatabase, isMac, withSnapshot } from './macos-local.mjs'

const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1)
const DB_FILE = 'AddressBook-v22.abcddb'
const MAX_CONTACTS = 10_000
const MAX_SOURCES = 20
const MAX_EACH = 10

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v === null || v === undefined || v === '' ? NaN : Number(v))
const coreToMs = (sec) => (Number.isFinite(sec) ? Math.round(CORE_DATA_EPOCH_MS + sec * 1000) : null)

export const addressBookDir = (home = homedir()) => join(home, 'Library', 'Application Support', 'AddressBook')

/** `_$!<Mobile>!$_` → `Mobile`; custom labels are kept as typed (short). */
export function cleanLabel(raw) {
  const s = clean(raw, 60)
  const m = /^_\$!<(.*)>!\$_$/.exec(s)
  return clean(m ? m[1] : s, 30)
}

/**
 * Every Contacts database on this Mac: the local one plus one per synced
 * account. Links are not followed. Permission errors win over "not found".
 */
export async function findDatabases(home = homedir()) {
  const base = addressBookDir(home)
  const paths = [join(base, DB_FILE)]
  try {
    const entries = await readdir(join(base, 'Sources'), { withFileTypes: true })
    const names = entries.filter((e) => e.isDirectory() && /^[A-Za-z0-9._-]{1,80}$/.test(e.name)).map((e) => e.name).sort()
    for (const n of names.slice(0, MAX_SOURCES)) paths.push(join(base, 'Sources', n, DB_FILE))
  } catch (err) {
    const e = accessError(err, 'the Contacts folder')
    if (e.code !== 'folder-missing') throw e
  }
  const found = []
  let denied = null
  for (const p of paths) {
    try {
      found.push(await findDatabase([p]))
    } catch (err) {
      if (err?.code === 'permission-needed') denied = err
      else if (err?.code !== 'folder-missing') throw err
    }
  }
  if (!found.length) throw denied ?? new ConnectorError('folder-missing', { detail: 'Contacts database not found' })
  return found
}

/** One signature for all databases, short enough for a cursor. */
export const signatureOf = (dbs) =>
  createHash('sha256').update(dbs.map((d) => `${d.path}|${d.signature}`).join('\n')).digest('hex').slice(0, 32)

const NEED = ['Z_PK', 'ZFIRSTNAME', 'ZLASTNAME']

/** `[{ value, label }]` per owner from one of the value tables, when it is there. */
function valuesByOwner(db, table, valueCol) {
  const cols = columnsOf(db, table)
  /** @type {Map<number, {value: string, label: string}[]>} */
  const out = new Map()
  if (!cols.has('ZOWNER') || !cols.has(valueCol)) return out
  const label = cols.has('ZLABEL') ? 'ZLABEL' : 'NULL'
  const order = cols.has('ZORDERINGINDEX') ? 'ZOWNER, ZORDERINGINDEX' : 'ZOWNER'
  for (const r of db.prepare(`SELECT ZOWNER AS o, ${valueCol} AS v, ${label} AS l FROM ${table} ORDER BY ${order}`).all()) {
    const value = clean(r.v, 200)
    if (!value) continue
    const o = num(r.o)
    const list = out.get(o) ?? []
    if (list.length < MAX_EACH && !list.some((x) => x.value.toLowerCase() === value.toLowerCase())) list.push({ value, label: cleanLabel(r.l) })
    out.set(o, list)
  }
  return out
}

/**
 * Read the people from an open (snapshot) Contacts database.
 * @returns {object[]} contact records for `contactToDocument`
 */
export function readContacts(db, { limit = MAX_CONTACTS } = {}) {
  const rec = columnsOf(db, 'ZABCDRECORD')
  if (!NEED.every((c) => rec.has(c))) throw new ConnectorError('bad-response', { detail: 'unrecognised Contacts database layout' })
  const col = (c) => (rec.has(c) ? `${c} AS ${c}` : `NULL AS ${c}`)
  const person = ['ZFIRSTNAME', 'ZLASTNAME', 'ZORGANIZATION', 'ZNICKNAME'].filter((c) => rec.has(c)).map((c) => `${c} IS NOT NULL`).join(' OR ')
  const rows = db.prepare(
    `SELECT Z_PK, ${['ZFIRSTNAME', 'ZMIDDLENAME', 'ZLASTNAME', 'ZNICKNAME', 'ZORGANIZATION', 'ZJOBTITLE', 'ZDEPARTMENT', 'ZUNIQUEID', 'ZMODIFICATIONDATE'].map(col).join(', ')}
     FROM ZABCDRECORD WHERE ${person} ORDER BY Z_PK LIMIT ${Math.max(0, Math.floor(limit))}`,
  ).all()
  const emails = valuesByOwner(db, 'ZABCDEMAILADDRESS', 'ZADDRESS')
  const phones = valuesByOwner(db, 'ZABCDPHONENUMBER', 'ZFULLNUMBER')
  const out = []
  for (const r of rows) {
    const pk = num(r.Z_PK)
    const uid = clean(r.ZUNIQUEID, 120)
    const first = clean(r.ZFIRSTNAME, 100)
    const middle = clean(r.ZMIDDLENAME, 100)
    const last = clean(r.ZLASTNAME, 100)
    const org = clean(r.ZORGANIZATION, 200)
    const nickname = clean(r.ZNICKNAME, 100)
    out.push({
      uid: /^[A-Za-z0-9:._-]{4,120}$/.test(uid) ? uid : null,
      pk,
      name: [first, middle, last].filter(Boolean).join(' '),
      nickname, org,
      jobTitle: clean(r.ZJOBTITLE, 200),
      department: clean(r.ZDEPARTMENT, 200),
      emails: emails.get(pk) ?? [],
      phones: phones.get(pk) ?? [],
      modifiedMs: coreToMs(num(r.ZMODIFICATIONDATE)),
    })
  }
  return out
}

const lineOf = (label, values) =>
  values.length ? `${label}: ${values.map((v) => (v.label ? `${v.value} (${v.label})` : v.value)).join(', ')}` : null

/**
 * One contact to a document; null when it has nothing to show or no stable id.
 * @param {{ uid: string|null, name: string, nickname: string, org: string, jobTitle: string, department: string,
 *   emails: {value:string,label:string}[], phones: {value:string,label:string}[], modifiedMs: number|null }} c
 */
export function contactToDocument(c, { now = Date.now } = {}) {
  if (!c?.uid) return null
  const title = c.name || c.nickname || c.org || c.emails[0]?.value || c.phones[0]?.value
  if (!title) return null
  const lines = [`Name: ${title}`]
  if (c.nickname && c.nickname !== title) lines.push(`Also called: ${c.nickname}`)
  for (const l of [lineOf('Email', c.emails), lineOf('Phone', c.phones)]) if (l) lines.push(l)
  const work = [c.jobTitle, c.department, c.org !== title ? c.org : ''].filter(Boolean)
  if (work.length) lines.push(`Work: ${work.join(', ')}`)
  lines.push('Source: Apple Contacts')
  const meta = { emails: c.emails.length, phones: c.phones.length }
  if (c.emails[0]) meta.email = c.emails[0].value
  return {
    id: `contact:${c.uid}`,
    title,
    text: lines.join('\n'),
    updatedAt: c.modifiedMs ?? now(),
    sensitivity: 'personal',
    meta,
  }
}

export function parseContactsCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.g !== 'string' || !/^[0-9a-f]{32}$/.test(c.g)) return null
    return { g: c.g }
  } catch {
    return null
  }
}
export const contactsCursor = ({ g }) => JSON.stringify({ v: 1, g })

const SEES = [
  'Your contacts in the Contacts app, including synced accounts such as iCloud: names, nicknames, email addresses, phone numbers, job title and company.',
  'Not addresses, birthdays, notes, photos, social profiles or relationships. Nothing is sent anywhere by this connector.',
  'Read-only: JARVIS works on a private copy of the Contacts database, deletes the copy right away, and never changes Contacts.',
  'Needs Full Disk Access on a Mac; it does not work on Windows or Linux.',
  'Contact fields are treated as information, never as instructions.',
]

/** @param {{ home?: string, platform?: string }} [opts] */
export function appleContactsConnector({ home, platform } = {}) {
  const here = platform ?? process.platform
  return Object.freeze({
    id: 'apple_contacts',
    create({ credentials, now }) {
      let lastSync

      /** Every contact from every database, de-duplicated by id. */
      async function readAll(dbs) {
        const seen = new Set()
        const docs = []
        for (const d of dbs) {
          if (docs.length >= MAX_CONTACTS) break
          const people = await withSnapshot(d.path, (db) => readContacts(db, { limit: MAX_CONTACTS - docs.length }))
          for (const p of people) {
            const doc = contactToDocument(p, { now })
            if (!doc || seen.has(doc.id)) continue
            seen.add(doc.id)
            docs.push(doc)
          }
        }
        return docs
      }

      return {
        id: 'apple_contacts',
        name: 'Apple Contacts',
        kind: 'data',
        auth: 'local',
        platforms: ['mac'],
        risk: 'R1',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'personal',
        setup: {
          sees: SEES,
          localWhy: explainAccess({ app: 'Contacts', reads: 'names, emails, phone numbers and work details', notReads: 'your mail, messages, photos or other apps' }),
          steps: [
            'Open System Settings → Privacy & Security → Full Disk Access and turn it on for JARVIS (or the terminal that runs it). Restart JARVIS if you just did.',
            'Tick the box here and press Grant access.',
            'Press Test: JARVIS checks it can read Contacts and shows only a count.',
          ],
          testQuestion: "What's Sam's phone number?",
        },

        /** Grant pattern: `{ confirmed: true }`. Stores a marker only when a database is readable. */
        async connect({ confirmed } = {}) {
          ensureMac(here)
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const dbs = await findDatabases(home)
          await withSnapshot(dbs[0].path, (d) => {
            if (!NEED.every((c) => columnsOf(d, 'ZABCDRECORD').has(c))) throw new ConnectorError('bad-response', { detail: 'unrecognised Contacts database layout' })
          })
          credentials.set('granted', '1')
          lastSync = undefined
          return { account: 'This Mac', detail: 'Connected to the Contacts app on this Mac (read-only, on a private copy).' }
        },

        async disconnect() {
          credentials.delete('granted')
          lastSync = undefined
        },

        status() {
          if (!isMac(here)) return { state: 'error', detail: 'Apple Contacts only works on a Mac' }
          if (!credentials.get('granted')) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: 'Reading the Contacts app on this Mac (read-only)' }
          return lastSync ? { ...s, lastSync } : s
        },

        async test() {
          ensureMac(here)
          const n = (await readAll(await findDatabases(home))).length
          return { detail: `Apple Contacts works: ${n} contact${n === 1 ? '' : 's'} found (read-only).` }
        },

        async *sync({ cursor } = {}) {
          ensureMac(here)
          if (!credentials.get('granted')) throw new ConnectorError('not-connected')
          const dbs = await findDatabases(home)
          const g = signatureOf(dbs)
          if (parseContactsCursor(cursor)?.g === g) {
            lastSync = now()
            yield { cursor }
            return
          }
          for (const doc of await readAll(dbs)) yield doc
          yield { cursor: contactsCursor({ g }) }
          lastSync = now()
        },
      }
    },
  })
}
