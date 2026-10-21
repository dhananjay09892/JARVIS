# JARVIS plans

One file per piece of work. Written October 2026 against `release/0.1.5`.
Each plan has: goal, where things stand today, steps, and how to know it is done.

Status key: **Done** (works today) · **Partial** (some of it works) · **Pending** (nothing yet).
Effort is rough. Priorities (P0/P1/P2/Later) follow `docs/IMPROVEMENT_PLAN.md`
(on branch `docs/improvement-plan`, not yet merged to `main`).

## Gap check: the 12-step "movie Jarvis" list vs. this repo

| # | Capability | Status | What exists | What is missing | Plan |
|---|---|---|---|---|---|
| 1 | Mics in every room | **Pending** | One browser mic on the PC | Satellite mics, phone as mic | [03](03-multi-room-satellites.md) |
| 2 | Wake word | **Partial** | Name matched in transcripts (`WAKE` in `voice.ts`), clap trigger; Porcupine is a dependency but `WAKE_ENGINE` is never used | Offline wake engine; room audio currently goes to the cloud before the wake word | [02](02-offline-wake-word.md) |
| 3 | Speech to text | **Partial** | ElevenLabs Scribe via bridge `/stt`; browser fallback; VAD + pause-aware sentence assembly | Local STT (faster-whisper) | [04](04-local-speech-stack.md) |
| 4 | Text to speech | **Partial** | ElevenLabs, local Kokoro (`kokoro.ts`), browser voice | Voice/licence review; Piper option | [04](04-local-speech-stack.md) |
| 5 | Real-time engine | **Mostly done** | Custom loop with barge-in, echo filter, open mic during answers | No latency number (end of speech to first sound); no <1 s budget | [05](05-latency-and-realtime.md) |
| 6 | Brain + personality | **Partial** | Claude via Agent SDK, `SYSTEM_PROMPT` persona | Fast/slow model routing; local model | [06](06-brain-routing.md) |
| 7 | Memory | **Done** (basic) | SQLite memory, journal, conversations, view/edit/forget, memory tools | Semantic search; save-after-approval suggestions | [07](07-memory-upgrade.md) |
| 8 | Data + internet | **Partial** | Any MCP server in the user's Claude config; read-only by default | Prompt-injection hardening, permission-gate fix | [08](08-data-access-and-safety.md) |
| 9 | Smart home | **Pending** | Nothing | Home Assistant MCP with risk levels | [09](09-smart-home.md) |
| 10 | Computer + phone control | **Partial** | Android MCP, app launching (Windows only), dev workspace, Chrome driving, workflows | macOS/Linux; fixed automations library | [10](10-computer-and-phone-control.md) |
| 11 | Eyes | **Partial** | `camera.ts`, `vision.mjs`, hand gestures | Event-driven local detection (Frigate-style); who-is-it | [11](11-vision.md) |
| 12 | Proactive alerts | **Pending** | Daily scheduled workflows exist | "Announce" step, quiet hours, briefing, event triggers | [12](12-proactive-alerts.md) |
| – | Who is speaking | **Pending** | Nothing; STT returns text only | Speaker verification | [01](01-speaker-identification.md) |

## Suggested order

1. **Safety and trust first:** [08](08-data-access-and-safety.md) (permission gate, injection) and [02](02-offline-wake-word.md) (stop sending room audio to the cloud).
2. **Who is talking:** [01](01-speaker-identification.md). It makes per-person permissions and memory possible.
3. **Feel:** [05](05-latency-and-realtime.md), [06](06-brain-routing.md).
4. **Reach:** [12](12-proactive-alerts.md), [07](07-memory-upgrade.md), then [09](09-smart-home.md), [03](03-multi-room-satellites.md), [11](11-vision.md).
5. **Offline mode** ([04](04-local-speech-stack.md)): last, biggest effort, smallest audience.

## Already-decided constraints

- JARVIS stays on the user's own Claude subscription (see memory note / `IMPROVEMENT_PLAN.md` #5).
- Writes and effectful tools stay off by default; anything new that acts on the world goes through the approval queue.
- Windows installer is the main product; Node 22.13+ is required for source users.
