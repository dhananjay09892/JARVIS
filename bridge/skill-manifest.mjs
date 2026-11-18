/**
 * Skill packs: the manifest, its checks, a permission summary and the loader.
 *
 * A skill pack is a folder with a `skill.json`:
 *
 *   {
 *     "id": "focus-mode",
 *     "name": "Focus mode",
 *     "version": "1.0.0",
 *     "author": "Your name",
 *     "description": "Reads today's notes and lists what to focus on.",
 *     "riskTier": "low",
 *     "permissions": { "tools": ["Read"], "paths": ["notes/**"] },
 *     "triggers": { "phrases": ["start focus mode"] },
 *     "dataUse": "Reads files under notes/ on this computer. Nothing leaves it.",
 *     "steps": [{ "tool": "Read", "input": { "file_path": "notes/today.md" }, "label": "Read today's notes" }]
 *   }
 *
 * This module is the declarative half only: there is no script runtime, and
 * nothing here runs a step. It checks the file, shows what the skill asks for,
 * and maps it onto the policy engine.
 *
 * Nothing here grants anything. `permissions` is what the skill asks for, and
 * `createSkillGate` can only narrow what the policy engine already decides: a
 * tool outside the skill's grants is refused whatever the policy says, and a
 * tool inside them is still decided by the policy (writes off, the never-list
 * and the kill switch all apply). A step that uses a tool the manifest does not
 * list is a manifest error, so the mismatch is found when the pack is loaded,
 * not when it runs.
 *
 * Shared rules (tool names, connector names, cron strings and bus topics)
 * follow agent-definition.mjs, so a skill and an agent name things the same way.
 * Errors are short `path: message` strings that never echo the file's content,
 * so they are safe to log.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPolicy } from './policy.mjs'

export const SKILL_MANIFEST_VERSION = 1
export const SKILL_FILE = 'skill.json'
/** Largest skill.json we read, in characters. */
export const MAX_MANIFEST_CHARS = 64_000
export const RISK_TIERS = Object.freeze(['low', 'medium', 'high'])
export const INPUT_TYPES = Object.freeze(['string', 'number', 'boolean'])
const MAX_STEPS = 20
const MAX_TOOLS = 100

const SKILL_ID = /^[a-z][a-z0-9-]{0,39}$/
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const CONNECTOR = /^[a-z0-9][a-z0-9_-]{0,39}$/
const CRON = /^\S+(?:[ \t]+\S+){4}$/
const TOPIC = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/
const INPUT_NAME = /^[a-z][A-Za-z0-9_]{0,39}$/
// A host name, optionally with a leading `*.`; no scheme, port, path or bare wildcard.
const DOMAIN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/
const TEMPLATE = /\{\{\s*input\.([A-Za-z0-9_]*)\s*\}\}/g

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** A path grant: relative, inside the workspace, `/` separators, `*` and `**` allowed. */
export function isSafePathGrant(p) {
  if (!isString(p) || p.length < 1 || p.length > 200) return false
  if (p.includes('\0') || p.includes('\\') || /^[/~]/.test(p) || /^[A-Za-z]:/.test(p)) return false
  return !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')
}

const unknownKeys = (obj, known, path, err) => {
  for (const k of Object.keys(obj)) {
    // Only a well-formed key is echoed; anything else could be file content.
    if (!known.includes(k)) err(path, /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) ? `unknown field ${k}` : 'unknown field')
  }
}

/** Check a list of unique strings against a pattern; returns the list or []. */
function stringList(value, path, { max, check, what, err }) {
  if (value === undefined) return []
  if (!Array.isArray(value)) { err(path, 'must be a list'); return [] }
  if (value.length > max) err(path, `at most ${max} entries`)
  value.forEach((x, i) => { if (!check(x)) err(`${path}.${i}`, what) })
  if (new Set(value).size !== value.length) err(path, 'duplicate entry')
  return value
}

/**
 * Check one manifest object. On success `value` has unknown fields refused
 * (not dropped: a typo in a permission must not pass silently), strings
 * trimmed, and defaults filled in.
 */
export function checkSkillManifest(m) {
  if (!isRecord(m)) return { ok: false, errors: ['(root): must be an object'] }
  const errors = []
  const err = (path, message) => errors.push(`${path}: ${message}`)
  unknownKeys(m, [
    'v', 'id', 'name', 'version', 'author', 'description', 'riskTier',
    'permissions', 'triggers', 'inputs', 'dataUse', 'steps',
  ], '(root)', err)
  const out = {}

  out.v = m.v === undefined ? SKILL_MANIFEST_VERSION : m.v
  if (out.v !== SKILL_MANIFEST_VERSION) err('v', `must be ${SKILL_MANIFEST_VERSION}`)

  if (!isString(m.id) || !SKILL_ID.test(m.id)) err('id', 'skill id must be lowercase letters, digits and dashes, starting with a letter')
  out.id = m.id

  for (const [field, max] of [['name', 60], ['author', 80], ['description', 500], ['dataUse', 500]]) {
    if (!isString(m[field])) { err(field, 'must be a string'); continue }
    const t = m[field].trim()
    if (t.length < 1) err(field, 'must not be empty')
    else if (t.length > max) err(field, `must be at most ${max} characters`)
    out[field] = t
  }

  if (!isString(m.version) || !SEMVER.test(m.version)) err('version', 'must look like 1.0.0')
  out.version = m.version

  if (!RISK_TIERS.includes(m.riskTier)) err('riskTier', `must be one of ${RISK_TIERS.join(', ')}`)
  out.riskTier = m.riskTier

  // permissions: what the skill asks for. Empty means nothing.
  const perms = m.permissions === undefined ? {} : m.permissions
  out.permissions = { tools: [], connectors: {}, domains: [], paths: [], spend: { maxCostUsd: 0 } }
  if (!isRecord(perms)) err('permissions', 'must be an object')
  else {
    unknownKeys(perms, ['tools', 'connectors', 'domains', 'paths', 'spend'], 'permissions', err)
    out.permissions.tools = stringList(perms.tools, 'permissions.tools', {
      max: MAX_TOOLS, check: (t) => isString(t) && TOOL.test(t), what: 'invalid tool name', err,
    })
    if (perms.connectors !== undefined) {
      if (!isRecord(perms.connectors)) err('permissions.connectors', 'must be a map of connector to read or write')
      else {
        for (const [name, access] of Object.entries(perms.connectors)) {
          if (!CONNECTOR.test(name)) err('permissions.connectors', 'invalid connector name')
          else if (access !== 'read' && access !== 'write') err(`permissions.connectors.${name}`, 'must be read or write')
          out.permissions.connectors[name] = access
        }
      }
    }
    out.permissions.domains = stringList(perms.domains, 'permissions.domains', {
      max: 50, check: (d) => isString(d) && DOMAIN.test(d), what: 'must be a host name such as example.com or *.example.com', err,
    })
    out.permissions.paths = stringList(perms.paths, 'permissions.paths', {
      max: 50, check: isSafePathGrant, what: 'must be a relative path inside the workspace, without .. or a leading /', err,
    })
    if (perms.spend !== undefined) {
      if (!isRecord(perms.spend)) err('permissions.spend', 'must be an object')
      else {
        unknownKeys(perms.spend, ['maxCostUsd'], 'permissions.spend', err)
        if (!(isNumber(perms.spend.maxCostUsd) && perms.spend.maxCostUsd >= 0 && perms.spend.maxCostUsd <= 100)) {
          err('permissions.spend.maxCostUsd', 'must be a number from 0 to 100')
        }
        out.permissions.spend = { maxCostUsd: perms.spend.maxCostUsd }
      }
    }
  }

  // triggers: voice phrases, a schedule, bus events. None means on demand only.
  const trig = m.triggers === undefined ? {} : m.triggers
  out.triggers = { phrases: [], schedule: null, events: [] }
  if (!isRecord(trig)) err('triggers', 'must be an object')
  else {
    unknownKeys(trig, ['phrases', 'schedule', 'events'], 'triggers', err)
    out.triggers.phrases = stringList(trig.phrases, 'triggers.phrases', {
      max: 10, check: (p) => isString(p) && p.trim().length >= 3 && p.trim().length <= 80, what: 'a phrase must be 3 to 80 characters', err,
    }).map((p) => (isString(p) ? p.trim() : p))
    if (trig.schedule !== undefined && trig.schedule !== null) {
      if (!(isString(trig.schedule) && CRON.test(trig.schedule))) err('triggers.schedule', 'schedule must be a 5-field cron string')
      out.triggers.schedule = trig.schedule
    }
    out.triggers.events = stringList(trig.events, 'triggers.events', {
      max: 10, check: (t) => isString(t) && TOPIC.test(t), what: 'must be a bus topic such as meeting.ended', err,
    })
  }

  // inputs: what the skill asks the user for.
  const inputs = m.inputs === undefined ? {} : m.inputs
  out.inputs = {}
  if (!isRecord(inputs)) err('inputs', 'must be a map of input name to its type')
  else {
    if (Object.keys(inputs).length > 10) err('inputs', 'at most 10 inputs')
    for (const [name, spec] of Object.entries(inputs)) {
      if (!INPUT_NAME.test(name)) { err('inputs', 'invalid input name'); continue }
      if (!isRecord(spec)) { err(`inputs.${name}`, 'must be an object'); continue }
      unknownKeys(spec, ['type', 'description', 'required'], `inputs.${name}`, err)
      if (!INPUT_TYPES.includes(spec.type)) err(`inputs.${name}.type`, `must be one of ${INPUT_TYPES.join(', ')}`)
      if (!isString(spec.description) || spec.description.trim().length < 1 || spec.description.length > 200) {
        err(`inputs.${name}.description`, 'must be 1 to 200 characters')
      }
      if (spec.required !== undefined && typeof spec.required !== 'boolean') err(`inputs.${name}.required`, 'must be true or false')
      out.inputs[name] = {
        type: spec.type,
        description: isString(spec.description) ? spec.description.trim() : spec.description,
        required: spec.required === undefined ? true : spec.required,
      }
    }
  }

  // steps: declarative tool calls; each tool must be one the skill declared.
  out.steps = []
  if (!Array.isArray(m.steps) || m.steps.length < 1 || m.steps.length > MAX_STEPS) {
    err('steps', `a skill needs 1 to ${MAX_STEPS} steps`)
  } else {
    m.steps.forEach((s, i) => {
      const at = `steps.${i}`
      if (!isRecord(s)) { err(at, 'must be an object'); return }
      unknownKeys(s, ['tool', 'input', 'label'], at, err)
      if (!isString(s.tool) || !TOOL.test(s.tool)) err(`${at}.tool`, 'invalid tool name')
      else if (!out.permissions.tools.includes(s.tool)) err(`${at}.tool`, 'this tool is not in permissions.tools, so the skill is not granted it')
      let input = {}
      if (s.input !== undefined) {
        if (!isRecord(s.input)) err(`${at}.input`, 'must be an object')
        else {
          input = {}
          for (const [k, v] of Object.entries(s.input)) {
            if (!FIELD_NAME.test(k)) { err(`${at}.input`, 'invalid field name'); continue }
            if (!(isString(v) || isNumber(v) || typeof v === 'boolean')) { err(`${at}.input.${k}`, 'must be text, a number or true/false'); continue }
            if (isString(v) && v.length > 2000) { err(`${at}.input.${k}`, 'must be at most 2000 characters'); continue }
            if (isString(v)) {
              for (const ref of v.matchAll(TEMPLATE)) {
                if (!Object.hasOwn(out.inputs, ref[1])) err(`${at}.input.${k}`, 'refers to an input the skill does not declare')
              }
            }
            input[k] = v
          }
        }
      }
      let label = ''
      if (s.label !== undefined) {
        if (!isString(s.label) || s.label.length > 80) err(`${at}.label`, 'must be text of at most 80 characters')
        else label = s.label.trim()
      }
      out.steps.push({ tool: s.tool, input, label })
    })
  }

  // Cross-field rules, only once every field is well-formed.
  if (errors.length === 0) {
    const effectful = out.permissions.tools.some((t) => toolEffect(t) === 'action')
      || Object.values(out.permissions.connectors).includes('write')
    const reachesOut = out.permissions.domains.length > 0 || out.permissions.spend.maxCostUsd > 0
    if (effectful && out.riskTier === 'low') err('riskTier', 'a skill that can act, write or spend cannot be low risk')
    if (effectful && out.permissions.spend.maxCostUsd > 0 && out.riskTier !== 'high') err('riskTier', 'a skill that can spend money must be high risk')
    if (reachesOut && out.riskTier === 'low') err('riskTier', 'a skill that reaches the internet or spends cannot be low risk')
    if (out.triggers.schedule !== null && out.riskTier === 'high') err('triggers.schedule', 'a high-risk skill cannot run on a schedule')
    if (out.triggers.events.length > 0 && out.riskTier === 'high') err('triggers.events', 'a high-risk skill cannot start from an event')
    for (const [name, spec] of Object.entries(out.inputs)) {
      if (!spec.required) continue
      const used = out.steps.some((s) => Object.values(s.input).some((v) => isString(v) && [...v.matchAll(TEMPLATE)].some((r) => r[1] === name)))
      if (!used) err(`inputs.${name}`, 'is declared but no step uses it')
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out }
}

/** Parse the text of a skill.json and check it. */
export function parseSkillManifest(text) {
  if (!isString(text)) return { ok: false, errors: ['(file): must be text'] }
  if (text.length > MAX_MANIFEST_CHARS) return { ok: false, errors: [`(file): larger than ${MAX_MANIFEST_CHARS} characters`] }
  let data
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false, errors: ['(file): not valid JSON'] }
  }
  return checkSkillManifest(data)
}

// ---------------------------------------------------------------------------
// The policy engine
// ---------------------------------------------------------------------------

// What a tool does is the policy's call: a tool the policy would run with
// general writes off only reads. A probe is built once; own-server tools
// whose lists the probe does not know come out as 'action', the careful side.
let probe = null
/** 'read' when the policy runs the tool with writes off, otherwise 'action'. */
export function toolEffect(name, policy) {
  const p = policy ?? (probe ??= createPolicy({ allowWrites: false }))
  return p.decide({ kind: 'tool', name }).verdict === 'allow' ? 'read' : 'action'
}

export const SKILL_RULE_REASONS = Object.freeze({
  'skill-ungranted': 'The skill did not ask for this tool, so it cannot use it.',
  'skill-unknown': 'No skill manifest was given.',
})

/**
 * The policy as one skill sees it. `policy` is a policy view (createPolicy()
 * or its forAgent()); the result has the same `decide` and `decideTool`, and
 * can only be stricter: a tool outside `manifest.permissions.tools` is refused
 * with rule `skill-ungranted` without asking the policy, and one inside is
 * decided by the policy as usual.
 */
export function createSkillGate({ manifest, policy }) {
  const granted = new Set(Array.isArray(manifest?.permissions?.tools) ? manifest.permissions.tools : [])
  const noManifest = !isRecord(manifest) || !Array.isArray(manifest.permissions?.tools)
  const deny = (rule) => ({ verdict: 'deny', rule, reason: SKILL_RULE_REASONS[rule] })
  const decide = (action) => {
    if (noManifest) return deny('skill-unknown')
    if (action?.kind !== 'tool' || !granted.has(action.name)) return deny('skill-ungranted')
    return policy.decide(action)
  }
  return Object.freeze({
    skillId: manifest?.id ?? null,
    decide,
    decideTool: (name) => decide({ kind: 'tool', name }).verdict === 'allow',
  })
}

/**
 * Walk the steps through a skill's gate without running anything. Returns one
 * row per step: what the gate says now, so the owner sees, before installing,
 * which steps would run, which wait for "allow writes" and which are refused.
 */
export function previewSkill(manifest, policy) {
  const gate = createSkillGate({ manifest, policy })
  return manifest.steps.map((s, i) => {
    const d = gate.decide({ kind: 'tool', name: s.tool })
    return { step: i + 1, tool: s.tool, label: s.label, verdict: d.verdict, rule: d.rule, reason: d.reason }
  })
}

// ---------------------------------------------------------------------------
// Permission display
// ---------------------------------------------------------------------------

/**
 * What to show the owner before a skill is installed or run: plain-language
 * lines, one per thing it asks for, and the data-use note. Tools are split
 * into those that only read and those that act (per the policy engine).
 */
export function describePermissions(manifest, policy) {
  const p = manifest.permissions
  const read = []
  const act = []
  for (const t of p.tools) (toolEffect(t, policy) === 'read' ? read : act).push(t)
  const lines = []
  if (read.length) lines.push(`Can look things up with: ${read.join(', ')}.`)
  if (act.length) lines.push(`Can act with: ${act.join(', ')}. Each still passes the safety rules and needs "allow actions" turned on.`)
  for (const [name, access] of Object.entries(p.connectors)) {
    lines.push(access === 'write' ? `Can change data in ${name}.` : `Can read ${name}.`)
  }
  if (p.domains.length) lines.push(`Can reach these websites: ${p.domains.join(', ')}.`)
  if (p.paths.length) lines.push(`Can use these files and folders: ${p.paths.join(', ')}.`)
  if (p.spend.maxCostUsd > 0) lines.push(`Can spend up to $${p.spend.maxCostUsd} per run.`)
  if (lines.length === 0) lines.push('Asks for no permissions.')
  const t = manifest.triggers
  const starts = []
  if (t.phrases.length) starts.push(`when you say ${t.phrases.map((x) => `"${x}"`).join(' or ')}`)
  if (t.schedule) starts.push(`on the schedule ${t.schedule}`)
  if (t.events.length) starts.push(`when ${t.events.join(' or ')} happens`)
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    riskTier: manifest.riskTier,
    summary: manifest.description,
    permissions: lines,
    startsOn: starts.length ? starts : ['only when you ask for it by name'],
    dataUse: manifest.dataUse,
  }
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/**
 * Read and check one skill folder. The folder name must equal the skill id,
 * and skill.json must be a plain file (a link could point anywhere).
 */
export function loadSkillDir(dir, name) {
  const file = join(dir, SKILL_FILE)
  let st
  try { st = lstatSync(file) } catch { return { ok: false, errors: [`(file): no ${SKILL_FILE} in this folder`] } }
  if (!st.isFile()) return { ok: false, errors: [`(file): ${SKILL_FILE} must be a plain file`] }
  if (st.size > MAX_MANIFEST_CHARS * 4) return { ok: false, errors: [`(file): larger than ${MAX_MANIFEST_CHARS} characters`] }
  let text
  try { text = readFileSync(file, 'utf8') } catch { return { ok: false, errors: ['(file): could not be read'] } }
  const r = parseSkillManifest(text)
  if (r.ok && name !== undefined && r.value.id !== name) {
    return { ok: false, errors: ['id: must match the name of the skill folder'] }
  }
  return r
}

/**
 * Load every skill folder under `root`. One bad pack never stops the others:
 * it comes back in `rejected` with its errors. Plain files and links at the
 * top level are ignored. Skills are sorted by id.
 */
export function loadSkills(root) {
  const skills = []
  const rejected = []
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return { skills, rejected } }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue
    const r = loadSkillDir(join(root, e.name), e.name)
    if (r.ok) skills.push(r.value)
    else rejected.push({ folder: e.name, errors: r.errors })
  }
  return { skills, rejected }
}
