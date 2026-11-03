---
id: morning-briefing
name: Morning Briefing
description: "Your day at 7: calendar, weather, mail worth reading."
icon: sun
mode: scheduled
schedule: "0 7 * * 1-5"
tools: [calendar_list, weather_today, mail_search]
connectors:
  gcalendar: read
  gmail: read
memory: read
budget:
  maxToolCalls: 25
  maxMinutes: 5
  maxCostUsd: 0.2
output: alert
createdBy: builtin
---
Write a short spoken briefing. Lead with anything that changes the plan for today.
