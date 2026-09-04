#!/bin/sh
# Starts the HoshiStream native server without the menu-bar app. Pass --dev
# to skip the tsc build and run the add-on straight from addon/src.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${HOSHISTREAM_STATE_DIR:-"$HOME/Library/Application Support/HoshiStream"}
LOG_DIR="$STATE_DIR/logs"
PID_FILE="$STATE_DIR/hoshistream.pid"

DEV=0
for arg in "$@"; do
  [ "$arg" = "--dev" ] && DEV=1
done

mkdir -p "$LOG_DIR"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "HoshiStream native server is already running."
  exit 0
fi

if [ "$DEV" -eq 0 ]; then
  (cd "$ROOT/addon" && npm run build)
fi

# Same --project-root the menu-bar app and start-native.ps1 use, so the
# terminal server reads the installed app's .env (token, MEDIA_DIR) and is a
# drop-in for it rather than a second identity with its own token.
nohup node "$ROOT/scripts/native-server.mjs" --state-dir="$STATE_DIR" --project-root="$STATE_DIR" --detached "$@" >>"$LOG_DIR/hoshistream.log" 2>&1 &

for _ in $(seq 1 60); do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "HoshiStream native server started."
    exit 0
  fi
  sleep 0.25
done

echo "HoshiStream native server failed to start. Check $LOG_DIR/hoshistream.log" >&2
exit 1
