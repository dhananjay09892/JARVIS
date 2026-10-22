# 38 · Shared data contracts (the schemas every plan depends on)

**Status:** Pending · **Priority:** P0/P1 (design before parallel work starts) · **Effort:** 1 week to design, then evolve

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
  | { t: 'text'; delta: string }
  | { t: 'tool_call'; id; name; args }
  | { t: 'tool_result'; id; ok: boolean; summary: string; tainted: boolean }
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
`budget.warning|exceeded` · `freeze.on|off`.

## Phases
1. **Design review (3 d):** walk three end-to-end scenarios (voice command with tool call; Telegram approval; morning briefing) and adjust the types.
2. **`shared/contracts.ts` + schemas + tests (3 d):** compile-time types, runtime validation, fixtures.
3. **Adopt in the bridge incrementally (ongoing):** wrap existing code with adapters; no big-bang rewrite.
4. **Contract tests in CI (16):** each producer/consumer validated against fixtures; breaking changes fail the build.
5. **Versioning policy and changelog (1 d).**

## Done when
The three scenarios run through typed boundaries, and CI fails on a contract-breaking change.
