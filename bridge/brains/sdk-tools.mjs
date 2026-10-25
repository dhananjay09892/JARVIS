/**
 * The bridge's own tools for a tool-loop brain (plan 25; task Q54).
 *
 * JARVIS's tools (the HUD, the interface, Chrome, apps, workspace,
 * development, the camera, tasks, memory, workflows, connectors) are built as
 * in-process MCP servers for the Claude Agent SDK (`createSdkMcpServer` and
 * `tool()`). A tool-loop brain such as the OpenAI-compatible one has no MCP
 * client: JARVIS runs its loop and the tool bridge (tool-bridge.mjs) needs
 * plain handlers and a JSON Schema for each tool.
 *
 * So the bridge's servers are made through `recordingServerFactory`, which
 * keeps each server's tool definitions (name, description, input schema,
 * handler: the shape `tool()` returns) on the server object, not enumerable,
 * so the SDK never sees them. `toolsFromServers` turns those into
 *
 *   handlers  'mcp__<server>__<tool>' → (args) => output
 *   specs     'mcp__<server>__<tool>' → { description, parameters }
 *
 * The names are the ones the Claude brain sees, so the policy engine, the
 * taint rules, the untrusted-content labels and the HUD treat a tool the same
 * whichever brain called it. Servers this module cannot read (other people's
 * MCP servers, run as separate processes) are left out: a tool that is not
 * offered can never run.
 *
 * This module does not import the SDK or zod. Schemas go through a small
 * adapter (`schema.toJson`, `schema.parse`) that server.mjs builds from zod,
 * so the tests run without dependencies.
 */

/** Where a server made by `recordingServerFactory` keeps its tool definitions. */
export const TOOL_DEFS = Symbol.for('jarvis.sdkToolDefs')

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Server keys and tool names that make a valid `mcp__<key>__<tool>` name. */
const PART = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Wrap `createSdkMcpServer` so every server it makes remembers its tools.
 * The server object is otherwise exactly what the SDK returned.
 */
export function recordingServerFactory(create) {
  if (typeof create !== 'function') throw new Error('recordingServerFactory needs createSdkMcpServer.')
  return (options = {}) => {
    const server = create(options)
    const defs = Array.isArray(options.tools) ? Object.freeze([...options.tools]) : Object.freeze([])
    if (server && typeof server === 'object' && Object.isExtensible(server)) {
      Object.defineProperty(server, TOOL_DEFS, { value: defs, enumerable: false })
    }
    return server
  }
}

/** The text of an MCP tool result's content blocks, joined. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

/** A JSON Schema for the tool's input, or a permissive one if it cannot be made. */
function parametersOf(def, schema, log, name) {
  try {
    const json = schema?.toJson?.(def.inputSchema ?? {})
    if (isRecord(json) && json.type === 'object') {
      const { $schema: _s, ...rest } = json
      return rest
    }
  } catch (err) {
    log?.warn?.(`[jarvis] ${name}: input schema not convertible (${err?.message ?? err}); offered with a permissive one`)
  }
  return { type: 'object', properties: {} }
}

/**
 * The handlers and specs for every tool of the bridge's own servers.
 *
 * @param {Record<string, object>} mcpServers  the session's servers, by key
 * @param {object} [o]
 * @param {{ toJson?: Function, parse?: Function }} [o.schema]  zod shape → JSON Schema, and validation
 * @param {object} [o.log]
 * @returns {{ handlers: Record<string, Function>, specs: Record<string, object>, skipped: string[] }}
 */
export function toolsFromServers(mcpServers = {}, { schema = null, log = console } = {}) {
  const handlers = {}
  const specs = {}
  const skipped = []
  for (const [key, server] of Object.entries(isRecord(mcpServers) ? mcpServers : {})) {
    const defs = server?.[TOOL_DEFS]
    if (!Array.isArray(defs) || !PART.test(key)) {
      skipped.push(key)
      continue
    }
    for (const def of defs) {
      if (!isRecord(def) || typeof def.name !== 'string' || !PART.test(def.name) || typeof def.handler !== 'function') continue
      const name = `mcp__${key}__${def.name}`
      if (name.length > 64 || Object.hasOwn(handlers, name)) continue
      specs[name] = {
        ...(typeof def.description === 'string' && { description: def.description }),
        parameters: parametersOf(def, schema, log, name),
      }
      handlers[name] = async (args) => {
        // The MCP server checks arguments against the schema before a handler
        // runs; calling the handler directly, this does the same.
        let input = isRecord(args) ? args : {}
        if (typeof schema?.parse === 'function') {
          try {
            input = schema.parse(def.inputSchema ?? {}, input)
          } catch (err) {
            throw new Error(`Invalid arguments for ${def.name}: ${String(err?.message ?? err).slice(0, 300)}`)
          }
        }
        const out = await def.handler(input, {})
        // A CallToolResult: its content blocks, or a thrown error so the tool
        // bridge reports a failed call.
        if (isRecord(out) && Array.isArray(out.content)) {
          if (out.isError === true) throw new Error(textOf(out.content) || `${def.name} failed.`)
          return out.content
        }
        return out
      }
    }
  }
  return { handlers, specs, skipped }
}

/**
 * The schema adapter for `toolsFromServers`, from zod (v4). A tool's input
 * schema is a zod raw shape (what `tool()` takes) or a zod object.
 */
export function zodSchemaAdapter(z) {
  const asObject = (shape) => (typeof shape?.safeParse === 'function' ? shape : z.object(shape ?? {}))
  return Object.freeze({
    toJson: (shape) => z.toJSONSchema(asObject(shape), { io: 'input', unrepresentable: 'any' }),
    parse: (shape, args) => asObject(shape).parse(args),
  })
}
