# Codex · Skills (`.agents/skills`)

**Kind:** tool-provider interop · **Auth:** none · **Platform:** Any · **Risk tier:** R1–R2 · **Priority:** P2
**Reference:** OpenAI Codex Skills docs (learn.chatgpt.com/docs/build-skills), read 2026-10-21.

## What it gives JARVIS
The same `SKILL.md` format as Claude, discovered in different folders. Supporting these paths means skills a user already has for Codex show up in JARVIS (after approval), and skills JARVIS creates work in Codex.

## Format and discovery (from the docs)
- A skill is a directory with `SKILL.md` containing `name` and `description` frontmatter; optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml` for UI metadata and invocation policy.
- Discovery paths: `$CWD/.agents/skills`, parent folders up to the repo root, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills` (user), `/etc/codex/skills` (admin), plus system-bundled skills. Symlinks are followed; same-named skills are not merged.
- Loading is progressive: names and descriptions first (about 2% of the context window, 8,000 characters if unknown; configurable up to 10,000 tokens), full body only when selected.
- Invocation: explicit (`$skill-name` in the CLI/IDE, `@` in ChatGPT) or implicit by description match; `agents/openai.yaml` can set `policy.allow_implicit_invocation: false`.
- Install: `$skill-installer <name>` for curated skills; team sharing by committing to `.agents/skills`.
- Disable locally in `~/.codex/config.toml` with `[[skills.config]]` entries (`path`, `enabled = false`).

## How a user connects it
1. In JARVIS: **Settings → Skills → Sources → Add Codex skills folder** (suggests `~/.agents/skills` and the current project's `.agents/skills`).
2. JARVIS lists the skills it finds (name, description, path, whether it has scripts) with trust tier "imported".
3. Review → enable the ones you want. Skills with `scripts/` need explicit permission to run them.
4. To share the other way: **Export skill → Codex** writes the skill to `~/.agents/skills/<name>/` (never overwrites without a diff).

## How we implement it in JARVIS
1. Add the Codex discovery paths as skill sources in the registry from [agent-sdk-loading](../../claude-skills-and-plugins/agent-sdk-loading/README.md).
2. Parse `agents/openai.yaml` for implicit-invocation policy and honour `allow_implicit_invocation: false`.
3. De-duplicate by name across sources and show conflicts (do not merge silently).
4. Respect the "disabled" entries in Codex's config only as a hint; JARVIS keeps its own enable state.
5. Same sandbox and policy rules as other skills ([skills](../../claude-skills-and-plugins/skills/README.md)).

## Acceptance tests
Skill in `~/.agents/skills` appears; duplicate names are flagged; `allow_implicit_invocation: false` stops automatic selection; export round-trips without data loss; script execution requires approval.

## Related
[Codex overview](../README.md) · [Claude skills](../../claude-skills-and-plugins/skills/README.md) · [plan 19](../../../19-skills-ecosystem.md)
