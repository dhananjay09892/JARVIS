#!/usr/bin/env node
// Builds scripts/wake/configs/<model>.json from phrases.json and sources.json (Q47).
//
// Each file is an openWakeWord training config (openwakeword.train reads it with
// yaml.safe_load, and JSON is valid YAML) plus a "recipe" block that our own
// scripts read: which TTS voices to use and the Hindi/Gujarati negatives.
// Paths are relative to the recipe's work directory (see README).
//
//   node scripts/wake/make-configs.mjs          write the configs
//   node scripts/wake/make-configs.mjs --check  exit 1 if a committed config is stale

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function loadRecipe() {
  const phrases = JSON.parse(readFileSync(join(here, 'phrases.json'), 'utf8'))
  const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'))
  return { phrases, sources }
}

/** Source ids each config uses, by role. Every id must be commercial-use OK in sources.json. */
export const USES = {
  tts: ['kokoro-82m', 'piper-libritts-r'],
  negatives: ['libritts-r', 'fleurs', 'kathbath', 'musan'],
  background: ['musan', 'rirs-noises'],
  reverb: ['rirs-noises'],
  frontend: ['frontend-mel', 'frontend-embedding'],
}

const unique = (xs) => [...new Set(xs)]

export function buildConfig(model, phrases) {
  const { shared } = phrases
  const others = phrases.models.filter((m) => m.model !== model.model).map((m) => m.phrase.toLowerCase())
  return {
    model_name: model.model,
    target_phrase: model.say,
    custom_negative_phrases: unique([...model.negatives, ...others, ...shared.otherAssistants]),
    n_samples: shared.nSamples,
    n_samples_val: shared.nSamplesVal,
    tts_batch_size: 50,
    augmentation_batch_size: 16,
    piper_sample_generator_path: './tools/piper-sample-generator',
    output_dir: './models',
    rir_paths: ['./data16k/rirs-noises/rirs'],
    background_paths: ['./data16k/musan/noise', './data16k/musan/music', './data16k/rirs-noises/pointsource_noises'],
    background_paths_duplication_rate: [1, 1, 1],
    false_positive_validation_data_path: './features/validation_stream.npy',
    augmentation_rounds: 2,
    feature_data_files: { commercial_negatives: './features/negatives_train.npy' },
    batch_n_per_class: { commercial_negatives: 1024, adversarial_negative: 70, positive: 70 },
    model_type: 'dnn',
    layer_size: 32,
    steps: 50000,
    max_negative_weight: 1500,
    target_false_positives_per_hour: 0.2,
    recipe: {
      phrase: model.phrase,
      pronunciation: model.pronunciation,
      say_hindi: model.sayHindi,
      negatives_hindi: model.negativesHindi,
      voice_mix: shared.voiceMix,
      sources: USES,
      frontend: { melspec: './frontend/melspectrogram.onnx', embedding: './frontend/embedding_model.onnx' },
    },
  }
}

export function render(config) {
  return JSON.stringify(config, null, 2) + '\n'
}

function main() {
  const { phrases } = loadRecipe()
  const check = process.argv.includes('--check')
  const dir = join(here, 'configs')
  mkdirSync(dir, { recursive: true })
  let stale = 0
  for (const model of phrases.models) {
    const path = join(dir, `${model.model}.json`)
    const text = render(buildConfig(model, phrases))
    if (check) {
      let current = ''
      try {
        current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
      } catch {}
      if (current !== text) {
        console.error(`stale: ${path} (run node scripts/wake/make-configs.mjs)`)
        stale++
      }
    } else {
      writeFileSync(path, text)
      console.log(`wrote ${path}`)
    }
  }
  if (stale) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
