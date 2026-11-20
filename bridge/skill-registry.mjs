/**
 * Skill registry (plan 19, phase 4): install, update, pin, roll back, switch
 * off and remove skill packs, always after a permission review.
 *
 * Packs live under `<root>/<id>/<version>/` (a copy of `skill.json` and, when
 * the manifest names one, its script). `<root>/registry.json` records which
 * version is active, whether it is pinned, and the older versions kept for
 * rollback. Nothing here runs a skill and nothing grants anything: the
 * manifest's permissions stay an upper bound that skill-manifest.mjs maps onto
 * the policy engine call by call.
 *
 * The review step cannot be skipped. `review(dir)` checks the pack, builds the
 * permission screen and returns a `reviewId`, which is a hash of everything
 * that will be installed (manifest text and script text). `install(dir,
 * { approve })` copies the pack only when `approve` equals the `reviewId` of
 * the files as they are now, so a pack edited between the review and the
 * install is refused and must be reviewed again.
 *
 * Pinning stops updates: an update to a pinned skill is refused until it is
 * unpinned. Rollback re-activates the previous version (which was reviewed
 * when it was installed). Removing deletes the pack and its record.
 *
 * Per-skill kill switch: `createSkillSwitches` reads the settings
 * `JARVIS_SKILL_SWITCHES` ("focus-mode=off") and `JARVIS_SKILLS_PAUSED`.
 * A switch can only stop a skill; the kill switch and the pause stop all of
 * them. Skills installed from outside are on until switched off.
 *
 * Messages are short and never echo file content, so they are safe to log.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithRetry } from './atomic-rename.mjs'
import { settingsDir } from './settings.mjs'
import { parseSwitches } from './agent-settings.mjs'
import {
  SKILL_FILE, describePermissions, loadSkillDir, previewSkill,
} from './skill-manifest.mjs'
import { checkCallArguments, readSkillScript, scanSkillContent } from './skill-sandbox.mjs'

export const SKILL_SETTINGS = Object.freeze({ paused: 'JARVIS_SKILLS_PAUSED', switches: 'JARVIS_SKILL_SWITCHES' })
export const SKILL_SETTING_IDS = Object.freeze(Object.values(SKILL_SETTINGS))

/** Where installed skills live. */
export const userSkillsDir = (env = process.env) => join(settingsDir(env), 'skills')
const REGISTRY_FILE = 'registry.json'
/** Older versions kept for rollback, per skill. */
export const MAX_KEPT_VERSIONS = 3
const MAX_SKILLS = 200
const SKILL_ID = /^[a-z][a-z0-9-]{0,39}$/
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** `1.2.3` as numbers, for ordering. */
const parts = (v) => v.split('.').map(Number)
export function compareVersions(a, b) {
  const x = parts(a); const y = parts(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** Which permissions a new version adds compared with the old one, as plain lines. */
export function permissionChanges(oldManifest, newManifest) {
  if (!oldManifest) return []
  const a = oldManifest.permissions; const b = newManifest.permissions
  const out = []
  for (const t of b.tools) if (!a.tools.includes(t)) out.push(`Now also uses the tool ${t}.`)
  for (const [c, access] of Object.entries(b.connectors)) {
    if (!a.connectors[c]) out.push(`Now also uses ${c} (${access}).`)
    else if (a.connectors[c] === 'read' && access === 'write') out.push(`Can now change data in ${c}.`)
  }
  for (const d of b.domains) if (!a.domains.includes(d)) out.push(`Can now reach ${d}.`)
  for (const p of b.paths) if (!a.paths.includes(p)) out.push(`Can now use ${p}.`)
  if (b.spend.maxCostUsd > a.spend.maxCostUsd) out.push(`Can now spend up to $${b.spend.maxCostUsd} per run.`)
  const order = ['low', 'medium', 'high']
  if (order.indexOf(newManifest.riskTier) > order.indexOf(oldManifest.riskTier)) out.push(`Risk went up to ${newManifest.riskTier}.`)
  return out
}

function readRegistry(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(data) || !isRecord(data.skills)) return { skills: {} }
    const skills = {}
    for (const [id, r] of Object.entries(data.skills).slice(0, MAX_SKILLS)) {
      if (!SKILL_ID.test(id) || !isRecord(r) || typeof r.version !== 'string' || !SEMVER.test(r.version)) continue
      skills[id] = {
        version: r.version,
        pinned: r.pinned === true,
        installedAt: typeof r.installedAt === 'string' ? r.installedAt : '',
        previous: Array.isArray(r.previous) ? r.previous.filter((v) => typeof v === 'string' && SEMVER.test(v)).slice(-MAX_KEPT_VERSIONS) : [],
      }
    }
    return { skills }
  } catch {
    return { skills: {} }
  }
}

function writeRegistry(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameWithRetry(tmp, file)
}

/** The hash a review is bound to: the manifest text plus the script text. */
function packHash(dir, manifestText, manifest) {
  let script = ''
  if (manifest.script !== undefined) {
    const s = readSkillScript(dir, manifest)
    if (!s.ok) return { ok: false, error: s.error }
    script = s.source
  }
  return { ok: true, hash: sha(`${sha(manifestText)}:${sha(script)}`), script }
}

/**
 * @param {object} [o]
 * @param {string} [o.root]     where installed skills live (default userSkillsDir())
 * @param {object} [o.policy]   a policy view, for the review screen's step preview
 * @param {() => Date} [o.now]
 */
export function createSkillRegistry({ root = userSkillsDir(), policy, now = () => new Date() } = {}) {
  const regFile = join(root, REGISTRY_FILE)
  const dirOf = (id, version) => join(root, id, version)

  function review(srcDir) {
    const loaded = loadSkillDir(srcDir)
    if (!loaded.ok) return { ok: false, errors: loaded.errors }
    const manifest = loaded.value
    let text
    try { text = readFileSync(join(srcDir, SKILL_FILE), 'utf8') } catch { return { ok: false, errors: ['(file): could not be read'] } }
    const h = packHash(srcDir, text, manifest)
    if (!h.ok) return { ok: false, errors: [`script: ${h.error}`] }
    const current = readRegistry(regFile).skills[manifest.id]
    let installed = null
    if (current) {
      const l = loadSkillDir(dirOf(manifest.id, current.version))
      installed = l.ok ? l.value : null
    }
    return {
      ok: true,
      reviewId: h.hash,
      manifest,
      screen: describePermissions(manifest, policy),
      steps: policy ? previewSkill(manifest, policy) : [],
      findings: scanSkillContent(manifest, h.script || undefined),
      installedVersion: current?.version ?? null,
      pinned: current?.pinned === true,
      changes: permissionChanges(installed, manifest),
    }
  }

  function install(srcDir, { approve } = {}) {
    const r = review(srcDir)
    if (!r.ok) return r
    if (typeof approve !== 'string' || approve !== r.reviewId) {
      return { ok: false, errors: ['review: the permission review was not approved for these exact files'], needsReview: true }
    }
    const reg = readRegistry(regFile)
    const id = r.manifest.id
    const version = r.manifest.version
    const cur = reg.skills[id]
    if (cur) {
      if (cur.pinned) return { ok: false, errors: [`pinned: ${id} is pinned at ${cur.version}; unpin it to update`] }
      if (compareVersions(version, cur.version) === 0) return { ok: false, errors: [`version: ${id} ${version} is already installed`] }
      if (compareVersions(version, cur.version) < 0) return { ok: false, errors: [`version: ${version} is older than the installed ${cur.version}; use roll back instead`] }
    } else if (Object.keys(reg.skills).length >= MAX_SKILLS) {
      return { ok: false, errors: [`registry: at most ${MAX_SKILLS} skills`] }
    }
    const dest = dirOf(id, version)
    try {
      mkdirSync(join(root, id), { recursive: true })
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      copyFileSync(join(srcDir, SKILL_FILE), join(dest, SKILL_FILE))
      if (r.manifest.script !== undefined) copyFileSync(join(srcDir, r.manifest.script), join(dest, r.manifest.script))
    } catch {
      rmSync(dest, { recursive: true, force: true })
      return { ok: false, errors: ['install: could not copy the skill'] }
    }
    const previous = cur ? [...cur.previous, cur.version].filter((v, i, a) => a.indexOf(v) === i) : []
    while (previous.length > MAX_KEPT_VERSIONS) {
      const old = previous.shift()
      rmSync(dirOf(id, old), { recursive: true, force: true })
    }
    reg.skills[id] = { version, pinned: false, installedAt: now().toISOString(), previous }
    writeRegistry(regFile, reg)
    return { ok: true, id, version, updatedFrom: cur?.version ?? null }
  }

  function change(id, fn) {
    const reg = readRegistry(regFile)
    const cur = reg.skills[id]
    if (!cur) return { ok: false, errors: [`${id}: not installed`] }
    const res = fn(cur, reg)
    if (res?.ok === false) return res
    writeRegistry(regFile, reg)
    return { ok: true, id, version: cur.version, pinned: cur.pinned }
  }

  return {
    root,
    review,
    install,
    /** Hold the installed version: updates are refused until unpinned. */
    pin: (id) => change(id, (c) => { c.pinned = true }),
    unpin: (id) => change(id, (c) => { c.pinned = false }),
    /** Go back to the version installed before this one. */
    rollback: (id) => change(id, (c) => {
      const prev = c.previous[c.previous.length - 1]
      if (!prev || !existsSync(dirOf(id, prev))) return { ok: false, errors: [`${id}: no earlier version to roll back to`] }
      const from = c.version
      c.previous = c.previous.slice(0, -1)
      c.version = prev
      c.pinned = true // a rollback is a decision to stay put until the owner unpins
      rmSync(dirOf(id, from), { recursive: true, force: true })
    }),
    remove(id) {
      const reg = readRegistry(regFile)
      if (!reg.skills[id]) return { ok: false, errors: [`${id}: not installed`] }
      delete reg.skills[id]
      writeRegistry(regFile, reg)
      rmSync(join(root, id), { recursive: true, force: true })
      return { ok: true, id }
    },
    /** Installed skills with their checked manifests. A pack that no longer checks is listed as broken. */
    list() {
      const reg = readRegistry(regFile)
      return Object.entries(reg.skills).sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => {
        const l = loadSkillDir(dirOf(id, r.version))
        return l.ok
          ? { id, version: r.version, pinned: r.pinned, installedAt: r.installedAt, canRollBack: r.previous.length > 0, manifest: l.value }
          : { id, version: r.version, pinned: r.pinned, installedAt: r.installedAt, canRollBack: r.previous.length > 0, broken: l.errors }
      })
    },
    get: (id) => {
      const r = readRegistry(regFile).skills[id]
      if (!r) return null
      const l = loadSkillDir(dirOf(id, r.version))
      return l.ok ? { id, version: r.version, pinned: r.pinned, dir: dirOf(id, r.version), manifest: l.value } : null
    },
  }
}

/**
 * Per-skill switches and the pause, read live from the settings registry.
 * @param {object} o
 * @param {(id: string) => string | undefined} o.read a setting's effective value
 * @param {() => boolean} [o.frozen] the kill switch
 */
export function createSkillSwitches({ read, frozen = () => false } = {}) {
  if (typeof read !== 'function') throw new Error('skill switches: read must be a function')
  const get = (id) => { try { const v = read(id); return typeof v === 'string' ? v : undefined } catch { return undefined } }
  // A kill-switch reading that cannot be taken counts as frozen (as in policy.mjs).
  const isFrozen = () => { try { return frozen() === true } catch { return true } }
  const paused = () => /^(1|true|on|yes)$/i.test((get(SKILL_SETTINGS.paused) ?? '').trim())
  const switches = () => parseSwitches(get(SKILL_SETTINGS.switches))
  return {
    isPaused: () => isFrozen() || paused(),
    /** Whether a skill may run now: not frozen, not paused, not switched off. */
    state(id) {
      if (isFrozen()) return { on: false, reason: 'JARVIS is frozen by the kill switch, so no skill runs.' }
      if (paused()) return { on: false, reason: 'All skills are paused. Switch them back on in Settings.' }
      if (switches().get(id) === false) return { on: false, reason: 'This skill is switched off in Settings.' }
      return { on: true }
    },
    isOn(id) { return this.state(id).on },
  }
}

// ---------------------------------------------------------------------------
// Using an installed skill
// ---------------------------------------------------------------------------

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * Find the skill whose trigger phrase is the whole utterance (after lower-casing
 * and dropping punctuation), among skills that are switched on. A sentence that
 * merely mentions a phrase does not match, so a skill never fires by accident.
 * Returns `{ id }` or null.
 */
export function matchSkill(skills, utterance, switches) {
  const u = norm(utterance)
  if (!u) return null
  for (const s of skills) {
    const m = s.manifest ?? s
    if (switches && !switches.isOn(m.id)) continue
    if (m.triggers.phrases.some((p) => norm(p) === u)) return { id: m.id }
  }
  return null
}

/**
 * Fill a skill's steps from the user's inputs. Checks required inputs and
 * types, replaces `{{input.name}}` in text fields, and holds each resulting
 * call to the manifest's path and website lists (the same check the sandbox
 * makes), so a filled-in value cannot point outside the grants.
 * Returns `{ ok, steps: [{ tool, input, label }] }` or `{ ok:false, errors }`.
 */
export function resolveSteps(manifest, inputs = {}) {
  const errors = []
  const given = isRecord(inputs) ? inputs : {}
  for (const [name, spec] of Object.entries(manifest.inputs)) {
    const v = given[name]
    if (v === undefined || v === null || v === '') {
      if (spec.required) errors.push(`inputs.${name}: needed`)
      continue
    }
    if (typeof v !== spec.type) errors.push(`inputs.${name}: must be ${spec.type}`)
    else if (typeof v === 'string' && (v.length > 2000 || v.includes('\0'))) errors.push(`inputs.${name}: too long`)
    else if (typeof v === 'number' && !Number.isFinite(v)) errors.push(`inputs.${name}: must be a number`)
  }
  for (const k of Object.keys(given)) if (!Object.hasOwn(manifest.inputs, k)) errors.push('inputs: unknown input')
  if (errors.length) return { ok: false, errors }
  const fill = (text) => text.replace(/\{\{\s*input\.([A-Za-z0-9_]*)\s*\}\}/g, (_, n) => String(given[n] ?? ''))
  const steps = manifest.steps.map((s) => ({
    tool: s.tool,
    label: s.label,
    input: Object.fromEntries(Object.entries(s.input).map(([k, v]) => [k, typeof v === 'string' ? fill(v) : v])),
  }))
  steps.forEach((s, i) => {
    const bad = checkCallArguments(manifest, s.input)
    if (bad) errors.push(`steps.${i}: ${bad}`)
  })
  return errors.length ? { ok: false, errors } : { ok: true, steps }
}

/** Packs shipped with the app: the first-party skills under bridge/skills/. */
export function listFirstPartyPacks(dir) {
  let names = []
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() } catch { /* none */ }
  return names.map((name) => ({ name, dir: join(dir, name) }))
}
