#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$ROOT/build/HoshiStream.app"
CONTENTS="$APP/Contents"
RUNTIME="$CONTENTS/Resources/runtime"

(cd "$ROOT/addon" && npm run build)
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$RUNTIME/bin" "$RUNTIME/scripts" \
  "$RUNTIME/addon" "$RUNTIME/packaging" "$RUNTIME/vendor/torrserver/darwin-arm64" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64"

# Prefer a full Xcode when present, otherwise fall back to the Command Line
# Tools, which carry an SDK sufficient for AppKit and ServiceManagement.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  export DEVELOPER_DIR
fi

xcrun swiftc -parse-as-library \
  -module-cache-path "$ROOT/build/swift-module-cache" \
  -framework AppKit \
  -framework ServiceManagement \
  "$ROOT/supervisor/macos/Sources/"*.swift \
  -o "$CONTENTS/MacOS/HoshiStream"

cp "$ROOT/supervisor/macos/Info.plist" "$CONTENTS/Info.plist"
# HoshiStreamProjectRoot stays at its PROJECT_ROOT placeholder: the supervisor
# then resolves ~/Library/Application Support/HoshiStream at runtime, which is
# what makes the bundle portable to other Macs. Set it only for a dev build
# pointed at a checkout:
#   HOSHISTREAM_PROJECT_ROOT=/path/to/checkout packaging/build-macos-app.sh
if [ -n "${HOSHISTREAM_PROJECT_ROOT:-}" ]; then
  /usr/libexec/PlistBuddy -c \
    "Set :HoshiStreamProjectRoot $HOSHISTREAM_PROJECT_ROOT" "$CONTENTS/Info.plist"
fi
cp "$ROOT/vendor/node/darwin-arm64/node" "$RUNTIME/bin/node"
cp "$ROOT/scripts/native-server.mjs" "$RUNTIME/scripts/native-server.mjs"
cp "$ROOT/scripts/bootstrap.mjs" "$RUNTIME/scripts/bootstrap.mjs"
cp "$ROOT/scripts/lan-ip.mjs" "$RUNTIME/scripts/lan-ip.mjs"
cp "$ROOT/scripts/register-browser-bridge.mjs" "$RUNTIME/scripts/register-browser-bridge.mjs"
cp "$ROOT/packaging/torrserver-settings.json" \
  "$RUNTIME/packaging/torrserver-settings.json"
cp -R "$ROOT/addon/dist" "$RUNTIME/addon/dist"
cp -R "$ROOT/addon/assets" "$RUNTIME/addon/assets"
cp "$ROOT/addon/package.json" "$RUNTIME/addon/package.json"
# Production-only dependencies. The checkout's node_modules carries the seven
# devDependencies (vitest, eslint, typescript, vite, ...) that nothing needs at
# runtime, and the UI is prebuilt into addon/assets, so shipping them only
# inflates the download. Install from the lockfile into a staging dir instead.
DEPS_STAGE="$ROOT/build/deps-stage"
mkdir -p "$DEPS_STAGE"
cp "$ROOT/addon/package.json" "$ROOT/addon/package-lock.json" "$DEPS_STAGE/"
(cd "$DEPS_STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp -R "$DEPS_STAGE/node_modules" "$RUNTIME/addon/node_modules"
cp "$ROOT/vendor/torrserver/darwin-arm64/TorrServer" \
  "$RUNTIME/vendor/torrserver/darwin-arm64/TorrServer"

# Vendored ffmpeg/ffprobe for stream repair (ADR 0010); optional so the app
# still builds before fetch-ffmpeg.mjs has run — repair then uses PATH.
if [ -x "$ROOT/vendor/ffmpeg/darwin-arm64/ffmpeg" ]; then
  cp "$ROOT/vendor/ffmpeg/darwin-arm64/ffmpeg" \
    "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffmpeg"
  cp "$ROOT/vendor/ffmpeg/darwin-arm64/ffprobe" \
    "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffprobe"
  chmod 755 "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffmpeg" \
    "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffprobe"
fi

chmod 755 "$CONTENTS/MacOS/HoshiStream" "$RUNTIME/bin/node" \
  "$RUNTIME/vendor/torrserver/darwin-arm64/TorrServer"

# Sign inside out. `--deep` is deprecated and routinely produces bundles that
# Gatekeeper reports as "damaged", so each nested executable is signed first
# and the bundle last.
for BINARY in \
  "$RUNTIME/bin/node" \
  "$RUNTIME/vendor/torrserver/darwin-arm64/TorrServer" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffmpeg" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffprobe"; do
  [ -x "$BINARY" ] && codesign --force --sign - "$BINARY"
done
codesign --force --sign - "$APP"
echo "$APP"
