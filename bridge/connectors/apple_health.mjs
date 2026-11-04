/**
 * Apple Health data connector (task C28; export-file route).
 *
 * Grant-local-access pattern: the owner types the full path of the file the
 * Health app produced (Health → profile picture → Export All Health Data),
 * either `export.zip` or the unzipped `export.xml`, and ticks consent. No
 * network, no credential; the only thing kept (in the credential slot, so
 * Disconnect forgets it) is the file's real path.
 *
 * Health data is sensitivity `health`: the document tool leaves it out unless
 * the owner's vault setting allows it, so none of it reaches a cloud model by
 * default. As with Oura there is deliberately no live tool.
 *
 * Reading the file safely:
 *   - One file, `.zip` or `.xml`, never a symlink (opened with O_NOFOLLOW and
 *     the real path must equal the stored path).
 *   - Exports are huge, so the XML is stream-parsed in chunks and aggregated;
 *     it is never loaded whole. Only `<Record>` and `<Workout>` opening tags
 *     are looked at. No XML parser is used, so DOCTYPE entities and external
 *     references are never expanded.
 *   - From a zip only the entry named `export.xml` is read, with a hard limit
 *     on how many bytes it may inflate to, and no zip64. A file that is too
 *     large, not a Health export, or malformed fails with a clear message.
 *
 * Mapping (plan 38 Document), built from numbers, fixed labels and cleaned
 * source names:
 *   day:<YYYY-MM-DD>   steps, walking/running distance, active energy, sleep,
 *                      heart rate (avg/min/max), resting heart rate
 *   workout:<startMs>  one workout: type, duration, distance, energy
 * Steps, distance, energy and sleep are summed per source (iPhone, Watch…) and
 * the source with the largest total wins, so the same walk recorded by two
 * devices is not counted twice. `day` is the local day written in the export;
 * sleep counts on the day it ended.
 *
 * Sync: the export is a snapshot. If the file's size and modified time match
 * the cursor nothing is read; otherwise it is parsed again and every document
 * is upserted by id (at most the last 1100 days). Cursor:
 * `{"v":1,"r":"<hash of the path>","m":<mtime>,"s":<size>}`. The adapter never
 * reports deletions; "erase synced data" in Settings clears the store.
 */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createInflateRaw } from 'node:zlib'
import { ConnectorError } from './http.mjs'

const MAX_XML_BYTES = 6 * 1024 ** 3 // inflated export.xml
const MAX_RATIO = 400 // inflated / compressed, a zip-bomb guard
const MAX_RECORDS = 40_000_000
const MAX_TAG_BYTES = 256 * 1024
const MAX_DAYS = 1100
const MAX_WORKOUTS = 2000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const SIZE_32 = 0xffffffff

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
const pathHash = (p) => createHash('sha256').update(p).digest('hex').slice(0, 16)
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d

// ------------------------------------------------------------ the xml stream

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s) =>
  s.replace(/&(?:#(\d{1,6})|#x([0-9a-fA-F]{1,5})|(amp|lt|gt|quot|apos));/g, (_m, dec, hex, name) => {
    if (name) return ENTITIES[name]
    const cp = dec ? Number(dec) : parseInt(hex, 16)
    return cp > 0 && cp < 0x110000 && !(cp >= 0xd800 && cp < 0xe000) ? String.fromCodePoint(cp) : ' '
  })

const TAG = /<(Record|Workout)\s((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g

/** Attributes of one opening tag, unescaped. */
export function parseAttributes(src) {
  const out = {}
  ATTR.lastIndex = 0
  let n = 0
  for (const m of src.matchAll(ATTR)) {
    if (n++ >= 40) break
    out[m[1]] = unescapeXml(m[2])
  }
  return out
}

/**
 * Walk a stream of XML text and call `onTag(name, attrs)` for each `<Record>`
 * and `<Workout>` opening tag. Chunk boundaries may fall anywhere.
 * @param {AsyncIterable<Buffer>} source
 * @param {(name: 'Record' | 'Workout', attrs: Record<string,string>) => void} onTag
 * @returns {Promise<{ bytes: number, sawRoot: boolean }>}
 */
export async function scanHealthXml(source, onTag, { maxBytes = MAX_XML_BYTES } = {}) {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  let bytes = 0
  let sawRoot = false
  for await (const chunk of source) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new ConnectorError('bad-response', { detail: 'the export is larger than the limit' })
    buf += decoder.write(chunk)
    if (!sawRoot) {
      if (/<HealthData[\s>]/.test(buf)) sawRoot = true
      else if (bytes > 1024 * 1024) throw new ConnectorError('bad-response', { detail: 'not an Apple Health export' })
    }
    TAG.lastIndex = 0
    let end = 0
    for (let m = TAG.exec(buf); m; m = TAG.exec(buf)) {
      end = TAG.lastIndex
      onTag(m[1], parseAttributes(m[2]))
    }
    // Keep only a possibly unfinished tag: it starts at the last '<' (values escape '<').
    const rest = buf.slice(end)
    const lt = rest.lastIndexOf('<')
    buf = lt >= 0 ? rest.slice(lt) : ''
    if (buf.length > MAX_TAG_BYTES) throw new ConnectorError('bad-response', { detail: 'a tag in the export is too long' })
  }
  buf += decoder.end()
  return { bytes, sawRoot }
}

// ------------------------------------------------------------------ the zip

/**
 * Find `export.xml` in a zip without reading the whole file. Reads the end
 * record and the central directory only. No zip64, no encryption.
 * @returns {Promise<{ offset: number, size: number, csize: number, method: number }>}
 */
export async function findZipEntry(fh, fileSize, wanted = /(^|\/)export\.xml$/) {
  if (fileSize < 22) throw new ConnectorError('bad-response', { detail: 'not a zip file' })
  const tailLen = Math.min(fileSize, 65_557)
  const tail = Buffer.alloc(tailLen)
  await fh.read(tail, 0, tailLen, fileSize - tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ConnectorError('bad-response', { detail: 'not a zip file' })
  const count = tail.readUInt16LE(eocd + 10)
  const dirSize = tail.readUInt32LE(eocd + 12)
  const dirOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || dirSize === SIZE_32 || dirOffset === SIZE_32) {
    throw new ConnectorError('bad-response', { detail: 'zip64 exports are not supported; unzip the file and pick export.xml' })
  }
  if (dirSize > 16 * 1024 * 1024 || dirOffset + dirSize > fileSize) throw new ConnectorError('bad-response', { detail: 'damaged zip' })
  const dir = Buffer.alloc(dirSize)
  await fh.read(dir, 0, dirSize, dirOffset)
  let p = 0
  for (let i = 0; i < count && p + 46 <= dirSize; i++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) break
    const flags = dir.readUInt16LE(p + 8)
    const method = dir.readUInt16LE(p + 10)
    const csize = dir.readUInt32LE(p + 20)
    const size = dir.readUInt32LE(p + 24)
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    const local = dir.readUInt32LE(p + 42)
    const name = dir.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (!wanted.test(name) || /(^|\/)__MACOSX\//.test(name)) continue
    if (flags & 1) throw new ConnectorError('bad-response', { detail: 'the zip is encrypted' })
    if (method !== 0 && method !== 8) throw new ConnectorError('bad-response', { detail: 'unsupported zip compression' })
    if (csize === SIZE_32 || size === SIZE_32 || local === SIZE_32) throw new ConnectorError('bad-response', { detail: 'zip64 exports are not supported; unzip the file and pick export.xml' })
    const lh = Buffer.alloc(30)
    await fh.read(lh, 0, 30, local)
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new ConnectorError('bad-response', { detail: 'damaged zip' })
    const offset = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
    if (offset + csize > fileSize) throw new ConnectorError('bad-response', { detail: 'damaged zip' })
    return { offset, size, csize, method }
  }
  throw new ConnectorError('bad-response', { detail: 'no export.xml in the zip; is this a Health export?' })
}

/** The XML bytes of an export file, as a stream, whichever form it is in. */
async function* xmlBytes(real, kind, fileSize) {
  if (kind === 'xml') {
    yield* createReadStream(real, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
    return
  }
  const fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const e = await findZipEntry(fh, fileSize)
    if (e.size > MAX_XML_BYTES || (e.csize > 0 && e.size / e.csize > MAX_RATIO && e.size > 64 * 1024 * 1024)) {
      throw new ConnectorError('bad-response', { detail: 'the export is larger than the limit' })
    }
    const raw = createReadStream(real, { start: e.offset, end: Math.max(e.offset, e.offset + e.csize - 1), flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
    if (e.csize === 0) return
    if (e.method === 0) { yield* raw; return }
    const inflate = createInflateRaw()
    raw.on('error', (err) => inflate.destroy(err))
    raw.pipe(inflate)
    let out = 0
    try {
      for await (const chunk of inflate) {
        out += chunk.length
        // The entry says how big it is; more than that is a lie (zip bomb).
        if (out > e.size + 1024 || out > MAX_XML_BYTES) throw new ConnectorError('bad-response', { detail: 'the zip inflates beyond its declared size' })
        yield chunk
      }
    } catch (err) {
      if (err instanceof ConnectorError) throw err
      throw new ConnectorError('bad-response', { detail: 'damaged zip data' })
    } finally {
      raw.destroy()
      inflate.destroy()
    }
  } finally {
    await fh.close().catch(() => {})
  }
}

// ------------------------------------------------------------- aggregation

/** Milliseconds for an Apple Health date such as `2026-11-01 08:00:00 +0530`. */
export function parseHealthDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-])(\d{2}):?(\d{2})|\s*Z)?$/.exec(String(s ?? '').trim())
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? `${m[3]}${m[4]}:${m[5]}` : 'Z'}`)
  return Number.isFinite(ms) ? { ms, day: m[1] } : null
}

const SUMS = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distance',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'energy',
}
const SLEEP_STAGE = {
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'asleep',
  HKCategoryValueSleepAnalysisAsleep: 'asleep',
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
}
const HEART = 'HKQuantityTypeIdentifierHeartRate'
const RESTING = 'HKQuantityTypeIdentifierRestingHeartRate'
const UNIT = /^[A-Za-z%/]{1,12}$/

export function createAggregator({ nowMs, maxDays = MAX_DAYS }) {
  const floor = nowMs - maxDays * DAY_MS
  /** @type {Map<string, any>} */
  const days = new Map()
  /** @type {any[]} */
  const workouts = []
  let records = 0
  const dayOf = (d) => {
    let v = days.get(d)
    if (!v) days.set(d, (v = { sums: {}, stages: new Map(), units: {}, hr: null, rhr: null }))
    return v
  }
  const addSum = (day, kind, source, n, unit) => {
    const bySource = (day.sums[kind] ??= new Map())
    bySource.set(source, (bySource.get(source) ?? 0) + n)
    if (unit && UNIT.test(unit)) day.units[kind] = unit
  }
  return {
    get records() { return records },
    add(name, a) {
      if (++records > MAX_RECORDS) throw new ConnectorError('bad-response', { detail: 'too many records in the export' })
      if (name === 'Workout') {
        const start = parseHealthDate(a.startDate)
        if (!start || start.ms < floor || !/^HKWorkoutActivityType[A-Za-z]{1,60}$/.test(a.workoutActivityType ?? '')) return
        const end = parseHealthDate(a.endDate)
        const dur = Number(a.duration)
        const mins = Number.isFinite(dur) ? (a.durationUnit === 'sec' ? dur / 60 : a.durationUnit === 'hr' ? dur * 60 : dur) : end ? (end.ms - start.ms) / 60_000 : null
        const dist = Number(a.totalDistance)
        const kcal = Number(a.totalEnergyBurned)
        workouts.push({
          startMs: start.ms, day: start.day, type: a.workoutActivityType.slice('HKWorkoutActivityType'.length),
          minutes: mins !== null && mins >= 0 && mins < 7 * 24 * 60 ? mins : null,
          distance: Number.isFinite(dist) && dist >= 0 ? dist : null,
          distanceUnit: UNIT.test(a.totalDistanceUnit ?? '') ? a.totalDistanceUnit : '',
          energy: Number.isFinite(kcal) && kcal >= 0 ? kcal : null,
          energyUnit: UNIT.test(a.totalEnergyBurnedUnit ?? '') ? a.totalEnergyBurnedUnit : '',
        })
        return
      }
      const type = a.type
      const source = clean(a.sourceName, 80) || 'unknown'
      if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
        const stage = SLEEP_STAGE[a.value]
        const s = parseHealthDate(a.startDate)
        const e = parseHealthDate(a.endDate)
        if (!stage || !s || !e || e.ms <= s.ms || e.ms - s.ms > 24 * 3_600_000 || e.ms < floor) return
        const d = dayOf(e.day)
        let per = d.stages.get(source)
        if (!per) d.stages.set(source, (per = {}))
        per[stage] = (per[stage] ?? 0) + (e.ms - s.ms)
        return
      }
      const kind = SUMS[type]
      const when = parseHealthDate(a.startDate)
      if (!when || when.ms < floor) return
      const v = Number(a.value)
      if (!Number.isFinite(v) || v < 0) return
      if (kind) return addSum(dayOf(when.day), kind, source, v, a.unit)
      if (type === HEART || type === RESTING) {
        const d = dayOf(when.day)
        const key = type === HEART ? 'hr' : 'rhr'
        const h = (d[key] ??= { n: 0, sum: 0, min: Infinity, max: -Infinity })
        h.n++; h.sum += v; h.min = Math.min(h.min, v); h.max = Math.max(h.max, v)
      }
    },
    finish() {
      return { days: [...days.entries()].map(([day, v]) => finishDay(day, v)).filter((d) => d.parts.length), workouts: workouts.sort((a, b) => b.startMs - a.startMs).slice(0, MAX_WORKOUTS) }
    },
  }
}

/** The source with the largest total wins. */
function best(map) {
  let top = null
  for (const [source, n] of map ?? []) if (!top || n > top.n) top = { source, n }
  return top
}

function finishDay(day, v) {
  const parts = []
  const sources = new Set()
  const meta = { kind: 'day', day }
  const steps = best(v.sums.steps)
  if (steps) { parts.push(`${Math.round(steps.n).toLocaleString('en-US')} steps`); meta.steps = Math.round(steps.n); sources.add(steps.source) }
  const dist = best(v.sums.distance)
  if (dist) { parts.push(`walking and running ${round(dist.n)} ${v.units.distance ?? 'km'}`); sources.add(dist.source) }
  const energy = best(v.sums.energy)
  if (energy) { parts.push(`active energy ${Math.round(energy.n)} ${v.units.energy ?? 'kcal'}`); sources.add(energy.source) }
  let top = null
  for (const [source, st] of v.stages) {
    const total = Object.values(st).reduce((a, b) => a + b, 0)
    if (!top || total > top.total) top = { source, st, total }
  }
  if (top && top.total >= 600_000) {
    const h = (ms) => round(ms / 3_600_000)
    const stages = ['core', 'deep', 'rem'].filter((k) => top.st[k]).map((k) => `${k === 'rem' ? 'REM' : k} ${h(top.st[k])}`)
    parts.push(`sleep ${h(top.total)} h${stages.length ? ` (${stages.join(', ')})` : ''}`)
    meta.sleepHours = h(top.total)
    sources.add(top.source)
  }
  if (v.hr) parts.push(`heart rate average ${Math.round(v.hr.sum / v.hr.n)} (low ${Math.round(v.hr.min)}, high ${Math.round(v.hr.max)}) bpm`)
  if (v.rhr) parts.push(`resting heart rate ${Math.round(v.rhr.sum / v.rhr.n)} bpm`)
  return { day, parts, sources: [...sources].slice(0, 4), meta }
}

const WORKOUT_NAME = (t) => t.replace(/([a-z])([A-Z])/g, '$1 $2')

export function dayToDocument(d) {
  return {
    id: `day:${d.day}`,
    title: `Health ${d.day}`,
    text: `Apple Health for ${d.day}: ${d.parts.join('; ')}.${d.sources.length ? `\nRecorded by: ${d.sources.join(', ')}.` : ''}`,
    updatedAt: Date.parse(`${d.day}T12:00:00Z`),
    sensitivity: 'health',
    meta: d.meta,
  }
}

export function workoutToDocument(w) {
  const bits = [
    w.minutes !== null ? `${Math.round(w.minutes)} min` : '',
    w.distance !== null && w.distance > 0 ? `${round(w.distance, 2)} ${w.distanceUnit}`.trim() : '',
    w.energy !== null && w.energy > 0 ? `${Math.round(w.energy)} ${w.energyUnit || 'kcal'}` : '',
  ].filter(Boolean)
  const name = WORKOUT_NAME(w.type)
  return {
    id: `workout:${w.startMs}`,
    title: `Workout ${w.day}: ${name}`,
    text: `Workout on ${w.day}: ${name}${bits.length ? `, ${bits.join(', ')}` : ''}.`,
    updatedAt: w.startMs,
    sensitivity: 'health',
    meta: { kind: 'workout', day: w.day },
  }
}

// ------------------------------------------------------------------ cursor

export function parseHealthCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 1000) return null
  try {
    const c = JSON.parse(cursor)
    if (!c || c.v !== 1 || typeof c.r !== 'string' || !Number.isFinite(c.m) || !Number.isFinite(c.s)) return null
    return { r: c.r, m: Math.floor(c.m), s: Math.floor(c.s) }
  } catch {
    return null
  }
}
export const healthCursor = ({ r, m, s }) => JSON.stringify({ v: 1, r, m, s })

// ------------------------------------------------------------------ the file

/**
 * Check and resolve the file the owner typed.
 * @returns {Promise<{ real: string, kind: 'zip' | 'xml', size: number, mtimeMs: number }>}
 */
export async function resolveExportFile(input, { home = homedir() } = {}) {
  let p = String(input ?? '').trim()
  if (!p) throw new ConnectorError('folder-missing', { detail: 'no file given' })
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(1))
  if (!isAbsolute(p)) throw new ConnectorError('folder-missing', { detail: 'the file must be a full path' })
  const lower = p.toLowerCase()
  const kind = lower.endsWith('.zip') ? 'zip' : lower.endsWith('.xml') ? 'xml' : null
  if (!kind) throw new ConnectorError('folder-missing', { detail: 'pick export.zip or export.xml' })
  let real
  let s
  try {
    real = await realpath(resolve(p))
    s = await stat(real)
    if (!s.isFile()) throw new Error('not a file')
  } catch {
    throw new ConnectorError('folder-missing', { detail: 'file not found or not a file' })
  }
  if (real.toLowerCase().endsWith('.zip') !== (kind === 'zip')) throw new ConnectorError('folder-missing', { detail: 'the file name does not match its target' })
  return { real, kind, size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
}

const HEALTH_SEES = [
  'The one Health export file you choose (export.zip, or the export.xml inside it).',
  'Daily steps, walking and running distance, active energy, sleep, heart rate and resting heart rate, and your workouts. Not clinical records, ECGs, photos, GPS routes or medications.',
  'This is health data. It stays on this device: JARVIS does not show it to a cloud model unless you allow health data there.',
  'Read-only: the file is never changed. It is read in a stream, so a big export does not fill memory.',
  'Disconnecting forgets the file location here. To refresh the data, export again and press Sync now.',
]

/** @param {{ home?: string, nowMs?: () => number }} [opts] */
export function appleHealthConnector({ home } = {}) {
  return Object.freeze({
    id: 'apple_health',
    create({ credentials, now }) {
      let lastSync

      async function fileOrThrow() {
        const real = credentials.get('file')
        if (!real) throw new ConnectorError('not-connected')
        try {
          const r = await resolveExportFile(real, home ? { home } : {})
          if (r.real !== real) throw new Error('moved or replaced by a link')
          return r
        } catch (err) {
          throw new ConnectorError('folder-missing', { detail: err?.detail ?? err?.message ?? 'file missing' })
        }
      }

      return {
        id: 'apple_health',
        name: 'Apple Health',
        kind: 'data',
        auth: 'filesystem',
        platforms: ['win', 'mac', 'linux'],
        risk: 'R2',
        capabilities: { read: true, write: false, subscribe: false },
        defaultSensitivity: 'health',
        setup: {
          sees: HEALTH_SEES,
          localWhy:
            'JARVIS reads the Apple Health export file you made on your iPhone, on this computer, to answer questions about your steps, sleep, heart rate and workouts. ' +
            'Type the full path of export.zip (or the export.xml inside it).',
          steps: [
            'On your iPhone open Health, tap your picture, then Export All Health Data, and send the file to this computer.',
            'Type the full path of export.zip (or export.xml) here and press Grant access.',
            'Export again whenever you want fresher data, then press Sync now.',
          ],
          testQuestion: 'How many steps did I walk last week?',
        },

        /** Grant pattern: `{ confirmed: true, path }`. Stores nothing unless the file is usable. */
        async connect({ confirmed, path } = {}) {
          if (confirmed !== true) throw new ConnectorError('consent-denied', { detail: 'not confirmed' })
          const f = await resolveExportFile(path, home ? { home } : {})
          credentials.set('file', f.real)
          lastSync = undefined
          const name = clean(basename(f.real), 100)
          return { account: name, detail: `Connected to "${name}" (read-only). Health data is kept on this device.` }
        },

        async disconnect() {
          credentials.delete('file')
          lastSync = undefined
        },

        status() {
          const real = credentials.get('file')
          if (!real) return { state: 'disconnected', detail: 'Not connected' }
          const s = { state: 'ok', detail: `Reading "${clean(basename(real), 100)}" (read-only, health data kept local)` }
          return lastSync ? { ...s, lastSync } : s
        },

        /** Looks at the start of the file only. */
        async test() {
          const f = await fileOrThrow()
          let ok = false
          const stream = xmlBytes(f.real, f.kind, f.size)
          try {
            await scanHealthXml(
              (async function* () {
                let seen = 0
                for await (const c of stream) {
                  yield c
                  seen += c.length
                  if (seen > 64 * 1024) return
                }
              })(),
              () => {},
              { maxBytes: 1024 * 1024 },
            ).then((r) => { ok = r.sawRoot })
          } catch (err) {
            if (err instanceof ConnectorError) throw err
            throw new ConnectorError('bad-response', { detail: 'could not read the file' })
          }
          if (!ok) throw new ConnectorError('bad-response', { detail: 'not an Apple Health export' })
          return { detail: 'Apple Health works: the export file looks right (read-only).' }
        },

        async *sync({ cursor } = {}) {
          const f = await fileOrThrow()
          const r = pathHash(f.real)
          const prev = parseHealthCursor(cursor)
          if (prev && prev.r === r && prev.m === f.mtimeMs && prev.s === f.size) {
            lastSync = now()
            yield { cursor }
            return
          }
          const agg = createAggregator({ nowMs: now() })
          let sawRoot
          try {
            ;({ sawRoot } = await scanHealthXml(xmlBytes(f.real, f.kind, f.size), (name, attrs) => agg.add(name, attrs)))
          } catch (err) {
            if (err instanceof ConnectorError) throw err
            throw new ConnectorError('bad-response', { detail: 'could not read the export' })
          }
          if (!sawRoot) throw new ConnectorError('bad-response', { detail: 'not an Apple Health export' })
          const { days, workouts } = agg.finish()
          days.sort((a, b) => (a.day < b.day ? 1 : -1))
          for (const d of days) if (DAY.test(d.day)) yield dayToDocument(d)
          for (const w of workouts) yield workoutToDocument(w)
          yield { cursor: healthCursor({ r, m: f.mtimeMs, s: f.size }) }
          lastSync = now()
        },
      }
    },
  })
}
