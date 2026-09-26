#!/usr/bin/env bash
# Install or update Claude Telegram Supercharged on top of the official plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/k1p1l0/claude-telegram-supercharged/master/install.sh | bash
#
# Safe to re-run: it pulls the latest version and copies the files again.
# Env overrides: TELEGRAM_SUPERCHARGED_DIR (checkout location),
# TELEGRAM_SUPERCHARGED_REPO (git URL).
set -euo pipefail

REPO="${TELEGRAM_SUPERCHARGED_REPO:-https://github.com/k1p1l0/claude-telegram-supercharged.git}"
DIR="${TELEGRAM_SUPERCHARGED_DIR:-$HOME/.claude/telegram-supercharged}"
CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
SCRIPTS="$HOME/.claude/scripts"

command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
if [ ! -d "$CACHE" ] || [ -z "$(ls -A "$CACHE" 2>/dev/null)" ]; then
  echo "Install the official plugin first. In Claude Code run:" >&2
  echo "  /plugin install telegram@claude-plugins-official" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only --quiet
else
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

# Claude Code runs the plugin from the newest version directory in the cache.
VERSION="$(ls "$CACHE" | sort -V | tail -1)"
TARGET="$CACHE/$VERSION"

# Keep the official server once, so you can go back to it.
[ -f "$TARGET/server.ts.official" ] || cp "$TARGET/server.ts" "$TARGET/server.ts.official"

cp "$DIR/server.ts" "$TARGET/server.ts"
mkdir -p "$TARGET/skills"
cp -R "$DIR/skills/." "$TARGET/skills/"
# package.json is left alone: the official start script keeps `bun install`
# output off stdout, which is the MCP channel.

mkdir -p "$SCRIPTS"
cp "$DIR/supervisor.ts" "$SCRIPTS/telegram-supervisor.ts"
cp "$DIR/scripts/claude-daemon-wrapper.exp" "$DIR/scripts/telegram-progress-hook.ts" "$SCRIPTS/"
chmod +x "$SCRIPTS/claude-daemon-wrapper.exp"

echo "Claude Telegram Supercharged $(git -C "$DIR" rev-parse --short HEAD) installed into $TARGET"
echo "Next:"
echo "  1. In Claude Code: /telegram:configure <bot token>   (first install only)"
echo "  2. Restart: claude --channels plugin:telegram@claude-plugins-official"
echo "     or, for the daemon: bun $SCRIPTS/telegram-supervisor.ts"
echo "Restore the official server any time: cp \"$TARGET/server.ts.official\" \"$TARGET/server.ts\""
