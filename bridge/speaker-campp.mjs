/**
 * The default speaker model: WeSpeaker CAM++ (VoxCeleb), as an ONNX file run
 * with onnxruntime-node inside the bridge. It sits behind the SpeakerEmbedder
 * interface of bridge/speaker.mjs.
 *
 * Nothing here is loaded until a voice is actually embedded: the model file
 * is downloaded on first use (about 29 MB, checked against a fixed SHA-256),
 * and onnxruntime-node is imported only then. Audio and voiceprints never
 * leave this machine; only the model file comes in.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAMPP_MODEL_ID = 'wespeaker-campp'
export const CAMPP_DIMENSIONS = 512
export const CAMPP_FILE = 'wespeaker_en_voxceleb_CAM++.onnx'
export const CAMPP_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx'
export const CAMPP_SHA256 = 'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef'

const SR = 16000
const FRAME = 400 // 25 ms
const SHIFT = 160 // 10 ms
const NFFT = 512
const NMEL = 80
const LOW_HZ = 20
const PREEMPH = 0.97
const EPS = 1.1920929e-7

const mel = (hz) => 1127 * Math.log(1 + hz / 700)

/** Kaldi's triangular mel filters: NMEL rows over the first NFFT/2 FFT bins. */
function melBank() {
  const bins = NFFT / 2
  const binHz = SR / NFFT
  const lo = mel(LOW_HZ)
  const hi = mel(SR / 2)
  const delta = (hi - lo) / (NMEL + 1)
  const bank = []
  for (let b = 0; b < NMEL; b++) {
    const left = lo + b * delta
    const center = lo + (b + 1) * delta
    const right = lo + (b + 2) * delta
    const w = new Float32Array(bins)
    for (let i = 0; i < bins; i++) {
      const m = mel(i * binHz)
      if (m > left && m < right) w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center)
    }
    bank.push(w)
  }
  return bank
}

/** Kaldi "povey" window: a Hann window raised to 0.85. */
function poveyWindow() {
  const w = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85)
  return w
}

/** In-place radix-2 FFT. */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

const BANK = melBank()
const WINDOW = poveyWindow()

/**
 * 80-dim log-mel filterbank features as Kaldi computes them (what WeSpeaker
 * models were trained on): samples scaled to 16-bit range, 25 ms frames every
 * 10 ms, DC removed, pre-emphasis 0.97, povey window, no dither, then the mean
 * of each dimension subtracted over the clip. Returns { data, frames }, data
 * being frames x 80 row-major.
 */
export function fbank(pcm) {
  const frames = pcm.length >= FRAME ? 1 + Math.floor((pcm.length - FRAME) / SHIFT) : 0
  const data = new Float32Array(frames * NMEL)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const x = new Float64Array(FRAME)
  for (let f = 0; f < frames; f++) {
    const off = f * SHIFT
    let mean = 0
    for (let i = 0; i < FRAME; i++) { x[i] = pcm[off + i] * 32768; mean += x[i] }
    mean /= FRAME
    for (let i = 0; i < FRAME; i++) x[i] -= mean
    for (let i = FRAME - 1; i > 0; i--) x[i] -= PREEMPH * x[i - 1]
    x[0] -= PREEMPH * x[0]
    re.fill(0); im.fill(0)
    for (let i = 0; i < FRAME; i++) re[i] = x[i] * WINDOW[i]
    fft(re, im)
    for (let b = 0; b < NMEL; b++) {
      let e = 0
      const w = BANK[b]
      for (let i = 0; i < NFFT / 2; i++) if (w[i]) e += w[i] * (re[i] * re[i] + im[i] * im[i])
      data[f * NMEL + b] = Math.log(Math.max(e, EPS))
    }
  }
  for (let b = 0; b < NMEL; b++) {
    let m = 0
    for (let f = 0; f < frames; f++) m += data[f * NMEL + b]
    m /= frames || 1
    for (let f = 0; f < frames; f++) data[f * NMEL + b] -= m
  }
  return { data, frames }
}

/** Reads `path` and checks its SHA-256; returns the bytes or null. */
function readVerified(path, sha256) {
  if (!existsSync(path)) return null
  const bytes = readFileSync(path)
  return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null
}

/**
 * Makes sure the model file is on disk and intact, downloading it once.
 * `fetchImpl` is injectable for tests. Throws code 'model-unavailable'.
 */
export async function ensureModel({ dir, url = CAMPP_URL, sha256 = CAMPP_SHA256, file = CAMPP_FILE, fetchImpl = fetch } = {}) {
  const path = join(dir, file)
  if (!sha256) throw Object.assign(new Error('speaker model unavailable: its checksum is not pinned yet'), { code: 'model-unavailable' })
  if (readVerified(path, sha256)) return path
  try {
    const res = await fetchImpl(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('download does not match the expected checksum')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, path)
    return path
  } catch (err) {
    throw Object.assign(new Error(`speaker model unavailable: ${err.message}`), { code: 'model-unavailable' })
  }
}

/** The default model, as a spec the generic embedder can run. */
export const CAMPP_SPEC = Object.freeze({
  id: CAMPP_MODEL_ID, dimensions: CAMPP_DIMENSIONS, file: CAMPP_FILE, url: CAMPP_URL, sha256: CAMPP_SHA256,
})

/**
 * An embedder for any model that takes the same 80-dim Kaldi fbank features
 * (WeSpeaker and 3D-Speaker exports do). `spec` is { id, dimensions, file,
 * url, sha256 }. `modelPath` (tests, offline installs) skips the download.
 * `ort` is injectable; by default onnxruntime-node is imported on first use.
 * warm() loads the model now, so a switch can find out it fails before
 * anything is deleted.
 */
export function createOnnxEmbedder(spec, { dir, modelPath, ort, fetchImpl } = {}) {
  let session = null
  let loading = null
  const open = async () => {
    const runtime = ort ?? (await import('onnxruntime-node'))
    const path = modelPath ?? (await ensureModel({ dir, url: spec.url, sha256: spec.sha256, file: spec.file, fetchImpl }))
    try {
      return { runtime, session: await runtime.InferenceSession.create(path) }
    } catch (err) {
      throw Object.assign(new Error(`speaker model unavailable: ${err.message}`), { code: 'model-unavailable' })
    }
  }
  const ready = async () => {
    loading ??= open().catch((err) => { loading = null; throw err })
    session ??= await loading
    return session
  }
  return {
    id: spec.id,
    dimensions: spec.dimensions,
    async warm() { await ready() },
    async embed(pcm) {
      const { runtime, session: s } = await ready()
      const { data, frames } = fbank(pcm)
      if (frames < 1) throw Object.assign(new Error('too-short'), { code: 'too-short' })
      const input = new runtime.Tensor('float32', data, [1, frames, NMEL])
      const out = await s.run({ [s.inputNames[0]]: input })
      return Float32Array.from(out[s.outputNames[0]].data)
    },
  }
}

/** The CAM++ embedder (the default model). */
export const createCamppEmbedder = (opts = {}) => createOnnxEmbedder(CAMPP_SPEC, opts)
