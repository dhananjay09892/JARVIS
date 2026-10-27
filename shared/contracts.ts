/**
 * Shared data contracts (plan 38): the shapes every part of JARVIS agrees on
 * when it hands something to another part — wake → speaker → STT → router →
 * brain → policy → tools → TTS, plus alerts, channels, missions and audit.
 *
 * One declaration per object: a zod schema for runtime validation, and the
 * TypeScript type inferred from it, so the two can never drift apart.
 *
 * Rules (plan 38 "Principles"):
 * - Every top-level object is versioned (`v: 1`). Changes are additive only:
 *   a new field is optional, an existing field never changes meaning or type.
 *   A breaking change means a new `v` and a new schema beside the old one.
 * - Unknown fields are ignored: parsing strips them instead of failing, so an
 *   older reader accepts a newer writer's object.
 * - Every top-level object carries `id` and `ts` (UTC milliseconds), plus
 *   `traceId` and `deviceId` where the object belongs to a turn or a device.
 * - Fields that can hold private content carry `sensitivity` so policy and
 *   logging can redact them.
 * - Validate strictly on inbound boundaries (channels, satellites, MCP
 *   results, skills) with `parseContract` / `checkContract`.
 *
 * Status: phase 2. Nothing in the bridge or the page uses these yet; adoption
 * is phase 3, one boundary at a time behind adapters.
 */
import { z } from 'zod'

export const CONTRACT_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Opaque identifier: 1–128 characters, no whitespace or control characters. */
export const Id = z.string().regex(/^[^\s\u0000-\u001f]{1,128}$/, 'invalid id')
/** UTC milliseconds since the epoch. */
export const Ts = z.number().int().nonnegative()
/** One trace per turn (plan 16): 16 lowercase hex characters. */
export const TraceId = z.string().regex(/^[0-9a-f]{16}$/, 'traceId must be 16 hex characters')
export const Score = z.number().min(0).max(1)
const Version = z.literal(CONTRACT_VERSION)
const Count = z.number().int().nonnegative()

export const Sensitivity = z.enum(['public', 'private', 'vault'])
export type Sensitivity = z.infer<typeof Sensitivity>

/** Fields every top-level object carries. */
const envelope = { v: Version, id: Id, ts: Ts }

// ---------------------------------------------------------------------------
// Identity and input
// ---------------------------------------------------------------------------

export const Role = z.enum(['owner', 'member', 'child', 'guest'])
export const IdentitySource = z.enum(['voice', 'face', 'device', 'declared', 'carry-over', 'channel'])

/** Who is speaking or asking, and how sure we are (plans 01, 30). */
export const Identity = z.object({
  personId: z.union([Id, z.literal('guest')]),
  role: Role,
  confidence: Score,
  sources: z.array(IdentitySource),
})
export type Identity = z.infer<typeof Identity>

/** Output of the audio gateway, the text box or a channel (plans 02, 05, 16, 28). */
export const Utterance = z.object({
  ...envelope,
  traceId: TraceId,
  deviceId: Id,
  room: z.string().optional(),
  modality: z.enum(['voice', 'text', 'image']),
  text: z.string(),
  /** BCP 47 tag, e.g. 'en-IN', 'gu', 'hi'. */
  language: z.string().min(2).max(35),
  langConfidence: Score,
  audioMs: Count.optional(),
  identity: Identity,
  /** Null when the turn did not start from a wake word (button, text, channel). */
  wake: z.object({ engine: z.string(), score: Score }).nullable(),
  /** Absolute UTC ms; missing stages were not measured (e.g. typed text). */
  timings: z.object({ speechEnd: Ts.optional(), sttDone: Ts.optional() }),
  sensitivity: Sensitivity.default('private'),
})
export type Utterance = z.infer<typeof Utterance>

// ---------------------------------------------------------------------------
// Turn context (plans 06, 07, 14)
// ---------------------------------------------------------------------------

/** One named piece of context with a lifetime (plan 14's context broker). */
export const ContextSlice = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  fetchedAt: Ts,
  ttlMs: Count,
  sensitivity: Sensitivity,
  /** Already redacted to what this actor may see. */
  text: z.string(),
  tokens: Count.optional(),
  /** True when the text came from outside (web, email, file): data, never instructions. */
  untrusted: z.boolean(),
})
export type ContextSlice = z.infer<typeof ContextSlice>

export const Risk = z.enum(['R0', 'R1', 'R2', 'R3', 'R4'])
export type Risk = z.infer<typeof Risk>

/** A tool as offered to a brain, after policy filtering for this actor. */
export const ToolManifest = z.object({
  name: z.string().min(1),
  server: z.string().optional(),
  description: z.string(),
  readOnly: z.boolean(),
  risk: Risk.optional(),
})
export type ToolManifest = z.infer<typeof ToolManifest>

export const MemoryHit = z.object({ id: Id, text: z.string(), source: z.string(), score: Score })

export const Persona = z.object({
  id: Id,
  mode: z.enum(['normal', 'focus', 'night', 'guest']),
})

export const Budget = z.object({
  maxTokens: Count,
  maxSteps: Count,
  maxSpendUsd: z.number().nonnegative(),
})

/** Everything a brain gets for one turn. */
export const TurnContext = z.object({
  ...envelope,
  traceId: TraceId,
  utterance: Utterance,
  persona: Persona,
  slices: z.array(ContextSlice),
  memories: z.array(MemoryHit),
  tools: z.array(ToolManifest),
  budget: Budget,
})
export type TurnContext = z.infer<typeof TurnContext>

// ---------------------------------------------------------------------------
// Brain events (plan 21): normalised across every brain
// ---------------------------------------------------------------------------

// `ready` and `tool_start` are optional (a brain may never send them); `detail`
// is a tool's bounded output for the bridge's local journal, never the HUD or traces.
export const BrainEvent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), servers: z.array(z.string().min(1)) }),
  z.object({ t: z.literal('text'), delta: z.string() }),
  z.object({ t: z.literal('tool_start'), id: Id, name: z.string().min(1) }),
  z.object({ t: z.literal('tool_call'), id: Id, name: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal('tool_result'), id: Id, ok: z.boolean(), summary: z.string(), tainted: z.boolean(), detail: z.string().max(2000).optional() }),
  z.object({ t: z.literal('usage'), inTokens: Count, outTokens: Count, costUsd: z.number().nonnegative().optional() }),
  z.object({ t: z.literal('error'), code: z.string().min(1), retryable: z.boolean(), message: z.string().optional() }),
  z.object({ t: z.literal('done'), reason: z.enum(['complete', 'cancelled', 'limit', 'error']) }),
])
export type BrainEvent = z.infer<typeof BrainEvent>

// ---------------------------------------------------------------------------
// Policy (plan 15) and approvals
// ---------------------------------------------------------------------------

export const ActionKind = z.enum(['tool', 'device', 'message', 'file', 'spend', 'egress'])

export const PolicyRequest = z.object({
  ...envelope,
  traceId: TraceId.optional(),
  action: z.object({
    kind: ActionKind,
    name: z.string().min(1),
    target: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  actor: Identity,
  room: z.string().optional(),
  /** Everyone detected nearby, so a private answer is not spoken to a guest. */
  presence: z.array(Identity),
  taint: z.object({ privateRead: z.boolean(), untrustedContent: z.boolean() }),
  risk: Risk.optional(),
  /** Which channel the request came from; approvals go back the same way. */
  via: z.enum(['voice', 'hud', 'chat', 'worker', 'schedule']).optional(),
})
export type PolicyRequest = z.infer<typeof PolicyRequest>

export const ApprovalChannel = z.enum(['hud', 'voice', 'chat', 'phone'])

export const PolicyDecision = z.object({
  ...envelope,
  requestId: Id,
  verdict: z.enum(['allow', 'ask', 'deny']),
  /** Human-readable and speakable. */
  reason: z.string().min(1),
  /** Machine-readable rule name, as bridge/policy.mjs returns today. */
  rule: z.string().optional(),
  approval: z
    .object({ id: Id, expiresAt: Ts, channel: ApprovalChannel, needsPin: z.boolean() })
    .optional(),
  /** Standing grant that allowed this without asking (plan 15). */
  grantId: Id.optional(),
}).refine((d) => d.verdict !== 'ask' || d.approval !== undefined, {
  message: "an 'ask' verdict needs an approval",
  path: ['approval'],
})
export type PolicyDecision = z.infer<typeof PolicyDecision>

/** How an approval was answered (event `approval.resolved`). */
export const ApprovalResolution = z.object({
  ...envelope,
  approvalId: Id,
  outcome: z.enum(['approved', 'denied', 'expired', 'cancelled']),
  /** Absent when it expired or was cancelled by the system. */
  by: Identity.optional(),
  channel: ApprovalChannel,
  pinVerified: z.boolean().optional(),
})
export type ApprovalResolution = z.infer<typeof ApprovalResolution>

// ---------------------------------------------------------------------------
// Proactive layer (plan 12)
// ---------------------------------------------------------------------------

export const Urgency = z.enum(['info', 'normal', 'important', 'urgent'])

export const Notification = z.object({
  ...envelope,
  traceId: TraceId.optional(),
  /** What raised it: 'briefing', 'calendar', 'mission', 'health' … */
  source: z.string().min(1),
  urgency: Urgency,
  /** personIds, or 'household'. */
  audience: z.array(z.string().min(1)).min(1),
  privacy: z.enum(['public', 'private']),
  title: z.string().min(1),
  body: z.string(),
  actions: z.array(z.object({ id: Id, label: z.string().min(1) })).optional(),
  expiresAt: Ts.optional(),
})
export type Notification = z.infer<typeof Notification>

// ---------------------------------------------------------------------------
// Memory (plan 07)
// ---------------------------------------------------------------------------

export const MemoryItem = z.object({
  ...envelope,
  kind: z.enum(['fact', 'person', 'preference', 'routine', 'episode']),
  text: z.string().min(1),
  owner: z.union([Id, z.literal('household')]),
  sensitivity: Sensitivity,
  provenance: z.object({ turnId: Id, ts: Ts, confidence: Score }),
  embeddingId: Id.optional(),
})
export type MemoryItem = z.infer<typeof MemoryItem>

// ---------------------------------------------------------------------------
// Missions (plan 13)
// ---------------------------------------------------------------------------

export const MissionStep = z.object({
  id: Id,
  summary: z.string().min(1),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
})

export const Mission = z.object({
  ...envelope,
  goal: z.string().min(1),
  plan: z.array(MissionStep),
  status: z.enum(['planned', 'running', 'paused', 'done', 'failed', 'cancelled']),
  budget: Budget,
  permissions: z.array(z.string()),
  log: z.array(z.object({ ts: Ts, kind: z.string().min(1), summary: z.string() })),
  artifacts: z.array(z.string()),
})
export type Mission = z.infer<typeof Mission>

// ---------------------------------------------------------------------------
// Channels (plan 20): always inbound, always strict
// ---------------------------------------------------------------------------

export const ChannelMessage = z.object({
  ...envelope,
  channel: z.enum(['telegram', 'sms', 'whatsapp', 'signal', 'email']),
  /** The channel's own sender id; checked against the allow-list before anything else. */
  senderId: z.string().min(1).max(256),
  /** Filled in only after the allow-list matched the sender. */
  person: Identity.optional(),
  text: z.string().max(16_000).optional(),
  audioRef: z.string().optional(),
  imageRef: z.string().optional(),
  threadId: z.string().min(1),
  /** Set when this message answers something JARVIS sent (e.g. an approval). */
  inReplyTo: Id.optional(),
}).refine((m) => m.text !== undefined || m.audioRef !== undefined || m.imageRef !== undefined, {
  message: 'a channel message needs text, audio or an image',
})
export type ChannelMessage = z.infer<typeof ChannelMessage>

// ---------------------------------------------------------------------------
// Skills, devices, audit
// ---------------------------------------------------------------------------

export const SkillManifest = z.object({
  v: Version,
  id: Id,
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.-]+)?$/, 'semver'),
  permissions: z.array(z.string()),
  triggers: z.array(z.string().min(1)).min(1),
  risk: Risk,
  inputs: z.record(z.string(), z.unknown()),
  tests: z.array(z.string()).min(1),
})
export type SkillManifest = z.infer<typeof SkillManifest>

export const DeviceEvent = z.object({
  ...envelope,
  deviceId: Id,
  room: z.string(),
  kind: z.enum(['wake', 'level', 'state', 'sensor']),
  payload: z.record(z.string(), z.unknown()),
})
export type DeviceEvent = z.infer<typeof DeviceEvent>

/** Hex SHA-256. */
const Hash = z.string().regex(/^[0-9a-f]{64}$/, 'sha-256 hex')

export const AuditRecord = z.object({
  ...envelope,
  actor: Identity,
  request: PolicyRequest,
  decision: PolicyDecision,
  result: z.object({ ok: z.boolean(), summary: z.string().optional() }).optional(),
  prevHash: Hash,
})
export type AuditRecord = z.infer<typeof AuditRecord>

// ---------------------------------------------------------------------------
// Event bus (plan 12)
// ---------------------------------------------------------------------------

export const TOPICS = [
  'utterance.received',
  'turn.started', 'turn.finished',
  'tool.requested', 'tool.allowed', 'tool.denied',
  'approval.requested', 'approval.resolved',
  'notification.created', 'notification.delivered', 'notification.suppressed',
  'device.event',
  'presence.changed',
  'mission.progress', 'mission.finished',
  'health.check',
  'budget.warning', 'budget.exceeded',
  'freeze.on', 'freeze.off',
  // Added with the bus itself (plan 12 block 1, Q32): the scheduler and
  // background-task completion, the first two publishers.
  'workflow.started', 'workflow.finished',
  'task.finished',
] as const
export const Topic = z.enum(TOPICS)
export type Topic = z.infer<typeof Topic>

/**
 * A workflow run (bridge/workflows.mjs), started by the scheduler or by hand.
 * Counts and names only: never a step's command, path or output.
 */
export const WorkflowRun = z.object({
  runId: Id,
  workflowId: Id,
  name: z.string().min(1).max(60),
  trigger: z.enum(['manual', 'schedule']),
  status: z.enum(['running', 'completed', 'failed']),
  stepsTotal: Count,
  stepsCompleted: Count,
  startedAt: Ts,
  finishedAt: Ts.optional(),
}).refine((r) => r.stepsCompleted <= r.stepsTotal, { message: 'more steps completed than exist', path: ['stepsCompleted'] })
  .refine((r) => (r.status === 'running') === (r.finishedAt === undefined), {
    message: 'finishedAt is set exactly when the run has ended', path: ['finishedAt'],
  })
export type WorkflowRun = z.infer<typeof WorkflowRun>

/**
 * A background task (bridge/tasks.mjs) that has ended. `summary` is the
 * result or the error, clipped; it can hold what the task read, so it is
 * `private` unless the publisher says otherwise.
 */
export const TaskOutcome = z.object({
  taskId: Id,
  title: z.string().min(1).max(60),
  status: z.enum(['done', 'failed', 'cancelled', 'interrupted']),
  summary: z.string().max(300),
  costUsd: z.number().nonnegative().optional(),
  startedAt: Ts.optional(),
  endedAt: Ts,
  sensitivity: Sensitivity.default('private'),
})
export type TaskOutcome = z.infer<typeof TaskOutcome>

/**
 * Payload schema per topic, where one is fixed. Topics not listed here carry
 * a free-form object until the plan that owns them defines it.
 */
const TOPIC_PAYLOADS: Partial<Record<Topic, z.ZodType>> = {
  'utterance.received': Utterance,
  'tool.requested': PolicyRequest,
  'tool.allowed': PolicyDecision,
  'tool.denied': PolicyDecision,
  'approval.requested': PolicyDecision,
  'approval.resolved': ApprovalResolution,
  'notification.created': Notification,
  'notification.delivered': Notification,
  'notification.suppressed': Notification,
  'device.event': DeviceEvent,
  'mission.progress': Mission,
  'mission.finished': Mission,
  'workflow.started': WorkflowRun,
  'workflow.finished': WorkflowRun,
  'task.finished': TaskOutcome,
}

export const BusEvent = z.object({
  ...envelope,
  topic: Topic,
  traceId: TraceId.optional(),
  payload: z.unknown(),
}).superRefine((e, ctx) => {
  const schema = TOPIC_PAYLOADS[e.topic]
  const result = (schema ?? z.record(z.string(), z.unknown())).safeParse(e.payload)
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: ['payload', ...issue.path] })
    }
  }
})
export type BusEvent = z.infer<typeof BusEvent>

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Every contract by name, for boundaries that validate by name and for tests. */
export const CONTRACTS = {
  Identity, Utterance, ContextSlice, ToolManifest, TurnContext, BrainEvent,
  PolicyRequest, PolicyDecision, ApprovalResolution, Notification, MemoryItem,
  Mission, ChannelMessage, SkillManifest, DeviceEvent, AuditRecord, BusEvent,
  WorkflowRun, TaskOutcome,
} as const
export type ContractName = keyof typeof CONTRACTS
export type Contract<N extends ContractName> = z.infer<(typeof CONTRACTS)[N]>

export type CheckResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }

/**
 * Validate without throwing. On success `value` is the parsed object with
 * unknown fields stripped and defaults filled in. Errors are short
 * `path: message` strings that never echo the rejected value, so they are
 * safe to log.
 */
export function checkContract<N extends ContractName>(name: N, value: unknown): CheckResult<Contract<N>> {
  const result = CONTRACTS[name].safeParse(value)
  if (result.success) return { ok: true, value: result.data as Contract<N> }
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
  }
}

/** Validate and throw a `ContractError` on failure. For inbound boundaries. */
export function parseContract<N extends ContractName>(name: N, value: unknown): Contract<N> {
  const result = checkContract(name, value)
  if (!result.ok) throw new ContractError(name, result.errors)
  return result.value
}

export class ContractError extends Error {
  readonly contract: ContractName
  readonly errors: string[]
  constructor(contract: ContractName, errors: string[]) {
    super(`invalid ${contract}: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ' …' : ''}`)
    this.name = 'ContractError'
    this.contract = contract
    this.errors = errors
  }
}
