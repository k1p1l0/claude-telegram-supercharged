# claude-telegram-supercharged

A community-driven, supercharged fork of Anthropic's official Claude Code Telegram plugin.

## Why this fork?

Anthropic's Claude Code Channels is an amazing product with huge potential. We recognized that immediately when it launched, and within hours we were already building on top of it.

But here's the reality: Anthropic has a lot on their plate. The official plugin ships the essentials, and that's great. But there are dozens of features, fixes, and improvements the community needs right now, and Anthropic simply can't prioritize them all.

**That's where we come in.**

This fork exists because we believe the best way to support a great product is to build around it. Instead of filing issues and waiting, we're shipping fixes and features ourselves, for ourselves and for the entire community.

## What's already improved

### MarkdownV2 formatting support
The official plugin sends all messages as plain text. `*bold*` and `_italic_` show up as raw characters in Telegram. We fixed that.

- Added `parse_mode` parameter to `reply` and `edit_message` tools
- Defaults to `MarkdownV2` so messages render with proper Telegram formatting
- Supports `HTML` and `plain` modes as fallback
- Updated MCP instructions so Claude knows how to use Telegram's formatting syntax

> Related issue: [anthropics/claude-code#36622](https://github.com/anthropics/claude-code/issues/36622)

### Emoji reaction tracking
The official plugin ignores user reactions entirely. Now when you react to a bot message with an emoji (e.g. 👍, 👎, 🔥), Claude receives a notification and can act on it.

- Reactions from allowlisted users are forwarded to Claude as channel events
- Claude sees which emoji was used and on which message
- Use reactions as lightweight feedback: 👍 = approve, 👎 = reject, 🔥 = great job

### Ask User (inline keyboard buttons)
A new `ask_user` tool — the Telegram equivalent of Claude Code's `AskUserQuestion`. Claude sends a message with tappable inline buttons and waits for the user's choice.

- Send a question with up to 10 button options
- Blocks until the user taps a button (or timeout after 120s)
- Buttons are removed after selection, showing a ✅ confirmation
- Perfect for confirmations ("Deploy?" → Yes / No), choices, and approval flows

## Roadmap

Here's what we're planning to build. PRs welcome!

- [ ] **Message history buffer** - Keep a rolling buffer of recent messages so Claude has context without asking users to repeat themselves
- [ ] **Scheduled messages** - Send messages at a specific time
- [ ] **Rich media replies** - Support for inline keyboards, polls, and formatted cards
- [ ] **Voice message transcription** - Auto-transcribe voice messages before forwarding to Claude
- [ ] **Multi-bot support** - Run multiple bots from one server instance
- [ ] **Conversation threading** - Smart thread management for group chats
- [ ] **Rate limiting & usage stats** - Track token usage and set limits per user
- [ ] **Webhook mode** - Alternative to polling for production deployments
- [ ] **Custom commands** - Define bot commands that map to Claude Code skills
- [ ] **Message templates** - Predefined response templates for common queries

## Quick Setup

> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

### Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

### 1. Create a bot with BotFather

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

### 2. Install the [official plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)

These are Claude Code commands — run `claude` to start a session first.

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

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

### 5. Relaunch with the channel flag

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

### 6. Pair

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

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

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading, `files` (absolute paths) for attachments, and `parse_mode` (MarkdownV2/HTML/plain, defaults to MarkdownV2). Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Supports `parse_mode` (MarkdownV2/HTML/plain). Useful for "working..." → result progress updates. Only works on the bot's own messages. |
| `ask_user` | **NEW** — Send a question with inline keyboard buttons and wait for the user's choice. Takes `chat_id`, `text`, `buttons` (array of labels), optional `parse_mode` and `timeout` (default 120s). Returns the label of the tapped button. |

### Inbound events

| Event | Description |
| --- | --- |
| Text message | Forwarded to Claude as a channel notification with `chat_id`, `message_id`, `user`, `ts`. |
| Photo | Downloaded to inbox, path included in notification so Claude can `Read` it. |
| Emoji reaction | **NEW** — When a user reacts to a bot message, Claude receives a notification with `event_type: "reaction"`, the emoji, and the `message_id`. Use as lightweight feedback. |

Inbound messages trigger a typing indicator automatically — Telegram shows "botname is typing..." while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the local path is included in the `<channel>` notification so the assistant can `Read` it. Telegram compresses photos — if you need the original file, send it as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot only sees messages as they arrive — no `fetch_messages` tool exists. If the assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages — photos are downloaded eagerly on arrival since there's no way to fetch them later.

## Access control

Full access control docs in [ACCESS.md](./ACCESS.md) — DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Contributing

This is a community project. We want your help!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/voice-transcription`)
3. Make your changes
4. Test with a real Telegram bot
5. Open a PR with a clear description of what you changed and why

### Guidelines
- Keep changes focused — one feature per PR
- Test with real Telegram interactions, not just unit tests
- Update the README if you add new features or tools
- Follow the existing code style (TypeScript, grammy library)

## Credits

- **Original plugin** by [Anthropic](https://github.com/anthropics) ([source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)) — Apache 2.0 licensed
- **Community fork** maintained by [@k1p1l0](https://github.com/k1p1l0) and contributors
- Inspired by the Claude Code Channels launch by [@boris_cherny](https://www.threads.com/@boris_cherny)

## License

Apache 2.0 — Same as the original. See [LICENSE](./LICENSE).
