# 31 · Money and life admin (read-only first)

**Status:** Pending · **Priority:** Later · **Effort:** 3–5 weeks · **Depends on:** 08, 15, 12, 33

## End state
JARVIS keeps on top of bills, subscriptions, receipts, deadlines, renewals, taxes paperwork and
travel logistics: "what's due this week?", "which subscriptions did I forget?", "file this
receipt", "remind me before the insurance renews", "draft the dispute email". He can read and
organise; he does **not** move money or trade.

## Hard boundaries (product rules)
- No executing trades, transfers or payments by JARVIS. He may prepare, never confirm.
- No personalised investment, tax or legal advice: he can summarise facts and explain concepts, and says he is not a licensed advisor.
- Financial credentials are never typed or stored by JARVIS; connections use read-only OAuth / aggregator tokens in the OS keychain.
- Financial data stays local; model sees summaries or redacted fields (08 data minimisation).

## Features
1. **Bills and renewals calendar:** extracted from email/PDFs (with consent), due dates, amounts, autopay status; alerts via 12 with escalation near deadlines.
2. **Receipts and documents:** photo/email → structured record (vendor, date, total, category), filed to a local folder/vault; search by voice ("find the laptop warranty").
3. **Subscriptions audit:** detect recurring charges, show monthly total, highlight price increases and duplicates.
4. **Budget awareness (read-only):** categories, month-to-date vs. plan, no judgement; spoken summaries on request.
5. **Forms and admin drafts:** letters, disputes, cancellations; **draft then approve** before sending (15, 20).
6. **Travel logistics:** itineraries from email, check-in reminders, document expiry (passport, visa) alerts, packing lists (30).
7. **Warranty/insurance/vehicle tracker:** service due dates, renewal windows.
8. **Tax-season helper:** collects documents into a folder, checklist by jurisdiction; no filing.
9. **Scam shield:** warns when a message/call/email matches known scam patterns; "this looks like phishing" explanations; never clicks links.

## Phases
1. **Document vault and receipt pipeline (1 w)** (OCR via 11/vision, local storage, encryption).
2. **Bills/renewals extraction (1 w)** from mail connector with approval for each new source.
3. **Subscriptions and budget read-only views (1 w)** via aggregator or CSV import (privacy-first option).
4. **Draft-and-approve actions (4 d).**
5. **Travel and expiry tracker (4 d).**
6. **Scam shield (4 d).**

## Metrics
Extraction accuracy (amount/date) ≥ 95 % on a test set; missed-deadline rate; false scam alerts per month; zero unauthorised outbound actions (policy tests).

## Risks
Wrong amounts/dates causing harm → show source and ask to confirm for anything actionable; regulatory scope of "advice" → conservative language, disclaimers, region checks; aggregator terms/costs → CSV/manual import as base path.

## Done when
JARVIS lists next month's obligations from the user's own documents with sources, and every outbound action is a draft that waits for approval.
