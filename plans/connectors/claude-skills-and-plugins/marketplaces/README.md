# Skill and plugin marketplaces

**Kind:** discovery source · **Auth:** none (git) · **Platform:** Any · **Risk tier:** R2 · **Priority:** P2

## What it gives JARVIS
A catalogue to browse and install from, instead of hand-copying folders.

## Sources and sizes (counts are third-party and change quickly; verify before quoting)
| Source | What | Notes |
|---|---|---|
| **Anthropic official plugins** | Plugins managed in the `anthropics/claude-code` repo and Anthropic's directory | An older guide cited 13 official plugins; the current count was not found. Directory submission uses `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` fields in `plugin.json`. |
| **Community Claude plugin marketplaces** | Git repos with a `marketplace.json` (e.g. cased/claude-code-plugins, Max-Levitskiy/skills) | "100+ plugins in 13 categories" was reported by an old source; unverified for 2026. |
| **Agent Skills catalogues** | Hermes (~150 skills), OpenClaw (~13,700 community skills), GitHub repos | Quoted in OpenJarvis's README; OpenClaw's marketplace later had **1,184 malicious skills** reported by one security vendor (unverified), so large community catalogues need scanning. |
| **Codex plugin marketplaces** | Git repo or local dir with `.agents/plugins/marketplace.json` | Shared with ChatGPT's directory per OpenAI docs; manifest details from blogs (*verify*). |
| **MCP registries** | Official MCP Registry (~43,000 active servers per a third-party census), Smithery, Glama, PulseMCP | Not skills, but the same vetting needs. |

## How a user connects it
1. In JARVIS: **Settings → Skills & Plugins → Sources → Add source** → paste a git URL (`owner/repo`) or choose a local folder.
2. JARVIS fetches the catalogue (metadata only) and shows entries with trust tier, author, licence, last update and requested permissions.
3. Pick an entry → **Review** → **Install** (disabled until you enable it).
4. Optional: add your **private marketplace** (git repo) for your own or your team's skills.

## How we implement it in JARVIS
1. **Marketplace reader:** git clone/fetch of a repo containing a catalogue file (Claude's `marketplace.json`; Codex's `.agents/plugins/marketplace.json`), cached; never run code during browsing.
2. **Vetting pipeline:** static checks (manifest validity, path escapes, name spoofing, suspicious hooks/executables), dependency listing, licence detection, "last updated" and "stars" as hints only; optional malware/injection scan; trust tier assignment.
3. **Pinning:** install by commit SHA; show diff on update; no auto-update for community sources.
4. **Allow-list of sources:** off by default; owner adds each source explicitly; organisations can restrict to private ones.
5. **Provenance record:** URL, commit, hash of installed files, install date, who approved.
6. **Takedown:** a local deny-list and a remote advisory feed (later) to disable known-bad entries.

## Acceptance tests
Catalogue loads without executing anything; a spoofed vendor name is flagged; update shows a diff; deny-listed entry is disabled at next start; offline browsing works from cache.

## Risks
Supply-chain compromise (the dominant risk); typosquatting; abandoned entries; licence ambiguity; marketplace format changes.

## Related
[Part overview](../README.md) · [skills](../skills/README.md) · [plugins](../plugins/README.md) · [plan 19](../../../19-skills-ecosystem.md) · [plan 36](../../../36-economics-and-licensing.md)
