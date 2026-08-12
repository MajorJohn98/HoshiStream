#!/bin/sh
set -eu

STATE_DIR=${HOSHISTREAM_STATE_DIR:-"$HOME/Library/Application Support/HoshiStream"}
PID_FILE="$STATE_DIR/hoshistream.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "HoshiStream native server is not running."
  exit 0
fi

PID=$(cat "$PID_FILE")
case "$PID" in
  *[!0-9]*|"") echo "Invalid native server PID file." >&2; exit 1 ;;
esac

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 1 40); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
fi
rm -f "$PID_FILE"
echo "HoshiStream native server stopped."
