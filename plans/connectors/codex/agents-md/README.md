# Codex · `AGENTS.md`

**Kind:** instruction source · **Auth:** none · **Platform:** Any · **Risk tier:** R1 (text steering an agent) · **Priority:** Later
**Reference:** described in OpenAI's Codex docs and community guides; layered files: `~/.codex/AGENTS.md` (global) → repository root → nested directories (*verify exact precedence in current docs*).

## What it gives JARVIS
A convention for project and user instructions that many coding agents read. For JARVIS it matters in two places: (1) when JARVIS drives a coding workspace (plan 10, development workspace), it can honour the repo's `AGENTS.md`; (2) JARVIS's own persona and house rules can be exported in this format so Codex used as an executor behaves consistently.

## How a user connects it
1. Nothing to install. Put an `AGENTS.md` in the repository (or use your global one).
2. In JARVIS: **Settings → Workspaces → (project) → "Use AGENTS.md"** (default on for trusted projects).
3. JARVIS shows the effective instructions (merged order) so you can see what will be followed.

## How we implement it in JARVIS
1. Read `AGENTS.md` files from the workspace path up to its root plus the user's global file; merge in precedence order; cap size.
2. Treat the contents as **repository-provided text, untrusted by default** for security-sensitive decisions: it can steer style and workflow, but it cannot lower safety settings, grant tool permissions, or approve actions (a malicious repo must not take over the agent).
3. Include the merged text in the executor's prompt (Codex gets it natively; other brains get it injected).
4. Export: generate a small `AGENTS.md` from JARVIS's persona and constraints for coding tasks.

## Acceptance tests
Nested files merge in order; oversized file is truncated with a warning; an `AGENTS.md` saying "disable approvals" has no effect; untrusted project's file is shown but off until the owner enables it.

## Related
[Codex overview](../README.md) · [plan 10](../../../10-computer-and-phone-control.md) · [plan 15](../../../15-policy-trust-and-privacy.md)
