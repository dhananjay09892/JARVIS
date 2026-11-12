/**
 * The npm packages the installed app needs at run time: everything that
 * bridge/ and launcher/ import. The UI is compiled into dist/ and needs none.
 *
 * scripts/package.mjs installs exactly these into the folder the Windows
 * installer wraps, at the versions package.json gives. A package the bridge
 * imports that is missing here works from source and fails in the installed
 * app, so scripts/runtime-packages.test.mjs checks this list against the
 * imports.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const RUNTIME_PACKAGES = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
  // Speaker recognition (bridge/speaker-campp.mjs), loaded on first use.
  'onnxruntime-node',
  'ws',
  'zod',
])

/** Bytes used by everything under `dir`. */
function sizeOf(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
  }
  return total
}

/**
 * onnxruntime-node ships a native binary for every system it supports, in
 * `bin/napi-v3/<platform>/<arch>`, and at run time loads the one that matches
 * the Node it runs under. The installed app always runs the node.exe staged
 * beside it, so only that one folder can ever be loaded; the rest only makes
 * the installer bigger. This removes the rest from a staged `app` folder.
 *
 * It refuses to remove anything when the folder to keep is not there, so a
 * change in the package's layout stops the build instead of shipping an app
 * whose speaker recognition cannot load.
 *
 * @param {string} appDir    the staged app folder (holds node_modules)
 * @param {object} [target]  the Node that will run the app
 * @returns {{ kept: string, removed: string[], removedBytes: number }}
 */
export function pruneOnnxRuntime(appDir, { platform = process.platform, arch = process.arch } = {}) {
  const bin = join(appDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
  const kept = `${platform}/${arch}`
  if (!existsSync(join(bin, platform, arch, 'onnxruntime_binding.node'))) {
    throw new Error(`onnxruntime-node has no binary for ${kept} under ${bin}; nothing was removed`)
  }
  const removed = []
  let removedBytes = 0
  for (const p of readdirSync(bin)) {
    for (const a of readdirSync(join(bin, p))) {
      if (p === platform && a === arch) continue
      removedBytes += sizeOf(join(bin, p, a))
      rmSync(join(bin, p, a), { recursive: true, force: true })
      removed.push(`${p}/${a}`)
    }
    if (!readdirSync(join(bin, p)).length) rmSync(join(bin, p), { recursive: true, force: true })
  }
  return { kept, removed: removed.sort(), removedBytes }
}
