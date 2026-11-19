/**
 * Skill sandbox (plan 19, phase 2): runs a skill's script with only what its
 * manifest grants.
 *
 * A script is a file named by the manifest's `script` field: the body of an
 * async function `(input, call)`. It runs in a separate Node process
 * (skill-sandbox-child.mjs) with no files, no child processes, no workers,
 * no native add-ons, an empty environment and no network globals. The only
 * way out is `call(tool, input)`, and every call is checked here, in the
 * bridge, before anything runs:
 *
 *   1. the tool must be in the skill's grants (createSkillGate), and the
 *      policy engine still decides it (writes off, never-list, kill switch);
 *   2. file arguments must match `permissions.paths`, and URL arguments must
 *      be http(s) to a host in `permissions.domains`;
 *   3. the call count, the size of each result handed back and the size of the
 *      final answer are capped;
 *   4. the whole run has a deadline; at the deadline the process is killed.
 *
 * Nothing in the script can widen any of this: the limits live in the parent,
 * and the script only ever receives JSON strings. `invokeTool` is supplied by
 * the caller; with none, every call is refused.
 *
 * Network: Node 22's permission model has no network switch, so the sandbox
 * does not rely on one. The script has no network API in its context and
 * cannot import anything. Treat this as defence in depth, not as a hard
 * network boundary: a process-level or OS-level network block is a later step.
 */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createSkillGate, isSafePathGrant } from './skill-manifest.mjs'

const CHILD_FILE = fileURLToPath(new URL('./skill-sandbox-child.mjs', import.meta.url))

export const SANDBOX_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxCalls: 50,
  maxResultChars: 100_000,
  maxOutputChars: 20_000,
  maxScriptChars: 64_000,
})
export const SANDBOX_LIMITS = Object.freeze({ timeoutMs: 60_000, maxCalls: 500 })
/** Heap limit for the child, in MB. */
const CHILD_HEAP_MB = 64

/** Tool-input fields that name a file or folder, and fields that name a URL. */
export const PATH_FIELDS = Object.freeze(['file_path', 'path', 'notebook_path', 'directory', 'dir', 'cwd', 'filePath', 'filename'])
export const URL_FIELDS = Object.freeze(['url', 'uri', 'endpoint', 'href'])

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Turn a path grant such as `notes/**` into a regular expression. */
function grantToRegExp(grant) {
  let re = ''
  for (let i = 0; i < grant.length; i++) {
    const c = grant[i]
    if (c === '*') {
      if (grant[i + 1] === '*') {
        i++
        if (grant[i + 1] === '/') { i++; re += '(?:[^/]+/)*' } else re += '.*'
      } else re += '[^/]*'
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Does a relative path match any grant? A bare `**` or `dir/**` includes the folder's contents. */
export function pathAllowed(p, grants) {
  if (!isSafePathGrant(p)) return false
  return grants.some((g) => grantToRegExp(g).test(p))
}

/** Does a host match a domain grant (`example.com` or `*.example.com`)? */
export function hostAllowed(host, grants) {
  const h = String(host).toLowerCase()
  return grants.some((g) => (g.startsWith('*.') ? h.endsWith(g.slice(1)) && h.length > g.length - 1 : h === g))
}

/**
 * Check one tool call's arguments against the manifest's path and domain
 * lists. Returns null when fine, or a short reason.
 */
export function checkCallArguments(manifest, input) {
  if (!isRecord(input)) return 'the input must be an object'
  const { paths, domains } = manifest.permissions
  const walk = (value, depth) => {
    if (depth > 4) return 'the input is nested too deeply'
    for (const [k, v] of Object.entries(value)) {
      if (isRecord(v)) {
        if (PATH_FIELDS.includes(k) || URL_FIELDS.includes(k)) return `${k} must be text`
        const r = walk(v, depth + 1)
        if (r) return r
        continue
      }
      const list = Array.isArray(v) ? v : [v]
      if (PATH_FIELDS.includes(k)) {
        for (const x of list) if (typeof x !== 'string' || !pathAllowed(x, paths)) return `${k} is outside the folders this skill may use`
      } else if (URL_FIELDS.includes(k)) {
        for (const x of list) {
          let u
          try { u = new URL(String(x)) } catch { return `${k} is not a web address` }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${k} must be an http or https address`
          if (u.username || u.password) return `${k} must not carry a login`
          if (!hostAllowed(u.hostname, domains)) return `${k} is not a website this skill may reach`
        }
      }
    }
    return null
  }
  return walk(input, 0)
}

/** Read the script named by the manifest: a plain file inside the skill folder. */
export function readSkillScript(dir, manifest, maxChars = SANDBOX_DEFAULTS.maxScriptChars) {
  if (typeof manifest?.script !== 'string') return { ok: false, error: 'this skill has no script' }
  const file = join(dir, manifest.script)
  let st
  try { st = lstatSync(file) } catch { return { ok: false, error: 'the script file is missing' } }
  if (!st.isFile()) return { ok: false, error: 'the script must be a plain file' }
  try {
    const root = realpathSync(dir)
    if (!realpathSync(file).startsWith(root + sep)) return { ok: false, error: 'the script is outside the skill folder' }
  } catch { return { ok: false, error: 'the script could not be read' } }
  if (st.size > maxChars * 4) return { ok: false, error: 'the script is too large' }
  const source = readFileSync(file, 'utf8')
  if (source.length > maxChars) return { ok: false, error: 'the script is too large' }
  return { ok: true, source }
}

const REFUSED = (error, rule) => JSON.stringify({ ok: false, error, rule })

/**
 * Run `source` as the skill's script.
 *
 * @param {object} o
 * @param {object} o.manifest   a checked manifest (checkSkillManifest().value)
 * @param {string} o.source     the script text
 * @param {object} o.policy     a policy view (createPolicy() or forAgent())
 * @param {Function} [o.invokeTool] async (name, input) => value; none means every call is refused
 * @param {object} [o.input]    JSON value handed to the script
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxCalls]
 * @param {Function} [o.onEvent] called with { type, tool?, verdict?, rule? } for audit
 * @returns {Promise<{ok:true,value:any,calls:number}|{ok:false,error:string,reason:string,calls:number}>}
 */
export function runSkillScript(o) {
  const { manifest, source, policy, invokeTool, onEvent } = o
  const timeoutMs = Math.min(Math.max(Number(o.timeoutMs) || SANDBOX_DEFAULTS.timeoutMs, 50), SANDBOX_LIMITS.timeoutMs)
  const maxCalls = Math.min(Math.max(Number(o.maxCalls) || SANDBOX_DEFAULTS.maxCalls, 1), SANDBOX_LIMITS.maxCalls)
  const audit = (e) => { try { onEvent?.(e) } catch { /* auditing never breaks a run */ } }

  return new Promise((resolve) => {
    let settled = false
    let calls = 0
    let child
    const end = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
      resolve({ calls, ...r })
    }
    const fail = (reason, error) => end({ ok: false, reason, error })

    if (!isRecord(manifest) || typeof source !== 'string' || source.length > SANDBOX_DEFAULTS.maxScriptChars) {
      return resolve({ ok: false, reason: 'invalid', error: 'no valid skill or script was given', calls: 0 })
    }
    let inputJson
    try { inputJson = JSON.stringify(o.input === undefined ? null : o.input) } catch { inputJson = undefined }
    if (typeof inputJson !== 'string' || inputJson.length > 20_000) {
      return resolve({ ok: false, reason: 'invalid', error: 'the input must be JSON of at most 20000 characters', calls: 0 })
    }

    const gate = createSkillGate({ manifest, policy })
    const timer = setTimeout(() => fail('timeout', `the script ran longer than ${timeoutMs} ms and was stopped`), timeoutMs)

    try {
      child = fork(CHILD_FILE, [], {
        execArgv: ['--permission', `--allow-fs-read=${CHILD_FILE}`, `--max-old-space-size=${CHILD_HEAP_MB}`, '--disallow-code-generation-from-strings'],
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
      })
    } catch {
      return fail('start', 'the sandbox could not start')
    }
    child.on('error', () => fail('crash', 'the sandbox stopped unexpectedly'))
    child.on('exit', () => fail('crash', 'the script ended without an answer'))

    const reply = (id, json) => { try { if (child.connected) child.send({ t: 'result', id, json }) } catch { /* child is gone */ } }

    child.on('message', async (msg) => {
      if (settled || !isRecord(msg)) return
      if (msg.t === 'ready') { child.send({ t: 'run', source, inputJson }); return }
      if (msg.t === 'done') {
        if (typeof msg.json !== 'string' || msg.json.length > SANDBOX_DEFAULTS.maxOutputChars) {
          return fail('output-too-large', `the answer is larger than ${SANDBOX_DEFAULTS.maxOutputChars} characters`)
        }
        let value
        try { value = JSON.parse(msg.json) } catch { return fail('bad-output', 'the script returned something that is not JSON') }
        return end({ ok: true, value })
      }
      if (msg.t === 'fail') return fail('script-error', typeof msg.error === 'string' ? msg.error : 'the script failed')
      if (msg.t !== 'call') return

      const id = msg.id
      const tool = typeof msg.tool === 'string' ? msg.tool : ''
      calls++
      if (calls > maxCalls) {
        audit({ type: 'skill-call', tool, verdict: 'deny', rule: 'skill-call-limit' })
        return fail('call-limit', `the script made more than ${maxCalls} tool calls and was stopped`)
      }
      const decision = gate.decide({ kind: 'tool', name: tool })
      if (decision.verdict !== 'allow') {
        audit({ type: 'skill-call', tool, verdict: 'deny', rule: decision.rule })
        return reply(id, REFUSED(decision.reason ?? 'this tool is not allowed', decision.rule))
      }
      let args
      try { args = JSON.parse(msg.inputJson) } catch { return reply(id, REFUSED('the input is not JSON', 'skill-bad-input')) }
      const bad = checkCallArguments(manifest, args)
      if (bad) {
        audit({ type: 'skill-call', tool, verdict: 'deny', rule: 'skill-scope' })
        return reply(id, REFUSED(bad, 'skill-scope'))
      }
      if (typeof invokeTool !== 'function') return reply(id, REFUSED('tools are not available to this run', 'skill-no-host'))
      audit({ type: 'skill-call', tool, verdict: 'allow' })
      let json
      try {
        const value = await invokeTool(tool, args)
        json = JSON.stringify({ ok: true, value: value === undefined ? null : value })
        if (json.length > SANDBOX_DEFAULTS.maxResultChars) json = REFUSED('the tool result was too large to hand to the script', 'skill-result-size')
      } catch (e) {
        json = REFUSED(typeof e?.message === 'string' ? e.message.slice(0, 200) : 'the tool failed', 'skill-tool-error')
      }
      reply(id, json)
    })
  })
}

// ---------------------------------------------------------------------------
// Content scan
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  [/ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|messages)/i, 'tells the model to ignore its instructions'],
  [/disregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|safety|policy|rules|instructions)/i, 'tells the model to disregard its rules'],
  [/you\s+are\s+now\s+(?:in\s+)?(?:developer|admin|root|unrestricted|dan)\b/i, 'tries to change the model\'s role'],
  [/(?:reveal|print|show|send|leak)\s+(?:the\s+|your\s+)?(?:system\s+prompt|api\s*key|secret|password|token|credentials)/i, 'asks for secrets'],
  [/do\s+not\s+(?:tell|inform|show|mention)\s+(?:this\s+to\s+)?the\s+(?:user|owner)/i, 'asks to hide something from the owner'],
  [/(?:allow[_ ]writes|bypass|turn\s+off|disable)\s+(?:the\s+)?(?:policy|safety|approval|kill\s*switch|permission)/i, 'tries to switch off safety rules'],
  [/exfiltrat/i, 'mentions exfiltration'],
]
const SCRIPT_PATTERNS = [
  [/\b(?:eval|Function)\s*\(/, 'builds code from text'],
  [/\bimport\s*\(|\brequire\s*\(|^\s*import\s/m, 'tries to import a module'],
  [/\b(?:process|globalThis|global|window|self)\b/, 'reaches for the host environment'],
  [/\.constructor\b|__proto__|\bprototype\b/, 'reaches for object internals'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|child_process)\b/, 'names a network or process API'],
]

/**
 * Look for text that tries to steer the model or the sandbox, in every string
 * the owner or the model will read (name, description, data-use note,
 * phrases, labels, input descriptions) and, with `script`, in the script.
 * Findings are warnings for the review screen, never a gate: the grants and
 * the sandbox hold whatever this finds, and a match is a reason to look
 * closer, not proof. Returns `[{ where, problem }]`.
 */
export function scanSkillContent(manifest, script) {
  const findings = []
  const texts = [
    ['name', manifest?.name], ['description', manifest?.description], ['dataUse', manifest?.dataUse],
    ...(manifest?.triggers?.phrases ?? []).map((p, i) => [`triggers.phrases.${i}`, p]),
    ...(manifest?.steps ?? []).map((s, i) => [`steps.${i}.label`, s.label]),
    ...Object.entries(manifest?.inputs ?? {}).map(([k, v]) => [`inputs.${k}`, v?.description]),
  ]
  for (const [where, text] of texts) {
    if (typeof text !== 'string') continue
    for (const [re, problem] of INJECTION_PATTERNS) if (re.test(text)) findings.push({ where, problem })
  }
  if (typeof script === 'string') {
    for (const [re, problem] of [...INJECTION_PATTERNS, ...SCRIPT_PATTERNS]) if (re.test(script)) findings.push({ where: 'script', problem })
  }
  return findings
}
