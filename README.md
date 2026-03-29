<div align="center">

<img src="./banner.jpg" alt="Claude Telegram Supercharged" width="100%" />

<h3>The official Claude Code Telegram plugin is good. This one is better.</h3>

<br />

<a href="https://github.com/k1p1l0/claude-telegram-supercharged/blob/main/LICENSE"><img src="https://img.shields.io/github/license/k1p1l0/claude-telegram-supercharged?style=flat" alt="License" /></a>
<a href="https://github.com/k1p1l0/claude-telegram-supercharged/stargazers"><img src="https://img.shields.io/github/stars/k1p1l0/claude-telegram-supercharged?style=flat" alt="GitHub Stars" /></a>
<a href="https://github.com/k1p1l0/claude-telegram-supercharged/commits/main"><img src="https://img.shields.io/github/last-commit/k1p1l0/claude-telegram-supercharged?style=flat" alt="Last Commit" /></a>

<br />

<a href="#getting-started">Getting Started</a>
<span>&nbsp;&nbsp;&bull;&nbsp;&nbsp;</span>
<a href="#features">Features</a>
<span>&nbsp;&nbsp;&bull;&nbsp;&nbsp;</span>
<a href="#tools-exposed-to-the-assistant">Tools Reference</a>
<span>&nbsp;&nbsp;&bull;&nbsp;&nbsp;</span>
<a href="#contributing">Contributing</a>

<br />
<hr />
</div>

## Claude Telegram Supercharged

Drop-in upgrade for the [official Claude Code Telegram plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram). Install once, get 15+ features the official plugin doesn't have. Built on top of the [official plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) -- everything works, just better.

2 minutes to install. Zero config. Your existing bot and pairing keep working.

## Features

### Voice & Audio

| Feature | What it does |
| --- | --- |
| **🎤 Voice Messages** | Talk to Claude. Provider fallback chain: OpenAI Whisper → Groq → Deepgram → local whisper-cli. Works from your phone while walking. |
| **🔊 Voice Replies (TTS)** | Claude replies with voice messages via ElevenLabs TTS. OGG/Opus native format. Auto-fallback to audio file if voice is restricted. |
| **🎤 Auto-transcribe** | ALL voice messages in group chats are transcribed, even without mentioning the bot. Configurable via `autoTranscribe`. |

### Messages & Media

| Feature | What it does |
| --- | --- |
| **📨 Forwarded Messages** | Full forwarding context preserved -- Claude sees who originally sent it and from which chat/channel. |
| **📦 Message Batching** | Forward 20+ messages at once -- collected into one batch (5s debounce), auto-summarized instantly, then Claude responds to the whole conversation in one reply. |
| **📄 Document Support** | Send PDFs, DOCX, CSV, TXT, JSON -- Claude downloads, reads, and summarizes. 10MB file size limit. |
| **🎨 MarkdownV2 Auto-escaping** | Special characters auto-escaped server-side -- Claude writes natural text, no manual `\.` escaping needed. |
| **😎 Sticker & GIF Support** | Claude sees stickers and GIFs. Static as images, animated as multi-frame collages. |
| **📰 Telegraph Instant View** | Long research (3000+ chars) published to telegra.ph as Instant View. Disabled by default -- opt-in via `TELEGRAPH_ENABLED=true`. |

### Conversations & Groups

| Feature | What it does |
| --- | --- |
| **💬 Message History** | SQLite-backed rolling store. Claude has context across restarts. `get_history` + `search_messages` tools. |
| **🧠 Conversation Memory** | `/clean` saves a summary before clearing. Memory persists across sessions. Claude never forgets. |
| **🧵 Conversation Threading** | Follows reply chains in groups, sees who said what, responds in the correct thread. Up to 3 levels deep. |
| **📋 Forum Topics** | Telegram Forum topics fully supported. Each topic isolated with persistent `thread_id`. |
| **👥 Group Pairing** | Add bot to group, mention it, get pairing code. No hunting for numeric chat IDs. |
| **🎯 Inline Buttons** | `ask_user` tool -- tappable buttons for confirmations and choices. |
| **👍 Reaction Status** | 👀 read → 🔥 working → 👍 done. Voice messages get ✍ for transcription. |

### Daemon & Infrastructure

| Feature | What it does |
| --- | --- |
| **⚡ Two-Tier Model Routing** | Configurable router: Haiku (fast, 200K), Sonnet (balanced, 1M), or Opus (deep, 1M). Set via `TELEGRAM_ROUTER_MODEL`. Complex tasks auto-escalate to Opus via subagents. |
| **🔄 Daemon Mode** | Supervisor auto-restarts Claude on crash or context reset. Memory preserved, zero downtime. |
| **🛡 Context Watchdog** | Auto-restarts when context exceeds 70% to prevent unresponsive sessions. SQLite history and memory survive restarts. |
| **🔒 Single-Instance Lock** | PID-based lock file prevents duplicate bot instances competing for Telegram updates. |
| **🖥 Daemon Management** | `/telegram:daemon start\|stop\|restart\|status\|logs` -- full lifecycle. `/telegram:monitor` for health dashboard with remote control URL. |
| **⏰ Scheduled Messages** | `schedule` tool for reminders and recurring tasks. "at" (one-shot) and "every" (interval) types. Persists across restarts. |
| **📅 Google Calendar** | Check schedule, create events, daily briefings from Telegram. Multi-account support. Proactive — Claude uses calendar context when answering. |
| **📸 Headless Screenshots** | Playwright-based page capture -- works in daemon mode where Chrome isn't available. |
| **✅ Reaction Validation** | Client-side emoji whitelist prevents cryptic Telegram API errors. |
| **🔒 Shell Injection Protection** | All subprocess calls use `spawnSync` with array args. No shell interpretation. |
| **📊 Smart Caching** | Voice/audio cached between middleware and handlers. No double downloads or transcriptions. |

## Getting Started

> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

### Prerequisites

- [Bun](https://bun.sh) -- the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

### 1. Create a bot with BotFather

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** -- the display name shown in chat headers (anything, can contain spaces)
- **Username** -- a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` -- that's the whole token, copy it including the leading number and colon.

### 2. Install the [official plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)

These are Claude Code commands -- run `claude` to start a session first.

```
/plugin install telegram@claude-plugins-official
```

### 3. Apply the supercharged version

Clone this repo and install both the supercharged server and the daemon supervisor:

```sh
git clone https://github.com/k1p1l0/claude-telegram-supercharged.git
cp claude-telegram-supercharged/server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts
mkdir -p ~/.claude/scripts
cp claude-telegram-supercharged/supervisor.ts ~/.claude/scripts/telegram-supervisor.ts
```

### 4. Give the server the token

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment -- shell takes precedence.

### 5. Relaunch with the channel flag

The server won't connect without this -- exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

Or use the **daemon supervisor** for always-on operation with auto-restart and context reset from Telegram (see [Daemon Mode](#daemon-mode)):

```sh
bun ~/.claude/scripts/telegram-supervisor.ts
```

### 6. Pair

With Claude Code running from the previous step, DM your bot on Telegram -- it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step -- Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

### 7. Lock it down

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

### Updating

> **Important:** The official plugin auto-updates and will overwrite your supercharged `server.ts`. When the bot suddenly stops working after an update, this is why.

When the official plugin updates (check for new version directories in `~/.claude/plugins/cache/claude-plugins-official/telegram/`):

```sh
cd claude-telegram-supercharged
git pull
# Find the current version (e.g. 0.0.4)
PLUGIN_VERSION=$(ls ~/.claude/plugins/cache/claude-plugins-official/telegram/ | sort -V | tail -1)
echo "Updating to version: $PLUGIN_VERSION"
cp server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/$PLUGIN_VERSION/server.ts
cp supervisor.ts ~/.claude/scripts/telegram-supervisor.ts
# Copy skills
cp -r skills/* ~/.claude/plugins/cache/claude-plugins-official/telegram/$PLUGIN_VERSION/skills/
# Copy scripts
cp scripts/claude-daemon-wrapper.exp ~/.claude/scripts/claude-daemon-wrapper.exp
```

Then restart your daemon or Claude Code session.

## Tools Exposed to the Assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading, `files` (absolute paths) for attachments, and `parse_mode` (MarkdownV2/HTML/plain, defaults to MarkdownV2). Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 🎉 😂 🤔 etc). Also used for status indicators (👀 read → 👍 done). |
| `edit_message` | Edit a message the bot previously sent. Supports `parse_mode` (MarkdownV2/HTML/plain). Useful for "working..." → result progress updates. Only works on the bot's own messages. |
| `ask_user` | Send a question with inline keyboard buttons and wait for the user's choice. Takes `chat_id`, `text`, `buttons` (array of labels), optional `parse_mode` and `timeout` (default 120s). Returns the label of the tapped button. |
| `get_history` | Retrieve recent message history from a chat. Takes `chat_id`, optional `limit` (default 50, max 200), optional `before` (unix timestamp for pagination). Returns formatted messages with timestamps, senders, and content. |
| `search_messages` | Search message history by text pattern. Takes `chat_id`, `query` (substring match), optional `limit` (default 20, max 100). Returns matching messages. |
| `clear_history` | Clear all message history for a chat. Always confirm with `ask_user` first, and call `save_memory` before clearing to preserve context. Pass `restart_context: true` to signal the supervisor daemon to restart Claude for a full context reset. |
| `save_memory` | Save a conversation summary to persistent memory. Loaded into Claude's instructions on every startup. Use before `clear_history` so context survives across sessions. |
| `create_telegraph_page` | Publish long-form content to Telegraph (telegra.ph) and return a URL. Telegram renders it as Instant View -- a native article reader. Takes `title`, `content` (Markdown), optional `author_name` and `author_url`. Auto-creates Telegraph account on first use. |

### Inbound Events

| Event | Description |
| --- | --- |
| Text message | Forwarded to Claude as a channel notification with `chat_id`, `message_id`, `user`, `ts`. |
| Photo | Downloaded to inbox, path included in notification so Claude can `Read` it. |
| Emoji reaction | When a user reacts to a bot message, Claude receives a notification with `event_type: "reaction"`, the emoji, and the `message_id`. Use as lightweight feedback. |
| Voice message | Downloaded to inbox as `.ogg`, auto-transcribed by the server if whisper is installed. Transcription replaces "(voice message)" in the notification text. Audio path still included as `audio_path`. |
| Audio file | Forwarded audio files (`.mp3`, etc.) downloaded to inbox, path included as `audio_path`. |
| Sticker | Static `.webp` passed directly as `image_path`. Animated (`.tgs`) and video (`.webm`) stickers converted to multi-frame collage. Emoji and pack name included in text. |
| GIF / Animation | Downloaded and converted to a multi-frame horizontal collage so Claude can see the animation content. |

Inbound messages trigger a typing indicator automatically -- Telegram shows "botname is typing..." while the assistant works on a response.

## Voice & Audio Messages

Voice messages and audio files are downloaded to `~/.claude/channels/telegram/inbox/` and automatically transcribed by the server. The transcription text replaces "(voice message)" in the notification, so Claude receives the spoken text directly.

Think of it as **Wispr Flow for Claude Code**. Open Telegram, hold the mic button, say "refactor the auth middleware to use JWT" -- Claude gets that as text and starts working. No typing, no desktop app needed, works from your phone.

### Transcription Setup

The server tries transcription methods in this order:

1. **OpenAI Whisper API** (recommended) -- fastest, highest quality, non-blocking. Set your API key in `~/.claude/channels/telegram/.env`:
   ```
   OPENAI_API_KEY=sk-proj-...
   ```
   Uses `whisper-1` by default ($0.006/min). You can switch to a different model:
   ```
   OPENAI_WHISPER_MODEL=gpt-4o-transcribe
   ```
   No local install needed. The active transcription method is logged at startup.

2. **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** (local fallback) -- `brew install whisper-cpp`. Fast C++ port, runs fully offline. Requires a model file:
   ```sh
   # Download the small multilingual model (465MB, good quality/speed balance)
   mkdir -p /usr/local/share/whisper-cpp/models
   curl -L -o /usr/local/share/whisper-cpp/models/ggml-small.bin \
     "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
   ```
3. **[openai-whisper](https://github.com/openai/whisper)** (local fallback) -- `pip install openai-whisper`. Python-based, slower but also works offline.
4. **No transcriber** -- voice messages are still downloaded and the `audio_path` is included in the notification, but no transcription is provided.

Local options (2 & 3) require **ffmpeg** (`brew install ffmpeg`) for audio format conversion. If you have an OpenAI API key, option 1 is recommended -- it's async (doesn't block the event loop), faster, and more accurate.

### Auto-transcription in history

When `autoTranscribe` is enabled (the default), the server transcribes **all** voice/audio messages in group chats -- even ones that don't mention the bot. This means `get_history` and the auto-injected context always show the spoken text (prefixed with 🎤) instead of `[voice]`. Claude gets full conversational context including what people said in voice messages.

To disable (e.g. to save CPU on busy groups):

```sh
/telegram:access set autoTranscribe false
```

To re-enable:

```sh
/telegram:access set autoTranscribe true
```

## Telegraph (Instant View Articles)

Claude can publish long-form content to [Telegraph](https://telegra.ph) and send it as Instant View links in Telegram -- a native full-screen article reader. Telegraph is **disabled by default** because posts are publicly accessible by URL.

To enable, add to `~/.claude/channels/telegram/.env`:

```
TELEGRAPH_ENABLED=true
```

When enabled, Claude only uses Telegraph for truly long content (3000+ characters with multiple sections) -- research reports, comprehensive analyses, detailed guides. Regular replies always stay in chat.

When disabled (default):
- The `create_telegraph_page` tool is hidden from Claude
- Claude sends all content directly in chat messages
- The system prompt does not mention Telegraph

Requires MCP server restart to take effect.

## Conversation Memory

When you clear chat history, Claude first saves a short summary to `~/.claude/channels/telegram/data/memory.md`. This file is loaded into Claude's instructions on every startup -- so context from previous sessions is never fully lost.

- Summaries are dated and tagged with the chat ID
- File auto-compresses when it exceeds 10,000 characters (older half gets trimmed)
- Works across `/clear` and Claude Code restarts

## Daemon Mode

The plugin ships with a **supervisor script** (`supervisor.ts`) that runs Claude Code as a managed child process. It handles:

- **Auto-restart on crash** -- exponential backoff (1s, 2s, 4s... up to 30s), resets after 60s of stable uptime
- **Context reset from Telegram** -- say "clear everything" in Telegram, Claude saves memory, clears history, and the supervisor restarts Claude with a fresh session. Zero downtime, memory preserved.
- **Signal file protocol** -- the MCP server writes `~/.claude/channels/telegram/data/restart.signal`, the supervisor detects it within 500ms, waits 3 seconds for Claude to finish sending replies, then kills and respawns

### Usage

If you followed the [Getting Started](#getting-started) steps, the supervisor is already installed at `~/.claude/scripts/telegram-supervisor.ts`. Just run:

```sh
bun ~/.claude/scripts/telegram-supervisor.ts
```

Extra flags are forwarded to Claude:

```sh
bun supervisor.ts --effort high
```

The supervisor spawns Claude with `--channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions` by default.

### How context reset works

1. User sends "clear everything" in Telegram
2. Claude confirms via inline buttons (`ask_user`)
3. Claude saves a conversation summary (`save_memory`)
4. Claude sends a confirmation reply to Telegram
5. Claude calls `clear_history` with `restart_context: true`
6. The MCP server writes `restart.signal` with a 3-second delay
7. Supervisor detects the file, waits for Claude to finish, then kills the process
8. Supervisor spawns a fresh Claude session -- memory.md is loaded into instructions automatically

### Always-on with launchd (macOS)

Running the supervisor in a terminal (or tmux/screen) works for quick sessions, but has a fundamental problem on macOS: **the system suspends background processes aggressively**. When you close the lid, switch users, or the Mac goes to sleep, macOS sends `SIGSTOP` to terminal processes — your bot goes silent until you open the lid again. tmux/screen don't help because they run in userspace and get suspended too.

**launchd** is Apple's native process manager — the same system that keeps Spotlight, Time Machine, and iCloud running. It operates at the OS level, outside of any terminal session, so it:

- **Survives lid close** -- the process keeps running when you close your MacBook (on power)
- **Survives logout** -- stays alive even if you log out of your user session
- **Auto-starts on boot** -- no need to remember to start it after a restart
- **Auto-restarts on crash** -- if the supervisor dies unexpectedly, launchd brings it back
- **Stays awake** -- we wrap the supervisor with `caffeinate -s` to prevent system sleep

#### Setup

Create `~/Library/LaunchAgents/com.user.claude-telegram.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.claude-telegram</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>/path/to/bun</string>
        <string>/Users/YOU/.claude/scripts/telegram-supervisor.ts</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/YOU/.claude/channels/telegram/data/supervisor-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/YOU/.claude/channels/telegram/data/supervisor-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOU</string>
        <key>PATH</key>
        <string>/path/to/bun/dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>/Users/YOU</string>

    <key>ProcessType</key>
    <string>Background</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

Replace `/path/to/bun` with your bun path (`which bun`) and `/Users/YOU` with your home directory.

> **Important:** Both `RunAtLoad` and `KeepAlive` should be set to `<true/>` for hands-off operation. `RunAtLoad` starts the daemon automatically on login/boot. `KeepAlive` tells launchd to restart the process if it exits unexpectedly. Setting either to `<false/>` means you'll need to manually start the daemon or it won't recover from crashes.

#### Managing the daemon

**Start the daemon:**

```sh
launchctl load ~/Library/LaunchAgents/com.user.claude-telegram.plist
```

**Stop the daemon:**

```sh
launchctl unload ~/Library/LaunchAgents/com.user.claude-telegram.plist
```

**Check if it's running:**

```sh
launchctl list | grep claude-telegram
```

A running daemon shows its PID in the first column. A `0` in the status column means it exited cleanly; non-zero means it crashed (launchd will restart it).

**View logs:**

```sh
tail -f ~/.claude/channels/telegram/data/supervisor-stderr.log
```

**Restart (reload config after editing the plist):**

```sh
launchctl unload ~/Library/LaunchAgents/com.user.claude-telegram.plist
launchctl load ~/Library/LaunchAgents/com.user.claude-telegram.plist
```

**Remove completely (stop + delete):**

```sh
launchctl unload ~/Library/LaunchAgents/com.user.claude-telegram.plist
rm ~/Library/LaunchAgents/com.user.claude-telegram.plist
```

#### Monitoring the daemon

Use the built-in monitor skill from any Claude Code session:

```
/telegram:monitor
```

Shows a live dashboard: process status for all components, launchd state, recent logs, MCP health, remote control URL (watch the daemon live in your browser), and lock file status.

You can also monitor manually:

```sh
# Live supervisor logs
tail -f ~/.claude/channels/telegram/data/supervisor-stderr.log

# Quick alive check
ps aux | grep "channels.*telegram" | grep -v grep && echo "ALIVE" || echo "DEAD"

# Find the remote control URL (open in browser to watch the daemon live)
strings ~/.claude/channels/telegram/data/supervisor-stdout.log | grep "session_" | tail -1
```

#### How the layers work together

```
launchd (OS-level)
  └── caffeinate -s (prevents system sleep)
        └── supervisor.ts (manages Claude lifecycle)
              └── claude --channels plugin:telegram (the actual bot)
```

- **launchd** ensures the process tree is always alive
- **caffeinate** keeps the Mac awake while the process runs
- **supervisor** handles Claude-specific restarts (context reset, crash recovery with backoff)
- **Claude** runs as a managed child process with the Telegram channel

> **Note:** `caffeinate -s` prevents sleep only when connected to power. On battery with the lid closed, macOS will eventually sleep regardless. For true 24/7 uptime on battery, consider running on a server instead.

## Group Chats & Conversation Threading

The plugin supports group chats with smart conversation threading -- Claude can follow reply chains, see who said what, and respond in the correct thread.

### Setup

**1. Disable privacy mode in BotFather**

By default, Telegram bots in groups only see commands and messages that mention them. For full thread tracking, disable privacy mode:

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/mybots` → select your bot
3. **Bot Settings** → **Group Privacy** → **Turn off**

> If you prefer to keep privacy mode on, the bot will still work -- it just won't see messages that don't mention it, so thread tracking will be incomplete.

**2. Add the bot to a group**

Add your bot to any Telegram group like a normal member.

**3. Pair the group (automatic)**

Just send a message in the group mentioning your bot (e.g. `@your_bot hello`). The bot replies with a 6-character pairing code -- same flow as DM pairing:

```
/telegram:access pair <code>
```

That's it. The group is registered automatically with `requireMention: true` (bot only responds when mentioned or replied to).

To let it respond to all messages:

```
/telegram:access group update -100XXXXXXXXXX requireMention false
```

> **Manual alternative:** If you already know the group's numeric ID (starts with `-100...`), you can register directly with `/telegram:access group add -100XXXXXXXXXX`. Ways to find the ID: check the bot's stderr logs, open [web.telegram.org](https://web.telegram.org) (ID is in the URL), or forward a group message to [@RawDataBot](https://t.me/RawDataBot).

**4. Restart Claude Code**

```sh
claude --channels plugin:telegram@claude-plugins-official
```

### How Threading Works

- When someone replies to a message in the group, Claude receives `reply_to_text` and `reply_to_user` showing what was replied to
- The plugin tracks up to 200 messages per chat (4-hour TTL) and walks reply chains up to 3 levels deep, providing `thread_context` in the notification
- Claude's own sent messages are tracked too, so reply chains work end-to-end
- Claude automatically threads its responses to the message that triggered them

### Forum Topics

If your supergroup has **Topics** enabled, the plugin forwards `thread_id` (Telegram's `message_thread_id`) and passes it through to replies -- keeping conversations in their correct Forum topic automatically. Topic IDs are persisted in SQLite so context is preserved across restarts.

## Access Control

Full access control docs in [ACCESS.md](./ACCESS.md) -- DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: Default policy is `pairing` -- DMs and groups both use the pairing flow. For DMs, message the bot to get a code. For groups, add the bot and mention it to get a code. Then `/telegram:access pair <code>` approves either. `ackReaction` only accepts Telegram's fixed emoji whitelist.

### Acknowledgment Reactions

The bot can react to incoming messages with an emoji to signal it received and is processing them. This is controlled by the `ackReaction` field in `access.json`:

```json
{
  "ackReaction": "👀"
}
```

**Reaction flow:**

| Stage | Emoji | When |
| --- | --- | --- |
| **Received** | `👀` (configurable via `ackReaction`) | Immediately on receipt |
| **Processing voice** | `✍` | When transcribing a voice message |
| **Working** | `🔥` | During long tasks (multiple tool calls, research, code generation) |
| **Done** | `👍` | After the reply is sent |

Telegram only keeps **one bot reaction per message**, so each new reaction replaces the previous — creating a natural status progression.

**Note:** `ackReaction` is **not set by default**. To enable it, add it to your `~/.claude/channels/telegram/access.json`. It only accepts emoji from [Telegram's fixed reaction whitelist](https://core.telegram.org/bots/api#reactiontypeemoji). Common choices: `👀`, `⚡`, `🔥`.

## Message History Buffer

Every message flowing through the bot is captured in a local SQLite database and persisted across restarts. Claude gets context without asking users to repeat themselves.

```
~/.claude/channels/telegram/data/messages.db
```

**How it works:**
- A grammY middleware intercepts ALL messages (including group messages without @bot mention) before the gate check
- Both inbound messages and bot replies are stored with `INSERT OR REPLACE` dedup
- Last 5 messages are auto-injected into each notification so Claude always has rolling context
- `get_history` retrieves up to 200 messages with pagination; `search_messages` does substring search
- SQLite WAL mode ensures crash-safe writes -- if Claude Code crashes, the DB auto-recovers on next startup
- Rolling buffer prunes automatically: 500 messages/chat cap, 14-day TTL, 50MB hard limit

## Limitations

Telegram's Bot API exposes **no native history endpoint** -- bots only see messages in real-time. We solve this with a local SQLite message store (see [Message History](#message-history-buffer) below). Every message flowing through the bot is captured and persisted, giving Claude full context across restarts via `get_history` and `search_messages` tools. History is available from when the bot joined the chat.

Photos and voice messages are downloaded eagerly on arrival -- there's no way to fetch attachments from historical messages via the Bot API.

## Roadmap

### Completed

- [x] MarkdownV2 formatting
- [x] Emoji reaction tracking
- [x] Ask User inline buttons
- [x] Reaction status indicators (👀 → 🔥 → 👍)
- [x] Voice & audio messages with whisper transcription
- [x] Auto-transcription in history (configurable)
- [x] Sticker & GIF support
- [x] Emoji reaction validation
- [x] Conversation threading
- [x] Forum topic support with persistent thread_id
- [x] Group pairing flow
- [x] Message history buffer (SQLite)
- [x] Session management (clear_history + save_memory)
- [x] Conversation memory persistence
- [x] Shell injection protection (spawnSync)
- [x] Smart media caching (no double downloads)

- [x] Daemon mode supervisor (auto-restart + context reset from Telegram)
- [x] Telegraph Instant View for long-form content
- [x] OpenAI Whisper API with local fallback

### Planned
- [ ] **Remote permission approval** -- Approve Claude Code permission prompts via Telegram inline buttons
- [ ] **Scheduled messages** -- Send messages at a specific time
- [ ] **Multi-bot support** -- Run multiple bots from one server instance
- [ ] **Rate limiting & usage stats** -- Track token usage and set limits per user
- [ ] **Webhook mode** -- Alternative to polling for production deployments
- [ ] **Custom commands** -- Define bot commands that map to Claude Code skills

## Contributing

This is a community project. We want your help!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Test with a real Telegram bot
5. Open a PR with a clear description of what you changed and why

### Guidelines

- Keep changes focused -- one feature per PR
- Test with real Telegram interactions, not just unit tests
- Update the README if you add new features or tools
- Follow the existing code style (TypeScript, grammy library)

## Credits

- **Original plugin** by [Anthropic](https://github.com/anthropics) ([source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)) -- Apache 2.0 licensed
- **Supercharged** by [@k1p1l0](https://github.com/k1p1l0) and contributors
- Inspired by the Claude Code Channels launch by [@boris_cherny](https://www.threads.com/@boris_cherny)

## License

Apache 2.0 -- Same as the original. See [LICENSE](./LICENSE).
