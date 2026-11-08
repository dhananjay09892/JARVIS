/**
 * Which speaker model is in use, and switching it (plan 01, Q82).
 *
 * The default is WeSpeaker CAM++. A user may pick one of the alternatives
 * listed here. Every model sits behind the SpeakerEmbedder interface of
 * bridge/speaker.mjs; each is downloaded the first time it is chosen and
 * checked against a pinned SHA-256. An entry whose checksum is not pinned yet
 * is listed but cannot be chosen.
 *
 * Vectors from different models cannot be compared, so switching deletes every
 * voiceprint and everyone enrols again: nothing is converted. The new model is
 * downloaded and loaded first, so a failed download leaves the old model and
 * the old voiceprints exactly as they were.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAMPP_MODEL_ID, CAMPP_SPEC, createOnnxEmbedder } from './speaker-campp.mjs'

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models'

export const SPEAKER_MODELS = Object.freeze([
  Object.freeze({
    ...CAMPP_SPEC,
    label: 'WeSpeaker CAM++ (default)',
    sizeMb: 29,
    licence: 'CC BY 4.0, trained on VoxCeleb',
  }),
  Object.freeze({
    id: 'wespeaker-resnet34',
    label: 'WeSpeaker ResNet34',
    file: 'wespeaker_en_voxceleb_resnet34.onnx',
    url: `${RELEASE}/wespeaker_en_voxceleb_resnet34.onnx`,
    sha256: null,
    dimensions: 256,
    sizeMb: 27,
    licence: 'CC BY 4.0, trained on VoxCeleb',
  }),
  Object.freeze({
    id: '3dspeaker-campp',
    label: '3D-Speaker CAM++ (English)',
    file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
    url: `${RELEASE}/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
    sha256: null,
    dimensions: 192,
    sizeMb: 28,
    licence: 'Apache-2.0, trained on VoxCeleb',
  }),
])

export const DEFAULT_SPEAKER_MODEL = CAMPP_MODEL_ID

export const modelSpec = (id, catalogue = SPEAKER_MODELS) => catalogue.find((m) => m.id === id) ?? null
/** Chooseable only once its checksum is pinned. */
export const isAvailable = (spec) => Boolean(spec?.sha256)

/** The embedder for a catalogue entry; the file is fetched on first use. */
export function embedderFor(id, { dir, catalogue = SPEAKER_MODELS, ...opts } = {}) {
  const spec = modelSpec(id, catalogue)
  return spec ? createOnnxEmbedder(spec, { dir: join(dir, 'models'), ...opts }) : null
}

/** The chosen model id, kept in <dir>/model.json; the default when nothing valid is stored. */
export function readChosenModel(dir, catalogue = SPEAKER_MODELS) {
  try {
    const id = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'))?.id
    return isAvailable(modelSpec(id, catalogue)) ? id : DEFAULT_SPEAKER_MODEL
  } catch {
    return DEFAULT_SPEAKER_MODEL
  }
}

function writeChosenModel(dir, id) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'model.json')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ id }), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * `store` is the voiceprint store (needs clear()). `makeEmbedder(id)` builds an
 * embedder (injectable for tests). Errors carry a code: 'unknown-model',
 * 'not-available' or 'model-unavailable'.
 */
export function createSpeakerModels({ dir, store, catalogue = SPEAKER_MODELS, makeEmbedder } = {}) {
  const build = makeEmbedder ?? ((id) => embedderFor(id, { dir, catalogue }))
  let current = readChosenModel(dir, catalogue)
  return {
    current: () => current,
    list: () => catalogue.map((m) => ({
      id: m.id, label: m.label, sizeMb: m.sizeMb, licence: m.licence,
      available: isAvailable(m), selected: m.id === current,
    })),
    /** The embedder for the model in use. */
    embedder: () => build(current),
    /**
     * Switch to `id`. Returns { embedder, changed }. When it changes, every
     * voiceprint is deleted (after the new model has loaded).
     */
    async switchTo(id) {
      const spec = modelSpec(id, catalogue)
      if (!spec) throw Object.assign(new Error('unknown-model'), { code: 'unknown-model' })
      if (!isAvailable(spec)) throw Object.assign(new Error('not-available'), { code: 'not-available' })
      const embedder = build(id)
      if (id === current) return { embedder, changed: false }
      await embedder.warm?.()
      writeChosenModel(dir, id)
      store.clear()
      current = id
      return { embedder, changed: true }
    },
  }
}

