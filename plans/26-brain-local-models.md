# 26 · Brain: local models (Ollama, LM Studio, llama.cpp)

**Status:** Pending · **Priority:** P2 · **Effort:** 1–2 weeks (basic), more for quality · **Depends on:** 21, 25 (shares the tool-loop adapter), 06

## Goal
A private, offline-capable brain with no subscription and no per-token cost: fast replies for
simple requests, reflex-level smart-home and timer commands, and a "degraded but alive" mode
when the internet or cloud brain is down (see 17).

## Positioning (be honest)
Local models are **weaker at long reasoning and reliable tool use** than frontier cloud
models. They are a *complement*: private, free, quick for small things; not the default for
complex tasks.

## Design
- Reuse the OpenAI-compatible tool-loop adapter from 25; profiles for **Ollama**, **LM Studio**, **llama.cpp server**.
- **Hardware probe + model recommendation:** detect RAM/VRAM/CPU; suggest a model size (small 3–8B for CPU, larger with a GPU); one-click pull via Ollama; show expected speed.
- **Capability flags:** tools supported? vision? context length? — decide routing accordingly (e.g. no tools → chat/reflex only).
- **Tool restrictions:** local brain gets a **small allow-listed tool set** (timers, notes, home control, calendar read, memory read) and **no write/exec tools** by default; prompt-injection resistance is lower, so taint rules are stricter (08, 15).
- **Routing role (06):** reflex → local for trivial chat/commands; escalate to cloud on uncertainty or when a tool outside the allow-list is needed; offline → local only.
- **Home-control specialisation (with 09):** optional small model tuned for Home Assistant intents.
- **Privacy win:** with local STT/TTS (04) and local wake word (02) this gives a fully offline stack; label the UI mode clearly.

## Phases
1. **Adapter profile and connectivity (2 d):** detect Ollama/LM Studio, list models, test connection.
2. **Hardware advisor and model puller (2 d).**
3. **Allow-list tool mode + conformance subset (3 d):** run a reduced suite; publish what works.
4. **Routing and escalation rules (2 d):** confidence heuristics (tool needed? long reasoning? uncertain?) with a spoken "let me ask my bigger brain".
5. **Offline mode integration (3 d):** combine with 04/17 degraded-mode state machine; measure offline task success.
6. **Quality evals (2 d):** compare models on the persona/behaviour set in 16; keep a small "known good models" list.

## Risks
Slow on weak hardware, hallucinated tool calls, long-context degradation, battery drain → strict allow-list, timeouts, resource governor (17), clear "basic mode" labelling.

## Done when
With internet off, JARVIS still handles timers, notes, home control via local APIs, and simple conversation, and escalates (or says it cannot) for anything else.

## Related plans
[21](21-multi-brain-framework.md) · [04](04-local-speech-stack.md) · [17 offline mode](17-deployment-and-resilience.md) · [09](09-smart-home.md)
