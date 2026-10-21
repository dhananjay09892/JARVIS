# Agent Skills (`SKILL.md`)

**Kind:** tool-provider (instructions + scripts) · **Auth:** none · **Platform:** Any · **Risk tier:** R1 for read-only skills; R2+ if the skill uses write tools or scripts · **Priority:** P1

## What it gives JARVIS
Reusable know-how: a skill tells the brain *when* and *how* to do a task ("prepare a meeting brief", "summarise a PDF", "triage email") and can ship helper scripts and reference files. Because the format is an open standard, the same skill works with Claude, Codex, OpenJarvis and others.

## Format
```
my-skill/
├── SKILL.md        required: YAML frontmatter (name, description) + instructions
├── scripts/        optional executable helpers
├── references/     optional docs loaded on demand
└── assets/         optional templates and resources
```
```markdown
---
name: meeting-brief
description: Prepare a short brief before a meeting. Use when the user asks to prepare for a meeting or call.
---
Steps for the agent to follow...
```
Optional spec fields include `license`, `compatibility`, `metadata` and `allowed-tools`. Claude Code also discovers skills in `~/.claude/skills/<name>/SKILL.md` (personal) and `.claude/skills/` (project), and inside plugins at `skills/<name>/SKILL.md` (*verify exact paths against the current Claude Code docs*).

## How a user connects it
1. **Pick a skill:** from JARVIS's built-in set, a marketplace, a GitHub URL, or write your own.
2. In JARVIS: **Settings → Skills → Add** → choose a folder or paste a repo URL.
3. JARVIS shows the **full SKILL.md, scripts and requested tools**, and the trust tier. Read it.
4. Choose **Enable**, and choose whether it may run scripts (default off) and which tools it may use.
5. Test: ask for the task in plain words, or say the skill's name.

## How we implement it in JARVIS
1. **Loader:** scan configured skill directories; parse frontmatter; build a catalog (`name`, `description`, path); put the catalog in the brain's context and load full bodies only when selected (progressive disclosure).
2. **Validation:** require `name` and `description`; size limits; reject path traversal; show warnings for scripts.
3. **Execution rules:** instructions are advisory text for the brain; any tool the skill triggers still goes through the policy engine. Scripts run only in a sandbox (no network by default, working directory limited, timeouts).
4. **`allowed-tools`** is treated as a *request*, never a grant.
5. **Sources:** local folders, git repos (pinned commit), marketplaces; show provenance and licence.
6. **Updates:** diff view; re-approve on change.
7. **Telemetry:** none sent out; local usage stats shown to the user (plan 19).
8. **Interop:** export JARVIS skills in the same format; import OpenJarvis/Codex/Claude skills unchanged.

## Acceptance tests
Valid skill loads and is selectable; invalid frontmatter reports a clear error; a skill that tells the agent to email files is blocked by policy; scripts cannot reach the network; updating a skill triggers a diff and re-approval; catalog stays within a token budget with hundreds of skills.

## Risks
Prompt-injection through skill text; supply-chain attacks on popular skills; context bloat; unclear licences.

## Related
[Part overview](../README.md) · [plan 19](../../../19-skills-ecosystem.md) · [OpenJarvis skills importers](../../openjarvis/README.md) · [Codex skills](../../codex/skills/README.md)
