---
name: monitor
description: Monitor the Telegram daemon — check if it's alive, view recent logs, find the remote control URL, and diagnose MCP server issues. Use when the user asks "is the daemon running", "check the bot", "show daemon logs", "monitor telegram", or "what's happening with the bot".
user-invocable: true
allowed-tools:
  - Bash(ps *)
  - Bash(tail *)
  - Bash(cat *)
  - Bash(grep *)
  - Bash(launchctl *)
  - Bash(systemctl --user *)
  - Bash(uname *)
  - Bash(strings *)
  - Bash(head *)
  - Bash(wc *)
  - Read
---

# /telegram:monitor — Telegram Daemon Monitor

Shows the health and status of the Telegram daemon at a glance.

## What to check

Run these checks and present a clean summary:

### 1. Process status

```bash
ps aux | grep -E "telegram-supervisor|channels.*telegram|expect.*daemon|caffeinate.*supervisor|bun server.ts" | grep -v grep
```

Report:
- **Supervisor** (bun telegram-supervisor.ts) — PID, uptime
- **Expect wrapper** — PID
- **Claude bot** (claude --channels ...) — PID, TTY, CPU/memory
- **MCP server** (bun server.ts) — PID (if missing, the Telegram plugin didn't start)
- **Caffeinate** — running or not (macOS only; Linux has no caffeinate step)

If no processes found, report "Daemon is NOT running."

### 2. Service manager status

Check `uname -s`. On macOS (Darwin):

```bash
launchctl list | grep claude-telegram
```

Report loaded/not loaded.

On Linux:

```bash
systemctl --user is-active claude-telegram; systemctl --user is-enabled claude-telegram
```

Report active/inactive/failed and enabled/disabled. Show the row as "Systemd" instead of "Launchd" and drop the Caffeinate row.

### 3. Recent supervisor logs

```bash
tail -10 ~/.claude/channels/telegram/data/supervisor-stderr.log
```

Show the last few log entries — look for crashes, restarts, orphan cleanup, or errors.

### 4. MCP server health

```bash
cat ~/.claude/channels/telegram/data/supervisor-stdout.log | strings | grep -i "MCP server" | tail -5
```

Report any "MCP server needs a..." or "MCP servers fail" messages.

### 5. Remote control URL

```bash
cat ~/.claude/channels/telegram/data/supervisor-stdout.log | strings | grep "session_" | tail -1
```

Extract and show the `https://claude.ai/code/session_XXX` URL so the user can watch the daemon live in the browser.

### 6. Lock file

```bash
cat ~/.claude/channels/telegram/data/telegram.lock 2>/dev/null
```

Show the PID in the lock file and whether that process is still alive.

## Output format

Present as a clean status dashboard:

```
## Telegram Daemon Status

| Component        | Status  | PID   | Details          |
|------------------|---------|-------|------------------|
| Supervisor       | ✅ alive | 12345 | uptime: 2h       |
| Claude bot       | ✅ alive | 12346 | CPU: 0.5%, 300MB |
| MCP server       | ✅ alive | 12347 |                  |
| Caffeinate       | ✅ alive | 12348 |                  |
| Launchd          | ✅ loaded|       |                  |

**Remote control:** https://claude.ai/code/session_XXX
**Lock file:** PID 12346 (alive)

### Recent logs
[last 5 log entries]
```

## Arguments

- No args — full status check (default)
- `logs` — show last 30 lines of supervisor stderr
- `stdout` — show last 30 lines of stdout (Claude's output)
- `restart` — show the restart command for the user to run
- `url` — just show the remote control URL
