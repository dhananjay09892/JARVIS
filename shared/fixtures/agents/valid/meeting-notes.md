---
id: meeting-notes
name: 'Meeting Notes'
description: Turns a finished meeting's transcript into notes and proposed follow-ups.
mode: triggered
trigger: meeting.ended
brain: external:hermes
model: hermes-3.1
tools:
  - transcript_read
memory: propose
budget:
  maxToolCalls: 10
  maxMinutes: 10
  maxCostUsd: 0
review: false
output: draft
createdBy: agent
requestedBy: coordinator
---

Summarise decisions, owners and dates. Propose follow-ups; never send them.
