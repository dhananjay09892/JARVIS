/**
 * The child half of the skill sandbox (see skill-sandbox.mjs). Runs in its own
 * process, started with Node's permission model (no file access beyond this
 * file, no processes, no workers, no native add-ons) and an empty environment.
 *
 * The skill's script is compiled in a bare vm context: no `process`, `require`,
 * `import`, `fetch`, timers or `eval`/`Function` (code generation from strings
 * is switched off). The only thing it can reach is `call(tool, input)`, which
 * sends one JSON string to the parent and gets one JSON string back. Only
 * strings cross the boundary, so nothing from this realm (whose `Function`
 * constructor is not restricted) is ever handed to the script.
 *
 * Every decision (grants, path and domain lists, call limits) is the parent's.
 * Nothing here is trusted: if the script breaks out of the context it is still
 * inside a process with no files, no children and no secrets, and the parent
 * kills it at the deadline.
 */
import vm from 'node:vm'

const send = process.send?.bind(process)
if (!send) process.exit(2)

let started = false
const pending = new Map()
let nextId = 1

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.t === 'result') {
    const done = pending.get(msg.id)
    if (done) { pending.delete(msg.id); done(typeof msg.json === 'string' ? msg.json : '{"ok":false,"error":"bad reply"}') }
    return
  }
  if (msg.t === 'run' && !started) { started = true; run(msg).catch((e) => finish(false, typeof e?.message === 'string' ? e.message : 'script error')) }
})

function finish(ok, payload) {
  send(ok ? { t: 'done', json: payload } : { t: 'fail', error: String(payload).slice(0, 300) }, () => process.exit(0))
}

// The one function that crosses the boundary: a string in, a promise of a
// string out, and it never rejects or throws.
function raw(tool, inputJson) {
  return new Promise((resolve) => {
    try {
      const id = nextId++
      pending.set(id, resolve)
      send({ t: 'call', id, tool: String(tool), inputJson: String(inputJson) })
    } catch {
      resolve('{"ok":false,"error":"call failed"}')
    }
  })
}

async function run({ source, inputJson }) {
  const context = vm.createContext(Object.create(null), {
    name: 'skill',
    codeGeneration: { strings: false, wasm: false },
  })
  context.__raw = raw
  // Built inside the context, so every object the script can see is made by
  // the context's own constructors. `__raw` is captured by the closure and
  // then removed from the global object.
  const boot = new vm.Script(`(() => {
    const raw = __raw
    delete globalThis.__raw
    delete globalThis.console
    delete globalThis.WebAssembly
    const call = async (tool, input) => {
      let reply
      try { reply = JSON.parse(await raw(String(tool), JSON.stringify(input === undefined ? {} : input))) }
      catch { throw new Error('tool call failed') }
      if (!reply || reply.ok !== true) throw new Error(String(reply && reply.error || 'tool call failed'))
      return reply.value
    }
    Object.freeze(call)
    return async (inputJson, body) => {
      const fn = body
      return JSON.stringify(await fn(JSON.parse(inputJson), call))
    }
  })()`, { filename: 'skill-boot' })
  const runner = boot.runInContext(context)
  // The skill's text is the body of an async function (input, call).
  const wrapped = new vm.Script(`(async (input, call) => {\n${source}\n})`, { filename: 'skill-script' })
  const fn = wrapped.runInContext(context)
  const json = await runner(inputJson, fn)
  finish(true, typeof json === 'string' ? json : 'null')
}

send({ t: 'ready' })
