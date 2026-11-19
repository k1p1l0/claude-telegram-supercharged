---
name: daemon
description: Manage the Telegram daemon lifecycle — start, stop, restart, check status, tail logs. Use when the user says "start the bot", "stop the daemon", "restart telegram", "daemon status", "show bot logs", or "is the bot running".
user-invocable: true
allowed-tools:
  - Bash(launchctl *)
  - Bash(systemctl --user *)
  - Bash(uname *)
  - Bash(ps *)
  - Bash(tail *)
  - Bash(cat *)
  - Bash(grep *)
  - Bash(strings *)
  - Bash(kill *)
  - Read
---

# /telegram:daemon — Telegram Daemon Lifecycle Manager

Full lifecycle management for the Telegram bot daemon (launchd or systemd + supervisor + Claude).

## Platform

Run `uname -s` first:

- **Darwin** (macOS): the daemon is the launchd agent `~/Library/LaunchAgents/com.user.claude-telegram.plist`. Use the **macOS** commands below.
- **Linux**: the daemon is the systemd user unit `claude-telegram` (`~/.config/systemd/user/claude-telegram.service`). Use the **Linux** commands below.

If the plist (macOS) or the unit (Linux) doesn't exist, say so and point to the "Always-on" section of the README for that platform instead of running anything.

## Arguments — dispatch on first word

### `start` (default if no args and daemon is not running)

macOS:

```bash
launchctl load ~/Library/LaunchAgents/com.user.claude-telegram.plist 2>&1
```

If it fails with "already loaded", report that the daemon is already running.

Linux:

```bash
systemctl --user start claude-telegram
```

After starting, wait 5 seconds, then run the status check to confirm it started.

### `stop`

macOS:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.claude-telegram.plist 2>&1
```

Linux:

```bash
systemctl --user stop claude-telegram
```

Wait 3 seconds, verify all processes are gone:

```bash
ps aux | grep -E "channels.*telegram" | grep -v grep
```

Report success or if orphan processes remain.

### `restart`

macOS: unload then load:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.claude-telegram.plist 2>/dev/null
sleep 2
launchctl load ~/Library/LaunchAgents/com.user.claude-telegram.plist
```

Linux:

```bash
systemctl --user restart claude-telegram
```

Wait 10 seconds, then run full status check.

### `status` (default if no args and daemon IS running)

Run the full monitor check — same as /telegram:monitor:

1. Process status (supervisor, expect, claude, MCP server, and caffeinate on macOS)
2. Service state: launchd loaded/not (macOS) or `systemctl --user is-active claude-telegram` (Linux)
3. Remote control URL
4. Lock file
5. Last 5 log lines

### `logs`

Tail the last 30 lines of supervisor stderr:

```bash
tail -30 ~/.claude/channels/telegram/data/supervisor-stderr.log
```

### `stdout`

Tail the last 30 lines of daemon's Claude output:

```bash
tail -30 ~/.claude/channels/telegram/data/supervisor-stdout.log
```

### `url`

Just show the remote control URL:

```bash
cat ~/.claude/channels/telegram/data/supervisor-stdout.log | strings | grep "session_" | tail -1
```

### No args

Check if daemon is running. If running → show status. If not running → ask if user wants to start it.

## Important notes

- The `launchctl load/unload` commands may fail with "Input/output error" — this usually means the service is already in the requested state. Handle gracefully.
- On Linux, `systemctl --user` needs the user's bus. After a plain `su` or `sudo -u` it fails with "Failed to connect to user scope bus"; run `export XDG_RUNTIME_DIR=/run/user/$(id -u)` first, or log in as the user directly.
- After start/restart, always verify the daemon actually started by checking processes.
- The plist path is always `~/Library/LaunchAgents/com.user.claude-telegram.plist`; the unit is always `claude-telegram` (user scope).
- Show the remote control URL after every start/restart so the user can monitor.
