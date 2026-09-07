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
  if node "$ROOT/scripts/native-control.mjs" status --state-dir="$STATE_DIR" >/dev/null 2>&1; then
    echo "HoshiStream native server is already running."
    exit 0
  fi
fi

if [ "$DEV" -eq 0 ]; then
  (cd "$ROOT/addon" && npm run build)
fi

# Same --project-root the menu-bar app and start-native.ps1 use, so the
# terminal server reads the installed app's .env (token, MEDIA_DIR) and is a
# drop-in for it rather than a second identity with its own token.
node "$ROOT/scripts/native-control.mjs" prepare --state-dir="$STATE_DIR"
nohup node "$ROOT/scripts/native-server.mjs" --state-dir="$STATE_DIR" --project-root="$STATE_DIR" --detached "$@" >>"$LOG_DIR/hoshistream.log" 2>&1 &
STARTED_PID=$!

if node "$ROOT/scripts/native-control.mjs" wait --state-dir="$STATE_DIR" --pid="$STARTED_PID"; then
  exit 0
fi

echo "HoshiStream native server failed to start. Check $LOG_DIR/hoshistream.log" >&2
exit 1
