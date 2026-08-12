#!/bin/sh
set -eu

ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
[ -n "$ip" ] || { echo "No LAN IP found; set PUBLIC_* URLs manually." >&2; exit 1; }
printf 'Add-on:\nhttp://%s:7000/manifest.json\n\nTorrServer:\nhttp://%s:8090\n' "$ip" "$ip"

