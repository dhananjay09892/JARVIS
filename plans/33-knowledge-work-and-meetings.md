# 33 · Knowledge work: documents, meetings, research, writing

**Status:** Pending · **Priority:** P1/P2 · **Effort:** 4–6 weeks · **Depends on:** 07 (semantic memory), 08 (connectors), 13 (missions), 14 (context), 15

## End state
JARVIS is your chief of staff at work: he attends meetings (with consent), writes the minutes,
tracks action items, prepares you before calls, finds anything in your files and mail, drafts
documents in your voice, researches with cited sources, and keeps projects moving through
background missions.

## Features
1. **Personal knowledge base (RAG):** index chosen folders, mail, notes, calendar, chats with local embeddings (07); answers cite file/page/message; respects permissions per source; "what did Sam say about pricing in March?"
2. **Meeting assistant:** consent banner ("recording and transcribing"), transcription with speaker labels (01 diarization), summary, decisions, action items with owners/dates, follow-up drafts (approve before send), calendar updates. Works from the PC (system audio) or a phone satellite (03).
3. **Pre-meeting briefs:** attendees, last interactions, open items, relevant docs, 3 talking points; delivered 10 minutes before (12).
4. **Document drafting in your voice:** style profile from approved samples; outline → draft → revise loop; track changes, never auto-send.
5. **Research missions (13):** multi-source web/docs research with citations, contradictions flagged, confidence notes; saved to a research folder.
6. **Inbox triage:** summarise, prioritise, draft replies, unsubscribe suggestions, "waiting on" tracker; read-only until the user enables drafts.
7. **Task and project tracking:** link action items to Jira/Linear/GitHub/Notion/Todoist via MCP; weekly project digest.
8. **Dev-focused pack (existing workspace tools):** PR summaries, CI watch, "build failed" alerts (12), commit message help, runbook search.
9. **Learning/study mode:** summarise papers, quiz you, spaced repetition from your notes.
10. **Presentation and report helpers:** slide outlines, charts from data files, formatted exports.

## Phases
1. **Index and cite (1–2 w):** indexer, permissions per source, citation format, evaluation set.
2. **Meeting capture and minutes (1–2 w):** consent UX, legal notice, storage rules, redaction.
3. **Briefs and follow-ups (1 w).**
4. **Writing style and drafting (1 w).**
5. **Research mission template (1 w)** with source checking.
6. **Task-system integrations (1 w)** per connector.
7. **Study mode and exports (1 w).**

## Safety and law
- Recording laws vary (one-party vs. all-party consent): meeting capture shows a notice, asks participants when required, and is off by default.
- Confidential data: per-source allow-list, no cloud model on restricted folders unless allowed, corporate policy mode for managed devices.
- Hallucination control: every claim from the index cites a source; "I can't find that" is a valid answer.

## Metrics
Retrieval hit rate on a held-out question set ≥ 90 %; citation correctness ≥ 98 %; minutes accuracy (action items captured) ≥ 90 %; time saved per week (self-reported); zero out-of-scope source access.

## Done when
A user asks about a decision from a past meeting and gets a correct, cited answer; meeting minutes appear within a minute of the call ending with action items awaiting approval.
