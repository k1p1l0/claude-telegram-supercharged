---
name: context
description: Transfer context from the current Claude Code terminal session to the Telegram bot session. Use when the user says "send this to telegram", "transfer context", "telegram:context", "teleport to telegram", or wants the Telegram bot to continue work from this session.
---

# Context Transfer to Telegram Bot

Transfer the current conversation context to the Telegram bot session so it can continue the work.

## Process

### Step 1: Gather context

Summarize the current conversation into a structured context handoff. Include:

1. **What we were working on** — the main task/topic
2. **Key decisions made** — important choices, approaches taken
3. **Current state** — what's done, what's pending
4. **Files changed** — any relevant file paths
5. **Action items** — what the Telegram bot should do next (if any)

Keep it concise — under 2000 characters. The bot has limited context.

### Step 2: Write to bot memory

Append the context to the bot's memory file so it persists across restarts:

```bash
MEMORY_FILE="$HOME/.claude/channels/telegram/data/memory.md"
```

Append a new section with timestamp:

```markdown
## YYYY-MM-DD HH:MM — Context Transfer
**Chat 305120844**: [summary here]
```

**IMPORTANT:** Do not overwrite the file — APPEND to it. Read existing content first, then write old + new.

### Step 3: Send as Telegram message

Send the context as a direct message to the user's Telegram chat so the bot sees it immediately in the current session:

```bash
BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$HOME/.claude/channels/telegram/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")

# If not in .env, check environment
if [ -z "$BOT_TOKEN" ]; then
  BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
fi

CHAT_ID="305120844"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"text\": \"📋 *Context transfer from CLI session*\n\n${CONTEXT_TEXT}\",
    \"parse_mode\": \"Markdown\"
  }"
```

### Step 4: Confirm

Tell the user:
```
Context transferred to Telegram bot:
✓ Written to memory (persists across restarts)
✓ Sent as message (bot sees it now)

Switch to Telegram and continue the conversation there.
```

## Context Format Template

Use this format for the transferred context:

```
📋 CONTEXT TRANSFER FROM CLI

🔧 Working on: [main task]
📁 Project: [project name/path]

Key context:
- [point 1]
- [point 2]
- [point 3]

Current state: [what's done / what's pending]

Next steps: [what to do next, if any]
```

## Important Notes

- Always ask the user what specific context they want to transfer — don't dump everything
- Keep it under 2000 chars (Telegram message limit considerations)
- Escape special Markdown characters in the curl message
- The bot token is in `~/.claude/channels/telegram/.env` as `TELEGRAM_BOT_TOKEN`
- The user's chat_id is `305120844`
- If the user says "teleport everything" — summarize the full conversation
- If the user says "teleport this" — only transfer the most recent topic
