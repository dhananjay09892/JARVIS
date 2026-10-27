# 38 · Shared data contracts (the schemas every plan depends on)

**Status:** Partial (phases 1–2 done) · **Priority:** P0/P1 (design before parallel work starts) · **Effort:** 1 week to design, then evolve

## Why
Thirty-odd plans talk to each other: wake → speaker → STT → router → brain → policy → tools →
TTS, plus alerts, channels, satellites and skills. Without agreed shapes each plan invents its
own and integration breaks. This file fixes the vocabulary. Types are written in TypeScript
notation; the real source of truth will be `shared/contracts.ts` (and JSON Schema) with
validation at every boundary (zod is already in `node_modules`).

## Principles
- Versioned (`v: 1`), additive changes only, unknown fields ignored.
- Every object carries `id`, `ts` (UTC ms), and where relevant `traceId` (16) and `deviceId` (03).
- Sensitive fields flagged (`sensitivity: 'public'|'private'|'vault'`) so policy/logging can redact.
- Strict validation on **inbound** boundaries (channels, satellites, MCP results, skills).

## Core objects

```ts
type Identity = {
  personId: string | 'guest'
  role: 'owner' | 'member' | 'child' | 'guest'
  confidence: number            // 0..1 from voice/face/device fusion (01)
  sources: ('voice'|'face'|'device'|'declared'|'carry-over')[]
}

type Utterance = {               // output of audio gateway
  id; traceId; deviceId; room?: string
  modality: 'voice' | 'text' | 'image'
  text: string; language: string; langConfidence: number   // (28)
  audioMs?: number; identity: Identity
  wake: { engine: string; score: number } | null            // (02)
  timings: { speechEnd: number; sttDone: number }           // (05, 16)
}

type TurnContext = {             // assembled for the brain (06, 14, 07)
  utterance: Utterance
  persona: { id: string; mode: 'normal'|'focus'|'night'|'guest' }
  slices: ContextSlice[]         // calendar, screen, presence … with TTL + sensitivity
  memories: { id; text; source; score }[]
  tools: ToolManifest[]          // already filtered by policy for this actor
  budget: { maxTokens; maxSteps; maxSpendUsd }
}

type BrainEvent =                // normalised across all brains (21)
  | { t: 'ready'; servers: string[] }        // optional: the session's usable tool servers
  | { t: 'text'; delta: string }
  | { t: 'tool_start'; id; name }            // optional: early, before args have streamed
  | { t: 'tool_call'; id; name; args }
  | { t: 'tool_result'; id; ok: boolean; summary: string; tainted: boolean; detail?: string }  // detail: bounded output, local journal only
  | { t: 'usage'; inTokens; outTokens; costUsd? }
  | { t: 'error'; code; retryable: boolean }
  | { t: 'done'; reason: 'complete'|'cancelled'|'limit' }

type PolicyRequest = {
  action: { kind: 'tool'|'device'|'message'|'file'|'spend'|'egress'; name; target?; args }
  actor: Identity; room?: string; presence: Identity[]
  taint: { privateRead: boolean; untrustedContent: boolean }
  risk?: 'R0'|'R1'|'R2'|'R3'|'R4'
}
type PolicyDecision = {
  verdict: 'allow' | 'ask' | 'deny'
  reason: string                 // human-readable, speakable
  approval?: { id; expiresAt; channel: 'hud'|'voice'|'chat'|'phone'; needsPin: boolean }
  grantId?: string               // standing grant used (15)
}

type Notification = {            // proactive layer (12)
  id; source; urgency: 'info'|'normal'|'important'|'urgent'
  audience: string[]; privacy: 'public'|'private'
  title; body; actions?: { id; label }[]; expiresAt?
}

type MemoryItem = {              // (07)
  id; kind: 'fact'|'person'|'preference'|'routine'|'episode'
  text; owner: string | 'household'; sensitivity
  provenance: { turnId; ts; confidence }
  embeddingId?
}

type Mission = {                 // (13)
  id; goal; plan: Step[]; status; budget; permissions: string[]
  log: { ts; kind; summary }[]; artifacts: string[]
}

type ChannelMessage = {          // (20)
  channel: 'telegram'|'sms'|'whatsapp'|'signal'|'email'
  senderId; person?: Identity; text?; audioRef?; imageRef?; threadId
}

type SkillManifest = { id; version; permissions; triggers; risk; inputs; tests }   // (19)
type DeviceEvent = { deviceId; room; kind: 'wake'|'level'|'state'|'sensor'; payload }   // (03, 09, 11)
type AuditRecord = { id; ts; actor; request: PolicyRequest; decision: PolicyDecision; result?; prevHash }  // (15)
```

## Event bus topics (12)
`utterance.received` · `turn.started|finished` · `tool.requested|allowed|denied` ·
`approval.requested|resolved` · `notification.created|delivered|suppressed` ·
`device.event` · `presence.changed` · `mission.progress|finished` · `health.check` ·
`budget.warning|exceeded` · `freeze.on|off` · `workflow.started|finished` · `task.finished`
(the last three added with the bus itself, Q32).

## Phases
1. ✅ **Design review (3 d):** walk three end-to-end scenarios (voice command with tool call; Telegram approval; morning briefing) and adjust the types.
2. ✅ **`shared/contracts.ts` + schemas + tests (3 d):** compile-time types, runtime validation, fixtures.
3. **Adopt in the bridge incrementally (ongoing):** wrap existing code with adapters; no big-bang rewrite.
4. **Contract tests in CI (16):** each producer/consumer validated against fixtures; breaking changes fail the build.
5. **Versioning policy and changelog (1 d).**

## Scenario walkthrough (phase 1, 2026-10-23)
The three scenarios were walked step by step against the types above; each is now a fixture in
`shared/fixtures/` that the tests validate end to end. What the walk changed:

| Gap found | Scenario | Change in `shared/contracts.ts` |
|---|---|---|
| Objects had no common envelope | all | Every top-level object carries `v: 1`, `id`, `ts`; turn objects carry `traceId` |
| `ContextSlice` and `ToolManifest` were named but never defined | voice | Defined: slices have `fetchedAt`, `ttlMs`, `sensitivity`, `untrusted`; tools have `readOnly` and optional `risk` |
| A decision could not be tied to its request | voice, Telegram | `PolicyDecision.requestId`; optional `rule` (what `bridge/policy.mjs` already returns) |
| `verdict: 'ask'` without an approval was representable | Telegram | Refinement: `ask` requires `approval` |
| No object for *how* an approval was answered | Telegram | New `ApprovalResolution` (`approved`/`denied`/`expired`/`cancelled`, by whom, which channel) — payload of `approval.resolved` |
| A Telegram reply could not say what it answers | Telegram | `ChannelMessage.inReplyTo`; at least one of text/audio/image; text capped at 16 000 chars |
| Background work has no voice/room | Telegram | `PolicyRequest.via` (`voice`/`hud`/`chat`/`worker`/`schedule`); `presence` may be empty |
| Typed text and channel turns have no STT timings | briefing | `Utterance.timings` stages optional; `wake` null when not woken by the wake word |
| Utterances had no sensitivity flag | all | `Utterance.sensitivity`, default `private` |
| Event bus had topics but no envelope | briefing | `BusEvent { topic, traceId?, payload }`, payload validated against the topic's schema where one is fixed |
| Brains may stop on an error | voice | `done.reason` gains `error`; `error` event gains optional `message` |
| Mission steps were untyped | Telegram | `MissionStep { id, summary, status }` |

Rules kept from the principles: unknown fields are stripped, not rejected; a different `v` is
rejected; validation errors never echo the rejected value (safe to log).

## Done when
The three scenarios run through typed boundaries, and CI fails on a contract-breaking change.

## Autopilot log
- **2026-10-23 — Phases 1–2 (Q14).** Walked the three scenarios (table above) and wrote
  `shared/contracts.ts`: zod schemas with inferred types for every core object plus
  `ContextSlice`, `ToolManifest`, `ApprovalResolution` and the `BusEvent` envelope;
  `checkContract` / `parseContract` helpers. Fixtures for the three scenarios in
  `shared/fixtures/`, 36 tests in `shared/contracts.test.ts` (scenario validation, cross-ids,
  additive compatibility, rejections, log-safe errors). `tsconfig.shared.json` adds `shared/`
  to `tsc -b`; the release workflow runs the contract tests. Nothing adopts the contracts yet.
  **Left:** phase 3 (adopt in the bridge; the bridge is `.mjs` and `engines` allows Node 22.13,
  which cannot import `.ts` without a flag — adoption needs either a build step, `tsx`, or a
  Node ≥ 22.18 floor), phase 4 (contract tests on every PR — there is no PR CI yet), phase 5.
- **2026-10-27 — Event bus topics (Q32, plan 12).** Additive change: topics
  `workflow.started`, `workflow.finished` (payload `WorkflowRun`) and `task.finished` (payload
  `TaskOutcome`) added to `TOPICS`, with tests. First step of phase 3 for the bus: the bridge
  publishes through a plain-JS copy of `BusEvent` in `bridge/bus.mjs`, kept in step with the
  contract by a parity test (same pattern as `bridge/brains/events.mjs`).
