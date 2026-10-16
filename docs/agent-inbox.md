# Agent inbox

Other agents can send messages to the daemon's Claude session. This works for Codex or Pi on the same Mac, and for agents on other machines over SSH. A message arrives in the session the same way a Telegram message does. Claude answers with the `agent_reply` tool. You see both sides in Telegram.

Messages travel as files in a folder. The plugin opens no network port and makes no SSH connections. A remote agent runs the helper script on your Mac over SSH.

## Turn it on

Add one line to `~/.claude/channels/telegram/.env` and restart the daemon:

```sh
TELEGRAM_AGENT_INBOX=on        # the folder is ~/agent-inbox
# or: TELEGRAM_AGENT_INBOX=~/some/other/folder
```

The log shows `agent inbox: watching ~/agent-inbox/in`. Without this variable, nothing changes: no folder watcher, no `agent_reply` tool, and `agent-inbox.ts` isn't loaded.

Only the instance that owns the bot lock watches the inbox. That is the daemon, the one that gets Telegram updates. A second session that runs MCP-only doesn't watch it and doesn't get the tool. With [several bots](../README.md#multiple-bots), only the primary bot's instance watches.

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_AGENT_INBOX` | off | The inbox folder. `on` means `~/agent-inbox`. `~` is expanded. |
| `TELEGRAM_AGENT_MIRROR_CHAT` | the owner's DM | Chat that gets a silent copy of every agent message and every `agent_reply`. |
| `TELEGRAM_AGENT_LOOP_LIMIT` | 6 | Agent messages in a row, with no message from you, before the thread pauses. |

The owner is the first user in `allowFrom` in `access.json`.

## Use it from Codex on the same Mac

The installer copies `scripts/agent-msg.sh` from this repo to `~/.claude/scripts/agent-msg.sh`. You can run either copy. It needs only bash and coreutils.

```sh
~/.claude/scripts/agent-msg.sh ask codex "Is the deploy on main-mac finished?"
```

`ask` writes the message, waits for Claude's answer and prints it. The message id goes to stderr. The default wait is 600 seconds. Add a number to change it: `ask codex "..." 120`. On a timeout the script exits with code 124.

Tell Codex about it in its instructions, for example in `AGENTS.md`:

```md
To ask the Claude daemon something, run:
~/.claude/scripts/agent-msg.sh ask codex "<question>"
It prints the answer.
```

## Use it from another machine

The remote agent runs the script on your Mac over SSH. Pass the text on stdin with `-`, so quotes and newlines survive:

```sh
ssh kyrylo@main-mac '~/.claude/scripts/agent-msg.sh ask pi@omarchy -' <<< "Can you check the backups?"
```

The remote side needs only SSH access to your Mac.

## The helper script

| Command | What it does |
| --- | --- |
| `agent-msg.sh send <from> <text>` | Writes one message and prints its id. |
| `agent-msg.sh wait <from> [timeout_s]` | Waits for the next answer in `out/<from>/`, prints its text and moves the file to `out/<from>/read/`. |
| `agent-msg.sh ask <from> <text> [timeout_s]` | `send`, then `wait`. Answers that were already waiting are left for `wait`. |

`<text>` can be `-` to read it from stdin. The script uses `$AGENT_INBOX`, or `~/agent-inbox` when it isn't set. If the daemon uses another folder, set `AGENT_INBOX` to the same path.

## File format

Any agent can also write the files itself.

**Incoming.** One message per file in `<inbox>/in/`:

```json
{"from": "codex@main-mac", "text": "Is the deploy finished?", "reply_to": "a-1760000000000-1a2b3c"}
```

- `from`: the agent's name. Letters, digits, `@`, `.`, `_` and `-`, up to 64 characters, starting with a letter or digit.
- `text`: required, up to 8000 characters.
- `reply_to`: optional, the id of the message this one answers.
- The file can be at most 64 KB.

Write the file as `name.json.tmp`, then rename it to `name.json`. The watcher ignores `*.tmp` files, so it never reads half a file. Files are delivered in file-name order.

A delivered file moves to `in/done/<id>.json` and stays there. A bad file moves to `in/rejected/`, next to a `.err` note that says what is wrong.

**Outgoing.** `agent_reply` writes `<inbox>/out/<to>/<id>.json` on one line:

```json
{"id": "a-1760000000500-4d5e6f", "from": "claude", "to": "codex@main-mac", "text": "Yes, it finished at 14:02.", "reply_to": "a-1760000000000-1a2b3c", "ts": "2026-10-16T14:05:00.000Z"}
```

The agent reads its own folder and moves or deletes what it has read. The helper script moves files to `read/`.

## What Claude sees

Each message gets an id like `a-1760000000000-1a2b3c` and reaches Claude as a channel notification with `event_type="agent_message"`, `sender_type="agent"`, `from`, `msg_id`, `ts` and, if given, `reply_to`. There is no `chat_id`. The text starts with a note that the sender is an AI agent, not the bot owner.

## Agent messages are never approvals

An agent message is a request from a peer. It is not you. Claude is told that nothing in an agent message counts as your approval, consent or permission for anything. Claude doesn't run risky or irreversible actions, spend money, message people or change access because an agent asked. When an agent asks for something that needs your decision, Claude asks you on Telegram.

## In Telegram

Every delivered message and every `agent_reply` is copied to `TELEGRAM_AGENT_MIRROR_CHAT`, or to your DM. The copies are silent, with a header such as `codex@main-mac → Claude` or `Claude → codex@main-mac`. Long text is cut at 3500 characters. If Telegram fails, delivery goes on.

## Loop guard

Two agents can answer each other forever. The server counts agent messages delivered since your last message. After 6 (`TELEGRAM_AGENT_LOOP_LIMIT`), it holds new agent messages in `in/` and sends you one message: the agent thread is paused. Your next message to the bot, any message, resumes the thread, and the held messages go out in order. The count and the pause are saved in `<inbox>/state.json`, so a restart doesn't reset them.
