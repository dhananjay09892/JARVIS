# 24 · Brain: Google Gemini

**Status:** Pending · **Priority:** P2 · **Effort:** 1 week (API key) + subscription track after research

## Goal
Offer Gemini as a brain, via API key first, and via a Google-account/subscription route only
if Google's current terms and products allow it.

## What is known (uncertain, verify first)
- The old **Gemini CLI** offered a free Google-login tier (about 1,000 requests/day for a personal account) and higher caps for paid Google plans ([quota page](https://geminicli.com/docs/resources/quota-and-pricing/)).
- A third-party post ([dev.to](https://dev.to/owen_fox/gemini-cli-free-tier-shut-down-6-fixes-that-work-2026-26hc)) says Gemini CLI stopped serving the free Google-login path on **2026-06-18**, moving to a closed-source **Antigravity CLI**; API-key use continues. Not confirmed from an official Google source.
- Other tools (e.g. Roo Code) reuse the CLI's OAuth login; whether Google's terms permit third-party reuse is **unknown**.

## Decision gate (week 0)
Find out from Google's official docs:
1. What is the current supported way to use a Google AI Pro/Ultra subscription programmatically (Antigravity CLI? SDK?), and does it allow third-party apps?
2. Whether the Antigravity CLI offers headless mode, MCP, permission hooks and streaming.
3. Gemini API (AI Studio / Vertex) pricing, free tier, rate limits, data-use terms (is free-tier data used for training?).
Outcome options: (a) API key only, (b) API key + official subscription route, (c) defer.

## Design
- **Track A, API key (tool-loop mode, shares code with plan 25):** Gemini API with function calling; JARVIS runs the loop; persona via system instruction; streaming; vision support (useful for plan 11/14).
- **Track B, subscription route:** only if the gate confirms an official, third-party-permitted path; an adapter like 22/23 using the vendor CLI/SDK with MCP and permission hooks.
- Strengths to exploit: long context (large documents, screen history), native multimodal (images, audio, video), cheap fast models for the quick path.
- Privacy note: if the free tier uses data for improvement, show a warning and recommend a paid tier for private use.

## Phases
1. **Research gate (2 d):** produce the findings above and update the terms register.
2. **Track A adapter (3–4 d):** function calling, streaming, cancellation, usage; conformance suite.
3. **Multimodal hooks (2 d):** image input for "what's on my screen/camera" tasks.
4. **Track B (only if approved) (1 w):** CLI/SDK adapter with policy wiring.
5. **Routing rules (1 d):** use Gemini for long-context or vision-heavy turns when enabled.

## Risks
- Product churn (CLI retired/replaced) → adapter isolation, version pins, easy disable.
- Free-tier data handling.
- Function-calling reliability with many tools → tool subsetting per turn.

## Done when
A user can enter a Gemini API key, choose Gemini as default or for vision tasks, pass the conformance suite, and the Settings screen states clearly whether a subscription login is supported.

## Related plans
[21](21-multi-brain-framework.md) · [25](25-brain-api-providers.md) · [28 multilingual strengths](28-multilingual.md) · [11 vision](11-vision.md)
