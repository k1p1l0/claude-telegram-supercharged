#!/usr/bin/env bash
# Talk to the Telegram daemon's Claude session through its agent inbox.
# Needs TELEGRAM_AGENT_INBOX on the daemon side. See docs/agent-inbox.md.
#
#   agent-msg.sh send <from> <text>              write a message, print its id
#   agent-msg.sh wait <from> [timeout_s]         print the next answer for <from>, move it to read/
#   agent-msg.sh ask  <from> <text> [timeout_s]  send, then wait for the answer
#
# <text> "-" reads the text from stdin. The inbox is $AGENT_INBOX, default ~/agent-inbox.
# Exit codes: 0 ok, 2 usage error, 124 timeout.
# Works locally or over ssh: ssh me@mac '~/cts/scripts/agent-msg.sh ask pi@omarchy -' <<< "text"
set -euo pipefail

INBOX="${AGENT_INBOX:-$HOME/agent-inbox}"
case "$INBOX" in "~/"*) INBOX="$HOME/${INBOX#\~/}" ;; esac
DEFAULT_TIMEOUT=600
MAX_TEXT=8000

die() {
  echo "agent-msg: $1" >&2
  exit "${2:-2}"
}

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

check_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$ ]] || die "bad agent name '$1' (letters, digits, @ . _ -, max 64)"
}

check_timeout() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "timeout must be whole seconds, got '$1'"
}

# JSON string body: escape \ and ", then newline, CR, tab. Other control bytes are dropped.
json_escape() {
  local s
  s=$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# Prints the "text" value of a one-line JSON record written by the daemon (JSON.stringify).
json_text() {
  LC_ALL=C awk '
    function hex(h,   i, c, v) {
      v = 0
      for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", tolower(substr(h, i, 1))); v = v * 16 + c - 1 }
      return v
    }
    {
      p = index($0, "\"text\":\"")
      if (!p) exit 1
      s = substr($0, p + 8); out = ""; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\"") break
        if (c != "\\") { out = out c; continue }
        i++; e = substr(s, i, 1)
        if (e == "n") out = out "\n"
        else if (e == "t") out = out "\t"
        else if (e == "r") out = out "\r"
        else if (e == "b") out = out "\b"
        else if (e == "f") out = out "\f"
        else if (e == "u") {
          # JSON.stringify escapes only control characters and lone surrogates this way.
          cp = hex(substr(s, i + 1, 4)); i += 4
          out = out (cp < 128 ? sprintf("%c", cp) : "\357\277\275")
        }
        else out = out e
      }
      printf "%s\n", out
      exit 0
    }
  ' "$1"
}

now_ms() {
  local t
  t=$(date +%s%N 2>/dev/null || true)
  if [[ "$t" =~ ^[0-9]{19}$ ]]; then echo "${t:0:13}"; else echo "$(date +%s)000"; fi
}

rand_hex() {
  od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || printf '%06x' "$((RANDOM * 32768 + RANDOM))"
}

read_text() {
  if [[ "$1" == "-" ]]; then cat; else printf '%s' "$1"; fi
}

cmd_send() {
  local from="$1" text="$2"
  check_name "$from"
  [[ -n "${text//[[:space:]]/}" ]] || die "text is empty"
  ((${#text} <= MAX_TEXT)) || die "text is longer than $MAX_TEXT characters"
  mkdir -p "$INBOX/in"
  local id file
  id="a-$(now_ms)-$(rand_hex)"
  file="$INBOX/in/$id.json"
  printf '{"from":"%s","text":"%s"}\n' "$from" "$(json_escape "$text")" >"$file.tmp"
  mv "$file.tmp" "$file"
  echo "$id"
}

# Waits for the oldest answer in out/<from>/ that is not listed in $SKIP (newline-separated names).
cmd_wait() {
  local from="$1" timeout="${2:-$DEFAULT_TIMEOUT}"
  check_name "$from"
  check_timeout "$timeout"
  local dir="$INBOX/out/$from" deadline f name
  mkdir -p "$dir/read"
  deadline=$(($(date +%s) + timeout))
  while :; do
    for f in "$dir"/*.json; do
      [[ -f "$f" ]] || continue
      name=${f##*/}
      [[ -n "${SKIP:-}" ]] && grep -qxF "$name" <<<"$SKIP" && continue
      json_text "$f" || die "could not read $f" 1
      mv "$f" "$dir/read/$name"
      return 0
    done
    (($(date +%s) < deadline)) || die "no answer for $from within ${timeout}s" 124
    sleep 0.5
  done
}

cmd_ask() {
  local from="$1" text="$2" timeout="${3:-$DEFAULT_TIMEOUT}"
  check_name "$from"
  check_timeout "$timeout"
  # Answers that were already waiting belong to earlier questions: skip them.
  SKIP=$(ls "$INBOX/out/$from" 2>/dev/null | grep '\.json$' || true)
  cmd_send "$from" "$text" >&2
  cmd_wait "$from" "$timeout"
}

[[ $# -ge 2 ]] || usage
case "$1" in
  send)
    [[ $# -eq 3 ]] || usage
    cmd_send "$2" "$(read_text "$3")"
    ;;
  wait)
    [[ $# -le 3 ]] || usage
    cmd_wait "$2" "${3:-$DEFAULT_TIMEOUT}"
    ;;
  ask)
    [[ $# -ge 3 && $# -le 4 ]] || usage
    cmd_ask "$2" "$(read_text "$3")" "${4:-$DEFAULT_TIMEOUT}"
    ;;
  *) usage ;;
esac
