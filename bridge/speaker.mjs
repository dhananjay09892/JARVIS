/**
 * Speaker identification, first slice (plan 01, phase 1).
 *
 * Who is speaking? An embedder turns a few seconds of 16 kHz speech into a
 * vector; two clips of the same person give vectors with a high cosine
 * similarity. A voiceprint is a few such vectors per person.
 *
 *   SpeakerEmbedder   the one interface every model sits behind
 *                       { id, dimensions, embed(Float32Array pcm16k) -> Promise<Float32Array> }
 *   createVoiceprintStore  voiceprints on this machine only, hard delete
 *   createSpeakerService   enrol / identify / forget, owner or guest
 *
 * Voiceprints never leave this machine and are never sent to a model. The
 * model id is stored with every voiceprint, because vectors from different
 * models cannot be compared: a print made by another model is ignored, never
 * converted. Identity alone never authorises anything; it only picks the role
 * a turn is read at (a guest sees public information only).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CAMPP_MODEL_ID, createCamppEmbedder } from './speaker-campp.mjs'
import { sanitiseProfileOverride } from './language-profile.mjs'

export const SAMPLE_RATE = 16000
/** Shorter than this and a voice cannot be told from noise. */
export const MIN_SECONDS = 1
export const MAX_SECONDS = 30
/** Embeddings kept per person; the oldest is dropped past this. */
export const MAX_EMBEDDINGS = 20
export const ROLES = Object.freeze(['owner', 'member', 'child'])
export const BANDS = Object.freeze(['confident', 'unsure', 'unknown'])
export const DEFAULT_THRESHOLDS = Object.freeze({ confident: 0.6, unsure: 0.45 })

export function defaultSpeakerDir(env = process.env) {
  if (env.JARVIS_SPEAKER_DIR) return env.JARVIS_SPEAKER_DIR
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'JARVIS', 'speaker')
}

/** Throws unless `e` satisfies the SpeakerEmbedder interface. */
export function assertEmbedder(e) {
  if (!e || typeof e.id !== 'string' || !e.id) throw new Error('embedder needs an id')
  if (!Number.isInteger(e.dimensions) || e.dimensions < 1) throw new Error('embedder needs dimensions')
  if (typeof e.embed !== 'function') throw new Error('embedder needs embed()')
  return e
}

export const DEFAULT_MODEL_ID = CAMPP_MODEL_ID

/**
 * The embedder for `modelId`, or null for a model we do not know. The model
 * file is fetched and loaded on the first embed(), not here, so building the
 * service costs nothing; a failed fetch surfaces as code 'model-unavailable'.
 */
export function loadSpeakerEmbedder(modelId = DEFAULT_MODEL_ID, { dir = defaultSpeakerDir(), ...opts } = {}) {
  if (modelId !== CAMPP_MODEL_ID) return null
  return createCamppEmbedder({ dir: join(dir, 'models'), modelPath: process.env.JARVIS_SPEAKER_MODEL_PATH || undefined, ...opts })
}

export function cosine(a, b) {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Raw little-endian 16-bit mono PCM bytes -> floats in [-1, 1). */
export function pcm16ToFloat(buf) {
  const n = buf.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

export function band(score, t = DEFAULT_THRESHOLDS) {
  return score >= t.confident ? 'confident' : score >= t.unsure ? 'unsure' : 'unknown'
}

/**
 * Voiceprints in one JSON file (owner-only permissions), written atomically.
 * Shape: { people: [{ id, name, role, model, embeddings: number[][], created }] }
 */
export function createVoiceprintStore({ dir = defaultSpeakerDir(), clock = Date.now } = {}) {
  const file = join(dir, 'voiceprints.json')
  const load = () => {
    if (!existsSync(file)) return { people: [] }
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(d?.people) ? d : { people: [] }
    } catch {
      return { people: [] }
    }
  }
  const save = (data) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* not supported everywhere */ }
  }
  return {
    list: () => load().people,
    find: (id) => load().people.find((p) => p.id === id) ?? null,
    /** Add one embedding to a person, creating them if `id` is new. */
    add({ id, name, role, model, embedding }) {
      const data = load()
      let p = id ? data.people.find((x) => x.id === id) : null
      if (p && p.model !== model) throw new Error('model-mismatch')
      if (!p) {
        p = { id: randomUUID(), name, role, model, embeddings: [], created: clock() }
        data.people.push(p)
      }
      p.embeddings.push(Array.from(embedding))
      if (p.embeddings.length > MAX_EMBEDDINGS) p.embeddings.splice(0, p.embeddings.length - MAX_EMBEDDINGS)
      save(data)
      return p
    },
    /** Hard delete: the person and every embedding. */
    remove(id) {
      const data = load()
      const before = data.people.length
      data.people = data.people.filter((p) => p.id !== id)
      if (data.people.length !== before) save(data)
      return data.people.length !== before
    },
    /** Set (or with null/empty, clear) a person's own language choices. Returns the person, or null. */
    setLanguage(id, override) {
      const data = load()
      const p = data.people.find((x) => x.id === id)
      if (!p) return null
      const clean = sanitiseProfileOverride(override)
      if (Object.keys(clean).length) p.language = clean
      else delete p.language
      save(data)
      return p
    },
    clear() { save({ people: [] }) },
  }
}

export function createSpeakerService({ store, embedder, thresholds = DEFAULT_THRESHOLDS, clock = Date.now, carryMs = 20_000 } = {}) {
  assertEmbedder(embedder)
  let last = null // { personId, name, role, score, at }

  const check = (pcm) => {
    const secs = pcm.length / SAMPLE_RATE
    if (secs < MIN_SECONDS) throw Object.assign(new Error('too-short'), { code: 'too-short' })
    if (secs > MAX_SECONDS) throw Object.assign(new Error('too-long'), { code: 'too-long' })
  }
  const embed = async (pcm) => {
    check(pcm)
    const v = await embedder.embed(pcm)
    if (v.length !== embedder.dimensions) throw new Error('bad-embedding')
    return v
  }
  const safe = (p) => ({ id: p.id, name: p.name, role: p.role, clips: p.embeddings.length, language: sanitiseProfileOverride(p.language) })

  return {
    async enroll({ pcm, name, role = 'member', personId, consent }) {
      if (consent !== true) throw Object.assign(new Error('consent-required'), { code: 'consent-required' })
      if (!personId && !(typeof name === 'string' && name.trim() && name.length <= 60)) {
        throw Object.assign(new Error('name-required'), { code: 'name-required' })
      }
      if (!ROLES.includes(role)) throw Object.assign(new Error('bad-role'), { code: 'bad-role' })
      const embedding = await embed(pcm)
      const p = store.add({ id: personId, name: name?.trim(), role, model: embedder.id, embedding })
      return safe(p)
    },
    /** -> { speaker: {personId,name,role}|null, role, score, band } ; role is 'guest' unless confident. */
    async identify(pcm) {
      const v = await embed(pcm)
      let best = { score: -1, person: null }
      for (const p of store.list()) {
        if (p.model !== embedder.id) continue
        const score = Math.max(...p.embeddings.map((e) => cosine(v, e)))
        if (score > best.score) best = { score, person: p }
      }
      const score = best.person ? best.score : 0
      const b = best.person ? band(score, thresholds) : 'unknown'
      const known = b === 'confident' ? best.person : null
      last = {
        personId: known?.id ?? 'guest', name: known?.name ?? null, role: known?.role ?? 'guest', score, at: clock(),
      }
      return {
        speaker: known ? { personId: known.id, name: known.name, role: known.role } : null,
        role: last.role, score, band: b,
      }
    },
    /** Who spoke most recently, for the next turn; null when stale or unknown. */
    recent() {
      return last && clock() - last.at <= carryMs ? { ...last } : null
    },
    people: () => store.list().map(safe),
    /** A person's own language choices, or null (unknown id, guest, nothing set). */
    languageFor(personId) {
      const p = personId ? store.find(personId) : null
      const l = p ? sanitiseProfileOverride(p.language) : {}
      return Object.keys(l).length ? l : null
    },
    /** Replace a person's language choices; an empty object clears them. Returns the person or null. */
    setLanguage(personId, override) {
      const p = store.setLanguage(personId, override)
      return p ? safe(p) : null
    },
    forget: (id) => store.remove(id),
    forgetAll: () => { store.clear(); last = null },
  }
}

/** One line for the model about who is talking. Empty when nobody was identified. */
export function speakerPreface(recent) {
  if (!recent) return ''
  if (recent.role === 'guest') {
    return 'The voice was not recognised: treat the speaker as a guest. Chat only; do not share private information.'
  }
  return `The person speaking is ${recent.name} (${recent.role}).`
}
