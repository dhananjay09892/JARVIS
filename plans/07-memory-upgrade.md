# 07 · Memory upgrade

**Status:** Done (basic) · **Priority:** Later · **Effort:** 2–4 days

## Today
Local SQLite in `%LOCALAPPDATA%\JARVIS\memory` (`bridge/memory.mjs`, `memory-tools.mjs`,
`journal.mjs`, `conversation.mjs`): saved memories, journal, conversations, keyword recall,
view/edit/forget from the MEMORY panel, optional retention. Memory never grants permission
(tested). This already covers the "can view, edit and delete" requirement.

## Gap
Keyword recall misses paraphrases ("my wife's birthday" vs. "Sam's birthday"). Memories are
saved only when asked.

## Steps
1. **Local semantic search.** Small embedding model in the bridge (same ONNX runtime as
   plan 01), vectors stored in SQLite; hybrid keyword + vector ranking.
2. **Suggested memories.** After a turn, propose "remember this?" cards; save only after the
   user approves. No silent writes.
3. **Per-speaker scoping** after plan 01.
4. **Summaries** of old conversations to keep prompts small (still shown and editable).
5. Do not adopt Mem0/Letta unless local-only operation is guaranteed.

## Done when
Paraphrased recall works on a test set; suggestions need a click; deleting a memory deletes
its vector too.
