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

export const ChannelId = z.enum(['telegram', 'sms', 'whatsapp', 'signal', 'email'])

/**
 * Who may talk to JARVIS over a channel (plan 20 spec §4.1; Q36 built it in
 * bridge/channels/allowlist.mjs, Q79 added it here). Keyed on the provider's
 * stable sender id, never a display name. Times are epoch milliseconds, like
 * every other `Ts` here. Local personal data: it never leaves the computer.
 */
export const ChannelBinding = z.object({
  ...envelope,
  channel: ChannelId,
  senderId: z.string().min(1).max(64),
  senderLabel: z.string().max(80).optional(),
  personId: z.union([Id, z.literal('guest')]),
  role: Role,
  assurance: z.enum(['high', 'low']),
  boundVia: z.enum(['pairing', 'manual']),
  limits: z.object({ perMinute: z.number().int().positive(), perDay: z.number().int().positive() }),
  allow: z.object({ chat: z.boolean(), voiceNotes: z.boolean(), approvals: z.boolean(), proactive: z.boolean() }),
  status: z.enum(['active', 'revoked']),
  expiresAt: Ts.optional(),
  lastSeenAt: Ts.optional(),
}).refine((b) => !(b.assurance === 'low' && b.allow.approvals), {
  message: 'a low-assurance channel never answers approvals', path: ['allow', 'approvals'],
}).refine((b) => !((b.role === 'child' || b.role === 'guest') && (b.allow.approvals || b.allow.proactive)), {
  message: 'children and guests may only chat', path: ['allow'],
})
export type ChannelBinding = z.infer<typeof ChannelBinding>

/**
 * One message a channel received, rejected or sent (bus topics
 * `channel.received` / `channel.rejected` / `channel.sent`). Ids, the rule
 * that decided it and a length; never the text. A sender with no binding
 * appears only as a salted hash.
 */
export const ChannelEvent = z.object({
  channel: ChannelId,
  rule: z.string().regex(/^[a-z0-9-]{1,40}$/),
  length: Count,
  bindingId: Id.optional(),
  senderHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
}).refine((e) => (e.bindingId === undefined) !== (e.senderHash === undefined), {
  message: 'exactly one of bindingId and senderHash', path: ['bindingId'],
})
export type ChannelEvent = z.infer<typeof ChannelEvent>

/** The kill switch set (`freeze.on`) or cleared (`freeze.off`). Unfreeze is HUD-only. */
export const FreezeChange = z.object({ source: z.enum(['chat', 'hud']), at: Ts })
export type FreezeChange = z.infer<typeof FreezeChange>

/**
 * A meeting that ended and has something recorded to write up
 * (bridge/meeting-notes.mjs): which synced note, from which source, its
 * title and when it ended (or when its note appeared). The title is
 * outside text; a listener treats the whole payload as untrusted.
 */
export const MeetingEnded = z.object({
  meetingId: Id,
  source: z.enum(['granola']),
  title: z.string().min(1).max(200),
  endedAt: Ts,
})
export type MeetingEnded = z.infer<typeof MeetingEnded>

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
  // Plan 20 (Q79): what the messaging channels did, ids and lengths only.
  'channel.received', 'channel.rejected', 'channel.sent',
  // Agents A2 (A08): a topic triggered agents can wait on. Published by the
  // meeting source (bridge/meeting-notes.mjs) when a new meeting note syncs.
  'meeting.ended',
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
  'channel.received': ChannelEvent,
  'channel.rejected': ChannelEvent,
  'channel.sent': ChannelEvent,
  'freeze.on': FreezeChange,
  'freeze.off': FreezeChange,
  'meeting.ended': MeetingEnded,
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
// Agents: one definition per named specialist
// ---------------------------------------------------------------------------

/**
 * Lowercase, starts with a letter, letters/digits/dashes, at most 40
 * characters. Used by voice ("ask the researcher"), so it stays speakable.
 */
export const AgentId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'agent id must be lowercase letters, digits and dashes, starting with a letter')
/** The only agent that may start other agents. */
export const COORDINATOR_ID = 'coordinator'
export const AGENT_MODES = ['on-demand', 'scheduled', 'triggered', 'continuous'] as const
export const AgentMode = z.enum(AGENT_MODES)
/** Modes that run without the owner asking each time; these need a budget. */
export const UNATTENDED_MODES: readonly AgentMode[] = ['scheduled', 'triggered', 'continuous']
export type AgentMode = z.infer<typeof AgentMode>

const ToolName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/, 'invalid tool name')
const ConnectorName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'invalid connector name')

/** Per-run limits. Every bound is checked by the runtime, not just recorded. */
export const AgentBudget = z.object({
  maxToolCalls: z.number().int().positive().max(1000),
  maxMinutes: z.number().positive().max(24 * 60),
  /** Ignored on a subscription, enforced on an API key. */
  maxCostUsd: z.number().nonnegative().max(100),
})
export type AgentBudget = z.infer<typeof AgentBudget>

/**
 * One agent: a Markdown file whose frontmatter is these fields and whose body
 * is the agent's instructions (bridge/agent-definition.mjs reads and writes
 * the file). Built-in agents ship with the app; user agents live in the
 * user's JARVIS folder.
 *
 * A definition only ever narrows what an agent can do: `tools` is an
 * allow-list (empty = no tools), connectors are read unless `write` is listed,
 * and every call still goes through the policy engine. Memory is never written
 * directly (`propose` at most), and only the Coordinator may delegate.
 */
export const AgentDefinition = z.object({
  v: Version.default(CONTRACT_VERSION),
  id: AgentId,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  icon: z.string().regex(/^[a-z0-9-]{1,40}$/, 'invalid icon name').optional(),
  mode: AgentMode.default('on-demand'),
  /** 5-field cron string; set exactly when `mode` is `scheduled`. */
  schedule: z.string().regex(/^\S+(?:[ \t]+\S+){4}$/, 'schedule must be a 5-field cron string').nullable().default(null),
  /** Bus topic; set exactly when `mode` is `triggered`. */
  trigger: z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/, 'trigger must be a bus topic such as meeting.ended').nullable().default(null),
  /** A registered brain, or `external:<name>` for an outside agent. */
  brain: z.string().regex(/^(?:external:)?[a-z][a-z0-9-]{0,39}$/, 'invalid brain name').default('claude'),
  /** A model id, or `default` to follow Settings. */
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, 'invalid model id').default('default'),
  tools: z.array(ToolName).max(100).default([]),
  connectors: z.record(ConnectorName, z.enum(['read', 'write'])).default({}),
  memory: z.enum(['none', 'read', 'propose'], {
    error: (issue) => (issue.input === 'write'
      ? 'agents never write memory directly; use propose'
      : 'memory must be none, read or propose'),
  }).default('none'),
  budget: AgentBudget.optional(),
  /** Run the Reviewer on the result (max 3 attempts, then fail honestly). */
  review: z.boolean().default(false),
  /** Agents this one may start. Only the Coordinator gets any. */
  delegate: z.array(AgentId).max(20).default([]),
  output: z.enum(['report', 'draft', 'artifact', 'alert', 'none']).default('report'),
  createdBy: z.enum(['builtin', 'user', 'agent']).default('user'),
  /** Which agent asked for this one; required when `createdBy` is `agent`. */
  requestedBy: AgentId.optional(),
  /** The instructions: the Markdown body of the file. */
  body: z.string().trim().min(1).max(20_000),
}).superRefine((d, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (d.mode === 'scheduled' && d.schedule === null) issue('schedule', 'a scheduled agent needs a schedule')
  if (d.mode !== 'scheduled' && d.schedule !== null) issue('schedule', 'only a scheduled agent has a schedule')
  if (d.mode === 'triggered' && d.trigger === null) issue('trigger', 'a triggered agent needs a trigger')
  if (d.mode !== 'triggered' && d.trigger !== null) issue('trigger', 'only a triggered agent has a trigger')
  if (UNATTENDED_MODES.includes(d.mode) && d.budget === undefined) issue('budget', `a ${d.mode} agent needs a budget`)
  if (d.delegate.length > 0 && d.id !== COORDINATOR_ID) issue('delegate', 'only the coordinator may delegate')
  if (d.delegate.includes(d.id)) issue('delegate', 'an agent cannot delegate to itself')
  if (new Set(d.delegate).size !== d.delegate.length) issue('delegate', 'duplicate agent')
  if (new Set(d.tools).size !== d.tools.length) issue('tools', 'duplicate tool')
  if (d.createdBy === 'agent' && d.requestedBy === undefined) issue('requestedBy', 'an agent-made definition records who asked for it')
})
export type AgentDefinition = z.infer<typeof AgentDefinition>

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Every contract by name, for boundaries that validate by name and for tests. */
export const CONTRACTS = {
  Identity, Utterance, ContextSlice, ToolManifest, TurnContext, BrainEvent,
  PolicyRequest, PolicyDecision, ApprovalResolution, Notification, MemoryItem,
  Mission, ChannelMessage, SkillManifest, DeviceEvent, AuditRecord, BusEvent,
  WorkflowRun, TaskOutcome, ChannelBinding, ChannelEvent, FreezeChange,
  AgentDefinition,
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
