# 14 · Ambient context: knowing what's going on

**Status:** Pending · **Priority:** P2 · **Effort:** 2–4 weeks · **Depends on:** 15 (consent), 07

## End state
JARVIS answers "this", "that", "here", "why is it doing that?" correctly because he knows
your context: what is on screen (when you allow it), what you are working on, your calendar,
time, place, who is present, device state, recent files and messages — assembled on demand
with consent and a strict token budget.

## Context sources (each opt-in, individually revocable)
| Source | Example use | Capture |
|---|---|---|
| Screen / active window | "explain this error", "summarise this page" | On demand snapshot or accessibility text; never continuous by default |
| Calendar & tasks | "am I free Thursday?", travel time | Connector (08) |
| Location & travel | "leave now", "near me" | Phone, coarse |
| Presence & room | who/where (01, 03, 11) | Local |
| Recent files / clipboard | "summarise the file I just downloaded" | Explicit permission |
| Work state | open repo, branch, failing tests | Workspace tools (10) |
| System state | battery, network, now-playing | Local |

## Phases
1. **Context broker (1 w):** a module that gathers named context "slices" on demand with TTL, per-source permission, redaction, and a token budget; the orchestrator (06) requests slices per intent.
2. **Screen understanding (1 w):** active-window title/URL + accessibility text first, screenshot+vision second; "pin this context" for a session.
3. **Deixis resolution:** map "this/that/it" to the last relevant slice/object (selected text, last file, last mentioned person).
4. **Calendar-aware behaviour:** meeting prep summaries, run-late detection, focus mode during meetings.
5. **Situational modes:** driving (voice-only, short), sleeping (whisper/urgent only), working (terse), guests (formal).
6. **Context transparency:** "what do you know about my current situation?" lists slices used and when; a toggle panel in the HUD.
7. **Privacy filters:** per-app denylist (banking, password manager, private browsing), auto-redact secrets and card numbers in captures.

## Metrics
Deixis accuracy on a test script ≥ 90 %; avg context tokens per turn ≤ budget; zero captures from denylisted apps; user-visible indicator whenever a capture occurs.

## Risks
Surveillance feel → opt-in, indicator, on-demand-first design; token bloat → relevance ranking and summarisation; stale context → TTLs.

## Related plans
[07](07-memory-upgrade.md) · [15](15-policy-trust-and-privacy.md) · [33](33-knowledge-work-and-meetings.md) · [34 location](34-wearables-and-mobility.md) · [29 permissions UX](29-onboarding-and-first-run.md)
