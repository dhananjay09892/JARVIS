/**
 * The npm packages the installed app needs at run time: everything that
 * bridge/ and launcher/ import. The UI is compiled into dist/ and needs none.
 *
 * scripts/package.mjs installs exactly these into the folder the Windows
 * installer wraps, at the versions package-lock.json records. A package the bridge
 * imports that is missing here works from source and fails in the installed
 * app, so scripts/runtime-packages.test.mjs checks this list against the
 * imports.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

/**
 * What to install into the staged app so that it gets the versions this
 * repository was tested with.
 *
 * The manifest pins each runtime package to the exact version package-lock.json
 * records. The lockfile is the repository's own, with its first entry (the
 * project itself) replaced by the staged app, so `npm ci` installs just the
 * runtime packages and what they need, each at its recorded version, and
 * refuses to run if the two files disagree. Installing by version range
 * instead picks up whatever is newest on the day of the build.
 *
 * @param {{ version: string }} pkg   the repository's package.json
 * @param {{ packages: Record<string, { version?: string }> }} lock  its package-lock.json
 * @returns {{ manifest: object, lock: object }}
 */
export function stagedInstall(pkg, lock, names = RUNTIME_PACKAGES) {
  const dependencies = {}
  for (const name of names) {
    const version = lock.packages?.[`node_modules/${name}`]?.version
    if (!version) throw new Error(`${name} is not in package-lock.json; run npm install and commit the lockfile`)
    dependencies[name] = version
  }
  const manifest = { name: 'jarvis-app', version: pkg.version, private: true, type: 'module', dependencies }
  const self = { name: manifest.name, version: manifest.version, dependencies }
  return { manifest, lock: { ...lock, name: manifest.name, version: manifest.version, packages: { ...lock.packages, '': self } } }
}

/** Every package installed under `appDir/node_modules`, nested ones included. */
export function installedPackages(appDir) {
  const found = []
  const walk = (modules) => {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const names = entry.name.startsWith('@')
        ? readdirSync(join(modules, entry.name)).map((n) => `${entry.name}/${n}`)
        : [entry.name]
      for (const name of names) {
        const dir = join(modules, name)
        if (!existsSync(join(dir, 'package.json'))) continue
        found.push({ name, version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, dir })
        if (existsSync(join(dir, 'node_modules'))) walk(join(dir, 'node_modules'))
      }
    }
  }
  const top = join(appDir, 'node_modules')
  if (existsSync(top)) walk(top)
  return found
}

/**
 * The staged packages whose version package-lock.json does not record, as
 * "name@version (lockfile has …)". Empty when the stage holds only tested
 * versions.
 */
export function versionsNotInLock(appDir, lock) {
  const recorded = new Map()
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!recorded.has(name)) recorded.set(name, new Set())
    recorded.get(name).add(entry.version)
  }
  return installedPackages(appDir)
    .filter((p) => !recorded.get(p.name)?.has(p.version))
    .map((p) => `${p.name}@${p.version} (lockfile has ${[...(recorded.get(p.name) ?? [])].join(', ') || 'no such package'})`)
    .sort()
}
