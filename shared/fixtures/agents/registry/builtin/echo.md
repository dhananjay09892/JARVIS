---
id: echo
name: Echo
description: A test agent that repeats its goal back. Ships only in test fixtures.
icon: repeat
mode: on-demand
tools:
  - Read
  - mcp__jarvis_tasks__task_status
connectors:
  fake: read
memory: none
review: false
output: report
createdBy: builtin
---

Repeat the goal you are given, word for word, and stop.
