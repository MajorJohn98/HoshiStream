#!/bin/sh
set -eu

curl --fail --silent --show-error "${PUBLIC_ADDON_URL:-http://127.0.0.1:7000}/health"
curl --fail --silent --show-error "${PUBLIC_TORRSERVER_URL:-http://127.0.0.1:8090}/"

