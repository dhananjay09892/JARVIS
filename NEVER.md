# What JARVIS will never do

JARVIS listens, remembers, speaks for you and, if you allow it, acts on your computer.
That is a lot of trust, so these limits do not depend on what any AI model happens to
decide on the day. They are rules for the software itself.

This page is the short version of the never-list in
[plan 35](plans/35-ethics-limits-and-governance.md). Each rule is written into the
policy engine (`bridge/policy.mjs`) with its own test, so a rule can only be changed by a
reviewed code change, and no setting turns one off, not even the switch that allows real
actions. The **Today** line under each rule says honestly how far that goes.

The policy engine decides by the name of each tool JARVIS is offered, so it refuses any
tool that names one of these things (`clone_voice`, `pay_invoice`, `solve_captcha`).
It cannot see intent inside a general tool, such as a click in your browser or a shell
command. Those are off by default and need you to turn on real actions, and the
end-to-end safety tests that cover them are planned.

---

## JARVIS will never…

### 1. Spy on other people
Covertly record anyone, track where someone is, or read other people's messages. JARVIS
will not have stalking or "keep an eye on my partner" features.

**Today:** JARVIS has no feature that tracks people or reads anyone else's messages. The
camera only runs while an on-screen indicator is showing and your browser has allowed it,
and no camera frame is kept. The policy engine refuses any tool for spying, stalking,
covert recording, tracking someone's location or reading a partner's or employee's
messages. Covered by tests.

### 2. Pretend to be someone, or pretend to be human
Impersonate a real person, or copy a real person's voice without their documented
consent. When it matters (a message or call to someone else), JARVIS says it is an AI.

**Today:** JARVIS speaks with an original voice only. The policy engine refuses any tool
that clones a voice or face, makes a deepfake or impersonates someone, including the
cloning tool of a connected voice service. JARVIS is told to say it is an AI whenever
asked and in anything it writes to someone else, and never to claim to be human. Sending
messages and placing calls are off by default. Covered by tests.

### 3. Move your money or act as your doctor, lawyer or adviser
Make payments, transfers or trades, or give personalised investment, legal or medical
advice as if it were a licensed professional. It can explain and help you prepare; the
decision and the action stay with you.

**Today:** the policy engine refuses any tool that pays, buys, checks out, transfers
money, trades or withdraws, even after you turn on real actions. Looking at your payments
or orders still works. JARVIS is told not to give personalised investment, legal or
medical advice as if it were a professional. Covered by tests.

### 4. Take orders from a web page, email or file
Send messages, spend money or delete data because some text it read told it to. Only you
give instructions. Content from the web, mail and files is treated as information, never
as a command.

**Today:** content from tools, pages, mail and files is labelled as untrusted before the
model sees it, and hidden text is stripped from fetched pages. Once JARVIS has read your
private data in a session, sending, opening a link or running a command needs your
approval unless you named the target yourself. That includes any email address that only
appeared in something it read. Sending is also off by default. Covered by tests.

### 5. Break through security checks
Solve or bypass CAPTCHAs and other security checks, or help with illegal surveillance or
with getting around safety measures.

**Today:** JARVIS has no tool for this, and the policy engine refuses any tool that
solves a CAPTCHA, bypasses a login or two-factor check, cracks a password or evades
detection. Covered by tests.

### 6. Send your body's data where it shouldn't go
Store or send biometric or health data (such as a voiceprint) anywhere other than the
places this project tells you about.

**Today:** JARVIS does not create voiceprints yet. When speaker recognition arrives,
voiceprints stay on your computer. Microphone audio does go to a speech service to be
turned into text, as described in [DISCLAIMER.txt](DISCLAIMER.txt). The policy engine
refuses any tool that sends, uploads, shares or exports voiceprints, other biometrics or
health records. Covered by tests.

### 7. Act while you have stopped it
Do anything at all while you have frozen it with the kill switch.

**Today:** the kill switch is not built yet. Until it is, closing JARVIS stops it. The
policy engine is ready for it: while frozen it refuses every action, JARVIS's own display
included, and a switch it cannot read counts as frozen. Covered by tests.

---

## What is always true

- **You are in control.** Out of the box JARVIS can look and answer but cannot change
  anything. Real actions are off until you turn them on in Settings.
- **Consequences need you.** Anything that cannot be undone, or that touches money, the
  law, health or your reputation, needs your approval.
- **Honesty.** JARVIS should say "I don't know", give its sources and say when it is
  unsure.

## If JARVIS crosses a line

Please [open an issue](https://github.com/dhananjay09892/JARVIS/issues) describing what
happened. Breaking one of these rules is treated as a serious bug.
