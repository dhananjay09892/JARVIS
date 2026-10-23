# ADR 001 · Subscription brain terms: may JARVIS run on a user's own subscription login?

- **Status:** Accepted (2026-10-23)
- **Plans:** [21 Multi-brain framework](../21-multi-brain-framework.md) (phase 6, provider terms register) ·
  [22 Codex](../22-brain-openai-codex.md) · [23 Copilot](../23-brain-github-copilot.md) ·
  [24 Gemini](../24-brain-google-gemini.md) · [27 Other agent CLIs](../27-brain-other-agent-clis.md) ·
  roadmap open decision 1 in [37](../37-execution-roadmap-and-risks.md) · licence blocker **B2** in [LICENCES](../LICENCES.md)
- **Queue:** written by Q15. Informs Q16–Q18 and Q21 (brain interface and adapters) and Q41 (B2).
- **Date checked:** 2026-10-23
- **Decision:** Accepted as recommended (**B + D**), decided by the owner on 2026-10-23:
  - **Anthropic:** subscription sign-in stays the default; add a Claude API-key mode as a supported fallback (Q42). Keep every B2 condition (stock binary, never touch credentials, never "Claude Code" in the product name). Ask Anthropic for written confirmation (Q44) and record the answer here.
  - **OpenAI:** Sign in with ChatGPT + Responses API through the Q21 adapter (Q43), following the SIWC terms; not the Codex CLI's login.
  - **GitHub Copilot:** Copilot SDK login, one GitHub login per person (plan 23).
  - **Google:** API key only; plan 24 Track B dropped unless Google publishes a third-party route.
  - **Other agent CLIs (plan 27):** API key only until a vendor documents subscription use.
  - Build the terms register (21 phase 6) and re-check this ADR before each release.

> This is a reading of public vendor documents by the autopilot, not legal advice. Terms in this
> area changed several times in 2026 (see the Anthropic timeline below), so every row carries the
> date it was checked and should be re-checked before a release.

## Context

JARVIS's standing constraint is that the default brain is **Claude on the user's own
subscription**, with no API key (README: "The only subscription you need is Claude"). Plans 21–27
want other brains, ideally also on the user's existing subscription. Each vendor has its own rule
on whether a third-party app may use a consumer subscription login, and breaking that rule risks
the **user's** account being suspended, not ours. So this ADR records, per provider, what the
vendor says today.

How JARVIS signs in today (relevant to Anthropic):

- The bridge (`bridge/server.mjs`) runs the **Claude Agent SDK**, which drives the **unmodified
  Claude Code binary** shipped in the SDK's platform package (`bridge/claude-cli.mjs`).
- Sign-in is `claude auth login`, i.e. **Anthropic's own browser flow**. JARVIS never sees,
  stores or proxies the user's Claude credentials or tokens; the binary keeps them.
- Each install is one person's own machine using their own account; nothing is hosted, resold or
  shared between users.
- If `ANTHROPIC_API_KEY` is in the environment, the same binary bills that key instead, so an
  API-key mode needs no new code path in the bridge (only a place to enter the key, Q20/Q22).
- A separate browser-direct mode already exists (`src/lib/anthropic.ts`, `VITE_ANTHROPIC_API_KEY`);
  Q22 plans to move that key behind the bridge.

## Findings per provider

Risk levels: **Low** = the vendor documents this use for third-party apps; **Medium** = allowed on
a reading of the text but ambiguous or recently changed; **High** = the vendor prohibits it or
has enforced against it.

### 1. Anthropic (Claude): plan 21, the current default

| | |
|---|---|
| What the terms say | Claude Code legal page, "Authentication and credential use": OAuth (subscription) login "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." **Developers** building products, "including those using the Agent SDK, should use API key authentication". "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users", and may not "collect, store, or intermediate Claude.ai credentials or session tokens". But this "does not … prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude subscription, including where a platform hosts Claude Code". Running Claude Code in a product requires the Commercial Terms, an unmodified binary, no removed sign-in methods, and no paying for / reselling / intermediating usage. "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." Anthropic "may [enforce] without prior notice." |
| What the help centre says now | "Use the Claude Agent SDK with your Claude plan" (updates 15 June and 7 Oct 2026): "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits." Max and Team plans now also include monthly API credits ($100 Max 5x, $200 Max 20x) that cover the Agent SDK **when used with an API key** from the linked Console org; subscription sign-in keeps drawing from plan limits. |
| History (2026) | Feb 2026: the legal page was updated to bar third-party apps from subscription OAuth. 4 Apr: OAuth access cut off for third-party harnesses (OpenClaw, NanoClaw). 13 May: reversed, with a planned separate monthly "Agent SDK credit" at API rates from 15 June. 15 June: that change paused ("For now, nothing has changed"). 7 Oct: Max/Team API credits added; subscription use of the SDK and third-party apps still allowed. Anthropic says it will give notice before any revised plan. (Timeline from the help centre plus a third-party summary; the April and May steps are secondhand.) |
| How JARVIS fits | **Fits** the explicit carve-out on the facts: stock binary, Anthropic's own sign-in flow, no credentials touched, each user on their own account, no resale. **Tension:** JARVIS is a third-party product built on the Agent SDK, which the same page says "should use API key authentication", and the help centre's permission for "third-party apps" on subscription limits is explicitly provisional. A long-running voice assistant with background tasks may also stretch "ordinary, individual usage". |
| Risk | **Medium.** Allowed today by the help centre and arguably by the carve-out; the developer sentence and three policy changes this year make it the most likely to change. Ship-blocking only if Anthropic revokes the help-centre permission. |

### 2. OpenAI (ChatGPT / Codex): plan 22

| | |
|---|---|
| What the terms say | **Sign in with ChatGPT (SIWC)**, launched for plan usage at DevDay on 29 Sep 2026: "Eligible Plus and Pro users can bring their plan usage to participating apps." OpenAI's developer docs: "ChatGPT plan usage is available to **all open-source partners** and selected private clients", via a self-serve flow with no client secret or API key ("OpenAI registers the client during this flow"); commercial sign-in is a limited trial with selected partners (waitlist). The cookbook says plan usage is "available to open-source projects, personal projects that run locally, and selected private apps." The token is for **eligible Responses API requests**. SIWC Terms: requests must be for the signed-in user from a "local runtime or a remote runtime only that user controls"; tokens stored locally under the user's control; tokens obtained only through OpenAI's sign-in flow; no passwords or cookies; no pooling, reselling or sharing usage; users may not have to pay the app to use their plan; consent before background use; use your own app name, no implied endorsement; provide a privacy notice and a "Manage usage" link. Users can set per-app weekly caps in ChatGPT settings; at the limit, usage stops. |
| Codex CLI route | Codex supports "Sign in with ChatGPT" in its own CLI and SDK. Nothing found that lets a third-party app reuse the Codex CLI's `auth.json`; OpenAI's automation guidance prefers API keys. SIWC is the sanctioned route instead. |
| How JARVIS fits | **Good fit** for SIWC: JARVIS is MIT open source and runs locally on the user's machine. Integration would be a tool-loop brain on the Responses API (plan 25 / Q21 adapter, OpenAI profile) with SIWC as its auth, rather than driving the Codex CLI. Q21's OpenAI-compatible adapter is the natural base. |
| Risk | **Low** for SIWC in an open-source local app (documented, self-serve). **Medium–High** for piggybacking on the Codex CLI login (not documented for third parties). API key: Low. |

### 3. GitHub Copilot: plan 23

| | |
|---|---|
| What the terms say | The **Copilot SDK** (MIT, now "generally available and follows semantic versioning") is GitHub's documented way to embed the Copilot agent runtime in apps. Auth options listed by GitHub: the signed-in user's Copilot CLI login, **an OAuth GitHub App passing user tokens**, `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`, or BYOK. "A GitHub Copilot subscription is required … unless you use BYOK"; each prompt counts against the user's allowance (individual plans now metered in AI credits; premium requests are "legacy" since 1 June 2026). Individual use is governed by GitHub Terms of Service section J (AI features; effective 27 Apr 2026); business plans by the Generative AI Services Terms. GitHub ToS B.3: one login per person; H: API abuse or excessive requests can be suspended. No clause found that forbids a third-party app from using a user's own Copilot login through the SDK. |
| How JARVIS fits | **Good fit**: user signs in to GitHub themselves (device flow or their CLI login), JARVIS drives the SDK locally for that one user. Avoid sharing one account's token between household members (B.3). |
| Risk | **Low.** Remaining check for Q-tasks on plan 23: read the SDK's own "Usage and billing" page before shipping, and watch AI-credit burn from chatty voice use. |

### 4. Google (Gemini): plan 24

| | |
|---|---|
| What the terms say | Gemini CLI terms page (updated 10 Apr 2026): using third-party software to reach the services behind Gemini CLI ("using OpenClaw with Gemini CLI OAuth") "is a violation of applicable terms and policies … grounds for suspension or termination of your account." Antigravity Additional Terms, section 6: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement", "including … using the Service in connection with products not provided by us." Google **enforced** this: bans of Antigravity users in Feb 2026 (maintainer post 27 Feb 2026 requiring users to "recertify"), "more robust detection" announced 18 Mar 2026. On **18 June 2026** Gemini CLI stopped serving Google AI Pro, Ultra and free-tier logins; those users moved to the closed **Antigravity CLI**. Gemini CLI remains available with **paid Gemini API keys** and Vertex / enterprise licences. |
| How JARVIS fits | Using a Google AI Pro/Ultra login from JARVIS (directly, or by driving Gemini CLI / Antigravity CLI with the user's consumer OAuth) **does not fit**. A maintainer called one ACP integration "a legitimate use of the product", but there is no official carve-out. |
| Risk | **High** for any subscription route. API key (AI Studio / Vertex): Low. That is plan 24's Track A. |

### 5. Others (plan 27): first pass only

| Provider | Finding (2026-10-23) | Risk for subscription use |
|---|---|---|
| Cursor | Forum answer relaying a Cursor teammate (10 Jul 2026): "using Cursor as a backend AI service inside your product is a supported and intended use of the Cursor SDK", billed to "the account tied to the API key"; "you can't give third parties access to Cursor or usage under your account." Not clear whether an app may use **each end user's own** Cursor key; not an official policy page. Since 12 Oct 2026 Cursor is also bundled in the "X Subscription" with Grok usage. | Medium (unverified) |
| xAI (Grok) | X Subscription (12 Oct 2026) shares Grok usage "across Cursor, the Grok apps, and X"; no programmatic or third-party access to the subscription found. xAI API is separate and pay-as-you-go. | High / unknown; API key only |
| Mistral (Le Chat / Vibe) | No documented third-party use of a Le Chat subscription found in this pass. | Unknown; API key only |
| OpenCode, Amp, Kilo Code and other harnesses | Harnesses, not model sources. Several are OpenAI SIWC launch partners; that is OpenAI's route (row 2), not theirs. | n/a |

Plan 27's rubric should treat "unknown" as a red flag, so none of these is adoptable on a
subscription today.

## Summary table (for the plan 21 phase 6 terms register and the Settings warning)

| Provider | Subscription route | Officially allowed for a third-party local app? | Risk | API-key route |
|---|---|---|---|---|
| Anthropic | Stock Claude Code binary via Agent SDK, Anthropic sign-in | Yes for now (help centre, 7 Oct 2026), with a developer caveat and a history of changes | Medium | Yes |
| OpenAI | Sign in with ChatGPT, Responses API | Yes for open-source / local apps (self-serve) | Low | Yes |
| GitHub | Copilot SDK with the user's GitHub login | Yes (documented SDK) | Low | BYOK |
| Google | Gemini CLI / Antigravity OAuth | **No** (prohibited, enforced) | High | Yes (paid key) |
| Cursor / xAI / Mistral | — | Not shown | Medium–High | Yes |

## Options

**A. Keep subscription sign-in as the default for Claude; allow subscription routes only where the
vendor documents them (Anthropic as today, OpenAI SIWC, Copilot SDK); API key only for everyone
else.** Keeps the README promise. Requires: the provider-terms register in Settings (21 phase 6),
a visible note on the Claude sign-in screen, and a remote kill-switch per route (21 risks) so a
policy change can be followed without a release.

**B. Same as A, plus a first-class Claude API-key mode now** (Console key, entered in Settings,
stored in the keychain via Q20; the bridge passes it to the stock binary). Subscription stays the
default; API key is a one-click fallback if Anthropic changes course again. Max users can point it
at their included monthly API credits.

**C. Switch the Claude default to API key**, subscription as an advanced opt-in. Most conservative
reading of "developers … using the Agent SDK should use API key authentication", but breaks the
standing constraint (a recorded decision) and the README's pitch, and adds a cost for every user.

**D. Ask Anthropic first.** Use the "contact sales" link on the legal page to get written
confirmation that an open-source, local, single-user app driving the unmodified binary via the
Agent SDK, with Anthropic's own sign-in, is within the carve-out. Can be combined with A or B.

**E. Defer all non-Claude subscription routes**, ship other brains on API keys only. Simplest; gives
up the low-risk OpenAI and Copilot routes.

## Recommendation

**B + D**, provider by provider:

1. **Anthropic:** keep subscription sign-in as the default (no change to the standing constraint),
   and add a Claude **API-key mode** as a supported fallback (fits Q20/Q22; small, since the
   binary already honours `ANTHROPIC_API_KEY`). Keep every B2 condition: stock binary, never touch
   credentials, never "Claude Code" in the product name. Ask Anthropic for written confirmation
   (option D) and record the answer here.
2. **OpenAI:** plan 22 should target **Sign in with ChatGPT + Responses API** through the Q21
   adapter, not the Codex CLI's login. Follow the SIWC terms (local token storage, "Manage usage"
   link, consent before background tasks, privacy notice).
3. **GitHub Copilot:** proceed with plan 23 on the Copilot SDK; one GitHub login per person.
4. **Google:** **API key only.** Drop plan 24's Track B unless Google publishes a third-party route.
5. **Plan 27 candidates:** API key only until a vendor documents subscription use; re-check before
   any adapter is built.
6. Build the **terms register** (21 phase 6) from the summary table above, with the date checked,
   and show the risk line in Settings before a user enables a subscription brain.
7. **Re-check** this ADR before each release and whenever a vendor announces changes.

Why: the vendors' own documents now separate cleanly into "documented" (Anthropic for now,
OpenAI SIWC, Copilot SDK) and "prohibited" (Google). Following that split keeps users' accounts
safe. The only real exposure is Anthropic, whose rules moved three times this year; an API-key
fallback costs little and means a future change becomes a settings switch, not an outage.

## Decision to make

For each row, pick: **subscription allowed**, **API key only**, or **defer**.

- Anthropic: subscription default + API-key fallback (B) / subscription only (A) / API key default (C); and whether to contact Anthropic (D).
- OpenAI: SIWC / API key only / defer.
- GitHub Copilot: Copilot SDK login / BYOK only / defer.
- Google: API key only (recommended) / defer.
- Others: API key only (recommended) / defer.

## Consequences

- Q41 (licence blockers): B2 is resolved by the Anthropic line of the decision.
- Q16–Q18: no change needed; the brain interface already separates auth mode (`status().authMode`).
- Q20/Q22: if B is chosen, the Claude API key joins the keychain migration.
- Q21: if OpenAI SIWC is chosen, the OpenAI profile needs an SIWC auth option next to API keys
  (a new task, after Q21).
- Plan 24: Track B dropped if Google is "API key only".

## Sources (checked 2026-10-23)

Anthropic
- Claude Code docs, Legal and compliance (Authentication and credential use; Can customers offer Claude Code in their products?): https://code.claude.com/docs/en/legal-and-compliance
- Claude Help Centre, "Use the Claude Agent SDK with your Claude plan" (updates 15 June and 7 Oct 2026): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude Help Centre, "Monthly API credits for Max and Team plans": https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
- Third-party timeline (secondhand, used only for the April/May steps): https://www.betterclaw.io/blog/openclaw-anthropic-subscription-ban ; https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use

OpenAI
- Sign in with ChatGPT Terms: https://openai.com/policies/sign-in-with-chatgpt-terms/
- SIWC quickstart (eligibility, Responses API scopes): https://developers.openai.com/siwc/quickstart
- Cookbook, "Integrating Sign in with ChatGPT in your Opensource App" (28 Sep 2026): https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- ChatGPT docs, What's new 28 Sep–2 Oct 2026: https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026
- The New Stack, DevDay announcement (29 Sep 2026): https://thenewstack.io/sign-in-with-chatgpt/

GitHub
- Copilot SDK README (GA, auth methods, billing, MIT): https://github.com/github/copilot-sdk (read via https://cdn.jsdelivr.net/gh/github/copilot-sdk@main/README.md)
- GitHub Terms for Additional Products and Features (effective 27 Aug 2026): https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- GitHub Terms of Service (effective 27 Apr 2026; sections B.3, H, J): https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Copilot premium requests (legacy billing after 1 June 2026): https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests

Google
- Gemini CLI, License, Terms of Service and Privacy Notices (updated 10 Apr 2026): https://www.geminicli.com/docs/resources/tos-privacy
- Google Antigravity Additional Terms of Service, section 6: https://antigravity.google/terms/
- gemini-cli Discussion #20632, "Addressing Antigravity Bans & Reinstating Access" (27 Feb 2026): https://github.com/google-gemini/gemini-cli/discussions/20632
- gemini-cli Discussion #22970, "Service update: mitigating abuse and prioritizing traffic" (18 Mar 2026): https://github.com/google-gemini/gemini-cli/discussions/22970
- gemini-cli Discussion #27274, "Transitioning Gemini CLI to Antigravity CLI" (19 May 2026): https://github.com/google-gemini/gemini-cli/discussions/27274

Others
- Cursor forum, "Inquiry regarding official API or commercial license…" (10 Jul 2026): https://forum.cursor.com/t/inquiry-regarding-official-api-or-commercial-license-for-using-cursors-engine-as-a-backend-component/165063/5
- The New Stack, "The X Subscription" (13 Oct 2026): https://thenewstack.io/x-subscription-cursor-pricing/

Not reachable from this run (re-check by hand): OpenAI's open-source SIWC guide
(https://developers.openai.com/siwc/token-sharing-open-source/sign-in), OpenAI help article
20001410, and the Copilot SDK "Usage and billing" page.
