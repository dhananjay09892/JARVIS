/**
 * Agent definitions: one named specialist per Markdown file.
 *
 * A file is a frontmatter header (the fields below) and the agent's
 * instructions as the body, the same shape as Claude Code sub-agents so
 * definitions stay portable:
 *
 *   ---
 *   id: researcher
 *   name: Researcher
 *   description: Finds, compares and cites sources.
 *   tools:
 *     - web_search
 *   memory: read
 *   ---
 *
 *   You are JARVIS's researcher. …
 *
 * The validated shape is the `AgentDefinition` contract in shared/contracts.ts
 * (plan 38). This module is the bridge's copy of it in plain JavaScript, so the
 * bridge loads without a TypeScript step and without zod;
 * agent-definition.test.mjs runs both against the same inputs so the two never
 * drift apart.
 *
 * Nothing here grants anything. A definition can only narrow: `tools` is an
 * allow-list (empty means no tools), connectors are read-only unless `write`
 * is listed (and the policy still decides), memory is never written directly,
 * and only the Coordinator may delegate. Whether a tool or connector actually
 * exists is the registry's job, not this module's.
 *
 * The header is a small YAML subset: `key: value`, nested maps and `- item`
 * lists by indentation (spaces only), quoted or plain scalars, `null`,
 * booleans, numbers, `[]`/`{}` and short flow lists like `[a, b]`, and `#`
 * comments. Anchors, aliases, tags and multi-line strings are refused rather
 * than guessed at. Errors are short `path: message` strings that never echo
 * the file's content, so they are safe to log.
 */

export const CONTRACT_VERSION = 1
export const COORDINATOR_ID = 'coordinator'
export const AGENT_MODES = Object.freeze(['on-demand', 'scheduled', 'triggered', 'continuous'])
/** Modes that run without the owner asking each time; these need a budget. */
export const UNATTENDED_MODES = Object.freeze(['scheduled', 'triggered', 'continuous'])
export const MEMORY_SCOPES = Object.freeze(['none', 'read', 'propose'])
export const OUTPUT_KINDS = Object.freeze(['report', 'draft', 'artifact', 'alert', 'none'])
export const CREATORS = Object.freeze(['builtin', 'user', 'agent'])
/** Largest definition file we read, in characters. */
export const MAX_FILE_CHARS = 64_000

// Same rules as shared/contracts.ts.
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const CONNECTOR = /^[a-z0-9][a-z0-9_-]{0,39}$/
const ICON = /^[a-z0-9-]{1,40}$/
const CRON = /^\S+(?:[ \t]+\S+){4}$/
const TOPIC = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/
const BRAIN = /^(?:external:)?[a-z][a-z0-9-]{0,39}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** Fields in file order (TEMPLATE order); `body` is the Markdown after the header. */
export const FIELD_ORDER = Object.freeze([
  'id', 'name', 'description', 'icon', 'mode', 'schedule', 'trigger', 'brain', 'model',
  'tools', 'connectors', 'memory', 'budget', 'review', 'delegate', 'output', 'createdBy', 'requestedBy',
])

/**
 * Check one definition object. Mirrors `checkContract('AgentDefinition', d)`:
 * on success `value` has unknown fields dropped, strings trimmed where the
 * contract trims them, and defaults filled in.
 */
export function checkAgentDefinition(d) {
  if (!isRecord(d)) return { ok: false, errors: ['(root): must be an object'] }
  const errors = []
  const err = (path, message) => errors.push(`${path}: ${message}`)
  const out = {}

  const v = d.v === undefined ? CONTRACT_VERSION : d.v
  if (v !== CONTRACT_VERSION) err('v', `must be ${CONTRACT_VERSION}`)
  out.v = v

  if (!isString(d.id) || !AGENT_ID.test(d.id)) err('id', 'agent id must be lowercase letters, digits and dashes, starting with a letter')
  out.id = d.id

  for (const [field, max] of [['name', 60], ['description', 500]]) {
    if (!isString(d[field])) { err(field, 'must be a string'); continue }
    const t = d[field].trim()
    if (t.length < 1) err(field, 'must not be empty')
    else if (t.length > max) err(field, `must be at most ${max} characters`)
    out[field] = t
  }

  if (d.icon !== undefined) {
    if (!isString(d.icon) || !ICON.test(d.icon)) err('icon', 'invalid icon name')
    out.icon = d.icon
  }

  out.mode = d.mode === undefined ? 'on-demand' : d.mode
  if (!AGENT_MODES.includes(out.mode)) err('mode', `must be one of ${AGENT_MODES.join(', ')}`)

  out.schedule = d.schedule === undefined ? null : d.schedule
  if (out.schedule !== null && !(isString(out.schedule) && CRON.test(out.schedule))) err('schedule', 'schedule must be a 5-field cron string')
  out.trigger = d.trigger === undefined ? null : d.trigger
  if (out.trigger !== null && !(isString(out.trigger) && TOPIC.test(out.trigger))) err('trigger', 'trigger must be a bus topic such as meeting.ended')

  out.brain = d.brain === undefined ? 'claude' : d.brain
  if (!isString(out.brain) || !BRAIN.test(out.brain)) err('brain', 'invalid brain name')
  out.model = d.model === undefined ? 'default' : d.model
  if (!isString(out.model) || !MODEL.test(out.model)) err('model', 'invalid model id')

  out.tools = d.tools === undefined ? [] : d.tools
  if (!Array.isArray(out.tools)) err('tools', 'must be a list')
  else {
    if (out.tools.length > 100) err('tools', 'at most 100 tools')
    out.tools.forEach((t, i) => { if (!isString(t) || !TOOL.test(t)) err(`tools.${i}`, 'invalid tool name') })
  }

  const connectors = d.connectors === undefined ? {} : d.connectors
  out.connectors = connectors
  if (!isRecord(connectors)) err('connectors', 'must be a map of connector to read or write')
  else {
    out.connectors = {}
    for (const [name, access] of Object.entries(connectors)) {
      // Only a well-formed name goes into the error path; anything else could be file content.
      if (!CONNECTOR.test(name)) err('connectors', 'invalid connector name')
      else if (access !== 'read' && access !== 'write') err(`connectors.${name}`, 'must be read or write')
      out.connectors[name] = access
    }
  }

  out.memory = d.memory === undefined ? 'none' : d.memory
  if (!MEMORY_SCOPES.includes(out.memory)) {
    err('memory', out.memory === 'write' ? 'agents never write memory directly; use propose' : 'memory must be none, read or propose')
  }

  if (d.budget !== undefined) {
    const b = d.budget
    if (!isRecord(b)) err('budget', 'must be an object')
    else {
      if (!(Number.isInteger(b.maxToolCalls) && b.maxToolCalls > 0 && b.maxToolCalls <= 1000)) err('budget.maxToolCalls', 'must be a whole number from 1 to 1000')
      if (!(isNumber(b.maxMinutes) && b.maxMinutes > 0 && b.maxMinutes <= 1440)) err('budget.maxMinutes', 'must be a number above 0, at most 1440')
      if (!(isNumber(b.maxCostUsd) && b.maxCostUsd >= 0 && b.maxCostUsd <= 100)) err('budget.maxCostUsd', 'must be a number from 0 to 100')
      out.budget = { maxToolCalls: b.maxToolCalls, maxMinutes: b.maxMinutes, maxCostUsd: b.maxCostUsd }
    }
  }

  out.review = d.review === undefined ? false : d.review
  if (typeof out.review !== 'boolean') err('review', 'must be true or false')

  out.delegate = d.delegate === undefined ? [] : d.delegate
  if (!Array.isArray(out.delegate)) err('delegate', 'must be a list')
  else {
    if (out.delegate.length > 20) err('delegate', 'at most 20 agents')
    out.delegate.forEach((a, i) => { if (!isString(a) || !AGENT_ID.test(a)) err(`delegate.${i}`, 'agent id must be lowercase letters, digits and dashes, starting with a letter') })
  }

  out.output = d.output === undefined ? 'report' : d.output
  if (!OUTPUT_KINDS.includes(out.output)) err('output', `must be one of ${OUTPUT_KINDS.join(', ')}`)
  out.createdBy = d.createdBy === undefined ? 'user' : d.createdBy
  if (!CREATORS.includes(out.createdBy)) err('createdBy', `must be one of ${CREATORS.join(', ')}`)
  if (d.requestedBy !== undefined) {
    if (!isString(d.requestedBy) || !AGENT_ID.test(d.requestedBy)) err('requestedBy', 'agent id must be lowercase letters, digits and dashes, starting with a letter')
    out.requestedBy = d.requestedBy
  }

  if (!isString(d.body)) err('body', 'must be a string')
  else {
    const t = d.body.trim()
    if (t.length < 1) err('body', 'the instructions must not be empty')
    else if (t.length > 20_000) err('body', 'must be at most 20000 characters')
    out.body = t
  }

  // Cross-field rules; zod runs these only once every field is well-formed.
  if (errors.length === 0) {
    if (out.mode === 'scheduled' && out.schedule === null) err('schedule', 'a scheduled agent needs a schedule')
    if (out.mode !== 'scheduled' && out.schedule !== null) err('schedule', 'only a scheduled agent has a schedule')
    if (out.mode === 'triggered' && out.trigger === null) err('trigger', 'a triggered agent needs a trigger')
    if (out.mode !== 'triggered' && out.trigger !== null) err('trigger', 'only a triggered agent has a trigger')
    if (UNATTENDED_MODES.includes(out.mode) && out.budget === undefined) err('budget', `a ${out.mode} agent needs a budget`)
    if (out.delegate.length > 0 && out.id !== COORDINATOR_ID) err('delegate', 'only the coordinator may delegate')
    if (out.delegate.includes(out.id)) err('delegate', 'an agent cannot delegate to itself')
    if (new Set(out.delegate).size !== out.delegate.length) err('delegate', 'duplicate agent')
    if (new Set(out.tools).size !== out.tools.length) err('tools', 'duplicate tool')
    if (out.createdBy === 'agent' && out.requestedBy === undefined) err('requestedBy', 'an agent-made definition records who asked for it')
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out }
}

// ---------------------------------------------------------------------------
// The file: frontmatter + body
// ---------------------------------------------------------------------------

class HeaderError extends Error {}
const fail = (line, message) => { throw new HeaderError(`header line ${line}: ${message}`) }

const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/

/** Strip a trailing ` # comment` that is outside quotes. */
function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      if (i === 0 || /\s/.test(s[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s.trimEnd()
}

/** One inline scalar or flow value. */
function scalar(raw, line) {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) fail(line, 'unclosed quote')
    try { return JSON.parse(s) } catch { fail(line, 'bad escape in a quoted string') }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail(line, 'unclosed quote')
    const inner = s.slice(1, -1)
    if (/'(?!')/.test(inner.replace(/''/g, ''))) fail(line, 'unescaped quote')
    return inner.replace(/''/g, "'")
  }
  if (s === '[]') return []
  if (s === '{}') return {}
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) fail(line, 'unclosed list')
    const inner = s.slice(1, -1)
    if (/[[\]{}"']/.test(inner)) fail(line, 'only simple flow lists like [a, b] are supported')
    if (inner.trim() === '') return []
    return inner.split(',').map((x) => {
      if (x.trim() === '') fail(line, 'empty item in a list')
      return scalar(x, line)
    })
  }
  if (/^[&*!|>{%@`]/.test(s)) fail(line, 'anchors, aliases, tags, block strings and flow maps are not supported')
  return s
}

/** Parse the header lines into a plain object. */
function parseHeader(lines, firstLine) {
  const rows = []
  lines.forEach((text, i) => {
    const n = firstLine + i
    if (/^\s*(?:#.*)?$/.test(text)) return
    if (/^ *\t/.test(text)) fail(n, 'indent with spaces, not tabs')
    const indent = text.length - text.trimStart().length
    rows.push({ n, indent, text: stripComment(text.trimStart()) })
  })

  let pos = 0
  const block = (indent) => {
    const first = rows[pos]
    if (!first || first.indent < indent) return null
    if (first.indent !== indent) fail(first.n, 'unexpected indentation')
    return first.text.startsWith('- ') || first.text === '-' ? list(indent) : map(indent)
  }
  const nested = (parentIndent) => {
    const next = rows[pos]
    if (!next || next.indent <= parentIndent) return null
    return block(next.indent)
  }
  function list(indent) {
    const out = []
    while (pos < rows.length && rows[pos].indent === indent) {
      const row = rows[pos]
      if (!(row.text.startsWith('- ') || row.text === '-')) break
      pos++
      const rest = row.text.slice(1).trim()
      if (rest === '') {
        out.push(nested(indent))
      } else {
        if (/^[A-Za-z][\w-]*:(?:\s|$)/.test(rest)) fail(row.n, 'maps inside lists are not supported')
        out.push(scalar(rest, row.n))
      }
    }
    if (pos < rows.length && rows[pos].indent > indent) fail(rows[pos].n, 'unexpected indentation')
    return out
  }
  function map(indent) {
    const out = {}
    while (pos < rows.length && rows[pos].indent === indent) {
      const row = rows[pos]
      const m = /^([^:\s]+):(?:\s+(.*))?$/.exec(row.text) ?? /^([^:\s]+):$/.exec(row.text)
      if (!m) fail(row.n, 'expected "key: value"')
      const key = m[1]
      if (!KEY.test(key)) fail(row.n, 'invalid key')
      if (Object.hasOwn(out, key)) fail(row.n, `duplicate key ${key}`)
      pos++
      const rest = (m[2] ?? '').trim()
      if (rest === '') {
        const next = rows[pos]
        // A list may sit at the key's own indentation, as YAML allows.
        out[key] = next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-') ? list(indent) : nested(indent)
      } else {
        out[key] = scalar(rest, row.n)
      }
    }
    if (pos < rows.length && rows[pos].indent > indent) fail(rows[pos].n, 'unexpected indentation')
    return out
  }

  if (rows.length === 0) return {}
  if (rows[0].indent !== 0) fail(rows[0].n, 'the header must start at the left margin')
  const result = map(0)
  if (pos < rows.length) fail(rows[pos].n, 'unexpected indentation')
  return result
}

/**
 * Turn a definition file into a checked definition. Accepts LF or CRLF line
 * endings. A Claude Code style `tools: Read, Grep` line is read as a list.
 */
export function parseAgentFile(text) {
  if (!isString(text)) return { ok: false, errors: ['(file): must be text'] }
  if (text.length > MAX_FILE_CHARS) return { ok: false, errors: [`(file): larger than ${MAX_FILE_CHARS} characters`] }
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0].trimEnd() !== '---') return { ok: false, errors: ['(file): must start with a --- header line'] }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---')
  if (end === -1) return { ok: false, errors: ['(file): the header has no closing --- line'] }

  let header
  try {
    header = parseHeader(lines.slice(1, end), 2)
  } catch (e) {
    if (e instanceof HeaderError) return { ok: false, errors: [e.message] }
    throw e
  }
  if ('body' in header) return { ok: false, errors: ['body: the instructions go after the header, not in it'] }
  if (isString(header.tools)) header.tools = header.tools.split(',').map((t) => t.trim()).filter(Boolean)
  return checkAgentDefinition({ ...header, body: lines.slice(end + 1).join('\n') })
}

/** A string as a header scalar: plain when it reads back unchanged, else JSON-quoted. */
function formatScalar(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  const plain = /^[A-Za-z_][A-Za-z0-9_./@:-]*$/.test(s) && !/^(?:true|false|null)$/.test(s) && !/:$/.test(s)
  return plain ? s : JSON.stringify(s)
}

/**
 * Write a definition back as a file. Fields go in TEMPLATE order; defaults are
 * written out so the file says plainly what the agent may do.
 * `parseAgentFile(formatAgentFile(d))` gives `d` back.
 */
export function formatAgentFile(def) {
  const checked = checkAgentDefinition(def)
  if (!checked.ok) throw new Error(`invalid agent definition: ${checked.errors.slice(0, 3).join('; ')}`)
  const d = checked.value
  const out = ['---']
  for (const key of FIELD_ORDER) {
    const v = d[key]
    if (v === undefined) continue
    if (Array.isArray(v)) {
      if (v.length === 0) out.push(`${key}: []`)
      else out.push(`${key}:`, ...v.map((x) => `  - ${formatScalar(x)}`))
    } else if (isRecord(v)) {
      const entries = Object.entries(v)
      if (entries.length === 0) out.push(`${key}: {}`)
      else out.push(`${key}:`, ...entries.map(([k, x]) => `  ${k}: ${formatScalar(x)}`))
    } else out.push(`${key}: ${formatScalar(v)}`)
  }
  out.push('---', '', d.body, '')
  return out.join('\n')
}
