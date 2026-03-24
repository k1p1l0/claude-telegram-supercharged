---
name: calendar
description: Google Calendar integration — check schedule, create events, daily briefings, proactive reminders. Triggers on "what's on my calendar", "add to calendar", "schedule a meeting", "when am I free", "daily briefing", or any calendar-related request.
user-invocable: true
allowed-tools:
  - Bash(npx *)
  - Read
  - Write
  - mcp__google-calendar__list-events
  - mcp__google-calendar__create-event
  - mcp__google-calendar__update-event
  - mcp__google-calendar__delete-event
  - mcp__google-calendar__find-free-time
  - mcp__google-calendar__manage-accounts
---

# Google Calendar Integration

Manage your Google Calendar from Telegram — check schedule, create events, get daily briefings, and receive proactive reminders.

## Available MCP Tools

Try loading these tools via ToolSearch first:
1. `mcp__google-calendar__list-events` — list upcoming events
2. `mcp__google-calendar__create-event` — create new events
3. `mcp__google-calendar__update-event` — modify events
4. `mcp__google-calendar__delete-event` — remove events
5. `mcp__google-calendar__find-free-time` — check availability

If tools aren't available, the Google Calendar MCP server may not be connected. Tell the user to run:
```
GOOGLE_OAUTH_CREDENTIALS="~/.claude/scripts/gcp-oauth.keys.json" npx -y @cocal/google-calendar-mcp auth
```

## Use Cases

### Check today's schedule
When user asks "what's on my calendar" or "what do I have today":
1. Call `list-events` with today's date range
2. Format as a clean summary with times, titles, locations
3. Reply via Telegram

### Create an event
When user says "add to calendar" or "schedule X":
1. Parse the natural language for: title, date, time, duration, location
2. If anything is ambiguous (e.g. "next Thursday"), ASK the user to confirm before creating
3. Call `create-event` with structured data
4. Confirm what was created via Telegram reply

### Daily briefing
When user asks for "daily briefing" or "morning summary":
1. List today's events
2. List tomorrow's events
3. Format as a concise briefing
4. Can be combined with the `schedule` tool to auto-send every morning

### Find free time
When user asks "when am I free" or "find a slot":
1. Call `find-free-time` with the requested date range
2. Show available slots

## Date/Time Handling

- Always use ISO 8601 format for API calls
- Detect user's timezone from context or default to Europe/Lisbon
- For relative dates ("tomorrow", "next Monday"), calculate the exact date
- For ambiguous times ("afternoon"), ask for clarification

## Proactive Calendar Features

The daemon can use the `schedule` tool to set up recurring calendar checks:
- **Morning briefing**: Schedule an "every" job at 86400000ms (24h) that checks and sends today's events
- **Meeting reminders**: After listing events, create schedule reminders for important ones

## Response Format

For event listings:
```
📅 Today's schedule:

09:00 — Team standup (Google Meet)
12:00 — Lunch with Vika & Artem at Café Utro Tempo
15:00 — Product review (Zoom)
18:00 — Free evening
```

For event creation:
```
✅ Added to calendar:
April 3rd, 12:00 — Vika's birthday at Café Utro Tempo
```
