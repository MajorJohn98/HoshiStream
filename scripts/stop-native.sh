#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${HOSHISTREAM_STATE_DIR:-"$HOME/Library/Application Support/HoshiStream"}
node "$ROOT/scripts/native-control.mjs" stop --state-dir="$STATE_DIR"
