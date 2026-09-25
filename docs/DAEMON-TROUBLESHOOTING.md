# Daemon Troubleshooting

Field notes from running the supervisor under launchd for months. Each entry is a real failure, its symptom, and the fix.

## How the pieces fit

```
launchd (com.user.claude-telegram)
  └─ caffeinate -s bun ~/.claude/scripts/telegram-supervisor.ts
       └─ expect ~/.claude/scripts/claude-daemon-wrapper.exp   (re-read on every spawn)
            └─ claude --channels plugin:telegram@claude-plugins-official ...   (cwd: ~/.claude-telegram-daemon)
                 └─ bun run ... start
                      └─ bun server.ts   (the poller; pid in data/telegram.lock)
```

State, token, and logs live in `~/.claude/channels/telegram/` (`.env`, `access.json`, `data/telegram.lock`, `data/supervisor-{stdout,stderr}.log`).

## Health check

1. `launchctl list | grep claude-telegram` shows a PID.
2. `tail -5 ~/.claude/channels/telegram/data/supervisor-stderr.log` has no repeated `failed to spawn` or `crashed` lines.
3. `supervisor-stdout.log` contains `wrapper: telegram plugin poller detected` for the current boot.
4. The pid in `data/telegram.lock` is a `bun server.ts` whose grandparent is `claude --channels ...`.
5. Ask Telegram directly. Run this 2 or 3 times:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" "https://api.telegram.org/bot$TOKEN/getUpdates?timeout=0&limit=1"
   ```
   - `409 Conflict` at least once: a poller is alive.
   - Always `200`: nobody is polling. `getWebhookInfo` then shows how many updates are queued.
   - A `getUpdates` call without `offset` does not consume the queue. It does cut the bot's current long poll short with a 409, which the server now retries (see "Server died on a 409" below).

## Restarting

- **Soft** (reload skills or config): `touch ~/.claude/channels/telegram/data/restart.signal`. The supervisor waits for in-flight replies, then respawns claude. It keeps its in-memory args, so edits to `supervisor.ts` need a hard restart.
- **Hard** (reload the plist or supervisor code):
  ```sh
  launchctl bootout gui/$(id -u)/com.user.claude-telegram
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.claude-telegram.plist
  ```
- A healthy boot connects the plugin within a few seconds. If `supervisor-stderr.log` shows `claude crashed (code=1)` every ~2 minutes, see "Plugin silently skipped at boot" below.

## Failures

### Emoji reaction, no reply

Another `claude` session (a terminal with the plugin enabled) holds the polling lock, so messages reach that session instead of the daemon. The terminal session acks with the emoji and then stalls.

The supervisor sets `TELEGRAM_DAEMON_MODE=1`, and a server started in daemon mode now terminates a non-daemon poller and takes the lock. Non-daemon sessions still start in MCP-only mode when a poller is alive. If you still see this, check which process owns `data/telegram.lock`.

### Plugin silently skipped at boot (the old "startup race")

Symptom: claude boots, every other MCP server connects, but the telegram plugin never starts. There's no poller child, no new file in the plugin's MCP log directory, and nothing in the debug log. It used to look random ("about 1 boot in 3") and recover after 10 to 15 minutes.

Cause: Claude Code remembers a failed plugin MCP connection for 15 minutes in `~/.claude/mcp-needs-auth-cache.json`. That cache is shared by every Claude session on the machine and keyed by server name (`plugin:telegram:telegram`). While an entry is fresh, every new session skips the server without logging anything. Any other session that fails to start the plugin creates one. A common trigger is a cron or launchd job that runs `claude` with a PATH lacking bun: its plugin log (`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-plugin-telegram-telegram/`) shows `Connection failed after 3ms (ENOENT): Executable not found in $PATH: "bun"`. A job every 10 minutes keeps the daemon blocked about 70% of the time.

Fix: the supervisor removes `plugin:telegram*` entries from that cache before each spawn and logs `cleared cached MCP connection failure ...` when it does. Also give such jobs a PATH that includes bun, or set `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS=1` for them. The wrapper still checks for the poller child for 60 seconds and respawns claude if it never appears, as a safety net.

### Server died on a 409

Symptom: the bot works for a while, then goes deaf. `data/telegram.lock` disappears, and there's no `bun server.ts` under claude.

Cause: grammY rejects `bot.start()` on a 409 Conflict, which any other `getUpdates` call causes: a restart overlap, a second poller, even a manual curl. The rejection was unhandled, so the server exited. A throw inside a message handler stopped polling the same way.

Fix: the server now retries polling with backoff (up to 30 seconds) for any error, registers `bot.catch()` so handler errors don't stop polling, and logs unhandled rejections instead of exiting. It stops retrying only if another instance took the lock. After 8 straight 409s, a non-daemon session gives up polling and stays in tools-only mode.

### cwd = `$HOME` drops the plugin

With cwd set to `$HOME`, Claude Code also reads the plugin's own `.mcp.json` (under `~/.claude/plugins/cache/...`) as a project server named `telegram` ("pending approval", `CLAUDE_PLUGIN_ROOT` unexpanded) and drops the real plugin server as a duplicate. `claude mcp list` run from `$HOME` shows the stray entry.

The wrapper now `cd`s to `~/.claude-telegram-daemon` before spawning. Override it with `TELEGRAM_DAEMON_CWD`. Claude Code keys project memory by cwd, so symlink `~/.claude/projects/<cwd-slug>/memory` to your usual memory dir if the daemon should share it.

### Restart overlap skips the channel

If a new claude boots while the previous one (or its plugin server) is still shutting down, the channel MCP silently never starts. Rapid `launchctl kickstart -k` cycles trigger it. Fix: `launchctl stop com.user.claude-telegram`, wait until `pgrep -f "claude --channels"` is empty, remove a stale `data/telegram.lock`, then let KeepAlive respawn it.

### Trust-dialog crash loop

The workspace-trust dialog ("Quick safety check") defaults to "No, exit". A bare Enter exits claude with code 1 on every boot. The wrapper matches `trust[^\n]{0,40}folder` and sends Down, then Enter, both at startup and for the whole session, because Claude Code can re-show the dialog after an auto-update. The pattern is deliberately narrow: Telegram messages are rendered into the same PTY, so a broad "trust" match would inject Enter into the prompt.

### Supervisor can't find the wrapper (ENOENT loop)

Symptom: `failed to spawn claude: ENOENT ... /<somewhere>/.claude/scripts/claude-daemon-wrapper.exp`, repeated forever. The plist's `EnvironmentVariables` overrode `HOME`, so every path resolved under the wrong directory. The supervisor now resolves paths from the account's real home (`os.userInfo().homedir`) and passes that `HOME` to claude. Still, don't override `HOME` in the plist. Use `TELEGRAM_DAEMON_CWD` to change the daemon's cwd.

### Auth expired

When the stdout log shows `authentication_error` (401), the supervisor stops the restart loop, messages the owner (first `allowFrom` entry) on Telegram, and polls every 30 seconds until `claude -p ping` works again. Run `claude /login` in any terminal, and the daemon restarts itself.

### Bot silent in a group

Groups aren't paired. Add the group's chat ID to `groups` in `access.json` (`/telegram:access`). Get the ID from the web.telegram.org URL. With Group Privacy on (the member list shows "has no access to messages"), only @mentions, replies to the bot, and /commands are delivered, and that's enough for `requireMention: true`.

If the group is allowlisted, the bot is a member, and mentions still never arrive (the queue stays empty even with no poller running), remove the bot from the group and add it back. Telegram started delivering mentions right after that. To see what the bot receives, temporarily add a `bot.use` middleware that appends non-private updates and the `gate()` result to a log file.
