---
name: update
description: Update the Telegram Supercharged plugin to the latest version from GitHub. Use when the statusline shows "⬆ Supercharged", or when the user says "update telegram plugin", "update supercharged", or "telegram:update".
---

# Update Telegram Supercharged Plugin

Pull the latest version from GitHub and apply it to the installed plugin.

## Process

### Step 1: Check current state

```bash
# Get local file hash (Claude Code runs the newest version directory in the cache)
CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
LOCAL_FILE="$CACHE/$(ls "$CACHE" | sort -V | tail -1)/server.ts"
LOCAL_HASH=$(shasum -a 256 "$LOCAL_FILE" 2>/dev/null | cut -c1-12)
echo "Local hash: $LOCAL_HASH"
```

### Step 2: Check for updates

```bash
# Read cache if available
cat ~/.claude/cache/telegram-update-check.json 2>/dev/null || echo '{"update_available":"unknown"}'
```

### Step 3: Pull latest from GitHub

If update is available (or unknown), pull the latest:

```bash
cd /tmp
if [ -d "claude-telegram-supercharged" ]; then
  cd claude-telegram-supercharged && git pull
else
  git clone https://github.com/k1p1l0/claude-telegram-supercharged.git
  cd claude-telegram-supercharged
fi
```

### Step 4: Compare versions

```bash
REMOTE_HASH=$(shasum -a 256 /tmp/claude-telegram-supercharged/server.ts 2>/dev/null | cut -c1-12)
echo "Remote hash: $REMOTE_HASH"
echo "Local hash: $LOCAL_HASH"
```

If hashes match, report "Already up to date" and exit.

### Step 5: Show what changed

```bash
cd /tmp/claude-telegram-supercharged && git log --oneline -10
```

Show the user the recent commits and ask for confirmation before updating.

### Step 6: Apply update

After user confirms, run the installer from the checkout. It copies `server.ts` and the skills into the cache directory Claude Code actually runs, keeps the official `package.json` (its start script keeps `bun install` output off the MCP channel), and installs the supervisor, the daemon wrapper and the Agentic Mode hook:

```bash
TELEGRAM_SUPERCHARGED_DIR=/tmp/claude-telegram-supercharged bash /tmp/claude-telegram-supercharged/install.sh
```

Then restart: a new Claude Code session, or for the daemon `launchctl bootout` + `launchctl bootstrap` (a soft restart doesn't reload the supervisor).

### Step 7: Clear update cache

```bash
rm -f ~/.claude/cache/telegram-update-check.json
```

### Step 8: Report success

Display:
```
╔═══════════════════════════════════════════════════════════╗
║  Supercharged Updated!                                    ║
╚═══════════════════════════════════════════════════════════╝

⚠️  Restart the Telegram daemon to apply changes:
   /telegram:daemon restart

   Or write restart signal:
   echo "restart" > ~/.claude/channels/telegram/data/restart.signal
```

## Important Notes

- Always show the user what changed before applying
- Ask for confirmation before overwriting files
- Clear the update cache after successful update so the statusline indicator disappears
- Remind user to restart the daemon after updating
