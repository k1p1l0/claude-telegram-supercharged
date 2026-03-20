<div align="center">

<img src="./banner.png" alt="Claude Telegram Supercharged" width="100%" />

<h3>Community fork of Claude Code's Telegram plugin with threading, voice, stickers, reactions, and more.</h3>

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

## What is Claude Telegram Supercharged?

**Claude Telegram Supercharged** is a community-driven, drop-in replacement for Anthropic's official Claude Code Telegram plugin. It takes everything the official plugin does and adds the features the community needs right now -- threading, MarkdownV2 formatting, voice messages, stickers, inline buttons, emoji reactions, and more.

Anthropic's Claude Code Channels is an amazing product with huge potential. But Anthropic has a lot on their plate, and the official plugin ships the essentials. Instead of filing issues and waiting, we ship fixes and features ourselves -- for ourselves and for the entire community.

## Table of Contents

- [What is Claude Telegram Supercharged?](#what-is-claude-telegram-supercharged)
- [Getting Started](#getting-started)
- [Features](#features)
- [Tools Exposed to the Assistant](#tools-exposed-to-the-assistant)
- [Photos](#photos)
- [Voice & Audio Messages](#voice--audio-messages)
- [Group Chats & Conversation Threading](#group-chats--conversation-threading)
- [Access Control](#access-control)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Feature Details](#feature-details)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

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

Clone this repo and replace the official plugin's server with the supercharged one:

```sh
git clone https://github.com/k1p1l0/claude-telegram-supercharged.git
cp claude-telegram-supercharged/server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts
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

When the official plugin updates, re-apply the supercharged server:

```sh
cd claude-telegram-supercharged
git pull
cp server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts
```

Then restart your Claude Code session.

## Features

| Feature | Description |
| --- | --- |
| **MarkdownV2 Formatting** | Bold, italic, code, and links render properly in Telegram instead of showing raw characters |
| **Conversation Threading** | Smart thread management for group chats with reply context, chain tracking, and Forum topic support |
| **Voice & Audio Messages** | Receive and process voice messages and audio files with optional Whisper transcription |
| **Sticker & GIF Support** | Static stickers passed as images; animated stickers and GIFs converted to multi-frame collages |
| **Ask User (Inline Buttons)** | Send questions with tappable inline keyboard buttons and wait for the user's choice |
| **Emoji Reaction Tracking** | Claude receives and acts on user reactions as lightweight feedback |
| **Reaction Status Indicators** | Visual processing status via emoji reactions (read / working / done) |
| **Emoji Reaction Validation** | Client-side whitelist prevents cryptic `REACTION_INVALID` errors |

## Tools Exposed to the Assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading, `files` (absolute paths) for attachments, and `parse_mode` (MarkdownV2/HTML/plain, defaults to MarkdownV2). Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 🎉 😂 🤔 etc). Also used for status indicators (👀 read → 👍 done). |
| `edit_message` | Edit a message the bot previously sent. Supports `parse_mode` (MarkdownV2/HTML/plain). Useful for "working..." → result progress updates. Only works on the bot's own messages. |
| `ask_user` | Send a question with inline keyboard buttons and wait for the user's choice. Takes `chat_id`, `text`, `buttons` (array of labels), optional `parse_mode` and `timeout` (default 120s). Returns the label of the tapped button. |

### Inbound Events

| Event | Description |
| --- | --- |
| Text message | Forwarded to Claude as a channel notification with `chat_id`, `message_id`, `user`, `ts`. |
| Photo | Downloaded to inbox, path included in notification so Claude can `Read` it. |
| Emoji reaction | When a user reacts to a bot message, Claude receives a notification with `event_type: "reaction"`, the emoji, and the `message_id`. Use as lightweight feedback. |
| Voice message | Downloaded to inbox as `.ogg`, path included in notification as `audio_path`. Claude transcribes using local whisper if available. |
| Audio file | Forwarded audio files (`.mp3`, etc.) downloaded to inbox, path included as `audio_path`. |
| Sticker | Static `.webp` passed directly as `image_path`. Animated (`.tgs`) and video (`.webm`) stickers converted to multi-frame collage. Emoji and pack name included in text. |
| GIF / Animation | Downloaded and converted to a multi-frame horizontal collage so Claude can see the animation content. |

Inbound messages trigger a typing indicator automatically -- Telegram shows "botname is typing..." while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the local path is included in the `<channel>` notification so the assistant can `Read` it. Telegram compresses photos -- if you need the original file, send it as a document instead (long-press → Send as File).

## Voice & Audio Messages

Voice messages and audio files are downloaded to `~/.claude/channels/telegram/inbox/` and the path is included as `audio_path` in the notification. Claude will attempt to transcribe using locally installed tools:

1. **[openai-whisper](https://github.com/openai/whisper)** (recommended) -- `pip install openai-whisper`. Supports 99 languages, runs fully offline.
2. **ffmpeg only** -- if whisper isn't installed but ffmpeg is, Claude converts to `.wav` for manual review.
3. **No tools** -- Claude tells you the voice was received and suggests installing whisper.

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

**3. Register the group**

Find your group's numeric ID (starts with `-100...`) by temporarily adding [@userinfobot](https://t.me/userinfobot) to the group. Then in your Claude Code session:

```
/telegram:access group add -100XXXXXXXXXX
```

By default, `requireMention` is `true` -- the bot only responds when mentioned or replied to. To let it see all messages:

```
/telegram:access group update -100XXXXXXXXXX requireMention false
```

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

If your supergroup has **Topics** enabled, the plugin forwards `thread_id` (Telegram's `message_thread_id`) and passes it through to replies -- keeping conversations in their correct Forum topic automatically.

## Access Control

Full access control docs in [ACCESS.md](./ACCESS.md) -- DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Limitations

Telegram's Bot API exposes **neither** message history nor search. The bot only sees messages as they arrive -- no `fetch_messages` tool exists. If the assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages -- photos are downloaded eagerly on arrival since there's no way to fetch them later.

## Roadmap

### Completed

- [x] MarkdownV2 formatting
- [x] Emoji reaction tracking
- [x] Ask User inline buttons
- [x] Reaction status indicators (👀 → 🔥 → 👍)
- [x] Voice & audio messages
- [x] Sticker & GIF support
- [x] Emoji reaction validation
- [x] Conversation threading

### Planned

- [ ] **Message history buffer** -- Keep a rolling buffer of recent messages so Claude has context without asking users to repeat themselves
- [ ] **Scheduled messages** -- Send messages at a specific time
- [ ] **Multi-bot support** -- Run multiple bots from one server instance
- [ ] **Rate limiting & usage stats** -- Track token usage and set limits per user
- [ ] **Webhook mode** -- Alternative to polling for production deployments
- [ ] **Custom commands** -- Define bot commands that map to Claude Code skills

---

## Feature Details

<details>
<summary><strong>MarkdownV2 formatting support</strong></summary>

<br />

The official plugin sends all messages as plain text. `*bold*` and `_italic_` show up as raw characters in Telegram. We fixed that.

- Added `parse_mode` parameter to `reply` and `edit_message` tools
- Defaults to `MarkdownV2` so messages render with proper Telegram formatting
- Supports `HTML` and `plain` modes as fallback
- Updated MCP instructions so Claude knows how to use Telegram's formatting syntax

> Related issue: [anthropics/claude-code#36622](https://github.com/anthropics/claude-code/issues/36622)

</details>

<details>
<summary><strong>Emoji reaction tracking</strong></summary>

<br />

The official plugin ignores user reactions entirely. Now when you react to a bot message with an emoji (e.g. 👍, 👎, 🔥), Claude receives a notification and can act on it.

- Reactions from allowlisted users are forwarded to Claude as channel events
- Claude sees which emoji was used and on which message
- Use reactions as lightweight feedback: 👍 = approve, 👎 = reject, 🔥 = great job

</details>

<details>
<summary><strong>Ask User (inline keyboard buttons)</strong></summary>

<br />

A new `ask_user` tool -- the Telegram equivalent of Claude Code's `AskUserQuestion`. Claude sends a message with tappable inline buttons and waits for the user's choice.

- Send a question with up to 10 button options
- Blocks until the user taps a button (or timeout after 120s)
- Buttons are removed after selection, showing a ✅ confirmation
- Perfect for confirmations ("Deploy?" → Yes / No), choices, and approval flows

</details>

<details>
<summary><strong>Reaction-based status indicators</strong></summary>

<br />

Claude now reacts to your messages with emoji to show processing status -- like read receipts on steroids.

- 👀 immediately when Claude reads your message
- 🔥 when starting heavy work (research, code generation, multi-step tasks)
- 👍 when Claude has finished and sent its reply
- Each reaction replaces the previous one -- Telegram only keeps one bot reaction per message
- Uses only Telegram's whitelisted bot emoji (👍 👎 ❤ 🔥 👀 🎉 😂 🤔)

Beyond status, Claude also reacts expressively when a message genuinely stands out -- 🔥 for impressive work, 😂 for funny messages, ❤ for heartfelt ones, 🎉 for celebrations. Selective, not robotic.

</details>

<details>
<summary><strong>Voice & audio message support</strong></summary>

<br />

Send a voice message or audio file in Telegram and Claude receives it. Voice messages and audio files are downloaded to the inbox and the path is passed to Claude via `audio_path` in the notification metadata.

- Supports both voice messages (recorded in-app, `.ogg`) and audio files (forwarded `.mp3`, etc.)
- Downloaded eagerly to `~/.claude/channels/telegram/inbox/` like photos
- Claude can process the audio file using available tools (transcription, analysis, etc.)

</details>

<details>
<summary><strong>Sticker & GIF support</strong></summary>

<br />

Send a sticker or GIF in Telegram and Claude actually sees it. Static stickers are passed directly as images. Animated stickers and GIFs are converted to multi-frame collages so Claude can understand the visual content.

- **Static stickers** (`.webp`) -- passed directly to Claude as `image_path`
- **Animated stickers** (`.tgs`, `.webm`) -- extracted into a 4-frame collage at 640px per frame
- **GIFs / animations** -- Telegram sends these as `.mp4`; 4 frames are extracted and stitched into a horizontal strip
- Sticker emoji and pack name are included in the notification text for extra context
- Uses `ffmpeg` for frame extraction and collage stitching -- falls back gracefully if unavailable

</details>

<details>
<summary><strong>Conversation threading for group chats</strong></summary>

<br />

In group chats, multiple conversations happen simultaneously. Without threading, Claude sees a flat stream of messages with no context. Now it can follow and participate in threaded conversations.

- **Reply context forwarding** -- when someone replies to a message, Claude sees the original text and sender (`reply_to_text`, `reply_to_user`)
- **Thread chain tracking** -- in-memory tracker maintains up to 200 messages per chat (4-hour TTL), walking reply chains up to 3 levels deep
- **Auto-threaded replies** -- Claude's responses include the thread context so it can reply to the correct message
- **Forum topic support** -- Telegram supergroup topics (`message_thread_id`) are forwarded as `thread_id` and passed through to replies, keeping conversations in their correct topic
- **Bot message tracking** -- bot's own sent messages are tracked so reply chains work when users reply to the bot
- Zero persistence needed -- in-memory only, bounded and self-pruning

</details>

<details>
<summary><strong>Emoji reaction validation</strong></summary>

<br />

The official plugin passes any emoji to Telegram's `setMessageReaction` API, which silently rejects non-whitelisted emoji with a cryptic `REACTION_INVALID` error. We added client-side validation.

- Full whitelist of 70+ Telegram-allowed reaction emoji built into the plugin
- Invalid emoji are caught before the API call with a helpful error message listing valid options
- Tool description updated with the complete emoji list so Claude picks valid reactions from the start

</details>

## Contributing

This is a community project. We want your help!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/voice-transcription`)
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
- **Community fork** maintained by [@k1p1l0](https://github.com/k1p1l0) and contributors
- Inspired by the Claude Code Channels launch by [@boris_cherny](https://www.threads.com/@boris_cherny)

## License

Apache 2.0 -- Same as the original. See [LICENSE](./LICENSE).
