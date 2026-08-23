#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${HOSHISTREAM_STATE_DIR:-"$HOME/Library/Application Support/HoshiStream"}
LOG_DIR="$STATE_DIR/logs"
PID_FILE="$STATE_DIR/hoshistream.pid"

mkdir -p "$LOG_DIR"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "HoshiStream native server is already running."
  exit 0
fi

(cd "$ROOT/addon" && npm run build)
nohup node "$ROOT/scripts/native-server.mjs" --state-dir="$STATE_DIR" --detached "$@" >>"$LOG_DIR/hoshistream.log" 2>&1 &

for _ in $(seq 1 60); do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "HoshiStream native server started."
    exit 0
  fi
  sleep 0.25
done

echo "HoshiStream native server failed to start. Check $LOG_DIR/hoshistream.log" >&2
exit 1
